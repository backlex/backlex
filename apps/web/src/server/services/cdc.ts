/**
 * CDC sinks — the changefeed, delivered somewhere.
 *
 * ## What already existed, and what did not
 *
 * `/{slug}/changes` produces the hard part: an incremental feed with delete
 * TOMBSTONES and shape move-out markers, keyset-paginated so a reader resumes
 * exactly where it stopped. What it had was no consumer other than a client
 * polling it — so replicating a collection into a warehouse, a queue or an
 * archive meant somebody writing that poller, holding the cursor themselves,
 * and getting the retry semantics right.
 *
 * ## The decisions
 *
 * **It reuses `runChangefeed`, it does not re-derive "what changed".** The
 * tombstones are the whole reason the changefeed exists: a sink that selected
 * rows by `updated_at` would replicate every insert and update and silently
 * never replicate a delete, which is the failure mode that makes a warehouse
 * quietly wrong rather than obviously broken.
 *
 * **The cursor advances only after the delivery is acknowledged.** That makes a
 * sink at-least-once and never at-most-once. Duplicates on a retry are the
 * honest trade and every record carries a stable key so a destination can
 * deduplicate; advancing first and delivering after would lose rows on any
 * failure with nobody able to say which.
 *
 * **It runs as the system principal, unconditionally.** A sink replicates a
 * COLLECTION, and resolving the permission of whoever created it would make the
 * sink's contents depend on that person's row conditions — a replica that is
 * silently a subset, and that changes if their role does. The narrowing knob is
 * the `shape`, which is explicit and visible on the row.
 *
 * **One bounded page per tick per sink**, the same shape the external-DB
 * migration runner uses: a catch-up is many ticks rather than one long one, so
 * a large backlog cannot monopolise the cron.
 */
import { and, asc, eq } from "drizzle-orm";
import { AppError, type AuthSubject } from "@backlex/core";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import { runChangefeed } from "./items/changefeed";
import { loadCollection } from "./items/collection-loader";
import { signStandardWebhook } from "../lib/standard-webhooks";
import { fetchOutbound } from "./storage/hosts";
import { guardLogicalKey, physicalKey } from "./storage/keys";
import type { Ctx } from "../context";

type AnyDb = any;

const table = (dialect: "pg" | "sqlite") =>
  (dialect === "pg" ? pg.schema.cdcSinks : sqlite.schema.cdcSinks) as typeof pg.schema.cdcSinks;

export const CDC_DESTINATIONS = ["webhook", "storage"] as const;
export type CdcDestination = (typeof CDC_DESTINATIONS)[number];

/** Consecutive failures that trip the breaker, matching webhooks + sync hooks. */
export const CDC_AUTODISABLE_THRESHOLD = 15;
/** Ceiling on one delivery. A sink is a background job; a person is not waiting
 *  on it, but a hung destination must not hold the cron tick. */
const DELIVERY_TIMEOUT_MS = 15_000;
/** Sinks advanced per tick. Bounded so one workspace's backlog cannot starve
 *  every other workspace's. */
const SINKS_PER_TICK = 10;

export interface CdcSinkRow {
  id: string;
  tenantId: string;
  name: string;
  collection: string;
  destination: string;
  config: unknown;
  shape: string | null;
  fields: string | null;
  batchSize: number;
  enabled: boolean;
  cursor: string | null;
  lastRunAt: Date | number | null;
  lastError: string | null;
  consecutiveFailures: number;
  disabledReason: string | null;
}

export interface CdcSinkView {
  id: string;
  name: string;
  collection: string;
  destination: CdcDestination;
  /** The destination WITHOUT its secret — see `redactConfig`. */
  config: Record<string, unknown>;
  shape: string | null;
  fields: string | null;
  batchSize: number;
  enabled: boolean;
  /** How far this sink has replicated. Opaque; it is the changefeed's cursor. */
  cursor: string | null;
  lastRunAt: number | null;
  lastError: string | null;
  consecutiveFailures: number;
  disabledReason: string | null;
}

const ms = (v: Date | number | null): number | null =>
  v === null ? null : v instanceof Date ? v.getTime() : v;

const readConfig = (raw: unknown): Record<string, unknown> => {
  const parsed = typeof raw === "string" ? safeJson(raw) : raw;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
};

const safeJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

/** The signing secret is write-only, like every other one here — a config that
 *  came back whole would put it in a list half the admin UI reads. */
const redactConfig = (config: Record<string, unknown>): Record<string, unknown> => {
  const { secret, ...rest } = config;
  return { ...rest, ...(secret ? { hasSecret: true } : {}) };
};

export const toView = (row: CdcSinkRow): CdcSinkView => ({
  id: row.id,
  name: row.name,
  collection: row.collection,
  destination: row.destination === "storage" ? "storage" : "webhook",
  config: redactConfig(readConfig(row.config)),
  shape: row.shape,
  fields: row.fields,
  batchSize: row.batchSize,
  enabled: Boolean(row.enabled),
  cursor: row.cursor,
  lastRunAt: ms(row.lastRunAt),
  lastError: row.lastError,
  consecutiveFailures: row.consecutiveFailures,
  disabledReason: row.disabledReason,
});

// --- CRUD -------------------------------------------------------------------

export interface CdcSinkInput {
  name: string;
  collection: string;
  destination: CdcDestination;
  config: Record<string, unknown>;
  shape?: string | null;
  fields?: string | null;
  batchSize?: number;
  enabled?: boolean;
}

/**
 * The object key a storage sink writes to. One function, so what `validate`
 * checks is the same string `deliverStorage` produces — a prefix vetted in one
 * shape and used in another is a guard that only looks like one.
 */
const storageKey = (prefix: string, collection: string, marker: string): string =>
  `${(prefix || "cdc").replace(/\/+$/, "")}/${collection}/${marker}.ndjson`;

const validate = (input: CdcSinkInput): void => {
  if (!input.name?.trim()) throw new AppError("VALIDATION", "`name` is required");
  if (!input.collection?.trim()) throw new AppError("VALIDATION", "`collection` is required");
  if (!(CDC_DESTINATIONS as readonly string[]).includes(input.destination)) {
    throw new AppError("VALIDATION", `destination must be one of: ${CDC_DESTINATIONS.join(", ")}`);
  }
  if (input.destination === "webhook") {
    const url = input.config?.url;
    if (typeof url !== "string" || !url.trim()) {
      throw new AppError("VALIDATION", "A webhook sink needs `config.url`");
    }
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        throw new Error("scheme");
      }
    } catch {
      throw new AppError("VALIDATION", "`config.url` must be an http(s) URL");
    }
  }
  if (input.destination === "storage") {
    const prefix = input.config?.prefix;
    if (prefix !== undefined && typeof prefix !== "string") {
      throw new AppError("VALIDATION", "`config.prefix` must be a string");
    }
    if (typeof prefix === "string" && prefix) {
      // A prefix is a LOCATION, and this one is admin-supplied and ends up in a
      // key under `tenants/<id>/`. Refusing the two obvious shapes by hand
      // ("starts with a slash", "contains dot-dot") misses the ones the storage
      // layer already knows about — percent-encoded traversal that the S3
      // adapter's `encodeURI` leaves intact for URL parsing to collapse back,
      // backslashes, null bytes, `?`/`#`, and the reserved tenant prefix
      // itself. Escaping the tenant namespace on a shared deployment is a
      // cross-tenant write, so this asks the function that enforces that
      // boundary everywhere else rather than re-deriving its rules here.
      try {
        guardLogicalKey(storageKey(prefix, "probe", "probe"));
      } catch {
        throw new AppError(
          "VALIDATION",
          "`config.prefix` must be a plain key prefix — no leading slash, traversal segments, backslashes or query characters",
        );
      }
    }
  }
  const batch = input.batchSize ?? 100;
  if (!Number.isInteger(batch) || batch < 1 || batch > 500) {
    throw new AppError("VALIDATION", "`batchSize` must be 1..500");
  }
  if (input.shape) {
    try {
      JSON.parse(input.shape);
    } catch {
      throw new AppError("VALIDATION", "`shape` must be a JSON filter");
    }
  }
};

export const listCdcSinks = async (ctx: Ctx, tenantId: string): Promise<CdcSinkView[]> => {
  const t = table(ctx.dialect);
  const rows = (await (ctx.db as AnyDb)
    .select()
    .from(t)
    .where(eq(t.tenantId, tenantId))
    .orderBy(asc(t.createdAt))) as CdcSinkRow[];
  return rows.map(toView);
};

const storedConfig = (ctx: Ctx, config: Record<string, unknown>) =>
  ctx.dialect === "pg" ? config : JSON.stringify(config);

export const createCdcSink = async (
  ctx: Ctx,
  tenantId: string,
  input: CdcSinkInput,
): Promise<CdcSinkView> => {
  validate(input);
  // The collection has to exist NOW, or the sink is a job that fails forever
  // and an operator finds out from the failure counter.
  await loadCollection(ctx, tenantId, input.collection);
  const t = table(ctx.dialect);
  const row: CdcSinkRow = {
    id: crypto.randomUUID(),
    tenantId,
    name: input.name.trim(),
    collection: input.collection,
    destination: input.destination,
    config: input.config,
    shape: input.shape ?? null,
    fields: input.fields ?? null,
    batchSize: input.batchSize ?? 100,
    enabled: input.enabled ?? true,
    cursor: null,
    lastRunAt: null,
    lastError: null,
    consecutiveFailures: 0,
    disabledReason: null,
  };
  await (ctx.db as AnyDb)
    .insert(t)
    .values({
      ...row,
      config: storedConfig(ctx, input.config),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  return toView(row);
};

export const updateCdcSink = async (
  ctx: Ctx,
  tenantId: string,
  id: string,
  patch: Partial<CdcSinkInput> & { resetCursor?: boolean },
): Promise<CdcSinkView> => {
  const t = table(ctx.dialect);
  const rows = (await (ctx.db as AnyDb)
    .select()
    .from(t)
    .where(and(eq(t.id, id), eq(t.tenantId, tenantId)))
    .limit(1)) as CdcSinkRow[];
  const existing = rows[0];
  if (!existing) throw new AppError("NOT_FOUND", "Sink not found");
  const existingConfig = readConfig(existing.config);
  const merged: CdcSinkInput = {
    name: patch.name ?? existing.name,
    collection: patch.collection ?? existing.collection,
    destination: (patch.destination ?? existing.destination) as CdcDestination,
    // A patch that omits `secret` keeps the stored one — the same "leave blank
    // to keep" rule every other credential here follows.
    config: patch.config
      ? { ...patch.config, ...(patch.config.secret ? {} : pickSecret(existingConfig)) }
      : existingConfig,
    shape: patch.shape === undefined ? existing.shape : patch.shape,
    fields: patch.fields === undefined ? existing.fields : patch.fields,
    batchSize: patch.batchSize ?? existing.batchSize,
    enabled: patch.enabled ?? Boolean(existing.enabled),
  };
  validate(merged);
  const next: Record<string, unknown> = {
    ...merged,
    config: storedConfig(ctx, merged.config),
    updatedAt: new Date(),
  };
  // Re-enabling clears the breaker, or it would trip again immediately.
  if (patch.enabled === true) {
    next.consecutiveFailures = 0;
    next.disabledReason = null;
  }
  // Resetting the cursor replays the collection from the beginning. Explicit,
  // because it is the one operation that can flood a destination.
  if (patch.resetCursor) next.cursor = null;
  await (ctx.db as AnyDb)
    .update(t)
    .set(next)
    .where(and(eq(t.id, id), eq(t.tenantId, tenantId)));
  return toView({
    ...existing,
    ...merged,
    config: merged.config,
    cursor: patch.resetCursor ? null : existing.cursor,
    consecutiveFailures: patch.enabled === true ? 0 : existing.consecutiveFailures,
    disabledReason: patch.enabled === true ? null : existing.disabledReason,
  } as CdcSinkRow);
};

const pickSecret = (config: Record<string, unknown>): Record<string, unknown> =>
  config.secret ? { secret: config.secret } : {};

export const deleteCdcSink = async (
  ctx: Ctx,
  tenantId: string,
  id: string,
): Promise<void> => {
  const t = table(ctx.dialect);
  const rows = (await (ctx.db as AnyDb)
    .select({ id: t.id })
    .from(t)
    .where(and(eq(t.id, id), eq(t.tenantId, tenantId)))
    .limit(1)) as Array<{ id: string }>;
  if (!rows[0]) throw new AppError("NOT_FOUND", "Sink not found");
  await (ctx.db as AnyDb).delete(t).where(and(eq(t.id, id), eq(t.tenantId, tenantId)));
};

// --- delivery ---------------------------------------------------------------

/**
 * The system principal a sink reads as.
 *
 * Unconditional on purpose — see the header. `roles: []` is not "no access"
 * here: the changefeed is handed an explicit `perm` below rather than resolving
 * one, which is what makes the sink's contents a property of the SINK.
 */
const systemAuth = (tenantId: string): AuthSubject => ({
  userId: null,
  email: null,
  roles: [],
  tenantId,
});

export interface CdcRunResult {
  delivered: number;
  cursor: string | null;
  hasMore: boolean;
}

/** One record as a destination sees it. */
interface CdcRecord {
  /** Stable across retries — a destination deduplicates on this. */
  key: string;
  collection: string;
  /** `upsert` for a row that changed, `delete` for a tombstone, `exit` for a
   *  row that stopped matching the sink's shape. A destination that treats all
   *  three as an upsert would keep deleted rows forever. */
  op: "upsert" | "delete" | "exit";
  data: Record<string, unknown>;
}

const classify = (row: Record<string, unknown>, collection: string): CdcRecord => {
  const id = String(row.id ?? "");
  const updatedAt = row.updated_at ?? row.updatedAt ?? "";
  const op = row._shape_exit
    ? "exit"
    : row.deleted_at || row._deleted
      ? "delete"
      : "upsert";
  return {
    // Row id + the version it was at. A retry re-sends the identical key, so a
    // destination keyed on it converges; a UUID per attempt would not.
    key: `${collection}:${id}:${String(updatedAt)}`,
    collection,
    op,
    data: row,
  };
};

const deliverWebhook = async (
  ctx: Ctx,
  sink: CdcSinkRow,
  records: CdcRecord[],
): Promise<void> => {
  const config = readConfig(sink.config);
  const url = String(config.url);
  const body = JSON.stringify({
    sink: sink.name,
    collection: sink.collection,
    records,
  });
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(typeof config.headers === "object" && config.headers
      ? (config.headers as Record<string, string>)
      : {}),
  };
  if (typeof config.secret === "string" && config.secret) {
    // The Standard Webhooks scheme, the same one auth hooks use — an app
    // implementing one of ours has a verifier already.
    Object.assign(headers, await signStandardWebhook(config.secret, body, { id: `msg_${sink.id}` }));
  }
  // Through `fetchOutbound`, like every other admin-supplied URL in this
  // codebase: a sink URL is customer-controlled on managed cloud, where the
  // SSRF guard is deliberately on.
  const res = await fetchOutbound(ctx.env, url, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`destination responded ${res.status}`);
  }
};

const deliverStorage = async (
  ctx: Ctx,
  sink: CdcSinkRow,
  records: CdcRecord[],
  cursorBefore: string | null,
): Promise<void> => {
  const config = readConfig(sink.config);
  const prefix = typeof config.prefix === "string" && config.prefix ? config.prefix : "cdc";
  // The object name is derived from the cursor the batch STARTED at, so a retry
  // of the same batch overwrites its own object instead of adding a second one.
  // A timestamped name would make at-least-once delivery visible as duplicate
  // files, which is the thing a reader of this bucket cannot deduplicate.
  const marker = cursorBefore ? cursorBefore.slice(0, 32) : "initial";
  const key = storageKey(prefix, sink.collection, marker);
  // Checked at create AND here. A sink row outlives the validation that let it
  // in — an older row, a restored backup, a direct database edit — and this is
  // the last point before a key becomes a path under another tenant's prefix.
  guardLogicalKey(key);
  const body = `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;
  const physical = physicalKey(sink.tenantId, key);
  const stored = await ctx.storage.put({
    key: physical,
    body,
    contentType: "application/x-ndjson",
  });
  // Registered like any other object, for the reason the S3 endpoint was: the
  // bytes being in the bucket while the object is invisible to `/api/storage`,
  // the file browser, the usage gauges and backups would make this a second
  // STORE rather than a destination. `acl: private` — a CDC dump is the
  // collection's contents.
  const t = ctx.dialect === "pg" ? pg.schema.files : sqlite.schema.files;
  await (ctx.db as AnyDb)
    .insert(t)
    .values({
      key: physical,
      folderId: null,
      ownerId: null,
      tenantId: sink.tenantId,
      size: stored.size,
      contentType: "application/x-ndjson",
      acl: "private",
    })
    .onConflictDoUpdate({
      target: t.key,
      set: { size: stored.size, contentType: "application/x-ndjson", tenantId: sink.tenantId },
    });
};

/**
 * Advance one sink by at most one page.
 *
 * Exported so the admin "run now" button and the cron tick are the same code —
 * a "test this sink" path that delivered differently would be testing something
 * else.
 */
export const runCdcSink = async (ctx: Ctx, sink: CdcSinkRow): Promise<CdcRunResult> => {
  const collection = await loadCollection(ctx, sink.tenantId, sink.collection);
  const page = await runChangefeed({
    ctx,
    auth: systemAuth(sink.tenantId),
    collection,
    // Unconditional, and stated: the sink replicates the collection, not one
    // person's view of it.
    perm: { whereSql: undefined, fields: null },
    // A replica that silently omitted drafts would diverge from the source in a
    // way nobody could see from the destination.
    canSeeDrafts: true,
    since: sink.cursor ?? undefined,
    limit: sink.batchSize,
    shape: sink.shape ?? undefined,
    fields: sink.fields ?? undefined,
  });

  if (page.data.length === 0) {
    return { delivered: 0, cursor: sink.cursor, hasMore: false };
  }
  const records = page.data.map((row) => classify(row, sink.collection));
  if (sink.destination === "storage") {
    await deliverStorage(ctx, sink, records, sink.cursor);
  } else {
    await deliverWebhook(ctx, sink, records);
  }
  // Only now. The cursor is the acknowledgement.
  return { delivered: records.length, cursor: page.cursor, hasMore: page.hasMore };
};

const recordSuccess = async (ctx: Ctx, sink: CdcSinkRow, cursor: string | null) => {
  const t = table(ctx.dialect);
  await (ctx.db as AnyDb)
    .update(t)
    .set({
      cursor,
      lastRunAt: new Date(),
      lastError: null,
      consecutiveFailures: 0,
      updatedAt: new Date(),
    })
    .where(eq(t.id, sink.id));
};

const recordFailure = async (ctx: Ctx, sink: CdcSinkRow, error: string) => {
  const t = table(ctx.dialect);
  const failures = sink.consecutiveFailures + 1;
  const tripped = failures >= CDC_AUTODISABLE_THRESHOLD;
  await (ctx.db as AnyDb)
    .update(t)
    .set({
      // The cursor is NOT advanced. The same batch is retried next tick, which
      // is what at-least-once means.
      lastRunAt: new Date(),
      lastError: error.slice(0, 500),
      consecutiveFailures: failures,
      ...(tripped
        ? {
            enabled: false,
            disabledReason: `${CDC_AUTODISABLE_THRESHOLD} consecutive failures`,
          }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(t.id, sink.id));
};

/** Advance every enabled sink by one page. Called from the cron tick. */
export const processCdcSinks = async (ctx: Ctx): Promise<void> => {
  const t = table(ctx.dialect);
  let sinks: CdcSinkRow[];
  try {
    sinks = (await (ctx.db as AnyDb)
      .select()
      .from(t)
      .where(eq(t.enabled, true))
      .orderBy(asc(t.lastRunAt))
      .limit(SINKS_PER_TICK)) as CdcSinkRow[];
  } catch {
    // Table not migrated yet on an older instance.
    return;
  }
  for (const sink of sinks) {
    try {
      const res = await runCdcSink(ctx, sink);
      if (res.delivered > 0) await recordSuccess(ctx, sink, res.cursor);
      else await recordSuccess(ctx, sink, sink.cursor);
    } catch (e) {
      await recordFailure(ctx, sink, (e as Error).message);
    }
  }
};

export const loadCdcSink = async (
  ctx: Ctx,
  tenantId: string,
  id: string,
): Promise<CdcSinkRow> => {
  const t = table(ctx.dialect);
  const rows = (await (ctx.db as AnyDb)
    .select()
    .from(t)
    .where(and(eq(t.id, id), eq(t.tenantId, tenantId)))
    .limit(1)) as CdcSinkRow[];
  if (!rows[0]) throw new AppError("NOT_FOUND", "Sink not found");
  return rows[0];
};

/** "Run now" — one page, through the same code the cron uses. */
export const runCdcSinkNow = async (
  ctx: Ctx,
  tenantId: string,
  id: string,
): Promise<CdcRunResult & { error?: string }> => {
  const sink = await loadCdcSink(ctx, tenantId, id);
  try {
    const res = await runCdcSink(ctx, sink);
    await recordSuccess(ctx, sink, res.delivered > 0 ? res.cursor : sink.cursor);
    return res;
  } catch (e) {
    await recordFailure(ctx, sink, (e as Error).message);
    return { delivered: 0, cursor: sink.cursor, hasMore: false, error: (e as Error).message };
  }
};
