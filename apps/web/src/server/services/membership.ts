/**
 * Workspace membership removal, written once for the two routes that claim to
 * do it.
 *
 * There were two of them and they did different things.
 * `DELETE /api/tenants/{id}/members/{memberId}` issued a single statement — it
 * deleted the `tenant_members` row and stopped. The RBAC bindings in
 * `user_roles` stayed, the personal API keys stayed, and nothing checked
 * whether the row being deleted was the workspace's last owner.
 * `DELETE /api/users/{id}` in `routes/roles/users.ts` dropped the
 * tenant-scoped `user_roles` first, so it removed rather more. Whether an
 * eviction actually evicted therefore depended on which of two buttons the
 * admin happened to press, and before the cross-tenant shortcut was closed the
 * lighter of the two paths re-admitted the evicted user as an admin.
 *
 * One implementation, called by both. The interesting decisions are marked
 * below; the short version is that a removal is scoped to THIS workspace in
 * every table it touches, because the identities involved are global and a
 * removal that reached past the workspace boundary would be an account-wide
 * privilege wipe dressed up as a membership change.
 */
import { AppError } from "@backlex/core";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import { and, count, eq, inArray, isNotNull, isNull, ne } from "drizzle-orm";
import { assertMayActOn, WORKSPACE_RANK } from "./membership-guards";
import {
  invalidateTenantMembership,
  invalidateUserRoles,
} from "./permissions-cache";
import type { DbCtx } from "./seed";

const tablesFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg"
    ? {
        members: pg.schema.tenantMembers,
        roles: pg.schema.roles,
        userRoles: pg.schema.userRoles,
        apiKeys: pg.schema.apiKeys,
      }
    : {
        members: sqlite.schema.tenantMembers,
        roles: sqlite.schema.roles,
        userRoles: sqlite.schema.userRoles,
        apiKeys: sqlite.schema.apiKeys,
      };

/** `revoked_at` in whichever shape the dialect's column wants. Mirrors the
 *  inline expression the suspend route already uses. */
const nowFor = (dialect: "pg" | "sqlite"): Date | number =>
  dialect === "pg" ? new Date() : Date.now();

/** The person performing the removal, as a membership row. `null` is the
 *  control plane acting on behalf of nobody — see `membership-guards.ts`. */
export interface MembershipActor {
  id: string;
  role: string;
}

/**
 * How many owners this workspace has who can actually administer it.
 *
 * Three deliberate exclusions, because each one changes the answer:
 *
 *   - a row with `user_id IS NULL` is a PENDING INVITE, not an owner. Counting
 *     it would let an admin invite `someone@example.com` as `owner` and
 *     immediately remove the real one: the guard would see two owners while
 *     the workspace had one, and nothing forces an invite to ever be accepted.
 *   - a SUSPENDED owner does not count. `assertWorkspaceAccess` turns them
 *     away, so they cannot invite, promote or evict anyone — counting them let
 *     two owners become zero ACTING owners: suspend one, demote the other, and
 *     a guard reading the raw row set saw two the whole way down.
 *   - `excludeMemberId` leaves the row being acted on out, which is what makes
 *     the question answerable about the RESULT of a change rather than about
 *     the state before it. See `assertLeavesAnActingOwner`.
 *
 * Excluding suspended owners is what forces the forward-looking form: ask "are
 * there OTHER acting owners" and both edges behave, where "is the count above
 * one" would have made an already-stranded workspace unrepairable.
 *
 * Exported because the routes need the same number for their own pre-flight
 * checks (a role change out of `owner` is the other way to reach zero owners),
 * and a second copy of this query is exactly how the two removal paths drifted.
 */
export const countOwners = async (
  ctx: DbCtx,
  tenantId: string,
  opts: { excludeMemberId?: string } = {},
): Promise<number> => {
  const t = tablesFor(ctx.dialect);
  const rows = (await (ctx.db as any)
    .select({ n: count() })
    .from(t.members)
    .where(
      and(
        eq(t.members.tenantId, tenantId),
        eq(t.members.role, "owner"),
        // `NOT NULL` is what separates an accepted membership from an invite
        // that was merely sent — `bindInvite` is what fills the column in.
        isNotNull(t.members.userId),
        // A SUSPENDED owner is not one for this purpose. The invariant worth
        // holding is "somebody can still administer this workspace", and
        // `assertWorkspaceAccess` turns a suspended member away — so counting
        // them let two owners become zero acting owners: suspend one, then
        // demote the other, and the guard saw two the whole way down.
        ne(t.members.status, "suspended"),
        ...(opts.excludeMemberId ? [ne(t.members.id, opts.excludeMemberId)] : []),
      ),
    )) as Array<{ n: number | string }>;
  return Number(rows[0]?.n ?? 0);
};

/**
 * Would this change leave the workspace with nobody who can administer it?
 *
 * Forward-looking, and that is the point. Counting the CURRENT owners and
 * refusing at one has two bad edges: a workspace already stranded (its only
 * owner suspended by hand, or by an older build) becomes unfixable, because
 * every repair is itself a change to the last owner; and two owners with one
 * suspended reads as two.
 *
 * So the question is asked about the RESULT: how many acting owners remain
 * once this row stops being one. A change is refused only when it takes the
 * last acting owner away from a workspace that still had one — never when the
 * workspace was already in that state, where refusing repairs nothing and
 * blocks the repair.
 */
export const assertLeavesAnActingOwner = async (
  ctx: DbCtx,
  tenantId: string,
  target: { memberId: string; role: string; status: string },
  next: { role?: string; status?: string },
): Promise<void> => {
  const wasActing = target.role === "owner" && target.status !== "suspended";
  if (!wasActing) return;
  const stillActing =
    (next.role ?? target.role) === "owner" &&
    (next.status ?? target.status) !== "suspended";
  if (stillActing) return;
  const othersActing = await countOwners(ctx, tenantId, {
    excludeMemberId: target.memberId,
  });
  if (othersActing > 0) return;
  throw new AppError(
    "VALIDATION",
    "This is the workspace's last active owner — promote or unsuspend someone else first",
  );
};

/** The membership row a removal resolved to, plus what the removal took with
 *  it. Returned so a route can log and report honestly rather than guessing. */
export interface RemovedMember {
  memberId: string;
  /** `null` for a pending invite — nobody has accepted it yet. */
  userId: string | null;
  email: string;
  /** The membership role the row held at the moment it was deleted. */
  role: string;
  status: string;
  /** Ids of the roles whose `user_roles` bindings were dropped — all of them
   *  belonging to THIS workspace. */
  rolesRevoked: string[];
  /** Ids of the API keys revoked — all of them pinned to THIS workspace. */
  apiKeysRevoked: string[];
}

export interface RemoveMemberInput {
  tenantId: string;
  /** `tenant_members.id` — how `DELETE /api/tenants/{id}/members/{memberId}`
   *  addresses a member. The only handle a pending invite has. */
  memberId?: string;
  /** `users.id` — how `DELETE /api/users/{id}` addresses one. */
  userId?: string;
  actor: MembershipActor | null;
}

/**
 * Remove a member from a workspace, and actually remove them.
 *
 * The order matters: everything that can refuse runs before anything is
 * written, so a refused removal leaves the member exactly as they were rather
 * than half-stripped.
 */
export const removeMemberFully = async (
  ctx: DbCtx,
  input: RemoveMemberInput,
): Promise<RemovedMember> => {
  const { tenantId, memberId, userId, actor } = input;
  if (!memberId && !userId) {
    throw new AppError(
      "VALIDATION",
      "removeMemberFully needs either a member id or a user id",
    );
  }
  const t = tablesFor(ctx.dialect);

  // Resolve the row from whichever handle the caller had. Both lookups are
  // scoped by tenant, so a member id borrowed from another workspace resolves
  // to nothing instead of to somebody else's membership.
  const rows = (await (ctx.db as any)
    .select({
      id: t.members.id,
      userId: t.members.userId,
      email: t.members.email,
      role: t.members.role,
      status: t.members.status,
    })
    .from(t.members)
    .where(
      and(
        eq(t.members.tenantId, tenantId),
        memberId ? eq(t.members.id, memberId) : eq(t.members.userId, userId!),
      ),
    )
    .limit(1)) as Array<{
    id: string;
    userId: string | null;
    email: string;
    role: string;
    status: string;
  }>;
  const row = rows[0];
  if (!row) throw new AppError("NOT_FOUND", "Not a member of this workspace");

  // A pending invite has no user id, so it can never be the actor themselves;
  // falling back to the member id keeps the self-action branch from matching by
  // accident on two nulls comparing equal.
  assertMayActOn(actor, row.userId ?? row.id, row.role, WORKSPACE_RANK);
  // Only a row that COUNTS as an owner can be protected as one. `countOwners`
  // ignores pending invitations, so an invite that merely names `owner` was
  // never part of the count and revoking it cannot reduce it — guarding it
  // anyway would refuse to cancel an invitation that protects nothing, in a
  // workspace whose real owner is untouched. Counted and protected have to be
  // the same set or the guard contradicts the count.
  if (row.userId) {
    // A removal takes the row away entirely, so there is no "next" state to
    // describe — it simply stops being an owner.
    await assertLeavesAnActingOwner(
      ctx,
      tenantId,
      { memberId: row.id, role: row.role, status: row.status },
      { role: "member" },
    );
  }

  const rolesRevoked: string[] = [];
  const apiKeysRevoked: string[] = [];

  if (row.userId) {
    // Drop the RBAC bindings — but only those pointing at roles that belong to
    // THIS workspace. Deleting by user id alone would strip the same person's
    // roles in every other workspace they are a member of, turning "remove
    // from this workspace" into an account-wide privilege wipe. The users
    // route already scoped it this way; this is that scoping, kept.
    const roleIds = (await (ctx.db as any)
      .select({ id: t.roles.id })
      .from(t.roles)
      .where(eq(t.roles.tenantId, tenantId))) as Array<{ id: string }>;
    if (roleIds.length) {
      const ids = roleIds.map((r) => r.id);
      const doomed = (await (ctx.db as any)
        .select({ roleId: t.userRoles.roleId })
        .from(t.userRoles)
        .where(
          and(
            eq(t.userRoles.userId, row.userId),
            inArray(t.userRoles.roleId, ids),
          ),
        )) as Array<{ roleId: string }>;
      rolesRevoked.push(...doomed.map((r) => r.roleId));
      if (doomed.length) {
        await (ctx.db as any)
          .delete(t.userRoles)
          .where(
            and(
              eq(t.userRoles.userId, row.userId),
              inArray(t.userRoles.roleId, ids),
            ),
          );
      }
    }

    // Revoke the personal API keys PINNED to this workspace, and only those.
    //
    // `api_keys.tenant_id` is nullable: a null means the key is not pinned, and
    // `middleware/tenant.ts` resolves such a key's workspace from the owner's
    // own membership on every request. So an unpinned key is already denied
    // this workspace the moment the membership row below disappears, while it
    // stays valid for the other workspaces its owner still belongs to.
    // Revoking it here would destroy credentials that have nothing to do with
    // this workspace — the same account-wide overreach the `user_roles` scoping
    // above exists to prevent, one table over. A pinned key has no such second
    // life: it can only ever address this workspace, so leaving it live would
    // hand the evicted member a working machine credential for the workspace
    // they were just removed from.
    const keys = (await (ctx.db as any)
      .select({ id: t.apiKeys.id })
      .from(t.apiKeys)
      .where(
        and(
          eq(t.apiKeys.tenantId, tenantId),
          eq(t.apiKeys.userId, row.userId),
          isNull(t.apiKeys.revokedAt),
        ),
      )) as Array<{ id: string }>;
    apiKeysRevoked.push(...keys.map((k) => k.id));
    if (keys.length) {
      await (ctx.db as any)
        .update(t.apiKeys)
        .set({ revokedAt: nowFor(ctx.dialect) })
        .where(
          inArray(
            t.apiKeys.id,
            keys.map((k) => k.id),
          ),
        );
    }
  }

  await (ctx.db as any).delete(t.members).where(eq(t.members.id, row.id));

  // Both per-isolate caches now hold a membership and a role bundle the
  // database no longer agrees with. Without these the removed member keeps
  // resolving their old roles for up to the cache TTL — which is the whole
  // window an eviction exists to close.
  invalidateTenantMembership(tenantId);
  if (row.userId) invalidateUserRoles(tenantId, row.userId);

  // Sessions are deliberately left alone. better-auth sessions are global
  // rather than per-workspace, so deleting them would sign the person out of
  // every other workspace they belong to. The cache invalidation above is what
  // makes their existing session stop resolving anything here.
  return {
    memberId: row.id,
    userId: row.userId,
    email: row.email,
    role: row.role,
    status: row.status,
    rolesRevoked,
    apiKeysRevoked,
  };
};
