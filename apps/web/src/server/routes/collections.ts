import {
  AppError,
  type Condition,
  EMBEDDING_MODEL_NAMES,
  type EmbeddingModel,
} from "@backlex/core";
import {
  FIELD_TYPES,
  ROLLUP_FNS,
  SEQUENCE_RESETS,
  applyCollection,
  assertIdent,
  derivePhysicalTable,
  dropCollection,
  dropField,
  type FieldDef,
  tableExists,
  validateFields,
} from "@backlex/db";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import { and, eq, ne, type SQL, sql } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { z } from "zod";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { requireAdminMw, requirePlatformMw } from "../services/roles/guards";
import { listReadableCollections } from "../services/permissions";
import { logActivity } from "../services/activity";
import { inspectTable, RESERVED_NAMES } from "../services/adopt";
import { cascadeSlugRename } from "../services/collection-rename";
import {
  getCachedCollections,
  getCachedGroupOrder,
  invalidateTenantCollections,
  setCachedCollections,
  setCachedGroupOrder,
} from "../services/collections-cache";
import { invalidateTenantPermissions } from "../services/permissions-cache";
import { loadCollection } from "../services/items/collection-loader";
import {
  refreshCollectionRollups,
  rollupSignature,
  validateRollupTargets,
} from "../services/items/rollup";
import {
  dropSequenceCounters,
  sequenceFieldsOf,
  syncSequenceCounters,
} from "../services/items/sequence";
import { ifNoneMatch, weakETag } from "../lib/etag";
import { seedOwnerScopedPermissions } from "../services/seed";
import { cloneCollection } from "../services/collections";
import { embedAndUpsertBatch, isVectorizable } from "../services/vectorize";
import { backfillFts, ftsIndexSignature, isSearchable } from "../services/fts";

const DurationPartsSchema = z
  .object({
    years: z.number().optional(),
    months: z.number().optional(),
    weeks: z.number().optional(),
    days: z.number().optional(),
    hours: z.number().optional(),
    minutes: z.number().optional(),
    seconds: z.number().optional(),
  })
  .strict();

/** A datetime bound accepted by `validation.minDate` / `maxDate`. */
const DateBoundSchema = z.union([
  z.number(),
  z.string(),
  z.object({
    $now: z.object({
      add: DurationPartsSchema.optional(),
      sub: DurationPartsSchema.optional(),
    }),
  }),
]);

const FieldSchema = z
  .object({
    name: z.string().min(1).regex(/^[a-z][a-z0-9_]*$/, "snake_case"),
    // Derived from the canonical list in @backlex/db (which carries the
    // per-type notes and a compile-time exhaustiveness guard) — a hand-copied
    // enum here has silently dropped `file` and `hash` before.
    type: z.enum(FIELD_TYPES),
    required: z.boolean().optional(),
    unique: z.boolean().optional(),
    // Plain B-tree index on the column — speeds up filter/sort. Applied by
    // the schema applier; the admin UI already sends this flag.
    indexed: z.boolean().optional(),
    // Store this field's value per-locale in the `<table>__i18n` sidecar (any
    // type except computed/hash). validateFields enforces the
    // combinations; the schema applier maintains the sidecar column.
    localized: z.boolean().optional(),
    to: z
      .string()
      .regex(/^[a-z][a-z0-9_]*$/, "snake_case")
      .optional(),
    // UI hint only — never affects storage or security, so any catalog id
    // from the admin's interface picker (apps/web/src/client/admin/interfaces.ts)
    // is accepted. `dropdown` still gets its choices enforced by validateFields.
    interface: z.string().min(1).max(64).optional(),
    options: z
      .object({
        values: z.array(z.string()).optional(),
        choices: z
          .array(
            z.object({
              value: z.string().min(1),
              label: z.string().optional(),
              color: z.string().optional(),
              icon: z.string().optional(),
            }),
          )
          .optional(),
      })
      .optional(),
    validation: z
      .object({
        regex: z.string().optional(),
        min: z.number().optional(),
        max: z.number().optional(),
        minLength: z.number().int().nonnegative().optional(),
        maxLength: z.number().int().nonnegative().optional(),
        // Built-in format for text-ish fields — canonical email/url patterns.
        format: z.enum(["email", "url"]).optional(),
        // Whole-number constraint for integer/number.
        integer: z.boolean().optional(),
        // Datetime bounds (timestamp): epoch-ms, ISO string, "$now", or a
        // relative-now object `{ $now: { sub: { days: 1 } } }`.
        minDate: DateBoundSchema.optional(),
        maxDate: DateBoundSchema.optional(),
        // Cardinality bounds for relation_many (array length).
        minSelect: z.number().int().nonnegative().optional(),
        maxSelect: z.number().int().nonnegative().optional(),
        // Cross-field escape hatch — opaque Condition; validateFields checks
        // its field refs. Sibling values via `"$field.<name>"`.
        rule: z
          .custom<Condition>(
            (v) => typeof v === "object" && v !== null && !Array.isArray(v),
            "rule must be a condition object",
          )
          .optional(),
        // Custom message shown on any failure for this field.
        message: z.string().max(300).optional(),
        // error (default) blocks the write; warning/info are advisory and
        // surfaced in the response `warnings` array instead.
        severity: z.enum(["error", "warning", "info"]).optional(),
      })
      .optional(),
    visibleWhen: z
      .object({
        field: z.string().regex(/^[a-z][a-z0-9_]*$/),
        op: z.enum(["_eq", "_neq", "_in"]),
        value: z.unknown(),
      })
      .optional(),
    // Per-field conditions: a rule (filter over the row) plus
    // effects. `required` is enforced server-side (validateFields checks the
    // rule's field refs; the write path enforces the effect); `readonly` /
    // `hidden` are honoured by the item form. `rule` is an opaque Condition.
    conditions: z
      .array(
        z.object({
          name: z.string().optional(),
          // Opaque Condition object — validateFields checks its field refs.
          rule: z.custom<Condition>(
            (v) => typeof v === "object" && v !== null && !Array.isArray(v),
            "rule must be a condition object",
          ),
          required: z.boolean().optional(),
          readonly: z.boolean().optional(),
          hidden: z.boolean().optional(),
        }),
      )
      .optional(),
    group: z.string().optional(),
    /** Form-layout metadata — pure UI, never touches storage/API/validation.
     *  `width: "half"` pairs two consecutive fields into a 2-column row; the
     *  section flags make a `group` collapsible (aggregated across the group). */
    width: z.enum(["full", "half"]).optional(),
    sectionCollapsible: z.boolean().optional(),
    sectionCollapsed: z.boolean().optional(),
    sectionsAsTabs: z.boolean().optional(),
    /** Include this field in the embed text when the collection has
     *  `vectorize: true`. Only meaningful on text/longtext fields. */
    vectorize: z.boolean().optional(),
    /** Fold this field into the full-text-search index when the collection
     *  has `fts: true`. Only meaningful on text/longtext fields. */
    searchable: z.boolean().optional(),
    /** Column-level DEFAULT (scalar types only). Emitted into the DDL by
     *  `columnDefSql`; ignored for relation/json/timestamp/computed. */
    default: z.union([z.string(), z.number(), z.boolean()]).optional(),
    /** Human display name for the field in the admin editor. UI only —
     *  the storage column is still keyed by `name`. */
    label: z.string().max(200).optional(),
    /** Inline help text shown beneath the field in the admin editor. UI only. */
    description: z.string().max(1000).optional(),
    /** Private / internal column — stored + writable but stripped from every
     *  API read surface (REST + GraphQL + CSV + changefeed). */
    private: z.boolean().optional(),
    /** Server-side auto-fill on insert (uuid/now/user/tenant). Read-only for
     *  writes; validateFields checks type-appropriateness. */
    onCreate: z.enum(["uuid", "now", "user", "tenant"]).optional(),
    /** Server-side auto-fill on every update (now/user/tenant). */
    onUpdate: z.enum(["now", "user", "tenant"]).optional(),
    /** App-layer ON DELETE action for a relation FK (set_null/cascade/no_action). */
    onDelete: z.enum(["set_null", "cascade", "no_action"]).optional(),
    /** Display-only formatting hint (number/date/currency) — never affects
     *  storage, the API, sorting or filtering. */
    format: z
      .object({
        style: z.enum(["plain", "decimal", "currency", "percent"]).optional(),
        precision: z.number().int().min(0).max(10).optional(),
        currency: z.string().max(8).optional(),
        thousandSeparator: z.boolean().optional(),
        dateStyle: z.enum(["relative", "date", "datetime", "time"]).optional(),
        prefix: z.string().max(16).optional(),
        suffix: z.string().max(16).optional(),
      })
      .optional(),
    /** Per-locale display label overrides (locale → label). UI-only. */
    translations: z.record(z.string(), z.string().max(200)).optional(),
    /**
     * Maintain this column as an aggregate over another collection's rows —
     * `{ from, via, fn, field?, filter? }`. Unlike `computed` (deliberately
     * absent from this schema: a raw SQL formula reaching the DDL from a
     * request body is a break-out surface) a rollup is structured — the
     * identifiers go through `assertIdent` and the filter compiles through the
     * same condition DSL as permissions — so it is safe to accept over the API,
     * which is the point: an operator has to be able to add one from the admin.
     * `validateFields` checks the shape; `validateRollupTargets` checks it
     * against the collection it names.
     */
    rollup: z
      .object({
        from: z.string().regex(/^[a-z][a-z0-9_]*$/, "snake_case"),
        via: z.string().regex(/^[a-z][a-z0-9_]*$/, "snake_case"),
        fn: z.enum(ROLLUP_FNS),
        field: z.string().regex(/^[a-z][a-z0-9_]*$/, "snake_case").optional(),
        filter: z
          .custom<Condition>(
            (v) => typeof v === "object" && v !== null && !Array.isArray(v),
            "filter must be a condition object",
          )
          .optional(),
      })
      .optional(),
    /**
     * Issue this column from a server-side counter — `{ pattern, start?,
     * reset?, timezone? }`, e.g. `INV-{YYYY}-{####}`.
     *
     * Safe to accept over the API for the same reason `rollup` is and
     * `computed` is not: nothing here reaches the DDL. The pattern is parsed by
     * a closed grammar (literals, four date tokens, one counter token) and only
     * ever rendered into a value, so the worst a malformed one can do is fail
     * `validateSequenceSpec` at save time. The bound on `pattern` is what stops
     * a caller storing a megabyte of literal text in every row.
     */
    sequence: z
      .object({
        pattern: z.string().min(1).max(120),
        start: z.number().int().min(0).optional(),
        reset: z.enum(SEQUENCE_RESETS).optional(),
        timezone: z.string().max(64).optional(),
      })
      .optional(),
    /**
     * `geo` field configuration — which text columns a missing point may be
     * geocoded from, and where the admin's map opens.
     *
     * `geocodeFrom` is a list of field NAMES, not values, and `validateFields`
     * checks each one against the collection's own fields; the geocode call
     * itself joins those columns' values and hands the string to the configured
     * provider. The `max(8)` is what stops a caller building a request body out
     * of a hundred columns on every write.
     */
    geo: z
      .object({
        geocodeFrom: z
          .array(z.string().regex(/^[a-z][a-z0-9_]*$/, "snake_case"))
          .min(1)
          .max(8)
          .optional(),
        defaultCenter: z
          .object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) })
          .optional(),
      })
      .optional(),
    /**
     * Money configuration — where this column's currency comes from, and how
     * the amount sits in it. Exactly one of `currency` / `currencyField` is
     * required (enforced by `validateMoneySpec`, which also checks that the
     * named sibling exists and is text). `exponent` overrides the ISO-4217
     * minor-unit count; `storage: "decimal"` is for adopted tables whose
     * numeric column already holds major units.
     */
    money: z
      .object({
        currency: z.string().length(3).optional(),
        currencyField: z
          .string()
          .regex(/^[a-z][a-z0-9_]*$/, "snake_case")
          .optional(),
        exponent: z.number().int().min(0).max(6).optional(),
        storage: z.enum(["minor", "decimal"]).optional(),
      })
      .optional(),
  })
  .refine((f) => (f.type !== "relation" && f.type !== "relation_many") || !!f.to, {
    message: "relation / relation_many field must specify `to` (target collection slug)",
    path: ["to"],
  });

const ModelEnum = z.enum(
  EMBEDDING_MODEL_NAMES as [EmbeddingModel, ...EmbeddingModel[]],
);

const CollectionInput = z.object({
  slug: z.string().min(1).regex(/^[a-z][a-z0-9_]*$/),
  singular: z.string().nullable().optional(),
  plural: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
  displayTemplate: z.string().nullable().optional(),
  /** Admin icon key from the SPA icon set (e.g. `"FileText"`). Presentational. */
  icon: z.string().max(60).nullable().optional(),
  /** Admin accent color — a preset token name (`"violet"`) or `#rrggbb` hex. */
  color: z
    .string()
    .regex(/^([a-z]{2,30}|#[0-9a-fA-F]{6})$/)
    .nullable()
    .optional(),
  /** Hidden from the admin sidebar/index. Presentational only — API access
   *  and permissions are unaffected. */
  hidden: z.boolean().optional().default(false),
  /** Preview-URL template with `{{field}}` placeholders, e.g.
   *  `https://site.com/blog/{{slug}}?preview=1`. Rendered client-side into an
   *  "Open preview" action on items. Must be absolute http(s). */
  previewUrl: z
    .string()
    .max(500)
    .regex(/^https?:\/\//)
    .nullable()
    .optional(),
  fields: z.array(FieldSchema),
  ownerScoped: z.boolean().optional().default(false),
  /** When true (default), the physical table gets a `tenant_id` column and
   *  rows are scoped to the active tenant. */
  tenantScoped: z.boolean().optional().default(true),
  versioned: z.boolean().optional().default(false),
  /** Staged edits (versioned only). When true, a PATCH against a *published*
   *  row is stored as a staged patch (item_staged) instead of mutating the
   *  live row; `publish` applies it. `?live=1` + publish permission edits the
   *  live row directly. Ignored (no staging) while the row is a draft. */
  stagedEdits: z.boolean().optional().default(false),
  /** When true (managed only), the physical table gets a nullable
   *  `deleted_at` column, DELETE soft-deletes, and reads filter
   *  `deleted_at IS NULL`. Forced false for adopted creates. */
  softDelete: z.boolean().optional().default(false),
  /** When true, the collection is locked to a single live row. */
  singleton: z.boolean().optional().default(false),
  /** Opt-in sensitive-read auditing. When true, REST read operations on this
   *  collection (list + by-id) record an `access.read` activity row so admins
   *  get a "who viewed this" trail. Off by default — reads are otherwise not
   *  logged. Pruned on a shorter retention than other activity (see
   *  ACCESS_AUDIT_RETENTION_DAYS). */
  auditReads: z.boolean().optional().default(false),
  /** Master switch — when true, item writes auto-embed fields with
   *  `vectorize: true` and the bulk endpoint backfills existing rows. */
  vectorize: z.boolean().optional().default(false),
  /** Embedding model key. Null → fall back to env.EMBEDDING_DEFAULT_MODEL. */
  vectorizeModel: ModelEnum.nullable().optional(),
  /** Master switch — when true, item writes maintain a keyword full-text
   *  index built from fields flagged `searchable: true`, and the bulk
   *  `POST /:slug/fts-reindex` endpoint backfills existing rows. */
  fts: z.boolean().optional().default(false),
  /** Comma-separated default sort (`"-published_at,name"`). Field-level
   *  validity is enforced by `parseQuery` at read time against the
   *  caller's permission allow-list; here we only constrain shape. */
  defaultSort: z
    .string()
    .regex(/^[-+]?[a-z_][a-z0-9_]*(,[-+]?[a-z_][a-z0-9_]*)*$/)
    .nullable()
    .optional(),
  /** Field the admin Kanban view groups by — a user field name (a
   *  `dropdown`/`select` field) or the special `_status` lifecycle column on
   *  versioned collections. Null = auto-detect. Purely an admin-UI preference;
   *  it never affects the API read/write contract. */
  kanbanGroupBy: z
    .string()
    .regex(/^(_status|[a-z][a-z0-9_]*)$/)
    .max(120)
    .nullable()
    .optional(),
  /** Maps Kanban group-by dropdown values to lifecycle actions (e.g.
   *  `{ done: "publish" }`) so moving a card into that column also fires the
   *  publish/unpublish/archive transition. Admin-UI only; ignored unless the
   *  collection is versioned and grouped by a user dropdown. */
  kanbanActionMap: z
    .record(z.string(), z.enum(["publish", "unpublish", "archive"]))
    .nullable()
    .optional(),
  /** Admin grouping: section header on the Collections page + sidebar tree.
   *  Null = ungrouped (rendered last). Header order lives in the
   *  `collectionGroups` app_settings key, written by `POST /layout`. */
  group: z.string().min(1).max(60).nullable().optional(),
  /** Manual position within the group. Null sorts after ordered rows. */
  sortOrder: z.number().int().min(0).max(100_000).nullable().optional(),
  /** Physical table name. Optional for managed creates (defaults to
   *  `derivePhysicalTable(tenantId, slug)`); required when `adopted=true`.
   *  Custom names are allowed for managed collections too — useful when a
   *  caller wants a friendlier table name than `c_<prefix>_<slug>`. */
  physicalTable: z.string().min(1).max(120).optional(),
  /** When true, register an *existing* physical table without DDL. The
   *  table must already exist; field names, PK, and any column aliases are
   *  validated against the live table shape before the metadata row is
   *  written. Default is false (managed create — DDL runs). */
  adopted: z.boolean().optional().default(false),
  /** PK column name. Ignored for managed creates (always `"id"`); for
   *  adopted creates, must match the introspected primary key. */
  pkColumn: z.string().min(1).max(120).optional(),
  /** PK storage type for MANAGED creates. Default `uuid` (the historical
   *  shape). `text` / `integer` exist so external-DB migration can copy
   *  source primary keys verbatim — preserved PKs are what keep the
   *  source's FK values valid without an id-remap. Integer-keyed
   *  collections never auto-generate ids; item POST requires the key in
   *  the body (same contract as adopted tables). Ignored for adopted
   *  creates — there it's derived from the introspected PK column. */
  pkType: z.enum(["uuid", "text", "integer"]).optional(),
  /** Adopted-only flags asserting the source table has the conventional
   *  system column. Ignored for managed creates (always true). */
  hasCreatedAt: z.boolean().optional(),
  hasUpdatedAt: z.boolean().optional(),
  /** Adopted-only: alias an existing column to a system field. e.g.
   *  `createdAtColumn: "inserted_at"` makes routes/items.ts read
   *  `created_at` from `inserted_at` without DDL. Null/omitted = use the
   *  conventional name. Ignored for managed creates. */
  createdAtColumn: z.string().min(1).max(120).nullable().optional(),
  updatedAtColumn: z.string().min(1).max(120).nullable().optional(),
  /** Adopted-only: when set on an owner-scoped collection, ownership
   *  reads from this column on the source table instead of the
   *  `item_ownership` side-table. */
  ownerIdColumn: z.string().min(1).max(120).nullable().optional(),
});

// PATCH must NOT reuse CollectionInput's create-time defaults: `.default()`
// survives `.partial()` in zod, so a partial update that omits a flag would
// parse it to its default and the `!== undefined` guards below would then
// "apply" it — e.g. a bare rename PATCH would silently turn `versioned` /
// `softDelete` / `fts` back off (and `tenantScoped` back on). Re-declare the
// defaulted flags as plain optionals.
const CollectionPatch = CollectionInput.partial().extend({
  ownerScoped: z.boolean().optional(),
  tenantScoped: z.boolean().optional(),
  versioned: z.boolean().optional(),
  stagedEdits: z.boolean().optional(),
  softDelete: z.boolean().optional(),
  singleton: z.boolean().optional(),
  auditReads: z.boolean().optional(),
  vectorize: z.boolean().optional(),
  fts: z.boolean().optional(),
  adopted: z.boolean().optional(),
  hidden: z.boolean().optional(),
  /** Enable/disable the collection. `inactive` keeps it visible + editable in
   *  the admin but 404s all item traffic (loadCollection only serves
   *  `active`). `archived` is NOT patchable — it goes through the dedicated
   *  archive/restore routes. */
  status: z.enum(["active", "inactive"]).optional(),
});

/** Body of `POST /:slug/clone` — just the new slug; everything else is
 *  copied from the source collection. */
const CloneInput = z.object({
  slug: z.string().min(1).max(120).regex(/^[a-z][a-z0-9_]*$/),
});

/** Full-layout write for the Collections page "Edit layout" mode: every
 *  collection's `{group, sortOrder}` plus the ordered group-header list, in
 *  one request with a single cache invalidation (per-row PATCH would also
 *  re-run DDL via `applyCollection` N times). */
const LayoutInput = z.object({
  groups: z.array(z.string().min(1).max(60)).max(200),
  items: z
    .array(
      z.object({
        slug: z.string().min(1),
        group: z.string().min(1).max(60).nullable(),
        sortOrder: z.number().int().min(0).max(100_000).nullable(),
      }),
    )
    .max(500),
});

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.collections : sqlite.schema.collections;

const settingsTableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.appSettings : sqlite.schema.appSettings;

/** Ordered group-header names for the Collections page + sidebar tree —
 *  the tenant's `collectionGroups` app_settings row, behind the same
 *  per-isolate cache/invalidation as the collection rows themselves. */
const loadGroupOrder = async (
  db: unknown,
  dialect: "pg" | "sqlite",
  tenantId: string,
): Promise<string[]> => {
  const cached = getCachedGroupOrder(tenantId);
  if (cached) return cached;
  const st = settingsTableFor(dialect);
  const rows = (await (db as any)
    .select({ value: st.value })
    .from(st)
    .where(and(eq(st.tenantId, tenantId), eq(st.key, "collectionGroups")))
    .limit(1)) as { value: unknown }[];
  const v = rows[0]?.value;
  const groups =
    Array.isArray(v) && v.every((x) => typeof x === "string") ? v : [];
  setCachedGroupOrder(tenantId, groups);
  return groups;
};

/** Pull the active tenant from the request, throwing if it isn't set.
 *  Collections are workspace-scoped — every route here needs one. */
const requireTenant = (c: { get: (k: string) => any }): string => {
  const tenantId = c.get("auth")?.tenantId as string | undefined;
  if (!tenantId) {
    throw new AppError("UNAUTHORIZED", "Active tenant required");
  }
  return tenantId;
};

/** DDL is an operator action: signed-in + platform plane (never a workspace
 *  end-user) + admin role. Mirrors the `/api/admin/adopt` and `/api/admin/db`
 *  gates so every schema-mutating surface is locked the same way. */
const DDL_GATE = [requireUser, requirePlatformMw, requireAdminMw] as const;

/** Digest of a collection set's identity + version, for a weak ETag. The schema
 *  (read on nearly every admin page load + MCP tool) changes rarely, so the
 *  digest is stable across requests until a create/rename/field/archive bumps
 *  some row's `updatedAt`. */
const schemaDigest = (
  rows: { id?: unknown; updatedAt?: unknown }[],
): string => rows.map((r) => `${String(r.id)}:${String(r.updatedAt)}`).join(",");

/** Set the conditional-GET headers and return a 304 when the client already
 *  holds this version. Same private/no-cache/Vary posture as the item reads. */
const schemaEtag304 = (
  c: Context<AppBindings>,
  parts: (string | number)[],
): Response | null => {
  const etag = weakETag(parts);
  c.header("ETag", etag);
  c.header("Cache-Control", "private, no-cache");
  c.header("Vary", "Authorization, Cookie");
  return ifNoneMatch(c.req.header("if-none-match"), etag) ? c.body(null, 304) : null;
};

export const collectionsRoutes = new Hono<AppBindings>()
  .get("/", requireUser, async (c) => {
    const { db, dialect } = c.get("ctx");
    const tenantId = requireTenant(c);
    const t = tableFor(dialect);
    // Default hides archived (adopted) collections so the admin UI
    // doesn't have to know about the lifecycle column.
    // `?include_archived=true` opts into the full set — used by the
    // "Archived" panel that exposes restore.
    const includeArchived = c.req.query("include_archived") === "true";
    let rows = getCachedCollections({ tenantId, includeArchived }) as
      | { id?: unknown; updatedAt?: unknown }[]
      | undefined;
    if (!rows) {
      rows = await (db as any)
        .select()
        .from(t)
        .where(
          // `inactive` collections stay visible (they're admin-manageable —
          // only item traffic is blocked); only `archived` is hidden here.
          includeArchived
            ? eq(t.tenantId, tenantId)
            : and(eq(t.tenantId, tenantId), ne(t.status, "archived")),
        );
      setCachedCollections({ tenantId, includeArchived }, rows!);
    }
    // Permission-aware visibility: non-admins only see collections they hold
    // at least one `read` grant for (wildcard grant = all). The per-isolate
    // cache stays tenant-keyed with the FULL row set; the filter runs per
    // request so one cache entry serves every caller.
    const readable = await listReadableCollections(c.get("ctx"), c.get("auth"));
    const visible =
      readable === "*"
        ? rows!
        : rows!.filter((r) => readable.has((r as { slug: string }).slug));
    const groups = await loadGroupOrder(db, dialect, tenantId);
    // Cheap revalidation on top of the per-isolate cache: a warm client that
    // already has the current schema gets an empty 304 instead of the full
    // (often large) collection-list payload. Layout state is digested by
    // VALUE, not via updatedAt: the header order changes no collection row,
    // and two rapid layout writes can land in the same millisecond — either
    // way an updatedAt-only digest would hand a stale 304 to the client.
    // Digesting the VISIBLE rows also busts the validator when a permission
    // grant/revoke changes what this caller may see.
    const layoutDigest = (visible as { group?: unknown; sortOrder?: unknown }[])
      .map((r) => `${String(r.group ?? "")}.${String(r.sortOrder ?? "")}`)
      .join(",");
    const r304 = schemaEtag304(c, [
      "collections",
      tenantId,
      includeArchived ? 1 : 0,
      schemaDigest(visible),
      layoutDigest,
      groups.join("|"),
    ]);
    if (r304) return r304;
    return c.json({ data: visible, meta: { groups } });
  })
  .get("/:slug", requireUser, async (c) => {
    const { db, dialect } = c.get("ctx");
    const tenantId = requireTenant(c);
    const t = tableFor(dialect);
    const includeArchived = c.req.query("include_archived") === "true";
    const row = await (db as any)
      .select()
      .from(t)
      .where(and(eq(t.tenantId, tenantId), eq(t.slug, c.req.param("slug"))))
      .limit(1);
    if (!row[0]) throw new AppError("NOT_FOUND", "Collection not found");
    if (!includeArchived && (row[0].status ?? "active") === "archived") {
      throw new AppError("NOT_FOUND", "Collection not found");
    }
    // Same visibility rule as the list: no read grant → the collection's
    // metadata (field names etc.) doesn't exist for this caller.
    const readable = await listReadableCollections(c.get("ctx"), c.get("auth"));
    if (readable !== "*" && !readable.has(c.req.param("slug"))) {
      throw new AppError("NOT_FOUND", "Collection not found");
    }
    const r304 = schemaEtag304(c, [
      "collection",
      tenantId,
      String(row[0].id),
      String(row[0].updatedAt),
    ]);
    if (r304) return r304;
    return c.json({ data: row[0] });
  })
  /**
   * Restore an archived (adopted) collection. No-op when the row is
   * already active; 404 when it doesn't exist. The `authenticated`
   * role's owner-scoped permissions are re-seeded so a restore is
   * one-shot, not "restore + re-grant permissions".
   */
  .post("/:slug/restore", ...DDL_GATE, async (c) => {
    const slug = c.req.param("slug");
    const { db, dialect } = c.get("ctx");
    const tenantId = requireTenant(c);
    const t = tableFor(dialect);
    const existing = await (db as any)
      .select()
      .from(t)
      .where(and(eq(t.tenantId, tenantId), eq(t.slug, slug)))
      .limit(1);
    if (!existing[0]) throw new AppError("NOT_FOUND", "Collection not found");
    if ((existing[0].status ?? "active") === "active") {
      return c.json({ ok: true, alreadyActive: true });
    }
    await (db as any)
      .update(t)
      .set({ status: "active", archivedAt: null })
      .where(and(eq(t.tenantId, tenantId), eq(t.slug, slug)));
    invalidateTenantCollections(tenantId);
    if (existing[0].ownerScoped ?? existing[0].owner_scoped) {
      await seedOwnerScopedPermissions({ db, dialect }, tenantId, slug);
      invalidateTenantPermissions(tenantId);
    }
    await logActivity(c, {
      action: "restore",
      collection: "system_collections",
      itemId: slug,
      response: { ok: true },
    });
    return c.json({ ok: true });
  })
  /**
   * Clone a collection's schema into a new managed collection. Copies fields
   * + all metadata (labels, display template, icon/color, flags, kanban
   * config); never copies data. Adopted sources clone into a managed table
   * built from their field definitions. Delegates to
   * `services/collections.ts::cloneCollection` — the single implementation
   * shared with GraphQL/SDK/CLI.
   */
  .post("/:slug/clone", ...DDL_GATE, async (c) => {
    const sourceSlug = c.req.param("slug");
    const body = CloneInput.parse(await c.req.json());
    const { db, dialect } = c.get("ctx");
    const tenantId = requireTenant(c);
    try {
      await cloneCollection({ db, dialect }, tenantId, sourceSlug, body.slug);
    } catch (e) {
      const msg = (e as Error).message;
      if (msg === "SOURCE_NOT_FOUND") {
        throw new AppError("NOT_FOUND", "Collection not found");
      }
      if (msg === "SLUG_TAKEN") {
        throw new AppError(
          "CONFLICT",
          `Collection slug "${body.slug}" already exists in this workspace`,
        );
      }
      throw e;
    }
    invalidateTenantCollections(tenantId);
    const t = tableFor(dialect);
    const created = await (db as any)
      .select()
      .from(t)
      .where(and(eq(t.tenantId, tenantId), eq(t.slug, body.slug)))
      .limit(1);
    await logActivity(c, {
      action: "create",
      collection: "system_collections",
      itemId: body.slug,
      payload: { clonedFrom: sourceSlug },
      response: { ok: true },
    });
    return c.json({ data: created[0] }, 201);
  })
  /**
   * Unified create — one endpoint for both managed (we own the DDL) and
   * adopted (existing table, no DDL) collections. `body.adopted` controls
   * which path runs; the `physical_table` column is the single source of
   * truth either way, so the runtime read path doesn't branch.
   *
   *   Managed (`adopted: false`, default):
   *     - physicalTable optional, defaults to derivePhysicalTable(tenant, slug)
   *     - table must NOT exist (we're about to CREATE it)
   *     - pkColumn / hasCreatedAt / createdAtColumn / etc. ignored — always
   *       "id" + true + null
   *
   *   Adopted (`adopted: true`):
   *     - physicalTable required, table MUST exist
   *     - introspected via inspectTable; pkColumn must match the real PK,
   *       field names must exist on the table, alias columns must be present
   *       and type-compatible
   *     - applier short-circuits — never touches the user's table
   */
  .post("/", ...DDL_GATE, async (c) => {
    const body = CollectionInput.parse(await c.req.json());
    try {
      validateFields(body.fields);
    } catch (e) {
      throw new AppError("VALIDATION", (e as Error).message);
    }
    const { db, dialect } = c.get("ctx");
    const tenantId = requireTenant(c);
    const t = tableFor(dialect);

    // Slug uniqueness per workspace.
    const slugConflict = await (db as any)
      .select({ id: t.id })
      .from(t)
      .where(and(eq(t.tenantId, tenantId), eq(t.slug, body.slug)))
      .limit(1);
    if (slugConflict[0]) throw new AppError("CONFLICT", "Slug already exists");

    let physicalTable: string;
    let pkColumn = "id";
    let pkType: "uuid" | "text" | "integer" = "uuid";
    let hasCreatedAt = true;
    let hasUpdatedAt = true;
    let createdAtColumn: string | null = null;
    let updatedAtColumn: string | null = null;
    let ownerIdColumn: string | null = null;

    if (body.adopted) {
      if (!body.physicalTable) {
        throw new AppError(
          "VALIDATION",
          "physicalTable is required when adopted is true",
        );
      }
      try {
        assertIdent(body.physicalTable);
      } catch (e) {
        throw new AppError("VALIDATION", (e as Error).message);
      }
      physicalTable = body.physicalTable;
      if (!(await tableExists(db, dialect, physicalTable))) {
        throw new AppError("NOT_FOUND", `Table "${physicalTable}" not found`);
      }
      let inspection;
      try {
        inspection = await inspectTable({ db, dialect }, physicalTable);
      } catch (e) {
        const msg = (e as Error).message;
        if (/not found/i.test(msg)) throw new AppError("NOT_FOUND", msg);
        throw new AppError("VALIDATION", msg);
      }
      if (!inspection.pk) {
        throw new AppError(
          "VALIDATION",
          `Table "${physicalTable}" has no primary key — adoption requires a single-column PK`,
        );
      }
      pkColumn = body.pkColumn ?? inspection.pk.column;
      if (pkColumn !== inspection.pk.column) {
        throw new AppError(
          "VALIDATION",
          `pkColumn "${pkColumn}" does not match the table's primary key column "${inspection.pk.column}"`,
        );
      }
      // Record what the source PK actually is (informational for adopted
      // tables — no DDL runs — but keeps gen-types/SDK metadata honest).
      const inspectedPk = inspection.columns.find((col) => col.name === pkColumn);
      pkType =
        inspectedPk?.suggested === "integer"
          ? "integer"
          : inspectedPk?.suggested === "uuid"
            ? "uuid"
            : "text";
      const colNames = new Set(inspection.columns.map((col) => col.name));
      for (const f of body.fields) {
        if (!colNames.has(f.name)) {
          throw new AppError(
            "VALIDATION",
            `Field "${f.name}" not found on table "${physicalTable}"`,
          );
        }
        // The pkColumn override may legitimately point at "id"; everything
        // else colliding with a reserved name is a footgun.
        if (RESERVED_NAMES.has(f.name) && f.name !== pkColumn) {
          throw new AppError(
            "VALIDATION",
            `Field name "${f.name}" collides with a reserved system column`,
          );
        }
      }
      // Alias resolution. We never invent columns; an alias pointing nowhere
      // would silently corrupt reads.
      const colByName = new Map(
        inspection.columns.map((col) => [col.name, col] as const),
      );
      const validateAlias = (
        logical: "createdAt" | "updatedAt" | "ownerId",
        raw: string | null | undefined,
      ): string | null => {
        if (!raw) return null;
        const col = colByName.get(raw);
        if (!col) {
          throw new AppError(
            "VALIDATION",
            `${logical}Column "${raw}" not found on table "${physicalTable}"`,
          );
        }
        if (logical === "ownerId") {
          if (
            col.suggested !== "text" &&
            col.suggested !== "longtext" &&
            col.suggested !== "uuid"
          ) {
            throw new AppError(
              "VALIDATION",
              `${logical}Column "${raw}" must be a text/uuid type (got ${col.dbType})`,
            );
          }
        } else {
          if (col.suggested !== "timestamp" && col.suggested !== "integer") {
            throw new AppError(
              "VALIDATION",
              `${logical}Column "${raw}" must be a timestamp/integer type (got ${col.dbType})`,
            );
          }
        }
        return raw;
      };
      // Normalize: an alias pointing at the conventional name is the same
      // as no alias (cleaner storage; routes/items.ts treats null as "use
      // the conventional name").
      createdAtColumn = validateAlias(
        "createdAt",
        body.createdAtColumn === "created_at" ? null : body.createdAtColumn,
      );
      updatedAtColumn = validateAlias(
        "updatedAt",
        body.updatedAtColumn === "updated_at" ? null : body.updatedAtColumn,
      );
      ownerIdColumn = validateAlias(
        "ownerId",
        body.ownerIdColumn === "owner_id" ? null : body.ownerIdColumn,
      );
      hasCreatedAt =
        Boolean(createdAtColumn) ||
        (body.hasCreatedAt ?? false) ||
        inspection.systemColumnsPresent.createdAt;
      hasUpdatedAt =
        Boolean(updatedAtColumn) ||
        (body.hasUpdatedAt ?? false) ||
        inspection.systemColumnsPresent.updatedAt;
      if (
        body.hasCreatedAt &&
        !inspection.systemColumnsPresent.createdAt &&
        !createdAtColumn
      ) {
        throw new AppError(
          "VALIDATION",
          "hasCreatedAt is true but the table has no created_at column (use createdAtColumn to alias an existing column instead)",
        );
      }
      if (
        body.hasUpdatedAt &&
        !inspection.systemColumnsPresent.updatedAt &&
        !updatedAtColumn
      ) {
        throw new AppError(
          "VALIDATION",
          "hasUpdatedAt is true but the table has no updated_at column",
        );
      }
      if (ownerIdColumn && !body.ownerScoped) {
        throw new AppError(
          "VALIDATION",
          "ownerIdColumn is set but ownerScoped is false — drop one or the other",
        );
      }
    } else {
      // Managed path. Custom physicalTable is allowed but optional — the
      // default `c_<tenantPrefix12>_<slug>` keeps two workspaces from
      // colliding when they happen to pick the same slug.
      // Honor the timestamps toggle: when the caller opts out, the applier
      // skips the created_at/updated_at columns and the read/write paths
      // gate on these flags (same plumbing adopted tables already use).
      hasCreatedAt = body.hasCreatedAt ?? true;
      hasUpdatedAt = body.hasUpdatedAt ?? true;
      pkType = body.pkType ?? "uuid";
      if (body.physicalTable) {
        try {
          assertIdent(body.physicalTable);
        } catch (e) {
          throw new AppError("VALIDATION", (e as Error).message);
        }
        physicalTable = body.physicalTable;
      } else {
        physicalTable = derivePhysicalTable(tenantId, body.slug);
      }
      if (await tableExists(db, dialect, physicalTable)) {
        throw new AppError(
          "CONFLICT",
          `Physical table "${physicalTable}" already exists. To register it as a collection, set adopted=true instead.`,
        );
      }
    }

    // Physical-table uniqueness check (friendly per-workspace error; the
    // DB-level `collections_physical_table_idx` enforces the hard guarantee).
    const tableConflict = await (db as any)
      .select({ slug: t.slug })
      .from(t)
      .where(and(eq(t.tenantId, tenantId), eq(t.physicalTable, physicalTable)))
      .limit(1);
    if (tableConflict[0]) {
      throw new AppError(
        "CONFLICT",
        `Physical table "${physicalTable}" is already registered as collection "${tableConflict[0].slug}"`,
      );
    }

    // Soft-delete needs a physical `deleted_at` column, so it's managed-only;
    // forcing it false for adopted creates avoids reads referencing a column
    // that doesn't exist on the source table. Singleton is pure insert-guard
    // behavior (no DDL), so it's allowed on either path.
    const softDelete = body.adopted ? false : body.softDelete;
    const singleton = body.singleton;

    // Rollups name another collection, so they can only be checked once that
    // collection is resolvable — after the shape pass, before anything is
    // stored. (Chicken-and-egg is real but one-directional: create the child
    // first, then the parent that rolls it up, or PATCH the rollup on after.)
    await validateRollupTargets(c.get("ctx"), tenantId, { slug: body.slug, pkType }, body.fields);

    const id = crypto.randomUUID();
    await (db as any).insert(t).values({
      id,
      slug: body.slug,
      tenantId,
      physicalTable,
      singular: body.singular ?? null,
      plural: body.plural ?? null,
      note: body.note ?? null,
      displayTemplate: body.displayTemplate ?? null,
      icon: body.icon ?? null,
      color: body.color ?? null,
      hidden: body.hidden,
      previewUrl: body.previewUrl ?? null,
      fields: body.fields,
      ownerScoped: body.ownerScoped,
      tenantScoped: body.tenantScoped,
      versioned: body.versioned,
      stagedEdits: body.stagedEdits,
      softDelete,
      singleton,
      auditReads: body.auditReads,
      vectorize: body.vectorize,
      vectorizeModel: body.vectorizeModel ?? null,
      fts: body.fts,
      defaultSort: body.defaultSort ?? null,
      kanbanGroupBy: body.kanbanGroupBy ?? null,
      kanbanActionMap: body.kanbanActionMap ?? null,
      group: body.group ?? null,
      sortOrder: body.sortOrder ?? null,
      adopted: body.adopted,
      pkColumn,
      pkType,
      hasCreatedAt,
      hasUpdatedAt,
      createdAtColumn,
      updatedAtColumn,
      ownerIdColumn,
    });
    invalidateTenantCollections(tenantId);
    await applyCollection(db, dialect, {
      table: physicalTable,
      fields: body.fields,
      pkType,
      ownerScoped: body.ownerScoped,
      tenantScoped: body.tenantScoped,
      versioned: body.versioned,
      hasCreatedAt,
      hasUpdatedAt,
      softDelete,
      fts: body.fts,
      adopted: body.adopted,
    });
    if (body.ownerScoped) {
      await seedOwnerScopedPermissions({ db, dialect }, tenantId, body.slug);
      invalidateTenantPermissions(tenantId);
    }
    const created = {
      id,
      slug: body.slug,
      tenantId,
      physicalTable,
      singular: body.singular ?? null,
      plural: body.plural ?? null,
      note: body.note ?? null,
      displayTemplate: body.displayTemplate ?? null,
      icon: body.icon ?? null,
      color: body.color ?? null,
      hidden: body.hidden,
      previewUrl: body.previewUrl ?? null,
      fields: body.fields,
      ownerScoped: body.ownerScoped,
      tenantScoped: body.tenantScoped,
      versioned: body.versioned,
      stagedEdits: body.stagedEdits,
      softDelete,
      singleton,
      auditReads: body.auditReads,
      vectorize: body.vectorize,
      vectorizeModel: body.vectorizeModel ?? null,
      fts: body.fts,
      defaultSort: body.defaultSort ?? null,
      kanbanGroupBy: body.kanbanGroupBy ?? null,
      kanbanActionMap: body.kanbanActionMap ?? null,
      group: body.group ?? null,
      sortOrder: body.sortOrder ?? null,
      adopted: body.adopted,
      pkColumn,
      pkType,
      hasCreatedAt,
      hasUpdatedAt,
      createdAtColumn,
      updatedAtColumn,
      ownerIdColumn,
    };
    await logActivity(c, {
      action: "create",
      collection: "system_collections",
      itemId: body.slug,
      payload: { fields: body.fields.length, adopted: body.adopted },
      response: { data: created },
    });
    return c.json({ data: created }, 201);
  })
  .post("/layout", ...DDL_GATE, async (c) => {
    const body = LayoutInput.parse(await c.req.json());
    const { db, dialect } = c.get("ctx");
    const tenantId = requireTenant(c);
    const t = tableFor(dialect);
    const existing = (await (db as any)
      .select({ slug: t.slug, group: t.group, sortOrder: t.sortOrder })
      .from(t)
      .where(eq(t.tenantId, tenantId))) as {
      slug: string;
      group: string | null;
      sortOrder: number | null;
    }[];
    const bySlug = new Map(existing.map((r) => [r.slug, r]));
    let changed = 0;
    for (const it of body.items) {
      const cur = bySlug.get(it.slug);
      // Unknown slugs are skipped, not 404s: the client computes the layout
      // from a snapshot that may race a concurrent delete/rename.
      if (!cur) continue;
      if (cur.group === it.group && cur.sortOrder === it.sortOrder) continue;
      await (db as any)
        .update(t)
        // updatedAt bump = ETag digest bust (schemaDigest is id:updatedAt).
        .set({ group: it.group, sortOrder: it.sortOrder, updatedAt: new Date() })
        .where(and(eq(t.tenantId, tenantId), eq(t.slug, it.slug)));
      changed++;
    }
    // Group-header order → app_settings, via the same atomic upsert the
    // settings route uses (check-then-insert raced under concurrent writes).
    const st = settingsTableFor(dialect);
    const settingsUpdatedAt = dialect === "pg" ? new Date() : Date.now();
    await (db as any)
      .insert(st)
      .values({
        id: crypto.randomUUID(),
        tenantId,
        key: "collectionGroups",
        value: body.groups,
      })
      .onConflictDoUpdate({
        target: [st.tenantId, st.key],
        set: { value: body.groups, updatedAt: settingsUpdatedAt },
      });
    invalidateTenantCollections(tenantId);
    const response = { ok: true, changed };
    await logActivity(c, {
      action: "update",
      collection: "system_collections",
      itemId: "__layout__",
      payload: { groups: body.groups.length, items: body.items.length },
      response,
    });
    return c.json(response);
  })
  .patch("/:slug", ...DDL_GATE, async (c) => {
    const slug = c.req.param("slug");
    const body = CollectionPatch.parse(await c.req.json());
    if (body.fields) {
      try {
        validateFields(body.fields);
      } catch (e) {
        throw new AppError("VALIDATION", (e as Error).message);
      }
    }
    const { db, dialect } = c.get("ctx");
    const tenantId = requireTenant(c);
    const t = tableFor(dialect);
    const existing = await (db as any)
      .select()
      .from(t)
      .where(and(eq(t.tenantId, tenantId), eq(t.slug, slug)))
      .limit(1);
    if (!existing[0]) throw new AppError("NOT_FOUND", "Collection not found");

    // Slug rename: only when the body explicitly sends a different slug.
    // Validate target uniqueness within the tenant before touching anything,
    // then cascade the slug to every place it's stored as data (permissions,
    // revisions, comments, activity, webhook patterns, function patterns,
    // flow ops). The physical table name is not touched.
    let renameCounts: Awaited<ReturnType<typeof cascadeSlugRename>> | null = null;
    let nextSlug = slug;
    if (body.slug && body.slug !== slug) {
      const conflict = await (db as any)
        .select({ slug: t.slug })
        .from(t)
        .where(and(eq(t.tenantId, tenantId), eq(t.slug, body.slug)))
        .limit(1);
      if (conflict[0]) {
        throw new AppError("CONFLICT", `Collection slug "${body.slug}" already exists in this workspace`);
      }
      nextSlug = body.slug;
    }

    const merged = {
      ...existing[0],
      ...(nextSlug !== slug ? { slug: nextSlug } : {}),
      ...(body.singular !== undefined ? { singular: body.singular } : {}),
      ...(body.plural !== undefined ? { plural: body.plural } : {}),
      ...(body.note !== undefined ? { note: body.note } : {}),
      ...(body.displayTemplate !== undefined
        ? { displayTemplate: body.displayTemplate }
        : {}),
      ...(body.icon !== undefined ? { icon: body.icon ?? null } : {}),
      ...(body.color !== undefined ? { color: body.color ?? null } : {}),
      ...(body.hidden !== undefined ? { hidden: body.hidden } : {}),
      ...(body.previewUrl !== undefined
        ? { previewUrl: body.previewUrl ?? null }
        : {}),
      // active ⇄ inactive only — archived rows keep their lifecycle (the
      // dedicated archive/restore routes own that transition, incl. the
      // permission re-seed on restore).
      ...(body.status !== undefined &&
      (existing[0].status ?? "active") !== "archived"
        ? { status: body.status }
        : {}),
      ...(body.fields ? { fields: body.fields } : {}),
      ...(body.ownerScoped !== undefined
        ? { ownerScoped: body.ownerScoped }
        : {}),
      ...(body.tenantScoped !== undefined
        ? { tenantScoped: body.tenantScoped }
        : {}),
      ...(body.versioned !== undefined ? { versioned: body.versioned } : {}),
      ...(body.stagedEdits !== undefined ? { stagedEdits: body.stagedEdits } : {}),
      ...(body.auditReads !== undefined ? { auditReads: body.auditReads } : {}),
      ...(body.vectorize !== undefined ? { vectorize: body.vectorize } : {}),
      ...(body.vectorizeModel !== undefined
        ? { vectorizeModel: body.vectorizeModel ?? null }
        : {}),
      ...(body.fts !== undefined ? { fts: body.fts } : {}),
      ...(body.defaultSort !== undefined
        ? { defaultSort: body.defaultSort ?? null }
        : {}),
      ...(body.kanbanGroupBy !== undefined
        ? { kanbanGroupBy: body.kanbanGroupBy ?? null }
        : {}),
      ...(body.kanbanActionMap !== undefined
        ? { kanbanActionMap: body.kanbanActionMap ?? null }
        : {}),
      ...(body.group !== undefined ? { group: body.group ?? null } : {}),
      ...(body.sortOrder !== undefined
        ? { sortOrder: body.sortOrder ?? null }
        : {}),
      updatedAt: new Date(),
    };
    if (body.fields) {
      await validateRollupTargets(
        c.get("ctx"),
        tenantId,
        {
          slug: nextSlug,
          pkType: (merged.pkType ?? merged.pk_type) as string | undefined,
        },
        merged.fields as FieldDef[],
      );
    }
    await (db as any)
      .update(t)
      .set(merged)
      .where(and(eq(t.tenantId, tenantId), eq(t.slug, slug)));

    if (nextSlug !== slug) {
      renameCounts = await cascadeSlugRename(db, dialect, tenantId, slug, nextSlug);
      // Permission rows just got their `collection` rewritten; cached entries
      // keyed by the old slug would still claim allow=true.
      invalidateTenantPermissions(tenantId);
    }

    await applyCollection(db, dialect, {
      table: merged.physicalTable ?? merged.physical_table,
      fields: merged.fields,
      ownerScoped: merged.ownerScoped,
      tenantScoped: merged.tenantScoped ?? merged.tenant_scoped ?? true,
      versioned: merged.versioned,
      // Thread the collection's stored timestamp/soft-delete shape so a PATCH
      // doesn't re-add created_at/updated_at to a timestamps-off collection
      // (the applier defaults these to true when omitted).
      hasCreatedAt: merged.hasCreatedAt ?? merged.has_created_at ?? true,
      hasUpdatedAt: merged.hasUpdatedAt ?? merged.has_updated_at ?? true,
      softDelete: Boolean(merged.softDelete ?? merged.soft_delete),
      fts: Boolean(merged.fts),
      adopted: Boolean(merged.adopted),
    });
    if (merged.ownerScoped) {
      await seedOwnerScopedPermissions({ db, dialect }, tenantId, nextSlug);
      invalidateTenantPermissions(tenantId);
    }

    // Auto-backfill the full-text index when what feeds it changed: FTS just
    // toggled on, or the searchable field set moved while it's on. Without
    // this, rows written before the change stay invisible to search until an
    // admin manually hits `/:slug/fts-reindex` — the #1 "search returns
    // nothing" trap. Skipped for adopted tables (FTS is managed-only; the
    // applier never creates index objects for them).
    const before = existing[0] as Record<string, unknown>;
    const ftsMeta = {
      fts: Boolean(merged.fts),
      physicalTable: (merged.physicalTable ?? merged.physical_table) as string,
      pkColumn: ((merged.pkColumn ?? merged.pk_column) as string | undefined) ?? "id",
      fields: merged.fields as FieldDef[],
      tenantScoped: Boolean(merged.tenantScoped ?? merged.tenant_scoped ?? true),
    };
    let ftsBackfill: Awaited<ReturnType<typeof backfillFts>> | null = null;
    if (
      !merged.adopted &&
      isSearchable(ftsMeta) &&
      ftsIndexSignature(ftsMeta) !==
        ftsIndexSignature({ fts: Boolean(before.fts), fields: before.fields as FieldDef[] })
    ) {
      ftsBackfill = await backfillFts(c.get("ctx"), ftsMeta, tenantId);
    }

    // Invalidate after *all* metadata writes (the row update above plus any
    // cascadeSlugRename) so a same-isolate read can't repopulate the cache
    // mid-rename.
    invalidateTenantCollections(tenantId);

    // Auto-backfill rollup columns whose definition just changed. Same reason
    // as the FTS backfill above, and the same failure without it: the applier
    // adds the column with its neutral default, so every EXISTING parent would
    // read 0 — a total that is confidently wrong, which is worse than one
    // that's obviously missing. Runs after the cache invalidation so
    // `loadCollection` re-reads the definition we just stored.
    let rollupBackfill: string[] | null = null;
    if (!merged.adopted && rollupSignature(merged.fields as FieldDef[]) !==
        rollupSignature(before.fields as FieldDef[])) {
      const fresh = await loadCollection(c.get("ctx"), tenantId, nextSlug);
      rollupBackfill = await refreshCollectionRollups(c.get("ctx"), tenantId, fresh);
    }
    // Catch the counters up for sequence fields that were just ADDED. Without
    // this, adding a numbering field to a collection whose rows already carry
    // numbers — which is the ordinary way an adopted table arrives — leaves the
    // counter at zero, and the very next create reissues a number that is
    // already on a document. Only new fields are considered: re-syncing an
    // existing one on every unrelated PATCH would scan the whole table for
    // nothing.
    const addedSequences = sequenceFieldsOf(merged.fields as FieldDef[]).filter(
      (f) => !(before.fields as FieldDef[]).some((b) => b.name === f.name && b.sequence),
    );
    let sequenceSync: Awaited<ReturnType<typeof syncSequenceCounters>> | null = null;
    if (addedSequences.length > 0) {
      const fresh = await loadCollection(c.get("ctx"), tenantId, nextSlug);
      sequenceSync = await syncSequenceCounters(c.get("ctx"), tenantId, fresh, addedSequences);
    }
    const updateResponse = {
      ok: true,
      slug: nextSlug,
      renamed: renameCounts,
      ftsBackfill,
      ...(rollupBackfill ? { rollupBackfill } : {}),
      ...(sequenceSync ? { sequenceSync } : {}),
    };
    await logActivity(c, {
      action: "update",
      collection: "system_collections",
      itemId: nextSlug,
      payload: renameCounts ? { ...body, _rename: { from: slug, to: nextSlug, ...renameCounts } } : body,
      response: updateResponse,
    });
    return c.json(updateResponse);
  })
  /**
   * Drop a single field (column) from a managed collection. The metadata
   * `fields` array is the source of truth, so we remove the entry there and
   * then `ALTER TABLE … DROP COLUMN` via the applier. Destructive and
   * irreversible (the column's data is gone) — kept as its own endpoint, not
   * folded into PATCH, because `applyCollection` is additive-only and never
   * drops columns. Refused on adopted tables (we never touch the user's DDL).
   */
  .delete("/:slug/fields/:name", ...DDL_GATE, async (c) => {
    const slug = c.req.param("slug");
    const fieldName = c.req.param("name");
    const { db, dialect } = c.get("ctx");
    const tenantId = requireTenant(c);
    const t = tableFor(dialect);
    const existing = await (db as any)
      .select()
      .from(t)
      .where(and(eq(t.tenantId, tenantId), eq(t.slug, slug)))
      .limit(1);
    if (!existing[0]) throw new AppError("NOT_FOUND", "Collection not found");
    if (existing[0].adopted) {
      throw new AppError(
        "VALIDATION",
        "Cannot drop a field from an adopted collection — backlex never alters the source table.",
      );
    }
    if (RESERVED_NAMES.has(fieldName)) {
      throw new AppError("VALIDATION", `"${fieldName}" is a reserved column and cannot be dropped.`);
    }
    const fields = (existing[0].fields ?? []) as FieldDef[];
    const target = fields.find((f) => f.name === fieldName);
    if (!target) throw new AppError("NOT_FOUND", `Field "${fieldName}" not found`);
    const nextFields = fields.filter((f) => f.name !== fieldName);
    const physicalTable = (existing[0].physicalTable ?? existing[0].physical_table) as string;
    // Metadata first, then the physical DROP COLUMN. If the ALTER fails the
    // metadata write is rolled forward-compatible (the column simply still
    // exists physically but is hidden from the API — the next apply is a no-op).
    await (db as any)
      .update(t)
      .set({ fields: nextFields, updatedAt: new Date() })
      .where(and(eq(t.tenantId, tenantId), eq(t.slug, slug)));
    await dropField(db, dialect, physicalTable, fieldName);
    // A dropped sequence field's counter is meaningless — and would silently
    // resume if a field of the same name were added back.
    if (target.sequence) {
      await dropSequenceCounters(c.get("ctx"), tenantId, slug, fieldName);
    }
    invalidateTenantCollections(tenantId);
    const dropResponse = { ok: true, slug, field: fieldName };
    await logActivity(c, {
      action: "drop_field",
      collection: "system_collections",
      itemId: slug,
      payload: { field: fieldName, type: target.type },
      response: dropResponse,
    });
    return c.json(dropResponse);
  })
  .delete("/:slug", ...DDL_GATE, async (c) => {
    const slug = c.req.param("slug");
    const { db, dialect } = c.get("ctx");
    const tenantId = requireTenant(c);
    const t = tableFor(dialect);
    const existing = await (db as any)
      .select()
      .from(t)
      .where(and(eq(t.tenantId, tenantId), eq(t.slug, slug)))
      .limit(1);
    if (!existing[0]) throw new AppError("NOT_FOUND", "Collection not found");
    const physicalTable = (existing[0].physicalTable ?? existing[0].physical_table) as string;
    const adopted = Boolean(existing[0].adopted);
    if (adopted) {
      // Archive adopted collections: physical table is intact (the
      // applier already short-circuits on adopted), so flipping
      // `status` on the metadata row is enough. The data stays
      // queryable directly on the source DB; only backlex stops
      // treating the table as a collection. `POST /:slug/restore`
      // flips it back. We DON'T do this for managed collections
      // because their `c_<slug>` table is about to be dropped — a
      // restorable row with no data behind it would be a lie.
      await (db as any)
        .update(t)
        .set({ status: "archived", archivedAt: new Date() })
        .where(and(eq(t.tenantId, tenantId), eq(t.slug, slug)));
    } else {
      // Managed collections — physical `c_<slug>` table goes too; the
      // metadata row is hard-deleted. There's nothing to restore.
      await dropCollection(db, dialect, physicalTable, { adopted });
      // Recreating this slug is a NEW series: a fresh table with no rows in it
      // must not resume numbering where the dropped one left off.
      await dropSequenceCounters(c.get("ctx"), tenantId, slug);
      await (db as any)
        .delete(t)
        .where(and(eq(t.tenantId, tenantId), eq(t.slug, slug)));
      // Permission rows referencing this slug are now ghosts; cached lookups
      // would still say "allowed" for a slug that no longer exists.
      invalidateTenantPermissions(tenantId);
    }
    invalidateTenantCollections(tenantId);
    await logActivity(c, {
      action: adopted ? "archive" : "delete",
      collection: "system_collections",
      itemId: slug,
      payload: { adopted, archived: adopted },
      response: { ok: true },
    });
    return c.json({ ok: true, archived: adopted });
  })
  /**
   * Backfill: embed every existing row in the collection's physical table
   * and upsert into the vector store. Synchronous + paginated (100 rows per
   * batch, one provider call per batch). The collection must have
   * `vectorize: true` and at least one text/longtext field with
   * `vectorize: true`.
   *
   * Returns `{ processed, total, skipped }` — `skipped` counts rows whose
   * vectorize fields are all empty (nothing to embed).
   */
  .post("/:slug/vectorize", ...DDL_GATE, async (c) => {
    const slug = c.req.param("slug");
    const ctx = c.get("ctx");
    const { db, dialect } = ctx;
    const tenantId = requireTenant(c);
    const t = tableFor(dialect);
    const rows = await (db as any)
      .select()
      .from(t)
      .where(and(eq(t.tenantId, tenantId), eq(t.slug, slug)))
      .limit(1);
    if (!rows[0]) throw new AppError("NOT_FOUND", "Collection not found");
    const r = rows[0] as Record<string, unknown>;
    const meta = {
      slug,
      vectorize: Boolean(r.vectorize),
      vectorizeModel:
        ((r.vectorizeModel ?? r.vectorize_model) as string | null | undefined) ??
        null,
      fields: r.fields as FieldDef[],
    };
    if (!meta.vectorize) {
      throw new AppError(
        "VALIDATION",
        `Collection "${slug}" has vectorize disabled. Enable it on the collection first.`,
      );
    }
    if (!isVectorizable(meta, ctx.env)) {
      throw new AppError(
        "VALIDATION",
        "No embedding model resolves for this collection, or no field is marked `vectorize: true`. " +
          "Pick a model (or set EMBEDDING_DEFAULT_MODEL) and flag at least one text/longtext field.",
      );
    }
    const physicalTable = (r.physicalTable ?? r.physical_table) as string;
    const tenantWhere: SQL = sql`${sql.identifier("tenant_id")} = ${tenantId}`;
    const totalRow = await runQuery<{ count: number | string | bigint }>(
      ctx,
      sql`SELECT COUNT(*) AS count FROM ${sql.identifier(physicalTable)} WHERE ${tenantWhere}`,
    );
    const total = Number(totalRow[0]?.count ?? 0);

    let processed = 0;
    let skipped = 0;
    let offset = 0;
    const batchSize = 100;
    while (offset < total) {
      const batch = await runQuery<Record<string, unknown>>(
        ctx,
        sql`SELECT * FROM ${sql.identifier(physicalTable)} WHERE ${tenantWhere} ORDER BY ${sql.identifier("id")} LIMIT ${batchSize} OFFSET ${offset}`,
      );
      if (batch.length === 0) break;
      const upserted = await embedAndUpsertBatch(
        ctx,
        meta,
        tenantId,
        batch.map((row) => ({ id: row.id as string, row })),
      );
      processed += upserted;
      skipped += batch.length - upserted;
      offset += batch.length;
    }
    const vectorizeResponse = { ok: true, processed, skipped, total };
    await logActivity(c, {
      action: "vectorize",
      collection: "system_collections",
      itemId: slug,
      payload: { processed, skipped, total },
      response: vectorizeResponse,
    });
    return c.json(vectorizeResponse);
  })
  /**
   * Backfill: build the full-text index for every existing row in the
   * collection's physical table. Synchronous + paginated (100 rows per
   * batch). The collection must have `fts: true` and at least one
   * text/longtext field flagged `searchable: true`.
   *
   * Returns `{ processed, total, skipped }` — `skipped` counts rows whose
   * searchable fields are all empty (nothing to index).
   */
  .post("/:slug/fts-reindex", ...DDL_GATE, async (c) => {
    const slug = c.req.param("slug");
    const ctx = c.get("ctx");
    const { db, dialect } = ctx;
    const tenantId = requireTenant(c);
    const t = tableFor(dialect);
    const rows = await (db as any)
      .select()
      .from(t)
      .where(and(eq(t.tenantId, tenantId), eq(t.slug, slug)))
      .limit(1);
    if (!rows[0]) throw new AppError("NOT_FOUND", "Collection not found");
    const r = rows[0] as Record<string, unknown>;
    const physicalTable = (r.physicalTable ?? r.physical_table) as string;
    const meta = {
      fts: Boolean(r.fts),
      physicalTable,
      pkColumn: ((r.pkColumn ?? r.pk_column) as string | undefined) ?? "id",
      fields: r.fields as FieldDef[],
      tenantScoped: Boolean(r.tenantScoped ?? r.tenant_scoped ?? true),
    };
    if (!meta.fts) {
      throw new AppError(
        "VALIDATION",
        `Collection "${slug}" has full-text search disabled. Enable it on the collection first.`,
      );
    }
    if (!isSearchable(meta)) {
      throw new AppError(
        "VALIDATION",
        "No field is flagged `searchable: true`. Mark at least one text/longtext field as searchable.",
      );
    }
    const { processed, skipped, total } = await backfillFts(ctx, meta, tenantId);
    const ftsResponse = { ok: true, processed, skipped, total };
    await logActivity(c, {
      action: "fts-reindex",
      collection: "system_collections",
      itemId: slug,
      payload: { processed, skipped, total },
      response: ftsResponse,
    });
    return c.json(ftsResponse);
  });

const runQuery = async <T>(
  ctx: { db: unknown; dialect: "pg" | "sqlite" },
  query: SQL,
): Promise<T[]> => {
  if (ctx.dialect === "pg") {
    const r = await (ctx.db as any).execute(query);
    if (Array.isArray(r)) return r as T[];
    if (r && typeof r === "object" && "rows" in r) return r.rows as T[];
    return r as T[];
  }
  return (await (ctx.db as any).all(query)) as T[];
};
