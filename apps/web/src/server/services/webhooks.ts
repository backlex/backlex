import { desc, eq } from "drizzle-orm";
import * as pg from "@workeros/db/pg";
import * as sqlite from "@workeros/db/sqlite";
import type { DbCtx } from "./seed";

const webhooksTable = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.webhooks : sqlite.schema.webhooks;

const deliveriesTable = (dialect: "pg" | "sqlite") =>
  dialect === "pg"
    ? pg.schema.webhookDeliveries
    : sqlite.schema.webhookDeliveries;

interface WebhookRow {
  id: string;
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
    "x-workeros-event": `${channel}:${event}`,
    ...(row.headers ?? {}),
  };
  if (row.secret) {
    headers["x-workeros-signature"] = await hmacSha256Hex(row.secret, body);
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

export const dispatchWebhooks = async (
  ctx: DbCtx,
  channel: string,
  payload: { event: string; data: unknown },
): Promise<void> => {
  const t = webhooksTable(ctx.dialect);
  const rows = (await (ctx.db as any)
    .select()
    .from(t)
    .where(eq(t.active, true))) as WebhookRow[];
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

/** Re-attempt a single past delivery — finds the original webhook + event. */
export const retryDelivery = async (
  ctx: DbCtx,
  deliveryId: string,
): Promise<{ status: number; ms: number } | null> => {
  const dt = deliveriesTable(ctx.dialect);
  const wt = webhooksTable(ctx.dialect);

  const dRows = (await (ctx.db as any)
    .select()
    .from(dt)
    .where(eq(dt.id, deliveryId))) as WebhookDeliveryRow[];
  const delivery = dRows[0];
  if (!delivery) return null;

  const wRows = (await (ctx.db as any)
    .select()
    .from(wt)
    .where(eq(wt.id, delivery.webhookId))) as WebhookRow[];
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

/** Recent deliveries across one webhook (or all when omitted). */
export const listDeliveries = async (
  ctx: DbCtx,
  opts: { webhookId?: string; limit?: number } = {},
): Promise<WebhookDeliveryRow[]> => {
  const t = deliveriesTable(ctx.dialect);
  let q: any = (ctx.db as any).select().from(t);
  if (opts.webhookId) q = q.where(eq(t.webhookId, opts.webhookId));
  q = q.orderBy(desc(t.deliveredAt)).limit(opts.limit ?? 50);
  return (await q) as WebhookDeliveryRow[];
};
