/**
 * Advisor — automated lint over live schema, permissions, and config.
 *
 * Every check here is computed from real DB / env state. No statistics are
 * fabricated: the security checks read permission / role / key rows directly,
 * and the performance checks are *static, schema-derived* — they introspect
 * which physical indexes exist (via dialect-specific catalog queries) and flag
 * collections whose hot query paths (owner_id filter, `-created_at` sort) have
 * no covering index. They do NOT use query-level statistics (seq-scan counts,
 * p95 latencies) — the app doesn't collect those, so no finding pretends to.
 *
 * Keep this file pure-ish: it only reads from `ctx.db` + `ctx.env` and
 * returns plain findings + a derived score. The route (`routes/advisor.ts`)
 * stays thin. Every check is wrapped in try/catch and skips silently when a
 * table isn't migrated yet.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
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
  /** Stable rule-family identifier. Findings sharing a `rule` are grouped. */
  rule: string;
  /** Category label shown when several findings share the same `rule`. */
  groupTitle: string;
  title: string;
  body: string;
  fix: string;
  resource: string;
  /** Optional admin SPA route path to the relevant surface. */
  link?: string;
}

export interface AdvisorResult {
  data: AdvisorCheck[];
  /** 0–100 health score derived from all findings. */
  score: number;
  /** ISO timestamp — one honest value per run. */
  generatedAt: string;
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

/** Compute the health score from all findings. */
const computeScore = (findings: AdvisorCheck[]): number => {
  const errors = findings.filter((f) => f.level === "error").length;
  const warns = findings.filter((f) => f.level === "warn").length;
  return Math.max(0, 100 - errors * 18 - warns * 7);
};

/** Run a raw SQL query against either dialect, normalising the result to a
 *  plain row array (mirrors `services/adopt.ts::runQuery`). */
const runRaw = async <T>(
  db: any,
  dialect: "pg" | "sqlite",
  query: ReturnType<typeof sql.raw>,
): Promise<T[]> => {
  if (dialect === "pg") {
    const r = (await db.execute(query)) as unknown;
    if (Array.isArray(r)) return r as T[];
    if (r && typeof r === "object" && "rows" in r) {
      return (r as { rows: T[] }).rows;
    }
    return r as T[];
  }
  return (await db.all(query)) as T[];
};

/**
 * Return the set of column names that have at least one index covering them
 * (as the index's leading column). Dialect-specific catalog introspection;
 * throws are caught by the caller so a check skips gracefully.
 */
const indexedColumns = async (
  db: any,
  dialect: "pg" | "sqlite",
  table: string,
): Promise<Set<string>> => {
  const cols = new Set<string>();
  const safe = table.replace(/"/g, '""');
  if (dialect === "sqlite") {
    // PRAGMA index_list → each index; PRAGMA index_info → its columns.
    const idxList = await runRaw<{ name: string }>(
      db,
      dialect,
      sql.raw(`PRAGMA index_list("${safe}")`),
    );
    for (const idx of idxList) {
      if (!idx?.name) continue;
      const idxSafe = idx.name.replace(/"/g, '""');
      const info = await runRaw<{ seqno: number | string; name: string }>(
        db,
        dialect,
        sql.raw(`PRAGMA index_info("${idxSafe}")`),
      );
      for (const c of info) {
        // Only the leading column of an index helps a single-column filter.
        if (c && Number(c.seqno) === 0 && c.name) cols.add(c.name);
      }
    }
  } else {
    // PG: pg_index → indkey[0] is the leading indexed column's attnum.
    const rows = await runRaw<{ col: string }>(
      db,
      dialect,
      sql.raw(
        `SELECT a.attname AS col
           FROM pg_index i
           JOIN pg_class t ON t.oid = i.indrelid
           JOIN pg_namespace n ON n.oid = t.relnamespace
           JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = i.indkey[0]
          WHERE t.relname = '${safe.replace(/'/g, "''")}'
            AND n.nspname = current_schema()`,
      ),
    );
    for (const r of rows) {
      if (r?.col) cols.add(r.col);
    }
  }
  return cols;
};

/**
 * Run every advisor check against live state. Tenant-scoped: `tenantId`
 * narrows the `collections` / `roles` rows that are inspected so a workspace
 * only sees findings about its own schema and permissions.
 */
export const runAdvisorChecks = async (
  ctx: AdvisorCtx,
  tenantId: string | null,
): Promise<AdvisorResult> => {
  const s = schemaFor(ctx.dialect);
  const db = ctx.db as any;
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
          tenantId ? eq(s.roles.tenantId, tenantId) : undefined,
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
        rule: "public-read",
        groupTitle: "Public reads with no condition",
        title: `Public read on ${row.collection} with no condition`,
        body: `The 'public' role can read ${row.collection} with no DSL condition — anonymous traffic can list every row, including any sensitive fields.`,
        fix: `Remove the public read permission on ${row.collection}, or scope it with a condition such as { is_public: { _eq: true } }.`,
        resource: `permissions · ${row.collection}`,
        link: `/collections/${row.collection}`,
      });
    }
  } catch {
    // permissions table not migrated yet — skip this check silently.
  }

  // Public write permission: the `public` role with a create/update/delete
  // action — anonymous traffic can mutate data.
  try {
    const publicWrites = (await db
      .select({
        collection: s.permissions.collection,
        action: s.permissions.action,
      })
      .from(s.permissions)
      .innerJoin(s.roles, eq(s.permissions.roleId, s.roles.id))
      .where(
        and(
          eq(s.roles.name, "public"),
          tenantId ? eq(s.roles.tenantId, tenantId) : undefined,
        ),
      )) as { collection: string; action: string }[];
    for (const row of publicWrites) {
      if (!["create", "update", "delete"].includes(row.action)) continue;
      out.push({
        id: `sec-public-write-${row.collection}-${row.action}`,
        kind: "security",
        level: "error",
        rule: "public-write",
        groupTitle: "Public write permissions",
        title: `Public ${row.action} on ${row.collection}`,
        body: `The 'public' role can ${row.action} rows on ${row.collection} — anonymous, unauthenticated traffic can mutate this collection.`,
        fix: `Remove the public ${row.action} permission on ${row.collection}. Writes should require the 'authenticated' role at minimum.`,
        resource: `permissions · ${row.collection}`,
        link: `/collections/${row.collection}`,
      });
    }
  } catch {
    // permissions / roles table not migrated — skip.
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
            tenantId ? eq(s.roles.tenantId, tenantId) : undefined,
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
            rule: "owner-scope",
            groupTitle: "Owner-scoped collections with unguarded updates",
            title: `Owner-scoped collection ${coll.slug} has an unguarded update permission`,
            body: missingEntirely
              ? `${coll.slug} is owner-scoped but has no 'authenticated' update permission row — wiring may be incomplete.`
              : `${coll.slug} is owner-scoped but its 'authenticated' update permission has no DSL condition — any signed-in user can edit any row.`,
            fix: `Add { owner_id: { _eq: "$user.id" } } to the authenticated update permission on ${coll.slug}.`,
            resource: `permissions · ${coll.slug}`,
            link: `/collections/${coll.slug}`,
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
      const exp = toMs(key.expiresAt);
      const expired = exp != null && exp <= nowMs;

      // No role scope — active, non-expired key inheriting the owner's roles.
      if (!key.roleId && key.revokedAt == null && !expired) {
        out.push({
          id: `sec-apikey-noscope-${key.id}`,
          kind: "security",
          level: "warn",
          rule: "apikey-noscope",
          groupTitle: "API keys with no role scope",
          title: `API key "${key.name}" has no role scope`,
          body: `${key.prefix} inherits its owner's full role set — including admin if the owner is an admin.`,
          fix: `Bind the key to a narrower role via role_id, or rotate it to a service account that only holds the roles it needs.`,
          resource: `api_keys · ${key.prefix}`,
          link: "/api-keys",
        });
      }

      // Expired but not revoked — harmless (lookup rejects it) but stale.
      if (expired && key.revokedAt == null) {
        out.push({
          id: `sec-apikey-expired-${key.id}`,
          kind: "security",
          level: "info",
          rule: "apikey-expired",
          groupTitle: "Expired API keys not yet revoked",
          title: `API key "${key.name}" is expired but not revoked`,
          body: `${key.prefix} passed its expiry date — auth lookup already rejects it, but the row lingers. Revoking it keeps the key list honest.`,
          fix: `Revoke ${key.prefix} so it drops off the active key list.`,
          resource: `api_keys · ${key.prefix}`,
          link: "/api-keys",
        });
      }
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
        rule: "email-console-fallback",
        groupTitle: "Email transport falls back to the console",
        title: "Email provider falls back to the console adapter",
        body: "No workspace email_config and no deployment EMAIL_PROVIDER credentials are set — verification, reset, and invite mail is logged to stdout instead of being delivered.",
        fix: "Configure Resend, SendGrid, Mailgun, or SES under Settings → Email (or set EMAIL_PROVIDER + EMAIL_FROM in the deployment env).",
        resource: "email_config · provider",
        link: "/settings",
      });
    }
  } catch {
    // email_config read failed — skip.
  }

  // Half-configured OAuth provider: exactly one of id / secret set for a
  // provider — better-auth silently won't wire it up.
  try {
    const oauthPairs: [string, string | undefined, string | undefined][] = [
      ["Google", ctx.env.OAUTH_GOOGLE_CLIENT_ID, ctx.env.OAUTH_GOOGLE_CLIENT_SECRET],
      ["GitHub", ctx.env.OAUTH_GITHUB_CLIENT_ID, ctx.env.OAUTH_GITHUB_CLIENT_SECRET],
    ];
    for (const [name, id, secret] of oauthPairs) {
      const hasId = Boolean(id?.trim());
      const hasSecret = Boolean(secret?.trim());
      if (hasId !== hasSecret) {
        out.push({
          id: `sec-oauth-incomplete-${name.toLowerCase()}`,
          kind: "security",
          level: "warn",
          rule: "oauth-incomplete",
          groupTitle: "Half-configured OAuth providers",
          title: `${name} OAuth is half-configured`,
          body: `Only the ${hasId ? "client ID" : "client secret"} is set for ${name} — better-auth needs both id and secret, so this provider will silently not wire up.`,
          fix: `Set both OAUTH_${name.toUpperCase()}_CLIENT_ID and OAUTH_${name.toUpperCase()}_CLIENT_SECRET in the deployment env, or unset the one that is configured.`,
          resource: `env · OAUTH_${name.toUpperCase()}_*`,
          link: "/authentication",
        });
      }
    }
  } catch {
    // env read failed — skip.
  }

  // No admin user: a workspace with zero admins can lock itself out of
  // every admin-only surface.
  try {
    const adminRows = (await db
      .select({ userId: s.userRoles.userId })
      .from(s.userRoles)
      .innerJoin(s.roles, eq(s.userRoles.roleId, s.roles.id))
      .where(
        and(
          eq(s.roles.name, "admin"),
          tenantId ? eq(s.roles.tenantId, tenantId) : undefined,
        ),
      )) as { userId: string }[];
    if (adminRows.length === 0) {
      out.push({
        id: "sec-no-admin",
        kind: "security",
        level: "warn",
        rule: "no-admin",
        groupTitle: "Workspace has no admin",
        title: "No user holds the admin role",
        body: "No account is assigned the 'admin' role — admin-only surfaces (settings, roles, the database console) have no operator.",
        fix: "Grant the admin role to a trusted account via Users → Roles.",
        resource: "user_roles · admin",
        link: "/users",
      });
    }
  } catch {
    // user_roles / roles table not migrated — skip.
  }

  // --- PERFORMANCE -------------------------------------------------------
  //
  // Static, schema-derived index-presence checks. Each inspects the physical
  // table's index catalog and flags a missing index on a hot query path.
  // Wrapped in try/catch so an introspection failure on either dialect skips
  // the check rather than emitting an unbacked finding.
  try {
    const perfCollRows = (await db
      .select({
        slug: s.collections.slug,
        physicalTable: s.collections.physicalTable,
        ownerScoped: s.collections.ownerScoped,
        adopted: s.collections.adopted,
        ownerIdColumn: s.collections.ownerIdColumn,
        hasCreatedAt: s.collections.hasCreatedAt,
        createdAtColumn: s.collections.createdAtColumn,
        status: s.collections.status,
      })
      .from(s.collections)
      .where(
        tenantId ? eq(s.collections.tenantId, tenantId) : undefined,
      )) as {
      slug: string;
      physicalTable: string;
      ownerScoped: boolean;
      adopted: boolean;
      ownerIdColumn: string | null;
      hasCreatedAt: boolean;
      createdAtColumn: string | null;
      status: string;
    }[];

    for (const coll of perfCollRows) {
      if (coll.status === "archived") continue;
      let cols: Set<string>;
      try {
        cols = await indexedColumns(db, ctx.dialect, coll.physicalTable);
      } catch {
        // Index introspection failed for this table — skip it silently.
        continue;
      }

      // Owner-scoped reads filter by owner_id on every request.
      if (coll.ownerScoped) {
        const ownerCol = coll.ownerIdColumn ?? "owner_id";
        if (!cols.has(ownerCol)) {
          out.push({
            id: `perf-owner-index-${coll.slug}`,
            kind: "performance",
            level: "warn",
            rule: "owner-index",
            groupTitle: "Owner-scoped collections missing an owner_id index",
            title: `${coll.slug} has no index on ${ownerCol}`,
            body: `${coll.slug} is owner-scoped — owner-scoped reads filter by ${ownerCol} on every request; an unindexed ${ownerCol} forces a full scan.`,
            fix: `CREATE INDEX ON ${coll.physicalTable} (${ownerCol}); — or add the index through your migration tooling.`,
            resource: `${coll.physicalTable} · ${ownerCol}`,
            link: `/collections/${coll.slug}`,
          });
        }
      }

      // The items query API default-sorts `-created_at`.
      if (coll.hasCreatedAt) {
        const createdCol = coll.createdAtColumn ?? "created_at";
        if (!cols.has(createdCol)) {
          out.push({
            id: `perf-created-index-${coll.slug}`,
            kind: "performance",
            level: "info",
            rule: "created-index",
            groupTitle: "Collections missing a created_at index",
            title: `${coll.slug} has no index covering ${createdCol}`,
            body: `The items query API default-sorts by -${createdCol}; without a covering index every list request sorts the full table.`,
            fix: `CREATE INDEX ON ${coll.physicalTable} (${createdCol}); — or add the index through your migration tooling.`,
            resource: `${coll.physicalTable} · ${createdCol}`,
            link: `/collections/${coll.slug}`,
          });
        }
      }
    }
  } catch {
    // collections table not migrated — skip the whole performance section.
  }

  return {
    data: out,
    score: computeScore(out),
    generatedAt: new Date().toISOString(),
  };
};
