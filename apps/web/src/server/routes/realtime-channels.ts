/**
 * Broadcast channel rules — admin CRUD. Mounted at `/api/admin/realtime-channels`.
 *
 * A rule says who may subscribe to, and who may publish on, the free-form
 * realtime channels an application invents. See `services/broadcast.ts` for
 * why they needed a gate at all and why the pattern grammar is closed.
 */
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { AppError, MAX_REPLAY_RETENTION_HOURS, SYSTEM_ROLES } from "@backlex/core";
import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { SECURITY, OkSchema, errorResponses } from "../lib/openapi";
import {
  createBroadcastRule,
  deleteBroadcastRule,
  listBroadcastRules,
  updateBroadcastRule,
  type BroadcastRuleInput,
} from "../services/broadcast";
import { logActivity } from "../services/activity";
import { defaultHook } from "../lib/openapi-router";

const AccessSchema = z
  .object({
    access: z.enum(["none", "public", "authenticated", "roles"]).openapi({
      description:
        "`none` — nobody. `public` — anyone, including an unauthenticated caller. " +
        "`authenticated` — any caller with a session or token in this workspace. " +
        "`roles` — a caller holding one of `roles`.",
    }),
    roles: z.array(z.string()).optional().openapi({
      description: "Required and non-empty when `access` is `roles`.",
    }),
    condition: z.unknown().optional().openapi({
      description:
        "Permission-DSL condition over the pattern's captures, not over a row. On the pattern " +
        "`org:{org}:feed`, `{\"org\":{\"_eq\":\"$org.id\"}}` means the org segment must be the org " +
        "this request is acting in. Same operators and variables as a collection permission.",
    }),
  })
  .openapi("ChannelAccess");

const RuleView = z
  .object({
    id: z.string(),
    name: z.string(),
    pattern: z.string(),
    subscribe: AccessSchema,
    publish: AccessSchema,
    presence: z.boolean(),
    replay: z.boolean(),
    retentionHours: z.number(),
    enabled: z.boolean(),
  })
  .openapi("BroadcastChannelRule");

const RuleInput = z
  .object({
    name: z.string().min(1).max(120),
    pattern: z.string().min(1).openapi({
      description:
        "Colon-separated segments: a literal, `*` (one segment), `**` (the rest, last only) or " +
        "`{name}` (one segment, captured for the condition). The first segment must be a literal " +
        "and may not be one the managed channels own (items, signal, presence, collab, agent, collections).",
    }),
    subscribe: AccessSchema,
    publish: AccessSchema,
    presence: z.boolean().optional(),
    replay: z.boolean().optional(),
    retentionHours: z.number().int().min(1).max(MAX_REPLAY_RETENTION_HOURS).optional(),
    enabled: z.boolean().optional(),
  })
  .openapi("BroadcastChannelRuleInput");

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

const tags = ["realtime-channels"];

export const realtimeChannelsRoutes = new OpenAPIHono<AppBindings>({ defaultHook })
  .openapi(
    createRoute({
      method: "get",
      path: "/",
      tags,
      summary: "List broadcast channel rules",
      security: SECURITY,
      middleware: adminGate,
      responses: {
        200: {
          description: "OK",
          content: { "application/json": { schema: z.object({ data: z.array(RuleView) }) } },
        },
        ...errorResponses,
      },
    }),
    async (c) => c.json({ data: await listBroadcastRules(c.get("ctx"), requireTenant(c)) }),
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/",
      tags,
      summary: "Create a broadcast channel rule",
      description:
        "Admin-only. Channels with no matching rule are refused in both directions, so this is " +
        "how an application-owned channel comes into existence.",
      security: SECURITY,
      middleware: adminGate,
      request: { body: { required: true, content: { "application/json": { schema: RuleInput } } } },
      responses: {
        201: {
          description: "Created",
          content: { "application/json": { schema: z.object({ data: RuleView }) } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const data = await createBroadcastRule(
        c.get("ctx"),
        requireTenant(c),
        c.req.valid("json") as BroadcastRuleInput,
      );
      await logActivity(c, {
        action: "create",
        collection: "system_realtime_channels",
        itemId: data.id,
        payload: { pattern: data.pattern },
      });
      return c.json({ data }, 201);
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/{id}",
      tags,
      summary: "Update a broadcast channel rule",
      security: SECURITY,
      middleware: adminGate,
      request: {
        params: z.object({ id: z.string() }),
        body: { required: true, content: { "application/json": { schema: RuleInput.partial() } } },
      },
      responses: {
        200: {
          description: "OK",
          content: { "application/json": { schema: z.object({ data: RuleView }) } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const data = await updateBroadcastRule(
        c.get("ctx"),
        requireTenant(c),
        id,
        c.req.valid("json") as Partial<BroadcastRuleInput>,
      );
      await logActivity(c, {
        action: "update",
        collection: "system_realtime_channels",
        itemId: id,
      });
      return c.json({ data });
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/{id}",
      tags,
      summary: "Delete a broadcast channel rule",
      description:
        "Admin-only. Channels the rule matched are refused from the next request onward — " +
        "there is no grace period, because a rule is the only thing making them reachable.",
      security: SECURITY,
      middleware: adminGate,
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: { description: "OK", content: { "application/json": { schema: OkSchema } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      await deleteBroadcastRule(c.get("ctx"), requireTenant(c), id);
      await logActivity(c, {
        action: "delete",
        collection: "system_realtime_channels",
        itemId: id,
      });
      return c.json({ ok: true });
    },
  );
