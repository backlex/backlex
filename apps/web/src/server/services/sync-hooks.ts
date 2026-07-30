/**
 * Synchronous hooks — letting an external service participate in a write.
 *
 * Every extension point backlex had until now runs AFTER the fact: outbound
 * webhooks, flows and extension event hooks all fire from `publishEvent`, by
 * which time the row is already committed. That is why every integration has to
 * be written by us: nothing outside the process can validate, enrich, price or
 * tax a request while it still matters. Saleor solves this with sync webhooks
 * and Shopify with Functions; this is the equivalent.
 *
 * A hook receives the pending write and answers:
 *
 *   { "allow": true,  "data": { ...patch } }   // proceed, optionally patched
 *   { "allow": false, "reason": "why" }        // reject the write
 *
 * ## The load-bearing decisions
 *
 * **It is on the request path.** A slow app must degrade the write, not hang
 * it: every call is bounded by `timeoutMs` (default 2s, hard max 10s) via an
 * AbortController, and the total across hooks is bounded too.
 *
 * **`onError` has no default.** When a hook cannot answer, `allow` silently
 * drops the guarantee it exists to provide, and `deny` converts the app's
 * outage into yours. Neither is safe to assume, so the operator must choose.
 *
 * **Mutation is opt-in.** A hook registered to validate must not be able to
 * rewrite rows, so a `data` patch is ignored unless `canMutate`.
 *
 * **Hooks run sequentially**, ordered by priority then age, each seeing the
 * previous patch. Running them in parallel would make two hooks patching the
 * same field a coin flip.
 *
 * **Internal writes skip hooks entirely** (restore, seed, template apply, bulk
 * import, and any write made from inside a hook-driven request). Otherwise a
 * restore fires thousands of blocking HTTP calls, and a hook that writes back
 * into backlex re-triggers itself.
 */
import { and, asc, eq, isNull, or } from "drizzle-orm";
import { AppError } from "@backlex/core";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { Ctx } from "../context";
import { fetchOutbound } from "./storage/hosts";

type AnyDb = any;

const tableFor = (dialect: "pg" | "sqlite") =>
  (dialect === "pg" ? pg.schema.syncHooks : sqlite.schema.syncHooks) as typeof pg.schema.syncHooks;

/** Ceiling on a single hook, and on all hooks for one write combined. */
export const MAX_HOOK_TIMEOUT_MS = 10_000;
export const MAX_TOTAL_HOOK_MS = 15_000;
/** Consecutive failures that trip the breaker, matching webhooks. */
export const HOOK_AUTODISABLE_THRESHOLD = 15;

export type SyncHookPhase = "beforeCreate" | "beforeUpdate" | "beforeDelete";
export type OnHookError = "allow" | "deny";

export interface SyncHookRow {
  id: string;
  tenantId: string | null;
  name: string;
  url: string;
  secret: string | null;
  events: string[];
  headers: Record<string, string> | null;
  timeoutMs: number;
  onError: string;
  canMutate: boolean | number;
  priority: number;
  enabled: boolean | number;
  consecutiveFailures: number;
  lastFailureAt: Date | number | null;
  disabledReason: string | null;
  createdAt: Date | number | null;
  updatedAt: Date | number | null;
}

export const toPublic = (row: SyncHookRow) => ({
  id: row.id,
  name: row.name,
  url: row.url,
  events: row.events,
  headers: row.headers,
  timeoutMs: row.timeoutMs,
  onError: row.onError as OnHookError,
  canMutate: Boolean(row.canMutate),
  priority: row.priority,
  enabled: Boolean(row.enabled),
  /** Presence only — the signing secret has no read-back path. */
  hasSecret: Boolean(row.secret),
  consecutiveFailures: row.consecutiveFailures ?? 0,
  lastFailureAt: row.lastFailureAt ?? null,
  disabledReason: row.disabledReason ?? null,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

/**
 * Does `pattern` select `<collection>.<phase>`?
 *
 * Supports the exact name, `*` (everything), `<collection>.*` (any phase of one
 * collection) and `*.<phase>` (one phase of every collection). Deliberately
 * narrow: a hook is on the write path, so a pattern language with surprises in
 * it is a way to accidentally block every write in the workspace.
 */
export const matchesHookEvent = (
  pattern: string,
  collection: string,
  phase: SyncHookPhase,
): boolean => {
  const target = `${collection}.${phase}`;
  if (pattern === target || pattern === "*") return true;
  if (pattern === `${collection}.*`) return true;
  if (pattern === `*.${phase}`) return true;
  return false;
};

/**
 * Enabled hooks for this workspace that match the event, in execution order.
 *
 * SECURITY REQUIREMENT for whoever adds the admin routes: a hook with
 * `tenant_id = NULL` is INSTANCE-WIDE and receives the pending row data of
 * every workspace on the instance. Creating one must be restricted to the
 * instance operator — a workspace admin who could set `tenantId: null` would
 * have a read channel into every other workspace's writes.
 */
export async function loadHooksFor(
  ctx: Ctx,
  tenantId: string | null,
  collection: string,
  phase: SyncHookPhase,
): Promise<SyncHookRow[]> {
  const t = tableFor(ctx.dialect);
  let rows: SyncHookRow[];
  try {
    rows = (await (ctx.db as AnyDb)
      .select()
      .from(t)
      .where(
        and(
          eq(t.enabled, true),
          // A hook with no tenant is instance-wide; a tenant's own hooks apply
          // on top. Scoping by `= tenantId` alone would silently drop the
          // instance-wide ones.
          tenantId ? or(eq(t.tenantId, tenantId), isNull(t.tenantId)) : isNull(t.tenantId),
        ),
      )
      .orderBy(asc(t.priority), asc(t.createdAt))) as SyncHookRow[];
  } catch {
    // Table not migrated yet — behave as "no hooks configured" rather than
    // failing every write on the instance.
    return [];
  }
  return rows.filter((h) =>
    (h.events ?? []).some((p) => matchesHookEvent(p, collection, phase)),
  );
}

export interface HookRequest {
  collection: string;
  phase: SyncHookPhase;
  /** Row id — null on create, since it does not exist yet. */
  id: string | null;
  /** The pending payload. On delete this is the row being removed. */
  data: Record<string, unknown>;
  actor: { userId: string | null; email: string | null; roles: string[] };
}

export interface HookVerdict {
  allow: boolean;
  reason?: string;
  data?: Record<string, unknown>;
}

const hmacHex = async (secret: string, message: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
};

/** Call one hook. Never throws — a transport problem becomes `ok: false`. */
export async function callHook(
  ctx: Ctx,
  hook: SyncHookRow,
  req: HookRequest,
): Promise<{ ok: boolean; verdict?: HookVerdict; error?: string; ms: number }> {
  const started = Date.now();
  const body = JSON.stringify({
    event: `${req.collection}.${req.phase}`,
    collection: req.collection,
    phase: req.phase,
    id: req.id,
    data: req.data,
    actor: req.actor,
    at: new Date().toISOString(),
  });

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-backlex-event": `${req.collection}.${req.phase}`,
    ...(hook.headers ?? {}),
  };
  if (hook.secret) {
    // Same replay-safe scheme as outbound webhooks: the timestamp travels in
    // its own header and is inside the signed string, so an app can reject a
    // stale call without parsing the signature. Set last so a custom header
    // can never override the signing headers.
    const ts = Math.floor(Date.now() / 1000).toString();
    headers["x-backlex-timestamp"] = ts;
    headers["x-backlex-signature"] = await hmacHex(hook.secret, `${ts}.${body}`);
  }

  const budget = Math.min(Math.max(hook.timeoutMs || 2000, 50), MAX_HOOK_TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budget);
  try {
    const res = await fetchOutbound(ctx.env, hook.url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, ms: Date.now() - started };
    const parsed = (await res.json().catch(() => null)) as HookVerdict | null;
    if (!parsed || typeof parsed.allow !== "boolean") {
      // A hook that answers 200 with a body we cannot read is NOT an approval:
      // treating it as one would let a broken app quietly disable itself.
      return { ok: false, error: "malformed_verdict", ms: Date.now() - started };
    }
    return { ok: true, verdict: parsed, ms: Date.now() - started };
  } catch (e) {
    const aborted = (e as Error)?.name === "AbortError";
    return {
      ok: false,
      error: aborted ? `timeout after ${budget}ms` : ((e as Error)?.message ?? "fetch_failed"),
      ms: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Fold one outcome into the breaker. Best-effort; never throws into a write. */
async function applyOutcome(ctx: Ctx, hook: SyncHookRow, ok: boolean, detail: string) {
  const t = tableFor(ctx.dialect);
  const now = new Date();
  const prior = hook.consecutiveFailures ?? 0;
  try {
    if (ok) {
      if (prior > 0) {
        await (ctx.db as AnyDb)
          .update(t)
          .set({ consecutiveFailures: 0, lastFailureAt: null, disabledReason: null, updatedAt: now })
          .where(eq(t.id, hook.id));
      }
      return;
    }
    const next = prior + 1;
    if (next >= HOOK_AUTODISABLE_THRESHOLD) {
      await (ctx.db as AnyDb)
        .update(t)
        .set({
          enabled: false,
          consecutiveFailures: next,
          lastFailureAt: now,
          disabledReason: `Auto-disabled after ${next} consecutive failures (last: ${detail})`,
          updatedAt: now,
        })
        .where(eq(t.id, hook.id));
    } else {
      await (ctx.db as AnyDb)
        .update(t)
        .set({ consecutiveFailures: next, lastFailureAt: now, updatedAt: now })
        .where(eq(t.id, hook.id));
    }
  } catch (e) {
    console.error("[sync-hook] breaker update failed", e);
  }
}

export interface RunHooksResult {
  /** The payload after any applied patches. */
  data: Record<string, unknown>;
  /** Names of the hooks that actually ran. */
  ran: string[];
}

/**
 * Run every matching hook for a pending write.
 *
 * Throws `AppError("FORBIDDEN")` when a hook rejects, or when one fails and its
 * `onError` is `deny` — that is the whole point of the feature, so the write
 * must not proceed. Returns the (possibly patched) payload otherwise.
 */
export async function runSyncHooks(
  ctx: Ctx,
  input: {
    tenantId: string | null;
    collection: string;
    phase: SyncHookPhase;
    id: string | null;
    data: Record<string, unknown>;
    actor?: { userId: string | null; email: string | null; roles: string[] };
  },
): Promise<RunHooksResult> {
  const hooks = await loadHooksFor(ctx, input.tenantId, input.collection, input.phase);
  if (hooks.length === 0) return { data: input.data, ran: [] };

  const actor = input.actor ?? { userId: null, email: null, roles: [] };
  let data = input.data;
  const ran: string[] = [];
  const deadline = Date.now() + MAX_TOTAL_HOOK_MS;

  for (const hook of hooks) {
    if (Date.now() >= deadline) {
      // The per-hook timeout bounds one call; this bounds the chain, so a long
      // list of slow-but-not-timing-out hooks cannot add up to a hung request.
      // 503, not 500: the write did not fail, a dependency was too slow to
      // let it proceed — and a retry may well succeed.
      throw new AppError(
        "UNAVAILABLE",
        `Sync hooks exceeded the ${MAX_TOTAL_HOOK_MS}ms total budget for ${input.collection}.${input.phase}`,
      );
    }

    const out = await callHook(ctx, hook, {
      collection: input.collection,
      phase: input.phase,
      id: input.id,
      data,
      actor,
    });
    void applyOutcome(ctx, hook, out.ok, out.error ?? "ok");

    if (!out.ok) {
      if ((hook.onError as OnHookError) === "deny") {
        throw new AppError(
          "FORBIDDEN",
          `Write blocked: hook "${hook.name}" could not be reached (${out.error})`,
        );
      }
      // `allow`: the operator accepted this failure mode explicitly.
      console.warn(`[sync-hook] ${hook.name} failed open: ${out.error}`);
      continue;
    }

    ran.push(hook.name);
    const verdict = out.verdict!;
    if (!verdict.allow) {
      throw new AppError(
        "FORBIDDEN",
        verdict.reason?.slice(0, 500) || `Write rejected by hook "${hook.name}"`,
      );
    }
    if (verdict.data && Boolean(hook.canMutate)) {
      // Shallow merge: a hook patches fields, it does not replace the row.
      // Deep-merging would make it impossible to clear a nested value.
      data = { ...data, ...verdict.data };
    }
  }

  return { data, ran };
}

/* ───────────────────────── admin CRUD ───────────────────────── */

export interface SyncHookInput {
  name: string;
  url: string;
  events: string[];
  onError: OnHookError;
  secret?: string | null;
  headers?: Record<string, string> | null;
  timeoutMs?: number;
  canMutate?: boolean;
  priority?: number;
  enabled?: boolean;
}

/**
 * `tenantId` is a required `string`, never nullable — that is the enforcement
 * of the instance-wide rule stated on `loadHooksFor`. A route derives it from
 * the session, so an API caller has no way to express `tenant_id = NULL` and
 * therefore no way to create a hook that sees other workspaces' writes. Making
 * it unrepresentable beats a check somebody can forget.
 */
export async function createSyncHook(
  ctx: Ctx,
  tenantId: string,
  input: SyncHookInput,
): Promise<ReturnType<typeof toPublic>> {
  const t = tableFor(ctx.dialect);
  const id = crypto.randomUUID();
  await (ctx.db as AnyDb).insert(t).values({
    id,
    tenantId,
    name: input.name,
    url: input.url,
    events: input.events,
    onError: input.onError,
    secret: input.secret ?? null,
    headers: input.headers ?? null,
    timeoutMs: Math.min(Math.max(input.timeoutMs ?? 2000, 50), MAX_HOOK_TIMEOUT_MS),
    canMutate: input.canMutate ?? false,
    priority: input.priority ?? 0,
    enabled: input.enabled ?? true,
  });
  const [row] = (await (ctx.db as AnyDb).select().from(t).where(eq(t.id, id))) as SyncHookRow[];
  if (!row) throw new AppError("INTERNAL", "sync_hooks row missing after insert");
  return toPublic(row);
}

export async function listSyncHooks(ctx: Ctx, tenantId: string) {
  const t = tableFor(ctx.dialect);
  try {
    const rows = (await (ctx.db as AnyDb)
      .select()
      .from(t)
      .where(eq(t.tenantId, tenantId))
      .orderBy(asc(t.priority), asc(t.createdAt))) as SyncHookRow[];
    return rows.map(toPublic);
  } catch {
    return [];
  }
}

export async function updateSyncHook(
  ctx: Ctx,
  tenantId: string,
  id: string,
  patch: Partial<SyncHookInput>,
): Promise<ReturnType<typeof toPublic>> {
  const t = tableFor(ctx.dialect);
  const db = ctx.db as AnyDb;
  const set: Record<string, unknown> = { updatedAt: new Date() };
  for (const k of ["name", "url", "events", "onError", "headers", "canMutate", "priority"] as const) {
    if (patch[k] !== undefined) set[k] = patch[k];
  }
  // An empty/absent secret keeps the stored one: the UI cannot read it back, so
  // a blank field must not blank the credential.
  if (patch.secret?.trim()) set.secret = patch.secret.trim();
  if (patch.timeoutMs !== undefined) {
    set.timeoutMs = Math.min(Math.max(patch.timeoutMs, 50), MAX_HOOK_TIMEOUT_MS);
  }
  if (patch.enabled !== undefined) {
    set.enabled = patch.enabled;
    // Re-enabling by hand clears the breaker, or it would trip again instantly.
    if (patch.enabled) {
      set.consecutiveFailures = 0;
      set.lastFailureAt = null;
      set.disabledReason = null;
    }
  }
  await db.update(t).set(set).where(and(eq(t.tenantId, tenantId), eq(t.id, id)));
  const [row] = (await db
    .select()
    .from(t)
    .where(and(eq(t.tenantId, tenantId), eq(t.id, id)))) as SyncHookRow[];
  if (!row) throw new AppError("NOT_FOUND", "Sync hook not found");
  return toPublic(row);
}

export async function deleteSyncHook(ctx: Ctx, tenantId: string, id: string): Promise<void> {
  const t = tableFor(ctx.dialect);
  await (ctx.db as AnyDb).delete(t).where(and(eq(t.tenantId, tenantId), eq(t.id, id)));
}

/**
 * Fire one test call with a synthetic payload and report what came back —
 * without it, the only way to find out a hook is misconfigured is a blocked
 * write in production.
 */
export async function testSyncHook(
  ctx: Ctx,
  tenantId: string,
  id: string,
): Promise<{ ok: boolean; verdict?: HookVerdict; error?: string; ms: number }> {
  const t = tableFor(ctx.dialect);
  const [row] = (await (ctx.db as AnyDb)
    .select()
    .from(t)
    .where(and(eq(t.tenantId, tenantId), eq(t.id, id)))) as SyncHookRow[];
  if (!row) throw new AppError("NOT_FOUND", "Sync hook not found");
  return callHook(ctx, row, {
    collection: "__test__",
    phase: "beforeCreate",
    id: null,
    data: { __backlex_test: true },
    actor: { userId: null, email: null, roles: [] },
  });
}
