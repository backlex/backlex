import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { AppError } from "@workeros/core";
import * as pg from "@workeros/db/pg";
import * as sqlite from "@workeros/db/sqlite";
import type { AppBindings } from "../app";
import { runFlowById } from "../services/flows";

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

  const body = await c.req.json().catch(() => ({}));
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
