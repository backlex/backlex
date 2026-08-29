import { and, eq, inArray, ne, or, type SQL } from "drizzle-orm";
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
import { resolveOrgContext, type OrgContext } from "./app-orgs";
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
        appOrgMemberRoles: pg.schema.appOrgMemberRoles,
        permissions: pg.schema.permissions,
        users: pg.schema.users,
        appUsers: pg.schema.appUsers,
        tenantMembers: pg.schema.tenantMembers,
      }
    : {
        roles: sqlite.schema.roles,
        userRoles: sqlite.schema.userRoles,
        appUserRoles: sqlite.schema.appUserRoles,
        appOrgMemberRoles: sqlite.schema.appOrgMemberRoles,
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
/**
 * Does this control-plane user hold a usable membership in this workspace?
 *
 * "Usable" excludes `suspended` — a banned member must resolve to zero roles —
 * and it deliberately INCLUDES `invited`, because an invite row exists before
 * the account does and binding it is what `onUserCreated` does; a row whose
 * `user_id` matches is already past that point.
 *
 * This replaced a narrower `isMembershipSuspended`, and the difference is the
 * whole point. Asking "is this person banned here?" answers `false` for a
 * complete stranger, so the query below then handed that stranger the
 * workspace's `authenticated` role — which `seedOwnerScopedPermissions` gives
 * an unconditional `create` on every owner-scoped collection. Asking "is this
 * person a member?" answers `false` for both, which is the honest reading of a
 * bundle named "authenticated": authenticated *in this workspace*, not merely
 * signed in somewhere on the deployment.
 */
const isActiveMember = async (
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
        ne(t.tenantMembers.status, "suspended"),
      ),
    )
    .limit(1)) as { id: string }[];
  return rows.length > 0;
};

/**
 * How the caller reached this workspace.
 *
 * `"member"` — they hold a `tenant_members` row. The ordinary case, and the
 * one every route gets unless something explicitly says otherwise.
 *
 * `"operator-visit"` — the INSTANCE OPERATOR (admin of the default workspace,
 * or `OWNER_EMAIL`) looking at a workspace they do not belong to. This is what
 * makes the admin workspace-switcher work for the one principal it was written
 * for. It is not a role, it is not stored, and no route hands it out: only
 * `tenantMiddleware` mints it, and only after `isInstanceOperator` said yes.
 *
 * Undefined resolves to `"member"` everywhere, so a caller that forgets gets
 * the STRICTER answer. That direction is not an accident — a hand-built
 * `AuthSubject` (the job queue rebuilds one) must not be able to acquire
 * cross-workspace reach by omission.
 */
export type WorkspaceAccess = "member" | "operator-visit";

export const loadRolesForUser = async (
  ctx: DbCtx,
  userId: string | null,
  tenantId: string | null,
  opts: {
    apiKeyRoleId?: string | null;
    plane?: "platform" | "app";
    /** Active app-plane organization, when the request has one. Adds the roles
     *  bound to this member *within that org* (`app_org_member_roles`) on top
     *  of their workspace-wide ones. Ignored on the platform plane. */
    orgId?: string | null;
    /**
     * REQUIRED, and required on purpose. This used to be absent, and its
     * absence was the defect: the control-plane branch of the query below
     * filters on `roles.tenant_id` and `user_roles.user_id` and had NO
     * membership term at all, so containment rested entirely on
     * `tenantMiddleware` refusing to set `auth.tenantId` — a single refusal,
     * one bypass away from being handed out. Making every caller state the
     * answer is what turns that from an invariant somebody has to remember
     * into one the compiler asks about.
     */
    access: WorkspaceAccess;
  },
): Promise<RoleRow[]> => {
  const apiKeyRoleId = opts.apiKeyRoleId ?? null;
  const plane = opts.plane ?? "platform";
  const orgId = opts.orgId ?? null;
  const access = opts.access;
  // Without an active tenant we can't pick the right copy of public/admin/etc.,
  // so deny everything by returning no roles. This is the safe default — the
  // request just hits the public-deny branch in resolvePermission.
  if (!tenantId) return [];
  // L2 cache hit short-circuits both the role join and the underlying DB
  // round-trip. TTL is short (1s) so role demotion is felt almost immediately
  // even across isolates; explicit writes also invalidate.
  //
  // `orgId` is part of the key: the same person in org A and org B resolves to
  // two different role bundles, and collapsing them would leak grants across
  // orgs for a full TTL window.
  const cacheKey = { plane, tenantId, userId, apiKeyRoleId, orgId, access };
  const cached = getCachedRoles(cacheKey);
  if (cached) return cached;
  // Membership gate (control-plane only — app-plane end-users have no
  // tenant_members row; their session is pinned to its issuing workspace
  // instead, which is the same guarantee by a different mechanism).
  //
  // A non-member resolves to zero roles here, and that is the authoritative
  // deny for every REST / GraphQL / realtime check and for any API key the
  // user owns. It subsumes the suspension gate this replaced: a suspended
  // member is not an active member.
  //
  // The `operator-visit` escape is the admin workspace-switcher, and only
  // `tenantMiddleware` can mint it — after `isInstanceOperator` said yes, not
  // after finding the name "admin" somewhere in the user's role rows.
  // Invalidated on suspend / activate / membership change via
  // `invalidateUserRoles`.
  if (userId && plane === "platform" && access === "member") {
    if (!(await isActiveMember(ctx, tenantId, userId))) {
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
    // Org-scoped grants (`app_org_member_roles`) sit on top: the same person
    // can be an Editor in org A and hold nothing in org B, so these are only
    // pulled in for the org the request is actually acting in. Same `admin`
    // exclusion as above — an org owner must never be able to hand out the
    // workspace admin bypass.
    if (orgId) {
      const orgRows = (await (ctx.db as any)
        .select({ id: t.roles.id, name: t.roles.name, admin: t.roles.admin })
        .from(t.appOrgMemberRoles)
        .innerJoin(t.roles, eq(t.appOrgMemberRoles.roleId, t.roles.id))
        .where(
          and(
            eq(t.appOrgMemberRoles.orgId, orgId),
            eq(t.appOrgMemberRoles.appUserId, userId),
            eq(t.roles.tenantId, tenantId),
            eq(t.roles.admin, false),
          ),
        )) as RoleRow[];
      const seen = new Set(rows.map((r) => r.id));
      for (const r of orgRows) if (!seen.has(r.id)) rows.push(r);
    }
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

  const roles = await loadRolesForUser(ctx, auth.userId, auth.tenantId ?? null, {
    apiKeyRoleId: auth.apiKeyRoleId ?? null,
    plane: auth.plane ?? "platform",
    orgId: auth.orgId ?? null,
    // `tenantMiddleware` stamps this after it decides HOW the caller reached
    // the workspace. Falling back to "member" rather than to the permissive
    // value matters: an `AuthSubject` rebuilt outside the request path (the
    // job queue does this) has no `access`, and the strict answer is the one
    // that stays correct when someone forgets.
    access: auth.access ?? "member",
  });

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
  const roles = await loadRolesForUser(ctx, auth.userId, auth.tenantId ?? null, {
    apiKeyRoleId: auth.apiKeyRoleId ?? null,
    plane: auth.plane ?? "platform",
    orgId: auth.orgId ?? null,
    access: auth.access ?? "member",
  });
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
  /** App-plane only: the organization to simulate acting in (id or slug). It
   *  binds `$org.id` / `$org.role` and pulls in the subject's org-scoped role
   *  grants, so "would this member see org B's rows?" is answerable without
   *  signing in as them. Ignored on the platform plane. */
  orgId?: string | null;
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
    /** App-plane only: the org the simulation ran in, and every org the
     *  subject belongs to. Null/empty on the platform plane. */
    orgId?: string | null;
    orgRole?: string | null;
    orgIds?: string[];
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

/** Resolve the supported DSL variables to concrete values for display.
 *  `$now` uses the dialect's physical representation (PG ISO string / SQLite
 *  epoch-ms), matching what the compiler binds into the SQL. The `$org.*`
 *  trio only means anything on the app plane, so it's omitted for
 *  platform-plane subjects rather than shown as a row of nulls. */
const resolveVarsForDisplay = (
  auth: AuthSubject,
  now: number,
  dialect: "pg" | "sqlite",
): Record<string, unknown> => ({
  "$user.id": auth.userId,
  "$user.email": auth.email,
  "$user.roles": auth.roles,
  "$tenant.id": auth.tenantId ?? null,
  ...(auth.plane === "app"
    ? {
        "$org.id": auth.orgId ?? null,
        "$org.role": auth.orgRole ?? null,
        "$user.orgs": auth.orgIds ?? [],
      }
    : {}),
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

  // App-plane org context. Resolved before the role load because org-scoped
  // grants are part of the bundle — simulating "in org B" must produce exactly
  // what a real request in org B would. The simulator deliberately bypasses
  // caches everywhere else, but this path reuses `resolveOrgContext` so its
  // membership rules (header must name a real membership, sole-org fallback)
  // are the ones under test rather than a second copy.
  let orgCtx: OrgContext = { orgId: null, orgRole: null, orgIds: [] };
  if (plane === "app" && input.userId && tenantId) {
    try {
      orgCtx = await resolveOrgContext(ctx, tenantId, input.userId, {
        requestedOrg: input.orgId ?? null,
      });
    } catch {
      // A non-membership `orgId` is a legitimate thing to ask about ("what
      // would they see in an org they don't belong to?") — answer with no org
      // context rather than failing the whole simulation.
      orgCtx = { orgId: null, orgRole: null, orgIds: [] };
    }
  }

  // Resolve the role bundle. An explicit userId reads the live roles from the
  // DB (the real-world path); ad-hoc role *names* are looked up so we can map
  // them to ids for the permission query; neither ⇒ anonymous (public role).
  let roles: RoleRow[];
  let email = input.email ?? null;
  if (input.userId) {
    // The simulator answers "what would THIS member see", which is the
    // question the operator is asking — never "what would the instance
    // operator see if they visited". Modelling the visit here would have the
    // tool report reach that the person being simulated does not have.
    roles = await loadRolesForUser(ctx, input.userId, tenantId, {
      plane,
      orgId: orgCtx.orgId,
      access: "member",
    });
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
    // Anonymous — no user id, so the membership gate never runs; `access` is
    // stated anyway because the parameter is required and silence is what this
    // change exists to remove.
    roles = await loadRolesForUser(ctx, null, tenantId, { plane, access: "member" });
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
    orgId: orgCtx.orgId,
    orgRole: orgCtx.orgRole,
    orgIds: orgCtx.orgIds,
  };
  const resolvedVars = resolveVarsForDisplay(auth, now, ctx.dialect);

  const base = {
    subject: {
      userId: auth.userId,
      email: auth.email,
      roles: auth.roles,
      tenantId,
      plane,
      ...(plane === "app"
        ? {
            orgId: orgCtx.orgId,
            orgRole: orgCtx.orgRole,
            orgIds: orgCtx.orgIds,
          }
        : {}),
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
