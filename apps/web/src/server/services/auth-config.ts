import { eq } from "drizzle-orm";
import * as pg from "@workeros/db/pg";
import * as sqlite from "@workeros/db/sqlite";
import type { Env } from "../env";
import type { DbCtx } from "./seed";

/**
 * Tenant id of the instance-wide `auth_config` row — the fallback used when a
 * workspace hasn't customised its auth settings. Mirrors the `?? "_global"`
 * sentinel the admin "Auth Settings" route already uses.
 */
export const GLOBAL_AUTH_CONFIG_ID = "_global";

/** Provider keys recognised by the auth-config layer — same keys the admin
 *  "Auth Settings" page reads/writes under `providers.<key>`. */
export type AuthProviderKey = "email" | "magic" | "passkey" | "github" | "google";

export interface PublicProvider {
  /** Identifier a frontend app passes to the client SDK — `auth.signIn.email()`
   *  for `"email"`, `auth.signIn.magicLink()` for `"magic"`,
   *  `auth.signIn.passkey()` for `"passkey"`, `auth.signIn.social("github")`
   *  for the OAuth providers. */
  id: AuthProviderKey;
  kind: "credential" | "magic-link" | "passkey" | "social";
  label: string;
  /** Whether sign-in with this provider is currently offered for this
   *  workspace. The list itself only contains providers the running worker is
   *  actually able to serve. */
  enabled: boolean;
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
  passkey: { kind: "passkey", label: "Passkey" },
  github: { kind: "social", label: "GitHub" },
  google: { kind: "social", label: "Google" },
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
  passkey: Boolean(env.AUTH_PLUGINS?.includes("passkey")),
  github: Boolean(env.OAUTH_GITHUB_CLIENT_ID && env.OAUTH_GITHUB_CLIENT_SECRET),
  google: Boolean(env.OAUTH_GOOGLE_CLIENT_ID && env.OAUTH_GOOGLE_CLIENT_SECRET),
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
 * Resolve the *public* description of a workspace's auth surface — the provider
 * list and policy flags a frontend app needs to render its sign-in screen.
 * Never includes secrets or admin-only fields.
 */
export const resolveAuthSurface = async (
  ctx: DbCtx,
  env: Env,
  tenantId: string | null | undefined,
): Promise<ResolvedAuthSurface> => {
  const stored = await loadAuthConfigRow(ctx, tenantId);
  const configured = envConfiguredProviders(env);
  const fallbackEnabled = defaultEnabledProviders(env);

  const providers: PublicProvider[] = (
    Object.keys(PROVIDER_META) as AuthProviderKey[]
  )
    .filter((key) => configured[key])
    .map((key) => {
      const entry = stored?.providers?.[key] as { enabled?: unknown } | undefined;
      const enabled =
        entry && typeof entry.enabled === "boolean"
          ? entry.enabled
          : fallbackEnabled[key];
      return { id: key, kind: PROVIDER_META[key].kind, label: PROVIDER_META[key].label, enabled };
    });

  const policy = (stored?.policy ?? {}) as Record<string, unknown>;
  return {
    tenantId: tenantId ?? null,
    providers,
    policy: { openSignup: true, requireEmailVerification: true, ...policy },
  };
};
