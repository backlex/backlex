import { eq } from "drizzle-orm";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { Env } from "../env";
import { userCount, type DbCtx } from "./seed";
import { demoCredentials, isDemoMode } from "./demo";
import {
  loadPasswordLoginMode,
  loadSignInBranding,
  type PasswordLoginMode,
} from "./settings";
import { readCaptchaConfig } from "./captcha";
import { isPlatformSsoEnabled } from "../lib/platform-sso";
import { isEdgeRuntime } from "../lib/runtime";

/**
 * Tenant id of the instance-wide `auth_config` row — the fallback used when a
 * workspace hasn't customised its auth settings. Mirrors the `?? "_global"`
 * sentinel the admin "Auth Settings" route already uses.
 */
export const GLOBAL_AUTH_CONFIG_ID = "_global";

/**
 * Default policy flags applied when a workspace's stored `auth_config.policy`
 * doesn't set them. Single source of truth for both the public auth surface and
 * the server-side sign-up enforcement (`onBeforeUserCreated`).
 *
 * `openSignup` defaults to **false**: a fresh instance only ever admits its
 * first user (the bootstrap admin) and anyone holding a valid workspace invite;
 * an admin must explicitly open public sign-up in Auth Settings.
 */
export const POLICY_DEFAULTS = {
  openSignup: false,
  // Email verification gates password sign-in when an instance turns it on AND
  // has a real email transport (see context.ts). Default OFF so an instance
  // without email — or one that hasn't opted in — never blocks new users.
  requireEmailVerification: false,
} as const;

export interface ResolvedPolicy {
  openSignup: boolean;
  requireEmailVerification: boolean;
  [key: string]: unknown;
}

/** Provider keys recognised by the auth-config layer — same keys the admin
 *  "Auth Settings" page reads/writes under `providers.<key>`. */
export type AuthProviderKey =
  | "email"
  | "magic"
  | "emailOtp"
  | "passkey"
  | "github"
  | "google"
  | "apple";

export interface PublicProvider {
  /** Identifier a frontend app passes to the client SDK — `auth.signIn()` for
   *  `"email"`, `auth.signInMagicLink()` for `"magic"`, the email-OTP flow for
   *  `"emailOtp"`, the WebAuthn flow for `"passkey"`,
   *  `auth.signInSocial("github")` for the OAuth providers. SAML providers
   *  use their per-tenant slug as the id and point to
   *  `/api/t/<slug>/auth/saml/<slug>/login`. */
  id: AuthProviderKey | string;
  kind: "credential" | "magic-link" | "email-otp" | "passkey" | "social" | "saml" | "ldap";
  label: string;
  /** Whether sign-in with this provider is currently offered for this
   *  workspace. The list itself only contains providers the running worker is
   *  actually able to serve. */
  enabled: boolean;
  /** Provider-specific entry-point URL (SAML only — the rest are implied by
   *  the better-auth client SDK calls). */
  loginUrl?: string;
}

export interface ResolvedAuthSurface {
  /** Workspace this surface belongs to, or `null` in single-tenant mode. */
  tenantId: string | null;
  providers: PublicProvider[];
  /** Non-secret policy flags a sign-in screen needs (e.g. whether to show a
   *  "create account" link). Extra keys from the stored config pass through. */
  policy: {
    openSignup: boolean;
    requireEmailVerification: boolean;
    [key: string]: unknown;
  };
  /** True iff the instance has zero users yet — the next sign-up will be
   *  provisioned as admin. Lets the client show the "claim instance" copy
   *  only when it actually applies (server-validated, not query-param). */
  firstUserMode: boolean;
  /** When `firstUserMode` and the deployment pinned an owner (managed cloud),
   *  the email allowed to claim the first-admin account. Empty = anyone may
   *  claim (self-host default). */
  ownerEmail: string;
  /** Admin-customised copy for the sign-in screen's brand panel — instance-
   *  global (not per-workspace, since the sign-in page has no active tenant).
   *  Empty strings mean the client should fall back to its built-in default. */
  branding: {
    signInHeadline: string;
    signInTagline: string;
    /** Absolute URLs for the sign-up consent links; empty = hide that link. */
    termsUrl: string;
    privacyUrl: string;
  };
  /** Control-plane only: whether admin SAML/LDAP SSO is enabled for this
   *  instance (the `PLATFORM_SSO_ENABLED` gate). Lets the admin client show or
   *  hide the "Platform SSO" settings page. Absent on the workspace surface. */
  platformSso?: boolean;
  /** The captcha's public half, when the workspace has one enabled — a sign-in
   *  screen cannot render the widget without the site key, and there is nowhere
   *  else it could come from. The secret and the `onError` choice never appear
   *  here. */
  captcha?: { provider: string; siteKey: string; protect: string[] };
  /** Playground (DEMO_MODE) only: the shared demo-admin credentials, published
   *  so the sign-in screen can offer a one-click "enter the playground" button.
   *  Public by design — never present outside demo mode. */
  demo?: { email: string; password: string };
}

interface StoredAuthConfigRow {
  tenantId: string;
  providers: Record<string, Record<string, unknown>> | null;
  policy: Record<string, unknown> | null;
  sessionLifetime: string;
  redirectUrls: string[] | null;
  updatedAt: Date | number | null;
}

const PROVIDER_META: Record<
  AuthProviderKey,
  { kind: PublicProvider["kind"]; label: string }
> = {
  email: { kind: "credential", label: "Email & password" },
  magic: { kind: "magic-link", label: "Magic link" },
  emailOtp: { kind: "email-otp", label: "Email code (OTP)" },
  passkey: { kind: "passkey", label: "Passkey" },
  github: { kind: "social", label: "GitHub" },
  google: { kind: "social", label: "Google" },
  apple: { kind: "social", label: "Apple" },
};

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.authConfig : sqlite.schema.authConfig;

/**
 * Which providers the *running worker* is actually configured to serve. A
 * workspace's stored config can only ever toggle a provider on if the worker
 * has the underlying credentials/plugin — so the discovery endpoint advertises
 * the intersection, never something it can't fulfil.
 */
const envConfiguredProviders = (env: Env): Record<AuthProviderKey, boolean> => ({
  email: true,
  magic: Boolean(env.AUTH_PLUGINS?.includes("magic-link")),
  emailOtp: Boolean(env.AUTH_PLUGINS?.includes("email-otp")),
  passkey: Boolean(env.AUTH_PLUGINS?.includes("passkey")),
  github: Boolean(env.OAUTH_GITHUB_CLIENT_ID && env.OAUTH_GITHUB_CLIENT_SECRET),
  google: Boolean(env.OAUTH_GOOGLE_CLIENT_ID && env.OAUTH_GOOGLE_CLIENT_SECRET),
  apple: Boolean(env.OAUTH_APPLE_CLIENT_ID && env.OAUTH_APPLE_CLIENT_SECRET),
});

/** `enabled` defaults applied when a workspace has no stored `auth_config`
 *  row — everything the worker can serve is on by default. */
const defaultEnabledProviders = (env: Env): Record<AuthProviderKey, boolean> =>
  envConfiguredProviders(env);

/**
 * Load the stored `auth_config` row for a workspace, falling back to the
 * instance-wide ({@link GLOBAL_AUTH_CONFIG_ID}) row. Returns `null` if neither
 * exists (callers then fall back to env-derived defaults). Read failures
 * (e.g. the table not migrated yet) also degrade to `null` rather than throw —
 * this feeds a public endpoint that must not 500.
 */
export const loadAuthConfigRow = async (
  ctx: DbCtx,
  tenantId: string | null | undefined,
): Promise<StoredAuthConfigRow | null> => {
  const t = tableFor(ctx.dialect);
  const ids =
    tenantId && tenantId !== GLOBAL_AUTH_CONFIG_ID
      ? [tenantId, GLOBAL_AUTH_CONFIG_ID]
      : [GLOBAL_AUTH_CONFIG_ID];
  for (const id of ids) {
    try {
      const rows = (await (ctx.db as any)
        .select()
        .from(t)
        .where(eq(t.tenantId, id))
        .limit(1)) as StoredAuthConfigRow[];
      if (rows[0]) return rows[0];
    } catch {
      return null;
    }
  }
  return null;
};

/**
 * Honour the admin "enabled" toggle for `magic` / `emailOtp` at the HTTP edge.
 *
 * The CONTROL-PLANE better-auth instance loads its plugin set once per isolate
 * from `env.AUTH_PLUGINS` (see context.ts) and is never rebuilt, so flipping a
 * provider off in the admin only hides the sign-in button — the endpoint stays
 * mounted and would still mint a session. (The workspace plane already gates
 * correctly: tenant-auth rebuilds its plugin list from stored config and is
 * dropped via `invalidateTenantAuth` on every config PATCH.) This closes that
 * gap by rejecting the disabled provider's sign-in endpoints before they reach
 * the handler.
 *
 * Returns the offending provider key when the request targets a magic-link /
 * email-OTP endpoint the admin has explicitly disabled, else `null`. Only an
 * explicit `enabled === false` blocks — an absent flag means "use the env
 * default" (on), so this never breaks an instance that hasn't customised auth.
 *
 * The DB read happens only for the handful of gated paths; the hot endpoints
 * (`/sign-in/email`, `/get-session`, …) short-circuit on the cheap path test.
 */
export const disabledAuthProviderForPath = async (
  ctx: DbCtx,
  tenantId: string | null | undefined,
  path: string,
): Promise<AuthProviderKey | null> => {
  let key: AuthProviderKey | null = null;
  if (/\/sign-in\/magic-link|\/magic-link\//.test(path)) key = "magic";
  else if (/\/sign-in\/email-otp|\/email-otp\//.test(path)) key = "emailOtp";
  if (!key) return null;
  const stored = await loadAuthConfigRow(ctx, tenantId);
  const entry = stored?.providers?.[key] as { enabled?: unknown } | undefined;
  return entry && entry.enabled === false ? key : null;
};

/**
 * Does this better-auth path exchange an email + password for a session?
 *
 * Every one of these is a password path, and blocking only `/sign-in/email`
 * would leave the others open: a sign-up mints a session directly, and a reset
 * sets a password the caller then signs in with. `/change-password` is
 * deliberately NOT here — it needs an existing session, so it is a
 * *credential-management* call by someone already inside, and blocking it would
 * strand anyone who wanted to rotate a password before it stops being usable.
 */
const isPasswordPath = (path: string): boolean =>
  /\/sign-in\/email(?:$|\/|\?)/.test(path) ||
  /\/sign-up\/email(?:$|\/|\?)/.test(path) ||
  /\/(?:forget|reset)-password(?:$|\/|\?)/.test(path);

/**
 * Refuse a password exchange the instance has turned off, or `null` to let it
 * through. `plane` says which side of the split is asking — `app-only` blocks
 * the admin dashboard and lets workspace end-users keep theirs.
 *
 * Reads only for paths that could possibly be blocked, so ordinary auth traffic
 * (callbacks, sessions, sign-out) never pays for the lookup.
 */
export const passwordLoginBlocked = async (
  ctx: DbCtx,
  path: string,
  plane: "platform" | "app",
): Promise<string | null> => {
  if (!isPasswordPath(path)) return null;
  const mode = await loadPasswordLoginMode(ctx.db, ctx.dialect);
  if (mode === "enabled") return null;
  if (mode === "app-only" && plane === "app") return null;
  return plane === "platform"
    ? "Password sign-in is disabled for the admin dashboard. Use SSO, a passkey, or a magic link."
    : "Password sign-in is disabled for this instance.";
};

/**
 * Reflect the password-login mode in a resolved surface, so a sign-in screen
 * stops offering a form the server will refuse.
 *
 * The gate on the auth routes is the enforcement; this is what makes the UI
 * honest. Marking the provider `enabled: false` rather than dropping it keeps
 * the entry visible to the settings screen, which needs to know the password
 * exists in order to say it is off.
 */
export const applyPasswordLoginMode = (
  surface: ResolvedAuthSurface,
  mode: PasswordLoginMode,
  plane: "platform" | "app",
): ResolvedAuthSurface => {
  const blocked = mode === "disabled" || (mode === "app-only" && plane === "platform");
  if (!blocked) return surface;
  return {
    ...surface,
    providers: surface.providers.map((p) =>
      p.kind === "credential" ? { ...p, enabled: false } : p,
    ),
  };
};

/**
 * Resolve just the policy flags for a workspace (stored `auth_config.policy`
 * over {@link POLICY_DEFAULTS}). Lean alternative to {@link resolveAuthSurface}
 * for the sign-up / verification enforcement paths, which only need a couple of
 * flags (`openSignup`, `requireEmailVerification`).
 */
export const loadPolicy = async (
  ctx: DbCtx,
  tenantId: string | null | undefined,
): Promise<ResolvedPolicy> => {
  const stored = await loadAuthConfigRow(ctx, tenantId);
  return { ...POLICY_DEFAULTS, ...((stored?.policy as Record<string, unknown>) ?? {}) };
};

/**
 * Resolve the *public* description of a workspace's auth surface — the provider
 * list and policy flags a frontend app needs to render its sign-in screen.
 * Never includes secrets or admin-only fields.
 *
 * `tenantSlug` is optional; when provided, SAML providers are included in the
 * list with a `loginUrl` pointing at the SP-initiated login redirect.
 *
 * `excludeSocial` drops consumer OAuth (Google / Apple / GitHub) from the list.
 * The control-plane (admin) sign-in screen passes `true` — social login belongs
 * to the workspace end-user plane only. The admin better-auth instance also
 * ships without these providers (see context.ts), so hiding the buttons here
 * keeps the discovery surface honest rather than advertising a dead route.
 */
export const resolveAuthSurface = async (
  ctx: DbCtx,
  env: Env,
  tenantId: string | null | undefined,
  tenantSlug?: string,
  excludeSocial = false,
): Promise<ResolvedAuthSurface> => {
  const stored = await loadAuthConfigRow(ctx, tenantId);
  const envConfigured = envConfiguredProviders(env);
  const fallbackEnabled = defaultEnabledProviders(env);

  // A provider is serveable for this workspace if the running worker has it
  // (env) OR the workspace opted in via its stored config: OAuth providers
  // need their own `clientId` + `clientSecretEnc`; `magic` / `emailOtp` just
  // need to be explicitly enabled (they send through the deployment's email
  // adapter).
  const isConfigured = (key: AuthProviderKey): boolean => {
    if (envConfigured[key]) return true;
    const e = stored?.providers?.[key] as
      | { enabled?: unknown; clientId?: unknown; clientSecretEnc?: unknown }
      | undefined;
    if (!e) return false;
    if (key === "github" || key === "google" || key === "apple") {
      return Boolean(
        typeof e.clientId === "string" &&
          e.clientId.trim() &&
          typeof e.clientSecretEnc === "string",
      );
    }
    if (key === "magic" || key === "emailOtp") return e.enabled === true;
    return false;
  };

  const providers: PublicProvider[] = (
    Object.keys(PROVIDER_META) as AuthProviderKey[]
  )
    .filter((key) => isConfigured(key))
    .filter((key) => !(excludeSocial && PROVIDER_META[key].kind === "social"))
    .map((key) => {
      const entry = stored?.providers?.[key] as { enabled?: unknown } | undefined;
      const enabled =
        entry && typeof entry.enabled === "boolean"
          ? entry.enabled
          : fallbackEnabled[key];
      return {
        id: key,
        kind: PROVIDER_META[key].kind,
        label: PROVIDER_META[key].label,
        enabled,
      };
    });

  // Append enabled SAML providers — one entry per row. Reads degrade to an
  // empty list when the table isn't migrated yet.
  if (tenantId && tenantSlug) {
    const t =
      ctx.dialect === "pg" ? pg.schema.samlProviders : sqlite.schema.samlProviders;
    try {
      const rows = (await (ctx.db as any)
        .select({
          id: t.id,
          slug: t.slug,
          name: t.name,
          enabled: t.enabled,
        })
        .from(t)
        .where(eq(t.tenantId, tenantId))) as Array<{
          id: string;
          slug: string;
          name: string;
          enabled: boolean;
        }>;
      const base = env.APP_URL.replace(/\/+$/, "");
      for (const r of rows) {
        providers.push({
          id: r.slug,
          kind: "saml",
          label: r.name,
          enabled: Boolean(r.enabled),
          loginUrl: `${base}/api/t/${tenantSlug}/auth/saml/${r.slug}/login`,
        });
      }
    } catch {
      // table not migrated yet — skip silently.
    }
  }

  const policy = (stored?.policy ?? {}) as Record<string, unknown>;
  // Read from the same stored row rather than a second query.
  const captcha = tenantId ? readCaptchaConfig((stored as { captcha?: unknown })?.captcha) : null;
  const activeCaptcha = captcha?.enabled ? captcha : null;
  // The user count drives `firstUserMode`. Treat read failures (table not
  // migrated yet on a brand-new instance) as "yes, first user" so the bootstrap
  // flow still works — the server-side `onBeforeUserCreated` hook is the
  // actual enforcer; this flag is only a UI hint.
  let firstUserMode = false;
  try {
    firstUserMode = (await userCount(ctx)) === 0;
  } catch {
    firstUserMode = true;
  }
  // Login-screen copy is instance-global — read it from the `tenant_id IS NULL`
  // row, not the request's resolved workspace.
  const branding = await loadSignInBranding(ctx.db, ctx.dialect);
  return {
    tenantId: tenantId ?? null,
    providers,
    policy: { ...POLICY_DEFAULTS, ...policy },
    firstUserMode,
    // On a managed cloud instance the provisioner pins the owner's email so only
    // they can claim the first-admin slot. Surfaced (when still in first-user
    // mode) so the claim screen can prefill + lock the email. Empty otherwise.
    ownerEmail: firstUserMode ? (env.OWNER_EMAIL?.trim() ?? "") : "",
    branding,
    // The captcha's PUBLIC half. A sign-in screen cannot render the widget
    // without the site key, and there is nowhere else it could get it — the
    // whole config is per workspace. The secret never appears here; neither
    // does `onError`, which is an operator's decision and not the browser's
    // business.
    ...(activeCaptcha
      ? {
          captcha: {
            provider: activeCaptcha.provider,
            siteKey: activeCaptcha.siteKey,
            protect: activeCaptcha.protect,
          },
        }
      : {}),
    ...(isDemoMode(env) ? { demo: demoCredentials(env) } : {}),
  };
};

/**
 * The CONTROL-PLANE (admin) sign-in surface. Reuses {@link resolveAuthSurface}
 * with `excludeSocial` (consumer OAuth belongs to the workspace plane only),
 * then appends the instance-global platform SAML providers and a synthetic LDAP
 * entry. Gated by `PLATFORM_SSO_ENABLED`: when off, no SSO providers are listed
 * and `platformSso` is false so the admin client hides the settings page.
 *
 * LDAP is advertised only on a runtime that can actually serve it — on
 * Cloudflare Workers / other edge runtimes `buildLdapAdapter` returns undefined,
 * so the entry is omitted there (SAML still works on Workers).
 */
export const resolvePlatformAuthSurface = async (
  ctx: DbCtx,
  env: Env,
  tenantId: string | null | undefined,
): Promise<ResolvedAuthSurface> => {
  const raw = await resolveAuthSurface(ctx, env, tenantId, undefined, true);
  // The admin dashboard is the `platform` plane, so `app-only` blocks here.
  const base = applyPasswordLoginMode(
    raw,
    await loadPasswordLoginMode(ctx.db, ctx.dialect),
    "platform",
  );
  if (!isPlatformSsoEnabled(env)) return { ...base, platformSso: false };

  const providers: PublicProvider[] = [...base.providers];
  const baseUrl = env.APP_URL.replace(/\/+$/, "");

  // Platform SAML providers.
  const st =
    ctx.dialect === "pg"
      ? pg.schema.platformSamlProviders
      : sqlite.schema.platformSamlProviders;
  try {
    const rows = (await (ctx.db as any)
      .select({ slug: st.slug, name: st.name, enabled: st.enabled })
      .from(st)) as Array<{ slug: string; name: string; enabled: boolean }>;
    for (const r of rows) {
      providers.push({
        id: r.slug,
        kind: "saml",
        label: r.name,
        enabled: Boolean(r.enabled),
        loginUrl: `${baseUrl}/api/auth/saml/${r.slug}/login`,
      });
    }
  } catch {
    // table not migrated yet — skip.
  }

  // Platform LDAP — only where the adapter can run (self-host, not edge).
  if (!isEdgeRuntime()) {
    const lt =
      ctx.dialect === "pg"
        ? pg.schema.platformLdapConfig
        : sqlite.schema.platformLdapConfig;
    try {
      const rows = (await (ctx.db as any)
        .select({ enabled: lt.enabled })
        .from(lt)
        .where(eq(lt.id, "singleton"))
        .limit(1)) as Array<{ enabled: boolean }>;
      if (rows[0]?.enabled) {
        providers.push({
          id: "ldap",
          kind: "ldap",
          label: "LDAP / Active Directory",
          enabled: true,
        });
      }
    } catch {
      // table not migrated yet — skip.
    }
  }

  return { ...base, providers, platformSso: true };
};
