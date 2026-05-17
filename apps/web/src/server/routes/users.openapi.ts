import { z } from "../lib/openapi";
import { apiRegistry, SECURITY, OkSchema, errorResponses } from "../lib/openapi";

const TAG = "users";

const UserRoleRef = z.object({ id: z.string(), name: z.string() });

const UserRow = z
  .object({
    id: z.string(),
    email: z.string(),
    name: z.string().nullable(),
    createdAt: z.unknown(),
    roles: z.array(UserRoleRef),
    lastSeenAt: z.number().nullable(),
  })
  .openapi("UserRow");

apiRegistry.registerPath({
  method: "get",
  path: "/api/users",
  tags: [TAG],
  summary: "List workspace users",
  description: "Admin-app users who are members of the active workspace, with their role bindings and last session timestamp.",
  security: SECURITY,
  responses: {
    200: { description: "OK", content: { "application/json": { schema: z.object({ data: z.array(UserRow) }) } } },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "post",
  path: "/api/users/{id}/roles",
  tags: [TAG],
  summary: "Attach a role",
  description: "Bind a workspace-scoped role to the user. Idempotent.",
  security: SECURITY,
  request: {
    params: z.object({ id: z.string() }),
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({ roleId: z.string() }).openapi("UserAttachRoleInput"),
        },
      },
    },
  },
  responses: {
    200: { description: "Bound", content: { "application/json": { schema: OkSchema } } },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "delete",
  path: "/api/users/{id}/roles/{roleId}",
  tags: [TAG],
  summary: "Detach a role",
  description: "Removes the (user, role) binding. Idempotent.",
  security: SECURITY,
  request: { params: z.object({ id: z.string(), roleId: z.string() }) },
  responses: {
    200: { description: "Removed", content: { "application/json": { schema: OkSchema } } },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "post",
  path: "/api/users/invite",
  tags: [TAG],
  summary: "Email-invite a user",
  description: "Sends an invite email; the actual user record is created when the invitee verifies.",
  security: SECURITY,
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z
            .object({ email: z.string().email(), role: z.string().optional() })
            .openapi("UserInviteInput"),
        },
      },
    },
  },
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": {
          schema: z.object({ data: z.object({ email: z.string(), sent: z.boolean() }) }),
        },
      },
    },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "patch",
  path: "/api/users/{id}/suspend",
  tags: [TAG],
  summary: "Suspend a user",
  description: "Marks the workspace membership suspended and revokes the user's global sessions.",
  security: SECURITY,
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: "Suspended", content: { "application/json": { schema: OkSchema } } },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "patch",
  path: "/api/users/{id}/activate",
  tags: [TAG],
  summary: "Reactivate a user",
  description: "Re-enables a suspended workspace membership.",
  security: SECURITY,
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: "Activated", content: { "application/json": { schema: OkSchema } } },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "post",
  path: "/api/users/{id}/sessions/revoke-all",
  tags: [TAG],
  summary: "Revoke all user sessions",
  description: "Drops every better-auth session for the user. Gated on workspace membership.",
  security: SECURITY,
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: "Revoked", content: { "application/json": { schema: OkSchema } } },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "delete",
  path: "/api/users/{id}",
  tags: [TAG],
  summary: "Remove from workspace",
  description: "Removes the user from the active workspace; the global user record is preserved.",
  security: SECURITY,
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: "Removed", content: { "application/json": { schema: OkSchema } } },
    ...errorResponses,
  },
});
