import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { AppError, SYSTEM_ROLES } from "@workeros/core";
import * as pg from "@workeros/db/pg";
import * as sqlite from "@workeros/db/sqlite";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { SECURITY, OkSchema, errorResponses } from "../lib/openapi";
import { encryptSecret } from "../lib/crypto";
import { EMAIL_PROVIDER_IDS } from "../lib/email-select";
import { GLOBAL_EMAIL_CONFIG_ID } from "../services/email-config";
import { invalidateTenantAuth } from "../services/tenant-auth";

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.emailConfig : sqlite.schema.emailConfig;

const requireAdmin: MiddlewareHandler<AppBindings> = async (c, next) => {
  const auth = c.get("auth");
  if (!auth.roles.includes(SYSTEM_ROLES.admin)) {
    throw new AppError("FORBIDDEN", "Admin role required");
  }
  await next();
};

/** Secret keys recognised per provider — used to scope what the PUT body may
 *  set and what the GET response advertises as "configured". */
const SECRET_KEYS = ["apiKey", "secretAccessKey", "pass"] as const;
type SecretKey = (typeof SECRET_KEYS)[number];

const EmailProvider = z.enum([
  "inherit",
  "console",
  "resend",
  "sendgrid",
  "mailgun",
  "ses",
  "smtp",
]);

const PutInput = z
  .object({
    provider: EmailProvider,
    fromAddress: z.union([z.string().email(), z.literal(""), z.null()]).optional(),
    /** Non-secret provider params (mailgun: domain/host; ses: region/accessKeyId;
     *  smtp: host/port/secure/user). Replaces the stored `config` wholesale. */
    config: z
      .record(z.string(), z.unknown())
      .optional()
      .openapi({
        description:
          "Non-secret provider params (mailgun domain, ses region, smtp host, etc.). Replaces stored config wholesale.",
      }),
    /** Per-key secret material. A non-empty string is encrypted and stored; `""`
     *  or `null` clears that key; omitted keys are left untouched. */
    secrets: z
      .record(z.string(), z.union([z.string(), z.null()]))
      .optional()
      .openapi({
        description:
          "Per-key plaintext secret (`apiKey`, `secretAccessKey`, `pass`). Non-empty string = encrypt + store; empty/null = clear; omitted keys are left untouched.",
      }),
  })
  .openapi("EmailConfigPutInput");

const EmailConfigResponse = z
  .object({
    tenantId: z.string(),
    provider: z.string(),
    fromAddress: z.string().nullable(),
    config: z.record(z.string(), z.unknown()),
    secretsSet: z.object({
      apiKey: z.boolean(),
      secretAccessKey: z.boolean(),
      pass: z.boolean(),
    }),
    updatedAt: z.unknown().nullable(),
    env: z.object({
      provider: z.string().nullable(),
      from: z.string().nullable(),
    }),
    providerIds: z.array(z.string()),
  })
  .openapi("EmailConfigResponse");

const EmailTestInput = z
  .object({ to: z.string().email().optional() })
  .openapi("EmailTestInput");

/** Which secret keys have a stored ciphertext — never returns the ciphertext. */
const secretsSet = (
  stored: Record<string, string> | null | undefined,
): Record<SecretKey, boolean> => {
  const s = stored ?? {};
  return {
    apiKey: typeof s.apiKey === "string" && s.apiKey.length > 0,
    secretAccessKey:
      typeof s.secretAccessKey === "string" && s.secretAccessKey.length > 0,
    pass: typeof s.pass === "string" && s.pass.length > 0,
  };
};

const tags = ["email-config"];
const adminGate = [requireUser, requireAdmin];

export const emailConfigRoutes = new OpenAPIHono<AppBindings>()
  .openapi(
    createRoute({
      method: "get",
      path: "/",
      tags,
      summary: "Read the workspace email config",
      description:
        "Returns the active workspace's email config. Secret values are never returned — only a per-key 'is it set' flag.",
      security: SECURITY,
      middleware: adminGate,
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": {
              schema: z.any(),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      // Read the active workspace's `email_config` (falls back to the env-derived
      // defaults so the UI shows what the deployment currently sends through).
      // Secret values are never returned — only a per-key "is it set" flag.
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const tenantId = auth.tenantId ?? GLOBAL_EMAIL_CONFIG_ID;
      const t = tableFor(ctx.dialect);
      let row:
        | {
            provider: string;
            fromAddress: string | null;
            config: Record<string, unknown> | null;
            secrets: Record<string, string> | null;
            updatedAt: unknown;
          }
        | undefined;
      try {
        const rows = (await (ctx.db as any)
          .select()
          .from(t)
          .where(eq(t.tenantId, tenantId))
          .limit(1)) as typeof row[];
        row = rows[0];
      } catch {
        row = undefined; // table not migrated yet — show env defaults
      }
      return c.json({
        data: {
          tenantId,
          provider: row?.provider ?? "inherit",
          fromAddress: row?.fromAddress ?? null,
          config: row?.config ?? {},
          secretsSet: secretsSet(row?.secrets),
          updatedAt: row?.updatedAt ?? null,
          /** Deployment-level fallback, for context in the UI. */
          env: {
            provider: ctx.env.EMAIL_PROVIDER ?? null,
            from: ctx.env.EMAIL_FROM ?? null,
          },
          providerIds: EMAIL_PROVIDER_IDS,
        },
      });
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/",
      tags,
      summary: "Upsert the workspace email config",
      description:
        "Plaintext secrets are encrypted (AES-256-GCM, key derived from `AUTH_SECRET`) before storage. Invalidates the tenant auth cache.",
      security: SECURITY,
      middleware: adminGate,
      request: {
        body: {
          required: true,
          content: { "application/json": { schema: PutInput } },
        },
      },
      responses: {
        200: {
          description: "Saved",
          content: { "application/json": { schema: OkSchema } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      // Upsert the active workspace's `email_config`. Plaintext secrets are
      // encrypted into the `secrets` column (AES-256-GCM via lib/crypto) and
      // never stored or returned in the clear.
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const body = c.req.valid("json");
      const tenantId = auth.tenantId ?? GLOBAL_EMAIL_CONFIG_ID;
      const t = tableFor(ctx.dialect);

      const existing = (await (ctx.db as any)
        .select()
        .from(t)
        .where(eq(t.tenantId, tenantId))
        .limit(1)) as { secrets: Record<string, string> | null }[];

      // Merge secrets: encrypt new values, drop cleared ones, keep the rest.
      const secrets: Record<string, string> = { ...(existing[0]?.secrets ?? {}) };
      if (body.secrets) {
        for (const k of SECRET_KEYS) {
          if (!(k in body.secrets)) continue;
          const v = body.secrets[k];
          if (typeof v === "string" && v.trim()) {
            secrets[k] = await encryptSecret(v.trim(), ctx.env.AUTH_SECRET);
          } else {
            delete secrets[k];
          }
        }
      }

      const fromAddress =
        body.fromAddress === undefined
          ? existing[0]
            ? undefined
            : null
          : body.fromAddress || null;
      const config = body.config ?? (existing[0] ? undefined : {});

      if (existing[0]) {
        const set: Record<string, unknown> = {
          provider: body.provider,
          secrets,
          updatedAt: ctx.dialect === "pg" ? new Date() : Date.now(),
        };
        if (fromAddress !== undefined) set.fromAddress = fromAddress;
        if (config !== undefined) set.config = config;
        await (ctx.db as any).update(t).set(set).where(eq(t.tenantId, tenantId));
      } else {
        await (ctx.db as any).insert(t).values({
          tenantId,
          provider: body.provider,
          fromAddress: fromAddress ?? null,
          config: config ?? {},
          secrets,
        });
      }

      // The workspace's end-user better-auth instance caches its email
      // transport — drop it so the next request rebuilds from the new config.
      if (auth.tenantId) invalidateTenantAuth(auth.tenantId);
      return c.json({ ok: true });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/test",
      tags,
      summary: "Send a test email through the resolved transport",
      security: SECURITY,
      middleware: adminGate,
      request: {
        body: {
          required: false,
          content: { "application/json": { schema: EmailTestInput } },
        },
      },
      responses: {
        200: {
          description: "Sent",
          content: {
            "application/json": {
              schema: z.object({ ok: z.boolean(), to: z.string() }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      // Send a one-off test email through the *resolved* transport for the
      // active workspace (its `email_config` → instance default → env adapter).
      // Useful to verify credentials right after saving without needing a template.
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const body = await c.req
        .json()
        .then((b) => EmailTestInput.parse(b ?? {}))
        .catch(() => EmailTestInput.parse({}));
      const to = body.to ?? auth.email;
      if (!to) throw new AppError("VALIDATION", "No recipient — pass `to`");
      const transport = await ctx.emailFor(auth.tenantId ?? null);
      await transport.send({
        to,
        subject: "workeros — email delivery test",
        text: `This is a test message confirming your workspace email transport is working.\n\nSent from ${ctx.env.APP_URL} at ${new Date().toISOString()}.`,
        html: `<p>This is a test message confirming your workspace email transport is working.</p><p style="color:#888;font-size:12px">Sent from ${ctx.env.APP_URL} at ${new Date().toISOString()}.</p>`,
      });
      return c.json({ ok: true, to });
    },
  );
