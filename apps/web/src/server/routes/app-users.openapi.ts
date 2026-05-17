import { z } from "../lib/openapi";
import { apiRegistry, SECURITY, OkSchema, errorResponses } from "../lib/openapi";

const TAG = "app-users";

const AppUserRoleRef = z.object({ id: z.string(), name: z.string() });

const AppUserRow = z
  .object({
    id: z.string(),
    email: z.string(),
    name: z.string().nullable(),
    emailVerified: z.boolean().nullable(),
    status: z.string(),
    createdAt: z.unknown(),
    roles: z.array(AppUserRoleRef),
  })
  .openapi("AppUserRow");

apiRegistry.registerPath({
  method: "get",
  path: "/api/app-users",
  tags: [TAG],
  summary: "List workspace end-users",
  description: "Returns the `app_users` for the active workspace with their custom role assignments.",
  security: SECURITY,
  responses: {
    200: { description: "OK", content: { "application/json": { schema: z.object({ data: z.array(AppUserRow) }) } } },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "put",
  path: "/api/app-users/{id}/roles",
  tags: [TAG],
  summary: "Replace end-user role assignments",
  description:
    "Replace the user's role bindings. Every roleId must belong to the active workspace; the admin role is rejected.",
  security: SECURITY,
  request: {
    params: z.object({ id: z.string() }),
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({ roleIds: z.array(z.string().min(1)) }).openapi("AppUserSetRolesInput"),
        },
      },
    },
  },
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": {
          schema: z.object({ ok: z.literal(true), roleIds: z.array(z.string()) }),
        },
      },
    },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "patch",
  path: "/api/app-users/{id}",
  tags: [TAG],
  summary: "Update end-user",
  description: "Currently only `status`. Suspending also drops the user's `app_sessions`.",
  security: SECURITY,
  request: {
    params: z.object({ id: z.string() }),
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({ status: z.enum(["active", "suspended"]).optional() }).openapi("AppUserPatchInput"),
        },
      },
    },
  },
  responses: {
    200: { description: "Updated", content: { "application/json": { schema: OkSchema } } },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "delete",
  path: "/api/app-users/{id}",
  tags: [TAG],
  summary: "Delete end-user",
  description: "Drops the `app_users` row plus sessions, OAuth accounts, and role assignments in this workspace.",
  security: SECURITY,
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: "Deleted", content: { "application/json": { schema: OkSchema } } },
    ...errorResponses,
  },
});
