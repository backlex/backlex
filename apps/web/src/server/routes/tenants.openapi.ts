import { z } from "../lib/openapi";
import { apiRegistry, SECURITY, OkSchema, errorResponses } from "../lib/openapi";

const TAG = "tenants";

const TenantRow = z
  .object({
    id: z.string(),
    slug: z.string(),
    name: z.string(),
    project: z.string(),
    branch: z.string(),
    env: z.string(),
    mark: z.string().nullable(),
    color: z.string().nullable(),
    role: z.string(),
  })
  .openapi("TenantRow");

const CreateTenantInput = z
  .object({
    name: z.string().min(2).max(60),
    project: z.string().max(40).optional(),
    env: z.enum(["development", "staging", "production"]).optional(),
  })
  .openapi("CreateTenantInput");

const InviteInput = z
  .object({
    email: z.string().email(),
    role: z.enum(["owner", "admin", "editor", "member"]).default("member"),
  })
  .openapi("TenantInviteInput");

const SwitchInput = z
  .object({ tenant: z.string().min(1) })
  .openapi("TenantSwitchInput");

apiRegistry.registerPath({
  method: "get",
  path: "/api/tenants",
  tags: [TAG],
  summary: "List my workspaces",
  description: "Workspaces the caller belongs to. `active` reflects the currently-selected workspace.",
  security: SECURITY,
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": {
          schema: z.object({ data: z.array(TenantRow), active: z.string().nullable() }),
        },
      },
    },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "post",
  path: "/api/tenants",
  tags: [TAG],
  summary: "Create a workspace",
  description: "The caller becomes owner. System roles are seeded and the creator is granted `admin`.",
  security: SECURITY,
  request: { body: { required: true, content: { "application/json": { schema: CreateTenantInput } } } },
  responses: {
    201: {
      description: "Created",
      content: {
        "application/json": {
          schema: z.object({ data: z.object({ id: z.string(), slug: z.string(), name: z.string() }) }),
        },
      },
    },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "post",
  path: "/api/tenants/switch",
  tags: [TAG],
  summary: "Switch active workspace",
  description: "Sets the workspace cookie. Body `tenant` is matched against id then slug.",
  security: SECURITY,
  request: { body: { required: true, content: { "application/json": { schema: SwitchInput } } } },
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": {
          schema: z.object({ data: z.object({ id: z.string(), slug: z.string() }) }),
        },
      },
    },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "get",
  path: "/api/tenants/{id}/members",
  tags: [TAG],
  summary: "List workspace members",
  description: "Caller must be a member (admins bypass).",
  security: SECURITY,
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: z.object({ data: z.array(z.record(z.unknown())) }) } } },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "post",
  path: "/api/tenants/{id}/members/invite",
  tags: [TAG],
  summary: "Invite a member",
  description: "Sends an invite email with a 7-day token. Owners/admins only.",
  security: SECURITY,
  request: {
    params: z.object({ id: z.string() }),
    body: { required: true, content: { "application/json": { schema: InviteInput } } },
  },
  responses: {
    201: {
      description: "Invite created",
      content: {
        "application/json": {
          schema: z.object({ data: z.object({ id: z.string(), token: z.string() }) }),
        },
      },
    },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "delete",
  path: "/api/tenants/{id}/members/{memberId}",
  tags: [TAG],
  summary: "Remove a member",
  description: "Owners/admins only.",
  security: SECURITY,
  request: { params: z.object({ id: z.string(), memberId: z.string() }) },
  responses: {
    200: { description: "Removed", content: { "application/json": { schema: OkSchema } } },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "post",
  path: "/api/tenants/accept",
  tags: [TAG],
  summary: "Accept an invite",
  description: "Consumes the invite token and binds the caller to the workspace.",
  security: SECURITY,
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({ token: z.string().min(8) }).openapi("TenantAcceptInput"),
        },
      },
    },
  },
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": {
          schema: z.object({ data: z.object({ tenantId: z.string() }) }),
        },
      },
    },
    ...errorResponses,
  },
});
