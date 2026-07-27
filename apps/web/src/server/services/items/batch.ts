import type { SQL } from "drizzle-orm";
import { AppError, type AuthSubject } from "@backlex/core";
import type { Ctx } from "../../context";
import { resolvePermission, type PermResolveCache } from "../permissions";
import type { CollectionRow } from "./collection-loader";
import {
  performCreate,
  performUpdate,
  performDelete,
  type ResolvedPerm,
  type WriteEnv,
  type WriteResult,
} from "./write";

/** Max operations per batch — bounds the work a single call can queue. */
export const BATCH_MAX = 100;

export interface BatchOp {
  op: "create" | "update" | "delete";
  id?: string;
  data?: Record<string, unknown>;
  /** Optimistic-concurrency precondition for this op alone — the `updatedAt`
   *  the caller last saw. If the row has moved since, the op fails with
   *  `CONFLICT` instead of last-write-winning over someone else's edit. This is
   *  what lets an offline client flush a queue and be *told* which of its
   *  writes raced, rather than silently clobbering. */
  ifUnmodifiedSince?: string;
}

export interface BatchRowResult {
  index: number;
  op: string;
  ok: boolean;
  id?: string;
  data?: Record<string, unknown>;
  error?: { code: string; message: string; details?: unknown };
}

export interface BatchRunResult {
  atomic: boolean;
  total: number;
  succeeded: number;
  failed: number;
  results: BatchRowResult[];
}

export interface RunBatchParams {
  ctx: Ctx;
  auth: AuthSubject;
  collection: CollectionRow;
  operations: BatchOp[];
  atomic: boolean;
  meta: Record<string, unknown>;
  durationMs: () => number;
  locale: string | null;
}

/**
 * Shared batch orchestrator behind both the REST `…/batch` endpoint and the
 * GraphQL `batch<Collection>` mutation. Non-atomic mode returns a per-row
 * result (failures isolated); atomic mode prepares + validates every op, replays
 * the collected write statements in one transaction, and THROWS `AppError` on
 * the first failure (nothing committed) — callers surface it as the HTTP / GraphQL
 * error. See `docs/querying.md` for the runtime support matrix + the
 * no-intra-batch-read-after-write caveat.
 */
export const runBatch = async (params: RunBatchParams): Promise<BatchRunResult> => {
  const { ctx, auth, collection, operations: ops, atomic } = params;

  const permCache: PermResolveCache = new Map();
  const permFor = async (action: "create" | "update" | "delete"): Promise<ResolvedPerm> => {
    const p = await resolvePermission(ctx, auth, collection.slug, action, permCache);
    if (!p.allowed) throw new AppError("FORBIDDEN", `No ${action} permission on ${collection.slug}`);
    return { whereSql: p.whereSql, fields: p.fields };
  };

  const baseEnv = (collect?: SQL[]): WriteEnv => ({
    ctx,
    collection,
    userId: auth.userId,
    tenantId: auth.tenantId,
    roles: auth.roles,
    email: auth.email,
    meta: params.meta,
    durationMs: params.durationMs,
    locale: params.locale,
    collect,
  });

  const runOne = async (env: WriteEnv, op: BatchOp): Promise<WriteResult> => {
    const perm = await permFor(op.op);
    if (op.op === "create") return performCreate(env, { ...(op.data ?? {}) }, perm);
    if (op.op === "update") {
      if (!op.id) throw new AppError("VALIDATION", "update operation requires `id`");
      return performUpdate(
        env,
        op.id,
        { ...(op.data ?? {}) },
        perm,
        op.ifUnmodifiedSince !== undefined ? { ifUnmodifiedSince: op.ifUnmodifiedSince } : undefined,
      );
    }
    if (!op.id) throw new AppError("VALIDATION", "delete operation requires `id`");
    return performDelete(env, op.id, perm);
  };

  if (atomic) {
    if (!ctx.txCapable) {
      throw new AppError(
        "CONFLICT",
        "atomic batch is not supported on this runtime (D1 / libSQL / neon-http) — retry without `atomic`",
      );
    }
    const statements: SQL[] = [];
    const env = baseEnv(statements);
    const prepared: { op: string; result: WriteResult }[] = [];
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i]!;
      try {
        prepared.push({ op: op.op, result: await runOne(env, op) });
      } catch (e) {
        const code = e instanceof AppError ? e.code : "INTERNAL";
        const msg = e instanceof Error ? e.message : String(e);
        throw new AppError(code, `atomic batch aborted at operation #${i} (${op.op}): ${msg}`);
      }
    }
    if (statements.length > 0) {
      if (ctx.dialect === "pg") {
        await (ctx.db as any).transaction(async (tx: any) => {
          for (const s of statements) await tx.execute(s);
        });
      } else {
        (ctx.db as any).transaction((tx: any) => {
          for (const s of statements) tx.run(s);
        });
      }
    }
    for (const p of prepared) for (const fx of p.result.sideEffects) await fx();
    const results: BatchRowResult[] = prepared.map((p, i) => ({
      index: i,
      op: p.op,
      ok: true,
      id: p.result.id,
      data: p.result.data,
    }));
    return { atomic: true, total: ops.length, succeeded: results.length, failed: 0, results };
  }

  const results: BatchRowResult[] = [];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!;
    try {
      const res = await runOne(baseEnv(), op);
      for (const fx of res.sideEffects) await fx();
      results.push({ index: i, op: op.op, ok: true, id: res.id, data: res.data });
    } catch (e) {
      const error =
        e instanceof AppError
          ? {
              code: e.code,
              message: e.message,
              // A CONFLICT carries `currentUpdatedAt` — a sync client uses it to
              // rebase its queued write without a second round trip.
              ...(e.details !== undefined ? { details: e.details } : {}),
            }
          : { code: "INTERNAL", message: e instanceof Error ? e.message : String(e) };
      results.push({ index: i, op: op.op, ok: false, id: op.id, error });
    }
  }
  const succeeded = results.filter((r) => r.ok).length;
  return { atomic: false, total: ops.length, succeeded, failed: ops.length - succeeded, results };
};
