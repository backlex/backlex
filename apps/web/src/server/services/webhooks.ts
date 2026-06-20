import { and, desc, eq } from "drizzle-orm";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { DbCtx } from "./seed";
import type { Ctx } from "../context";
import { enqueueJob } from "./jobs";

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
}

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

const sendOne = async (
  row: WebhookRow,
  channel: string,
  event: string,
  body: string,
): Promise<{ status: number; ms: number; responseBody: string | null; error: string | null }> => {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-backlex-event": `${channel}:${event}`,
    ...(row.headers ?? {}),
  };
  if (row.secret) {
    headers["x-backlex-signature"] = await hmacSha256Hex(row.secret, body);
  }
  const start = Date.now();
  try {
    const res = await fetch(row.url, { method: "POST", headers, body });
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
  const out = await sendOne(hook, input.channel, input.event, input.body);
  await recordDelivery(ctx, {
    webhookId: hook.id,
    event: `${input.channel}:${input.event}`,
    status: out.status,
    ms: out.ms,
    responseBody: out.responseBody,
    error: out.error,
    attempts: input.attempt ?? 1,
  });
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
  channel: string,
  payload: { event: string; data: unknown },
): Promise<void> => {
  const t = webhooksTable(ctx.dialect);
  // Pull the originating tenant from the event payload — every
  // ItemEvent.data carries the row, which on tenant-scoped collections
  // contains tenant_id/tenantId. When absent (system events with no
  // tenant), fall through to the unscoped fan-out so global hooks still
  // fire; the table-level fan-out is otherwise gated.
  const data = payload.data as Record<string, unknown> | null | undefined;
  const tenantId =
    (data && typeof data === "object"
      ? (data["tenantId"] ?? data["tenant_id"])
      : null) as string | null | undefined;
  const where = tenantId
    ? and(eq(t.active, true), eq(t.tenantId, tenantId))
    : eq(t.active, true);
  const rows = (await (ctx.db as any)
    .select()
    .from(t)
    .where(where)) as WebhookRow[];
  if (rows.length === 0) return;

  const body = JSON.stringify({
    channel,
    event: payload.event,
    data: payload.data,
    deliveredAt: new Date().toISOString(),
  });

  const matching = rows.filter((row) =>
    row.events.some((p) => matchesPattern(p, channel, payload.event)),
  );
  if (matching.length === 0) return;

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
          payload: { webhookId: row.id, channel, event: payload.event, body },
        }),
      ),
    );
    return;
  }

  // Fallback (no env / system event): best-effort inline delivery, no retry.
  await Promise.all(
    matching.map(async (row) => {
      const out = await sendOne(row, channel, payload.event, body);
      await recordDelivery(ctx, {
        webhookId: row.id,
        event: `${channel}:${payload.event}`,
        ...out,
      });
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

  const out = await sendOne(hook, channel, event, body);
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
