import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { and, eq, isNull } from "drizzle-orm";
import { AppError, SYSTEM_ROLES } from "@workeros/core";
import * as pg from "@workeros/db/pg";
import * as sqlite from "@workeros/db/sqlite";
import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { SECURITY, OkSchema, errorResponses } from "../lib/openapi";
import { loadAppSettings } from "../services/settings";

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.appSettings : sqlite.schema.appSettings;

const requireAdmin = (auth: { roles: string[] }) => {
  if (!auth.roles.includes(SYSTEM_ROLES.admin))
    throw new AppError("FORBIDDEN", "Admin role required");
};

const requireAdminMw: MiddlewareHandler<AppBindings> = async (c, next) => {
  requireAdmin(c.get("auth"));
  await next();
};

/**
 * Whitelist of runtime-mutable settings. Anything not here is deploy-time
 * config (env vars / wrangler bindings) and is read-only via `/runtime` —
 * we deliberately reject writes to keys like `appUrl`, `emailFrom`, or
 * `env.*` so the Settings UI can't pretend it manages those.
 */
const LocaleCode = z
  .string()
  .min(2)
  .max(8)
  .regex(/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})?$/, "Invalid locale code");

const SettingsInput = z
  .object({
    siteName: z.string().min(1).max(120).optional(),
    openSignup: z.boolean().optional(),
    i18nLocales: z.array(LocaleCode).min(1).max(50).optional(),
    i18nDefaultLocale: LocaleCode.optional(),
  })
  .strict()
  .refine(
    (v) =>
      !v.i18nDefaultLocale ||
      !v.i18nLocales ||
      v.i18nLocales.includes(v.i18nDefaultLocale),
    {
      message: "i18nDefaultLocale must be in i18nLocales",
      path: ["i18nDefaultLocale"],
    },
  )
  .openapi("SettingsInput");

const SettingsRow = z
  .object({
    siteName: z.string().nullable().optional(),
    openSignup: z.boolean().optional(),
    i18nLocales: z.array(z.string()).optional(),
    i18nDefaultLocale: z.string().nullable().optional(),
    appUrl: z.string(),
    emailFrom: z.string().nullable(),
  })
  .passthrough()
  .openapi("Settings");

const Binding = z.object({
  type: z.string(),
  name: z.string(),
  target: z.string(),
  status: z.string(),
});

const EnvVar = z.object({
  key: z.string(),
  set: z.boolean(),
  source: z.string(),
  secret: z.boolean(),
});

const RuntimeInfo = z
  .object({
    adapter: z.string(),
    dialect: z.string(),
    bindings: z.array(Binding),
    envVars: z.array(EnvVar),
    version: z.string(),
  })
  .openapi("RuntimeInfo");

const TAG = "settings";

export const settingsRoutes = new OpenAPIHono<AppBindings>()
  /** Returns the active tenant's settings plus the env-derived values the
   *  UI shows read-only (`appUrl`, `emailFrom`). */
  .openapi(
    createRoute({
      method: "get",
      path: "/",
      tags: [TAG],
      summary: "Get settings",
      description:
        "Active workspace's runtime-mutable settings plus env-derived `appUrl`/`emailFrom` (read-only).",
      security: SECURITY,
      middleware: [requireUser, requireAdminMw],
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": { schema: z.object({ data: SettingsRow }) },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const settings = await loadAppSettings(
        ctx.db,
        ctx.dialect,
        auth.tenantId ?? null,
      );
      return c.json({
        data: {
          ...settings,
          appUrl: ctx.env.APP_URL,
          emailFrom: ctx.env.EMAIL_FROM ?? null,
        },
      });
    },
  )
  /** Patch the whitelisted settings; merges into the existing key/value rows. */
  .openapi(
    createRoute({
      method: "patch",
      path: "/",
      tags: [TAG],
      summary: "Patch settings",
      description: "Whitelisted keys only. Unknown keys are rejected (strict).",
      security: SECURITY,
      middleware: [requireUser, requireAdminMw],
      request: {
        body: {
          required: true,
          content: { "application/json": { schema: SettingsInput } },
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
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const body = c.req.valid("json");
      const t = tableFor(ctx.dialect);
      for (const [key, value] of Object.entries(body)) {
        if (value === undefined) continue;
        const existing = (await (ctx.db as any)
          .select({ id: t.id })
          .from(t)
          .where(
            and(
              eq(t.key, key),
              auth.tenantId ? eq(t.tenantId, auth.tenantId) : isNull(t.tenantId),
            ),
          )
          .limit(1)) as { id: string }[];
        if (existing[0]) {
          await (ctx.db as any)
            .update(t)
            .set({
              value,
              updatedAt: ctx.dialect === "pg" ? new Date() : Date.now(),
            })
            .where(eq(t.id, existing[0].id));
        } else {
          await (ctx.db as any).insert(t).values({
            id: crypto.randomUUID(),
            tenantId: auth.tenantId ?? null,
            key,
            value,
          });
        }
      }
      return c.json({ ok: true });
    },
  )
  /**
   * Read-only runtime info: which env vars are set, which bindings are
   * present, package version. The Settings → Bindings/Environment tabs
   * read this — they never write back (those changes happen via
   * `wrangler.toml` + `wrangler secret` + redeploy).
   */
  .openapi(
    createRoute({
      method: "get",
      path: "/runtime",
      tags: [TAG],
      summary: "Runtime info",
      description:
        "Read-only adapter/dialect + env var presence + binding inventory. Changes require redeploy.",
      security: SECURITY,
      middleware: [requireUser, requireAdminMw],
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": { schema: z.object({ data: RuntimeInfo }) },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const env = ctx.env as unknown as Record<string, unknown>;
      const present = (k: string) =>
        env[k] !== undefined && env[k] !== null && env[k] !== "";
      const bindings = [
        { type: "D1", name: "D1", target: "workeros (D1)", status: env.D1 ? "connected" : "optional" },
        { type: "R2", name: "R2", target: "workeros-files (R2)", status: env.R2 ? "connected" : "optional" },
        { type: "DurableObj", name: "REALTIME", target: "RealtimeRoom", status: env.REALTIME ? "connected" : "optional" },
        { type: "Vectorize", name: "VECTORIZE_OPENAI", target: "workeros-openai-1536", status: env.VECTORIZE_OPENAI ? "connected" : "optional" },
        { type: "Vectorize", name: "VECTORIZE_OPENAI_LARGE", target: "workeros-openai-3072", status: env.VECTORIZE_OPENAI_LARGE ? "connected" : "optional" },
        { type: "Vectorize", name: "VECTORIZE_BGE_M3", target: "workeros-bge-m3", status: env.VECTORIZE_BGE_M3 ? "connected" : "optional" },
        { type: "Vectorize", name: "VECTORIZE_SELF_HOST_BGE_M3", target: "workeros-self-host-bge-m3", status: env.VECTORIZE_SELF_HOST_BGE_M3 ? "connected" : "optional" },
        { type: "WorkersAI", name: "AI", target: "@cf/baai/bge-m3", status: env.AI ? "connected" : "optional" },
        { type: "HTTP", name: "EMBEDDING_HTTP_URL", target: "self-host embeddings", status: env.EMBEDDING_HTTP_URL ? "connected" : "optional" },
        { type: "Hyperdrive", name: "HYPERDRIVE", target: "pg-pool", status: env.HYPERDRIVE ? "connected" : "optional" },
      ];
      const envVars = [
        { key: "APP_URL", set: present("APP_URL"), source: "env", secret: false },
        { key: "DATABASE_URL", set: present("DATABASE_URL"), source: "env", secret: true },
        { key: "AUTH_SECRET", set: present("AUTH_SECRET"), source: "env", secret: true },
        { key: "AUTH_PLUGINS", set: present("AUTH_PLUGINS"), source: "env", secret: false },
        { key: "EMAIL_PROVIDER", set: present("EMAIL_PROVIDER"), source: "env", secret: false },
        { key: "EMAIL_FROM", set: present("EMAIL_FROM"), source: "env", secret: false },
        { key: "RESEND_API_KEY", set: present("RESEND_API_KEY"), source: "env", secret: true },
        { key: "SENDGRID_API_KEY", set: present("SENDGRID_API_KEY"), source: "env", secret: true },
        { key: "MAILGUN_API_KEY", set: present("MAILGUN_API_KEY"), source: "env", secret: true },
        { key: "MAILGUN_DOMAIN", set: present("MAILGUN_DOMAIN"), source: "env", secret: false },
        { key: "SES_REGION", set: present("SES_REGION"), source: "env", secret: false },
        { key: "SES_ACCESS_KEY_ID", set: present("SES_ACCESS_KEY_ID"), source: "env", secret: false },
        { key: "SES_SECRET_ACCESS_KEY", set: present("SES_SECRET_ACCESS_KEY"), source: "env", secret: true },
        { key: "SMTP_HOST", set: present("SMTP_HOST"), source: "env", secret: false },
        { key: "SMTP_PORT", set: present("SMTP_PORT"), source: "env", secret: false },
        { key: "SMTP_USER", set: present("SMTP_USER"), source: "env", secret: false },
        { key: "SMTP_PASSWORD", set: present("SMTP_PASSWORD"), source: "env", secret: true },
        { key: "OPENAI_API_KEY", set: present("OPENAI_API_KEY"), source: "env", secret: true },
        { key: "OAUTH_GOOGLE_CLIENT_ID", set: present("OAUTH_GOOGLE_CLIENT_ID"), source: "env", secret: false },
        { key: "OAUTH_GOOGLE_CLIENT_SECRET", set: present("OAUTH_GOOGLE_CLIENT_SECRET"), source: "env", secret: true },
        { key: "OAUTH_GITHUB_CLIENT_ID", set: present("OAUTH_GITHUB_CLIENT_ID"), source: "env", secret: false },
        { key: "OAUTH_GITHUB_CLIENT_SECRET", set: present("OAUTH_GITHUB_CLIENT_SECRET"), source: "env", secret: true },
        { key: "S3_BUCKET", set: present("S3_BUCKET"), source: "env", secret: false },
        { key: "FUNCTIONS_FETCH_ALLOW", set: present("FUNCTIONS_FETCH_ALLOW"), source: "env", secret: false },
        { key: "FUNCTIONS_EXEC_URL", set: present("FUNCTIONS_EXEC_URL"), source: "env", secret: false },
        { key: "SANDBOX_RPC_TOKEN", set: present("SANDBOX_RPC_TOKEN"), source: "env", secret: true },
      ];
      const adapter = env.D1 ? "workers" : env.DATABASE_URL ? "vercel" : "bun";
      return c.json({
        data: {
          adapter,
          dialect: ctx.dialect,
          bindings,
          envVars,
          version: "v0.9.4",
        },
      });
    },
  );
