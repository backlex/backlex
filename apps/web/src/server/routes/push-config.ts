import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { AppError, SYSTEM_ROLES } from "@backlex/core";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { SECURITY, OkSchema, errorResponses } from "../lib/openapi";
import { enforceIpRateLimit } from "../lib/auth-rate-limit";
import { PUSH_PROVIDER_IDS } from "../lib/push-select";
import { GLOBAL_PUSH_CONFIG_ID, PUSH_SECRET_KEYS } from "../services/push-config";
import {
  mergeConfigSecrets,
  readOwnConfigRow,
  saveOwnConfigRow,
} from "../services/provider-config";
import { sendPushToUsers } from "../services/push";
import { invalidateAllPushCaches, invalidatePushCache } from "../context";
import { defaultHook } from "../lib/openapi-router";

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.pushConfig : sqlite.schema.pushConfig;

const requireAdmin: MiddlewareHandler<AppBindings> = async (c, next) => {
  const auth = c.get("auth");
  if (!auth.roles.includes(SYSTEM_ROLES.admin)) {
    throw new AppError("FORBIDDEN", "Admin role required");
  }
  await next();
};

const PushProvider = z.enum(["inherit", "console", "fcm", "apns", "web-push"]);

const PutInput = z
  .object({
    provider: PushProvider,
    /** Non-secret provider params (fcm: projectId/clientEmail; apns:
     *  keyId/teamId/bundleId/production; web-push: subject/vapidPublicKey).
     *  Replaces the stored `config` wholesale. */
    config: z.record(z.string(), z.unknown()).optional(),
    /** Per-key plaintext secret (`privateKey` for fcm/apns, `vapidPrivateKey`
     *  for web-push). Non-empty = encrypt + store; empty/null = clear; omitted
     *  keys untouched. */
    secrets: z.record(z.string(), z.union([z.string(), z.null()])).optional(),
  })
  .openapi("PushConfigPutInput");

const PushTestInput = z.object({}).openapi("PushTestInput");

/** Which secret keys have a stored ciphertext — never returns the ciphertext. */
const secretsSet = (
  stored: Record<string, string> | null | undefined,
): Record<(typeof PUSH_SECRET_KEYS)[number], boolean> => {
  const s = stored ?? {};
  return {
    privateKey: typeof s.privateKey === "string" && s.privateKey.length > 0,
    vapidPrivateKey: typeof s.vapidPrivateKey === "string" && s.vapidPrivateKey.length > 0,
  };
};

const tags = ["push-config"];
const adminGate = [requireUser, requireAdmin];

export const pushConfigRoutes = new OpenAPIHono<AppBindings>({ defaultHook })
  .openapi(
    createRoute({
      method: "get",
      path: "/",
      tags,
      summary: "Read the workspace push config",
      description:
        "Returns the active workspace's push config. Secret values are never returned — only a per-key 'is it set' flag.",
      security: SECURITY,
      middleware: adminGate,
      responses: {
        200: { description: "OK", content: { "application/json": { schema: z.any() } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const tenantId = auth.tenantId ?? GLOBAL_PUSH_CONFIG_ID;
      const row = await readOwnConfigRow<{
        provider: string;
        config: Record<string, unknown> | null;
        secrets: Record<string, string> | null;
        updatedAt: unknown;
      }>(ctx, tableFor(ctx.dialect), tenantId);
      return c.json({
        data: {
          tenantId,
          provider: row?.provider ?? "inherit",
          config: row?.config ?? {},
          secretsSet: secretsSet(row?.secrets),
          updatedAt: row?.updatedAt ?? null,
          env: { provider: ctx.env.PUSH_PROVIDER ?? null },
          providerIds: PUSH_PROVIDER_IDS,
        },
      });
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/",
      tags,
      summary: "Upsert the workspace push config",
      description:
        "Plaintext secrets are encrypted (AES-256-GCM, key derived from `AUTH_SECRET`) before storage.",
      security: SECURITY,
      middleware: adminGate,
      request: {
        body: { required: true, content: { "application/json": { schema: PutInput } } },
      },
      responses: {
        200: { description: "Saved", content: { "application/json": { schema: OkSchema } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const body = c.req.valid("json");
      const tenantId = auth.tenantId ?? GLOBAL_PUSH_CONFIG_ID;
      const t = tableFor(ctx.dialect);

      const existing = await readOwnConfigRow<{
        secrets: Record<string, string> | null;
      }>(ctx, t, tenantId);

      const secrets = await mergeConfigSecrets({
        stored: existing?.secrets,
        patch: body.secrets,
        allowed: PUSH_SECRET_KEYS,
        authSecret: ctx.env.AUTH_SECRET,
      });

      // An omitted column means "leave it alone" on an existing row and "use
      // the empty default" on a new one, so it belongs to `onCreate` rather
      // than `always`.
      const always: Record<string, unknown> = { provider: body.provider, secrets };
      const onCreate: Record<string, unknown> = { config: {} };
      if (body.config !== undefined) always.config = body.config;

      await saveOwnConfigRow(ctx, t, tenantId, { always, onCreate });

      if (tenantId === GLOBAL_PUSH_CONFIG_ID) {
        invalidateAllPushCaches(ctx.env);
      } else {
        invalidatePushCache(ctx.env, tenantId);
      }
      return c.json({ ok: true });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/test",
      tags,
      summary: "Send a test push to the caller's own devices",
      security: SECURITY,
      middleware: adminGate,
      request: {
        body: { required: false, content: { "application/json": { schema: PushTestInput } } },
      },
      responses: {
        200: {
          description: "Sent",
          content: {
            "application/json": {
              schema: z.object({ ok: z.boolean(), sent: z.number(), failed: z.number() }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      // Cap per-IP so an admin cookie can't be turned into a push-spam pipe.
      await enforceIpRateLimit(c, "push-test", 5);
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      if (!auth.userId) throw new AppError("VALIDATION", "No caller to send to");
      const result = await sendPushToUsers(ctx, auth.tenantId ?? null, {
        userIds: [auth.userId],
        title: "backlex — push delivery test",
        body: "Your workspace push transport is working.",
      });
      if (result.sent === 0 && result.failed === 0) {
        throw new AppError(
          "VALIDATION",
          "No active devices registered for your account — register one first.",
        );
      }
      return c.json({ ok: true, sent: result.sent, failed: result.failed });
    },
  );
