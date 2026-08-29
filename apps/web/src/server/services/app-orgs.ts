import { and, asc, count, desc, eq, inArray, ne, sql } from "drizzle-orm";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import { slugify } from "@backlex/db/slug";
import {
  AppError,
  isOrgRole,
  ORG_ROLE_RANK,
  type OrgRole,
} from "@backlex/core";
import type { Ctx } from "../context";
import type { DbCtx } from "./seed";
import { resolveAssignableRoles } from "./app-user-invites";
import {
  getCachedOrgMemberships,
  invalidateOrgMemberships,
  invalidateTenantOrgs,
  invalidateUserRoles,
  setCachedOrgMemberships,
} from "./permissions-cache";

/**
 * App-plane organizations ("teams") — the B2B grouping level *inside* one
 * workspace. A tenant is the backlex customer; an `app_orgs` row is one of
 * THEIR customers, and `app_users` join it as owners/admins/members.
 *
 * Two role layers live here and must not be conflated:
 *
 *   - the **membership role** (`app_org_members.role`: owner | admin | member)
 *     decides who may rename the org, invite, promote or remove people. It is
 *     enforced by {@link requireOrgRole} and never touches the permission DSL;
 *   - **org-scoped workspace roles** (`app_org_member_roles` → `roles`) are
 *     ordinary backlex roles bound to a member *within one org*, so the same
 *     person can be an Editor in org A and read-only in org B. They are folded
 *     into the effective role set by `loadRolesForUser` once an org is active.
 *
 * Every mutation funnels through this module — REST (admin + app plane),
 * GraphQL, MCP and the CLI are thin wrappers, so the guards below can't be
 * bypassed by picking a different surface.
 */

export const ORG_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const tablesFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg"
    ? {
        orgs: pg.schema.appOrgs,
        members: pg.schema.appOrgMembers,
        memberRoles: pg.schema.appOrgMemberRoles,
        invites: pg.schema.appOrgInvites,
        appUsers: pg.schema.appUsers,
        appSessions: pg.schema.appSessions,
        roles: pg.schema.roles,
        tenants: pg.schema.tenants,
      }
    : {
        orgs: sqlite.schema.appOrgs,
        members: sqlite.schema.appOrgMembers,
        memberRoles: sqlite.schema.appOrgMemberRoles,
        invites: sqlite.schema.appOrgInvites,
        appUsers: sqlite.schema.appUsers,
        appSessions: sqlite.schema.appSessions,
        roles: sqlite.schema.roles,
        tenants: sqlite.schema.tenants,
      };

/** `now` in the dialect's physical representation (PG Date / SQLite epoch-ms).
 *  Every write in this file goes through it so the two dialects can't drift. */
const nowFor = (dialect: "pg" | "sqlite"): Date | number =>
  dialect === "pg" ? new Date() : Date.now();

const dateFor = (dialect: "pg" | "sqlite", d: Date): Date | number =>
  dialect === "pg" ? d : d.getTime();

/** Read a timestamp column back as epoch-ms regardless of dialect. */
const ms = (v: unknown): number | null =>
  v == null ? null : v instanceof Date ? v.getTime() : Number(v);

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface OrgRow {
  id: string;
  slug: string;
  name: string;
  image: string | null;
  metadata: Record<string, unknown> | null;
  createdBy: string | null;
  createdAt: number | null;
  updatedAt: number | null;
}

export interface OrgSummary extends OrgRow {
  memberCount: number;
  /** Only present when the listing was scoped to one end-user — their
   *  membership role in this org. */
  role?: OrgRole;
}

export interface OrgMemberRow {
  appUserId: string;
  email: string;
  name: string | null;
  status: string;
  role: OrgRole;
  /** Org-scoped workspace roles bound to this member. */
  roles: Array<{ id: string; name: string }>;
  createdAt: number | null;
}

export interface OrgInviteRow {
  id: string;
  orgId: string;
  email: string;
  role: OrgRole;
  roleIds: string[];
  invitedBy: string | null;
  expiresAt: number;
  acceptedAt: number | null;
  createdAt: number | null;
  /** Derived: still actionable (not accepted, not past expiry). */
  pending: boolean;
}

// ---------------------------------------------------------------------------
// Slugs
// ---------------------------------------------------------------------------

/** Lowercase, dash-separated URL handle, capped at 48 characters.
 *
 *  The fold is `@backlex/db/slug` — the same one user-collection slug fields
 *  use, so an organization and a post named the same thing get the same handle.
 *  Latin letters fold to ASCII (`Ürün`→`urun`); scripts with no single
 *  romanization are refused rather than guessed, and the display `name` keeps
 *  the original text either way. An unfoldable name falls back to "org", which
 *  `uniqueOrgSlug` then suffixes. */
export const slugifyOrgName = (name: string): string => slugify(name, 48) || "org";

/** First free slug in this workspace: `base`, then `base-2`, `base-3`, …
 *  Bounded so a pathological collision run can't spin. */
const uniqueOrgSlug = async (
  ctx: DbCtx,
  tenantId: string,
  base: string,
  excludeOrgId?: string,
): Promise<string> => {
  const t = tablesFor(ctx.dialect);
  for (let i = 1; i <= 50; i++) {
    const candidate = i === 1 ? base : `${base}-${i}`;
    const rows = (await (ctx.db as any)
      .select({ id: t.orgs.id })
      .from(t.orgs)
      .where(and(eq(t.orgs.tenantId, tenantId), eq(t.orgs.slug, candidate)))
      .limit(1)) as Array<{ id: string }>;
    const hit = rows[0];
    if (!hit || hit.id === excludeOrgId) return candidate;
  }
  // Deterministic escape hatch — the unique index still guards correctness.
  return `${base}-${crypto.randomUUID().slice(0, 8)}`;
};

// ---------------------------------------------------------------------------
// Lookups + guards
// ---------------------------------------------------------------------------

const mapOrg = (r: Record<string, unknown>): OrgRow => ({
  id: String(r.id),
  slug: String(r.slug),
  name: String(r.name),
  image: (r.image as string | null) ?? null,
  // SQLite hands back the parsed JSON via drizzle's `mode: "json"`; PG via
  // jsonb. Both can be null.
  metadata: (r.metadata as Record<string, unknown> | null) ?? null,
  createdBy: (r.createdBy as string | null) ?? null,
  createdAt: ms(r.createdAt),
  updatedAt: ms(r.updatedAt),
});

/** Resolve an org by id *or* slug within a workspace. Returns null when it
 *  doesn't exist — callers that need it decide between 404 and 403. */
export const findOrg = async (
  ctx: DbCtx,
  tenantId: string,
  idOrSlug: string,
): Promise<OrgRow | null> => {
  const t = tablesFor(ctx.dialect);
  const rows = (await (ctx.db as any)
    .select()
    .from(t.orgs)
    .where(
      and(
        eq(t.orgs.tenantId, tenantId),
        sql`(${t.orgs.id} = ${idOrSlug} OR ${t.orgs.slug} = ${idOrSlug})`,
      ),
    )
    .limit(1)) as Array<Record<string, unknown>>;
  return rows[0] ? mapOrg(rows[0]) : null;
};

export const requireOrg = async (
  ctx: DbCtx,
  tenantId: string,
  idOrSlug: string,
): Promise<OrgRow> => {
  const org = await findOrg(ctx, tenantId, idOrSlug);
  if (!org) throw new AppError("NOT_FOUND", "Organization not found in this workspace");
  return org;
};

/** The subject's membership role in an org, or null when they aren't a member. */
export const memberRole = async (
  ctx: DbCtx,
  orgId: string,
  appUserId: string,
): Promise<OrgRole | null> => {
  const t = tablesFor(ctx.dialect);
  const rows = (await (ctx.db as any)
    .select({ role: t.members.role })
    .from(t.members)
    .where(and(eq(t.members.orgId, orgId), eq(t.members.appUserId, appUserId)))
    .limit(1)) as Array<{ role: string }>;
  const raw = rows[0]?.role;
  return isOrgRole(raw) ? raw : null;
};

/**
 * Assert the caller holds at least `min` in this org. Used by every app-plane
 * mutation; control-plane admins skip it entirely (they administer the whole
 * workspace and never have an `app_org_members` row).
 */
export const requireOrgRole = async (
  ctx: DbCtx,
  orgId: string,
  appUserId: string,
  min: OrgRole,
): Promise<OrgRole> => {
  const role = await memberRole(ctx, orgId, appUserId);
  if (!role) throw new AppError("FORBIDDEN", "Not a member of this organization");
  if (ORG_ROLE_RANK[role] < ORG_ROLE_RANK[min]) {
    throw new AppError(
      "FORBIDDEN",
      `This action needs the "${min}" role in the organization`,
    );
  }
  return role;
};

/**
 * Who is performing a membership change, when the change comes from inside the
 * org. `null` means the **control plane** — a workspace admin administering one
 * of their customers' orgs, who sits outside the rank order entirely and is
 * already gated by `requireAdmin`.
 *
 * Spelled as a required parameter rather than an optional one on purpose: the
 * guards below are skipped for `null`, so a new surface must say which plane it
 * speaks for instead of inheriting control-plane authority by omission.
 */
export type OrgActor = { appUserId: string; role: OrgRole } | null;

/**
 * Hold an app-plane actor to the org's rank order: you may act on your peers
 * and on anyone below you, never on someone above you.
 *
 * Without this an org `admin` could demote or remove an `owner` outright — the
 * last-owner guard only kept the *final* owner, so with two owners an admin
 * could depose the founder. "Only an owner can grant ownership" bounded what an
 * admin could hand out; it said nothing about what they could take away.
 *
 * Acting on yourself is always allowed — that's how demoting yourself and
 * `leaveOrg` work, and the last-owner guard is what stops the org being
 * stranded.
 */
const assertMayActOn = (
  actor: OrgActor,
  targetAppUserId: string,
  targetRole: OrgRole,
): void => {
  if (!actor) return;
  if (actor.appUserId === targetAppUserId) return;
  if (ORG_ROLE_RANK[targetRole] > ORG_ROLE_RANK[actor.role])
    throw new AppError(
      "FORBIDDEN",
      `An organization "${actor.role}" can't act on an "${targetRole}"`,
    );
};

/** How many owners the org has. Guards the "an org can never be ownerless"
 *  invariant on demote / remove / leave. */
const ownerCount = async (ctx: DbCtx, orgId: string): Promise<number> => {
  const t = tablesFor(ctx.dialect);
  const rows = (await (ctx.db as any)
    .select({ n: count() })
    .from(t.members)
    .where(and(eq(t.members.orgId, orgId), eq(t.members.role, "owner")))) as Array<{
      n: number | string;
    }>;
  return Number(rows[0]?.n ?? 0);
};

/** Reject a change that would leave `orgId` without an owner. */
const assertNotLastOwner = async (
  ctx: DbCtx,
  orgId: string,
  appUserId: string,
): Promise<void> => {
  const role = await memberRole(ctx, orgId, appUserId);
  if (role !== "owner") return;
  if ((await ownerCount(ctx, orgId)) <= 1) {
    throw new AppError(
      "VALIDATION",
      "This is the organization's last owner — promote someone else first",
    );
  }
};

/** Confirm an `app_users` row exists in this workspace and hand back its email. */
const requireAppUser = async (
  ctx: DbCtx,
  tenantId: string,
  appUserId: string,
): Promise<{ id: string; email: string; name: string | null }> => {
  const t = tablesFor(ctx.dialect);
  const rows = (await (ctx.db as any)
    .select({ id: t.appUsers.id, email: t.appUsers.email, name: t.appUsers.name })
    .from(t.appUsers)
    .where(and(eq(t.appUsers.id, appUserId), eq(t.appUsers.tenantId, tenantId)))
    .limit(1)) as Array<{ id: string; email: string; name: string | null }>;
  const row = rows[0];
  if (!row) throw new AppError("NOT_FOUND", "End-user not found in this workspace");
  return row;
};

// ---------------------------------------------------------------------------
// Org-scoped workspace roles
// ---------------------------------------------------------------------------

/** Replace a member's org-scoped workspace roles. Validation is shared with the
 *  workspace-wide path (`resolveAssignableRoles`), so the admin role stays
 *  unassignable here too — an org owner must never be able to mint themselves a
 *  workspace admin bypass.
 *
 *  An app-plane `actor` narrows it further: they may only bind roles their
 *  operator marked `org_assignable`. The control plane (`null`) is not held to
 *  that — it IS the operator. */
const replaceMemberRoles = async (
  ctx: DbCtx,
  tenantId: string,
  orgId: string,
  appUserId: string,
  roleIds: string[],
  actor: OrgActor,
): Promise<Array<{ id: string; name: string }>> => {
  const valid = await resolveAssignableRoles(ctx, tenantId, roleIds, {
    orgScoped: actor !== null,
  });
  const t = tablesFor(ctx.dialect);
  await (ctx.db as any)
    .delete(t.memberRoles)
    .where(
      and(eq(t.memberRoles.orgId, orgId), eq(t.memberRoles.appUserId, appUserId)),
    );
  for (const r of valid) {
    await (ctx.db as any).insert(t.memberRoles).values({
      orgId,
      appUserId,
      roleId: r.id,
      createdAt: nowFor(ctx.dialect),
    });
  }
  // The member's effective role set just changed for this org.
  invalidateUserRoles(tenantId, appUserId);
  return valid;
};

/** Org-scoped roles for a set of members, grouped by app_user_id. */
const memberRolesByUser = async (
  ctx: DbCtx,
  tenantId: string,
  orgId: string,
  appUserIds: string[],
): Promise<Map<string, Array<{ id: string; name: string }>>> => {
  const out = new Map<string, Array<{ id: string; name: string }>>();
  if (appUserIds.length === 0) return out;
  const t = tablesFor(ctx.dialect);
  const rows = (await (ctx.db as any)
    .select({
      appUserId: t.memberRoles.appUserId,
      roleId: t.roles.id,
      roleName: t.roles.name,
    })
    .from(t.memberRoles)
    .innerJoin(t.roles, eq(t.memberRoles.roleId, t.roles.id))
    .where(
      and(
        eq(t.memberRoles.orgId, orgId),
        inArray(t.memberRoles.appUserId, appUserIds),
        eq(t.roles.tenantId, tenantId),
      ),
    )) as Array<{ appUserId: string; roleId: string; roleName: string }>;
  for (const r of rows) {
    const list = out.get(r.appUserId) ?? [];
    list.push({ id: r.roleId, name: r.roleName });
    out.set(r.appUserId, list);
  }
  return out;
};

// ---------------------------------------------------------------------------
// Orgs — CRUD
// ---------------------------------------------------------------------------

export interface ListOrgsOptions {
  /** Substring match on name/slug (case-insensitive). */
  q?: string;
  /** Scope to the orgs one end-user belongs to, and stamp their role on each
   *  row. Omit for the admin listing (every org in the workspace). */
  appUserId?: string;
}

export const listOrgs = async (
  ctx: DbCtx,
  tenantId: string,
  opts: ListOrgsOptions = {},
): Promise<OrgSummary[]> => {
  const t = tablesFor(ctx.dialect);
  const conds = [eq(t.orgs.tenantId, tenantId)];
  if (opts.q) {
    // D1 rejects a BOUND parameter as a LIKE pattern, so the previous
    // `LIKE ${pat}` 500s on the primary production target while passing on
    // bun:sqlite — which is what the two tests covering this run on. The
    // established shape for the same job is a dialect-branched position
    // function with a plain bound value; see
    // `services/analytics-segments.ts::containsExpr`, three files over.
    const needle = opts.q.toLowerCase();
    const contains = (col: typeof t.orgs.name) =>
      ctx.dialect === "pg"
        ? sql`strpos(lower(coalesce(${col}, '')), ${needle}) > 0`
        : sql`instr(lower(coalesce(${col}, '')), ${needle}) > 0`;
    conds.push(sql`(${contains(t.orgs.name)} OR ${contains(t.orgs.slug)})`);
  }

  let rows: Array<Record<string, unknown>>;
  const roleByOrg = new Map<string, OrgRole>();
  if (opts.appUserId) {
    rows = (await (ctx.db as any)
      .select({
        id: t.orgs.id,
        slug: t.orgs.slug,
        name: t.orgs.name,
        image: t.orgs.image,
        metadata: t.orgs.metadata,
        createdBy: t.orgs.createdBy,
        createdAt: t.orgs.createdAt,
        updatedAt: t.orgs.updatedAt,
        memberRole: t.members.role,
      })
      .from(t.orgs)
      .innerJoin(
        t.members,
        and(
          eq(t.members.orgId, t.orgs.id),
          eq(t.members.appUserId, opts.appUserId),
        ),
      )
      .where(and(...conds))
      .orderBy(asc(t.orgs.name))) as Array<Record<string, unknown>>;
    for (const r of rows) {
      if (isOrgRole(r.memberRole)) roleByOrg.set(String(r.id), r.memberRole);
    }
  } else {
    rows = (await (ctx.db as any)
      .select()
      .from(t.orgs)
      .where(and(...conds))
      .orderBy(asc(t.orgs.name))) as Array<Record<string, unknown>>;
  }

  const ids = rows.map((r) => String(r.id));
  const counts = new Map<string, number>();
  if (ids.length) {
    const countRows = (await (ctx.db as any)
      .select({ orgId: t.members.orgId, n: count() })
      .from(t.members)
      .where(inArray(t.members.orgId, ids))
      .groupBy(t.members.orgId)) as Array<{ orgId: string; n: number | string }>;
    for (const r of countRows) counts.set(r.orgId, Number(r.n));
  }

  return rows.map((r) => {
    const org = mapOrg(r);
    const role = roleByOrg.get(org.id);
    return {
      ...org,
      memberCount: counts.get(org.id) ?? 0,
      ...(role ? { role } : {}),
    };
  });
};

export interface CreateOrgInput {
  name: string;
  slug?: string;
  image?: string | null;
  metadata?: Record<string, unknown> | null;
  /** End-user who becomes the first `owner`. Omitted for admin-created orgs,
   *  which start empty and get members added explicitly. */
  ownerAppUserId?: string | null;
}

export const createOrg = async (
  ctx: DbCtx,
  tenantId: string,
  input: CreateOrgInput,
): Promise<OrgRow> => {
  const name = input.name.trim();
  if (!name) throw new AppError("VALIDATION", "Organization name is required");

  // An explicit slug is honoured but must be free; a derived one is
  // auto-suffixed instead of failing, because the caller didn't choose it.
  const t = tablesFor(ctx.dialect);
  let slug: string;
  if (input.slug) {
    slug = slugifyOrgName(input.slug);
    const clash = (await (ctx.db as any)
      .select({ id: t.orgs.id })
      .from(t.orgs)
      .where(and(eq(t.orgs.tenantId, tenantId), eq(t.orgs.slug, slug)))
      .limit(1)) as Array<{ id: string }>;
    if (clash[0])
      throw new AppError("CONFLICT", `An organization with the slug "${slug}" already exists`);
  } else {
    slug = await uniqueOrgSlug(ctx, tenantId, slugifyOrgName(name));
  }

  if (input.ownerAppUserId) await requireAppUser(ctx, tenantId, input.ownerAppUserId);

  const id = crypto.randomUUID();
  const now = nowFor(ctx.dialect);
  await (ctx.db as any).insert(t.orgs).values({
    id,
    tenantId,
    slug,
    name,
    image: input.image ?? null,
    metadata: input.metadata ?? null,
    createdBy: input.ownerAppUserId ?? null,
    createdAt: now,
    updatedAt: now,
  });

  if (input.ownerAppUserId) {
    await (ctx.db as any).insert(t.members).values({
      id: crypto.randomUUID(),
      tenantId,
      orgId: id,
      appUserId: input.ownerAppUserId,
      role: "owner",
      createdAt: now,
      updatedAt: now,
    });
    invalidateOrgMemberships(tenantId, input.ownerAppUserId);
  }

  return {
    id,
    slug,
    name,
    image: input.image ?? null,
    metadata: input.metadata ?? null,
    createdBy: input.ownerAppUserId ?? null,
    createdAt: ms(now),
    updatedAt: ms(now),
  };
};

export interface UpdateOrgInput {
  name?: string;
  slug?: string;
  image?: string | null;
  metadata?: Record<string, unknown> | null;
}

export const updateOrg = async (
  ctx: DbCtx,
  tenantId: string,
  orgId: string,
  patch: UpdateOrgInput,
): Promise<OrgRow> => {
  const org = await requireOrg(ctx, tenantId, orgId);
  const t = tablesFor(ctx.dialect);
  const set: Record<string, unknown> = { updatedAt: nowFor(ctx.dialect) };
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw new AppError("VALIDATION", "Organization name cannot be empty");
    set.name = name;
  }
  if (patch.slug !== undefined) {
    const slug = slugifyOrgName(patch.slug);
    const free = await uniqueOrgSlug(ctx, tenantId, slug, org.id);
    if (free !== slug)
      throw new AppError("CONFLICT", `An organization with the slug "${slug}" already exists`);
    set.slug = slug;
  }
  if (patch.image !== undefined) set.image = patch.image;
  if (patch.metadata !== undefined) set.metadata = patch.metadata;

  await (ctx.db as any)
    .update(t.orgs)
    .set(set)
    .where(and(eq(t.orgs.id, org.id), eq(t.orgs.tenantId, tenantId)));
  return (await findOrg(ctx, tenantId, org.id))!;
};

/** Delete an org and everything hanging off it. Done explicitly rather than
 *  via FK cascade so it behaves identically on SQLite/D1, which don't enforce
 *  foreign keys by default. */
export const deleteOrg = async (
  ctx: DbCtx,
  tenantId: string,
  orgId: string,
): Promise<void> => {
  const org = await requireOrg(ctx, tenantId, orgId);
  const t = tablesFor(ctx.dialect);
  await (ctx.db as any).delete(t.memberRoles).where(eq(t.memberRoles.orgId, org.id));
  await (ctx.db as any).delete(t.invites).where(eq(t.invites.orgId, org.id));
  await (ctx.db as any).delete(t.members).where(eq(t.members.orgId, org.id));
  // Sessions pinned to this org fall back to "no active org" rather than
  // pointing at a row that no longer exists.
  await (ctx.db as any)
    .update(t.appSessions)
    .set({ activeOrgId: null })
    .where(eq(t.appSessions.activeOrgId, org.id));
  await (ctx.db as any)
    .delete(t.orgs)
    .where(and(eq(t.orgs.id, org.id), eq(t.orgs.tenantId, tenantId)));
  invalidateTenantOrgs(tenantId);
};

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

export const listMembers = async (
  ctx: DbCtx,
  tenantId: string,
  orgId: string,
): Promise<OrgMemberRow[]> => {
  const t = tablesFor(ctx.dialect);
  const rows = (await (ctx.db as any)
    .select({
      appUserId: t.members.appUserId,
      role: t.members.role,
      createdAt: t.members.createdAt,
      email: t.appUsers.email,
      name: t.appUsers.name,
      status: t.appUsers.status,
    })
    .from(t.members)
    .innerJoin(t.appUsers, eq(t.members.appUserId, t.appUsers.id))
    .where(and(eq(t.members.orgId, orgId), eq(t.members.tenantId, tenantId)))
    .orderBy(asc(t.members.createdAt))) as Array<Record<string, unknown>>;

  const byUser = await memberRolesByUser(
    ctx,
    tenantId,
    orgId,
    rows.map((r) => String(r.appUserId)),
  );
  return rows.map((r) => ({
    appUserId: String(r.appUserId),
    email: String(r.email),
    name: (r.name as string | null) ?? null,
    status: String(r.status),
    role: isOrgRole(r.role) ? r.role : "member",
    roles: byUser.get(String(r.appUserId)) ?? [],
    createdAt: ms(r.createdAt),
  }));
};

export interface AddMemberInput {
  appUserId: string;
  role?: OrgRole;
  /** Org-scoped workspace roles to bind at the same time. */
  roleIds?: string[];
}

export const addMember = async (
  ctx: DbCtx,
  tenantId: string,
  orgId: string,
  input: AddMemberInput,
  actor: OrgActor,
): Promise<OrgMemberRow> => {
  const org = await requireOrg(ctx, tenantId, orgId);
  const user = await requireAppUser(ctx, tenantId, input.appUserId);
  const role: OrgRole = input.role ?? "member";
  const t = tablesFor(ctx.dialect);

  const existing = await memberRole(ctx, org.id, user.id);
  if (existing)
    throw new AppError("CONFLICT", `${user.email} is already a member of this organization`);

  const now = nowFor(ctx.dialect);
  await (ctx.db as any).insert(t.members).values({
    id: crypto.randomUUID(),
    tenantId,
    orgId: org.id,
    appUserId: user.id,
    role,
    createdAt: now,
    updatedAt: now,
  });
  const roles = input.roleIds?.length
    ? await replaceMemberRoles(ctx, tenantId, org.id, user.id, input.roleIds, actor)
    : [];
  invalidateOrgMemberships(tenantId, user.id);
  invalidateUserRoles(tenantId, user.id);

  return {
    appUserId: user.id,
    email: user.email,
    name: user.name,
    status: "active",
    role,
    roles,
    createdAt: ms(now),
  };
};

export interface UpdateMemberInput {
  role?: OrgRole;
  /** Replaces the member's org-scoped workspace roles wholesale. */
  roleIds?: string[];
}

export const updateMember = async (
  ctx: DbCtx,
  tenantId: string,
  orgId: string,
  appUserId: string,
  patch: UpdateMemberInput,
  actor: OrgActor,
): Promise<OrgMemberRow> => {
  const org = await requireOrg(ctx, tenantId, orgId);
  const current = await memberRole(ctx, org.id, appUserId);
  if (!current) throw new AppError("NOT_FOUND", "Not a member of this organization");
  assertMayActOn(actor, appUserId, current);
  // An admin must not be able to mint an owner — not even themselves. Enforced
  // here rather than per-surface so GraphQL/MCP/CLI can't route around it.
  if (actor && patch.role === "owner" && actor.role !== "owner")
    throw new AppError("FORBIDDEN", "Only an owner can grant ownership");
  const t = tablesFor(ctx.dialect);

  if (patch.role !== undefined && patch.role !== current) {
    // Demoting the last owner would strand the org with nobody able to
    // administer it.
    if (current === "owner") await assertNotLastOwner(ctx, org.id, appUserId);
    await (ctx.db as any)
      .update(t.members)
      .set({ role: patch.role, updatedAt: nowFor(ctx.dialect) })
      .where(and(eq(t.members.orgId, org.id), eq(t.members.appUserId, appUserId)));
    invalidateOrgMemberships(tenantId, appUserId);
  }
  if (patch.roleIds !== undefined) {
    await replaceMemberRoles(ctx, tenantId, org.id, appUserId, patch.roleIds, actor);
  }

  const members = await listMembers(ctx, tenantId, org.id);
  const row = members.find((m) => m.appUserId === appUserId);
  if (!row) throw new AppError("NOT_FOUND", "Not a member of this organization");
  return row;
};

export const removeMember = async (
  ctx: DbCtx,
  tenantId: string,
  orgId: string,
  appUserId: string,
  actor: OrgActor,
): Promise<void> => {
  const org = await requireOrg(ctx, tenantId, orgId);
  const current = await memberRole(ctx, org.id, appUserId);
  if (!current) throw new AppError("NOT_FOUND", "Not a member of this organization");
  assertMayActOn(actor, appUserId, current);
  await assertNotLastOwner(ctx, org.id, appUserId);
  const t = tablesFor(ctx.dialect);
  await (ctx.db as any)
    .delete(t.memberRoles)
    .where(
      and(eq(t.memberRoles.orgId, org.id), eq(t.memberRoles.appUserId, appUserId)),
    );
  await (ctx.db as any)
    .delete(t.members)
    .where(and(eq(t.members.orgId, org.id), eq(t.members.appUserId, appUserId)));
  // Any session still pointing at this org loses its active selection.
  await (ctx.db as any)
    .update(t.appSessions)
    .set({ activeOrgId: null })
    .where(
      and(
        eq(t.appSessions.userId, appUserId),
        eq(t.appSessions.activeOrgId, org.id),
      ),
    );
  invalidateOrgMemberships(tenantId, appUserId);
  invalidateUserRoles(tenantId, appUserId);
};

// ---------------------------------------------------------------------------
// Invites
// ---------------------------------------------------------------------------

const mapInvite = (r: Record<string, unknown>): OrgInviteRow => {
  const expiresAt = ms(r.expiresAt) ?? 0;
  const acceptedAt = ms(r.acceptedAt);
  return {
    id: String(r.id),
    orgId: String(r.orgId),
    email: String(r.email),
    role: isOrgRole(r.role) ? r.role : "member",
    roleIds: Array.isArray(r.roleIds) ? (r.roleIds as string[]) : [],
    invitedBy: (r.invitedBy as string | null) ?? null,
    expiresAt,
    acceptedAt,
    createdAt: ms(r.createdAt),
    pending: acceptedAt == null && expiresAt > Date.now(),
  };
};

export const listInvites = async (
  ctx: DbCtx,
  tenantId: string,
  orgId: string,
  opts: { pendingOnly?: boolean } = {},
): Promise<OrgInviteRow[]> => {
  const t = tablesFor(ctx.dialect);
  const rows = (await (ctx.db as any)
    .select()
    .from(t.invites)
    .where(and(eq(t.invites.orgId, orgId), eq(t.invites.tenantId, tenantId)))
    .orderBy(desc(t.invites.createdAt))) as Array<Record<string, unknown>>;
  const all = rows.map(mapInvite);
  return opts.pendingOnly ? all.filter((i) => i.pending) : all;
};

export interface CreateOrgInviteInput {
  email: string;
  role?: OrgRole;
  /** Org-scoped workspace roles bound when the invite is accepted. */
  roleIds?: string[];
  /** `app_users.id` of the inviter; null for control-plane admin invites. */
  invitedBy?: string | null;
}

export interface CreateOrgInviteResult {
  id: string;
  email: string;
  role: OrgRole;
  token: string;
  expiresAt: Date;
}

/**
 * Mint a 7-day org invitation. The invitee must already have (or later create)
 * an `app_users` account with the same email — accepting is a separate,
 * authenticated call, so this never provisions an account on its own. That
 * keeps org invites orthogonal to the workspace-level end-user invite
 * (`services/app-user-invites.ts`), which is what creates the account.
 */
export const createOrgInvite = async (
  ctx: Ctx,
  tenantId: string,
  orgId: string,
  input: CreateOrgInviteInput,
  actor: OrgActor,
): Promise<CreateOrgInviteResult> => {
  const dbCtx: DbCtx = { db: ctx.db, dialect: ctx.dialect };
  const org = await requireOrg(dbCtx, tenantId, orgId);
  const email = input.email.trim().toLowerCase();
  if (!email) throw new AppError("VALIDATION", "Email is required");
  const role: OrgRole = input.role ?? "member";
  const t = tablesFor(ctx.dialect);

  // Validate the org-scoped roles up front so a bad request leaves no invite
  // behind that would fail at accept time. Checked against the INVITER's plane:
  // an operator may stage a role the org admin couldn't have picked themselves.
  if (input.roleIds?.length) {
    await resolveAssignableRoles(dbCtx, tenantId, input.roleIds, {
      orgScoped: actor !== null,
    });
  }

  // Already a member? Inviting them again is a no-op the caller should know
  // about rather than a second pending row.
  const memberRows = (await (ctx.db as any)
    .select({ id: t.members.id })
    .from(t.members)
    .innerJoin(t.appUsers, eq(t.members.appUserId, t.appUsers.id))
    .where(
      and(eq(t.members.orgId, org.id), sql`lower(${t.appUsers.email}) = ${email}`),
    )
    .limit(1)) as Array<{ id: string }>;
  if (memberRows[0])
    throw new AppError("CONFLICT", `${email} is already a member of this organization`);

  const existing = await listInvites(dbCtx, tenantId, org.id, { pendingOnly: true });
  if (existing.some((i) => i.email === email))
    throw new AppError("CONFLICT", `${email} already has a pending invitation`);

  const id = crypto.randomUUID();
  const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  const expiresAt = new Date(Date.now() + ORG_INVITE_TTL_MS);
  await (ctx.db as any).insert(t.invites).values({
    id,
    tenantId,
    orgId: org.id,
    email,
    role,
    roleIds: input.roleIds?.length ? input.roleIds : null,
    token,
    invitedBy: input.invitedBy ?? null,
    expiresAt: dateFor(ctx.dialect, expiresAt),
    acceptedAt: null,
    createdAt: nowFor(ctx.dialect),
  });

  // Best-effort mail through the workspace transport — a broken SMTP config
  // must never fail the invite; the caller still gets the token back. Same
  // contract as the workspace-level end-user invite.
  void (async () => {
    const slugRows = (await (ctx.db as any)
      .select({ slug: t.tenants.slug })
      .from(t.tenants)
      .where(eq(t.tenants.id, tenantId))
      .limit(1)) as Array<{ slug: string }>;
    const slug = slugRows[0]?.slug ?? tenantId;
    const transport = await ctx.emailFor(tenantId);
    await transport.send({
      to: email,
      subject: `You've been invited to ${org.name}`,
      text:
        `You've been invited to join ${org.name} as ${role}.\n\n` +
        `Sign in to your account, then POST ${ctx.env.APP_URL}/api/t/${slug}/orgs/invites/accept ` +
        `with { "token": "${token}" }.\n` +
        `The invitation expires ${expiresAt.toISOString()}.`,
    });
  })().catch(() => {});

  return { id, email, role, token, expiresAt };
};

export const revokeOrgInvite = async (
  ctx: DbCtx,
  tenantId: string,
  orgId: string,
  inviteId: string,
): Promise<void> => {
  const t = tablesFor(ctx.dialect);
  const rows = (await (ctx.db as any)
    .select({ id: t.invites.id })
    .from(t.invites)
    .where(
      and(
        eq(t.invites.id, inviteId),
        eq(t.invites.orgId, orgId),
        eq(t.invites.tenantId, tenantId),
      ),
    )
    .limit(1)) as Array<{ id: string }>;
  if (!rows[0]) throw new AppError("NOT_FOUND", "Invitation not found");
  await (ctx.db as any).delete(t.invites).where(eq(t.invites.id, inviteId));
};

export interface AcceptOrgInviteResult {
  org: OrgRow;
  role: OrgRole;
}

/**
 * Accept an org invitation as an already-authenticated end-user.
 *
 * The accepting account's email must match the invited one (case-insensitive):
 * an invitation is addressed to a person, not bearer-authority for whoever
 * happens to hold the link. A forwarded token is therefore useless.
 */
export const acceptOrgInvite = async (
  ctx: DbCtx,
  tenantId: string,
  token: string,
  appUserId: string,
): Promise<AcceptOrgInviteResult> => {
  const t = tablesFor(ctx.dialect);
  const rows = (await (ctx.db as any)
    .select()
    .from(t.invites)
    .where(and(eq(t.invites.token, token), eq(t.invites.tenantId, tenantId)))
    .limit(1)) as Array<Record<string, unknown>>;
  const raw = rows[0];
  if (!raw) throw new AppError("NOT_FOUND", "Invitation not found");
  const invite = mapInvite(raw);
  if (invite.acceptedAt != null)
    throw new AppError("VALIDATION", "This invitation has already been accepted");
  if (invite.expiresAt <= Date.now())
    throw new AppError("VALIDATION", "This invitation has expired");

  const user = await requireAppUser(ctx, tenantId, appUserId);
  if (user.email.toLowerCase() !== invite.email)
    throw new AppError(
      "FORBIDDEN",
      "This invitation was sent to a different email address",
    );

  const org = await requireOrg(ctx, tenantId, invite.orgId);
  const existing = await memberRole(ctx, org.id, appUserId);
  if (!existing) {
    const now = nowFor(ctx.dialect);
    await (ctx.db as any).insert(t.members).values({
      id: crypto.randomUUID(),
      tenantId,
      orgId: org.id,
      appUserId,
      role: invite.role,
      createdAt: now,
      updatedAt: now,
    });
  }
  if (invite.roleIds.length) {
    // `null` actor on purpose. The authority for these roles came from whoever
    // minted the invitation, and it was checked against THEIR plane then — so
    // an operator may stage a role an org admin could not have picked, and the
    // invitee redeeming it isn't the one being authorised. (An org admin still
    // can't stage a barred role: mint-time rejects it.) The residual window is
    // an invitation minted before the flag was turned off, which stays valid
    // for its 7 days; the binding is revocable either way.
    await replaceMemberRoles(ctx, tenantId, org.id, appUserId, invite.roleIds, null);
  }
  await (ctx.db as any)
    .update(t.invites)
    .set({ acceptedAt: nowFor(ctx.dialect) })
    .where(eq(t.invites.id, invite.id));

  invalidateOrgMemberships(tenantId, appUserId);
  invalidateUserRoles(tenantId, appUserId);
  return { org, role: existing ?? invite.role };
};

/** Leave an org under your own steam. Same last-owner guard as removal; the
 *  rank guard is a no-op because the actor and the target are the same person. */
export const leaveOrg = async (
  ctx: DbCtx,
  tenantId: string,
  orgId: string,
  appUserId: string,
  role: OrgRole,
): Promise<void> => {
  await removeMember(ctx, tenantId, orgId, appUserId, { appUserId, role });
};

/**
 * Detach an end-user from every organization in a workspace: memberships,
 * org-scoped role bindings, and any session pin naming one of those orgs.
 *
 * Deleting the `app_users` row on its own is not enough, and the failure is
 * silent in the worst way: `listMembers` inner-joins `app_users`, so an
 * orphaned `app_org_members` row DISAPPEARS from every listing while
 * {@link ownerCount} and the member count still see it. A ghost owner satisfies
 * the last-owner guard, so the org's only real owner can then be removed and
 * the org is left with no members at all — unadministerable from the app plane.
 *
 * Pending invitations are deliberately left alone: they are addressed to an
 * email, not to this row, so a person who signs up again can still accept.
 */
export const removeAppUserFromAllOrgs = async (
  ctx: DbCtx,
  tenantId: string,
  appUserId: string,
): Promise<void> => {
  const t = tablesFor(ctx.dialect);
  await (ctx.db as any)
    .delete(t.memberRoles)
    .where(eq(t.memberRoles.appUserId, appUserId));
  await (ctx.db as any)
    .delete(t.members)
    .where(
      and(eq(t.members.appUserId, appUserId), eq(t.members.tenantId, tenantId)),
    );
  await (ctx.db as any)
    .update(t.appSessions)
    .set({ activeOrgId: null })
    .where(eq(t.appSessions.userId, appUserId));
  invalidateOrgMemberships(tenantId, appUserId);
  invalidateUserRoles(tenantId, appUserId);
};

// ---------------------------------------------------------------------------
// Active-org resolution (request path)
// ---------------------------------------------------------------------------

export interface OrgContext {
  /** `$org.id` — null when the subject belongs to no org, or to several with
   *  none selected. */
  orgId: string | null;
  /** `$org.role` — their membership role in `orgId`. */
  orgRole: OrgRole | null;
  /** `$user.orgs` — every org they belong to. */
  orgIds: string[];
}

const EMPTY_ORG_CONTEXT: OrgContext = { orgId: null, orgRole: null, orgIds: [] };

/** Every org this end-user belongs to, with their role. Cached per isolate —
 *  this runs on every app-plane request. */
export const loadOrgMemberships = async (
  ctx: DbCtx,
  tenantId: string,
  appUserId: string,
): Promise<Array<{ orgId: string; role: OrgRole }>> => {
  const cacheKey = { tenantId, appUserId };
  const cached = getCachedOrgMemberships(cacheKey);
  if (cached) {
    return cached.map((m) => ({
      orgId: m.orgId,
      role: isOrgRole(m.role) ? m.role : "member",
    }));
  }
  const t = tablesFor(ctx.dialect);
  const rows = (await (ctx.db as any)
    .select({ orgId: t.members.orgId, role: t.members.role })
    .from(t.members)
    .where(
      and(eq(t.members.appUserId, appUserId), eq(t.members.tenantId, tenantId)),
    )) as Array<{ orgId: string; role: string }>;
  setCachedOrgMemberships(cacheKey, rows);
  return rows.map((r) => ({
    orgId: r.orgId,
    role: isOrgRole(r.role) ? r.role : "member",
  }));
};

/** The org id a session is currently pinned to, or null. */
const sessionActiveOrg = async (
  ctx: DbCtx,
  appSessionId: string,
): Promise<string | null> => {
  const t = tablesFor(ctx.dialect);
  const rows = (await (ctx.db as any)
    .select({ activeOrgId: t.appSessions.activeOrgId })
    .from(t.appSessions)
    .where(eq(t.appSessions.id, appSessionId))
    .limit(1)) as Array<{ activeOrgId: string | null }>;
  return rows[0]?.activeOrgId ?? null;
};

export interface ResolveOrgContextInput {
  /** Raw `X-Backlex-Org` value — an org id or slug. */
  requestedOrg?: string | null;
  /** `app_sessions.id` backing this request, when there is one. */
  appSessionId?: string | null;
}

/**
 * Pick the org this request acts in:
 *
 *   1. the `X-Backlex-Org` header (id or slug) — must be one of the caller's
 *      memberships, otherwise the request is rejected outright rather than
 *      silently downgraded to another org's data;
 *   2. the session's `active_org_id`, set by `POST …/orgs/{id}/set-active`;
 *   3. the sole membership, when there is exactly one — a single-org end-user
 *      should never have to select anything;
 *   4. nothing. `$org.id` resolves to null, and an org-scoped permission rule
 *      compiles to FALSE, so this fails closed.
 *
 * The membership list is cached per isolate; the session lookup only runs when
 * the caller sent no header and belongs to more than one org.
 */
export const resolveOrgContext = async (
  ctx: DbCtx,
  tenantId: string,
  appUserId: string,
  input: ResolveOrgContextInput = {},
): Promise<OrgContext> => {
  const memberships = await loadOrgMemberships(ctx, tenantId, appUserId);
  const orgIds = memberships.map((m) => m.orgId);
  const roleOf = (id: string): OrgRole | null =>
    memberships.find((m) => m.orgId === id)?.role ?? null;

  // An explicit header is validated FIRST — including for a subject with no
  // memberships at all. Returning "no org" early would silently ignore what the
  // caller asked for, which is precisely the quiet-downgrade this rejects.
  const requested = input.requestedOrg?.trim();
  if (requested) {
    // Accept an id directly; fall back to a slug lookup, which is scoped to
    // this workspace so a slug can never reach across tenants.
    let wanted = orgIds.includes(requested) ? requested : null;
    if (!wanted) {
      const org = await findOrg(ctx, tenantId, requested);
      if (org && orgIds.includes(org.id)) wanted = org.id;
    }
    if (!wanted)
      throw new AppError(
        "FORBIDDEN",
        "Not a member of the organization named by X-Backlex-Org",
      );
    return { orgId: wanted, orgRole: roleOf(wanted), orgIds };
  }

  if (memberships.length === 0) return EMPTY_ORG_CONTEXT;

  if (memberships.length === 1) {
    const only = memberships[0]!;
    return { orgId: only.orgId, orgRole: only.role, orgIds };
  }

  if (input.appSessionId) {
    const pinned = await sessionActiveOrg(ctx, input.appSessionId);
    if (pinned && orgIds.includes(pinned)) {
      return { orgId: pinned, orgRole: roleOf(pinned), orgIds };
    }
  }
  return { orgId: null, orgRole: null, orgIds };
};

/** Pin (or clear) the org a session acts in. Validated against membership so a
 *  session can't be pointed at an org the user doesn't belong to. */
export const setActiveOrg = async (
  ctx: DbCtx,
  tenantId: string,
  appSessionId: string,
  appUserId: string,
  orgIdOrSlug: string | null,
): Promise<OrgRow | null> => {
  const t = tablesFor(ctx.dialect);
  if (orgIdOrSlug === null) {
    await (ctx.db as any)
      .update(t.appSessions)
      .set({ activeOrgId: null, updatedAt: nowFor(ctx.dialect) })
      .where(eq(t.appSessions.id, appSessionId));
    return null;
  }
  const org = await requireOrg(ctx, tenantId, orgIdOrSlug);
  const role = await memberRole(ctx, org.id, appUserId);
  if (!role) throw new AppError("FORBIDDEN", "Not a member of this organization");
  await (ctx.db as any)
    .update(t.appSessions)
    .set({ activeOrgId: org.id, updatedAt: nowFor(ctx.dialect) })
    .where(eq(t.appSessions.id, appSessionId));
  return org;
};

/** Orgs an end-user does NOT belong to yet — used by the admin UI's
 *  "add member" picker to avoid offering duplicates. Exported because the
 *  same list backs the CLI's `--org` completion. */
export const orgsWithoutMember = async (
  ctx: DbCtx,
  tenantId: string,
  appUserId: string,
): Promise<OrgRow[]> => {
  const t = tablesFor(ctx.dialect);
  const mine = await loadOrgMemberships(ctx, tenantId, appUserId);
  const rows = (await (ctx.db as any)
    .select()
    .from(t.orgs)
    .where(
      mine.length
        ? and(
            eq(t.orgs.tenantId, tenantId),
            ne(t.orgs.id, mine[0]!.orgId),
            ...mine.slice(1).map((m) => ne(t.orgs.id, m.orgId)),
          )
        : eq(t.orgs.tenantId, tenantId),
    )
    .orderBy(asc(t.orgs.name))) as Array<Record<string, unknown>>;
  return rows.map(mapOrg);
};
