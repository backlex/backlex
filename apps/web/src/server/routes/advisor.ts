import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { AppError, SYSTEM_ROLES } from "@workeros/core";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { SECURITY, errorResponses } from "../lib/openapi";
import { runAdvisorChecks } from "../services/advisor";

const requireAdmin: MiddlewareHandler<AppBindings> = async (c, next) => {
  const auth = c.get("auth");
  if (!auth.roles.includes(SYSTEM_ROLES.admin))
    throw new AppError("FORBIDDEN", "Admin role required");
  await next();
};

const TAGS = ["advisor"];

const AdvisorCheckSchema = z
  .object({
    id: z.string(),
    kind: z.enum(["security", "performance"]),
    level: z.enum(["error", "warn", "info"]),
    rule: z.string(),
    groupTitle: z.string(),
    title: z.string(),
    body: z.string(),
    fix: z.string(),
    resource: z.string(),
    link: z.string().optional(),
  })
  .openapi("AdvisorCheck");

/**
 * Advisor — automated security + performance lint over live workspace state.
 * Admin-only. Every finding is computed from real DB / env state in
 * `services/advisor.ts`; this route just resolves the tenant scope and
 * delegates.
 */
export const advisorRoutes = new OpenAPIHono<AppBindings>().openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: TAGS,
    summary: "Run advisor checks",
    description:
      "Returns automated security + performance findings for the active workspace. Admin-only.",
    security: SECURITY,
    middleware: [requireUser, requireAdmin],
    responses: {
      200: {
        description: "OK",
        content: {
          "application/json": {
            schema: z.object({
              data: z.array(AdvisorCheckSchema),
              score: z.number(),
              generatedAt: z.string(),
            }),
          },
        },
      },
      ...errorResponses,
    },
  }),
  async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const result = await runAdvisorChecks(
      { db: ctx.db, dialect: ctx.dialect, env: ctx.env },
      auth.tenantId ?? null,
    );
    return c.json(result);
  },
);
