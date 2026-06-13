import { eq } from "drizzle-orm";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { Env } from "../env";
import { userCount, type DbCtx } from "./seed";
import { loadSignInBranding } from "./settings";
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
  // Email verification is not wired into the auth plane yet (no verification
  // email is sent or enforced), so default it OFF — otherwise the sign-up UI
  // shows a "check your inbox" screen for a mail that never arrives.
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
 * Resolve just the policy flags for a workspace (stored `auth_config.policy`
 * over {@link POLICY_DEFAULTS}). Lean alternative to {@link resolveAuthSurface}
 * for the sign-up enforcement path, which only needs `openSignup`.
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
  const base = await resolveAuthSurface(ctx, env, tenantId, undefined, true);
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
