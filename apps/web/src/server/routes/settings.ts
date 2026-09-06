import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { AppError, SYSTEM_ROLES } from "@backlex/core";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { isInstanceOperator, requirePlatformMw } from "../services/roles/guards";
import { SECURITY, OkSchema, errorResponses, httpUrl } from "../lib/openapi";
import { isCloudflareWorkers, isDenoDeploy, isNetlify } from "../lib/runtime";
import {
  GLOBAL_SETTINGS_TENANT_ID,
  loadAppSettings,
  loadPasswordLoginMode,
  loadSignInBranding,
  SIGN_IN_BRANDING_KEYS,
} from "../services/settings";
import { resolvePlatformAuthSurface } from "../services/auth-config";
import { timeZoneCode } from "../lib/locale";
import { defaultHook } from "../lib/openapi-router";

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
    i18nLocales: z.array(LocaleCode).min(1).max(50).optional(),
    i18nDefaultLocale: LocaleCode.optional(),
    /** Workspace default IANA time zone — applied to users with no personal
     *  `users.timezone` set. */
    timezone: timeZoneCode.optional(),
    /**
     * Workspace default currency — the code the admin pre-selects when a money
     * field is created. Display/authoring convenience only: it is copied onto
     * the field at creation time and never read at runtime, because a stored
     * amount whose currency could change with a settings toggle would silently
     * restate every price in the workspace.
     */
    defaultCurrency: z
      .string()
      .regex(/^[A-Za-z]{3}$/, "Expected a three-letter ISO-4217 code")
      .optional(),
    /** Instance-global copy for the public sign-in screen — persisted on the
     *  `_global` sentinel row, not per-workspace. Blank = built-in default. */
    signInHeadline: z.string().max(120).optional(),
    signInTagline: z.string().max(280).optional(),
    /** Sign-up consent links. Empty string clears (hides) the link; otherwise
     *  must be a valid absolute URL. Also instance-global (the `_global` row). */
    termsUrl: z.union([z.literal(""), httpUrl(2048)]).optional(),
    privacyUrl: z.union([z.literal(""), httpUrl(2048)]).optional(),
    /** Whether an email + password may be exchanged for a session, and on which
     *  plane. Instance-global (the `_global` row). Leaving `enabled` is gated
     *  on another way in existing — see the lock-out check in the handler. */
    passwordLogin: z.enum(["enabled", "app-only", "disabled"]).optional(),
    /** Saved Schema-graph (ERD) node positions, keyed by collection slug.
     *  Admin-UI convenience state only — capped at 500 collections to keep the
     *  settings row small. */
    erdLayout: z
      .record(z.string(), z.object({ x: z.number(), y: z.number() }))
      .refine((v) => Object.keys(v).length <= 500, {
        message: "Too many collections in erdLayout",
      })
      .optional(),
    /** Per-collection list-view columns (slug → ordered field names). Admin-UI
     *  convenience state; capped to keep the settings row small. */
    listColumns: z
      .record(z.string(), z.array(z.string()).max(60))
      .refine((v) => Object.keys(v).length <= 500, {
        message: "Too many collections in listColumns",
      })
      .optional(),
    /** Ordered group-header names for the Collections page + sidebar tree.
     *  Names not in this list append alphabetically; ungrouped renders last.
     *  Usually written by `POST /api/collections/layout`, not this route. */
    collectionGroups: z.array(z.string().min(1).max(60)).max(200).optional(),
    /** Automatic schema-snapshot cadence + retention (#9). */
    schemaSnapshotSchedule: z.enum(["off", "daily", "weekly"]).optional(),
    schemaSnapshotKeepLast: z.number().int().min(1).max(50).optional(),
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

/** The instance-wide tier: one value per deployment, shared by every workspace
 *  on it. Nothing here is the calling workspace's to own. */
const GlobalSettings = z
  .object({
    signInHeadline: z.string(),
    signInTagline: z.string(),
    termsUrl: z.string(),
    privacyUrl: z.string(),
    passwordLogin: z.enum(["enabled", "app-only", "disabled"]),
  })
  .openapi("GlobalSettings");

const SettingsRow = z
  .object({
    i18nLocales: z.array(z.string()).optional(),
    i18nDefaultLocale: z.string().nullable().optional(),
    timezone: z.string().optional(),
    /** The calling workspace's OWN values — nothing instance-wide is in here. */
    workspace: z.record(z.string(), z.unknown()),
    /** The instance-wide values, named as such rather than mixed in. */
    global: GlobalSettings,
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
    commit: z.string(),
    released: z.string(),
    wrangler: z.string(),
  })
  .openapi("RuntimeInfo");

const TAG = "settings";

export const settingsRoutes = new OpenAPIHono<AppBindings>({ defaultHook })
  /** Returns the active tenant's settings plus the env-derived values the
   *  UI shows read-only (`appUrl`, `emailFrom`). */
  .openapi(
    createRoute({
      method: "get",
      path: "/",
      tags: [TAG],
      summary: "Get settings",
      description:
        "Active workspace's runtime-mutable settings under `workspace`, the instance-wide tier under `global`, plus env-derived `appUrl`/`emailFrom` (read-only). Both tiers are ALSO mirrored flat at the top level for compatibility; prefer the two blocks.",
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
      const [workspace, branding, passwordLogin] = await Promise.all([
        loadAppSettings(ctx.db, ctx.dialect, auth.tenantId ?? null),
        loadSignInBranding(ctx.db, ctx.dialect),
        loadPasswordLoginMode(ctx.db, ctx.dialect),
      ]);
      // Two tiers answer this endpoint and they are not the same kind of thing:
      // `workspace` is what THIS workspace chose, `global` is one value for the
      // whole deployment that only the instance operator may write. Spreading
      // both flat — which is all this used to do — meant every workspace read
      // the operator's sign-in copy back as if it had chosen it, and there was
      // no way for a caller to tell the two apart. Now there is: a field's tier
      // is the block it appears in.
      //
      // The flat mirror stays for one release because the admin SPA, the CLI
      // and the MCP settings tool all read these keys at the top level today,
      // and none of those files is owned by this change. New callers should
      // read `data.workspace` / `data.global`; the mirror goes when the last
      // top-level reader does.
      const global = { ...branding, passwordLogin };
      return c.json({
        data: {
          ...workspace,
          ...global,
          workspace,
          global,
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
      // The plane gate is explicit here as well as in the firewall: this
      // handler is the one that can write the instance-global `_global` row, so it
      // should not be reachable by an app-plane identity even for the instant
      // before the operator check refuses them.
      middleware: [requireUser, requirePlatformMw, requireAdminMw],
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
      // Turning the password off with nothing else configured locks every admin
      // out of their own instance, and the fix would be a manual DB write. The
      // admin sign-in screen's own provider list is the authority on what is
      // left: if nothing but the password survives, refuse the change.
      const globalKeys = new Set<string>(SIGN_IN_BRANDING_KEYS);
      // These five keys land on the instance-global `_global` row, which is
      // correct — the sign-in page is shown before any workspace is selected,
      // so it can only have one answer. What was wrong is who could write it.
      //
      // `requireAdminMw` proves the caller is admin of THEIR OWN workspace, and
      // `POST /api/tenants` hands that role to any authenticated user for the
      // price of clicking "New workspace". So a stranger could rewrite the
      // sign-in headline, tagline and Terms/Privacy links every other admin on
      // the deployment sees — a ready-made phishing surface on the login page —
      // and, via `passwordLogin`, lock everyone else out of a dashboard whose
      // only recovery is `OWNER_EMAIL` or SQL.
      //
      // An instance-global write needs instance-global standing. The check runs
      // once, before any row is touched, so a mixed body is refused whole
      // rather than half-applied.
      if (Object.keys(body).some((k) => globalKeys.has(k))) {
        if (!(await isInstanceOperator(ctx, auth))) {
          throw new AppError(
            "FORBIDDEN",
            "Sign-in branding is instance-wide, so only the instance operator may change it — sign in as an admin of the default workspace, or set OWNER_EMAIL to your address",
          );
        }
      }

      // Turning the password off with nothing else configured locks every admin
      // out of their own instance, and the fix would be a manual DB write. The
      // admin sign-in screen's own provider list is the authority on what is
      // left: if nothing but the password survives, refuse the change.
      //
      // This runs AFTER the operator gate, and the order is load-bearing.
      // `passwordLogin` is one of the instance-global keys, so a non-operator
      // can never write it — but with the guard first they still reached it,
      // and its 422 ("enable another way in first") versus a 200 answered a
      // question they were not entitled to ask: whether this deployment has a
      // second way in. Refuse before you reveal.
      if (body.passwordLogin && body.passwordLogin !== "enabled") {
        const surface = await resolvePlatformAuthSurface(
          { db: ctx.db as any, dialect: ctx.dialect },
          ctx.env,
          auth.tenantId ?? null,
        );
        const alternatives = surface.providers.filter(
          (p) => p.kind !== "credential" && p.enabled !== false,
        );
        if (alternatives.length === 0) {
          throw new AppError(
            "VALIDATION",
            "Enable another way in first — SSO, a passkey, a magic link or an email code. Turning off the password with nothing else configured would lock every admin out.",
          );
        }
      }
      for (const [key, value] of Object.entries(body)) {
        if (value === undefined) continue;
        // Login-screen branding is instance-global — the sign-in page is shown
        // before any workspace is selected — so it lands on the `_global`
        // sentinel row. Everything else is scoped to the workspace.
        //
        // A caller with no active workspace has no workspace tier to write to,
        // so their non-global keys fall to the same sentinel rather than to a
        // NULL that would read back as "instance-wide" by accident. That
        // accident is exactly the ambiguity the sentinel exists to remove.
        const scopeTenantId = globalKeys.has(key)
          ? GLOBAL_SETTINGS_TENANT_ID
          : (auth.tenantId ?? GLOBAL_SETTINGS_TENANT_ID);
        const updatedAt = ctx.dialect === "pg" ? new Date() : Date.now();
        // Every key now goes through ONE atomic upsert keyed on the
        // `(tenant_id, key)` unique index. The old select-then-insert/update
        // was a check-then-act race: two concurrent PATCHes for a not-yet-
        // existing key both saw "no row" and both INSERTed, and the loser hit
        // `UNIQUE constraint failed: app_settings.tenant_id, app_settings.key`
        // → a 500 (confirmed via a concurrent-write load test). ON CONFLICT
        // collapses that to a single write with no window.
        //
        // The global keys could not take this path before, and the sentinel is
        // why they can now: SQLite/D1 treat NULLs as DISTINCT inside a unique
        // index, so `ON CONFLICT (tenant_id, key)` never matched the old NULL
        // row and the branding writes kept a hand-rolled select-then-update
        // (and, with it, the race). `'_global'` is an ordinary value and
        // conflicts like any other.
        //
        // Nothing here deletes the pre-sentinel `tenant_id IS NULL` row: an
        // isolate still running the previous release reads it, and this write
        // already wins for every new reader (the sentinel row shadows the
        // legacy one — see `readGlobalRows`). The reader logs when the legacy
        // row is what answered, which is the signal for deleting both it and
        // the fallback a release from now.
        await (ctx.db as any)
          .insert(t)
          .values({ id: crypto.randomUUID(), tenantId: scopeTenantId, key, value })
          .onConflictDoUpdate({ target: [t.tenantId, t.key], set: { value, updatedAt } });
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
        { type: "D1", name: "D1", target: "backlex (D1)", status: env.D1 ? "connected" : "optional" },
        { type: "R2", name: "R2", target: "backlex-files (R2)", status: env.R2 ? "connected" : "optional" },
        { type: "DurableObj", name: "REALTIME", target: "RealtimeRoom", status: env.REALTIME ? "connected" : "optional" },
        { type: "Vectorize", name: "VECTORIZE_OPENAI", target: "backlex-openai-1536", status: env.VECTORIZE_OPENAI ? "connected" : "optional" },
        { type: "Vectorize", name: "VECTORIZE_OPENAI_LARGE", target: "backlex-openai-3072", status: env.VECTORIZE_OPENAI_LARGE ? "connected" : "optional" },
        { type: "Vectorize", name: "VECTORIZE_BGE_M3", target: "backlex-bge-m3", status: env.VECTORIZE_BGE_M3 ? "connected" : "optional" },
        { type: "Vectorize", name: "VECTORIZE_SELF_HOST_BGE_M3", target: "backlex-self-host-bge-m3", status: env.VECTORIZE_SELF_HOST_BGE_M3 ? "connected" : "optional" },
        { type: "WorkersAI", name: "AI", target: "@cf/baai/bge-m3", status: env.AI ? "connected" : "optional" },
        { type: "HTTP", name: "EMBEDDING_HTTP_URL", target: "self-host embeddings", status: env.EMBEDDING_HTTP_URL ? "connected" : "optional" },
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
        // Generation credentials (see docs/ai-providers.md). Presence only —
        // this endpoint never returns a value for anything marked secret.
        { key: "AI_PROVIDER", set: present("AI_PROVIDER"), source: "env", secret: false },
        { key: "AI_GATEWAY_API_KEY", set: present("AI_GATEWAY_API_KEY"), source: "env", secret: true },
        { key: "ANTHROPIC_API_KEY", set: present("ANTHROPIC_API_KEY"), source: "env", secret: true },
        { key: "GOOGLE_GENERATIVE_AI_API_KEY", set: present("GOOGLE_GENERATIVE_AI_API_KEY"), source: "env", secret: true },
        { key: "OAUTH_GOOGLE_CLIENT_ID", set: present("OAUTH_GOOGLE_CLIENT_ID"), source: "env", secret: false },
        { key: "OAUTH_GOOGLE_CLIENT_SECRET", set: present("OAUTH_GOOGLE_CLIENT_SECRET"), source: "env", secret: true },
        { key: "OAUTH_GITHUB_CLIENT_ID", set: present("OAUTH_GITHUB_CLIENT_ID"), source: "env", secret: false },
        { key: "OAUTH_GITHUB_CLIENT_SECRET", set: present("OAUTH_GITHUB_CLIENT_SECRET"), source: "env", secret: true },
        { key: "S3_BUCKET", set: present("S3_BUCKET"), source: "env", secret: false },
        { key: "FUNCTIONS_FETCH_ALLOW", set: present("FUNCTIONS_FETCH_ALLOW"), source: "env", secret: false },
        { key: "FUNCTIONS_EXEC_URL", set: present("FUNCTIONS_EXEC_URL"), source: "env", secret: false },
        // Worth reading off this panel rather than off a shell: it decides
        // whether user-authored functions run in an isolate or in this process.
        { key: "FUNCTIONS_SANDBOX", set: present("FUNCTIONS_SANDBOX"), source: "env", secret: false },
        { key: "SANDBOX_RPC_TOKEN", set: present("SANDBOX_RPC_TOKEN"), source: "env", secret: true },
      ];
      // Report the actual host runtime, not a DB-presence heuristic. Order
      // matters: Workers (D1 binding) → Deno (Deno global, covers self-host +
      // Deno Deploy) → Netlify/Vercel Node functions → Bun → plain Node.
      const g = globalThis as {
        Deno?: unknown;
        Bun?: unknown;
        process?: { env?: Record<string, string | undefined> };
      };
      const adapter =
        env.D1 || isCloudflareWorkers()
          ? "workers"
          : isDenoDeploy() || typeof g.Deno !== "undefined"
            ? "deno"
            : isNetlify()
              ? "netlify"
              : g.process?.env?.VERCEL
                ? "vercel"
                : typeof g.Bun !== "undefined"
                  ? "bun"
                  : "node";
      // Build-time metadata injected by Vite `define` (see vite.config.ts).
      // The `typeof` guard keeps it safe under runtimes that don't apply Vite
      // `define` (bun test / bun self-host) — there it reports "dev"/"unknown".
      return c.json({
        data: {
          adapter,
          dialect: ctx.dialect,
          bindings,
          envVars,
          version:
            typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "dev",
          commit:
            typeof __GIT_COMMIT__ !== "undefined" ? __GIT_COMMIT__ : "unknown",
          released:
            typeof __BUILD_DATE__ !== "undefined" ? __BUILD_DATE__ : "unknown",
          wrangler:
            typeof __WRANGLER_VERSION__ !== "undefined"
              ? __WRANGLER_VERSION__
              : "unknown",
        },
      });
    },
  );
