import { and, desc, eq, gte, lt } from "drizzle-orm";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { Env } from "../env";
import type { TraceContext } from "../lib/trace";
import type { DbCtx } from "./seed";

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.spans : sqlite.schema.spans;

/** Fraction of requests whose span is persisted (`0`..`1`). `TRACES_SAMPLE_RATE`
 *  unset → record everything; the write is non-blocking and the table is
 *  pruned, so full sampling is the sensible default for a single instance. */
export const traceSampleRate = (
  env: Pick<Env, "TRACES_SAMPLE_RATE">,
): number => {
  const raw = (env.TRACES_SAMPLE_RATE ?? "").trim();
  if (!raw) return 1;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 1;
  return Math.min(1, Math.max(0, n));
};

export interface SpanInput {
  trace: TraceContext;
  name: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  /** Epoch-ms when the request started. */
  startedAt: number;
  tenantId: string | null;
  userId: string | null;
  errorCode?: string;
  /** Set on item-list requests: the collection and the local columns the query
   *  filtered / sorted on. Persisted into `attributes` so the advisor's
   *  runtime rules can aggregate which columns real traffic needs indexed.
   *  Column names only — filter values are never recorded. */
  queryShape?: { collection: string; filters: string[]; sorts: string[] };
  /** Writes in this request that fell outside their `write` permission's
   *  conditions. Persisted so the advisor's `permission-write-check` rule can
   *  answer the only question `PERMISSION_WRITE_CHECK=warn` exists to answer:
   *  would turning it to `enforce` refuse anything this workspace actually
   *  does. Collection + action + mode only — no row values. */
  permissionWriteChecks?: { collection: string; action: string; mode: string }[];
}

/** Distinct `collection:action:mode` triples, capped. One span row is written
 *  per sampled request, so a bulk import of 5,000 rows that each miss the same
 *  condition must not write 5,000 entries — the advisor needs to know WHICH
 *  collection and action, and the request count is the span count. */
export const foldWriteChecks = (
  checks: { collection: string; action: string; mode: string }[] | undefined,
  cap = 8,
): string[] => {
  if (!checks?.length) return [];
  const seen = new Set<string>();
  for (const c of checks) {
    seen.add(`${c.collection}:${c.action}:${c.mode}`);
    if (seen.size >= cap) break;
  }
  return [...seen];
};

/** Build the span's `attributes` JSON, or null when there is nothing to store.
 *  Kept small on purpose: one row is written per sampled request. */
const spanAttributes = (
  input: SpanInput,
): Record<string, unknown> | null => {
  const attrs: Record<string, unknown> = {};
  if (input.errorCode) attrs.code = input.errorCode;
  const shape = input.queryShape;
  if (shape) {
    attrs.collection = shape.collection;
    if (shape.filters.length) attrs.filters = shape.filters;
    if (shape.sorts.length) attrs.sorts = shape.sorts;
  }
  const writeChecks = foldWriteChecks(input.permissionWriteChecks);
  if (writeChecks.length) attrs.permissionWriteChecks = writeChecks;
  return Object.keys(attrs).length ? attrs : null;
};

/** Fire-and-forget persist of one server span. Never throws — telemetry must
 *  not break the request that produced it. */
export const recordSpan = async (
  ctx: DbCtx,
  input: SpanInput,
): Promise<void> => {
  const t = tableFor(ctx.dialect);
  try {
    await (ctx.db as any).insert(t).values({
      id: crypto.randomUUID(),
      tenantId: input.tenantId,
      traceId: input.trace.traceId,
      spanId: input.trace.spanId,
      parentSpanId: input.trace.parentSpanId,
      name: input.name,
      kind: "server",
      method: input.method,
      path: input.path,
      status: input.status,
      userId: input.userId,
      durationMs: input.durationMs,
      attributes: spanAttributes(input),
      startedAt: new Date(input.startedAt),
    });
  } catch (e) {
    console.error("[traces] failed to record span", e);
  }
};

export interface SpanRow {
  id: string;
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  method: string | null;
  path: string | null;
  status: number | null;
  userId: string | null;
  durationMs: number | null;
  attributes: Record<string, unknown> | null;
  startedAt: number;
}

const toRow = (r: any): SpanRow => ({
  id: r.id,
  traceId: r.traceId,
  spanId: r.spanId,
  parentSpanId: r.parentSpanId ?? null,
  name: r.name,
  method: r.method ?? null,
  path: r.path ?? null,
  status: r.status ?? null,
  userId: r.userId ?? null,
  durationMs: r.durationMs ?? null,
  attributes: (r.attributes as Record<string, unknown> | null) ?? null,
  startedAt: r.startedAt instanceof Date ? r.startedAt.getTime() : Number(r.startedAt),
});

/** A trace = all spans sharing a `traceId`, summarized by its root span. */
export interface TraceSummary {
  traceId: string;
  /** Display name of the root (parentless, else earliest) span. */
  name: string;
  rootStatus: number | null;
  spanCount: number;
  /** Wall-clock from the earliest span start to the latest span end (ms). */
  durationMs: number;
  startedAt: number;
  /** True if any span in the trace is an error (status ≥ 400). */
  hasError: boolean;
}

export interface ListTracesOpts {
  tenantId: string | null;
  /** Max traces to return (after grouping). */
  limit: number;
  /** Only traces whose root started at/after this epoch-ms. */
  from?: number;
  /** Substring match on path. */
  path?: string;
  /** Only traces whose root status is ≥ this (e.g. 400 for errors). */
  minStatus?: number;
}

/**
 * Recent traces, newest first. Spans are grouped in memory (most traces are a
 * single request span; multi-span traces appear when a function calls back into
 * the API with the propagated `traceparent`). Dialect-agnostic.
 */
export const listTraces = async (
  ctx: DbCtx,
  opts: ListTracesOpts,
): Promise<{ traces: TraceSummary[] }> => {
  const t = tableFor(ctx.dialect);
  const conds = [] as any[];
  if (opts.tenantId !== null) conds.push(eq(t.tenantId, opts.tenantId));
  if (opts.from) conds.push(gte(t.startedAt, new Date(opts.from)));
  const where = conds.length ? and(...conds) : undefined;

  // Over-fetch spans so grouping yields enough whole traces, then slice.
  const rows: SpanRow[] = (
    await (ctx.db as any)
      .select()
      .from(t)
      .where(where)
      .orderBy(desc(t.startedAt))
      .limit(Math.min(2000, Math.max(opts.limit * 5, opts.limit)))
  ).map(toRow);

  const byTrace = new Map<string, SpanRow[]>();
  for (const r of rows) {
    const list = byTrace.get(r.traceId);
    if (list) list.push(r);
    else byTrace.set(r.traceId, [r]);
  }

  const summaries: TraceSummary[] = [];
  for (const [traceId, spans] of byTrace) {
    const root =
      spans.find((s) => s.parentSpanId === null) ??
      [...spans].sort((a, b) => a.startedAt - b.startedAt)[0];
    if (!root) continue;
    const start = Math.min(...spans.map((s) => s.startedAt));
    const end = Math.max(...spans.map((s) => s.startedAt + (s.durationMs ?? 0)));
    const summary: TraceSummary = {
      traceId,
      name: root.name,
      rootStatus: root.status,
      spanCount: spans.length,
      durationMs: end - start,
      startedAt: start,
      hasError: spans.some((s) => (s.status ?? 0) >= 400),
    };
    if (opts.path && !(summary.name.includes(opts.path))) continue;
    if (opts.minStatus && (summary.rootStatus ?? 0) < opts.minStatus) continue;
    summaries.push(summary);
  }

  summaries.sort((a, b) => b.startedAt - a.startedAt);
  return { traces: summaries.slice(0, opts.limit) };
};

/** Every span of one trace, ordered for a waterfall (earliest first). */
export const getTrace = async (
  ctx: DbCtx,
  traceId: string,
  tenantId: string | null,
): Promise<{ spans: SpanRow[] }> => {
  const t = tableFor(ctx.dialect);
  const conds = [eq(t.traceId, traceId)] as any[];
  if (tenantId !== null) conds.push(eq(t.tenantId, tenantId));
  const rows: SpanRow[] = (
    await (ctx.db as any)
      .select()
      .from(t)
      .where(and(...conds))
      .orderBy(t.startedAt)
  ).map(toRow);
  return { spans: rows };
};

/**
 * Deletes span rows older than `retentionDays`. A retention of `0` (or
 * negative) disables pruning. Called from `cronTick` once per day.
 */
export const pruneOldSpans = async (
  ctx: DbCtx,
  retentionDays: number,
): Promise<{ cutoff: Date; ok: boolean }> => {
  const days = Math.floor(retentionDays);
  if (!Number.isFinite(days) || days <= 0) return { cutoff: new Date(0), ok: false };
  const t = tableFor(ctx.dialect);
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  try {
    await (ctx.db as any).delete(t).where(lt(t.createdAt, cutoff));
    return { cutoff, ok: true };
  } catch (e) {
    console.error("[traces] prune failed", e);
    return { cutoff, ok: false };
  }
};
