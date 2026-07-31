/**
 * Workspace integrations (Slack/Discord/Datadog/GitHub) for the project admin.
 *
 * Mirrors the cloud control plane, but the event source here is the DATA plane:
 * `dispatchIntegrations` is called from `publishEvent` on every record
 * created/updated/deleted and fans out to connected integrations via the shared
 * `@backlex/integrations` adapters. Secret config fields are encrypted at rest
 * with AUTH_SECRET (like SSO/email config) and masked on read.
 */
import { and, desc, eq, isNull } from "drizzle-orm";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { PgDb } from "@backlex/db/pg";
import type { SqliteDb } from "@backlex/db/sqlite";
import {
  OAUTH_ACCESS_TOKEN_KEY,
  OAUTH_CONFIG_KEYS,
  SECRET_KEYS,
  deliverToIntegration,
  isIntegrationKind,
  maskConfig,
  matchesEventFilter,
  providerFor,
  stripOAuthKeys,
  type FetchLike,
  type IntegrationEvent,
  type IntegrationKind,
} from "@backlex/integrations";
import type { Ctx } from "../context";
import type { Env } from "../env";
import { decryptSecret, encryptSecret, isEncryptedSecret } from "../lib/crypto";
import { ensureAccessToken } from "./integrations-oauth";
import { enqueueJob } from "./jobs";

type DbCtx = { db: PgDb | SqliteDb; dialect: "pg" | "sqlite" };
// The PgDb|SqliteDb union can't be queried without per-dialect narrowing; the
// table is the right shape for both, so queries go through this hatch (mirrors
// services/webhooks.ts's `(ctx.db as any)`).
type AnyDb = any;

// Both dialects' columns are query-compatible; type as the PG table so column
// access (`t.tenantId`) is concrete rather than a `never`-collapsing union.
// The DB itself is queried via `AnyDb`, so runtime uses the real dialect table.
const tableFor = (dialect: "pg" | "sqlite") =>
  (dialect === "pg" ? pg.schema.integrations : sqlite.schema.integrations) as typeof pg.schema.integrations;

const deliveriesTableFor = (dialect: "pg" | "sqlite") =>
  (dialect === "pg"
    ? pg.schema.integrationDeliveries
    : sqlite.schema.integrationDeliveries) as typeof pg.schema.integrationDeliveries;

const tenantEq = (t: typeof pg.schema.integrations, tenantId: string | null) =>
  tenantId === null ? isNull(t.tenantId) : eq(t.tenantId, tenantId);

/** Consecutive failed deliveries that trip the auto-disable circuit breaker.
 *  Every attempt counts (including queue retries); any success resets it to 0.
 *  Matches the webhook breaker so the two behave the same for an operator. */
export const INTEGRATION_AUTODISABLE_THRESHOLD = 15;

export interface IntegrationRow {
  id: string;
  tenantId: string | null;
  kind: string;
  config: Record<string, unknown>;
  events: string[] | null;
  status: string;
  lastEventAt: Date | number | null;
  createdAt: Date | number | null;
  /** The OAuth refresh path compares against this before writing new tokens. */
  updatedAt: Date | number | null;
  consecutiveFailures?: number;
  lastFailureAt?: Date | number | null;
  disabledReason?: string | null;
}

export interface IntegrationDeliveryRow {
  id: string;
  integrationId: string;
  tenantId: string | null;
  event: string;
  status: number;
  ms: number;
  error: string | null;
  attempts: number;
  deliveredAt: Date | number;
}

const secretKeys = (kind: string) => new Set(SECRET_KEYS[kind as IntegrationKind] ?? []);

async function encryptConfig(kind: string, config: Record<string, unknown>, secret: string) {
  const keys = secretKeys(kind);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) {
    out[k] =
      keys.has(k) && typeof v === "string" && v && !isEncryptedSecret(v) ? await encryptSecret(v, secret) : v;
  }
  return out;
}

async function decryptConfig(kind: string, config: Record<string, unknown>, secret: string) {
  const keys = secretKeys(kind);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) {
    out[k] = keys.has(k) && typeof v === "string" && isEncryptedSecret(v) ? ((await decryptSecret(v, secret)) ?? "") : v;
  }
  return out;
}

/** Public (masked) view of an integration row — never leaks decrypted secrets. */
export function toPublic(row: IntegrationRow) {
  return {
    id: row.id,
    kind: row.kind,
    events: row.events,
    status: row.status,
    config: maskConfig(row.kind, (row.config ?? {}) as Record<string, unknown>),
    lastEventAt: row.lastEventAt,
    createdAt: row.createdAt,
    consecutiveFailures: row.consecutiveFailures ?? 0,
    lastFailureAt: row.lastFailureAt ?? null,
    disabledReason: row.disabledReason ?? null,
  };
}

/** Connect (or update) an integration for a workspace. One row per (tenant, kind). */
export async function connectIntegration(
  ctx: DbCtx,
  input: { tenantId: string | null; kind: string; config?: Record<string, unknown>; events?: string[] | null },
  authSecret: string,
): Promise<ReturnType<typeof toPublic>> {
  if (!isIntegrationKind(input.kind)) throw new Error(`Unknown integration kind: ${input.kind}`);
  const t = tableFor(ctx.dialect);
  // Reserved `_oauth*` keys are written only by the OAuth flow. Dropping them
  // from caller input keeps "this token came from the provider" true, and stops
  // an admin pasting a token the UI could never have shown them.
  const config = await encryptConfig(input.kind, stripOAuthKeys(input.config ?? {}), authSecret);
  const events = input.events ?? null;
  const db = ctx.db as AnyDb;

  const existing = (await db
    .select()
    .from(t)
    .where(and(tenantEq(t, input.tenantId), eq(t.kind, input.kind)))) as IntegrationRow[];

  if (existing[0]) {
    // …and carry the stored ones over. This save replaces `config` wholesale,
    // so without the carry-over an admin correcting a typo in an unrelated
    // field would silently disconnect the OAuth account.
    const priorConfig = (existing[0].config ?? {}) as Record<string, unknown>;
    for (const key of OAUTH_CONFIG_KEYS) {
      if (key in priorConfig) config[key] = priorConfig[key];
    }
    await db
      .update(t)
      .set({ config, events, status: "connected", updatedAt: new Date() })
      .where(eq(t.id, existing[0].id));
    const [row] = (await db.select().from(t).where(eq(t.id, existing[0].id))) as IntegrationRow[];
    if (!row) throw new Error("integration row missing after update");
    return toPublic(row);
  }

  const id = crypto.randomUUID();
  await db.insert(t).values({ id, tenantId: input.tenantId, kind: input.kind, config, events, status: "connected" });
  const [row] = (await db.select().from(t).where(eq(t.id, id))) as IntegrationRow[];
  if (!row) throw new Error("integration row missing after insert");
  return toPublic(row);
}

export async function listIntegrations(ctx: DbCtx, tenantId: string | null) {
  const t = tableFor(ctx.dialect);
  const rows = (await (ctx.db as AnyDb)
    .select()
    .from(t)
    .where(tenantEq(t, tenantId))
    .orderBy(desc(t.createdAt))) as IntegrationRow[];
  return rows.map(toPublic);
}

export async function disconnectIntegration(ctx: DbCtx, tenantId: string | null, id: string): Promise<void> {
  const t = tableFor(ctx.dialect);
  const d = deliveriesTableFor(ctx.dialect);
  const db = ctx.db as AnyDb;
  // Confirm ownership BEFORE touching anything. The integration delete is
  // tenant-scoped on its own, but the delivery cleanup keys off the id alone;
  // running it unconditionally would let one workspace erase another's log by
  // passing a foreign id that the first delete harmlessly ignores.
  const [owned] = (await db
    .select()
    .from(t)
    .where(and(tenantEq(t, tenantId), eq(t.id, id)))) as IntegrationRow[];
  if (!owned) return;
  await db.delete(t).where(and(tenantEq(t, tenantId), eq(t.id, id)));
  // The log is meaningless once the integration is gone, and leaving it behind
  // would let a later row reuse the id and inherit a stranger's history.
  await db.delete(d).where(eq(d.integrationId, id));
}

/** Re-enable an integration the breaker paused, clearing its failure state. */
export async function resumeIntegration(
  ctx: DbCtx,
  tenantId: string | null,
  id: string,
): Promise<ReturnType<typeof toPublic> | null> {
  const t = tableFor(ctx.dialect);
  const db = ctx.db as AnyDb;
  await db
    .update(t)
    .set({
      status: "connected",
      consecutiveFailures: 0,
      lastFailureAt: null,
      disabledReason: null,
      updatedAt: new Date(),
    })
    .where(and(tenantEq(t, tenantId), eq(t.id, id)));
  const [row] = (await db
    .select()
    .from(t)
    .where(and(tenantEq(t, tenantId), eq(t.id, id)))) as IntegrationRow[];
  return row ? toPublic(row) : null;
}

/** Recent delivery attempts for one integration, newest first. Tenant-guarded
 *  through the integration row so a workspace can't read another's log. */
export async function listIntegrationDeliveries(
  ctx: DbCtx,
  tenantId: string | null,
  integrationId: string,
  limit = 50,
): Promise<IntegrationDeliveryRow[]> {
  const t = tableFor(ctx.dialect);
  const d = deliveriesTableFor(ctx.dialect);
  const db = ctx.db as AnyDb;
  const [owner] = (await db
    .select()
    .from(t)
    .where(and(tenantEq(t, tenantId), eq(t.id, integrationId)))) as IntegrationRow[];
  if (!owner) return [];
  return (await db
    .select()
    .from(d)
    .where(eq(d.integrationId, integrationId))
    .orderBy(desc(d.deliveredAt))
    .limit(Math.min(Math.max(limit, 1), 200))) as IntegrationDeliveryRow[];
}

/** Append one delivery attempt to the log. Best-effort — a full log must never
 *  break the delivery it is recording. */
async function recordDelivery(
  ctx: DbCtx,
  input: {
    integrationId: string;
    tenantId: string | null;
    event: string;
    status: number;
    ms: number;
    error: string | null;
    attempts: number;
  },
): Promise<void> {
  try {
    await (ctx.db as AnyDb)
      .insert(deliveriesTableFor(ctx.dialect))
      .values({ id: crypto.randomUUID(), deliveredAt: new Date(), ...input });
  } catch (e) {
    console.error("[integration] delivery log write failed", e);
  }
}

/** Circuit breaker: fold one outcome into the integration's failure counter. A
 *  success resets it; a failure bumps it and, past the threshold, flips status
 *  to `disabled` with a reason so the queue stops re-attempting a dead target.
 *  Best-effort — never throws into the delivery path. */
async function applyDeliveryOutcome(
  ctx: DbCtx,
  row: IntegrationRow,
  ok: boolean,
  detail: string,
): Promise<void> {
  const t = tableFor(ctx.dialect);
  const now = new Date();
  const prior = row.consecutiveFailures ?? 0;
  try {
    if (ok) {
      // Only write when there is state to clear — keeps the happy path quiet.
      if (prior > 0) {
        await (ctx.db as AnyDb)
          .update(t)
          .set({ consecutiveFailures: 0, lastFailureAt: null, disabledReason: null, updatedAt: now })
          .where(eq(t.id, row.id));
      }
      return;
    }
    const next = prior + 1;
    if (next >= INTEGRATION_AUTODISABLE_THRESHOLD) {
      await (ctx.db as AnyDb)
        .update(t)
        .set({
          status: "disabled",
          consecutiveFailures: next,
          lastFailureAt: now,
          disabledReason: `Auto-disabled after ${next} consecutive failed deliveries (last: ${detail})`,
          updatedAt: now,
        })
        .where(eq(t.id, row.id));
    } else {
      await (ctx.db as AnyDb)
        .update(t)
        .set({ consecutiveFailures: next, lastFailureAt: now, updatedAt: now })
        .where(eq(t.id, row.id));
    }
  } catch (e) {
    console.error("[integration] breaker update failed", e);
  }
}

/**
 * Fan a data event out to the workspace's connected integrations. Called from
 * `publishEvent` (fire-and-forget). Best-effort; never throws into the caller.
 *
 * `originTenantId` is the workspace the event happened in, taken from the
 * request context by `publishEvent`. It is AUTHORITATIVE and must never be
 * re-derived from the payload: this used to read `data.tenantId ?? data.tenant_id`,
 * but `deserializeRow` only emits declared collection fields, so item events
 * carry no tenant at all. The value was therefore always undefined in
 * production and the query fell through to an UNSCOPED fan-out, delivering
 * every workspace's record events to every connected integration on the
 * instance. `dispatchWebhooks` had the identical bug and the identical fix.
 * With no origin tenant, match only the genuinely global integrations rather
 * than all of them.
 */
export async function dispatchIntegrations(
  env: Env,
  ctx: DbCtx,
  originTenantId: string | null,
  channel: string,
  evt: { event: string; data: unknown },
  fetchImpl?: FetchLike,
): Promise<void> {
  const t = tableFor(ctx.dialect);
  const where = and(eq(t.status, "connected"), tenantEq(t, originTenantId));
  const rows = (await (ctx.db as AnyDb).select().from(t).where(where)) as IntegrationRow[];
  if (rows.length === 0) return;

  const message = buildEventMessage(channel, evt);
  const matching = rows.filter((row) => matchesEventFilter(row.events, message.event));
  if (matching.length === 0) return;

  // Prefer the durable queue: one integration.deliver job per matching row, so
  // a provider outage is retried with backoff and dead-lettered instead of
  // being dropped on the floor. The handler re-loads and tenant-guards the row
  // at delivery time, so a disconnect between enqueue and run is respected.
  // `fetchImpl` is a test seam; when it's supplied stay inline so specs observe
  // the request directly.
  const full = !fetchImpl && "env" in ctx ? (ctx as Ctx) : null;
  if (full) {
    await Promise.all(
      matching.map((row) =>
        enqueueJob(full, {
          type: "integration.deliver",
          queue: "integrations",
          tenantId: row.tenantId ?? originTenantId ?? null,
          // Scoped per integration BEFORE the job row is written. A single
          // message carrying the record would park row contents in the queue
          // for every provider, including the ones that must never see it.
          payload: { integrationId: row.id, message: messageFor(row.kind, message) },
        }),
      ),
    );
    return;
  }

  // Fallback (no env, or a test seam): best-effort inline delivery, no retry.
  for (const row of matching) {
    await deliverOne(env, ctx, row, messageFor(row.kind, message), 1, fetchImpl);
  }
}

/** Render the chat text + machine payload for one item event. Shared by the
 *  dispatcher and the queue handler so a retry sends byte-identical content to
 *  the first attempt. */
function buildEventMessage(channel: string, evt: { event: string; data: unknown }): IntegrationEvent {
  const data = evt.data as Record<string, unknown> | null | undefined;
  const collection = channel.startsWith("items:") ? channel.slice("items:".length) : channel;
  const id = data && typeof data === "object" ? data.id : undefined;
  return {
    event: `${collection}.${evt.event}`,
    text: `${collection}: record ${evt.event}${id ? ` #${String(id)}` : ""}`,
    payload: { collection, event: evt.event, id },
    // Carried on the message but NOT attached here — `deliverOne` decides
    // per provider. Building one message per integration would mean rendering
    // the same event N times, and building it once with the record always
    // present would put it in the queue payload for every provider, including
    // the ones that must never see it.
    record: (data ?? null) as Record<string, unknown> | null,
  };
}

/**
 * Narrow one event to what this provider is allowed to receive.
 *
 * The record is attached only to providers that declared `recordPayload`.
 * Everything else gets the same message with the field absent — not emptied,
 * absent, so a provider that reads it defensively cannot mistake `{}` for a row
 * that happened to have no fields.
 */
export const messageFor = (kind: string, message: IntegrationEvent): IntegrationEvent => {
  if (providerFor(kind)?.recordPayload) return message;
  const { record: _withheld, ...rest } = message;
  return rest;
};

/** Decrypt, deliver, log, and fold the outcome into the breaker. Returns the
 *  HTTP outcome so the job handler can throw a non-2xx into the retry path. */
async function deliverOne(
  env: Env,
  ctx: DbCtx,
  row: IntegrationRow,
  message: IntegrationEvent,
  attempt: number,
  fetchImpl?: FetchLike,
): Promise<{ ok: boolean; status: number }> {
  const t = tableFor(ctx.dialect);
  const started = Date.now();
  const cfg = await decryptConfig(row.kind, (row.config ?? {}) as Record<string, unknown>, env.AUTH_SECRET);
  // OAuth providers hold a token with a lifetime; renew it before the call
  // rather than letting the provider answer 401 and the breaker count it as an
  // outage. `null` means the grant was revoked — that is a reconnect, not
  // something a retry can fix, so report it as misconfigured straight away.
  if (providerFor(row.kind)?.oauth && "env" in ctx) {
    const fresh = await ensureAccessToken(ctx as Ctx, row, env.AUTH_SECRET);
    if (!fresh) {
      await applyDeliveryOutcome(ctx, row, false, "OAuth grant expired or revoked");
      await recordDelivery(ctx, {
        integrationId: row.id,
        tenantId: row.tenantId,
        event: message.event,
        status: 0,
        ms: Date.now() - started,
        error: "OAuth connection needs re-authorizing",
        attempts: attempt,
      });
      return { ok: false, status: 0 };
    }
    cfg[OAUTH_ACCESS_TOKEN_KEY] = fresh;
  }
  // Re-applied here because the queue handler reconstructs the message from a
  // stored payload: a job written before this rule existed, or hand-enqueued,
  // must not be able to hand a record to a provider that never asked for one.
  const out = await deliverToIntegration(row.kind, cfg, messageFor(row.kind, message), fetchImpl);
  const ms = Date.now() - started;
  // status 0 is the adapters' "misconfigured or the request threw" sentinel —
  // there is no response to quote, so say so rather than logging a bare 0.
  const error = out.ok ? null : out.status === 0 ? "provider misconfigured or unreachable" : `HTTP ${out.status}`;

  await recordDelivery(ctx, {
    integrationId: row.id,
    tenantId: row.tenantId,
    event: message.event,
    status: out.status,
    ms,
    error,
    attempts: attempt,
  });
  if (out.ok) {
    await (ctx.db as AnyDb).update(t).set({ lastEventAt: new Date() }).where(eq(t.id, row.id));
  }
  await applyDeliveryOutcome(ctx, row, out.ok, error ?? String(out.status));
  return out;
}

/**
 * Deliver one message through the workspace's integration of a given `kind` —
 * the runtime behind the `integration` flow operation. Addressing by kind
 * rather than id is what lets a flow name a provider ("slack") without
 * embedding a row id that differs per workspace. A kind the workspace hasn't
 * connected (or that the breaker disabled) is reported as skipped rather than
 * failing the flow, so a paused integration doesn't take the automation with
 * it. Credentials never leave this module.
 */
export async function deliverIntegrationByKind(
  env: Env,
  ctx: DbCtx,
  tenantId: string | null,
  kind: string,
  message: IntegrationEvent,
  fetchImpl?: FetchLike,
): Promise<{ ok: boolean; status: number; skipped?: boolean }> {
  if (!isIntegrationKind(kind)) return { ok: false, status: 0, skipped: true };
  const t = tableFor(ctx.dialect);
  const [row] = (await (ctx.db as AnyDb)
    .select()
    .from(t)
    .where(and(tenantEq(t, tenantId), eq(t.kind, kind), eq(t.status, "connected")))) as IntegrationRow[];
  if (!row) return { ok: false, status: 0, skipped: true };
  return deliverOne(env, ctx, row, message, 1, fetchImpl);
}

/**
 * Deliver one queued event to one integration — the runtime behind the
 * `integration.deliver` job. An integration that no longer exists, or that the
 * breaker has since disabled, is a terminal no-op (reported ok) so the queue
 * stops retrying a target nobody is listening on any more.
 */
export async function deliverIntegrationById(
  env: Env,
  ctx: DbCtx,
  input: {
    integrationId: string;
    tenantId: string | null;
    message: IntegrationEvent;
    attempt?: number;
  },
): Promise<{ ok: boolean; status: number; skipped?: boolean }> {
  const t = tableFor(ctx.dialect);
  const [row] = (await (ctx.db as AnyDb)
    .select()
    .from(t)
    .where(and(tenantEq(t, input.tenantId), eq(t.id, input.integrationId)))) as IntegrationRow[];
  if (!row || row.status !== "connected") return { ok: true, status: 200, skipped: true };
  return deliverOne(env, ctx, row, input.message, input.attempt ?? 1);
}
