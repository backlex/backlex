/**
 * Scheduled pulls from a source integration into a collection.
 *
 * The mirror image of `services/integrations.ts`: that one fans events out, this
 * one draws rows in. Both share the connection row, its encrypted config, and
 * the OAuth token machinery.
 *
 * Two decisions shape everything here:
 *
 * **Rows land in ordinary collections.** Writes go through `ingestRows` in
 * upsert mode, the same chokepoint the payments sync uses, so the permission
 * DSL, REST/GraphQL querying, realtime, exports and the BI panels all apply to
 * pulled data for free. Only the sync definition is a system table.
 *
 * **Ids are namespaced.** A pulled row's primary key is
 * `<kind>_<sync-id-prefix>_<external-id>`, so re-pulling updates in place while
 * never colliding with a row a person created, or with a second sync pointed at
 * the same collection. That namespacing is what makes it safe to let an admin
 * aim a sync at a collection that already holds data.
 */
import { and, asc, eq, sql } from "drizzle-orm";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import { AppError } from "@backlex/core";
import {
  SECRET_KEYS,
  DESTINATION_BATCH_SIZE,
  DESTINATION_SETTING_FIELDS,
  destinationColumnsFor,
  SOURCE_CHILD_GROUPS,
  SOURCE_SETTING_FIELDS,
  isIntegrationKind,
  isRateLimited,
  OAUTH_SCOPE_KEY,
  providerFor,
  pullFromSource,
  pushToDestination,
  type FetchLike,
  type IntegrationKind,
  type SourceRecord,
} from "@backlex/integrations";
import type { Ctx } from "../context";
import { decryptSecret, isEncryptedSecret } from "../lib/crypto";
import { loadCollection } from "./items/collection-loader";
import { ingestRows } from "./migrate-ingest";
import { queryAll } from "./items/sql-helpers";
import { ensureAccessToken } from "./integrations-oauth";
import { enqueueJob } from "./jobs";

type AnyDb = any;

const syncsTableFor = (dialect: "pg" | "sqlite") =>
  (dialect === "pg"
    ? pg.schema.integrationSyncs
    : sqlite.schema.integrationSyncs) as typeof pg.schema.integrationSyncs;

const integrationsTableFor = (dialect: "pg" | "sqlite") =>
  (dialect === "pg" ? pg.schema.integrations : sqlite.schema.integrations) as typeof pg.schema.integrations;

/** Consecutive failed runs that pause a sync. Matches the delivery breaker so
 *  the two behave the same for an operator. */
export const SYNC_AUTODISABLE_THRESHOLD = 5;

/** Pages per run. Bounds one invocation; the next run resumes at the cursor. */
const MAX_PAGES = 20;

/** Records per page requested from the provider. */
const PAGE_SIZE = 200;

/** Hard ceiling on rows one run may write, whatever the provider offers. */
const MAX_ROWS_PER_RUN = 2000;

/**
 * Which way rows travel.
 *
 * `inbound` is not a third pipe — it is a sync with nothing to poll. A carrier
 * tells you where a parcel is, but there is no list of parcels to walk, so the
 * row exists to hold the endpoint, the mapping and the collection while the
 * provider does the calling. A `pull` sync may ALSO have an endpoint: that is
 * the normal case for a marketplace, and it is what makes the poll the repair
 * mechanism for the deliveries a webhook inevitably loses.
 */
export type SyncDirection = "pull" | "push" | "inbound";
export const SYNC_DIRECTIONS: readonly SyncDirection[] = ["pull", "push", "inbound"];

/** Directions whose mapping reads `external → collection field`. */
const writesRows = (d: SyncDirection): boolean => d === "pull" || d === "inbound";

/**
 * Where one group of a source record's children lands.
 *
 * `parentField` is the relation column on the CHILD collection pointing back at
 * the header — the engine fills it from the parent's own namespaced id, so it
 * is never taken from provider data.
 */
export interface ChildMappingSpec {
  collection: string;
  parentField: string;
  mapping: Record<string, string>;
}

export interface SyncRow {
  id: string;
  integrationId: string;
  tenantId: string;
  collection: string;
  direction: string;
  settings: Record<string, unknown>;
  mapping: Record<string, string>;
  childMappings: Record<string, ChildMappingSpec>;
  intervalMinutes: number;
  enabled: boolean;
  cursor: string | null;
  lastRunAt: Date | number | null;
  lastRowCount: number;
  lastError: string | null;
  consecutiveFailures: number;
  disabledReason: string | null;
  /** Endpoint state. Null token = this sync receives nothing. */
  webhookToken: string | null;
  webhookSecret: string | null;
  webhookEvents: string[];
  webhookExternalId: string | null;
  /** The collection field a `patch` delivery is matched on. */
  matchField: string | null;
  createdAt: Date | number | null;
  updatedAt: Date | number | null;
}

/** Public view. Settings are non-secret by contract, so they pass through. */
export const toPublicSync = (row: SyncRow) => ({
  id: row.id,
  integrationId: row.integrationId,
  collection: row.collection,
  direction: row.direction,
  settings: row.settings ?? {},
  mapping: row.mapping ?? {},
  childMappings: row.childMappings ?? {},
  intervalMinutes: row.intervalMinutes,
  enabled: row.enabled,
  /** Whether a run is in progress from a cursor, not the token itself — the
   *  provider's resume token is an internal detail with no meaning to a UI. */
  resuming: Boolean(row.cursor),
  lastRunAt: row.lastRunAt,
  lastRowCount: row.lastRowCount,
  lastError: row.lastError,
  consecutiveFailures: row.consecutiveFailures,
  disabledReason: row.disabledReason,
  matchField: row.matchField ?? null,
  /**
   * The endpoint, described — never the secret.
   *
   * The secret is returned exactly once, by the call that minted it. A field
   * that keeps handing it back on every read would end up in a browser cache, a
   * screenshot and an activity log, which for a bearer token that a third party
   * also holds is three copies too many. An operator who lost it rotates.
   *
   * `path` rather than a URL: this row does not know the public origin, and
   * building one out of a request header would be a URL an operator could
   * influence. The route layer joins it to `APP_URL`.
   */
  webhook: row.webhookToken
    ? {
        path: webhookPathFor(row.webhookToken),
        events: row.webhookEvents ?? [],
        /** True when the provider was told about this endpoint by us. */
        registered: Boolean(row.webhookExternalId),
      }
    : null,
  createdAt: row.createdAt,
});

/** The public path a provider posts to. One definition, three consumers. */
export const webhookPathFor = (token: string): string => `/api/integrations/hooks/${token}`;

export type PublicSync = ReturnType<typeof toPublicSync>;

// ── Admin CRUD ───────────────────────────────────────────────────────────────

const loadOwnedIntegration = async (ctx: Ctx, tenantId: string, integrationId: string) => {
  const t = integrationsTableFor(ctx.dialect);
  const [row] = (await (ctx.db as AnyDb)
    .select()
    .from(t)
    .where(and(eq(t.tenantId, tenantId), eq(t.id, integrationId)))) as {
    id: string;
    kind: string;
    tenantId: string | null;
    config: Record<string, unknown>;
    updatedAt: Date | number | null;
  }[];
  if (!row) throw new AppError("NOT_FOUND", "Integration not found");
  return row;
};

/** Reject anything the provider did not ask for, and require what it did.
 *  Settings reach `pull` and end up in URLs, so an unknown key is refused
 *  rather than passed along on the chance a provider might read it. */
const validateSettings = (
  kind: string,
  settings: Record<string, unknown>,
  direction: SyncDirection,
): Record<string, unknown> => {
  if (direction === "inbound") {
    // Nothing to configure: the provider decides what it sends and the endpoint
    // decides nothing. Source settings would demand a lookback window on a sync
    // that never reads a window, so an unrecognised key here is refused rather
    // than validated against a list that does not apply.
    for (const key of Object.keys(settings)) {
      throw new AppError("VALIDATION", `An inbound sync takes no settings — remove "${key}"`);
    }
    return {};
  }
  const fields =
    (direction === "push" ? DESTINATION_SETTING_FIELDS[kind] : SOURCE_SETTING_FIELDS[kind]) ?? [];
  const allowed = new Set(fields.map((f) => f.key));
  for (const key of Object.keys(settings)) {
    if (!allowed.has(key)) throw new AppError("VALIDATION", `${kind} has no setting "${key}"`);
  }
  for (const f of fields) {
    const v = settings[f.key];
    if (v !== undefined && typeof v !== "string") {
      throw new AppError("VALIDATION", `Setting "${f.key}" must be a string`);
    }
    // "(optional)" in the label is the same convention the connect dialog uses.
    if (!f.label.toLowerCase().includes("optional") && !(typeof v === "string" && v.trim())) {
      throw new AppError("VALIDATION", `Setting "${f.key}" is required for ${kind}`);
    }
    // A field with `options` is a closed set. Providers build query strings and
    // URL paths out of these, and each one re-checks its own value, but the
    // list is declared here so a bad value is refused at the form rather than
    // surfacing as a provider error on the first run.
    if (f.options && typeof v === "string" && v.trim()) {
      const allowedValues = f.options.map((o) => o.value);
      if (!allowedValues.includes(v.trim())) {
        throw new AppError(
          "VALIDATION",
          `Setting "${f.key}" must be one of: ${allowedValues.join(", ")}`,
        );
      }
    }
  }
  return Object.fromEntries(
    Object.entries(settings).map(([k, v]) => [k, typeof v === "string" ? v.trim() : v]),
  );
};

/**
 * Refuse a sync whose connection was authorized before this direction existed.
 *
 * The recorded scope comes from the token exchange, so it is what the provider
 * actually GRANTED rather than what was asked for. Silence is not denial: a
 * provider that returns no scope list leaves the field empty, and refusing on
 * that would block connections that can do the work perfectly well. The far
 * end's 403 remains the backstop for anything this cannot see.
 */
const assertScope = (
  integration: { kind: string; config: Record<string, unknown> },
  required: string | readonly string[] | undefined,
): void => {
  // A list means every one is needed: Xero grants write per record type, and a
  // connection reauthorized for this direction receives them together.
  const needed = typeof required === "string" ? [required] : (required ?? []);
  if (needed.length === 0) return;
  const granted = integration.config?.[OAUTH_SCOPE_KEY];
  if (typeof granted !== "string" || !granted.trim()) return;
  const held = new Set(granted.split(/\s+/));
  if (needed.every((s) => held.has(s))) return;
  throw new AppError(
    "BAD_REQUEST",
    `This ${integration.kind} connection was authorized for reading only. Reconnect it to grant write access, then create the sync.`,
  );
};

export interface CreateSyncInput {
  integrationId: string;
  collection: string;
  /** Defaults to `pull`; a destination-only provider must be `push`. */
  direction?: SyncDirection;
  settings?: Record<string, unknown>;
  mapping?: Record<string, string>;
  /** Pull only. Where the record's child rows land — see {@link ChildMappingSpec}. */
  childMappings?: Record<string, ChildMappingSpec>;
  intervalMinutes?: number;
  enabled?: boolean;
  /**
   * The collection field a `patch` delivery is matched on. Required for a
   * provider whose webhook patches rather than upserts, refused for one that
   * upserts — where a record is addressed by its namespaced id and a match field
   * would be an invitation to write to the wrong row.
   */
  matchField?: string | null;
}

/** Create a sync. `tenantId` is `string`, never nullable: an instance-wide sync
 *  would write rows into whichever workspace ran it. */
export async function createSync(ctx: Ctx, tenantId: string, input: CreateSyncInput): Promise<PublicSync> {
  const integration = await loadOwnedIntegration(ctx, tenantId, input.integrationId);
  const direction: SyncDirection = input.direction ?? "pull";
  if (!SYNC_DIRECTIONS.includes(direction)) {
    throw new AppError("VALIDATION", `direction must be one of: ${SYNC_DIRECTIONS.join(", ")}`);
  }
  const provider = isIntegrationKind(integration.kind) ? providerFor(integration.kind) : undefined;
  if (direction === "pull" && !provider?.source) {
    throw new AppError("BAD_REQUEST", `${integration.kind} cannot be used as a source`);
  }
  if (direction === "push" && !provider?.destination) {
    throw new AppError("BAD_REQUEST", `${integration.kind} cannot be used as a destination`);
  }
  if (direction === "inbound" && !provider?.webhook) {
    throw new AppError("BAD_REQUEST", `${integration.kind} does not send webhooks`);
  }
  if (direction === "push") assertScope(integration, provider?.destination?.requiredScope);
  // Resolves within the caller's tenant and throws if the slug is unknown, so a
  // sync can never be aimed at another workspace's collection.
  const collection = await loadCollection(ctx, tenantId, input.collection);
  if (collection.adopted) {
    throw new AppError(
      "VALIDATION",
      `Collection "${input.collection}" is adopted — a sync only writes to managed collections`,
    );
  }
  const settings = validateSettings(integration.kind, input.settings ?? {}, direction);
  const mapping = validateMapping(input.mapping ?? {}, collection, direction, integration.kind, settings);
  const childMappings = await validateChildMappings(ctx, tenantId, direction, integration.kind, input.childMappings ?? {});
  const matchField = validateMatchField(input.matchField, collection, direction, integration.kind);

  const id = crypto.randomUUID();
  const now = new Date();
  await (ctx.db as AnyDb).insert(syncsTableFor(ctx.dialect)).values({
    id,
    integrationId: integration.id,
    tenantId,
    collection: input.collection,
    direction,
    settings,
    mapping,
    childMappings,
    // An inbound sync is never due, so an interval on it would be a schedule
    // that reads as active and does nothing. The scheduler already skips 0.
    intervalMinutes: direction === "inbound" ? 0 : clampInterval(input.intervalMinutes),
    enabled: input.enabled ?? true,
    matchField,
    createdAt: now,
    updatedAt: now,
  });
  const row = await getSync(ctx, tenantId, id);
  if (!row) throw new Error("sync row missing after insert");
  return row;
}

/**
 * Check every child group against the collection it claims to write into.
 *
 * The same argument as {@link validateMapping}, one level down: an unknown
 * target field is dropped by `ingestRows` and the run reports a clean import
 * having lost a column off every order line.
 *
 * Two things here are load-bearing beyond that:
 *
 *   - **Each child collection is resolved through `loadCollection` with the
 *     caller's tenant**, so a sync cannot be pointed at another workspace's
 *     table by naming its slug. This is the same guard the parent collection
 *     gets, and it has to be repeated because a child names its own collection.
 *   - **`parentField` must be a writable field**, because the engine fills it
 *     from the parent's namespaced id. A group naming a computed column would
 *     silently lose the link and leave orphan lines.
 */
const validateChildMappings = async (
  ctx: Ctx,
  tenantId: string,
  direction: SyncDirection,
  kind: string,
  childMappings: Record<string, ChildMappingSpec>,
): Promise<Record<string, ChildMappingSpec>> => {
  const entries = Object.entries(childMappings);
  if (entries.length === 0) return {};
  if (!writesRows(direction)) {
    // A push walks one collection's watermark. There is no second collection in
    // that direction, so accepting the field would store something inert.
    throw new AppError("VALIDATION", "childMappings apply to a sync that writes rows in");
  }
  // Checked against what the provider says it returns, for the providers that
  // say. A group nothing hands back is not refused at run time — it simply
  // matches nothing — so the sync would import orders without their lines and
  // report a clean run doing it. A provider that declares no groups is left
  // alone rather than assumed to have none: the check is here to catch a typo,
  // not to stop a source that predates the declaration.
  const declared = SOURCE_CHILD_GROUPS[kind];
  if (declared) {
    const known = new Set(declared.map((g) => g.key));
    for (const [group] of entries) {
      if (!known.has(group)) {
        throw new AppError(
          "VALIDATION",
          `${kind} returns no child group "${group}" — it has: ${declared.map((g) => g.key).join(", ")}`,
        );
      }
    }
  }

  const out: Record<string, ChildMappingSpec> = {};
  for (const [group, spec] of entries) {
    if (!spec || typeof spec !== "object") {
      throw new AppError("VALIDATION", `Child group "${group}" must be an object`);
    }
    if (typeof spec.collection !== "string" || !spec.collection.trim()) {
      throw new AppError("VALIDATION", `Child group "${group}" must name a collection`);
    }
    const collection = await loadCollection(ctx, tenantId, spec.collection.trim());
    if (collection.adopted) {
      throw new AppError(
        "VALIDATION",
        `Collection "${collection.slug}" is adopted — a sync only writes to managed collections`,
      );
    }
    const writable = new Set(collection.fields.filter((f) => !f.computed).map((f) => f.name));

    const parentField = typeof spec.parentField === "string" ? spec.parentField.trim() : "";
    if (!parentField || !writable.has(parentField)) {
      throw new AppError(
        "VALIDATION",
        `Child group "${group}" needs a writable parentField on "${collection.slug}"`,
      );
    }

    const mapping: Record<string, string> = {};
    for (const [external, target] of Object.entries(spec.mapping ?? {})) {
      if (typeof target !== "string" || !target.trim()) {
        throw new AppError("VALIDATION", `Child mapping for "${external}" must name a column`);
      }
      const field = target.trim();
      if (!writable.has(field)) {
        throw new AppError(
          "VALIDATION",
          `Collection "${collection.slug}" has no writable field "${field}"`,
        );
      }
      mapping[external] = field;
    }
    if (Object.keys(mapping).length === 0) {
      throw new AppError("VALIDATION", `Child group "${group}" needs at least one field mapping`);
    }

    out[group] = { collection: collection.slug, parentField, mapping };
  }
  return out;
};

/**
 * Which column a pushed delivery is matched on, checked against both halves.
 *
 * The provider decides WHETHER there is one: a webhook that patches is about a
 * row somebody else created, and one that upserts addresses its own row by the
 * namespaced id. Offering the field in the wrong case is not cosmetic — a match
 * field on an upserting sync would sit there implying a lookup that never
 * happens, and its absence on a patching one leaves the engine with a value and
 * no column to find it in.
 *
 * The column itself must be writable, which is a proxy for "stored". A computed
 * column is derived from the row on the way out, so matching on it would compare
 * a delivery's id against an expression — sometimes legal SQL, never the lookup
 * the operator meant.
 */
const validateMatchField = (
  raw: string | null | undefined,
  collection: Awaited<ReturnType<typeof loadCollection>>,
  direction: SyncDirection,
  kind: string,
): string | null => {
  const wants = providerFor(kind)?.webhook?.landing === "patch";
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) {
    // Only demanded where the endpoint is the whole point of the row. A pull
    // sync for a patching provider is a contradiction the provider check above
    // has already refused, so this cannot silently accept one.
    if (wants && direction === "inbound") {
      throw new AppError(
        "VALIDATION",
        `${kind} sends updates about existing rows — name the field they are matched on`,
      );
    }
    return null;
  }
  if (!wants) {
    throw new AppError(
      "VALIDATION",
      `${kind} deliveries carry whole records, so there is nothing to match on — remove matchField`,
    );
  }
  const writable = new Set(collection.fields.filter((f) => !f.computed).map((f) => f.name));
  if (!writable.has(value)) {
    throw new AppError("VALIDATION", `Collection "${collection.slug}" has no stored field "${value}"`);
  }
  return value;
};

const clampInterval = (v: number | undefined): number => {
  if (v === undefined) return 60;
  if (!Number.isFinite(v) || v < 0 || v > 10_080) {
    // Refused rather than clamped: a caller who asked for 5 minutes and got 60
    // would build a schedule on a number nobody agreed to.
    throw new AppError("VALIDATION", "intervalMinutes must be 0 (manual) to 10080 (weekly)");
  }
  return Math.floor(v);
};

/** Every mapping target must be a real, writable field on the collection. An
 *  unknown target would be dropped by `ingestRows` and the sync would report a
 *  clean run while quietly losing a column. */
const validateMapping = (
  mapping: Record<string, string>,
  collection: Awaited<ReturnType<typeof loadCollection>>,
  direction: SyncDirection,
  kind: string,
  settings: Record<string, unknown>,
): Record<string, string> => {
  const out: Record<string, string> = {};
  // A destination with a closed column set (a calendar event has a `summary`
  // and a `start`, not arbitrary columns) is checked here. A warehouse declares
  // none — its columns are whatever the operator's DDL says — and stays free
  // text. Without this a typo'd target is accepted, dropped by the provider,
  // and the run reports a clean success having written nothing.
  //
  // Narrowed by the settings, because a provider's columns are not always fixed
  // for the whole provider: QuickBooks writes a customer OR an invoice, and
  // `dueDate` on a customer is the same silent drop this check exists to stop.
  const columns = direction === "push" ? destinationColumnsFor(kind, settings) : undefined;
  // An inbound mapping reads the same way a pull's does — `external → field` —
  // because it lands through the same ingest with the same targets. What differs
  // is only who initiates, which the mapping has no opinion about.
  // The mapping is read in the direction of travel. On a pull the collection
  // field is the TARGET and must be writable; on a push it is the SOURCE and
  // may be any field the collection has, computed ones included — reading one
  // out is fine, writing to it is not.
  const known = new Set(collection.fields.map((f) => f.name));
  const writable = new Set(collection.fields.filter((f) => !f.computed).map((f) => f.name));
  for (const [left, right] of Object.entries(mapping)) {
    if (typeof right !== "string" || !right.trim()) {
      throw new AppError("VALIDATION", `Mapping for "${left}" must name a column`);
    }
    const value = right.trim();
    if (writesRows(direction) && !writable.has(value)) {
      throw new AppError(
        "VALIDATION",
        `Collection "${collection.slug}" has no writable field "${value}"`,
      );
    }
    if (direction === "push" && !known.has(left)) {
      throw new AppError("VALIDATION", `Collection "${collection.slug}" has no field "${left}"`);
    }
    if (columns && !columns.some((c) => c.value === value)) {
      throw new AppError(
        "VALIDATION",
        `${kind} has no destination column "${value}" — one of: ${columns.map((c) => c.value).join(", ")}`,
      );
    }
    out[left] = value;
  }
  if (Object.keys(out).length === 0) {
    // Without this the sync would insert rows that are nothing but ids.
    throw new AppError("VALIDATION", "A sync needs at least one field mapping");
  }
  return out;
};

export async function listSyncs(ctx: Ctx, tenantId: string, integrationId?: string): Promise<PublicSync[]> {
  const t = syncsTableFor(ctx.dialect);
  const where = integrationId
    ? and(eq(t.tenantId, tenantId), eq(t.integrationId, integrationId))
    : eq(t.tenantId, tenantId);
  const rows = (await (ctx.db as AnyDb).select().from(t).where(where).orderBy(asc(t.createdAt))) as SyncRow[];
  return rows.map(toPublicSync);
}

export async function getSync(ctx: Ctx, tenantId: string, id: string): Promise<PublicSync | null> {
  const row = await getSyncRow(ctx, tenantId, id);
  return row ? toPublicSync(row) : null;
}

export const getSyncRow = async (ctx: Ctx, tenantId: string, id: string): Promise<SyncRow | null> => {
  const t = syncsTableFor(ctx.dialect);
  const [row] = (await (ctx.db as AnyDb)
    .select()
    .from(t)
    .where(and(eq(t.tenantId, tenantId), eq(t.id, id)))) as SyncRow[];
  return row ?? null;
};

export interface UpdateSyncInput {
  settings?: Record<string, unknown>;
  mapping?: Record<string, string>;
  childMappings?: Record<string, ChildMappingSpec>;
  intervalMinutes?: number;
  enabled?: boolean;
  matchField?: string | null;
}

export async function updateSync(
  ctx: Ctx,
  tenantId: string,
  id: string,
  patch: UpdateSyncInput,
): Promise<PublicSync> {
  const existing = await getSyncRow(ctx, tenantId, id);
  if (!existing) throw new AppError("NOT_FOUND", "Sync not found");
  const integration = await loadOwnedIntegration(ctx, tenantId, existing.integrationId);

  const direction = (existing.direction ?? "pull") as SyncDirection;
  const set: Record<string, unknown> = { updatedAt: new Date() };
  let settings = (existing.settings ?? {}) as Record<string, unknown>;
  if (patch.settings !== undefined) {
    settings = validateSettings(integration.kind, patch.settings, direction);
    set.settings = settings;
    // The cursor is only meaningful for the source it came from; pointing the
    // sync at a different sheet while keeping a row offset would read garbage.
    set.cursor = null;
  }
  // The mapping is re-checked whenever EITHER half changes, because a push's
  // legal columns depend on the settings: switching a QuickBooks sync from
  // customers to invoices leaves a mapping that names columns an invoice does
  // not have, and nothing else would notice until the provider dropped them.
  if (patch.mapping !== undefined || patch.settings !== undefined) {
    set.mapping = validateMapping(
      patch.mapping ?? ((existing.mapping ?? {}) as Record<string, string>),
      await loadCollection(ctx, tenantId, existing.collection),
      direction,
      integration.kind,
      settings,
    );
  }
  // Re-validated on its own trigger rather than alongside the parent mapping: a
  // child group names its own collection, so nothing about the parent's
  // settings can invalidate it, and re-checking it on every settings edit would
  // re-read those collections for no reason.
  if (patch.childMappings !== undefined) {
    set.childMappings = await validateChildMappings(ctx, tenantId, direction, integration.kind, patch.childMappings);
  }
  if (patch.matchField !== undefined) {
    set.matchField = validateMatchField(
      patch.matchField,
      await loadCollection(ctx, tenantId, existing.collection),
      direction,
      integration.kind,
    );
  }
  if (patch.intervalMinutes !== undefined) {
    if (direction === "inbound") {
      // Refused rather than ignored. A caller who set an interval and was told
      // nothing would believe this row polls, and would go looking for the runs
      // it never made.
      throw new AppError("VALIDATION", "An inbound sync has nothing to poll — it has no interval");
    }
    set.intervalMinutes = clampInterval(patch.intervalMinutes);
  }
  if (patch.enabled !== undefined) {
    set.enabled = patch.enabled;
    if (patch.enabled) {
      // Re-enabling clears the breaker; otherwise a paused sync trips again on
      // its very next run and the admin cannot tell whether the fix worked.
      set.consecutiveFailures = 0;
      set.disabledReason = null;
      set.lastError = null;
    }
  }

  await (ctx.db as AnyDb)
    .update(syncsTableFor(ctx.dialect))
    .set(set)
    .where(and(eq(syncsTableFor(ctx.dialect).tenantId, tenantId), eq(syncsTableFor(ctx.dialect).id, id)));
  const row = await getSync(ctx, tenantId, id);
  if (!row) throw new Error("sync row missing after update");
  return row;
}

export async function deleteSync(ctx: Ctx, tenantId: string, id: string): Promise<void> {
  const t = syncsTableFor(ctx.dialect);
  await (ctx.db as AnyDb).delete(t).where(and(eq(t.tenantId, tenantId), eq(t.id, id)));
}

// ── The pull itself ──────────────────────────────────────────────────────────

export interface SyncRunResult {
  written: number;
  pages: number;
  /** True when the provider ran out of records, so the next run starts over. */
  complete: boolean;
}

/**
 * Decrypt this kind's secret config fields.
 *
 * Exported because the task service and the webhook receiver need exactly this
 * and nothing else. It was copied into each of them once, which is how three
 * copies of a decrypt helper come to disagree about which keys are secret.
 */
export const decryptConfig = async (kind: string, config: Record<string, unknown>, secret: string) => {
  const keys = new Set(SECRET_KEYS[kind as IntegrationKind] ?? []);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) {
    out[k] = keys.has(k) && typeof v === "string" && isEncryptedSecret(v) ? ((await decryptSecret(v, secret)) ?? "") : v;
  }
  return out;
};

/**
 * The primary key a pulled row gets.
 *
 * Namespaced by provider AND by sync, because two syncs can legitimately point
 * at the same collection — one Airtable table of customers and one sheet of
 * them — and their external ids are independent numbering schemes that would
 * otherwise collide and silently overwrite each other.
 */
const rowIdFor = (kind: string, syncId: string, externalId: string): string =>
  `${kind}_${syncId.slice(0, 8)}_${externalId}`;

/** Apply the mapping and attach the namespaced id. */
const toRow = (
  kind: string,
  syncId: string,
  mapping: Record<string, string>,
  record: { externalId: string; data: Record<string, unknown> },
): Record<string, unknown> => {
  const row: Record<string, unknown> = { id: rowIdFor(kind, syncId, record.externalId) };
  for (const [external, target] of Object.entries(mapping)) {
    if (record.data[external] !== undefined) row[target] = record.data[external];
  }
  return row;
};

/**
 * The primary key a CHILD row gets.
 *
 * Qualified by the parent's external id, because a child's id is only unique
 * within its parent: a provider that numbers an order's lines from 1 would
 * otherwise have every order's first line collide on one primary key, and each
 * pulled order would overwrite the previous one's lines.
 *
 * The separator is not escaped, so a provider whose ids contain `:` could in
 * principle fold two pairs onto one key. That is the same ambiguity `rowIdFor`
 * already carries between its own segments, and escaping here alone would
 * change every existing child key without closing the class — left as it is
 * deliberately rather than half-fixed.
 */
const childIdFor = (kind: string, syncId: string, parentExternalId: string, childExternalId: string): string =>
  rowIdFor(kind, syncId, `${parentExternalId}:${childExternalId}`);

/**
 * Write one batch of external records into this sync's collection, children and
 * all.
 *
 * The one place records become rows, shared by the scheduled pull and by an
 * inbound webhook. That sharing is the point: both land through the same
 * mapping, the same `rowIdFor` namespace and the same upsert, so a delivery
 * about an order the poll already imported updates that row instead of minting a
 * second one beside it. Two implementations could not promise that.
 *
 * Throws on a rejected row rather than counting it: for a pull, reporting
 * success would advance the cursor past data nobody stored, and for a delivery it
 * would answer 200 to a provider that will never send it again.
 */
export async function ingestSourceRecords(
  ctx: Ctx,
  tenantId: string,
  row: SyncRow,
  kind: string,
  records: readonly SourceRecord[],
  collection: Awaited<ReturnType<typeof loadCollection>>,
  childCollections: Map<string, ChildTarget>,
): Promise<number> {
  if (records.length === 0) return 0;
  const rows = records.map((r) => toRow(kind, row.id, row.mapping ?? {}, r));
  const out = await ingestRows(ctx, collection, tenantId, rows, { mode: "upsert" });
  if (out.failed.length > 0) {
    throw new AppError(
      "VALIDATION",
      `${out.failed.length} row(s) rejected by "${row.collection}": ${out.failed[0]?.error ?? "unknown"}`,
    );
  }
  // Children go in AFTER their parents so a line never references an order that
  // is not there yet.
  return out.inserted + out.updated + (await ingestChildren(ctx, tenantId, row, kind, records, childCollections));
}

/** One child group, resolved: the mapping plus the collection it writes into. */
export interface ChildTarget {
  parentField: string;
  mapping: Record<string, string>;
  collection: Awaited<ReturnType<typeof loadCollection>>;
}

/**
 * Resolve every child group this sync declares into a loaded collection.
 *
 * Done once per run. A group naming a collection that has since been dropped
 * fails the run rather than being skipped: silently importing orders without
 * their lines is the failure this whole feature exists to prevent, and it would
 * report a clean run while doing it.
 */
export const loadChildCollections = async (
  ctx: Ctx,
  tenantId: string,
  row: SyncRow,
): Promise<Map<string, ChildTarget>> => {
  const out = new Map<string, ChildTarget>();
  for (const [group, spec] of Object.entries(row.childMappings ?? {})) {
    out.set(group, {
      parentField: spec.parentField,
      mapping: spec.mapping ?? {},
      collection: await loadCollection(ctx, tenantId, spec.collection),
    });
  }
  return out;
};

/**
 * Write the child rows of one page's records.
 *
 * Returns how many landed, so a run's row count reflects everything it wrote
 * rather than only the headers.
 *
 * A group the sync has no mapping for is ignored — a provider may hand back
 * more groups than an operator chose to keep, and refusing those would make
 * adding a group to a provider a breaking change for every existing sync.
 */
const ingestChildren = async (
  ctx: Ctx,
  tenantId: string,
  row: SyncRow,
  kind: string,
  records: readonly { externalId: string; children?: Record<string, { externalId: string; data: Record<string, unknown> }[]> }[],
  targets: Map<string, ChildTarget>,
): Promise<number> => {
  if (targets.size === 0) return 0;
  let written = 0;

  for (const [group, target] of targets) {
    const rows: Record<string, unknown>[] = [];
    for (const parent of records) {
      for (const child of parent.children?.[group] ?? []) {
        const mapped: Record<string, unknown> = {
          id: childIdFor(kind, row.id, parent.externalId, child.externalId),
          // The link back to the header. Always written from the parent's own
          // namespaced id rather than from the payload, so a provider cannot
          // point a line at a row in another workspace's collection.
          [target.parentField]: rowIdFor(kind, row.id, parent.externalId),
        };
        for (const [external, field] of Object.entries(target.mapping)) {
          if (child.data[external] !== undefined) mapped[field] = child.data[external];
        }
        rows.push(mapped);
      }
    }
    if (rows.length === 0) continue;

    const out = await ingestRows(ctx, target.collection, tenantId, rows, { mode: "upsert" });
    if (out.failed.length > 0) {
      throw new AppError(
        "VALIDATION",
        `${out.failed.length} "${group}" row(s) rejected by "${target.collection.slug}": ${out.failed[0]?.error ?? "unknown"}`,
      );
    }
    written += out.inserted + out.updated;
  }
  return written;
};

/**
 * Fold one run's outcome into the breaker, mirroring the delivery path.
 *
 * `rateLimited` is the one failure that does NOT advance the counter. The
 * breaker exists to pause a sync pointed at something broken — a deleted
 * spreadsheet, a revoked grant — and a provider answering "too fast" is neither.
 * A marketplace with a per-second quota would otherwise pause a healthy
 * connection after five busy runs, and the operator's only clue would be a
 * paused row blaming an HTTP status that means the opposite of broken. The
 * cursor is held either way, so the rows are re-read rather than skipped.
 */
const applyRunOutcome = async (
  ctx: Ctx,
  row: SyncRow,
  outcome:
    | { ok: true; written: number; cursor: string | null }
    | { ok: false; error: string; rateLimited?: boolean },
): Promise<void> => {
  const t = syncsTableFor(ctx.dialect);
  const now = new Date();
  if (outcome.ok) {
    await (ctx.db as AnyDb)
      .update(t)
      .set({
        cursor: outcome.cursor,
        lastRunAt: now,
        lastRowCount: outcome.written,
        lastError: null,
        consecutiveFailures: 0,
        disabledReason: null,
        updatedAt: now,
      })
      .where(eq(t.id, row.id));
    return;
  }
  const held = outcome.rateLimited === true;
  const next = held ? (row.consecutiveFailures ?? 0) : (row.consecutiveFailures ?? 0) + 1;
  const paused = !held && next >= SYNC_AUTODISABLE_THRESHOLD;
  await (ctx.db as AnyDb)
    .update(t)
    .set({
      // The cursor is deliberately left alone: a failed page must be re-read,
      // not skipped, or the rows in it are lost with no trace.
      lastRunAt: now,
      lastError: outcome.error.slice(0, 500),
      consecutiveFailures: next,
      ...(paused
        ? {
            enabled: false,
            disabledReason: `Auto-paused after ${next} consecutive failed runs (last: ${outcome.error.slice(0, 200)})`,
          }
        : {}),
      updatedAt: now,
    })
    .where(eq(t.id, row.id));
};

/**
 * Run one sync to completion or to its page budget, whichever comes first.
 *
 * Throws on failure so the queue retries with backoff — but only after the
 * breaker has been updated, so a sync pointed at a deleted spreadsheet pauses
 * itself instead of retrying forever.
 */
export async function runSync(
  ctx: Ctx,
  tenantId: string,
  syncId: string,
  fetchImpl?: FetchLike,
): Promise<SyncRunResult> {
  const row = await getSyncRow(ctx, tenantId, syncId);
  if (!row) throw new AppError("NOT_FOUND", "Sync not found");
  const integration = await loadOwnedIntegration(ctx, tenantId, row.integrationId);
  const provider = providerFor(integration.kind);
  const direction = (row.direction ?? "pull") as SyncDirection;
  if (direction === "inbound") {
    // Nothing to run. Said plainly here rather than left to fall through to the
    // pull path, which would report that the provider "cannot be used as a
    // source" — true, and completely beside the point for a row whose whole
    // design is that the provider calls us.
    throw new AppError(
      "BAD_REQUEST",
      "This sync receives webhook deliveries — there is nothing to run on a schedule",
    );
  }
  if (direction === "pull" && !provider?.source) {
    throw new AppError("BAD_REQUEST", `${integration.kind} cannot be used as a source`);
  }
  if (direction === "push" && !provider?.destination) {
    throw new AppError("BAD_REQUEST", `${integration.kind} cannot be used as a destination`);
  }

  let config = await decryptConfig(
    integration.kind,
    (integration.config ?? {}) as Record<string, unknown>,
    ctx.env.AUTH_SECRET,
  );
  if (provider?.oauth) {
    const token = await ensureAccessToken(ctx, integration, ctx.env.AUTH_SECRET);
    if (!token) {
      const error = "OAuth connection needs re-authorizing";
      await applyRunOutcome(ctx, row, { ok: false, error });
      throw new AppError("UNAUTHORIZED", error);
    }
    config = { ...config, _oauthAccessToken: token };
  }

  if (direction === "push") {
    try {
      return await pushCollection(ctx, tenantId, row, integration, config, fetchImpl);
    } catch (e) {
      await applyRunOutcome(ctx, row, {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        rateLimited: isRateLimited(e),
      });
      throw e;
    }
  }

  const collection = await loadCollection(ctx, tenantId, row.collection);
  // Loaded once for the whole run rather than per page: a 20-page order import
  // would otherwise re-read the same two collection definitions 20 times.
  const childCollections = await loadChildCollections(ctx, tenantId, row);
  let cursor = row.cursor;
  let resumeToken: string | null = null;
  let written = 0;
  let pages = 0;
  let complete = false;
  try {
    for (; pages < MAX_PAGES && written < MAX_ROWS_PER_RUN; pages++) {
      const page = await pullFromSource(
        integration.kind,
        {
          config,
          settings: row.settings ?? {},
          cursor,
          limit: PAGE_SIZE,
          connectionKey: integration.id,
        },
        fetchImpl,
      );
      // A rejected row throws out of here, which is what holds the cursor: it
      // must not advance past an order — or an order's lines — nobody stored.
      written += await ingestSourceRecords(
        ctx,
        tenantId,
        row,
        integration.kind,
        page.records,
        collection,
        childCollections,
      );
      cursor = page.cursor;
      if (cursor === null) {
        complete = true;
        // A provider with a real incremental marker says where to pick up next
        // time. Without one the next run reads from the top again, which is how
        // a page-walk source notices edits at all.
        resumeToken = page.resumeToken ?? null;
        break;
      }
    }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await applyRunOutcome(ctx, row, { ok: false, error, rateLimited: isRateLimited(e) });
    throw e;
  }

  await applyRunOutcome(ctx, row, {
    ok: true,
    written,
    cursor: complete ? resumeToken : cursor,
  });
  return { written, pages, complete };
}

// ── Scheduling ───────────────────────────────────────────────────────────────

/**
 * Enqueue every enabled sync that is due, across all workspaces.
 *
 * Called from the cron tick, so it is the one place here that is deliberately
 * NOT tenant-scoped — it reads every workspace's rows in order to enqueue a job
 * per row, and each job carries its own `tenantId` which `runSync` then scopes
 * every subsequent query by.
 */
export async function enqueueDueSyncs(ctx: Ctx): Promise<number> {
  const t = syncsTableFor(ctx.dialect);
  const rows = (await (ctx.db as AnyDb)
    .select()
    .from(t)
    .where(and(eq(t.enabled, true), sql`${t.intervalMinutes} > 0`))) as SyncRow[];

  const now = Date.now();
  const due = rows.filter((row) => {
    const last = row.lastRunAt instanceof Date ? row.lastRunAt.getTime() : Number(row.lastRunAt ?? 0);
    // A run left mid-cursor is due immediately — it has more pages waiting and
    // making it sit out a whole interval would stall a large import.
    if (row.cursor) return true;
    return !last || now - last >= row.intervalMinutes * 60_000;
  });

  await Promise.all(
    due.map((row) =>
      enqueueJob(ctx, {
        type: "integration.sync",
        queue: "integrations",
        tenantId: row.tenantId,
        payload: { syncId: row.id },
      }),
    ),
  );
  return due.length;
}

// ── Push: a collection out to a warehouse ────────────────────────────────────

/**
 * The watermark a push resumes from.
 *
 * Compound on purpose. A plain `updated_at > last` SKIPS every row that shares
 * the last row's timestamp, and `>=` re-sends the same row forever. Pairing the
 * timestamp with the primary key gives a total order with neither failure.
 */
interface Watermark {
  updatedAt: number;
  id: string;
}

const parseWatermark = (cursor: string | null): Watermark | null => {
  if (!cursor) return null;
  const at = cursor.lastIndexOf("|");
  if (at <= 0) return null;
  const updatedAt = Number(cursor.slice(0, at));
  const id = cursor.slice(at + 1);
  return Number.isFinite(updatedAt) && id ? { updatedAt, id } : null;
};

const formatWatermark = (w: Watermark): string => `${w.updatedAt}|${w.id}`;

/** Timestamps arrive as epoch ms on SQLite and as a Date on PG. */
const toMs = (v: unknown): number =>
  v instanceof Date ? v.getTime() : typeof v === "number" ? v : Number(v ?? 0);

/**
 * Mirror a collection out, one batch at a time.
 *
 * Deletes are the known gap and it is stated rather than hidden: a watermark
 * walk only ever sees rows that still exist, so a hard delete is invisible to
 * the warehouse. A soft-delete collection is fine — the tombstone is an update
 * and travels like any other row.
 */
async function pushCollection(
  ctx: Ctx,
  tenantId: string,
  row: SyncRow,
  // `id` is here for the pacing bucket, which is keyed per connected account —
  // two workspaces pushing with two sellers' credentials have independent
  // quotas at the far end.
  integration: { id: string; kind: string; config: Record<string, unknown> },
  config: Record<string, unknown>,
  fetchImpl?: FetchLike,
): Promise<SyncRunResult> {
  const collection = await loadCollection(ctx, tenantId, row.collection);
  if (!collection.hasUpdatedAt) {
    // Without it there is no total order to resume from, so a run would either
    // re-send everything forever or skip rows silently.
    throw new AppError(
      "VALIDATION",
      `Collection "${row.collection}" has no updated_at column, so it cannot be mirrored incrementally`,
    );
  }
  const updatedAtCol = collection.updatedAtColumn ?? "updated_at";
  const mapping = row.mapping ?? {};
  const byField = new Map(Object.entries(mapping));
  // Column types travel with the batch: a warehouse that has to declare a
  // schema cannot infer one from JSON.
  const columns: Record<string, string> = { id: "text" };
  for (const f of collection.fields) {
    const target = byField.get(f.name);
    if (target) columns[target] = f.type;
  }

  // A warehouse takes the whole batch in one request and wants it large. A
  // provider with no bulk endpoint — Google Calendar issues a call per event —
  // asks for a smaller one, because 200 rows there is 400 subrequests. Clamped
  // DOWN only: a provider cannot talk the engine into a bigger page.
  const batchSize = Math.min(PAGE_SIZE, DESTINATION_BATCH_SIZE[integration.kind] ?? PAGE_SIZE);

  let mark = parseWatermark(row.cursor);
  let written = 0;
  let pages = 0;
  let complete = false;

  for (; pages < MAX_PAGES && written < MAX_ROWS_PER_RUN; pages++) {
    let where = collection.tenantScoped
      ? sql`${sql.identifier("tenant_id")} = ${tenantId}`
      : sql`1 = 1`;
    if (mark) {
      where = sql`${where} AND (${sql.identifier(updatedAtCol)} > ${mark.updatedAt} OR (${sql.identifier(updatedAtCol)} = ${mark.updatedAt} AND ${sql.identifier(collection.pkColumn)} > ${mark.id}))`;
    }
    const batch = await queryAll<Record<string, unknown>>(
      ctx,
      sql`SELECT * FROM ${sql.identifier(collection.physicalTable)} WHERE ${where} ORDER BY ${sql.identifier(updatedAtCol)} ASC, ${sql.identifier(collection.pkColumn)} ASC LIMIT ${batchSize}`,
    );
    if (batch.length === 0) {
      complete = true;
      break;
    }

    const out = batch.map((r: Record<string, unknown>) => {
      // The primary key always travels, whatever the mapping says: it is what
      // makes a re-sent batch an upsert rather than a duplicate.
      const mapped: Record<string, unknown> = { id: String(r[collection.pkColumn] ?? "") };
      for (const [field, target] of byField) {
        if (r[field] !== undefined) mapped[target] = r[field];
      }
      return mapped;
    });

    await pushToDestination(
      integration.kind,
      {
        config,
        settings: row.settings ?? {},
        rows: out,
        columns,
        syncKey: row.id,
        connectionKey: integration.id,
      },
      fetchImpl,
    );

    const last = batch[batch.length - 1]!;
    // Advanced only AFTER the push resolves. A throw above leaves it where it
    // was, so the batch is retried rather than skipped.
    mark = {
      updatedAt: toMs(last[updatedAtCol]),
      id: String(last[collection.pkColumn] ?? ""),
    };
    written += out.length;
    if (batch.length < batchSize) {
      complete = true;
      break;
    }
  }

  await applyRunOutcome(ctx, row, {
    ok: true,
    written,
    // Kept even when complete: the next run resumes from the last row it sent
    // rather than re-sending the table. That is the difference between a mirror
    // and a nightly full reload.
    cursor: mark ? formatWatermark(mark) : null,
  });
  return { written, pages, complete };
}
