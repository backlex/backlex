/**
 * OAuth client registry — admin routes. Mounted at `/api/admin/oauth-clients`.
 *
 * Instance-level, like the signing keys: there is one authorization server at
 * one issuer, and a client registered with it is registered with the instance.
 */
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { AppError, SYSTEM_ROLES } from "@backlex/core";
import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { SECURITY, OkSchema, errorResponses } from "../lib/openapi";
import {
  createOAuthClient,
  deleteOAuthClient,
  dynamicRegistrationEnabled,
  listOAuthClients,
  listOAuthGrants,
  revokeOAuthGrant,
  setOAuthClientDisabled,
} from "../services/oauth-clients";
import { logActivity } from "../services/activity";
import { defaultHook } from "../lib/openapi-router";

const ClientView = z
  .object({
    id: z.string(),
    clientId: z.string(),
    name: z.string(),
    type: z.string(),
    redirectUrls: z.array(z.string()),
    disabled: z.boolean(),
    dynamic: z.boolean(),
    hasSecret: z.boolean(),
    activeTokens: z.number(),
    createdAt: z.number().nullable(),
  })
  .openapi("OAuthClient");

const GrantView = z
  .object({
    id: z.string(),
    clientId: z.string(),
    clientName: z.string(),
    userId: z.string(),
    scopes: z.array(z.string()),
    createdAt: z.number().nullable(),
  })
  .openapi("OAuthGrant");

const requireAdminMiddleware: MiddlewareHandler<AppBindings> = async (c, next) => {
  const auth = c.get("auth");
  if (!auth.roles.includes(SYSTEM_ROLES.admin)) {
    throw new AppError("FORBIDDEN", "Admin role required");
  }
  await next();
};
const adminGate = [requireUser, requireAdminMiddleware];

const tags = ["oauth-clients"];

export const oauthClientsRoutes = new OpenAPIHono<AppBindings>({ defaultHook })
  .openapi(
    createRoute({
      method: "get",
      path: "/",
      tags,
      summary: "List OAuth clients",
      description:
        "Every client this authorization server knows, including the ones that arrived through " +
        "dynamic registration — `dynamic: true` marks those, because nobody vetted them. Client " +
        "secrets are never included.",
      security: SECURITY,
      middleware: adminGate,
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": {
              schema: z.object({
                data: z.array(ClientView),
                dynamicRegistration: z.boolean().openapi({
                  description:
                    "Whether open dynamic client registration is currently accepted " +
                    "(`OAUTH_DYNAMIC_REGISTRATION=off` refuses it).",
                }),
              }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) =>
      c.json({
        data: await listOAuthClients(c.get("ctx")),
        dynamicRegistration: dynamicRegistrationEnabled(c.get("ctx").env),
      }),
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/",
      tags,
      summary: "Register a client",
      description:
        "The client secret is returned ONCE, and only for a confidential client — a public client " +
        "gets none, because PKCE is what protects it and a secret shipped in a browser or a CLI " +
        "is not a secret. Redirect URIs must be https, or http on loopback for a native app.",
      security: SECURITY,
      middleware: adminGate,
      request: {
        body: {
          required: true,
          content: {
            "application/json": {
              schema: z
                .object({
                  name: z.string().min(1).max(120),
                  redirectUrls: z.array(z.string()).min(1),
                  type: z.enum(["public", "confidential"]).optional(),
                })
                .openapi("OAuthClientInput"),
            },
          },
        },
      },
      responses: {
        201: {
          description: "Registered",
          content: {
            "application/json": {
              schema: z.object({
                data: ClientView,
                clientSecret: z.string().nullable().openapi({
                  description: "Shown once. Null for a public client.",
                }),
              }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const res = await createOAuthClient(c.get("ctx"), auth.userId!, c.req.valid("json"));
      await logActivity(c, {
        action: "create",
        collection: "system_oauth_clients",
        itemId: res.client.clientId,
        // The client id identifies it; the secret is never written anywhere
        // but the response and the row.
        payload: { name: res.client.name, type: res.client.type },
      });
      return c.json({ data: res.client, clientSecret: res.clientSecret }, 201);
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/{clientId}",
      tags,
      summary: "Enable or disable a client",
      description:
        "Disabling stops the client immediately and keeps its history — which tokens it holds, " +
        "who consented, when. That is the difference from deleting.",
      security: SECURITY,
      middleware: adminGate,
      request: {
        params: z.object({ clientId: z.string() }),
        body: {
          required: true,
          content: { "application/json": { schema: z.object({ disabled: z.boolean() }) } },
        },
      },
      responses: {
        200: { description: "OK", content: { "application/json": { schema: OkSchema } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const { clientId } = c.req.valid("param");
      const { disabled } = c.req.valid("json");
      await setOAuthClientDisabled(c.get("ctx"), clientId, disabled);
      await logActivity(c, {
        action: "update",
        collection: "system_oauth_clients",
        itemId: clientId,
        payload: { disabled },
      });
      return c.json({ ok: true });
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/{clientId}",
      tags,
      summary: "Delete a client",
      description:
        "Cascades its tokens and consents away. For a client that misbehaved, disable it instead — " +
        "the history is the evidence.",
      security: SECURITY,
      middleware: adminGate,
      request: { params: z.object({ clientId: z.string() }) },
      responses: {
        200: { description: "OK", content: { "application/json": { schema: OkSchema } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const { clientId } = c.req.valid("param");
      await deleteOAuthClient(c.get("ctx"), clientId);
      await logActivity(c, {
        action: "delete",
        collection: "system_oauth_clients",
        itemId: clientId,
      });
      return c.json({ ok: true });
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/grants",
      tags,
      summary: "List the consents this server holds",
      description: "Who has authorised which client, and for what scopes.",
      security: SECURITY,
      middleware: adminGate,
      request: {
        query: z.object({
          userId: z.string().optional(),
          clientId: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(500).optional(),
        }),
      },
      responses: {
        200: {
          description: "OK",
          content: { "application/json": { schema: z.object({ data: z.array(GrantView) }) } },
        },
        ...errorResponses,
      },
    }),
    async (c) => c.json({ data: await listOAuthGrants(c.get("ctx"), c.req.valid("query")) }),
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/grants/revoke",
      tags,
      summary: "Take a grant back",
      description:
        "Deletes the consent AND every token issued under it. Removing only the consent would be " +
        "a revocation that does not revoke — the access token would keep working until it expired " +
        "and the refresh token would keep minting more.",
      security: SECURITY,
      middleware: adminGate,
      request: {
        body: {
          required: true,
          content: {
            "application/json": {
              schema: z.object({ clientId: z.string(), userId: z.string() }),
            },
          },
        },
      },
      responses: {
        200: {
          description: "Revoked",
          content: {
            "application/json": {
              schema: z.object({ ok: z.boolean(), tokensRevoked: z.number() }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const { clientId, userId } = c.req.valid("json");
      const res = await revokeOAuthGrant(c.get("ctx"), clientId, userId);
      await logActivity(c, {
        action: "delete",
        collection: "system_oauth_grants",
        itemId: `${clientId}:${userId}`,
        payload: { tokensRevoked: res.tokensRevoked },
      });
      return c.json({ ok: true, ...res });
    },
  );
