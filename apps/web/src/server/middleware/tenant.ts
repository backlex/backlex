import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import { and, eq, ne, or } from "drizzle-orm";
import { AppError } from "@backlex/core";
import type { MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { isPublicSubresource } from "../lib/public-paths";
import type { AppBindings } from "../app";
import {
  getCachedMembership,
  getCachedTenantResolve,
  getCachedTenantRoleNames,
  setCachedMembership,
  setCachedTenantResolve,
  setCachedTenantRoleNames,
} from "../services/permissions-cache";
import { ensureDefaultTenant } from "../services/seed";
import { resolveOrgContext, type OrgContext } from "../services/app-orgs";
import { isInstanceOperator } from "../services/roles/guards";
import type { WorkspaceAccess } from "../services/permissions";

/** Loose UUID v4-ish shape check — strict enough to avoid false positives on
 *  slugs (which can't contain `-` in groups of 8-4-4-4-12 hex). When a cookie
 *  value matches we skip the dedicated tenant lookup and rely on the membership
 *  check below to validate that the id really exists for this user. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const TENANT_COOKIE = "backlex-tenant";
export const TENANT_HEADER = "x-backlex-tenant";
/** App-plane organization override — an `app_orgs` id or slug. Only honoured
 *  for identities that are actually a member of it; see
 *  `services/app-orgs.ts::resolveOrgContext`. */
export const ORG_HEADER = "x-backlex-org";

const tablesFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg"
    ? {
        tenants: pg.schema.tenants,
        members: pg.schema.tenantMembers,
        users: pg.schema.users,
        roles: pg.schema.roles,
        userRoles: pg.schema.userRoles,
      }
    : {
        tenants: sqlite.schema.tenants,
        members: sqlite.schema.tenantMembers,
        users: sqlite.schema.users,
        roles: sqlite.schema.roles,
        userRoles: sqlite.schema.userRoles,
      };

/** Roles the user holds *within this tenant*. Used by tenantMiddleware to
 *  rewrite auth.roles after the active tenant is known — sessionMiddleware
 *  can't filter by tenant because resolution hasn't happened yet there.
 *
 *  `restrictRoleId` (set when the request authenticated with a role-scoped
 *  API key) narrows the result to that single role — and only while the
 *  owner still holds it, so a scoped key can never out-live the grant. */
const loadTenantRoleNames = async (
  db: unknown,
  dialect: "pg" | "sqlite",
  tenantId: string,
  userId: string,
  restrictRoleId: string | null,
): Promise<string[]> => {
  // Hot path: served from the per-isolate cache, invalidated on role grant/
  // revoke (invalidateUserRoles), role-def change (invalidateTenantRoles), and
  // membership change (invalidateTenantMembership). See services/permissions-cache.
  // Copy on hit so a caller that mutates auth.roles can't corrupt the entry.
  const cacheKey = { tenantId, userId, restrictRoleId };
  const cached = getCachedTenantRoleNames(cacheKey);
  if (cached) return [...cached];
  const t = tablesFor(dialect);
  const rows = (await (db as any)
    .select({ name: t.roles.name })
    .from(t.userRoles)
    .innerJoin(t.roles, eq(t.userRoles.roleId, t.roles.id))
    .where(
      restrictRoleId
        ? and(
            eq(t.userRoles.userId, userId),
            eq(t.roles.tenantId, tenantId),
            eq(t.roles.id, restrictRoleId),
          )
        : and(eq(t.userRoles.userId, userId), eq(t.roles.tenantId, tenantId)),
    )) as { name: string }[];
  const names = rows.map((r) => r.name);
  setCachedTenantRoleNames(cacheKey, names);
  return names;
};

const tenantBySlugOrId = async (
  db: unknown,
  dialect: "pg" | "sqlite",
  key: string,
): Promise<string | null> => {
  // Per-isolate cache: this runs on every request and is usually the first D1
  // call, so it pays the D1 Sessions setup (~25ms in traces, vs <1ms SQL).
  // slug→id / id→id are stable; caching removes the last uncached round-trip on
  // the hot path. See services/permissions-cache `tenantResolveCache`.
  const cached = getCachedTenantResolve(key);
  if (cached !== undefined) return cached;
  const t = tablesFor(dialect).tenants;
  // One SELECT against `id = ? OR slug = ?` is cheaper than the two sequential
  // round-trips the previous version did, and the table is small (rows.length
  // ≤ 1 since both id and slug are unique).
  const rows = (await (db as any)
    .select({ id: t.id })
    .from(t)
    .where(or(eq(t.id, key), eq(t.slug, key)))
    .limit(1)) as { id: string }[];
  const id = rows[0]?.id ?? null;
  if (id) setCachedTenantResolve(key, id);
  return id;
};

const isMember = async (
  db: unknown,
  dialect: "pg" | "sqlite",
  tenantId: string,
  userId: string,
): Promise<boolean> => {
  // "Active member" check: a `suspended` membership is treated as NON-member so
  // suspension actually revokes workspace access on the request path (re-login
  // no longer restores it). Cached per isolate; the suspend/activate handlers
  // call invalidateTenantMembership so a status flip is felt immediately.
  const cacheKey = { tenantId, userId };
  const cached = getCachedMembership(cacheKey);
  if (cached !== undefined) return cached;
  const m = tablesFor(dialect).members;
  const rows = (await (db as any)
    .select({ id: m.id })
    .from(m)
    .where(
      and(
        eq(m.tenantId, tenantId),
        eq(m.userId, userId),
        ne(m.status, "suspended"),
      ),
    )
    .limit(1)) as { id: string }[];
  const result = rows.length > 0;
  setCachedMembership(cacheKey, result);
  return result;
};

/** Does this user hold a *suspended* membership row in this tenant? Used only on
 *  the membership-failure path to deny the cross-tenant super-admin shortcut to
 *  a banned member (a non-member viewing a foreign workspace has no row at all,
 *  status 'none', and must keep the shortcut). Uncached — the failure path is
 *  rare, so a fresh read is cheap and always reflects the live status. */
const isSuspendedMember = async (
  db: unknown,
  dialect: "pg" | "sqlite",
  tenantId: string,
  userId: string,
): Promise<boolean> => {
  const m = tablesFor(dialect).members;
  const rows = (await (db as any)
    .select({ id: m.id })
    .from(m)
    .where(
      and(
        eq(m.tenantId, tenantId),
        eq(m.userId, userId),
        eq(m.status, "suspended"),
      ),
    )
    .limit(1)) as { id: string }[];
  return rows.length > 0;
};

/** Lightweight existence check for a tenant id. Used only by the cross-tenant
 *  admin shortcut to keep the UUID-cookie bypass from leaking a syntactically-
 *  valid but non-existent id into `auth.tenantId` for the rest of the request. */
const tenantExists = async (
  db: unknown,
  dialect: "pg" | "sqlite",
  tenantId: string,
): Promise<boolean> => {
  const t = tablesFor(dialect).tenants;
  const rows = (await (db as any)
    .select({ id: t.id })
    .from(t)
    .where(eq(t.id, tenantId))
    .limit(1)) as { id: string }[];
  return rows.length > 0;
};

/**
 * May this control-plane identity act in this workspace, and with which role
 * names?
 *
 * The one answer to that question. `tenantMiddleware` asks it on every request;
 * a queued job asks it again when it runs, because a job outlives the request
 * that enqueued it and the grant that justified it can be gone by then. Two
 * copies of this decision would drift, and the half that drifted would be the
 * one nobody was watching.
 *
 *   - `roles: null` — refused. The caller nulls the tenant (a request) or fails
 *     the job (the queue). It is deliberately not an empty array: "no roles" and
 *     "not allowed here" are different answers and only one of them is safe to
 *     fall through on.
 *   - `viaAdminShortcut` — access came from the cross-tenant super-admin path
 *     rather than membership. The request path uses it to avoid pinning the
 *     tenant cookie: a support visit must not silently move the admin's own
 *     workspace.
 *
 * `apiKeyId` closes an escalation: an admin-owned API key is confined to the
 * workspaces it is scoped to, never every workspace its owner can reach
 * interactively, so a key never gets the shortcut.
 */
export interface TenantAccess {
  roles: string[] | null;
  viaAdminShortcut: boolean;
  /** What to stamp on `auth.access`, and what the role resolver is told. */
  access: WorkspaceAccess;
}

export const resolveTenantAccess = async (
  db: unknown,
  dialect: "pg" | "sqlite",
  tenantId: string,
  userId: string,
  opts: {
    apiKeyRoleId?: string | null;
    apiKeyId?: string | null;
    /**
     * Needed for the instance-operator check, which is now what gates the
     * cross-workspace shortcut. `OWNER_EMAIL` is one of its two arms — the
     * other is `admin` in the DEFAULT workspace — so the env and the caller's
     * address both have to reach it. Optional so the shape stays compatible
     * with a caller that has neither; a missing env simply means the
     * `OWNER_EMAIL` arm cannot fire, never that the check is skipped.
     */
    env?: { OWNER_EMAIL?: string | undefined };
    email?: string | null;
    plane?: string;
  } = {},
): Promise<TenantAccess> => {
  const apiKeyRoleId = opts.apiKeyRoleId ?? null;
  // Hot path: run the membership check and the tenant-scoped role load in
  // parallel. If membership fails we fall back to a lazy global-admin lookup
  // (the only reason we'd ever need the unfiltered role union) — this keeps
  // the lookup off the request path for every member-of-tenant call, which
  // is by far the common case.
  const [member, scopedRoles] = await Promise.all([
    isMember(db, dialect, tenantId, userId),
    loadTenantRoleNames(db, dialect, tenantId, userId, apiKeyRoleId),
  ]);
  if (member) return { roles: scopedRoles, viaAdminShortcut: false, access: "member" };

  // Membership failed — last chance is the INSTANCE OPERATOR. We also confirm
  // the tenant actually exists so a forged UUID can't ride the UUID-bypass into
  // `auth.tenantId` for the rest of the request (the resolver would still deny
  // on permissions, but audit logs / route handlers that trust `auth.tenantId`
  // would see a bogus id).
  //
  // This used to key on `loadUnfilteredRoleNames(...).includes("admin")` — a
  // union of role NAMES across every workspace, with no tenant predicate. That
  // made the shortcut self-serve: `POST /api/tenants` is gated by `requireUser`
  // alone and grants the creator `admin` in the workspace they just made, so
  // clicking "New workspace" put the name "admin" into that union and unlocked
  // every OTHER workspace on the instance. `services/roles/guards.ts` already
  // said this in writing — "that role name is self-serve and can never gate
  // power that spans the whole database" — and this call site was the one
  // place not honouring it.
  //
  // `isInstanceOperator` is the same function the SQL console gates on: admin
  // of the DEFAULT workspace (where the first signup is seeded), or
  // `OWNER_EMAIL`. A workspace minted later confers neither.
  const [exists, suspendedHere, operator] = await Promise.all([
    tenantExists(db, dialect, tenantId),
    isSuspendedMember(db, dialect, tenantId, userId),
    isInstanceOperator(
      { db, dialect, env: opts.env ?? {} },
      {
        plane: opts.plane ?? "platform",
        userId,
        email: opts.email ?? null,
        apiKeyId: opts.apiKeyId ?? null,
      },
    ),
  ]);
  // A suspended member is denied even if they are the operator: the shortcut is
  // only for genuine non-members (status 'none') viewing a foreign workspace,
  // never for someone banned from this one.
  if (operator && exists && !suspendedHere) {
    // The operator keeps tenant-scoped role names — the shortcut decides
    // *whether* they may act here, never *as what*. `access` is what lets the
    // role resolver hand back that scoped bundle at all: with `"member"` it
    // now requires a `tenant_members` row, which by definition the operator
    // does not have here.
    return { roles: scopedRoles, viaAdminShortcut: true, access: "operator-visit" };
  }
  return { roles: null, viaAdminShortcut: false, access: "member" };
};

const firstUserTenant = async (
  db: unknown,
  dialect: "pg" | "sqlite",
  userId: string,
): Promise<string | null> => {
  const m = tablesFor(dialect).members;
  // Skip suspended memberships so a suspended user isn't auto-routed back into
  // the workspace they were just removed from (they fall through to the default
  // tenant / denial instead).
  const rows = (await (db as any)
    .select({ tenantId: m.tenantId })
    .from(m)
    .where(and(eq(m.userId, userId), ne(m.status, "suspended")))
    .limit(1)) as { tenantId: string }[];
  return rows[0]?.tenantId ?? null;
};

// ── Hot-path write throttling ──────────────────────────────────────────────
// persistActive + touchMember run on every authenticated request and both
// writes hit the D1 PRIMARY (cross-region for most colos — e.g. a FRA worker
// against a London primary). Re-issuing them when nothing changed is pure
// waste, so throttle per isolate:
//   • active_tenant_id — write only when it actually changes for a user.
//   • last_seen_at     — at most once per minute per (tenant, user).
// Keys are random ids; a stale entry left over from a prior test harness can
// only cause a harmless *skip*, never an FK error, so no cross-harness reset
// is needed (unlike the id-bearing permission caches).
const lastActiveTenant = new Map<string, string>();
const lastSeenWrite = new Map<string, number>();
const LAST_SEEN_DEBOUNCE_MS = 60_000;

/** Run a best-effort write off the request's critical path. `waitUntil` keeps
 *  the isolate alive until it resolves so the row reliably persists — a bare
 *  `void` promise can be cancelled by the runtime once the response returns.
 *  Falls back to a dangling promise on runtimes without an ExecutionContext
 *  (Bun-native / tests), matching the previous fire-and-forget behavior. */
const deferWrite = (
  c: { executionCtx: { waitUntil(p: Promise<unknown>): void } },
  run: () => Promise<unknown>,
): void => {
  const p = run().catch(() => {});
  try {
    c.executionCtx.waitUntil(p);
  } catch {
    /* no ExecutionContext — the promise still runs to completion */
  }
};

const persistActive = async (
  db: unknown,
  dialect: "pg" | "sqlite",
  userId: string,
  tenantId: string,
): Promise<void> => {
  const u = tablesFor(dialect).users;
  await (db as any)
    .update(u)
    .set({ activeTenantId: tenantId, updatedAt: new Date() })
    .where(eq(u.id, userId));
};

/** Touch tenant_members.last_seen_at on every authenticated request so the
 *  Members panel can show "active 2m ago" without joining sessions. */
const touchMember = async (
  db: unknown,
  dialect: "pg" | "sqlite",
  tenantId: string,
  userId: string,
): Promise<void> => {
  const m = tablesFor(dialect).members;
  try {
    await (db as any)
      .update(m)
      .set({ lastSeenAt: dialect === "pg" ? new Date() : Date.now() })
      .where(and(eq(m.tenantId, tenantId), eq(m.userId, userId)));
  } catch {
    // If the column doesn't exist yet (pre-migration deploy) just skip —
    // the next deploy applies the migration and this resumes working.
  }
};

/**
 * Resolve the active tenant for the request:
 *   1. `X-Backlex-Tenant` header (slug or id)
 *   2. `backlex-tenant` cookie
 *   3. user.activeTenantId
 *   4. first tenant the user belongs to
 *   5. default tenant (created on demand)
 *
 * Sets `auth.tenantId` so it propagates into the permission DSL via $tenant.id
 * and is available to every route via `c.get("auth").tenantId`.
 */
export const tenantMiddleware: MiddlewareHandler<AppBindings> = async (c, next) => {
  const ctx = c.get("ctx");
  const auth = c.get("auth");
  const db = ctx.db;
  const dialect = ctx.dialect;

  let tenantId: string | null = null;
  /** The workspace the caller ASKED for by header, if they asked at all. */
  let headerWanted: string | null = null;
  /** Whether `tenantId` currently holds what that header resolved to. */
  let tenantFromHeader = false;

  // Resolve the requested tenant id. UUIDs are accepted *as-is* — the membership
  // check below catches bogus ids cheaply, so we skip the dedicated lookup. Non-
  // UUID values (slugs) still need the SELECT to map slug → id.
  const resolveTenantKey = async (key: string): Promise<string | null> => {
    if (UUID_RE.test(key)) return key;
    return tenantBySlugOrId(db, dialect, key);
  };

  const headerKey = c.req.header(TENANT_HEADER);
  // API keys with a home workspace are PINNED to it — a header override is
  // ignored (and a non-matching one rejected) so a key (possibly owned by an
  // admin) can never be pointed at another workspace via `X-Backlex-Tenant`.
  // This mirrors the app-plane pinning below and, together with blocking the
  // cross-tenant admin shortcut for API keys, confines every key to its tenant.
  if (auth.apiKeyId && auth.apiKeyTenantId) {
    if (headerKey) {
      const requested = await resolveTenantKey(headerKey);
      if (requested && requested !== auth.apiKeyTenantId) {
        throw new AppError(
          "FORBIDDEN",
          "API key is bound to a different workspace",
        );
      }
    }
    tenantId = auth.apiKeyTenantId;
  } else if (headerKey) {
    tenantId = await resolveTenantKey(headerKey);
    // An explicit `X-Backlex-Tenant: typo` used to answer, with a 200, for
    // whichever workspace the caller happened to default to — a slug matching
    // nothing resolved to `null` and fell straight through the chain below.
    // Reads returned another workspace's rows and writes landed in it.
    //
    // An empty or whitespace-only value is still treated as absent: that is
    // indistinguishable from not sending the header, and some clients send one
    // either way.
    // Truncated: the value is echoed back in the refusal below, and a header
    // is caller-supplied.
    if (headerKey.trim() !== "") headerWanted = headerKey.trim().slice(0, 80);
    tenantFromHeader = tenantId !== null;
  }
  // Global (un-pinned) API keys fall back to their owner's tenant resolution
  // below; a pinned key already set `tenantId` above.
  if (!tenantId && auth.apiKeyTenantId) {
    tenantId = auth.apiKeyTenantId;
  }
  // App-plane sessions are bound to the workspace that issued them; ignore
  // any header/cookie overrides so a customer's frontend can't accidentally
  // walk into another workspace's data.
  if (auth.plane === "app" && auth.appSessionTenantId) {
    tenantId = auth.appSessionTenantId;
  }
  /**
   * The single refusal for "you named a workspace and cannot have it".
   *
   * Deliberately ONE message for two causes — the slug matches nothing, or it
   * matches one the caller is not a member of. Answering differently would
   * turn the header into an existence oracle: any signed-in user could probe
   * slugs and read off which workspaces exist from the status code alone.
   * Before this whole change both cases fell through to the caller's own
   * workspace, so they were indistinguishable; they stay that way.
   */
  const refuseHeaderWorkspace = (): never => {
    throw new AppError(
      "NOT_FOUND",
      `No workspace matches X-Backlex-Tenant "${headerWanted}", or you do not have access to it. An unknown workspace is refused rather than falling back to your default one.`,
    );
  };

  // Checked AFTER the pinning branches above, so the two callers whose header
  // is ignored on purpose keep working: an app-plane session is bound to the
  // workspace that issued it, and a pinned API key to its home one. Only a
  // caller whose header was actually meant to choose the workspace is refused.
  if (headerWanted && !tenantId) refuseHeaderWorkspace();
  if (!tenantId) {
    const cookieKey = getCookie(c, TENANT_COOKIE);
    if (cookieKey) tenantId = await resolveTenantKey(cookieKey);
  }
  // Control-plane users: confirm the requested tenant is one they belong to
  // (admins bypass). App-plane users are bound to the workspace their session
  // was issued for — that's authoritative, and they have no `tenant_members`
  // row, so the membership check (and the `tenant_members`/`users` fallbacks
  // and writes below) don't apply to them.
  //
  // Hot path: run the membership check and the tenant-scoped role load in
  // parallel. If membership fails we fall back to a lazy global-admin lookup
  // (the only reason we'd ever need the unfiltered role union) — this keeps
  // the lookup off the request path for every member-of-tenant call, which
  // is by far the common case.
  let tenantRoles: string[] = [];
  // Whether to persist this tenant choice in the backlex-tenant cookie.
  // Default true — the common case is a member operating on a workspace they
  // belong to. Flipped to false when we're letting a cross-tenant admin
  // *view* another workspace via the super-admin shortcut: their actual home
  // workspace should not be silently overwritten by a one-shot visit.
  let pinTenantCookie = true;
  /** Stamped on `auth` below so the permission resolver is told HOW the caller
   *  got here. Defaults to the strict value, and only the operator branch
   *  moves it. */
  let workspaceAccess: WorkspaceAccess = "member";
  if (auth.userId && auth.plane !== "app") {
    if (tenantId) {
      // One shared answer with the queue — see `resolveTenantAccess`. For
      // non-operator non-members it refuses, and the tenant is nulled so the
      // fallback below picks their own workspace instead.
      const access = await resolveTenantAccess(db, dialect, tenantId, auth.userId, {
        apiKeyRoleId: auth.apiKeyRoleId ?? null,
        apiKeyId: auth.apiKeyId ?? null,
        env: ctx.env,
        email: auth.email,
        plane: auth.plane,
      });
      if (access.roles) {
        tenantRoles = access.roles;
        workspaceAccess = access.access;
        // Instance-operator shortcut: viewing only. Don't persist the visit so
        // the next request without a header drops back to the operator's own
        // workspace (and clear any leaked cookie below).
        if (access.viaAdminShortcut) pinTenantCookie = false;
      } else {
        // Not a member, and not an admin taking the cross-tenant shortcut.
        // If the workspace was the caller's own explicit choice, say so rather
        // than quietly running the request somewhere else.
        if (tenantFromHeader && headerWanted) refuseHeaderWorkspace();
        tenantId = null;
      }
    }
    if (!tenantId) {
      tenantId = await firstUserTenant(db, dialect, auth.userId);
      if (tenantId) {
        tenantRoles = await loadTenantRoleNames(
          db,
          dialect,
          tenantId,
          auth.userId,
          auth.apiKeyRoleId ?? null,
        );
      }
    }
  }
  // For app-plane there's no fallback workspace — if the session's tenant
  // didn't resolve, leave it null and let permission resolution deny.
  if (!tenantId && auth.plane !== "app") {
    tenantId = await ensureDefaultTenant({ db, dialect });
  }

  // App-plane identities don't participate in control-plane RBAC, so
  // `auth.roles` stays empty for them — the data-plane permission resolver
  // loads their workspace roles separately.
  if (auth.userId && auth.plane !== "app" && tenantId) {
    const uid = auth.userId;
    // Persist the active tenant only when it changed for this user (this
    // isolate) — skips a primary-DB write on virtually every steady request.
    if (lastActiveTenant.get(uid) !== tenantId) {
      lastActiveTenant.set(uid, tenantId);
      deferWrite(c, () => persistActive(db, dialect, uid, tenantId));
    }
    // Debounce the presence touch to once per minute per (tenant, user); the
    // Members panel's "active Nm ago" tolerates ~minute granularity.
    const seenKey = `${tenantId}:${uid}`;
    const now = Date.now();
    if (now - (lastSeenWrite.get(seenKey) ?? 0) >= LAST_SEEN_DEBOUNCE_MS) {
      lastSeenWrite.set(seenKey, now);
      deferWrite(c, () => touchMember(db, dialect, tenantId, uid));
    }
  }

  // App-plane organization context. Resolved here (not in sessionMiddleware)
  // because it needs the active tenant, and only for the app plane —
  // control-plane identities have no `app_org_members` rows, so a platform
  // request never pays for this. The membership list rides a per-isolate cache
  // (see permissions-cache `orgMembershipsCache`), so a workspace that has no
  // orgs costs one cached empty lookup per TTL window.
  let orgCtx: OrgContext = { orgId: null, orgRole: null, orgIds: [] };
  if (auth.plane === "app" && auth.userId && tenantId) {
    orgCtx = await resolveOrgContext(
      { db, dialect },
      tenantId,
      auth.userId,
      {
        requestedOrg: c.req.header(ORG_HEADER) ?? null,
        appSessionId: auth.appSessionId ?? null,
      },
    );
  }

  c.set("auth", {
    ...auth,
    roles: tenantRoles,
    tenantId,
    // How the caller got here, for the role resolver. Only the instance-operator
    // branch above can make this anything other than `"member"`, and the
    // resolver refuses to hand a non-member the workspace's `authenticated`
    // bundle without it.
    access: workspaceAccess,
    orgId: orgCtx.orgId,
    orgRole: orgCtx.orgRole,
    orgIds: orgCtx.orgIds,
  });
  // Stamp the request start so route handlers can pass duration_ms to
  // recordActivity without each one having to remember to capture Date.now().
  // Use Hono's typed `set` — assigning to `c.var` directly hits a Proxy that
  // doesn't persist arbitrary keys.
  (c as unknown as { set: (k: string, v: unknown) => void }).set("__startedAt", Date.now());
  await next();

  // Cookie has to be appended *after* next() — better-auth (and any other
  // downstream handler that returns a fresh Response) replaces the staged
  // headers, so a setCookie call before next() gets dropped along with the
  // session cookie. Setting it here merges into the final response.
  //
  // Re-read auth.tenantId after next() so handlers like /api/tenants/switch
  // (which mutate auth to point at the new workspace) win — otherwise the
  // closed-over `tenantId` from the pre-next phase clobbers their cookie.
  const finalTenantId =
    (c.get("auth")?.tenantId as string | null | undefined) ?? tenantId;

  // Not on the documents customers embed on their own sites. An anonymous
  // visitor loading the analytics tag, the tag container or the consent banner
  // was being pinned to a default workspace for 30 days by a cookie that
  // `SameSite=Lax` guarantees is never sent back on a cross-site subresource
  // request — dead storage that also suppresses shared caching, and that the
  // consent banner's own delivery cannot be writing before the visitor has
  // answered it. Neither set NOR deleted here: the delete branch exists for the
  // cross-tenant admin shortcut, which needs a header these paths never carry.
  // See `lib/public-paths.ts`.
  if (isPublicSubresource(new URL(c.req.url).pathname)) return;

  if (finalTenantId && pinTenantCookie) {
    setCookie(c, TENANT_COOKIE, finalTenantId, {
      httpOnly: false,
      sameSite: "Lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
      // No credentials in here, but on HTTPS deploys keep it off plaintext
      // channels anyway — a tampered value silently reroutes workspace
      // requests. Conditional so local http dev keeps working.
      secure: c.req.url.startsWith("https:"),
    });
  } else if (!pinTenantCookie) {
    // Cross-tenant admin pass-through: actively clear any leaked cookie so
    // a previous header-driven visit doesn't keep silently routing every
    // subsequent request through the foreign workspace.
    deleteCookie(c, TENANT_COOKIE, { path: "/" });
  }
};
