/**
 * Server-side external-DB migration (Phase 2 of docs/migrating-in.md).
 *
 * Sources are saved connections (URL encrypted at rest, masked on the API);
 * runs are durable copy executions the scheduler tick advances in bounded
 * slices. The actual row write path is the SAME `ingestRows` the CLI pump
 * uses — idempotent, PK-preserving, side-effect-free — which is what makes
 * lease-reclaim + resume safe: re-copying an overlap never dupes.
 *
 * Every surface (REST / SDK / GraphQL / MCP / CLI) funnels through the
 * functions here — guards and validation live once (see
 * multi-surface-parity in CLAUDE.md).
 */
import { and, asc, desc, eq, or, lt } from "drizzle-orm";
import { AppError } from "@backlex/core";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import {
  applyCollection,
  derivePhysicalTable,
  tableExists,
  validateFields,
  type FieldDef,
} from "@backlex/db";
import {
  buildPlan,
  collectionPayloadFor,
  collectionShapeMismatch,
  dedupeSlugsAgainst,
  createPgSource,
  parsePlan,
  transformRow,
  type MigrationPlan,
  type PlanTable,
  type SourceConnector,
  type SourceQuery,
} from "@backlex/migrate";
import type { Ctx } from "../context";
import { decryptSecret, encryptSecret } from "../lib/crypto";
import { isPrivateHost } from "./storage/hosts";
import { assertNotDemo } from "./demo";
import { invalidateTenantCollections } from "./collections-cache";
import { loadCollection } from "./items/collection-loader";
import { ingestRows } from "./migrate-ingest";

const sourcesTable = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.externalSources : sqlite.schema.externalSources;
const runsTable = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.migrationRuns : sqlite.schema.migrationRuns;
const collectionsTable = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.collections : sqlite.schema.collections;

// ── Connector factory (injectable for tests — pglite has no TCP) ──────────

export interface OpenedSource {
  connector: SourceConnector;
  close: () => Promise<unknown>;
}
export type ConnectorFactory = (url: string) => OpenedSource | Promise<OpenedSource>;

const defaultFactory: ConnectorFactory = async (url) => {
  // One connection is plenty for a linear pump; `prepare:false` keeps
  // transaction poolers (PgBouncer/Supabase pooler) happy. postgres.js runs
  // on Bun, Node, and Workers (TCP via cloudflare:sockets — the `workerd`
  // export condition picks its cf build).
  //
  // Imported through the `#postgres-driver` package-imports alias, NOT the
  // bare `postgres` specifier: the worker vite build stubs `postgres` to keep
  // the wire driver out of the cold-start eval path (D1-only instances never
  // touch it), and this dynamic import lands in a lazy chunk that only loads
  // when someone actually runs a server-side migration — same lazy-load
  // posture as the GraphQL subsystem.
  const { default: postgres } = await import("#postgres-driver");
  const sql = postgres(url, { max: 1, prepare: false, connect_timeout: 10 });
  const query: SourceQuery = async (text, params) =>
    (await sql.unsafe(text, (params ?? []) as never[])) as unknown as Record<
      string,
      unknown
    >[];
  return { connector: createPgSource(query), close: () => sql.end() };
};

let connectorFactory: ConnectorFactory = defaultFactory;

/** Test hook: swap the connector factory (e.g. for a pglite-backed source).
 *  Returns the previous factory so callers can restore it. */
export const __setMigrateConnectorFactory = (
  f: ConnectorFactory | null,
): ConnectorFactory => {
  const prev = connectorFactory;
  connectorFactory = f ?? defaultFactory;
  return prev;
};

// ── SSRF guard ─────────────────────────────────────────────────────────────

/**
 * Reject connection strings that point back into the platform's own network — a
 * hosted admin must not be able to use the server as a proxy into private
 * infrastructure. Self-hosters whose source DB legitimately lives on a private
 * address opt out with MIGRATE_ALLOW_PRIVATE_SOURCES. (The CLI pump has no such
 * restriction — it runs on the user's machine.)
 *
 * This used to be eleven hand-written regexes over `u.hostname`, and it is now
 * `isPrivateHost` because the regexes answered a question the resolver does not
 * ask. `postgres:` is a non-special scheme, so the WHATWG parser leaves the
 * host opaque: `postgres://u:p@2130706433/db` has hostname `2130706433`, which
 * matches none of the eleven — and `getaddrinfo` turns it into `127.0.0.1`.
 * `0x7f000001`, `0177.0.0.1` and `[::ffff:127.0.0.1]` were three more of the
 * same. A saved source is readable (`POST /sources/:id/test`,
 * `GET /sources/:id/tables`) and copyable into the caller's own collections, so
 * every one of those was the outcome this function's own comment says it exists
 * to prevent.
 *
 * One matcher for the whole repo now, so a spelling the outbound-fetch guard
 * learns is a spelling this one knows too.
 */
export const assertSourceUrlAllowed = (ctx: Ctx, raw: string): void => {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new AppError("VALIDATION", "Invalid connection URL");
  }
  if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") {
    throw new AppError(
      "VALIDATION",
      "Only postgres:// sources are supported server-side (use the backlex import-db CLI for other engines)",
    );
  }
  if (!u.hostname) throw new AppError("VALIDATION", "Connection URL is missing a host");
  if (ctx.env.MIGRATE_ALLOW_PRIVATE_SOURCES === "true") return;
  if (isPrivateHost(u.hostname)) {
    throw new AppError(
      "VALIDATION",
      `Host "${u.hostname}" is a private/internal address. If this backlex is self-hosted next to the database, set MIGRATE_ALLOW_PRIVATE_SOURCES=true; otherwise run the copy from your own network with \`backlex import-db\`.`,
    );
  }
};

// ── Sources CRUD ───────────────────────────────────────────────────────────

export interface PublicSource {
  id: string;
  name: string;
  kind: string;
  /** Redacted URL — scheme + host + database only, credentials stripped. */
  urlMasked: string;
  createdAt: unknown;
  updatedAt: unknown;
}

const maskUrl = (raw: string): string => {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ""}${u.pathname}`;
  } catch {
    return "(invalid url)";
  }
};

const authSecret = (ctx: Ctx): string => {
  const s = ctx.env.AUTH_SECRET;
  if (!s) throw new AppError("UNAVAILABLE", "AUTH_SECRET is not configured");
  return s;
};

const toPublicSource = async (
  ctx: Ctx,
  row: Record<string, unknown>,
): Promise<PublicSource> => ({
  id: row.id as string,
  name: row.name as string,
  kind: row.kind as string,
  urlMasked: maskUrl(
    (await decryptSecret(row.url as string, authSecret(ctx))) ?? "",
  ),
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export const listSources = async (
  ctx: Ctx,
  tenantId: string,
): Promise<PublicSource[]> => {
  const t = sourcesTable(ctx.dialect);
  const rows = await (ctx.db as any)
    .select()
    .from(t)
    .where(eq(t.tenantId, tenantId))
    .orderBy(asc(t.name));
  return Promise.all(rows.map((r: Record<string, unknown>) => toPublicSource(ctx, r)));
};

export const createSource = async (
  ctx: Ctx,
  tenantId: string,
  input: { name: string; url: string; createdBy?: string | null },
): Promise<PublicSource> => {
  // Blocked in the playground wherever it is reached from — the route
  // prefix list is one layer and GraphQL does not pass through it.
  // See `services/demo.ts::assertNotDemo`.
  assertNotDemo(ctx.env);
  const name = input.name.trim();
  if (!name) throw new AppError("VALIDATION", "Source name is required");
  assertSourceUrlAllowed(ctx, input.url);
  const t = sourcesTable(ctx.dialect);
  const existing = await (ctx.db as any)
    .select({ id: t.id })
    .from(t)
    .where(and(eq(t.tenantId, tenantId), eq(t.name, name)))
    .limit(1);
  if (existing[0]) throw new AppError("CONFLICT", `Source "${name}" already exists`);
  const row = {
    id: crypto.randomUUID(),
    tenantId,
    name,
    kind: "postgres",
    url: await encryptSecret(input.url, authSecret(ctx)),
    createdBy: input.createdBy ?? null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  await (ctx.db as any).insert(t).values(row);
  return toPublicSource(ctx, row);
};

export const deleteSource = async (
  ctx: Ctx,
  tenantId: string,
  id: string,
): Promise<void> => {
  const t = sourcesTable(ctx.dialect);
  const existing = await (ctx.db as any)
    .select({ id: t.id })
    .from(t)
    .where(and(eq(t.tenantId, tenantId), eq(t.id, id)))
    .limit(1);
  if (!existing[0]) throw new AppError("NOT_FOUND", "Source not found");
  // Refuse while a run is in flight — cancel first, then delete.
  const r = runsTable(ctx.dialect);
  const active = await (ctx.db as any)
    .select({ id: r.id })
    .from(r)
    .where(
      and(
        eq(r.tenantId, tenantId),
        eq(r.sourceId, id),
        or(eq(r.status, "pending"), eq(r.status, "running")),
      ),
    )
    .limit(1);
  if (active[0]) {
    throw new AppError("CONFLICT", "A migration run for this source is in progress — cancel it first");
  }
  await (ctx.db as any).delete(t).where(and(eq(t.tenantId, tenantId), eq(t.id, id)));
};

/** Decrypt + open a saved source. Callers MUST close(). */
const openSavedSource = async (
  ctx: Ctx,
  tenantId: string,
  id: string,
): Promise<OpenedSource> => {
  const t = sourcesTable(ctx.dialect);
  const rows = await (ctx.db as any)
    .select()
    .from(t)
    .where(and(eq(t.tenantId, tenantId), eq(t.id, id)))
    .limit(1);
  if (!rows[0]) throw new AppError("NOT_FOUND", "Source not found");
  const url = await decryptSecret(rows[0].url as string, authSecret(ctx));
  if (!url) throw new AppError("UNAVAILABLE", "Could not decrypt the source URL (AUTH_SECRET changed?)");
  // Re-check on every open — the guard's env flag may have been tightened
  // since the source was saved.
  assertSourceUrlAllowed(ctx, url);
  return await connectorFactory(url);
};

export const testSource = async (
  ctx: Ctx,
  tenantId: string,
  id: string,
): Promise<{ ok: boolean; tables?: number; error?: string }> => {
  let opened: OpenedSource | null = null;
  try {
    opened = await openSavedSource(ctx, tenantId, id);
    const tables = await opened.connector.listTables();
    return { ok: true, tables: tables.length };
  } catch (e) {
    if (e instanceof AppError) throw e;
    return { ok: false, error: (e as Error).message };
  } finally {
    await opened?.close().catch(() => {});
  }
};

export const listSourceTables = async (
  ctx: Ctx,
  tenantId: string,
  id: string,
): Promise<{ name: string; approxRows: number | null }[]> => {
  const opened = await openSavedSource(ctx, tenantId, id);
  try {
    return await opened.connector.listTables();
  } finally {
    await opened.close().catch(() => {});
  }
};

export const buildSourcePlan = async (
  ctx: Ctx,
  tenantId: string,
  id: string,
  tables?: string[],
): Promise<MigrationPlan> => {
  const opened = await openSavedSource(ctx, tenantId, id);
  try {
    const all = await opened.connector.listTables();
    const picked = tables?.length
      ? all.filter((t) => tables.includes(t.name))
      : all;
    if (tables?.length) {
      for (const name of tables) {
        if (!all.some((t) => t.name === name)) {
          throw new AppError("NOT_FOUND", `Source table not found: ${name}`);
        }
      }
    }
    const inspections = [];
    for (const t of picked) inspections.push(await opened.connector.inspect(t.name));
    const plan = buildPlan(inspections, new Map(picked.map((t) => [t.name, t])));
    // Server-side plans know the workspace: rename slugs that collide with
    // existing incompatible collections (template-seeded workspaces almost
    // always have "customers"/"orders"/… already) so a run never "resumes"
    // into a foreign shape and fails every row. Compatible collisions stay —
    // that's the legitimate resume path.
    return dedupeSlugsAgainst(plan, await existingCollectionShapes(ctx, tenantId));
  } finally {
    await opened.close().catch(() => {});
  }
};

/** slug → shape map of the workspace's collections, for collision checks. */
const existingCollectionShapes = async (
  ctx: Ctx,
  tenantId: string,
): Promise<Map<string, { pkType: string | null; adopted: boolean; fields: { name: string }[] }>> => {
  const c = collectionsTable(ctx.dialect);
  const rows = await (ctx.db as any)
    .select({ slug: c.slug, pkType: c.pkType, adopted: c.adopted, fields: c.fields })
    .from(c)
    .where(eq(c.tenantId, tenantId));
  return new Map(
    (rows as { slug: string; pkType: string | null; adopted: unknown; fields: unknown }[]).map(
      (r) => [
        r.slug,
        {
          pkType: r.pkType ?? null,
          adopted: Boolean(r.adopted),
          fields: (r.fields ?? []) as { name: string }[],
        },
      ],
    ),
  );
};

// ── Runs ───────────────────────────────────────────────────────────────────

export interface RunTableState {
  table: string;
  cursor?: unknown;
  copied: number;
  failed: number;
  done: boolean;
  sourceCount?: number;
  targetTotal?: number;
}
export interface RunState {
  tables: Record<string, RunTableState>; // keyed by slug
}

export type RunStatus = "pending" | "running" | "done" | "failed" | "cancelled";

const toPublicRun = (row: Record<string, unknown>) => ({
  id: row.id,
  sourceId: row.sourceId ?? row.source_id,
  status: row.status,
  error: row.error ?? null,
  plan: row.plan,
  state: row.state,
  startedAt: row.startedAt ?? row.started_at ?? null,
  finishedAt: row.finishedAt ?? row.finished_at ?? null,
  createdAt: row.createdAt ?? row.created_at,
  updatedAt: row.updatedAt ?? row.updated_at,
});

export const startRun = async (
  ctx: Ctx,
  tenantId: string,
  input: { sourceId: string; plan: unknown; createdBy?: string | null },
): Promise<ReturnType<typeof toPublicRun>> => {
  // Blocked in the playground wherever it is reached from — the route
  // prefix list is one layer and GraphQL does not pass through it.
  // See `services/demo.ts::assertNotDemo`.
  assertNotDemo(ctx.env);
  let plan: MigrationPlan;
  try {
    plan = parsePlan(input.plan);
  } catch (e) {
    throw new AppError("VALIDATION", `Invalid plan: ${(e as Error).message}`);
  }
  const included = plan.tables.filter((t) => t.include);
  if (included.length === 0) {
    throw new AppError("VALIDATION", "The plan includes no tables");
  }
  // Hard guard against copying into an existing collection of a different
  // shape (hand-edited plans can reintroduce the collision the plan builder
  // renames away) — that would fail every row with "Unknown column".
  const shapes = await existingCollectionShapes(ctx, tenantId);
  for (const t of included) {
    const hit = shapes.get(t.slug);
    if (!hit) continue;
    const reason = collectionShapeMismatch(t, hit);
    if (reason) throw new AppError("CONFLICT", reason);
  }
  // Source must exist (also re-runs the SSRF guard via decrypt on open later).
  const s = sourcesTable(ctx.dialect);
  const src = await (ctx.db as any)
    .select({ id: s.id })
    .from(s)
    .where(and(eq(s.tenantId, tenantId), eq(s.id, input.sourceId)))
    .limit(1);
  if (!src[0]) throw new AppError("NOT_FOUND", "Source not found");
  // One migration at a time per workspace — parallel copies into the same
  // collections would interleave confusingly for no benefit.
  const r = runsTable(ctx.dialect);
  const active = await (ctx.db as any)
    .select({ id: r.id })
    .from(r)
    .where(
      and(
        eq(r.tenantId, tenantId),
        or(eq(r.status, "pending"), eq(r.status, "running")),
      ),
    )
    .limit(1);
  if (active[0]) {
    throw new AppError("CONFLICT", "Another migration run is already in progress for this workspace");
  }
  const state: RunState = { tables: {} };
  for (const t of included) {
    state.tables[t.slug] = { table: t.table, copied: 0, failed: 0, done: false };
  }
  const row = {
    id: crypto.randomUUID(),
    tenantId,
    sourceId: input.sourceId,
    plan: plan as unknown,
    state: state as unknown,
    status: "pending",
    error: null,
    leaseUntil: null,
    startedAt: null,
    finishedAt: null,
    createdBy: input.createdBy ?? null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  await (ctx.db as any).insert(r).values(row);
  return toPublicRun(row);
};

export const listRuns = async (ctx: Ctx, tenantId: string) => {
  const r = runsTable(ctx.dialect);
  const rows = await (ctx.db as any)
    .select()
    .from(r)
    .where(eq(r.tenantId, tenantId))
    .orderBy(desc(r.createdAt))
    .limit(50);
  return rows.map((row: Record<string, unknown>) => toPublicRun(row));
};

const getRunRow = async (ctx: Ctx, tenantId: string, id: string) => {
  const r = runsTable(ctx.dialect);
  const rows = await (ctx.db as any)
    .select()
    .from(r)
    .where(and(eq(r.tenantId, tenantId), eq(r.id, id)))
    .limit(1);
  if (!rows[0]) throw new AppError("NOT_FOUND", "Run not found");
  return rows[0] as Record<string, unknown>;
};

export const getRun = async (ctx: Ctx, tenantId: string, id: string) =>
  toPublicRun(await getRunRow(ctx, tenantId, id));

export const cancelRun = async (ctx: Ctx, tenantId: string, id: string) => {
  const row = await getRunRow(ctx, tenantId, id);
  if (row.status === "done" || row.status === "cancelled") {
    return toPublicRun(row);
  }
  const r = runsTable(ctx.dialect);
  await (ctx.db as any)
    .update(r)
    .set({ status: "cancelled", finishedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(r.tenantId, tenantId), eq(r.id, id)));
  return getRun(ctx, tenantId, id);
};

/** Put a failed/cancelled run back in the queue. State (cursors) is kept —
 *  the copy continues where it stopped; overlap is idempotent. */
export const resumeRun = async (ctx: Ctx, tenantId: string, id: string) => {
  const row = await getRunRow(ctx, tenantId, id);
  if (row.status !== "failed" && row.status !== "cancelled") {
    throw new AppError("VALIDATION", `Only failed/cancelled runs can be resumed (status: ${row.status})`);
  }
  const r = runsTable(ctx.dialect);
  await (ctx.db as any)
    .update(r)
    .set({ status: "pending", error: null, finishedAt: null, updatedAt: new Date() })
    .where(and(eq(r.tenantId, tenantId), eq(r.id, id)));
  return getRun(ctx, tenantId, id);
};

// ── The copy executor (scheduler tick sweep) ───────────────────────────────

const LEASE_MS = 120_000;

/** Ensure the target collection for a plan table exists (idempotent). This
 *  mirrors the managed branch of `POST /api/collections` minimally: slug
 *  reuse on resume, metadata row + additive DDL on first touch. */
const ensureCollection = async (
  ctx: Ctx,
  tenantId: string,
  t: PlanTable,
  createdBy: string | null,
): Promise<void> => {
  const c = collectionsTable(ctx.dialect);
  const existing = await (ctx.db as any)
    .select({ id: c.id })
    .from(c)
    .where(and(eq(c.tenantId, tenantId), eq(c.slug, t.slug)))
    .limit(1);
  if (existing[0]) return; // resume path — copy into the existing collection
  const payload = collectionPayloadFor(t);
  try {
    validateFields(payload.fields as FieldDef[]);
  } catch (e) {
    throw new AppError("VALIDATION", `Table "${t.table}": ${(e as Error).message}`);
  }
  const physicalTable = derivePhysicalTable(tenantId, t.slug);
  if (await tableExists(ctx.db, ctx.dialect, physicalTable)) {
    throw new AppError(
      "CONFLICT",
      `Physical table "${physicalTable}" already exists but is not registered as a collection`,
    );
  }
  await (ctx.db as any).insert(c).values({
    id: crypto.randomUUID(),
    slug: t.slug,
    tenantId,
    physicalTable,
    fields: payload.fields,
    ownerScoped: false,
    tenantScoped: true,
    versioned: false,
    softDelete: false,
    singleton: false,
    auditReads: false,
    vectorize: false,
    fts: false,
    adopted: false,
    pkColumn: "id",
    pkType: t.pkType,
    hasCreatedAt: true,
    hasUpdatedAt: true,
  });
  invalidateTenantCollections(tenantId);
  await applyCollection(ctx.db, ctx.dialect, {
    table: physicalTable,
    fields: payload.fields as FieldDef[],
    pkType: t.pkType,
    ownerScoped: false,
    tenantScoped: true,
    versioned: false,
    hasCreatedAt: true,
    hasUpdatedAt: true,
    softDelete: false,
    fts: false,
    adopted: false,
  });
  void createdBy; // recorded on the run row, not the collection
};

const saveRun = async (
  ctx: Ctx,
  id: string,
  patch: Record<string, unknown>,
): Promise<void> => {
  const r = runsTable(ctx.dialect);
  await (ctx.db as any)
    .update(r)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(r.id, id));
};

export interface ProcessOptions {
  /** Wall-clock budget for one sweep — the run yields back to the tick
   *  when exceeded and continues next tick. */
  budgetMs?: number;
  batchSize?: number;
  now?: Date;
}

/**
 * Advance at most one due migration run by one bounded slice. Called from
 * the scheduler tick. Claiming is lease-based: a `running` row whose lease
 * expired was abandoned by a dead isolate and is picked up again — safe
 * because the ingest is idempotent and cursors persist per batch.
 */
export const processMigrationRuns = async (
  ctx: Ctx,
  opts: ProcessOptions = {},
): Promise<{ advanced: string | null }> => {
  const now = opts.now ?? new Date();
  const budgetMs = opts.budgetMs ?? 20_000;
  const batchSize = Math.min(2000, Math.max(1, opts.batchSize ?? 500));
  const r = runsTable(ctx.dialect);

  const due = await (ctx.db as any)
    .select()
    .from(r)
    .where(
      or(
        eq(r.status, "pending"),
        and(eq(r.status, "running"), lt(r.leaseUntil, now)),
      ),
    )
    .orderBy(asc(r.createdAt))
    .limit(1);
  const run = due[0] as Record<string, unknown> | undefined;
  if (!run) return { advanced: null };

  const runId = run.id as string;
  const tenantId = (run.tenantId ?? run.tenant_id) as string;
  const sourceId = (run.sourceId ?? run.source_id) as string;
  const plan = parsePlan(run.plan);
  const state = (run.state ?? { tables: {} }) as RunState;
  const byName = new Map(plan.tables.map((t) => [t.table, t] as const));

  await saveRun(ctx, runId, {
    status: "running",
    leaseUntil: new Date(now.getTime() + LEASE_MS),
    startedAt: (run.startedAt ?? run.started_at ?? new Date()) as Date,
  });

  let opened: OpenedSource | null = null;
  const deadline = Date.now() + budgetMs;
  try {
    opened = await openSavedSource(ctx, tenantId, sourceId);

    for (const tableName of plan.order) {
      const t = byName.get(tableName)!;
      const st = (state.tables[t.slug] ??= {
        table: tableName,
        copied: 0,
        failed: 0,
        done: false,
      });
      if (st.done) {
        // A previous slice may have finished the copy but hit its budget
        // before the count-verification below ran — skipping here would
        // leave `sourceCount` unset forever and fail verification on a
        // clean table. Backfill it, then move on.
        if (st.sourceCount === undefined) {
          st.sourceCount = await opened.connector.count(tableName);
          st.targetTotal ??= st.copied;
          await saveRun(ctx, runId, { state });
          if (Date.now() > deadline) return { advanced: runId };
        }
        continue;
      }

      await ensureCollection(ctx, tenantId, t, (run.createdBy as string) ?? null);
      const collection = await loadCollection(ctx, tenantId, t.slug);

      while (!st.done) {
        // Honor cancel between batches (another request may have flipped it).
        const fresh = await getRunRow(ctx, tenantId, runId);
        if (fresh.status === "cancelled") return { advanced: runId };

        const rows = await opened.connector.readBatch(tableName, t.pkColumn, {
          after: st.cursor,
          limit: batchSize,
        });
        if (rows.length === 0) {
          st.done = true;
        } else {
          const result = await ingestRows(
            ctx,
            collection,
            tenantId,
            rows.map((row) => transformRow(t, row)),
          );
          st.copied += result.inserted;
          st.failed += result.failed.length;
          st.targetTotal = result.total;
          st.cursor = rows[rows.length - 1]![t.pkColumn];
          st.done = rows.length < batchSize;
        }
        await saveRun(ctx, runId, {
          state,
          leaseUntil: new Date(Date.now() + LEASE_MS),
        });
        if (Date.now() > deadline) return { advanced: runId }; // next tick continues
      }
      // Table finished — verify counts while the connector is open.
      st.sourceCount = await opened.connector.count(tableName);
      st.targetTotal ??= st.copied; // empty table — nothing was ingested
      await saveRun(ctx, runId, { state });
      if (Date.now() > deadline) return { advanced: runId };
    }

    const allVerified = plan.order.every((name) => {
      const t = byName.get(name)!;
      const st = state.tables[t.slug]!;
      return (
        st.failed === 0 &&
        st.sourceCount !== undefined &&
        (st.targetTotal ?? 0) >= st.sourceCount
      );
    });
    await saveRun(ctx, runId, {
      state,
      status: allVerified ? "done" : "failed",
      error: allVerified
        ? null
        : "Verification failed — some tables have row failures or count mismatches (see state)",
      finishedAt: new Date(),
      leaseUntil: null,
    });
    return { advanced: runId };
  } catch (e) {
    await saveRun(ctx, runId, {
      state,
      status: "failed",
      error: (e as Error).message,
      finishedAt: new Date(),
      leaseUntil: null,
    });
    return { advanced: runId };
  } finally {
    await opened?.close().catch(() => {});
  }
};
