import { and, like, lt } from "drizzle-orm";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { DbCtx } from "./seed";

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.activity : sqlite.schema.activity;

// Maps a system collection to its activity-log category. Anything not in
// this table (i.e. a user-defined collection slug) falls under "item".
// Categories are the prefixes the admin UI's chip filter expects, so the
// chip counts only line up if the action stored in the DB is namespaced.
const SYSTEM_COLLECTION_CATEGORY: Record<string, string> = {
  system_collections: "schema",
  system_webhooks: "webhook",
  system_flows: "flow",
  system_functions: "function",
  system_roles: "role",
  // A permission IS a role's grant, so it shares the `role` chip rather than
  // getting one of its own — an operator auditing authorization wants role
  // CRUD and the grants attached to those roles in the same filter. Without
  // an entry here a grant would fall through to `item.create` and be lost
  // among ordinary row writes, which is exactly what used to happen.
  system_permissions: "role",
  // Administering a person's access — suspend, invite, revoke sessions, reset
  // 2FA, remove from the workspace — is about who can get in, so it joins the
  // `auth` chip beside the sign-in events it explains.
  system_users: "auth",
  files: "storage",
};

const namespacedAction = (action: string, collection: string): string => {
  if (action.includes(".")) return action;
  const category = SYSTEM_COLLECTION_CATEGORY[collection] ?? "item";
  return `${category}.${action}`;
};

export interface ActivityInput {
  userId: string | null;
  tenantId?: string | null;
  action: string;
  collection: string;
  itemId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  payload?: unknown;
  /** Response body for the request that produced this row. Stored as JSON;
   *  redacted on write (see `redact`) so tokens/secrets never hit the audit
   *  log. Surfaced in the admin Activity modal alongside `payload`. */
  response?: unknown;
  /** Optional millisecond-precision duration for the request that produced
   *  this row. Populated by route handlers via `Date.now() - start` so the
   *  metrics endpoint can compute p95 latency without a separate pipeline. */
  durationMs?: number | null;
  /** The operator behind an impersonated request. `userId` stays the SUBJECT's
   *  — see the column's comment in the schema for why both are recorded. */
  impersonatedBy?: string | null;
}

/** Keys that should never reach the audit log verbatim. Match is
 *  case-insensitive and matches anywhere in the key — `client_secret`,
 *  `apiKey`, `x-auth-token`, etc. all hit the same redactor. */
const REDACT_PATTERN = /token|secret|password|api[-_]?key|authorization|cookie|session/i;

/** Walks a JSON-ish value and replaces redactable leaves with the marker
 *  string. Returns a new structure — never mutates input. Arrays and plain
 *  objects recurse; everything else (primitives, Dates, etc.) is returned
 *  as-is unless the parent key matched the pattern. */
export const redact = (value: unknown): unknown => {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((v) => redact(v));
  if (typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (REDACT_PATTERN.test(k)) {
      out[k] = "[redacted]";
      continue;
    }
    out[k] = redact(v);
  }
  return out;
};

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
      action: namespacedAction(input.action, input.collection),
      collection: input.collection,
      itemId: input.itemId ?? null,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      payload: input.payload === undefined ? null : redact(input.payload),
      response: input.response === undefined ? null : redact(input.response),
      durationMs: input.durationMs ?? null,
      impersonatedBy: input.impersonatedBy ?? null,
    });
  } catch (e) {
    console.error("[activity] failed to record", e);
  }
};

/**
 * Deletes activity rows older than `retentionDays`. A retention of `0` (or
 * negative) disables pruning. Called from `cronTick` once per day —
 * dialect-agnostic because `createdAt` is a Drizzle `Date` column on both
 * PG (native timestamp) and SQLite (`integer` ms).
 */
export const pruneOldActivity = async (
  ctx: DbCtx,
  retentionDays: number,
): Promise<{ cutoff: Date; ok: boolean }> => {
  const days = Math.floor(retentionDays);
  if (!Number.isFinite(days) || days <= 0) {
    return { cutoff: new Date(0), ok: false };
  }
  const t = tableFor(ctx.dialect);
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  try {
    await (ctx.db as any).delete(t).where(lt(t.createdAt, cutoff));
    return { cutoff, ok: true };
  } catch (e) {
    console.error("[activity] prune failed", e);
    return { cutoff, ok: false };
  }
};

/**
 * Deletes activity rows whose `action` starts with `prefix` (e.g. `"access."`)
 * and that are older than `retentionDays`. Used to trim the high-volume,
 * opt-in sensitive-read audit (`access.read`) on a shorter clock than the
 * global retention without touching mutation/error rows. A retention of `0`
 * (or negative) disables this prune. Called from `cronTick` once per day.
 */
export const pruneOldActivityByPrefix = async (
  ctx: DbCtx,
  retentionDays: number,
  prefix: string,
): Promise<{ cutoff: Date; ok: boolean }> => {
  const days = Math.floor(retentionDays);
  if (!Number.isFinite(days) || days <= 0) {
    return { cutoff: new Date(0), ok: false };
  }
  const t = tableFor(ctx.dialect);
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  try {
    await (ctx.db as any)
      .delete(t)
      .where(and(lt(t.createdAt, cutoff), like(t.action, `${prefix}%`)));
    return { cutoff, ok: true };
  } catch (e) {
    console.error("[activity] prefix prune failed", e);
    return { cutoff, ok: false };
  }
};

/**
 * The address and user-agent to record for a request — and, for the public
 * routes that key a limiter on it, the address that limiter buckets by.
 *
 * `env` is required rather than optional on purpose. Only the deployment knows
 * which header is entitled to state a client address (see
 * `lib/client-address.ts`), and making it a parameter is what forced every one
 * of the fifty call sites to be re-read rather than inheriting a default that
 * happens to be wrong on three of the four runtimes.
 */
import { type ClientAddressEnv, clientAddress } from "../lib/client-address";
export const requestMeta = (
  req: Request,
  env: ClientAddressEnv,
): { ip: string | null; userAgent: string | null } => ({
  ip: clientAddress(req, env),
  userAgent: req.headers.get("user-agent"),
});

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
 * {@link keepAlive} for the layers that hold a `Ctx` rather than a Hono
 * context — services, adapters, the event fan-out.
 *
 * `Ctx.waitUntil` is set by the request middleware and absent on cron ticks,
 * queue consumers and the test harness; there the promise simply floats, which
 * is what those runtimes did anyway. The rejection is swallowed here rather
 * than at each call site: this exists for work the caller has already decided
 * not to wait on, so a failure in it must not surface as an unhandled
 * rejection on the request that scheduled it. `label` names the subsystem in
 * that log line, because "something rejected" is not a debuggable sentence.
 */
export const keepAliveCtx = (
  ctx: { waitUntil?: (p: Promise<unknown>) => void },
  p: Promise<unknown>,
  label: string,
): void => {
  const guarded = p.catch((e) => {
    console.error(`[${label}] deferred work failed`, e);
  });
  if (ctx.waitUntil) ctx.waitUntil(guarded);
  else void guarded;
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
    response?: unknown;
  },
): Promise<void> => {
  const ctx = c.get("ctx");
  const auth = c.get("auth");
  const meta = requestMeta(c.req.raw, ctx.env);
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
      // An impersonated write is genuinely the SUBJECT's — that is what makes
      // it a faithful reproduction — so `userId` stays theirs and the operator
      // rides in its own column.
      impersonatedBy: auth?.impersonatedBy ?? null,
      response: input.response ?? null,
      durationMs: elapsedMs(c),
    },
  );
};
