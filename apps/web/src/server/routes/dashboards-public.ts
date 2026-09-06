import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { AppError } from "@backlex/core";
import type { AppBindings } from "../app";
import { PUBLIC_SECURITY, errorResponses } from "../lib/openapi";
import { rateLimitOk } from "../lib/rate-limit";
import { assertWorkspaceRequestQuota, setMeterTenant } from "../lib/usage-meter";
import { requestMeta } from "../services/activity";
import { resolveEmbedToken, runDashboardPublic } from "../services/dashboards";
import { defaultHook } from "../lib/openapi-router";

/** One request here fans out into a query per panel, and the embed token is
 *  public by design (it ships inside third-party pages), so the endpoint is a
 *  cheap compute amplifier without a budget. Per-IP first, then a per-token
 *  ceiling that also bounds a distributed caller. */
const EMBED_MAX_PER_MINUTE = 60;
const EMBED_MAX_PER_TOKEN_PER_MINUTE = 300;
const MINUTE_MS = 60_000;

const PublicPanel = z
  .object({
    panelId: z.string(),
    name: z.string(),
    viz: z.string(),
    kind: z.string(),
    config: z.unknown().nullable(),
    data: z.array(z.record(z.string(), z.unknown())),
    note: z.string().optional(),
    error: z.string().optional(),
  })
  .openapi("PublicDashboardPanel");

const PublicDashboard = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    layout: z.unknown().nullable(),
    panels: z.array(PublicPanel),
  })
  .openapi("PublicDashboard");

/**
 * Public, unauthenticated read of an embedded dashboard. Mounted at
 * `/api/public/dashboards` with NO `requireUser` — anyone holding the embed
 * token can read. Panel data is scoped to the dashboard's `embedRoleId`
 * (resolved server-side); a null role means fully public stats.
 *
 * Degrades to 404 when the token is unknown/revoked or the `dashboards` table
 * hasn't been migrated yet (`resolveEmbedToken` swallows the missing-table
 * error and returns null), mirroring `routes/shared-public.ts`.
 */
export const dashboardsPublicRoutes = new OpenAPIHono<AppBindings>({ defaultHook }).openapi(
  createRoute({
    method: "get",
    path: "/{token}",
    tags: ["dashboards"],
    summary: "Resolve a public dashboard embed token to its rendered panels",
    description:
      "PUBLIC — no auth. Resolves the token, runs every panel under the embed's role scope, and returns the dashboard plus per-panel data.",
    security: PUBLIC_SECURITY,
    request: { params: z.object({ token: z.string() }) },
    responses: {
      200: {
        description: "OK",
        content: { "application/json": { schema: z.object({ data: PublicDashboard }) } },
      },
      ...errorResponses,
    },
  }),
  async (c) => {
    const ctx = c.get("ctx");
    const { token } = c.req.valid("param");
    const ip = requestMeta(c.req.raw, c.get("ctx").env).ip ?? "unknown";
    const withinIpBudget = await rateLimitOk(
      ctx.env,
      `dash-embed:${token}:${ip}`,
      EMBED_MAX_PER_MINUTE,
      MINUTE_MS,
    );
    const withinTokenBudget =
      withinIpBudget &&
      (await rateLimitOk(
        ctx.env,
        `dash-embed-all:${token}`,
        EMBED_MAX_PER_TOKEN_PER_MINUTE,
        MINUTE_MS,
      ));
    if (!withinTokenBudget)
      throw new AppError("RATE_LIMITED", "Too many requests for this dashboard");

    const dash = await resolveEmbedToken(ctx, token);
    if (!dash)
      throw new AppError("NOT_FOUND", "This dashboard is no longer available");
    // Bill the panel queries to the workspace that owns the embed — the token
    // is the only thing identifying it on this unauthenticated path.
    if (dash.tenantId) {
      setMeterTenant(c, dash.tenantId);
      await assertWorkspaceRequestQuota(ctx, dash.tenantId);
    }
    const data = await runDashboardPublic(ctx, dash);
    return c.json({ data });
  },
);
