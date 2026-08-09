/**
 * Auth hooks — the app taking part in its own end-users' authentication.
 *
 * `sync-hooks` lets an external service participate in an item write; flow
 * triggers see item / cron / manual / webhook events. Neither can reach the
 * four moments that decide who an end-user *is*. Until now nothing could put
 * `plan`, `tenant` or `role` into an access token, veto a sign-up on the app's
 * own rules, react to a password check, or deliver an auth mail through the
 * app's own transport — the four extension points below.
 *
 * ## The load-bearing decisions
 *
 * **Workspace plane only.** These hooks fire for the `app_users` pool behind
 * `/api/t/<slug>/auth/*`. The platform plane is deliberately not hookable: on
 * managed cloud a workspace admin *is a customer*, and a hook there would let
 * one customer observe and veto the operator sign-ins of the instance they
 * live on. `tenant_id` is `NOT NULL` so the instance-wide row `sync_hooks`
 * allows has no spelling here at all.
 *
 * **One hook per (workspace, event).** Every event carries a different payload
 * and a different verdict, so a hook subscribed to several would have to
 * implement four contracts — and two hooks answering `custom-access-token`
 * would fight over the same claim. Chaining belongs in the app's endpoint.
 *
 * **`onError` has no default**, for the same reason it has none on sync hooks,
 * and the stakes are higher: a `custom-access-token` hook failing open mints a
 * token MISSING the claim a downstream authorizer reads, and an absent `plan`
 * claim is the shape most apps treat as "free tier" rather than "unknown".
 * `deny` means the auth action fails; `allow` means it proceeds without the
 * hook's answer.
 *
 * **Two target kinds.** `url` is an HTTPS endpoint called with the
 * [Standard Webhooks](https://www.standardwebhooks.com) header set, so an app
 * can verify us with an off-the-shelf library. `function` is a backlex
 * function run in the sandbox — no network hop, which is what makes
 * `custom-access-token` viable on the token mint path.
 *
 * **Reserved claims are dropped, never merged.** A `custom-access-token` hook
 * that could set `tid` would be a workspace-crossing privilege escalation, and
 * one that could set `exp` would be an unrevokable credential. The identity
 * claims are re-applied AFTER the hook's, so a collision cannot win.
 */
import { and, eq } from "drizzle-orm";
import { AppError } from "@backlex/core";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { PgDb } from "@backlex/db/pg";
import type { SqliteDb } from "@backlex/db/sqlite";
import type { Env } from "../env";
import { fetchOutbound } from "./storage/hosts";
import { signStandardWebhook } from "../lib/standard-webhooks";

type AnyDb = any;

/**
 * Enough of a `Ctx` to reach the DB and make an outbound call. Narrower than
 * `Ctx` on purpose: `provisionAppUser` and the better-auth closures both call
 * in from places that do not carry a full request context.
 *
 * Callers that DO hold a full `Ctx` pass it whole, because a function-target
 * hook is handed this object as its sandbox bindings — with the full context
 * it can reach `ctx.db` / `ctx.email` through the host bridge, and with the
 * slice those calls fail (which becomes a hook failure, so `onError` decides,
 * rather than anything unsafe).
 */
export interface AuthHookCtx {
  db: PgDb | SqliteDb;
  dialect: "pg" | "sqlite";
  env: Env;
}

const tableFor = (dialect: "pg" | "sqlite") =>
  (dialect === "pg" ? pg.schema.authHooks : sqlite.schema.authHooks) as typeof pg.schema.authHooks;

/** Ceiling on a single hook call. Lower than the sync-hook ceiling because an
 *  auth request has a person waiting on it with nothing else on screen. */
export const MAX_AUTH_HOOK_TIMEOUT_MS = 5_000;
export const DEFAULT_AUTH_HOOK_TIMEOUT_MS = 2_000;
/** Consecutive failures that trip the breaker, matching webhooks + sync hooks. */
export const AUTH_HOOK_AUTODISABLE_THRESHOLD = 15;
/** Serialized ceiling on the claims a `custom-access-token` hook may add. The
 *  token travels in an `Authorization` header on every request; a hook that
 *  attached a kilobyte of profile would make every request pay for it. */
export const MAX_CUSTOM_CLAIMS_BYTES = 2_048;

export const AUTH_HOOK_EVENTS = [
  "before-user-created",
  "custom-access-token",
  "password-verification",
  "send-email",
] as const;
export type AuthHookEvent = (typeof AUTH_HOOK_EVENTS)[number];

export const isAuthHookEvent = (v: unknown): v is AuthHookEvent =>
  typeof v === "string" && (AUTH_HOOK_EVENTS as readonly string[]).includes(v);

export type AuthHookTargetType = "url" | "function";
export type OnAuthHookError = "allow" | "deny";

/**
 * Claims a hook may never set. `sub`/`tid`/`sid`/`plane`/`typ` name the
 * identity the middleware trusts; `exp`/`iat`/`nbf` decide how long it lives;
 * `iss`/`aud`/`jti`/`kid`/`alg` are what an external verifier pins on. Every
 * one of them is a privilege boundary, so a hook-supplied value is DROPPED
 * rather than merged — and the identity claims are written over the top
 * afterwards, so even a gap in this list cannot become an escalation.
 */
export const RESERVED_TOKEN_CLAIMS = new Set([
  "sub",
  "tid",
  "sid",
  "plane",
  "typ",
  "iss",
  "aud",
  "exp",
  "iat",
  "nbf",
  "jti",
  "kid",
  "alg",
  "email",
  // Not JWT claims — object-model keys. `out["__proto__"] = x` on an object
  // literal REASSIGNS the prototype rather than adding a property, so a hook
  // returning one would silently lose its other claims (and hand a
  // caller-controlled object to everything that later reads the payload).
  "__proto__",
  "constructor",
  "prototype",
]);

export interface AuthHookRow {
  id: string;
  tenantId: string;
  event: string;
  targetType: string;
  url: string | null;
  functionName: string | null;
  secret: string | null;
  headers: Record<string, string> | null;
  timeoutMs: number;
  onError: string;
  enabled: boolean | number;
  consecutiveFailures: number;
  lastFailureAt: Date | number | null;
  disabledReason: string | null;
  createdAt: Date | number | null;
  updatedAt: Date | number | null;
}

export const toPublic = (row: AuthHookRow) => ({
  id: row.id,
  event: row.event as AuthHookEvent,
  targetType: row.targetType as AuthHookTargetType,
  url: row.url,
  functionName: row.functionName,
  headers: row.headers,
  timeoutMs: row.timeoutMs,
  onError: row.onError as OnAuthHookError,
  enabled: Boolean(row.enabled),
  /** Presence only — the signing secret has no read-back path. */
  hasSecret: Boolean(row.secret),
  consecutiveFailures: row.consecutiveFailures ?? 0,
  lastFailureAt: row.lastFailureAt ?? null,
  disabledReason: row.disabledReason ?? null,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export type AuthHookPublic = ReturnType<typeof toPublic>;

/**
 * The enabled hook for one workspace + event, or null.
 *
 * A missing table (an instance that has not run the migration) reads as "no
 * hook configured" rather than failing every sign-in on the instance — the
 * same degradation `loadHooksFor` chose for sync hooks, and far more important
 * here because the failure would lock everyone out.
 */
export async function loadAuthHook(
  ctx: AuthHookCtx,
  tenantId: string | null,
  event: AuthHookEvent,
): Promise<AuthHookRow | null> {
  if (!tenantId) return null;
  const t = tableFor(ctx.dialect);
  try {
    const rows = (await (ctx.db as AnyDb)
      .select()
      .from(t)
      .where(and(eq(t.tenantId, tenantId), eq(t.event, event), eq(t.enabled, true)))
      .limit(1)) as AuthHookRow[];
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

/* ───────────────────────── payloads + verdicts ───────────────────────── */

export interface BeforeUserCreatedPayload {
  email: string;
  name?: string | null;
  /** How this person arrived: the better-auth sign-up paths report
   *  `"password"`, federated provisioning reports its provider type. */
  via: "password" | "saml" | "ldap" | "jwt";
  /** IdP-side subject for the federated paths; null for a local sign-up. */
  subject?: string | null;
}

export interface CustomAccessTokenPayload {
  userId: string;
  email: string | null;
  sessionId: string;
  roles: string[];
}

/** The part of a `custom-access-token` payload the caller always has to hand.
 *  `roles` needs a lookup, so it is resolved separately and only once a hook is
 *  known to exist — see {@link runCustomAccessTokenHook}. */
export type CustomAccessTokenIdentity = Omit<CustomAccessTokenPayload, "roles">;

export interface PasswordVerificationPayload {
  email: string;
  /** Whether the password itself checked out. `false` arrives too, so an app
   *  can run its own lockout / alerting on failures it would never otherwise
   *  hear about. */
  valid: boolean;
  ip: string | null;
  userAgent: string | null;
}

export interface SendEmailPayload {
  /** Which auth mail this is, so the app can render its own template rather
   *  than re-sending ours. */
  type: "magic-link" | "email-otp";
  to: string;
  /** Present for `magic-link` — the URL the person must open. */
  url?: string;
  /** Present for `email-otp` — the code they must type. */
  otp?: string;
}

export type AuthHookPayload =
  | BeforeUserCreatedPayload
  | CustomAccessTokenPayload
  | PasswordVerificationPayload
  | SendEmailPayload;

/** What a hook answered with. Which fields matter depends on the event; a
 *  field an event does not read is ignored rather than rejected, so an app can
 *  point one endpoint at several events. */
export interface AuthHookVerdict {
  /** `before-user-created`, `password-verification`. */
  allow?: boolean;
  reason?: string;
  /** `custom-access-token`. */
  claims?: Record<string, unknown>;
  /** `send-email` — true when the hook delivered the message itself. */
  handled?: boolean;
}

export interface AuthHookOutcome {
  ok: boolean;
  verdict?: AuthHookVerdict;
  error?: string;
  ms: number;
}

/* ───────────────────────── invocation ───────────────────────── */

/**
 * Call one hook's URL target. Never throws — a transport problem becomes
 * `ok: false` so the caller applies `onError` rather than 500-ing an auth
 * request.
 */
const callUrlTarget = async (
  ctx: AuthHookCtx,
  hook: AuthHookRow,
  event: AuthHookEvent,
  payload: AuthHookPayload,
  budgetMs: number,
): Promise<AuthHookOutcome> => {
  const started = Date.now();
  const body = JSON.stringify({
    event,
    at: new Date().toISOString(),
    tenantId: hook.tenantId,
    data: payload,
  });

  // Standard Webhooks, not our own `x-backlex-signature` scheme. An auth hook
  // is the first thing an app integrating with us implements, and every
  // language already has a verifier for this header set — the ecosystem fit is
  // worth carrying a second scheme. Set AFTER the custom headers so a
  // hand-configured header can never override the signing ones.
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-backlex-event": event,
    ...(hook.headers ?? {}),
  };
  if (hook.secret) {
    Object.assign(headers, await signStandardWebhook(hook.secret, body));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs);
  try {
    const res = await fetchOutbound(ctx.env, hook.url ?? "", {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, ms: Date.now() - started };
    // A 204 (or an empty 200) is a valid "nothing to say" for the events whose
    // verdict is optional — `send-email` is the one that means it.
    const text = await res.text();
    if (!text.trim()) return { ok: true, verdict: {}, ms: Date.now() - started };
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, error: "malformed_verdict", ms: Date.now() - started };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: "malformed_verdict", ms: Date.now() - started };
    }
    return { ok: true, verdict: parsed as AuthHookVerdict, ms: Date.now() - started };
  } catch (e) {
    const aborted = (e as Error)?.name === "AbortError";
    return {
      ok: false,
      error: aborted ? `timeout after ${budgetMs}ms` : ((e as Error)?.message ?? "fetch_failed"),
      ms: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Call one hook's function target — a backlex function, run in the sandbox
 * with the payload as `ctx.data`; its return value is the verdict.
 *
 * The sandbox modules are dynamically imported so the QuickJS-WASM blob stays
 * out of the auth path's cold start for the (vast majority of) instances that
 * have no function-target hook.
 */
const callFunctionTarget = async (
  ctx: AuthHookCtx,
  hook: AuthHookRow,
  payload: AuthHookPayload,
  budgetMs: number,
): Promise<AuthHookOutcome> => {
  const started = Date.now();
  const name = hook.functionName ?? "";
  try {
    const [{ findByName }, { runFunction }] = await Promise.all([
      import("./functions"),
      import("./sandbox"),
    ]);
    const fn = await findByName({ db: ctx.db, dialect: ctx.dialect }, hook.tenantId, name);
    if (!fn) return { ok: false, error: `function "${name}" not found`, ms: Date.now() - started };
    if (!fn.active) return { ok: false, error: `function "${name}" is inactive`, ms: Date.now() - started };
    const result = await runFunction(
      fn.code,
      {
        // The sandbox wants a full Ctx; an auth hook runs before there is a
        // caller identity to speak of, so the subject carries the workspace
        // and nothing else. A function that reaches for `ctx.db` therefore has
        // no elevated read — it is the workspace's own function either way.
        ctx: ctx as never,
        auth: { plane: "app", userId: null, email: null, roles: [], tenantId: hook.tenantId },
      },
      payload,
      budgetMs,
    );
    if (!result.ok) {
      return { ok: false, error: result.error ?? "function_error", ms: Date.now() - started };
    }
    const value = result.value;
    if (value === undefined || value === null) {
      return { ok: true, verdict: {}, ms: Date.now() - started };
    }
    if (typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, error: "malformed_verdict", ms: Date.now() - started };
    }
    return { ok: true, verdict: value as AuthHookVerdict, ms: Date.now() - started };
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? "function_failed", ms: Date.now() - started };
  }
};

/** Fold one outcome into the breaker. Best-effort; never throws into an auth
 *  request. */
async function applyOutcome(
  ctx: AuthHookCtx,
  hook: AuthHookRow,
  ok: boolean,
  detail: string,
): Promise<void> {
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
    if (next >= AUTH_HOOK_AUTODISABLE_THRESHOLD) {
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
    console.error("[auth-hook] breaker update failed", e);
  }
}

/** Invoke a hook row against a payload, folding the outcome into the breaker.
 *  Never throws. Exported for the admin test endpoint, which passes
 *  `countOutcome: false` so a probe cannot trip (or clear) the breaker. */
export async function invokeAuthHook(
  ctx: AuthHookCtx,
  hook: AuthHookRow,
  event: AuthHookEvent,
  payload: AuthHookPayload,
  opts: { countOutcome?: boolean } = {},
): Promise<AuthHookOutcome> {
  const budget = Math.min(
    Math.max(hook.timeoutMs || DEFAULT_AUTH_HOOK_TIMEOUT_MS, 50),
    MAX_AUTH_HOOK_TIMEOUT_MS,
  );
  const out =
    hook.targetType === "function"
      ? await callFunctionTarget(ctx, hook, payload, budget)
      : await callUrlTarget(ctx, hook, event, payload, budget);
  if (opts.countOutcome !== false) void applyOutcome(ctx, hook, out.ok, out.error ?? "ok");
  return out;
}

/**
 * Resolve + invoke the hook for one event, returning the verdict or `null`
 * when no hook is configured.
 *
 * Throws `AppError` when the hook refuses to answer and its `onError` is
 * `deny` — that is the whole point of the setting, so the auth action must not
 * proceed. Every event-level helper below funnels through here so the failure
 * policy is applied in exactly one place.
 */
async function askHook(
  ctx: AuthHookCtx,
  hook: AuthHookRow,
  event: AuthHookEvent,
  payload: AuthHookPayload,
): Promise<AuthHookVerdict | null> {
  const out = await invokeAuthHook(ctx, hook, event, payload);
  if (out.ok) return out.verdict ?? {};
  if ((hook.onError as OnAuthHookError) === "deny") {
    // The transport detail goes to the LOG, never into the message. These
    // refusals surface to an UNAUTHENTICATED caller — a stranger attempting a
    // sign-up or a sign-in — and `out.error` carries whatever the runtime's
    // fetch said, which on a blocked or unreachable host names that host. A
    // workspace's internal hook endpoint is not something a sign-up form
    // should print. The admin `test` endpoint reports the detail in full;
    // that one is admin-only.
    console.warn(`[auth-hook] ${event} denied the request: ${out.error}`);
    // 503, not 500: nothing failed — a dependency the operator declared
    // mandatory was unreachable, and a retry may well succeed.
    throw new AppError(
      "UNAVAILABLE",
      `Auth hook "${event}" could not be reached and is configured to deny`,
    );
  }
  console.warn(`[auth-hook] ${event} failed open: ${out.error}`);
  return null;
}

/** Load the hook for an event and ask it, or `null` when none is configured. */
async function resolveVerdict(
  ctx: AuthHookCtx,
  tenantId: string | null,
  event: AuthHookEvent,
  payload: AuthHookPayload,
): Promise<AuthHookVerdict | null> {
  const hook = await loadAuthHook(ctx, tenantId, event);
  if (!hook) return null;
  return askHook(ctx, hook, event, payload);
}

/* ───────────────────────── event-level helpers ───────────────────────── */

/**
 * `before-user-created` — the app's admission decision on a person it has
 * never seen.
 *
 * Throws `AppError("FORBIDDEN")` when the hook refuses. Runs on EVERY path
 * that creates an `app_users` row: the better-auth sign-up flows (password,
 * social, magic-link, OTP) and federated provisioning (SAML, LDAP, a trusted
 * third-party JWT). A gate that only covered the first would be a gate an
 * attacker routes around by signing in with Google.
 */
export async function runBeforeUserCreatedHook(
  ctx: AuthHookCtx,
  tenantId: string | null,
  payload: BeforeUserCreatedPayload,
): Promise<void> {
  const verdict = await resolveVerdict(ctx, tenantId, "before-user-created", payload);
  if (!verdict) return;
  if (verdict.allow === false) {
    throw new AppError(
      "FORBIDDEN",
      verdict.reason?.slice(0, 500) || "Sign-up rejected",
    );
  }
}

/** Strip anything a token must not carry, then bound the result.
 *
 *  Exported because the reserved-claim rule is the security property of this
 *  whole feature and deserves to be tested directly rather than through a
 *  sign-in. */
export const sanitizeCustomClaims = (
  raw: unknown,
): { claims: Record<string, unknown>; dropped: string[]; tooLarge: boolean } => {
  const dropped: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { claims: {}, dropped, tooLarge: false };
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (RESERVED_TOKEN_CLAIMS.has(k)) {
      dropped.push(k);
      continue;
    }
    if (v === undefined || typeof v === "function") {
      dropped.push(k);
      continue;
    }
    out[k] = v;
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(out);
  } catch {
    // A cycle or a BigInt — nothing that can go in a JWT.
    return { claims: {}, dropped, tooLarge: false };
  }
  if (serialized.length > MAX_CUSTOM_CLAIMS_BYTES) {
    return { claims: {}, dropped, tooLarge: true };
  }
  return { claims: out, dropped, tooLarge: false };
};

/**
 * `custom-access-token` — the claims the app wants inside the JWT.
 *
 * Returns only what survives {@link sanitizeCustomClaims}. The caller writes
 * the identity claims OVER these, so a reserved name that slipped through the
 * filter still cannot decide who the token is for.
 *
 * `loadRoles` is a thunk rather than a value because this runs on the token
 * mint path: resolving a person's roles costs a query (cached, but a query),
 * and an instance with no `custom-access-token` hook — which is nearly all of
 * them — must not pay it on every refresh. It is called only once a hook is
 * known to exist.
 */
export async function runCustomAccessTokenHook(
  ctx: AuthHookCtx,
  tenantId: string | null,
  identity: CustomAccessTokenIdentity,
  loadRoles: () => Promise<string[]>,
): Promise<Record<string, unknown>> {
  const hook = await loadAuthHook(ctx, tenantId, "custom-access-token");
  if (!hook) return {};
  let roles: string[] = [];
  try {
    roles = await loadRoles();
  } catch {
    // A role lookup that fails is context the hook loses, not a reason to
    // refuse a token the person is otherwise entitled to.
    roles = [];
  }
  const verdict = await askHook(ctx, hook, "custom-access-token", { ...identity, roles });
  if (!verdict) return {};
  const { claims, tooLarge } = sanitizeCustomClaims(verdict.claims);
  if (tooLarge) {
    console.warn(
      `[auth-hook] custom-access-token returned more than ${MAX_CUSTOM_CLAIMS_BYTES} bytes of claims — dropped`,
    );
  }
  return claims;
}

/**
 * `password-verification` — the app's say on a password sign-in it just saw
 * the result of.
 *
 * Returns the verdict rather than throwing, because the caller has to revoke
 * the session better-auth already created before it can refuse. A hook that
 * fails with `onError: "deny"` still throws — a policy the operator declared
 * mandatory must not be skipped just because the password happened to match.
 */
export async function runPasswordVerificationHook(
  ctx: AuthHookCtx,
  tenantId: string | null,
  payload: PasswordVerificationPayload,
): Promise<{ allow: boolean; reason?: string }> {
  const verdict = await resolveVerdict(ctx, tenantId, "password-verification", payload);
  if (!verdict) return { allow: true };
  if (verdict.allow === false) {
    return { allow: false, reason: verdict.reason?.slice(0, 500) };
  }
  return { allow: true };
}

/**
 * `send-email` — the app delivering its own auth mail.
 *
 * Returns true when the hook took delivery, in which case the caller must NOT
 * also send. A hook that answers without `handled: false` is taken at its word
 * (a 2xx from a mail relay is "sent"); an explicit `handled: false` falls back
 * to our transport, which is how an app opts out per-message.
 */
export async function runSendEmailHook(
  ctx: AuthHookCtx,
  tenantId: string | null,
  payload: SendEmailPayload,
): Promise<boolean> {
  const verdict = await resolveVerdict(ctx, tenantId, "send-email", payload);
  if (!verdict) return false;
  return verdict.handled !== false;
}

/* ───────────────────────── admin CRUD ───────────────────────── */

export interface AuthHookInput {
  event: AuthHookEvent;
  targetType: AuthHookTargetType;
  url?: string | null;
  functionName?: string | null;
  onError: OnAuthHookError;
  secret?: string | null;
  headers?: Record<string, string> | null;
  timeoutMs?: number;
  enabled?: boolean;
}

/** Reject a target that names neither (or both) of the two kinds. Doing it
 *  here rather than in the route keeps GraphQL, MCP and the SDK on the same
 *  answer — they all call this. */
const validateTarget = (input: {
  targetType?: AuthHookTargetType;
  url?: string | null;
  functionName?: string | null;
}): void => {
  if (input.targetType === "url") {
    if (!input.url?.trim()) throw new AppError("VALIDATION", "`url` is required for a url target");
  } else if (input.targetType === "function") {
    if (!input.functionName?.trim()) {
      throw new AppError("VALIDATION", "`functionName` is required for a function target");
    }
  }
};

export async function createAuthHook(
  ctx: AuthHookCtx,
  tenantId: string,
  input: AuthHookInput,
): Promise<AuthHookPublic> {
  if (!isAuthHookEvent(input.event)) {
    throw new AppError("VALIDATION", `Unknown auth hook event "${String(input.event)}"`);
  }
  validateTarget(input);
  const t = tableFor(ctx.dialect);
  const existing = (await (ctx.db as AnyDb)
    .select({ id: t.id })
    .from(t)
    .where(and(eq(t.tenantId, tenantId), eq(t.event, input.event)))
    .limit(1)) as Array<{ id: string }>;
  if (existing[0]) {
    throw new AppError(
      "CONFLICT",
      `This workspace already has a "${input.event}" hook — update or delete it first`,
    );
  }
  const id = crypto.randomUUID();
  await (ctx.db as AnyDb).insert(t).values({
    id,
    tenantId,
    event: input.event,
    targetType: input.targetType,
    url: input.targetType === "url" ? (input.url ?? "").trim() : null,
    functionName: input.targetType === "function" ? (input.functionName ?? "").trim() : null,
    onError: input.onError,
    secret: input.secret?.trim() || null,
    headers: input.headers ?? null,
    timeoutMs: Math.min(
      Math.max(input.timeoutMs ?? DEFAULT_AUTH_HOOK_TIMEOUT_MS, 50),
      MAX_AUTH_HOOK_TIMEOUT_MS,
    ),
    enabled: input.enabled ?? true,
  });
  const [row] = (await (ctx.db as AnyDb).select().from(t).where(eq(t.id, id))) as AuthHookRow[];
  if (!row) throw new AppError("INTERNAL", "auth_hooks row missing after insert");
  return toPublic(row);
}

export async function listAuthHooks(
  ctx: AuthHookCtx,
  tenantId: string,
): Promise<AuthHookPublic[]> {
  const t = tableFor(ctx.dialect);
  try {
    const rows = (await (ctx.db as AnyDb)
      .select()
      .from(t)
      .where(eq(t.tenantId, tenantId))) as AuthHookRow[];
    // Stable, meaningful order: the sequence the events occur in for a person
    // signing up, so the card reads top-to-bottom like the flow it hooks.
    return rows
      .sort(
        (a, b) =>
          AUTH_HOOK_EVENTS.indexOf(a.event as AuthHookEvent) -
          AUTH_HOOK_EVENTS.indexOf(b.event as AuthHookEvent),
      )
      .map(toPublic);
  } catch {
    return [];
  }
}

export async function updateAuthHook(
  ctx: AuthHookCtx,
  tenantId: string,
  id: string,
  patch: Partial<AuthHookInput>,
): Promise<AuthHookPublic> {
  const t = tableFor(ctx.dialect);
  const db = ctx.db as AnyDb;
  const [current] = (await db
    .select()
    .from(t)
    .where(and(eq(t.tenantId, tenantId), eq(t.id, id)))) as AuthHookRow[];
  if (!current) throw new AppError("NOT_FOUND", "Auth hook not found");

  const targetType = (patch.targetType ?? current.targetType) as AuthHookTargetType;
  validateTarget({
    targetType,
    url: patch.url !== undefined ? patch.url : current.url,
    functionName: patch.functionName !== undefined ? patch.functionName : current.functionName,
  });

  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.event !== undefined && patch.event !== current.event) {
    if (!isAuthHookEvent(patch.event)) {
      throw new AppError("VALIDATION", `Unknown auth hook event "${String(patch.event)}"`);
    }
    // Checked here as well as on create: without it, moving a hook onto an
    // event that already has one would hit the unique index and surface as a
    // driver error, i.e. a 500 for a plain conflict.
    const clash = (await db
      .select({ id: t.id })
      .from(t)
      .where(and(eq(t.tenantId, tenantId), eq(t.event, patch.event)))
      .limit(1)) as Array<{ id: string }>;
    if (clash[0]) {
      throw new AppError(
        "CONFLICT",
        `This workspace already has a "${patch.event}" hook — update or delete it first`,
      );
    }
    set.event = patch.event;
  }
  if (patch.headers !== undefined) set.headers = patch.headers;
  if (patch.onError !== undefined) set.onError = patch.onError;
  if (patch.targetType !== undefined) set.targetType = patch.targetType;
  // Switching target kind blanks the other side, so a stale URL can never be
  // called by a hook the operator believes is running a function.
  if (targetType === "url") {
    if (patch.url !== undefined) set.url = (patch.url ?? "").trim() || null;
    if (patch.targetType !== undefined) set.functionName = null;
  } else {
    if (patch.functionName !== undefined) {
      set.functionName = (patch.functionName ?? "").trim() || null;
    }
    if (patch.targetType !== undefined) set.url = null;
  }
  // An empty/absent secret keeps the stored one: the UI cannot read it back, so
  // a blank field must not blank the credential.
  if (patch.secret?.trim()) set.secret = patch.secret.trim();
  if (patch.timeoutMs !== undefined) {
    set.timeoutMs = Math.min(Math.max(patch.timeoutMs, 50), MAX_AUTH_HOOK_TIMEOUT_MS);
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
    .where(and(eq(t.tenantId, tenantId), eq(t.id, id)))) as AuthHookRow[];
  if (!row) throw new AppError("NOT_FOUND", "Auth hook not found");
  return toPublic(row);
}

export async function deleteAuthHook(
  ctx: AuthHookCtx,
  tenantId: string,
  id: string,
): Promise<void> {
  await (ctx.db as AnyDb)
    .delete(tableFor(ctx.dialect))
    .where(and(eq(tableFor(ctx.dialect).tenantId, tenantId), eq(tableFor(ctx.dialect).id, id)));
}

/** A representative payload per event, so a test call exercises the same shape
 *  the real one will. `__backlex_test` marks it for an app that would rather
 *  not act on a probe. */
const testPayloadFor = (event: AuthHookEvent): AuthHookPayload => {
  switch (event) {
    case "before-user-created":
      return { email: "test@example.com", name: "Test Person", via: "password", subject: null };
    case "custom-access-token":
      return {
        userId: "00000000-0000-0000-0000-000000000000",
        email: "test@example.com",
        sessionId: "00000000-0000-0000-0000-000000000000",
        roles: ["authenticated"],
      };
    case "password-verification":
      return { email: "test@example.com", valid: true, ip: null, userAgent: null };
    case "send-email":
      return { type: "magic-link", to: "test@example.com", url: "https://example.com/verify?token=test" };
  }
};

/**
 * Fire one test call and report what came back — without it, the only way to
 * find out a hook is misconfigured is a blocked sign-in in production.
 *
 * For `custom-access-token` the response also reports which claims WOULD be
 * dropped: a hook quietly losing the `tid` it tried to set is exactly the
 * surprise this endpoint exists to prevent. Does not touch the breaker.
 */
export async function testAuthHook(
  ctx: AuthHookCtx,
  tenantId: string,
  id: string,
): Promise<AuthHookOutcome & { droppedClaims?: string[] }> {
  const t = tableFor(ctx.dialect);
  const [row] = (await (ctx.db as AnyDb)
    .select()
    .from(t)
    .where(and(eq(t.tenantId, tenantId), eq(t.id, id)))) as AuthHookRow[];
  if (!row) throw new AppError("NOT_FOUND", "Auth hook not found");
  const event = row.event as AuthHookEvent;
  const payload = {
    ...testPayloadFor(event),
    __backlex_test: true,
  } as unknown as AuthHookPayload;
  const out = await invokeAuthHook(ctx, row, event, payload, { countOutcome: false });
  if (event === "custom-access-token" && out.ok && out.verdict?.claims) {
    const { dropped } = sanitizeCustomClaims(out.verdict.claims);
    return { ...out, droppedClaims: dropped };
  }
  return out;
}
