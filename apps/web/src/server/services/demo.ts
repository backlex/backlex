import { hashSecret } from "@backlex/auth";
import { dropCollection } from "@backlex/db";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import { and, eq, ne } from "drizzle-orm";
import type { Env } from "../env";
import type { Ctx } from "../context";
import { invalidateTenantCollections } from "./collections-cache";
import { invalidateAllPermissions } from "./permissions-cache";
import {
  type DbCtx,
  ensureDefaultTenant,
  ensureSystemRoles,
  ensureTenantMembership,
  assignRoleByName,
} from "./seed";
import { applyTemplate } from "./templates";
import { getTemplate } from "../templates/catalog";
import { SYSTEM_ROLES } from "@backlex/core";

/**
 * Playground (demo) mode — a public, no-signup instance whose demo-admin
 * credentials are published on the sign-in screen and whose entire workspace
 * is wiped + re-seeded from `SEED_TEMPLATE` on a timer (default hourly).
 *
 * Everything here is inert unless `DEMO_MODE` is set; a normal instance pays
 * only the `isDemoMode()` boolean check.
 */

export const isDemoMode = (env: Env): boolean =>
  env.DEMO_MODE === "1" || env.DEMO_MODE?.toLowerCase() === "true";

/** Demo-admin credentials — public by design (they're on the sign-in screen). */
export const demoCredentials = (env: Env): { email: string; password: string } => ({
  email: env.DEMO_EMAIL?.trim() || "demo@backlex.com",
  password: env.DEMO_PASSWORD || "playground",
});

export const demoResetIntervalMs = (env: Env): number => {
  const minutes = Number(env.DEMO_RESET_MINUTES);
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : 60) * 60_000;
};

export const DEMO_BLOCKED_MESSAGE =
  "This action is disabled in the playground.";

/** app_settings key (default tenant) holding the last completed reset time. */
const DEMO_LAST_RESET_KEY = "demoLastResetAt";

/**
 * Route prefixes a public playground must not expose for writes: endpoints
 * that send outbound traffic (email/SMS/push, external-DB migrations), run raw
 * SQL against the system tables, or could lock everyone out of the shared demo
 * account (auth-config / SSO / password / 2FA changes). Reads stay open so the
 * admin pages still render.
 */
const BLOCKED_WRITE_PREFIXES = [
  "/api/admin/email-config",
  "/api/admin/push-config",
  "/api/admin/sms-config",
  "/api/admin/auth",
  "/api/admin/saml",
  "/api/admin/ldap-config",
  "/api/admin/platform-saml",
  "/api/admin/platform-ldap-config",
  "/api/admin/migrate",
  "/api/admin/db",
  "/api/messaging",
  "/api/auth/change-password",
  "/api/auth/change-email",
  "/api/auth/delete-user",
  "/api/auth/two-factor",
];

/** True when a request must be rejected in demo mode. Pure — unit-testable. */
export const isDemoBlockedRequest = (method: string, path: string): boolean => {
  const m = method.toUpperCase();
  if (m === "GET" || m === "HEAD" || m === "OPTIONS") return false;
  return BLOCKED_WRITE_PREFIXES.some(
    (p) => path === p || path.startsWith(`${p}/`),
  );
};

const settingsTable = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.appSettings : sqlite.schema.appSettings;

const readLastResetAt = async (ctx: DbCtx, tenantId: string): Promise<number | null> => {
  const t = settingsTable(ctx.dialect);
  const rows = await (ctx.db as any)
    .select({ value: t.value })
    .from(t)
    .where(and(eq(t.tenantId, tenantId), eq(t.key, DEMO_LAST_RESET_KEY)))
    .limit(1);
  const raw = rows[0]?.value;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
};

const writeLastResetAt = async (
  ctx: DbCtx,
  tenantId: string,
  at: number,
): Promise<void> => {
  const t = settingsTable(ctx.dialect);
  await (ctx.db as any)
    .insert(t)
    .values({ id: crypto.randomUUID(), tenantId, key: DEMO_LAST_RESET_KEY, value: at })
    .onConflictDoUpdate({
      target: [t.tenantId, t.key],
      set: { value: at, updatedAt: new Date() },
    });
};

/**
 * Every system table whose rows are visitor-created state — wiped wholesale on
 * reset. Deliberately excludes: `tenants`, `tenant_members`, `users`,
 * `accounts`, `sessions` (handled surgically so the demo admin survives),
 * `collections` (dropped with their physical tables first), and the drizzle
 * migrations journal.
 */
const WIPE_TABLE_KEYS = [
  "functions",
  "extensions",
  "extensionAssets",
  "scheduledTasks",
  "flows",
  "agents",
  "agentThreads",
  "agentMessages",
  "webhooks",
  "webhookDeliveries",
  "comments",
  "sharedLinks",
  "notifications",
  "deviceTokens",
  "pushConfig",
  "pushTemplates",
  "phoneNumbers",
  "smsConfig",
  "jobs",
  "uploads",
  "revisions",
  "schemaSnapshots",
  "schemaBranches",
  "externalSources",
  "migrationRuns",
  "activity",
  "spans",
  "usageCounters",
  "analyticsEvents",
  "errorEvents",
  "errorGroups",
  "apiKeys",
  "itemOwnership",
  "itemStaged",
  "folders",
  "files",
  "emailTemplates",
  "i18nStrings",
  "featureFlags",
  "savedPanels",
  "dashboards",
  "forms",
  "authConfig",
  "samlProviders",
  "externalIdentities",
  "ldapConfigs",
  "platformSamlProviders",
  "platformExternalIdentities",
  "emailConfig",
  "aiConfig",
  "workspaceConfig",
  "backups",
  "integrations",
  "verifications",
  "passkey",
  "appUsers",
  "appSessions",
  "appAccounts",
  "appVerifications",
  "appUserRoles",
  "permissions",
  "roles",
  "userRoles",
] as const;

export interface DemoResetResult {
  droppedCollections: number;
  templateApplied: boolean;
  at: number;
}

/**
 * Wipe the playground back to its seeded state:
 *
 *  1. drop every managed collection's physical table + all collection metadata,
 *  2. best-effort delete stored file objects, then truncate every
 *     visitor-state system table ({@link WIPE_TABLE_KEYS}),
 *  3. delete every workspace except the default one and every user except the
 *     demo admin (recreating the admin — with a fresh password hash — if a
 *     visitor deleted or changed it),
 *  4. re-apply `SEED_TEMPLATE` into the default workspace.
 *
 * Idempotent and safe to double-run: two racing isolates both converge on the
 * same seeded state (the claim-write in {@link maybeResetDemo} keeps the window
 * small; a rare double reset is harmless in a playground).
 */
export const resetDemoWorkspace = async (
  ctx: Ctx,
  env: Env,
  now: Date = new Date(),
): Promise<DemoResetResult> => {
  if (!isDemoMode(env)) {
    throw new Error("resetDemoWorkspace called outside demo mode");
  }
  const { db, dialect } = ctx;
  const schema = dialect === "pg" ? pg.schema : sqlite.schema;
  const tenantId = await ensureDefaultTenant(ctx);

  // 1. Managed collections: physical table + metadata. Adopted collections
  // don't exist on a playground, but dropCollection short-circuits on them
  // anyway.
  const ct = schema.collections;
  const collections = (await (db as any)
    .select({ physicalTable: ct.physicalTable, adopted: ct.adopted })
    .from(ct)) as Array<{ physicalTable: string; adopted: boolean }>;
  let dropped = 0;
  for (const row of collections) {
    try {
      await dropCollection(db, dialect, row.physicalTable, {
        adopted: Boolean(row.adopted),
      });
      dropped++;
    } catch (e) {
      console.error("[demo-reset] drop failed", row.physicalTable, (e as Error).message);
    }
  }
  await (db as any).delete(ct);

  // 2a. Stored file objects — best-effort, capped so a spammed playground
  // can't stall the reset; leftover blobs are orphaned metadata-free objects.
  try {
    const ft = schema.files;
    const files = (await (db as any)
      .select({ key: ft.key })
      .from(ft)
      .limit(1000)) as Array<{ key: string }>;
    for (const f of files) {
      try {
        await ctx.storage.delete(f.key);
      } catch {
        // object already gone / adapter hiccup — metadata wipe below still runs.
      }
    }
  } catch (e) {
    console.error("[demo-reset] file cleanup failed", (e as Error).message);
  }

  // 2b. Visitor-state system tables. Embedding tables are dialect-specific
  // and empty unless vector search was configured — clear defensively.
  for (const key of WIPE_TABLE_KEYS) {
    const table = (schema as Record<string, unknown>)[key];
    if (!table) continue;
    try {
      await (db as any).delete(table);
    } catch (e) {
      console.error(`[demo-reset] wipe ${key} failed`, (e as Error).message);
    }
  }
  // Keep the reset timestamp (written as a claim before the wipe) — drop every
  // other setting so visitor branding/config changes don't survive.
  const st = settingsTable(dialect);
  await (db as any).delete(st).where(ne(st.key, DEMO_LAST_RESET_KEY));

  // 3. Workspaces + users: keep only the default workspace and the demo admin.
  const { email, password } = demoCredentials(env);
  const tt = schema.tenants;
  await (db as any).delete(tt).where(ne(tt.id, tenantId));
  await (db as any).delete(schema.tenantMembers);

  const ut = schema.users;
  const demoRows = (await (db as any)
    .select({ id: ut.id })
    .from(ut)
    .where(eq(ut.email, email))
    .limit(1)) as Array<{ id: string }>;
  let demoUserId = demoRows[0]?.id;

  const at = schema.accounts;
  const sess = schema.sessions;
  if (demoUserId) {
    // Drop everyone else (accounts/sessions explicitly — FK cascade isn't
    // guaranteed on every runtime), then force the known password back in
    // case a visitor changed it through a surface the guard missed.
    await (db as any).delete(at).where(ne(at.userId, demoUserId));
    await (db as any).delete(sess).where(ne(sess.userId, demoUserId));
    await (db as any).delete(ut).where(ne(ut.id, demoUserId));
    await (db as any)
      .update(ut)
      .set({ emailVerified: true, status: "active", twoFactorEnabled: false, activeTenantId: tenantId })
      .where(eq(ut.id, demoUserId));
    await (db as any)
      .update(at)
      .set({ password: await hashSecret(password), updatedAt: new Date() })
      .where(and(eq(at.userId, demoUserId), eq(at.providerId, "credential")));
  } else {
    await (db as any).delete(at);
    await (db as any).delete(sess);
    await (db as any).delete(ut);
    demoUserId = crypto.randomUUID();
    await (db as any).insert(ut).values({
      id: demoUserId,
      email,
      name: "Playground Admin",
      emailVerified: true,
      activeTenantId: tenantId,
      createdAt: now,
      updatedAt: now,
    });
    await (db as any).insert(at).values({
      id: crypto.randomUUID(),
      userId: demoUserId,
      providerId: "credential",
      accountId: demoUserId,
      password: await hashSecret(password),
      createdAt: now,
      updatedAt: now,
    });
  }

  await ensureSystemRoles(ctx, tenantId);
  await assignRoleByName(ctx, tenantId, demoUserId, SYSTEM_ROLES.admin);
  await ensureTenantMembership(ctx, tenantId, demoUserId, email, "owner");

  // 4. Re-seed the vertical template (roles/dashboards/sample rows).
  let templateApplied = false;
  if (env.SEED_TEMPLATE && getTemplate(env.SEED_TEMPLATE)) {
    try {
      await applyTemplate(ctx, tenantId, env.SEED_TEMPLATE);
      templateApplied = true;
    } catch (e) {
      console.error("[demo-reset] template apply failed", (e as Error).message);
    }
  }

  await writeLastResetAt(ctx, tenantId, now.getTime());
  invalidateTenantCollections(tenantId);
  invalidateAllPermissions();
  console.log(
    `[demo-reset] wiped playground (${dropped} collections) + reseeded${templateApplied ? ` from ${env.SEED_TEMPLATE}` : ""}`,
  );
  return { droppedCollections: dropped, templateApplied, at: now.getTime() };
};

/**
 * Cron hook: reset when the persisted last-reset timestamp is older than the
 * interval (also fires on a brand-new instance, which bootstraps the demo
 * admin + template without any manual sign-up). The timestamp is claimed
 * *before* the wipe so concurrent isolates reading it mid-reset back off.
 */
export const maybeResetDemo = async (ctx: Ctx, env: Env, now: Date): Promise<boolean> => {
  if (!isDemoMode(env)) return false;
  const tenantId = await ensureDefaultTenant(ctx);
  const last = await readLastResetAt(ctx, tenantId);
  if (last !== null && now.getTime() - last < demoResetIntervalMs(env)) return false;
  await writeLastResetAt(ctx, tenantId, now.getTime());
  await resetDemoWorkspace(ctx, env, now);
  return true;
};
