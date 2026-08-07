/**
 * The collection every booking is recorded in.
 *
 * The ledger (`bookings`) is authoritative for the SLOT — it owns the partial
 * unique index that makes "no more than capacity at one instant" a property the
 * database enforces, and no dynamic collection can hold that. Everything else a
 * booking is — a customer, a status, a note, an answer to an intake question —
 * is ordinary business data, and business data belongs in a collection where
 * the permission DSL, flows, realtime, revisions, exports and the BI panels all
 * apply to it for free.
 *
 * So both, and the split is not negotiable per resource: the collection is
 * provisioned automatically and every resource writes to it. What used to be
 * optional (`mirrorCollection` + a hand-authored `mirrorFieldMap`) had a
 * failure mode that looked exactly like working — an admin typed a slug, no map
 * existed to go with it, and `mirrorBooking` returned null forever without
 * saying anything.
 *
 * ONE collection per workspace, not one per resource. `resource` is a column.
 * A clinic with twenty practitioners has twenty rails on the booking page and
 * one place to read the bookings; twenty collections would be the same
 * confusion this exists to remove.
 *
 * Shaped after `ensurePaymentCollections`, deliberately: same idempotence, same
 * marker-column check, same additive backfill. A second provisioning shape
 * would be a second set of bugs.
 */
import { applyCollection, type FieldDef } from "@backlex/db";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import { and, eq } from "drizzle-orm";
import { createManagedCollection } from "./collections";
import { invalidateTenantCollections } from "./collections-cache";
import { loadCollection } from "./items/collection-loader";
import type { DbCtx } from "./seed";

/**
 * Not `bookings`: three of the schema templates already ship a collection under
 * that slug, and a workspace that applied one of them would meet a conflict on
 * its very first resource. Same reasoning that named `payment_transactions`.
 */
export const BOOKING_COLLECTION_SLUG = "booking_records";

/**
 * How we recognise a collection as ours. `booking_id` alone is close to
 * decisive; `starts_at` is there so a workspace that happens to keep a
 * `booking_id` foreign key on some other table still reads as a conflict rather
 * than as a target we may write into.
 */
export const BOOKING_MARKER_COLUMNS = ["booking_id", "starts_at"] as const;

const statusChoices = (values: string[]): FieldDef["options"] => ({
  choices: values.map((v) => ({ value: v, label: v.replace(/_/g, " ") })),
});

/**
 * The recorded shape of a booking. Flat and boring on purpose — this is a
 * record of something the ledger already decided, not a place to be clever.
 *
 * `booking_id` is the join back to the ledger and the row's identity for every
 * later sync: `mirrorItemId` on the booking is the fast path, and this column is
 * how a row is found again when that pointer was never written (the first
 * mirror failed) or was lost.
 */
export const BOOKING_COLLECTION_FIELDS: FieldDef[] = [
  {
    name: "booking_id",
    type: "text",
    required: true,
    unique: true,
    indexed: true,
    label: "Booking ID",
    description: "The ledger row this record belongs to. Do not edit.",
  },
  {
    name: "resource",
    type: "text",
    indexed: true,
    width: "half",
    description: "The resource key this booking was taken against.",
  },
  {
    name: "status",
    type: "text",
    indexed: true,
    interface: "dropdown",
    width: "half",
    options: statusChoices(["held", "confirmed", "cancelled", "no_show", "expired", "completed"]),
    description: "Mirrored from the ledger. Changing it here does not cancel anything.",
  },
  { name: "starts_at", type: "timestamp", indexed: true, width: "half" },
  { name: "ends_at", type: "timestamp", width: "half" },
  {
    name: "customer_name",
    type: "text",
    searchable: true,
    width: "half",
    label: "Customer",
  },
  {
    name: "customer_email",
    type: "text",
    interface: "email",
    searchable: true,
    width: "half",
    label: "Email",
  },
  {
    name: "customer_phone",
    type: "text",
    interface: "phone",
    width: "half",
    label: "Phone",
  },
  {
    name: "source",
    type: "text",
    indexed: true,
    interface: "dropdown",
    width: "half",
    options: statusChoices(["public", "admin", "api"]),
    description: "Which surface took the booking.",
  },
  { name: "notes", type: "longtext" },
  {
    // Intake answers keyed by question name. A column per question is not
    // possible: the questions are per resource and change under a collection
    // that is shared by all of them.
    name: "answers",
    type: "json",
    interface: "json",
    label: "Intake answers",
    group: "Answers",
    sectionCollapsible: true,
    sectionCollapsed: true,
  },
];

/**
 * Ledger key → column, for the rows this service writes.
 *
 * A resource pointed at its OWN collection still carries a hand-authored
 * `mirrorFieldMap`; this is the map used when the target is the one we
 * provisioned, and it is derived rather than stored so it cannot drift from
 * {@link BOOKING_COLLECTION_FIELDS}.
 */
export const DEFAULT_BOOKING_FIELD_MAP: Record<string, string> = {
  booking: "booking_id",
  resource: "resource",
  status: "status",
  start: "starts_at",
  end: "ends_at",
  name: "customer_name",
  email: "customer_email",
  phone: "customer_phone",
  source: "source",
  notes: "notes",
  answers: "answers",
};

/** Does this collection look like ours? A pre-existing collection under the
 *  same slug but without our marker columns belongs to somebody else. */
export const isBookingTarget = (collection: { fields: FieldDef[] }): boolean => {
  const names = new Set(collection.fields.map((f) => f.name));
  return BOOKING_MARKER_COLUMNS.every((c) => names.has(c));
};

/**
 * Add any columns the target is missing, without touching the ones it has.
 *
 * A workspace provisioned before a column existed would otherwise never get it,
 * and the first booking carrying that key would fail with `Unknown column` —
 * which, on a best-effort mirror, means silently losing the record. Strictly
 * additive in both directions: only fields absent BY NAME are appended, so an
 * admin's own extra columns survive, and `applyCollection` never drops or
 * alters what is already there.
 *
 * A field added to {@link BOOKING_COLLECTION_FIELDS} later must be neither
 * `required` nor `unique`: this path reaches the table as `ALTER TABLE … ADD
 * COLUMN`, and neither dialect can add a NOT NULL column with no default to a
 * table that has rows — SQLite refuses a UNIQUE one outright. The two marker
 * columns carry both, and are safe only because a collection missing either of
 * them is a conflict rather than a backfill target, so they are never in
 * `missing`.
 */
const backfillBookingFields = async (
  ctx: DbCtx,
  tenantId: string,
  collection: Awaited<ReturnType<typeof loadCollection>>,
): Promise<string[]> => {
  const have = new Set(collection.fields.map((f) => f.name));
  const missing = BOOKING_COLLECTION_FIELDS.filter((f) => !have.has(f.name));
  if (missing.length === 0) return [];
  // An adopted table is somebody else's; DDL on it is exactly what adoption
  // exists not to do.
  if (collection.adopted) return [];

  const fields = [...collection.fields, ...missing];
  const t = (ctx.dialect === "pg" ? pg.schema.collections : sqlite.schema.collections) as
    typeof pg.schema.collections;
  await applyCollection(ctx.db as never, ctx.dialect, {
    table: collection.physicalTable,
    fields,
    ownerScoped: collection.ownerScoped,
    tenantScoped: collection.tenantScoped,
    versioned: collection.versioned,
    fts: collection.fts,
    softDelete: collection.softDelete,
    adopted: false,
  });
  await (ctx.db as never as { update: Function })
    .update(t)
    .set({ fields, updatedAt: new Date() })
    .where(and(eq(t.tenantId, tenantId), eq(t.slug, collection.slug)));
  // The loader caches per isolate; without this the next write still sees the
  // old field list and rejects the very column we just added.
  invalidateTenantCollections(tenantId);
  return missing.map((f) => f.name);
};

export interface EnsureBookingCollectionResult {
  slug: string;
  /** True when this call provisioned it. */
  created: boolean;
  /**
   * The slug is taken by a collection that ISN'T ours. Nothing is written to
   * it — the admin has to rename theirs or point the resource somewhere else.
   * Surfaced rather than silently skipped, because silently skipping is how a
   * workspace discovers months later that nothing was ever recorded.
   */
  conflict: boolean;
  /** Columns added to an already-existing target. Empty in the steady state. */
  addedFields: string[];
}

/**
 * Provision the booking record collection if it is missing, and bring an
 * existing one up to today's shape.
 *
 * Idempotent, and cheap in the steady state: one cached collection load and a
 * set comparison. Called when a resource is created AND lazily on the write
 * path, so a workspace whose resources predate this never needs a migration —
 * the first booking after the upgrade provisions it.
 */
export const ensureBookingCollection = async (
  ctx: DbCtx,
  tenantId: string,
): Promise<EnsureBookingCollectionResult> => {
  const slug = BOOKING_COLLECTION_SLUG;
  const out = await createManagedCollection(ctx, tenantId, {
    slug,
    singular: "Booking record",
    plural: "Booking records",
    note:
      "Every booking, recorded. The slot itself is owned by Availability & booking — " +
      "editing a row here does not move, cancel or free an appointment.",
    icon: "CalendarCheck",
    color: "teal",
    group: "Booking",
    sortOrder: 1,
    displayTemplate: "{{customer_name}}",
    defaultSort: "-starts_at",
    fields: BOOKING_COLLECTION_FIELDS,
    tenantScoped: true,
    fts: true,
  });
  if (out.created) return { slug, created: true, conflict: false, addedFields: [] };

  // Already there — but is it OURS? `createManagedCollection` is idempotent on
  // the slug, so it happily "skips" a collection that has nothing to do with
  // bookings.
  try {
    const collection = await loadCollection(ctx, tenantId, slug);
    if (!isBookingTarget(collection)) {
      return { slug, created: false, conflict: true, addedFields: [] };
    }
    const addedFields = await backfillBookingFields(ctx, tenantId, collection);
    return { slug, created: false, conflict: false, addedFields };
  } catch {
    // The slug is taken by a physical table with no active collection row
    // (archived / adopted-then-archived). We cannot verify its shape, so we
    // must not write to it.
    return { slug, created: false, conflict: true, addedFields: [] };
  }
};
