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
  DESTINATION_COLUMNS,
  DESTINATION_SETTING_FIELDS,
  SOURCE_SETTING_FIELDS,
  isIntegrationKind,
  OAUTH_SCOPE_KEY,
  providerFor,
  pullFromSource,
  pushToDestination,
  type FetchLike,
  type IntegrationKind,
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

export type SyncDirection = "pull" | "push";
export const SYNC_DIRECTIONS: readonly SyncDirection[] = ["pull", "push"];

export interface SyncRow {
  id: string;
  integrationId: string;
  tenantId: string;
  collection: string;
  direction: string;
  settings: Record<string, unknown>;
  mapping: Record<string, string>;
  intervalMinutes: number;
  enabled: boolean;
  cursor: string | null;
  lastRunAt: Date | number | null;
  lastRowCount: number;
  lastError: string | null;
  consecutiveFailures: number;
  disabledReason: string | null;
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
  createdAt: row.createdAt,
});

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
  required: string | undefined,
): void => {
  if (!required) return;
  const granted = integration.config?.[OAUTH_SCOPE_KEY];
  if (typeof granted !== "string" || !granted.trim()) return;
  if (granted.split(/\s+/).includes(required)) return;
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
  intervalMinutes?: number;
  enabled?: boolean;
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
  const mapping = validateMapping(input.mapping ?? {}, collection, direction, integration.kind);

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
    intervalMinutes: clampInterval(input.intervalMinutes),
    enabled: input.enabled ?? true,
    createdAt: now,
    updatedAt: now,
  });
  const row = await getSync(ctx, tenantId, id);
  if (!row) throw new Error("sync row missing after insert");
  return row;
}

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
): Record<string, string> => {
  const out: Record<string, string> = {};
  // A destination with a closed column set (a calendar event has a `summary`
  // and a `start`, not arbitrary columns) is checked here. A warehouse declares
  // none — its columns are whatever the operator's DDL says — and stays free
  // text. Without this a typo'd target is accepted, dropped by the provider,
  // and the run reports a clean success having written nothing.
  const columns = direction === "push" ? DESTINATION_COLUMNS[kind] : undefined;
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
    if (direction === "pull" && !writable.has(value)) {
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

const getSyncRow = async (ctx: Ctx, tenantId: string, id: string): Promise<SyncRow | null> => {
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
  intervalMinutes?: number;
  enabled?: boolean;
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

  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.settings !== undefined) {
    set.settings = validateSettings(
      integration.kind,
      patch.settings,
      existing.direction as SyncDirection,
    );
    // The cursor is only meaningful for the source it came from; pointing the
    // sync at a different sheet while keeping a row offset would read garbage.
    set.cursor = null;
  }
  if (patch.mapping !== undefined) {
    set.mapping = validateMapping(
      patch.mapping,
      await loadCollection(ctx, tenantId, existing.collection),
      existing.direction as SyncDirection,
      integration.kind,
    );
  }
  if (patch.intervalMinutes !== undefined) set.intervalMinutes = clampInterval(patch.intervalMinutes);
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

const decryptConfig = async (kind: string, config: Record<string, unknown>, secret: string) => {
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

/** Fold one run's outcome into the breaker, mirroring the delivery path. */
const applyRunOutcome = async (
  ctx: Ctx,
  row: SyncRow,
  outcome: { ok: true; written: number; cursor: string | null } | { ok: false; error: string },
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
  const next = (row.consecutiveFailures ?? 0) + 1;
  const paused = next >= SYNC_AUTODISABLE_THRESHOLD;
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
      });
      throw e;
    }
  }

  const collection = await loadCollection(ctx, tenantId, row.collection);
  let cursor = row.cursor;
  let resumeToken: string | null = null;
  let written = 0;
  let pages = 0;
  let complete = false;
  try {
    for (; pages < MAX_PAGES && written < MAX_ROWS_PER_RUN; pages++) {
      const page = await pullFromSource(
        integration.kind,
        { config, settings: row.settings ?? {}, cursor, limit: PAGE_SIZE },
        fetchImpl,
      );
      const rows = page.records.map((r) => toRow(integration.kind, row.id, row.mapping ?? {}, r));
      if (rows.length > 0) {
        const out = await ingestRows(ctx, collection, tenantId, rows, { mode: "upsert" });
        if (out.failed.length > 0) {
          // A rejected row is a schema mismatch, not a blip. Reporting success
          // would advance the cursor past data nobody stored.
          throw new AppError(
            "VALIDATION",
            `${out.failed.length} row(s) rejected by "${row.collection}": ${out.failed[0]?.error ?? "unknown"}`,
          );
        }
        written += out.inserted + out.updated;
      }
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
    await applyRunOutcome(ctx, row, { ok: false, error });
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
  integration: { kind: string; config: Record<string, unknown> },
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
      { config, settings: row.settings ?? {}, rows: out, columns, syncKey: row.id },
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
