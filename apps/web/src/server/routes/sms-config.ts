import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { AppError, SYSTEM_ROLES } from "@backlex/core";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { SECURITY, OkSchema, errorResponses } from "../lib/openapi";
import { enforceIpRateLimit } from "../lib/auth-rate-limit";
import { SMS_PROVIDER_IDS } from "../lib/sms-select";
import { GLOBAL_SMS_CONFIG_ID, SMS_SECRET_KEYS } from "../services/sms-config";
import {
  mergeConfigSecrets,
  readOwnConfigRow,
  saveOwnConfigRow,
} from "../services/provider-config";
import { sendSmsToUsers } from "../services/sms";
import { invalidateAllSmsCaches, invalidateSmsCache } from "../context";
import { defaultHook } from "../lib/openapi-router";

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.smsConfig : sqlite.schema.smsConfig;

const requireAdmin: MiddlewareHandler<AppBindings> = async (c, next) => {
  const auth = c.get("auth");
  if (!auth.roles.includes(SYSTEM_ROLES.admin)) {
    throw new AppError("FORBIDDEN", "Admin role required");
  }
  await next();
};

// Derived from the transport registry so a new provider can't be accepted by
// `sms-select` yet rejected here (or vice versa).
const SmsProvider = z.enum(SMS_PROVIDER_IDS);

const PutInput = z
  .object({
    provider: SmsProvider,
    /** Non-secret provider params (twilio: accountSid/from/messagingServiceSid;
     *  sns: region/accessKeyId/senderId; netgsm: usercode/msgheader;
     *  iletimerkezi: key/sender). Replaces the stored `config` wholesale. */
    config: z.record(z.string(), z.unknown()).optional(),
    /** Per-key plaintext secret (`authToken` twilio, `secretAccessKey` sns,
     *  `password` netgsm, `hash` iletimerkezi). Non-empty = encrypt + store;
     *  empty/null = clear; omitted keys untouched. */
    secrets: z.record(z.string(), z.union([z.string(), z.null()])).optional(),
  })
  .openapi("SmsConfigPutInput");

const SmsTestInput = z
  .object({
    /** Optional E.164 number to send the test to. Defaults to the caller's
     *  registered numbers. */
    to: z.string().regex(/^\+[1-9]\d{6,14}$/).optional(),
  })
  .openapi("SmsTestInput");

/**
 * Which secret keys have a stored ciphertext — never returns the ciphertext.
 * Built from `SMS_SECRET_KEYS` so adding a provider's secret key can't silently
 * leave it out of the "stored" flags (the UI would then look empty and an admin
 * would re-enter it).
 */
const secretsSet = (
  stored: Record<string, string> | null | undefined,
): Record<(typeof SMS_SECRET_KEYS)[number], boolean> => {
  const s = stored ?? {};
  const out = {} as Record<(typeof SMS_SECRET_KEYS)[number], boolean>;
  for (const k of SMS_SECRET_KEYS) {
    const v = s[k];
    out[k] = typeof v === "string" && v.length > 0;
  }
  return out;
};

const tags = ["sms-config"];
const adminGate = [requireUser, requireAdmin];

export const smsConfigRoutes = new OpenAPIHono<AppBindings>({ defaultHook })
  .openapi(
    createRoute({
      method: "get",
      path: "/",
      tags,
      summary: "Read the workspace SMS config",
      description:
        "Returns the active workspace's SMS config. Secret values are never returned — only a per-key 'is it set' flag.",
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
      const tenantId = auth.tenantId ?? GLOBAL_SMS_CONFIG_ID;
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
          env: { provider: ctx.env.SMS_PROVIDER ?? null },
          providerIds: SMS_PROVIDER_IDS,
        },
      });
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/",
      tags,
      summary: "Upsert the workspace SMS config",
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
      const tenantId = auth.tenantId ?? GLOBAL_SMS_CONFIG_ID;
      const t = tableFor(ctx.dialect);

      const existing = await readOwnConfigRow<{
        secrets: Record<string, string> | null;
      }>(ctx, t, tenantId);

      const secrets = await mergeConfigSecrets({
        stored: existing?.secrets,
        patch: body.secrets,
        allowed: SMS_SECRET_KEYS,
        authSecret: ctx.env.AUTH_SECRET,
      });

      // An omitted column means "leave it alone" on an existing row and "use
      // the empty default" on a new one, so it belongs to `onCreate` rather
      // than `always`.
      const always: Record<string, unknown> = { provider: body.provider, secrets };
      const onCreate: Record<string, unknown> = { config: {} };
      if (body.config !== undefined) always.config = body.config;

      await saveOwnConfigRow(ctx, t, tenantId, { always, onCreate });

      if (tenantId === GLOBAL_SMS_CONFIG_ID) {
        invalidateAllSmsCaches(ctx.env);
      } else {
        invalidateSmsCache(ctx.env, tenantId);
      }
      return c.json({ ok: true });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/test",
      tags,
      summary: "Send a test SMS to the caller's numbers (or a given number)",
      security: SECURITY,
      middleware: adminGate,
      request: {
        body: { required: false, content: { "application/json": { schema: SmsTestInput } } },
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
      // Cap per-IP so an admin cookie can't be turned into an SMS-spam pipe.
      await enforceIpRateLimit(c, "sms-test", 5);
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      if (!auth.userId) throw new AppError("VALIDATION", "No caller to send to");
      const body = (c.req.valid("json") ?? {}) as { to?: string };
      const text = "backlex — SMS delivery test. Your workspace SMS transport is working.";

      if (body.to) {
        const adapter = await ctx.smsFor(auth.tenantId ?? null);
        const result = await adapter.send({ to: [body.to], body: text });
        return c.json({ ok: true, sent: result.sent, failed: result.failed });
      }

      const result = await sendSmsToUsers(ctx, auth.tenantId ?? null, {
        userIds: [auth.userId],
        body: text,
      });
      if (result.sent === 0 && result.failed === 0) {
        throw new AppError(
          "VALIDATION",
          "No phone number registered for your account — register one or pass `to`.",
        );
      }
      return c.json({ ok: true, sent: result.sent, failed: result.failed });
    },
  );
