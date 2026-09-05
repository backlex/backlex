import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { AppError } from "@backlex/core";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { AppBindings } from "../app";
import { rateLimitOk } from "../lib/rate-limit";
import { assertWorkspaceRequestQuota, setMeterTenant } from "../lib/usage-meter";
import { requestMeta } from "../services/activity";
import { runFlowById } from "../services/flows";
import { readJsonOr } from "../lib/body";

/** Per-flow-and-IP burst budget, and a per-flow ceiling that bounds what a
 *  distributed caller can spend even from many addresses. A flow run can
 *  invoke functions and send SMS / push / AI calls, so an unbounded public
 *  trigger is a direct spend channel, not just load. */
const TRIGGER_MAX_PER_MINUTE = 30;
const TRIGGER_MAX_PER_FLOW_PER_MINUTE = 120;
const MINUTE_MS = 60_000;

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.flows : sqlite.schema.flows;

interface FlowRow {
  id: string;
  tenantId: string | null;
  trigger: string;
  active: boolean | number;
}

/**
 * Public POST endpoint that fires a webhook-triggered flow with the
 * request body as the input payload. Auth: the flow id is a secret
 * (cryptographically random UUID). For higher trust later, gate behind
 * a signed `Authorization: Bearer <flow.webhook_token>` header — would
 * need a new column on the flows table.
 *
 * The flow runs under a system principal, but its tenantId is taken from
 * the flow row so item.create / function lookups still scope correctly.
 */
export const webhookTriggerRoutes = new Hono<AppBindings>().post("/:flowId", async (c) => {
  const ctx = c.get("ctx");
  const flowId = c.req.param("flowId");
  const t = tableFor(ctx.dialect);

  const rows = (await (ctx.db as any)
    .select()
    .from(t)
    .where(eq(t.id, flowId))
    .limit(1)) as FlowRow[];
  const flow = rows[0];
  if (!flow) throw new AppError("NOT_FOUND", "Flow not found");
  if (!flow.active) throw new AppError("FORBIDDEN", "Flow is paused");
  if (flow.trigger !== "webhook") {
    throw new AppError("BAD_REQUEST", "Flow trigger is not 'webhook'");
  }

  // The flow row is what tells us which workspace owns this unauthenticated
  // request, so throttling + metering can only start here. Mirrors the
  // per-form/IP guard in routes/forms-public.ts.
  const ip = requestMeta(c.req.raw, c.get("ctx").env).ip ?? "unknown";
  const withinIpBudget = await rateLimitOk(
    ctx.env,
    `flow-trigger:${flow.id}:${ip}`,
    TRIGGER_MAX_PER_MINUTE,
    MINUTE_MS,
  );
  const withinFlowBudget =
    withinIpBudget &&
    (await rateLimitOk(
      ctx.env,
      `flow-trigger-all:${flow.id}`,
      TRIGGER_MAX_PER_FLOW_PER_MINUTE,
      MINUTE_MS,
    ));
  if (!withinFlowBudget) {
    throw new AppError("RATE_LIMITED", "Too many triggers for this flow — slow down");
  }
  if (flow.tenantId) {
    setMeterTenant(c, flow.tenantId);
    await assertWorkspaceRequestQuota(ctx, flow.tenantId);
  }

  const body = await readJsonOr(c.req, {});
  // Enrich the payload with HTTP metadata so flow operations can branch on
  // headers / query without parsing them again.
  const url = new URL(c.req.url);
  const data: Record<string, unknown> = {
    body,
    query: Object.fromEntries(url.searchParams.entries()),
    headers: Object.fromEntries(c.req.raw.headers.entries()),
    tenantId: flow.tenantId,
  };

  await runFlowById(ctx, flowId, data, {
    userId: null,
    email: null,
    roles: [],
    tenantId: flow.tenantId,
  });
  return c.json({ ok: true });
});
