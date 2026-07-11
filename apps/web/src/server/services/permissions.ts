import { and, eq, inArray, or, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import {
  type Action,
  type AuthPlane,
  type AuthSubject,
  type Condition,
  normalizeCondition,
  SYSTEM_ROLES,
} from "@backlex/core";
import { combineConditions, matchesCondition, type LeafCompiler } from "@backlex/db";
import type { DbCtx } from "./seed";
import {
  buildPermissionRelationLeaf,
  conditionHasDottedKey,
} from "./permission-relations";
import {
  type CachedRoleRow,
  type CachedStaticPermission,
  getCachedRoles,
  getCachedStaticPermission,
  setCachedRoles,
  setCachedStaticPermission,
  sortRoleIds,
} from "./permissions-cache";

type RoleRow = CachedRoleRow;

interface PermissionRow {
  id: string;
  collection: string;
  action: string;
  fields: string[] | null;
  condition: Condition | null;
}

const tablesFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg"
    ? {
        roles: pg.schema.roles,
        userRoles: pg.schema.userRoles,
        appUserRoles: pg.schema.appUserRoles,
        permissions: pg.schema.permissions,
        users: pg.schema.users,
        appUsers: pg.schema.appUsers,
        tenantMembers: pg.schema.tenantMembers,
      }
    : {
        roles: sqlite.schema.roles,
        userRoles: sqlite.schema.userRoles,
        appUserRoles: sqlite.schema.appUserRoles,
        permissions: sqlite.schema.permissions,
        users: sqlite.schema.users,
        appUsers: sqlite.schema.appUsers,
        tenantMembers: sqlite.schema.tenantMembers,
      };

/** True when the control-plane user holds a `suspended` membership row in this
 *  tenant. A suspended member must resolve to zero roles so route permission
 *  checks deny them — suspension is otherwise invisible to the data-plane
 *  resolver (it never consulted membership status). Genuine non-members
 *  (super-admins viewing a foreign workspace) have no row and are unaffected. */
const isMembershipSuspended = async (
  ctx: DbCtx,
  tenantId: string,
  userId: string,
): Promise<boolean> => {
  const t = tablesFor(ctx.dialect);
  const rows = (await (ctx.db as any)
    .select({ id: t.tenantMembers.id })
    .from(t.tenantMembers)
    .where(
      and(
        eq(t.tenantMembers.tenantId, tenantId),
        eq(t.tenantMembers.userId, userId),
        eq(t.tenantMembers.status, "suspended"),
      ),
    )
    .limit(1)) as { id: string }[];
  return rows.length > 0;
};

export const loadRolesForUser = async (
  ctx: DbCtx,
  userId: string | null,
  tenantId: string | null,
  apiKeyRoleId: string | null = null,
  plane: "platform" | "app" = "platform",
): Promise<RoleRow[]> => {
  // Without an active tenant we can't pick the right copy of public/admin/etc.,
  // so deny everything by returning no roles. This is the safe default — the
  // request just hits the public-deny branch in resolvePermission.
  if (!tenantId) return [];
  // L2 cache hit short-circuits both the role join and the underlying DB
  // round-trip. TTL is short (1s) so role demotion is felt almost immediately
  // even across isolates; explicit writes also invalidate.
  const cacheKey = { plane, tenantId, userId, apiKeyRoleId };
  const cached = getCachedRoles(cacheKey);
  if (cached) return cached;
  // Suspension gate (control-plane only — app-plane end-users have no
  // tenant_members row). A suspended member resolves to zero roles here, which
  // is the authoritative deny for every REST/GraphQL/realtime permission check
  // and for any API key the suspended user owns. Cached + invalidated on
  // suspend/activate via invalidateUserRoles.
  if (userId && plane === "platform") {
    if (await isMembershipSuspended(ctx, tenantId, userId)) {
      setCachedRoles(cacheKey, []);
      return [];
    }
  }
  const t = tablesFor(ctx.dialect);
  // Role-scoped API key: the effective role set is exactly the bound role —
  // no implicit `authenticated`, no other roles the owner happens to have —
  // and only while the owner still holds it. If they lost it (or it was
  // deleted), the key resolves to no roles → denied. A scoped key therefore
  // can never grant more than its owner currently has.
  if (apiKeyRoleId) {
    if (!userId) {
      setCachedRoles(cacheKey, []);
      return [];
    }
    const rows = (await (ctx.db as any)
      .select({ id: t.roles.id, name: t.roles.name, admin: t.roles.admin })
      .from(t.userRoles)
      .innerJoin(t.roles, eq(t.userRoles.roleId, t.roles.id))
      .where(
        and(
          eq(t.userRoles.userId, userId),
          eq(t.roles.tenantId, tenantId),
          eq(t.roles.id, apiKeyRoleId),
        ),
      )) as RoleRow[];
    setCachedRoles(cacheKey, rows);
    return rows;
  }
  if (!userId) {
    const rows = (await (ctx.db as any)
      .select()
      .from(t.roles)
      .where(
        and(
          eq(t.roles.tenantId, tenantId),
          eq(t.roles.name, SYSTEM_ROLES.public),
        ),
      )) as RoleRow[];
    setCachedRoles(cacheKey, rows);
    return rows;
  }
  // App-plane identities (workspace end-users from `app_users`) get the
  // workspace's `authenticated` role plus whatever custom roles a workspace
  // admin assigned via `app_user_roles`. They never touch the control-plane
  // `user_roles` table, and any role flagged `admin` is dropped here — a
  // customer can grant broad access only through explicit permissions, never
  // the admin bypass (and a UUID collision with a control-plane user can't
  // leak platform-admin powers either).
  //
  // One LEFT JOIN'd SELECT pulls both the explicitly-assigned roles and the
  // builtin `authenticated` row in a single round-trip — `app_user_roles`
  // matches on the user; the OR brings in the builtin row even when the user
  // has no explicit assignment. `roles.admin` is excluded on the join side
  // so an accidentally-admin custom role can't sneak through.
  if (plane === "app") {
    const rows = (await (ctx.db as any)
      .select({ id: t.roles.id, name: t.roles.name, admin: t.roles.admin })
      .from(t.roles)
      .leftJoin(
        t.appUserRoles,
        and(
          eq(t.appUserRoles.roleId, t.roles.id),
          eq(t.appUserRoles.appUserId, userId),
        ),
      )
      .where(
        and(
          eq(t.roles.tenantId, tenantId),
          or(
            eq(t.roles.name, SYSTEM_ROLES.authenticated),
            and(
              eq(t.appUserRoles.appUserId, userId),
              eq(t.roles.admin, false),
            ),
          ),
        ),
      )) as RoleRow[];
    setCachedRoles(cacheKey, rows);
    return rows;
  }
  // Only consider roles that belong to the active tenant. A user can have
  // role X in tenant A and role Y in tenant B; each request only sees the
  // role bundle for the workspace they're acting in.
  //
  // Same single-SELECT pattern as app-plane: LEFT JOIN user_roles so the
  // builtin `authenticated` row comes back even when the user has no rows
  // in `user_roles` yet.
  const rows = (await (ctx.db as any)
    .select({ id: t.roles.id, name: t.roles.name, admin: t.roles.admin })
    .from(t.roles)
    .leftJoin(
      t.userRoles,
      and(
        eq(t.userRoles.roleId, t.roles.id),
        eq(t.userRoles.userId, userId),
      ),
    )
    .where(
      and(
        eq(t.roles.tenantId, tenantId),
        or(
          eq(t.roles.name, SYSTEM_ROLES.authenticated),
          eq(t.userRoles.userId, userId),
        ),
      ),
    )) as RoleRow[];
  setCachedRoles(cacheKey, rows);
  return rows;
};

export interface ResolvedPermission {
  allowed: boolean;
  isAdmin: boolean;
  /** OR-combined condition across matching permissions; null = unrestricted. */
  whereSql: SQL | null;
  /**
   * Raw conditions across matching permission rows. `null` means at least one
   * matching row had no condition (= unrestricted access). An array means
   * access is granted only when at least one of these conditions matches.
   * Used by the realtime layer to evaluate per-event filters in JS via
   * `matchesCondition`.
   */
  conditions: Condition[] | null;
  /** Union of allowed fields across matching rows; null = all fields. */
  fields: Set<string> | null;
  /**
   * Present only when `conditions` contain dotted relation paths
   * (`employee.app_user_id`). The same leaf compiler that lowered those keys
   * into `whereSql` as correlated EXISTS subqueries — consumers that
   * RE-compile `conditions` (the list handler's join-aware path) must thread
   * it through `combineConditions` so dotted keys keep their lowering.
   */
  relationLeaf?: LeafCompiler;
}

/** Per-request L1 cache. Keyed by `"<collection>:<action>"` because `auth`
 *  is fixed for the lifetime of one request. Optional — when omitted the
 *  resolver falls back to L2+L3 only. */
export type PermResolveCache = Map<string, ResolvedPermission>;

export const resolvePermission = async (
  ctx: DbCtx,
  auth: AuthSubject,
  collection: string,
  action: Action,
  requestCache?: PermResolveCache,
): Promise<ResolvedPermission> => {
  // L1 — same request, same (collection, action) → return the prior result
  // verbatim. `whereSql` already carries this request's auth bindings.
  const memoKey = `${collection}:${action}`;
  if (requestCache) {
    const hit = requestCache.get(memoKey);
    if (hit) return hit;
  }

  const roles = await loadRolesForUser(
    ctx,
    auth.userId,
    auth.tenantId ?? null,
    auth.apiKeyRoleId ?? null,
    auth.plane ?? "platform",
  );

  const remember = (r: ResolvedPermission): ResolvedPermission => {
    requestCache?.set(memoKey, r);
    return r;
  };

  if (roles.some((r) => r.admin)) {
    return remember({
      allowed: true,
      isAdmin: true,
      whereSql: null,
      conditions: null,
      fields: null,
    });
  }
  if (roles.length === 0) {
    return remember({
      allowed: false,
      isAdmin: false,
      whereSql: null,
      conditions: null,
      fields: null,
    });
  }

  // L3 — static permission rows for this (tenant, roleSet, collection,
  // action). Keyed by the role set so two users with the same bundle share
  // one entry. Conditions are cached raw; we rebind `whereSql` with the
  // current `auth` after every hit so `$user.id` etc. always reflect the
  // live identity.
  const tenantId = auth.tenantId!;
  const permCacheKey = {
    tenantId,
    roleIds: sortRoleIds(roles.map((r) => r.id)),
    collection,
    action,
  };
  let staticPerm: CachedStaticPermission | undefined =
    getCachedStaticPermission(permCacheKey);
  if (!staticPerm) {
    const t = tablesFor(ctx.dialect);
    const rows = (await (ctx.db as any)
      .select()
      .from(t.permissions)
      .where(
        and(
          inArray(
            t.permissions.roleId,
            roles.map((r) => r.id),
          ),
          eq(t.permissions.action, action),
          or(
            eq(t.permissions.collection, collection),
            eq(t.permissions.collection, "*"),
          ),
        ),
      )) as PermissionRow[];

    if (rows.length === 0) {
      staticPerm = {
        allowed: false,
        isAdmin: false,
        rawConditions: [],
        fields: null,
      };
    } else {
      // Normalize stored conditions (schema-blind) so hand-authored permission
      // rows may use `_and`/`_or`/`_not` aliases or implicit-equality; canonical
      // rows pass through unchanged. Nested-object flattening needs the schema,
      // so it's intentionally not applied here — permission rules use dotted
      // relation paths, like the compiler has always expected.
      const rawConditions = rows.map((r) =>
        r.condition ? normalizeCondition(r.condition) : r.condition,
      );
      let fields: string[] | null = null;
      for (const r of rows) {
        if (!r.fields) {
          fields = null;
          break;
        }
        if (!fields) fields = [];
        for (const f of r.fields) if (!fields.includes(f)) fields.push(f);
      }
      staticPerm = {
        allowed: true,
        isAdmin: false,
        rawConditions,
        fields,
      };
    }
    setCachedStaticPermission(permCacheKey, staticPerm);
  }

  if (!staticPerm.allowed) {
    return remember({
      allowed: false,
      isAdmin: false,
      whereSql: null,
      conditions: null,
      fields: null,
    });
  }

  // Dotted relation paths in permission conditions lower to correlated
  // EXISTS subqueries (a bare-identifier compile would reference a column
  // that doesn't exist and match nothing). Only built when a condition
  // actually carries a dotted key, so the common path stays free of extra
  // metadata loads.
  const relationLeaf = staticPerm.rawConditions.some(
    (c) => c != null && conditionHasDottedKey(c),
  )
    ? await buildPermissionRelationLeaf(
        ctx,
        tenantId,
        collection,
        staticPerm.rawConditions,
      )
    : undefined;

  const whereSql = combineConditions(
    staticPerm.rawConditions,
    auth,
    undefined,
    relationLeaf,
    { dialect: ctx.dialect },
  );
  const conditions: Condition[] | null = staticPerm.rawConditions.some(
    (c) => c == null,
  )
    ? null
    : (staticPerm.rawConditions as Condition[]);
  const fields = staticPerm.fields ? new Set(staticPerm.fields) : null;

  return remember({
    allowed: true,
    isAdmin: false,
    whereSql,
    conditions,
    fields,
    ...(relationLeaf ? { relationLeaf } : {}),
  });
};

/**
 * Bulk visibility check: which collections may this subject `read` at all?
 * Backs the permission-filtered `GET /api/collections` (list + sidebar tree +
 * palette + CLI/MCP schema reads) — presence of ANY read grant makes a
 * collection visible; row-level conditions still apply on the items reads.
 *
 * Returns `"*"` for admins and wildcard grants (see everything), otherwise
 * the set of collection slugs with at least one read permission row. Roles
 * ride the L2 cache; the single DISTINCT-ish permissions SELECT per call is
 * cheap and stays uncached so grants/revokes are felt immediately.
 */
export const listReadableCollections = async (
  ctx: DbCtx,
  auth: AuthSubject,
): Promise<"*" | Set<string>> => {
  const roles = await loadRolesForUser(
    ctx,
    auth.userId,
    auth.tenantId ?? null,
    auth.apiKeyRoleId ?? null,
    auth.plane ?? "platform",
  );
  if (roles.some((r) => r.admin)) return "*";
  if (roles.length === 0) return new Set();
  const t = tablesFor(ctx.dialect);
  const rows = (await (ctx.db as any)
    .select({ collection: t.permissions.collection })
    .from(t.permissions)
    .where(
      and(
        inArray(
          t.permissions.roleId,
          roles.map((r) => r.id),
        ),
        eq(t.permissions.action, "read"),
      ),
    )) as { collection: string }[];
  const set = new Set(rows.map((r) => r.collection));
  return set.has("*") ? "*" : set;
};

// ---------------------------------------------------------------------------
// Permission simulator ("tester")
//
// A debug surface that answers "would <subject> be allowed to <action> on
// <collection>, and *why*?" — the same resolution path as `resolvePermission`,
// but it returns the full reasoning trace instead of just the allow/deny +
// compiled SQL. It deliberately bypasses the L1/L2/L3 caches so an operator
// always sees the live picture (and so toggling a role mid-debug is felt
// immediately). Shared by REST / SDK / GraphQL / MCP / CLI + the admin UI.
// ---------------------------------------------------------------------------

/** A single permission row that matched the (roles, collection, action) query,
 *  surfaced so an operator can see exactly which grant applied. */
export interface PermissionSimRule {
  permissionId: string;
  roleId: string;
  roleName: string;
  /** The row's own collection binding — the requested slug or `*`. */
  collection: string;
  /** Normalized condition (null = unconditional grant). */
  condition: Condition | null;
  /** Field allow-list on this row (null = all fields). */
  fields: string[] | null;
  /** Present only when a `sampleRow` was supplied: did this rule's condition
   *  match that row? A null condition always matches. */
  rowMatch?: boolean;
}

/** The subject under test. Either an existing identity (`userId`, roles read
 *  from the DB) or an ad-hoc one (`roles` given by name) — both anchored to a
 *  tenant so the right copy of `public`/`authenticated`/etc. is used. */
export interface PermissionSimInput {
  userId?: string | null;
  email?: string | null;
  /** Ad-hoc role *names*; ignored when `userId` is given (those roles are read
   *  from the DB). With neither, the subject is anonymous (the `public` role). */
  roles?: string[] | null;
  tenantId: string | null;
  plane?: AuthPlane;
  collection: string;
  action: Action;
  sampleRow?: Record<string, unknown> | null;
}

export interface PermissionSimResult {
  subject: {
    userId: string | null;
    email: string | null;
    roles: string[];
    tenantId: string | null;
    plane: AuthPlane;
  };
  collection: string;
  action: Action;
  allowed: boolean;
  isAdmin: boolean;
  /** Human-readable explanation of the decision. */
  reason: string;
  /** Every role the subject holds in this tenant (with the admin flag). */
  roles: { id: string; name: string; admin: boolean }[];
  /** Permission rows that granted the action (empty ⇒ denied for lack of one). */
  matchedRules: PermissionSimRule[];
  /** The DSL variables and the concrete values they resolved to for this
   *  subject (`$user.id`, `$user.email`, `$user.roles`, `$tenant.id`, `$now`). */
  resolvedVars: Record<string, unknown>;
  /** OR-combined WHERE clause the REST/GraphQL layers would apply, rendered to
   *  parametrized SQL. null = unrestricted (admin, or a row with no condition). */
  whereSql: { sql: string; params: unknown[] } | null;
  /** Union of allowed fields across matching rows; null = all fields. */
  fields: string[] | null;
  /** Present only when a `sampleRow` was supplied: would that row pass the
   *  combined filter? (OR across rules; admin/unconditional ⇒ true.) */
  rowMatch?: boolean;
}

const renderSql = (
  fragment: SQL,
  dialect: "pg" | "sqlite",
): { sql: string; params: unknown[] } => {
  const q =
    dialect === "pg"
      ? new PgDialect().sqlToQuery(fragment)
      : new SQLiteSyncDialect().sqlToQuery(fragment);
  return { sql: q.sql, params: q.params as unknown[] };
};

/** Resolve the five supported DSL variables to concrete values for display.
 *  `$now` uses the dialect's physical representation (PG ISO string / SQLite
 *  epoch-ms), matching what the compiler binds into the SQL. */
const resolveVarsForDisplay = (
  auth: AuthSubject,
  now: number,
  dialect: "pg" | "sqlite",
): Record<string, unknown> => ({
  "$user.id": auth.userId,
  "$user.email": auth.email,
  "$user.roles": auth.roles,
  "$tenant.id": auth.tenantId ?? null,
  "$now": dialect === "pg" ? new Date(now).toISOString() : now,
});

export const simulatePermission = async (
  ctx: DbCtx,
  input: PermissionSimInput,
): Promise<PermissionSimResult> => {
  const { collection, action } = input;
  const tenantId = input.tenantId;
  const plane: AuthPlane = input.plane ?? "platform";
  const now = Date.now();
  const t = tablesFor(ctx.dialect);

  // Resolve the role bundle. An explicit userId reads the live roles from the
  // DB (the real-world path); ad-hoc role *names* are looked up so we can map
  // them to ids for the permission query; neither ⇒ anonymous (public role).
  let roles: RoleRow[];
  let email = input.email ?? null;
  if (input.userId) {
    roles = await loadRolesForUser(ctx, input.userId, tenantId, null, plane);
    if (!email && tenantId) {
      // Best-effort: surface the subject's email so `$user.email` conditions
      // resolve to a real value (platform users live in `users`, app-plane
      // end-users in the tenant-scoped `app_users`).
      if (plane === "app") {
        const rows = (await (ctx.db as any)
          .select({ email: t.appUsers.email })
          .from(t.appUsers)
          .where(
            and(eq(t.appUsers.id, input.userId), eq(t.appUsers.tenantId, tenantId)),
          )
          .limit(1)) as { email: string | null }[];
        email = rows[0]?.email ?? null;
      } else {
        const rows = (await (ctx.db as any)
          .select({ email: t.users.email })
          .from(t.users)
          .where(eq(t.users.id, input.userId))
          .limit(1)) as { email: string | null }[];
        email = rows[0]?.email ?? null;
      }
    }
  } else if (input.roles && input.roles.length > 0 && tenantId) {
    roles = (await (ctx.db as any)
      .select({ id: t.roles.id, name: t.roles.name, admin: t.roles.admin })
      .from(t.roles)
      .where(
        and(eq(t.roles.tenantId, tenantId), inArray(t.roles.name, input.roles)),
      )) as RoleRow[];
  } else {
    // Anonymous: same path the resolver takes for an unauthenticated request.
    roles = await loadRolesForUser(ctx, null, tenantId, null, plane);
  }

  const roleSummaries = roles.map((r) => ({
    id: r.id,
    name: r.name,
    admin: r.admin,
  }));
  const auth: AuthSubject = {
    userId: input.userId ?? null,
    email,
    roles: roles.map((r) => r.name),
    tenantId,
    plane,
  };
  const resolvedVars = resolveVarsForDisplay(auth, now, ctx.dialect);

  const base = {
    subject: {
      userId: auth.userId,
      email: auth.email,
      roles: auth.roles,
      tenantId,
      plane,
    },
    collection,
    action,
    roles: roleSummaries,
    resolvedVars,
  };

  if (!tenantId) {
    return {
      ...base,
      allowed: false,
      isAdmin: false,
      reason:
        "No active tenant. Without a workspace the resolver can't pick the right roles, so every request is denied.",
      matchedRules: [],
      whereSql: null,
      fields: null,
      ...(input.sampleRow ? { rowMatch: false } : {}),
    };
  }

  const adminRole = roles.find((r) => r.admin);
  if (adminRole) {
    return {
      ...base,
      allowed: true,
      isAdmin: true,
      reason: `Allowed: the admin role "${adminRole.name}" bypasses all permission conditions.`,
      matchedRules: [],
      whereSql: null,
      fields: null,
      ...(input.sampleRow ? { rowMatch: true } : {}),
    };
  }

  if (roles.length === 0) {
    return {
      ...base,
      allowed: false,
      isAdmin: false,
      reason: auth.userId
        ? "Denied: the subject holds no roles in this workspace."
        : "Denied: anonymous access — the `public` role grants nothing here.",
      matchedRules: [],
      whereSql: null,
      fields: null,
      ...(input.sampleRow ? { rowMatch: false } : {}),
    };
  }

  // Live query of the matching permission rows (cache bypassed on purpose) —
  // joined to role names so the trace names each grant.
  const rows = (await (ctx.db as any)
    .select({
      id: t.permissions.id,
      roleId: t.permissions.roleId,
      roleName: t.roles.name,
      collection: t.permissions.collection,
      action: t.permissions.action,
      fields: t.permissions.fields,
      condition: t.permissions.condition,
    })
    .from(t.permissions)
    .innerJoin(t.roles, eq(t.permissions.roleId, t.roles.id))
    .where(
      and(
        inArray(
          t.permissions.roleId,
          roles.map((r) => r.id),
        ),
        eq(t.permissions.action, action),
        or(
          eq(t.permissions.collection, collection),
          eq(t.permissions.collection, "*"),
        ),
      ),
    )) as {
    id: string;
    roleId: string;
    roleName: string;
    collection: string;
    action: string;
    fields: string[] | null;
    condition: Condition | null;
  }[];

  if (rows.length === 0) {
    return {
      ...base,
      allowed: false,
      isAdmin: false,
      reason: `Denied: no permission grants \`${action}\` on "${collection}" for role(s) ${roleSummaries
        .map((r) => `"${r.name}"`)
        .join(", ")}.`,
      matchedRules: [],
      whereSql: null,
      fields: null,
      ...(input.sampleRow ? { rowMatch: false } : {}),
    };
  }

  const normalized = rows.map((r) =>
    r.condition ? normalizeCondition(r.condition) : null,
  );

  // Field allow-list union — any row with a null fields list opens all fields.
  let fields: string[] | null = null;
  for (const r of rows) {
    if (!r.fields) {
      fields = null;
      break;
    }
    if (!fields) fields = [];
    for (const f of r.fields) if (!fields.includes(f)) fields.push(f);
  }

  const whereFragment = combineConditions(normalized, auth, undefined, undefined, {
    now,
    dialect: ctx.dialect,
  });
  const whereSql = whereFragment ? renderSql(whereFragment, ctx.dialect) : null;

  // Per-row + overall sample-row evaluation (JS predicate, OR across rules).
  let overallRowMatch: boolean | undefined;
  const matchedRules: PermissionSimRule[] = rows.map((r, i) => {
    const condition = normalized[i] ?? null;
    let rowMatch: boolean | undefined;
    if (input.sampleRow) {
      rowMatch = condition
        ? matchesCondition(input.sampleRow, condition, auth, { now })
        : true;
      overallRowMatch = (overallRowMatch ?? false) || rowMatch;
    }
    return {
      permissionId: r.id,
      roleId: r.roleId,
      roleName: r.roleName,
      collection: r.collection,
      condition,
      fields: r.fields,
      ...(rowMatch === undefined ? {} : { rowMatch }),
    };
  });

  const unconditional = normalized.some((c) => c === null);
  return {
    ...base,
    allowed: true,
    isAdmin: false,
    reason: unconditional
      ? `Allowed: an unconditional grant on "${collection}" applies (no row filter).`
      : `Allowed, filtered: access is scoped by the combined condition from ${rows.length} matching rule(s).`,
    matchedRules,
    whereSql,
    fields,
    ...(input.sampleRow ? { rowMatch: overallRowMatch ?? false } : {}),
  };
};
