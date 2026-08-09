/**
 * Row-level security — admin routes. Mounted at `/api/admin/rls`.
 *
 * `plan` is deliberately a separate call from `apply`, and the admin UI shows
 * it first. Applying compiles a workspace's permission rules into DDL against
 * every physical table; the operator should read what it will do, and in
 * particular read the OMISSIONS — the parts of the model a policy cannot carry
 * — before the database starts enforcing a coarser version of their rules.
 */
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { AppError, SYSTEM_ROLES } from "@backlex/core";
import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { SECURITY, errorResponses } from "../lib/openapi";
import { applyRls, disableRls, planRls, rlsStatus } from "../services/rls";
import { logActivity } from "../services/activity";
import { defaultHook } from "../lib/openapi-router";

const OmissionSchema = z.object({
  collection: z.string(),
  role: z.string(),
  action: z.string(),
  reason: z.string(),
});

const PlanSchema = z
  .object({
    helpers: z.array(z.string()),
    enables: z.array(z.string()),
    policies: z.array(
      z.object({
        collection: z.string(),
        table: z.string(),
        role: z.string(),
        action: z.string(),
        name: z.string(),
        statements: z.array(z.string()),
      }),
    ),
    omissions: z.array(OmissionSchema),
    notOwned: z.array(z.string()),
  })
  .openapi("RlsPlan");

const StatusSchema = z
  .object({
    supported: z.boolean(),
    appliesTo: z.string(),
    installed: z.array(z.object({ table: z.string(), name: z.string(), command: z.string() })),
    expected: z.array(z.object({ table: z.string(), name: z.string() })),
    stale: z.array(z.object({ table: z.string(), name: z.string(), command: z.string() })),
    missing: z.array(z.object({ table: z.string(), name: z.string() })),
    omissions: z.array(OmissionSchema),
    notOwned: z.array(z.string()),
  })
  .openapi("RlsStatus");

const requireAdminMiddleware: MiddlewareHandler<AppBindings> = async (c, next) => {
  const auth = c.get("auth");
  if (!auth.roles.includes(SYSTEM_ROLES.admin)) {
    throw new AppError("FORBIDDEN", "Admin role required");
  }
  await next();
};
const adminGate = [requireUser, requireAdminMiddleware];

const requireTenant = (c: { get: (k: string) => any }): string => {
  const tenantId = c.get("auth")?.tenantId as string | undefined;
  if (!tenantId) throw new AppError("UNAUTHORIZED", "Active tenant required");
  return tenantId;
};

const tags = ["rls"];

export const rlsRoutes = new OpenAPIHono<AppBindings>({ defaultHook })
  .openapi(
    createRoute({
      method: "get",
      path: "/status",
      tags,
      summary: "What row security is installed, and whether it still matches the rules",
      description:
        "Policies are a snapshot taken when they were applied. Editing a role changes the API " +
        "immediately and the database not at all, so `stale` and `missing` are the drift between them.",
      security: SECURITY,
      middleware: adminGate,
      responses: {
        200: { description: "OK", content: { "application/json": { schema: StatusSchema } } },
        ...errorResponses,
      },
    }),
    async (c) => c.json(await rlsStatus(c.get("ctx"), requireTenant(c))),
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/plan",
      tags,
      summary: "The exact statements an apply would run",
      description:
        "Read the `omissions` before applying: a field allow-list, a relation-walking condition and " +
        "`_near` cannot be carried by a policy, so a direct database reader sees a COARSER view than the API.",
      security: SECURITY,
      middleware: adminGate,
      responses: {
        200: { description: "OK", content: { "application/json": { schema: PlanSchema } } },
        ...errorResponses,
      },
    }),
    async (c) => c.json(await planRls(c.get("ctx"), requireTenant(c))),
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/apply",
      tags,
      summary: "Install the policies",
      description:
        "Idempotent — every policy is dropped and recreated, so re-running after a rule change " +
        "replaces rather than accumulates. Refuses outright when backlex does not own a covered table.",
      security: SECURITY,
      middleware: adminGate,
      responses: {
        200: {
          description: "Applied",
          content: {
            "application/json": {
              schema: z
                .object({
                  applied: z.number(),
                  tables: z.array(z.string()),
                  statements: z.number(),
                  omissions: z.array(OmissionSchema),
                })
                .openapi("RlsApplyResult"),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const res = await applyRls(c.get("ctx"), requireTenant(c));
      await logActivity(c, {
        action: "update",
        collection: "system_rls",
        itemId: "apply",
        payload: { applied: res.applied, tables: res.tables.length },
      });
      return c.json(res);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/disable",
      tags,
      summary: "Remove backlex's policies",
      description:
        "Drops the policies this feature installed, then disables row security only on tables that " +
        "have none left — a hand-written policy somebody else added keeps its table protected.",
      security: SECURITY,
      middleware: adminGate,
      responses: {
        200: {
          description: "Removed",
          content: {
            "application/json": {
              schema: z
                .object({ dropped: z.number(), disabled: z.array(z.string()) })
                .openapi("RlsDisableResult"),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const res = await disableRls(c.get("ctx"), requireTenant(c));
      await logActivity(c, {
        action: "update",
        collection: "system_rls",
        itemId: "disable",
        payload: { dropped: res.dropped },
      });
      return c.json(res);
    },
  );
