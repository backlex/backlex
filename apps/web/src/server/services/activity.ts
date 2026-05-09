import * as pg from "@workeros/db/pg";
import * as sqlite from "@workeros/db/sqlite";
import type { DbCtx } from "./seed";

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.activity : sqlite.schema.activity;

export interface ActivityInput {
  userId: string | null;
  tenantId?: string | null;
  action: string;
  collection: string;
  itemId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  payload?: unknown;
  /** Optional millisecond-precision duration for the request that produced
   *  this row. Populated by route handlers via `Date.now() - start` so the
   *  metrics endpoint can compute p95 latency without a separate pipeline. */
  durationMs?: number | null;
}

export const recordActivity = async (
  ctx: DbCtx,
  input: ActivityInput,
): Promise<void> => {
  const t = tableFor(ctx.dialect);
  try {
    await (ctx.db as any).insert(t).values({
      id: crypto.randomUUID(),
      tenantId: input.tenantId ?? null,
      userId: input.userId,
      action: input.action,
      collection: input.collection,
      itemId: input.itemId ?? null,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      payload: input.payload ?? null,
      durationMs: input.durationMs ?? null,
    });
  } catch (e) {
    console.error("[activity] failed to record", e);
  }
};

export const requestMeta = (req: Request): { ip: string | null; userAgent: string | null } => {
  const ua = req.headers.get("user-agent");
  const ip =
    req.headers.get("cf-connecting-ip") ??
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    null;
  return { ip, userAgent: ua };
};

/**
 * Tries to register the promise with the Worker's ExecutionContext so the
 * isolate stays alive until our fire-and-forget activity insert finishes.
 * On environments where executionCtx is not exposed (Bun, plain Node, some
 * Hono adapters) we just attach a no-op catch and let the promise run.
 */
export const keepAlive = (
  c: { executionCtx?: { waitUntil?: (p: Promise<unknown>) => void } },
  p: Promise<unknown>,
): void => {
  try {
    c.executionCtx?.waitUntil?.(p);
  } catch {
    // executionCtx getter throws on non-Workers runtimes — just await later.
  }
  void p.catch(() => {});
};

/**
 * Reads the per-request timestamp that `tenantMiddleware` stamped onto
 * the Hono context via `c.set("__startedAt", …)` and returns elapsed ms.
 * Pass `c` itself (the Hono Context) — we narrow it to the get method.
 */
export const elapsedMs = (
  c: { get: (k: string) => unknown } | Record<string, unknown>,
): number => {
  const t0 =
    typeof (c as { get?: unknown }).get === "function"
      ? (c as { get: (k: string) => unknown }).get("__startedAt")
      : (c as Record<string, unknown>).__startedAt;
  if (typeof t0 !== "number") return 0;
  return Date.now() - t0;
};

/**
 * Convenience wrapper — pulls db/auth/duration/meta from a Hono Context
 * so route handlers can log an activity in one line:
 *
 *   await logActivity(c, { action: "create", collection: "files", itemId: key });
 *
 * Anything not specified inline is inferred from the context.
 */
export const logActivity = async (
  c: any,
  input: {
    action: string;
    collection: string;
    itemId?: string | null;
    payload?: unknown;
  },
): Promise<void> => {
  const ctx = c.get("ctx");
  const auth = c.get("auth");
  const meta = requestMeta(c.req.raw);
  await recordActivity(
    { db: ctx.db, dialect: ctx.dialect },
    {
      userId: auth?.userId ?? null,
      tenantId: auth?.tenantId ?? null,
      action: input.action,
      collection: input.collection,
      itemId: input.itemId ?? null,
      ...meta,
      payload: input.payload ?? null,
      durationMs: elapsedMs(c),
    },
  );
};
