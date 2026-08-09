import { and, desc, eq, isNull } from "drizzle-orm";
import { AppError } from "@backlex/core";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { DbCtx } from "./seed";
import type { Ctx } from "../context";
import type { Env } from "../env";
import { enqueueJob } from "./jobs";
import { recordActivity } from "./activity";
import { fetchOutbound } from "./storage/hosts";

/** Pull the runtime Env off a ctx when present (route/job ctx is the full Ctx);
 *  undefined for the bare DbCtx paths (system events) where no SSRF guard
 *  config is available, falling back to a plain fetch. */
const envOf = (ctx: DbCtx): Env | undefined =>
  "env" in ctx ? (ctx as Ctx).env : undefined;

/** Consecutive failed deliveries that trip the auto-disable circuit breaker.
 *  Each delivery attempt (including queue retries) counts; any 2xx resets it to
 *  0. Sized so a single flapping event can't disable a hook, but a genuinely
 *  dead endpoint is paused before it burns the queue indefinitely. */
const WEBHOOK_AUTODISABLE_THRESHOLD = 15;

const webhooksTable = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.webhooks : sqlite.schema.webhooks;

const deliveriesTable = (dialect: "pg" | "sqlite") =>
  dialect === "pg"
    ? pg.schema.webhookDeliveries
    : sqlite.schema.webhookDeliveries;

interface WebhookRow {
  id: string;
  tenantId: string | null;
  name: string;
  url: string;
  events: string[];
  headers: Record<string, string> | null;
  secret: string | null;
  active: boolean | number;
  consecutiveFailures?: number;
  /** Allow-list of top-level `data` keys. Null/empty = the whole row. */
  payloadFields?: string[] | null;
}

/**
 * Narrow an event's `data` to the keys this hook is allowed to carry.
 *
 * Every delivery used to ship the whole row, so a hook that only needed an id
 * and a status was also handed the customer's address and whatever column got
 * added last week — to a third-party endpoint, forever, because nobody revisits
 * a webhook once it works.
 *
 * Only the top level is projected, and only for object payloads. An array or a
 * scalar `data` (system events) passes through: there are no keys to choose
 * from, and silently emptying such a payload would be worse than sending it.
 * A configured key that the row doesn't have is simply absent — the projection
 * never invents an explicit `null`, which a receiver would read as "cleared".
 */
export const projectPayload = (data: unknown, fields: string[] | null | undefined): unknown => {
  if (!fields || fields.length === 0) return data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return data;
  const src = data as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (Object.hasOwn(src, f)) out[f] = src[f];
  }
  return out;
};

export interface WebhookDeliveryRow {
  id: string;
  webhookId: string;
  event: string;
  status: number;
  ms: number;
  responseBody: string | null;
  error: string | null;
  attempts: number;
  deliveredAt: string | number;
}

const matchesPattern = (pattern: string, channel: string, event: string): boolean => {
  const target = `${channel}:${event}`;
  if (pattern === target) return true;
  if (pattern === channel) return true;

  const parts = pattern.split(":");
  const targetParts = target.split(":");
  if (parts.length > targetParts.length) return false;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p === "*") continue;
    if (p !== targetParts[i]) return false;
  }
  return true;
};

const hmacSha256Hex = async (secret: string, body: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(body),
  );
  return Array.from(new Uint8Array(sig), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
};

const recordDelivery = async (
  ctx: DbCtx,
  row: {
    webhookId: string;
    event: string;
    status: number;
    ms: number;
    responseBody?: string | null;
    error?: string | null;
    attempts?: number;
  },
): Promise<void> => {
  const t = deliveriesTable(ctx.dialect);
  const now = ctx.dialect === "pg" ? new Date() : Date.now();
  try {
    await (ctx.db as any).insert(t).values({
      id: crypto.randomUUID(),
      webhookId: row.webhookId,
      event: row.event,
      status: row.status,
      ms: row.ms,
      responseBody: row.responseBody ?? null,
      error: row.error ?? null,
      attempts: row.attempts ?? 1,
      deliveredAt: now,
    });
  } catch (e) {
    // Don't let logging failures break the dispatch path.
    console.error("[webhook] delivery log insert failed", e);
  }
};

/** Broadcast an in-app notification + audit row when the breaker disables a
 *  hook. Best-effort: a notification/activity failure must not break delivery. */
const notifyAutoDisabled = async (
  ctx: DbCtx,
  hook: { id: string; name: string; tenantId: string | null },
  reason: string,
): Promise<void> => {
  try {
    const nt =
      ctx.dialect === "pg"
        ? pg.schema.notifications
        : sqlite.schema.notifications;
    await (ctx.db as any).insert(nt).values({
      id: crypto.randomUUID(),
      userId: null, // broadcast — surfaced to every admin
      title: `Webhook "${hook.name}" auto-disabled`,
      body: reason,
      url: "/webhooks",
      flowId: null,
      readAt: null,
      createdAt: ctx.dialect === "pg" ? new Date() : Date.now(),
    });
  } catch (e) {
    console.error("[webhook] auto-disable notify failed", e);
  }
  await recordActivity(ctx, {
    userId: null,
    tenantId: hook.tenantId ?? null,
    action: "auto_disabled",
    collection: "system_webhooks",
    itemId: hook.id,
    payload: { reason },
  });
};

/** Circuit breaker: fold one delivery outcome into the hook's failure counter.
 *  A 2xx resets the counter (and clears any failure marker); a non-2xx bumps it
 *  and, once it crosses {@link WEBHOOK_AUTODISABLE_THRESHOLD}, flips the hook
 *  `active=false` with a reason so the queue stops re-attempting a dead endpoint
 *  and an admin is notified. Best-effort — never throws into the delivery path. */
const applyDeliveryOutcome = async (
  ctx: DbCtx,
  hook: {
    id: string;
    name: string;
    tenantId: string | null;
    consecutiveFailures?: number;
  },
  out: { status: number; error: string | null },
): Promise<void> => {
  const wt = webhooksTable(ctx.dialect);
  const now = ctx.dialect === "pg" ? new Date() : Date.now();
  const ok = out.status >= 200 && out.status < 300;
  const prior = hook.consecutiveFailures ?? 0;
  try {
    if (ok) {
      // Only write when there's state to clear — keeps the happy path quiet.
      if (prior > 0) {
        await (ctx.db as any)
          .update(wt)
          .set({
            consecutiveFailures: 0,
            lastFailureAt: null,
            disabledReason: null,
            updatedAt: now,
          })
          .where(eq(wt.id, hook.id));
      }
      return;
    }
    const next = prior + 1;
    if (next >= WEBHOOK_AUTODISABLE_THRESHOLD) {
      const reason = `Auto-disabled after ${next} consecutive failed deliveries (last: ${
        out.status || out.error || "no response"
      })`;
      await (ctx.db as any)
        .update(wt)
        .set({
          active: false,
          consecutiveFailures: next,
          lastFailureAt: now,
          disabledReason: reason,
          updatedAt: now,
        })
        .where(eq(wt.id, hook.id));
      await notifyAutoDisabled(ctx, hook, reason);
    } else {
      await (ctx.db as any)
        .update(wt)
        .set({ consecutiveFailures: next, lastFailureAt: now, updatedAt: now })
        .where(eq(wt.id, hook.id));
    }
  } catch (e) {
    console.error("[webhook] breaker update failed", e);
  }
};

const sendOne = async (
  row: WebhookRow,
  channel: string,
  event: string,
  body: string,
  env?: Env,
): Promise<{ status: number; ms: number; responseBody: string | null; error: string | null }> => {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-backlex-event": `${channel}:${event}`,
    ...(row.headers ?? {}),
  };
  if (row.secret) {
    // Replay-safe signing. `x-backlex-signature` stays the bare hex HMAC of the
    // raw body (unchanged — existing receivers keep verifying it). The new
    // `x-backlex-signature-v2` signs `${timestamp}.${body}`, and the timestamp
    // travels in its own header so a receiver can reject stale deliveries
    // (replay protection) without parsing the signature. Set last so custom
    // headers can never override the signing headers.
    const timestamp = Math.floor(Date.now() / 1000).toString();
    headers["x-backlex-timestamp"] = timestamp;
    headers["x-backlex-signature"] = await hmacSha256Hex(row.secret, body);
    headers["x-backlex-signature-v2"] = await hmacSha256Hex(
      row.secret,
      `${timestamp}.${body}`,
    );
  }
  const start = Date.now();
  try {
    // SSRF guard (managed cloud / opt-in): refuses private hosts + re-validates
    // redirects. On self-host (guard off) this is a plain POST, preserving
    // internal webhook receivers.
    const res = env
      ? await fetchOutbound(env, row.url, { method: "POST", headers, body })
      : await fetch(row.url, { method: "POST", headers, body });
    const text = await res.text().catch(() => "");
    return {
      status: res.status,
      ms: Date.now() - start,
      responseBody: text.slice(0, 1024) || null,
      error: null,
    };
  } catch (e) {
    return {
      status: 0,
      ms: Date.now() - start,
      responseBody: null,
      error: (e as Error).message ?? "fetch failed",
    };
  }
};

/**
 * Single-hook variant — used by the "Send test" button on the webhooks page.
 * Skips the matchesPattern filter (the operator picked the hook directly)
 * and still records the delivery so the recent-deliveries panel reflects it.
 */
export const fireDelivery = async (
  ctx: DbCtx,
  hook: {
    id: string;
    url: string;
    headers: Record<string, string> | null;
    secret: string | null;
  },
  event: string,
  payload: unknown,
): Promise<{ status: number; ms: number; error: string | null }> => {
  const body = JSON.stringify({
    channel: "test",
    event,
    data: payload,
    deliveredAt: new Date().toISOString(),
  });
  const out = await sendOne(
    {
      id: hook.id,
      name: "test",
      url: hook.url,
      events: [event],
      headers: hook.headers,
      secret: hook.secret,
      active: true,
    } as WebhookRow,
    "test",
    event,
    body,
    envOf(ctx),
  );
  await recordDelivery(ctx, {
    webhookId: hook.id,
    event: `test:${event}`,
    ...out,
  });
  return { status: out.status, ms: out.ms, error: out.error };
};

/**
 * Deliver one webhook by id — the runtime behind the `webhook.deliver` job
 * handler. Loads the hook (tenant-guarded), POSTs the pre-rendered body, and
 * records the delivery with the queue's attempt count. A hook that no longer
 * exists (or is inactive) is a terminal no-op (status 200, nothing recorded) so
 * the queue doesn't keep retrying a deleted target. Returns the HTTP outcome;
 * the handler turns a non-2xx into a throw to drive retry / dead-letter.
 */
export const deliverWebhookById = async (
  ctx: DbCtx,
  input: {
    webhookId: string;
    tenantId?: string | null;
    channel: string;
    event: string;
    body: string;
    attempt?: number;
  },
): Promise<{ status: number; ms: number; error: string | null }> => {
  const wt = webhooksTable(ctx.dialect);
  const where = input.tenantId
    ? and(eq(wt.id, input.webhookId), eq(wt.tenantId, input.tenantId))
    : eq(wt.id, input.webhookId);
  const rows = (await (ctx.db as any).select().from(wt).where(where)) as WebhookRow[];
  const hook = rows[0];
  if (!hook || !(hook.active === true || hook.active === 1)) {
    return { status: 200, ms: 0, error: null };
  }
  const out = await sendOne(hook, input.channel, input.event, input.body, envOf(ctx));
  await recordDelivery(ctx, {
    webhookId: hook.id,
    event: `${input.channel}:${input.event}`,
    status: out.status,
    ms: out.ms,
    responseBody: out.responseBody,
    error: out.error,
    attempts: input.attempt ?? 1,
  });
  await applyDeliveryOutcome(ctx, hook, out);
  return { status: out.status, ms: out.ms, error: out.error };
};

/**
 * Fan out an event to matching webhooks. When a full {@link Ctx} (with `env`) is
 * available the deliveries are **enqueued** as `webhook.deliver` jobs so they
 * run off the write path with retry + dead-letter; otherwise (system events with
 * only a DbCtx) they're sent inline as a best-effort fallback.
 */
export const dispatchWebhooks = async (
  ctx: DbCtx | Ctx,
  /** Workspace the event originated in, taken from the request context by
   *  `publishEvent`. Authoritative — never re-derive it from the payload. */
  originTenantId: string | null,
  channel: string,
  payload: { event: string; data: unknown },
): Promise<void> => {
  const t = webhooksTable(ctx.dialect);
  // This used to read the tenant out of `payload.data`, on the assumption that
  // an ItemEvent row carries `tenant_id`. It does not — `deserializeRow` only
  // emits declared collection fields — so the value was always undefined for
  // item events and the query fell through to an UNSCOPED fan-out, delivering
  // every workspace's rows to every registered hook on the instance. Scope on
  // the caller-supplied origin instead, and when there is no origin tenant
  // match only the genuinely global hooks rather than all of them.
  const data = payload.data as Record<string, unknown> | null | undefined;
  const payloadTenantId =
    (data && typeof data === "object"
      ? (data["tenantId"] ?? data["tenant_id"])
      : null) as string | null | undefined;
  // System events (jobs, backups, …) put the tenant inside `data`; keep that as
  // a fallback, but only when the caller had nothing more authoritative.
  const tenantId = originTenantId ?? payloadTenantId ?? null;
  const where = tenantId
    ? and(eq(t.active, true), eq(t.tenantId, tenantId))
    : and(eq(t.active, true), isNull(t.tenantId));
  const rows = (await (ctx.db as any)
    .select()
    .from(t)
    .where(where)) as WebhookRow[];
  if (rows.length === 0) return;

  const matching = rows.filter((row) =>
    row.events.some((p) => matchesPattern(p, channel, payload.event)),
  );
  if (matching.length === 0) return;

  // Built per hook, not once for the set: `payloadFields` is per-hook, so two
  // hooks on the same event can legitimately receive different bodies. The
  // signature is over the body, so the projection has to happen before signing
  // — which it does, since the job carries the finished body.
  const deliveredAt = new Date().toISOString();
  const bodyFor = (row: WebhookRow): string =>
    JSON.stringify({
      channel,
      event: payload.event,
      data: projectPayload(payload.data, row.payloadFields),
      deliveredAt,
    });

  // Prefer the durable queue: one webhook.deliver job per matching hook so a
  // 5xx/timeout from the receiver is retried with backoff and dead-lettered
  // instead of being lost. `tenantId` is captured per-hook so the handler
  // re-loads + tenant-guards the row at delivery time.
  const full = "env" in ctx ? (ctx as Ctx) : null;
  if (full) {
    await Promise.all(
      matching.map((row) =>
        enqueueJob(full, {
          type: "webhook.deliver",
          queue: "webhooks",
          tenantId: row.tenantId ?? tenantId ?? null,
          payload: { webhookId: row.id, channel, event: payload.event, body: bodyFor(row) },
        }),
      ),
    );
    return;
  }

  // Fallback (no env / system event): best-effort inline delivery, no retry.
  await Promise.all(
    matching.map(async (row) => {
      const out = await sendOne(row, channel, payload.event, bodyFor(row));
      await recordDelivery(ctx, {
        webhookId: row.id,
        event: `${channel}:${payload.event}`,
        ...out,
      });
      await applyDeliveryOutcome(ctx, row, out);
    }),
  );
};

/** Re-attempt a single past delivery — finds the original webhook + event.
 *  Caller supplies `tenantId` so retry from the admin UI can't reach into
 *  another workspace's deliveries by guessing an id. */
export const retryDelivery = async (
  ctx: DbCtx,
  deliveryId: string,
  tenantId?: string | null,
): Promise<{ status: number; ms: number } | null> => {
  const dt = deliveriesTable(ctx.dialect);
  const wt = webhooksTable(ctx.dialect);

  const dRows = (await (ctx.db as any)
    .select()
    .from(dt)
    .where(eq(dt.id, deliveryId))) as WebhookDeliveryRow[];
  const delivery = dRows[0];
  if (!delivery) return null;

  const hookWhere = tenantId
    ? and(eq(wt.id, delivery.webhookId), eq(wt.tenantId, tenantId))
    : eq(wt.id, delivery.webhookId);
  const wRows = (await (ctx.db as any)
    .select()
    .from(wt)
    .where(hookWhere)) as WebhookRow[];
  const hook = wRows[0];
  if (!hook) return null;

  // Replays use the original event tag — payload data is not stored, so we
  // resend a marker event indicating this is a manual retry.
  const [channel, event] = delivery.event.split(":").length >= 2
    ? [
        delivery.event.split(":").slice(0, -1).join(":"),
        delivery.event.split(":").pop() ?? "replay",
      ]
    : [delivery.event, "replay"];
  const body = JSON.stringify({
    channel,
    event,
    data: { _retryOf: delivery.id },
    deliveredAt: new Date().toISOString(),
  });

  const out = await sendOne(hook, channel, event, body, envOf(ctx));
  await recordDelivery(ctx, {
    webhookId: hook.id,
    event: delivery.event,
    ...out,
    attempts: delivery.attempts + 1,
  });
  return { status: out.status, ms: out.ms };
};

/** Recent deliveries across one webhook (or all when omitted). When
 *  `tenantId` is set, deliveries are restricted to webhooks that belong
 *  to that workspace via an inner join. */
export const listDeliveries = async (
  ctx: DbCtx,
  opts: { webhookId?: string; limit?: number; tenantId?: string | null } = {},
): Promise<WebhookDeliveryRow[]> => {
  const t = deliveriesTable(ctx.dialect);
  const wt = webhooksTable(ctx.dialect);
  if (opts.tenantId) {
    // Join through webhooks so a delivery is only visible to its owning
    // workspace. Drizzle's row shape comes back nested under the table
    // alias when joining; we project back to the flat WebhookDeliveryRow
    // shape callers expect.
    const rows = (await (ctx.db as any)
      .select({ delivery: t })
      .from(t)
      .innerJoin(wt, eq(wt.id, t.webhookId))
      .where(
        opts.webhookId
          ? and(eq(wt.tenantId, opts.tenantId), eq(t.webhookId, opts.webhookId))
          : eq(wt.tenantId, opts.tenantId),
      )
      .orderBy(desc(t.deliveredAt))
      .limit(opts.limit ?? 50)) as { delivery: WebhookDeliveryRow }[];
    return rows.map((r) => r.delivery);
  }
  let q: any = (ctx.db as any).select().from(t);
  if (opts.webhookId) q = q.where(eq(t.webhookId, opts.webhookId));
  q = q.orderBy(desc(t.deliveredAt)).limit(opts.limit ?? 50);
  return (await q) as WebhookDeliveryRow[];
};

// ── Shared surface helpers ───────────────────────────────────────────────────
// REST (routes/webhooks.ts) and GraphQL (services/graphql/webhooks.ts) both
// call these so tenant scoping + the breaker-reset rule live in one place.
// Activity logging stays surface-specific (REST logs ip/UA via logActivity;
// GraphQL uses recordActivity).

export interface WebhookConfigInput {
  name: string;
  url: string;
  events: string[];
  headers?: Record<string, string> | null;
  secret?: string | null;
  active?: boolean;
  /** Allow-list of top-level `data` keys this hook may carry. Null/empty = the
   *  whole row. See {@link projectPayload}. */
  payloadFields?: string[] | null;
}

/** Every webhook in the workspace (includes breaker state columns). */
export const listWebhooks = async (
  ctx: Ctx,
  tenantId: string,
): Promise<Record<string, unknown>[]> => {
  const t = webhooksTable(ctx.dialect);
  return (await (ctx.db as any)
    .select()
    .from(t)
    .where(eq(t.tenantId, tenantId))) as Record<string, unknown>[];
};

export const createWebhook = async (
  ctx: Ctx,
  tenantId: string,
  input: WebhookConfigInput,
): Promise<Record<string, unknown>> => {
  const t = webhooksTable(ctx.dialect);
  const id = crypto.randomUUID();
  await (ctx.db as any).insert(t).values({
    id,
    tenantId,
    name: input.name,
    url: input.url,
    events: input.events,
    headers: input.headers ?? null,
    payloadFields: input.payloadFields ?? null,
    secret: input.secret ?? null,
    active: input.active ?? true,
  });
  // Wire shape preserved from the legacy route handler: echo the input back
  // (headers/secret stay absent when the caller omitted them).
  return { id, ...input, active: input.active ?? true };
};

export const updateWebhook = async (
  ctx: Ctx,
  tenantId: string,
  id: string,
  patch: Partial<WebhookConfigInput>,
): Promise<void> => {
  const t = webhooksTable(ctx.dialect);
  await (ctx.db as any)
    .update(t)
    .set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.url !== undefined ? { url: patch.url } : {}),
      ...(patch.events !== undefined ? { events: patch.events } : {}),
      ...(patch.headers !== undefined ? { headers: patch.headers } : {}),
      ...(patch.payloadFields !== undefined ? { payloadFields: patch.payloadFields } : {}),
      ...(patch.secret !== undefined ? { secret: patch.secret } : {}),
      ...(patch.active !== undefined ? { active: patch.active } : {}),
      // Re-enabling (manual resume) clears the breaker so the hook gets a
      // clean slate instead of tripping again on the next single failure.
      ...(patch.active === true
        ? { consecutiveFailures: 0, lastFailureAt: null, disabledReason: null }
        : {}),
      updatedAt: ctx.dialect === "pg" ? new Date() : Date.now(),
    })
    .where(and(eq(t.id, id), eq(t.tenantId, tenantId)));
};

export const deleteWebhook = async (
  ctx: Ctx,
  tenantId: string,
  id: string,
): Promise<void> => {
  const t = webhooksTable(ctx.dialect);
  await (ctx.db as any).delete(t).where(and(eq(t.id, id), eq(t.tenantId, tenantId)));
};

/** Fire a synthetic `webhook.test` delivery at one hook (honours its
 *  signature + headers). Throws NOT_FOUND when the hook isn't in scope. */
export const testWebhook = async (
  ctx: Ctx,
  tenantId: string,
  id: string,
): Promise<Awaited<ReturnType<typeof fireDelivery>>> => {
  const t = webhooksTable(ctx.dialect);
  const hook = (await (ctx.db as any)
    .select()
    .from(t)
    .where(and(eq(t.id, id), eq(t.tenantId, tenantId)))
    .limit(1)) as WebhookRow[];
  const h = hook[0];
  if (!h) throw new AppError("NOT_FOUND", "Webhook not found");
  const payload = {
    type: "webhook.test",
    data: { hookId: h.id, ts: new Date().toISOString() },
  };
  return fireDelivery(ctx, h, "webhook.test", payload);
};
