/**
 * Impersonation — admin routes. Mounted at `/api/admin/impersonation`.
 *
 * `start` returns a workspace access token for the SUBJECT. The operator's own
 * session is untouched: they hold two identities and choose which one to send,
 * rather than having their session mutated into somebody else's — which would
 * make "who did this" a question about wall-clock time.
 */
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { AppError, SYSTEM_ROLES } from "@backlex/core";
import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { SECURITY, errorResponses } from "../lib/openapi";
import {
  DEFAULT_IMPERSONATION_MINUTES,
  MAX_IMPERSONATION_MINUTES,
  endImpersonation,
  impersonationEnabled,
  listImpersonations,
  startImpersonation,
} from "../services/impersonation";
import { logActivity } from "../services/activity";
import { defaultHook } from "../lib/openapi-router";

const View = z
  .object({
    id: z.string(),
    actorUserId: z.string(),
    actorEmail: z.string().nullable(),
    subjectUserId: z.string(),
    subjectEmail: z.string().nullable(),
    reason: z.string(),
    readOnly: z.boolean(),
    expiresAt: z.number(),
    endedAt: z.number().nullable(),
    endedBy: z.string().nullable(),
    createdAt: z.number().nullable(),
    active: z.boolean(),
  })
  .openapi("Impersonation");

const requireAdminMiddleware: MiddlewareHandler<AppBindings> = async (c, next) => {
  const auth = c.get("auth");
  if (!auth.roles.includes(SYSTEM_ROLES.admin)) {
    throw new AppError("FORBIDDEN", "Admin role required");
  }
  // An impersonated session must never be able to START one. Otherwise an
  // operator could hop from a subject who happens to hold the admin role into
  // anyone else, and the audit trail would name the SUBJECT as the actor.
  if (auth.impersonatedBy) {
    throw new AppError("FORBIDDEN", "An impersonated session cannot impersonate");
  }
  await next();
};
const adminGate = [requireUser, requireAdminMiddleware];

const requireTenant = (c: { get: (k: string) => any }): string => {
  const tenantId = c.get("auth")?.tenantId as string | undefined;
  if (!tenantId) throw new AppError("UNAUTHORIZED", "Active tenant required");
  return tenantId;
};

const tags = ["impersonation"];

export const impersonationRoutes = new OpenAPIHono<AppBindings>({ defaultHook })
  .openapi(
    createRoute({
      method: "get",
      path: "/",
      tags,
      summary: "List impersonations",
      description: "The audit trail: who acted as whom, why, and whether it is still live.",
      security: SECURITY,
      middleware: adminGate,
      request: {
        query: z.object({
          activeOnly: z.enum(["true", "false"]).optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        }),
      },
      responses: {
        200: {
          description: "OK",
          content: { "application/json": { schema: z.object({ data: z.array(View) }) } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const { activeOnly, limit } = c.req.valid("query");
      return c.json({
        data: await listImpersonations(c.get("ctx"), requireTenant(c), {
          activeOnly: activeOnly === "true",
          limit,
        }),
      });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/",
      tags,
      summary: "Act as one of this workspace's end-users",
      description:
        "Returns a workspace access token for the subject. Your own session is untouched — you " +
        "hold two identities and choose which to send. Read-only unless you ask otherwise, capped " +
        `at ${MAX_IMPERSONATION_MINUTES} minutes, and every request it authenticates re-reads the ` +
        "audit row, so ending it is instant.",
      security: SECURITY,
      middleware: adminGate,
      request: {
        body: {
          required: true,
          content: {
            "application/json": {
              schema: z
                .object({
                  subjectUserId: z.string().min(1),
                  reason: z.string().min(3).max(500).openapi({
                    description:
                      "Required. An audit trail of who acted as whom, with no why, answers half the question.",
                  }),
                  readOnly: z.boolean().optional().openapi({
                    description:
                      "Defaults to true. Set false only when acting on the customer's behalf is intended.",
                  }),
                  minutes: z
                    .number()
                    .int()
                    .min(1)
                    .max(MAX_IMPERSONATION_MINUTES)
                    .optional()
                    .openapi({ description: `Defaults to ${DEFAULT_IMPERSONATION_MINUTES}.` }),
                })
                .openapi("ImpersonationInput"),
            },
          },
        },
      },
      responses: {
        201: {
          description: "Started",
          content: {
            "application/json": {
              schema: z.object({
                data: View,
                token: z.string().openapi({
                  description:
                    "Send as `Authorization: Bearer …`. Returned once; it names the audit row and " +
                    "stops working the moment that row is ended.",
                }),
                expiresAt: z.number(),
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
      if (!impersonationEnabled(ctx.env)) {
        throw new AppError("UNAVAILABLE", "Impersonation is disabled on this deployment");
      }
      const res = await startImpersonation(ctx, requireTenant(c), {
        userId: auth.userId!,
        email: auth.email,
      }, c.req.valid("json"));
      await logActivity(c, {
        action: "create",
        collection: "system_impersonation",
        itemId: res.impersonation.id,
        // The reason is the point of the record; the token is never logged.
        payload: {
          subjectUserId: res.impersonation.subjectUserId,
          reason: res.impersonation.reason,
          readOnly: res.impersonation.readOnly,
        },
      });
      return c.json({ data: res.impersonation, token: res.token, expiresAt: res.expiresAt }, 201);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/{id}/end",
      tags,
      summary: "End an impersonation now",
      description:
        "Takes effect on the next request — the token names this row and every request re-reads it.",
      security: SECURITY,
      middleware: adminGate,
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "Ended",
          content: { "application/json": { schema: z.object({ data: View }) } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const { id } = c.req.valid("param");
      const data = await endImpersonation(c.get("ctx"), requireTenant(c), id, auth.userId!);
      await logActivity(c, {
        action: "update",
        collection: "system_impersonation",
        itemId: id,
        payload: { ended: true },
      });
      return c.json({ data });
    },
  );
