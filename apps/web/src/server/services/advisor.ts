/**
 * Advisor — automated lint over live schema, permissions, and config.
 *
 * Every check here is computed from real DB / env state. No statistics are
 * fabricated: where the app doesn't collect the data needed for an honest
 * finding (notably query-level performance stats) the check is simply not
 * emitted, and the corresponding tab legitimately shows "All clear".
 *
 * Keep this file pure-ish: it only reads from `ctx.db` + `ctx.env` and
 * returns plain findings. The route (`routes/advisor.ts`) stays thin.
 */
import { and, eq, isNull } from "drizzle-orm";
import * as pg from "@workeros/db/pg";
import * as sqlite from "@workeros/db/sqlite";
import type { PgDb } from "@workeros/db/pg";
import type { SqliteDb } from "@workeros/db/sqlite";
import type { Env } from "../env";
import { loadEmailConfigRow } from "./email-config";

export type AdvisorKind = "security" | "performance";
export type AdvisorLevel = "error" | "warn" | "info";

export interface AdvisorCheck {
  id: string;
  kind: AdvisorKind;
  level: AdvisorLevel;
  title: string;
  body: string;
  fix: string;
  resource: string;
  /** ISO timestamp — the page renders it directly. */
  detected: string;
}

interface AdvisorCtx {
  db: PgDb | SqliteDb;
  dialect: "pg" | "sqlite";
  env: Env;
}

const schemaFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema : sqlite.schema;

/** True when the deployment env has complete credentials for a real
 *  (non-console) email transport. Mirrors `selectEmailAdapter`'s auto-detect
 *  without instantiating an adapter. */
const envHasRealEmailProvider = (env: Env): boolean => {
  const explicit = env.EMAIL_PROVIDER?.trim().toLowerCase();
  if (explicit === "console") return false;
  const from = env.EMAIL_FROM;
  if (!from) return false;
  return Boolean(
    env.RESEND_API_KEY ||
      env.SENDGRID_API_KEY ||
      (env.MAILGUN_API_KEY && env.MAILGUN_DOMAIN) ||
      (env.SES_ACCESS_KEY_ID && env.SES_SECRET_ACCESS_KEY && env.SES_REGION) ||
      env.SMTP_HOST,
  );
};

/**
 * Run every advisor check against live state. Tenant-scoped: `tenantId`
 * narrows the `collections` rows that are inspected so a workspace only sees
 * findings about its own schema.
 */
export const runAdvisorChecks = async (
  ctx: AdvisorCtx,
  tenantId: string | null,
): Promise<AdvisorCheck[]> => {
  const s = schemaFor(ctx.dialect);
  const db = ctx.db as any;
  const now = new Date().toISOString();
  const out: AdvisorCheck[] = [];

  // --- SECURITY ----------------------------------------------------------

  // Public read with no condition: the `public` role can list a collection
  // with no DSL guard at all — anonymous traffic can read every row.
  try {
    const publicReads = await db
      .select({
        collection: s.permissions.collection,
      })
      .from(s.permissions)
      .innerJoin(s.roles, eq(s.permissions.roleId, s.roles.id))
      .where(
        and(
          eq(s.roles.name, "public"),
          eq(s.permissions.action, "read"),
          isNull(s.permissions.condition),
        ),
      );
    const seen = new Set<string>();
    for (const row of publicReads as { collection: string }[]) {
      if (seen.has(row.collection)) continue;
      seen.add(row.collection);
      out.push({
        id: `sec-public-read-${row.collection}`,
        kind: "security",
        level: "error",
        title: `Public read on ${row.collection} with no condition`,
        body: `The 'public' role can read ${row.collection} with no DSL condition — anonymous traffic can list every row, including any sensitive fields.`,
        fix: `Remove the public read permission on ${row.collection}, or scope it with a condition such as { is_public: { _eq: true } }.`,
        resource: `permissions · ${row.collection}`,
        detected: now,
      });
    }
  } catch {
    // permissions table not migrated yet — skip this check silently.
  }

  // Owner-scoped collection missing an `authenticated` update condition:
  // ownerScoped sugar is meant to scope writes to the row owner. If the
  // update permission for `authenticated` has a null condition, any signed-in
  // user can edit any row.
  try {
    const collRows = (await db
      .select({
        slug: s.collections.slug,
        ownerScoped: s.collections.ownerScoped,
      })
      .from(s.collections)
      .where(
        tenantId ? eq(s.collections.tenantId, tenantId) : undefined,
      )) as { slug: string; ownerScoped: boolean }[];

    const ownerScoped = collRows.filter((r) => r.ownerScoped);
    if (ownerScoped.length > 0) {
      const updatePerms = (await db
        .select({
          collection: s.permissions.collection,
          condition: s.permissions.condition,
        })
        .from(s.permissions)
        .innerJoin(s.roles, eq(s.permissions.roleId, s.roles.id))
        .where(
          and(
            eq(s.roles.name, "authenticated"),
            eq(s.permissions.action, "update"),
          ),
        )) as { collection: string; condition: unknown }[];

      for (const coll of ownerScoped) {
        const perms = updatePerms.filter((p) => p.collection === coll.slug);
        const hasGuardedUpdate = perms.some((p) => p.condition != null);
        if (!hasGuardedUpdate) {
          const missingEntirely = perms.length === 0;
          out.push({
            id: `sec-owner-scope-${coll.slug}`,
            kind: "security",
            level: "error",
            title: `Owner-scoped collection ${coll.slug} has an unguarded update permission`,
            body: missingEntirely
              ? `${coll.slug} is owner-scoped but has no 'authenticated' update permission row — wiring may be incomplete.`
              : `${coll.slug} is owner-scoped but its 'authenticated' update permission has no DSL condition — any signed-in user can edit any row.`,
            fix: `Add { owner_id: { _eq: "$user.id" } } to the authenticated update permission on ${coll.slug}.`,
            resource: `permissions · ${coll.slug}`,
            detected: now,
          });
        }
      }
    }
  } catch {
    // collections / permissions table not migrated — skip.
  }

  // API key without a role scope: a key with role_id = null inherits the
  // owner's full role set (potentially admin).
  try {
    const keyRows = (await db
      .select({
        id: s.apiKeys.id,
        prefix: s.apiKeys.prefix,
        name: s.apiKeys.name,
        roleId: s.apiKeys.roleId,
        revokedAt: s.apiKeys.revokedAt,
        expiresAt: s.apiKeys.expiresAt,
      })
      .from(s.apiKeys)
      .where(
        tenantId ? eq(s.apiKeys.tenantId, tenantId) : undefined,
      )) as {
      id: string;
      prefix: string;
      name: string;
      roleId: string | null;
      revokedAt: Date | number | null;
      expiresAt: Date | number | null;
    }[];

    const nowMs = Date.now();
    const toMs = (v: Date | number | null): number | null =>
      v == null ? null : v instanceof Date ? v.getTime() : Number(v);

    for (const key of keyRows) {
      if (key.roleId) continue;
      if (key.revokedAt != null) continue;
      const exp = toMs(key.expiresAt);
      if (exp != null && exp <= nowMs) continue;
      out.push({
        id: `sec-apikey-noscope-${key.id}`,
        kind: "security",
        level: "warn",
        title: `API key "${key.name}" has no role scope`,
        body: `${key.prefix} inherits its owner's full role set — including admin if the owner is an admin.`,
        fix: `Bind the key to a narrower role via role_id, or rotate it to a service account that only holds the roles it needs.`,
        resource: `api_keys · ${key.prefix}`,
        detected: now,
      });
    }
  } catch {
    // api_keys table not migrated — skip.
  }

  // Email provider falls back to console: verification / reset mail logs to
  // stdout instead of actually being delivered.
  try {
    const row = await loadEmailConfigRow(ctx, tenantId);
    if (!row && !envHasRealEmailProvider(ctx.env)) {
      out.push({
        id: "sec-email-console-fallback",
        kind: "security",
        level: "info",
        title: "Email provider falls back to the console adapter",
        body: "No workspace email_config and no deployment EMAIL_PROVIDER credentials are set — verification, reset, and invite mail is logged to stdout instead of being delivered.",
        fix: "Configure Resend, SendGrid, Mailgun, or SES under Settings → Email (or set EMAIL_PROVIDER + EMAIL_FROM in the deployment env).",
        resource: "email_config · provider",
        detected: now,
      });
    }
  } catch {
    // email_config read failed — skip.
  }

  // No admin user: a workspace with zero admins can lock itself out of
  // every admin-only surface.
  try {
    const adminRows = (await db
      .select({ userId: s.userRoles.userId })
      .from(s.userRoles)
      .innerJoin(s.roles, eq(s.userRoles.roleId, s.roles.id))
      .where(eq(s.roles.name, "admin"))) as { userId: string }[];
    if (adminRows.length === 0) {
      out.push({
        id: "sec-no-admin",
        kind: "security",
        level: "warn",
        title: "No user holds the admin role",
        body: "No account is assigned the 'admin' role — admin-only surfaces (settings, roles, the database console) have no operator.",
        fix: "Grant the admin role to a trusted account via Users → Roles.",
        resource: "user_roles · admin",
        detected: now,
      });
    }
  } catch {
    // user_roles / roles table not migrated — skip.
  }

  // --- PERFORMANCE -------------------------------------------------------
  //
  // Honest performance advice needs query statistics (seq-scan counts, p95
  // latencies, index hit rates) that this app does not collect. Rather than
  // fabricate findings, the performance list is intentionally left empty —
  // the Performance tab will legitimately render "All clear".

  return out;
};
