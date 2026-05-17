import { z } from "../lib/openapi";
import { apiRegistry, SECURITY, OkSchema, errorResponses } from "../lib/openapi";

const TAG = "roles";

const RoleInput = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    admin: z.boolean().optional(),
  })
  .openapi("RoleInput");

const RoleRow = z
  .object({
    id: z.string(),
    tenantId: z.string().nullable(),
    name: z.string(),
    description: z.string().nullable(),
    admin: z.boolean(),
  })
  .openapi("Role");

const PermissionInput = z
  .object({
    roleId: z.string().min(1),
    collection: z.string().min(1),
    action: z.enum(["read", "create", "update", "delete"]),
    fields: z.array(z.string()).nullable().optional(),
    condition: z.unknown().nullable().optional(),
  })
  .openapi("PermissionInput");

const PermissionRow = z
  .object({
    id: z.string(),
    roleId: z.string(),
    collection: z.string(),
    action: z.string(),
    fields: z.array(z.string()).nullable(),
    condition: z.unknown().nullable(),
  })
  .openapi("Permission");

apiRegistry.registerPath({
  method: "get",
  path: "/api/roles",
  tags: [TAG],
  summary: "List roles",
  description: "Roles scoped to the active workspace.",
  security: SECURITY,
  responses: {
    200: { description: "OK", content: { "application/json": { schema: z.object({ data: z.array(RoleRow) }) } } },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "post",
  path: "/api/roles",
  tags: [TAG],
  summary: "Create a role",
  description: "Creates a workspace-scoped role.",
  security: SECURITY,
  request: { body: { required: true, content: { "application/json": { schema: RoleInput } } } },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: z.object({ data: RoleRow }) } } },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "patch",
  path: "/api/roles/{id}",
  tags: [TAG],
  summary: "Update a role",
  description: "Partial update; the role must belong to the active workspace.",
  security: SECURITY,
  request: {
    params: z.object({ id: z.string() }),
    body: { required: true, content: { "application/json": { schema: RoleInput.partial() } } },
  },
  responses: {
    200: { description: "Updated", content: { "application/json": { schema: OkSchema } } },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "delete",
  path: "/api/roles/{id}",
  tags: [TAG],
  summary: "Delete a role",
  description: "System roles (`admin`, `authenticated`, `public`) cannot be deleted.",
  security: SECURITY,
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: "Deleted", content: { "application/json": { schema: OkSchema } } },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "get",
  path: "/api/roles/{id}/permissions",
  tags: [TAG],
  summary: "List a role's permissions",
  description: "All permission rows attached to the role.",
  security: SECURITY,
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: z.object({ data: z.array(PermissionRow) }) } } },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "post",
  path: "/api/roles/{id}/permissions",
  tags: [TAG],
  summary: "Attach a permission",
  description: "Creates a (collection, action) permission row for the role.",
  security: SECURITY,
  request: {
    params: z.object({ id: z.string() }),
    body: { required: true, content: { "application/json": { schema: PermissionInput } } },
  },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: z.object({ data: PermissionRow }) } } },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "delete",
  path: "/api/permissions/{id}",
  tags: ["permissions"],
  summary: "Delete a permission",
  description: "Idempotent. Scoped to the active workspace via the parent role.",
  security: SECURITY,
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: "Deleted", content: { "application/json": { schema: OkSchema } } },
    ...errorResponses,
  },
});
