/**
 * `services/membership.ts` — the one removal both eviction routes call.
 *
 * The assertion this file exists for is the CROSS-WORKSPACE one. Removing a
 * member has to drop their RBAC bindings, and the obvious way to write that
 * (`DELETE FROM user_roles WHERE user_id = ?`) is scoped to the PERSON rather
 * than to the workspace — so it would also strip their roles in every other
 * workspace they belong to. That failure is invisible to any test whose subject
 * belongs to exactly one workspace, which is why the target here belongs to
 * two: `adminA` is an `admin` in workspace A and holds the `authenticated` role
 * in `default`, the workspace every platform signup lands in.
 *
 * Everything is driven against a real harness — a real SQLite file, real rows
 * written by the real routes — because the defects being closed were all in the
 * SQL, and a mock would have agreed with whatever the code did.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AppError } from "@backlex/core";
import * as sqlite from "@backlex/db/sqlite";
import { and, eq } from "drizzle-orm";
import { buildContext } from "../src/server/context";
import { createApiKey } from "../src/server/services/api-keys";
import { createMemberInvite } from "../src/server/services/invites";
import {
  countOwners,
  removeMemberFully,
} from "../src/server/services/membership";
import {
  getCachedMembership,
  getCachedRoles,
  setCachedMembership,
  setCachedRoles,
} from "../src/server/services/permissions-cache";
import type { DbCtx } from "../src/server/services/seed";
import { buildTwoPlaneCast, type TwoPlaneCast } from "./fixtures/two-plane-cast";

let cast: TwoPlaneCast;
let ctx: DbCtx;
/** The harness is always SQLite, so the schema can be named directly rather
 *  than picked per dialect. */
const s = sqlite.schema;

/** Every role binding this user holds inside one workspace, by role id. */
const roleIdsIn = async (tenantId: string, userId: string): Promise<string[]> => {
  const rows = (await (ctx.db as any)
    .select({ roleId: s.userRoles.roleId })
    .from(s.userRoles)
    .innerJoin(s.roles, eq(s.userRoles.roleId, s.roles.id))
    .where(
      and(eq(s.userRoles.userId, userId), eq(s.roles.tenantId, tenantId)),
    )) as Array<{ roleId: string }>;
  return rows.map((r) => r.roleId).sort();
};

const memberRow = async (
  tenantId: string,
  userId: string,
): Promise<{ id: string; role: string } | undefined> => {
  const rows = (await (ctx.db as any)
    .select({ id: s.tenantMembers.id, role: s.tenantMembers.role })
    .from(s.tenantMembers)
    .where(
      and(
        eq(s.tenantMembers.tenantId, tenantId),
        eq(s.tenantMembers.userId, userId),
      ),
    )) as Array<{ id: string; role: string }>;
  return rows[0];
};

const keyRevokedAt = async (id: string): Promise<number | Date | null> => {
  const rows = (await (ctx.db as any)
    .select({ revokedAt: s.apiKeys.revokedAt })
    .from(s.apiKeys)
    .where(eq(s.apiKeys.id, id))) as Array<{ revokedAt: number | Date | null }>;
  return rows[0]?.revokedAt ?? null;
};

/** The `AppError` code a call threw, or `null` when it did not throw. Written
 *  as a helper so a test that expects a refusal fails loudly when the call
 *  SUCCEEDS instead of passing on a vacuous `.catch()`. */
const codeOf = async (fn: () => Promise<unknown>): Promise<string | null> => {
  try {
    await fn();
    return null;
  } catch (err) {
    if (err instanceof AppError) return err.code;
    throw err;
  }
};

beforeAll(async () => {
  cast = await buildTwoPlaneCast();
  const built = await buildContext(cast.h.env);
  ctx = { db: built.db, dialect: built.dialect };
});

afterAll(() => cast?.cleanup());

describe("countOwners", () => {
  test("counts accepted owners, not pending invitations", async () => {
    // Workspace A has exactly one owner: `ownerA`, who created it.
    expect(await countOwners(ctx, cast.tenantA.id)).toBe(1);

    // An invitation is not an owner. If it counted, an admin could invite an
    // address they control as `owner` and immediately evict the real one —
    // the last-owner guard would see two while the workspace had one.
    const invite = await createMemberInvite(ctx, {
      tenantId: cast.tenantA.id,
      email: `phantom-owner-${Date.now()}@example.test`,
      role: "owner",
      invitedBy: cast.ownerA.userId,
    });
    expect(await countOwners(ctx, cast.tenantA.id)).toBe(1);

    // The rank ladder applies to a row nobody has accepted — an invite that
    // NAMES `owner` is an owner-ranked target — but EQUAL rank is allowed, so
    // `ownerA` can revoke it. That is the whole point of the equal-rank
    // reading: an owner who sent an invitation must be able to cancel it, and
    // a rule that refused would have stranded the address (the create path
    // CONFLICTs on any existing row for that email).
    const revokedByPeer = await removeMemberFully(ctx, {
      tenantId: cast.tenantA.id,
      memberId: invite.id,
      actor: { id: cast.ownerA.userId, role: "owner" },
    });
    expect(revokedByPeer.role).toBe("owner");
    expect(revokedByPeer.userId).toBeNull();

    // The same row, revoked as the control plane, is the other supported
    // caller — re-created here so the two paths are both exercised rather than
    // one being assumed from the other.
    const again = await createMemberInvite(ctx, {
      tenantId: cast.tenantA.id,
      email: `phantom-owner-2-${Date.now()}@example.test`,
      role: "owner",
      invitedBy: cast.ownerA.userId,
    });
    const removed = await removeMemberFully(ctx, {
      tenantId: cast.tenantA.id,
      memberId: again.id,
      actor: null,
    });
    expect(removed.userId).toBeNull();
    expect(removed.role).toBe("owner");
    expect(removed.rolesRevoked).toEqual([]);
    expect(removed.apiKeysRevoked).toEqual([]);
  });
});

describe("removeMemberFully — refusals", () => {
  test("refuses to remove the workspace's last owner", async () => {
    expect(await countOwners(ctx, cast.tenantA.id)).toBe(1);
    const before = await memberRow(cast.tenantA.id, cast.ownerA.userId);
    expect(before?.role).toBe("owner");

    // `actor: null` is the control plane acting on behalf of nobody, which
    // bypasses the rank ladder entirely — so this proves the last-owner guard
    // on its own rather than riding on a rank refusal.
    expect(
      await codeOf(() =>
        removeMemberFully(ctx, {
          tenantId: cast.tenantA.id,
          userId: cast.ownerA.userId,
          actor: null,
        }),
      ),
    ).toBe("VALIDATION");

    // A refused removal writes nothing: the member is still there, with their
    // roles intact.
    expect(await memberRow(cast.tenantA.id, cast.ownerA.userId)).toBeDefined();
    expect((await roleIdsIn(cast.tenantA.id, cast.ownerA.userId)).length).toBeGreaterThan(0);
  });

  test("refuses an admin who tries to remove an owner", async () => {
    expect(
      await codeOf(() =>
        removeMemberFully(ctx, {
          tenantId: cast.tenantA.id,
          userId: cast.ownerA.userId,
          actor: { id: cast.adminA.userId, role: "admin" },
        }),
      ),
    ).toBe("FORBIDDEN");
    expect(await memberRow(cast.tenantA.id, cast.ownerA.userId)).toBeDefined();
  });

  test("a member id from another workspace resolves to nothing", async () => {
    // ownerB's membership row lives in workspace B. Addressed against
    // workspace A it must not resolve — the tenant scope is part of the
    // lookup, not a check performed afterwards.
    const b = await memberRow(cast.tenantB.id, cast.ownerB.userId);
    expect(b, "ownerB should be a member of workspace B").toBeDefined();
    expect(
      await codeOf(() =>
        removeMemberFully(ctx, {
          tenantId: cast.tenantA.id,
          memberId: b!.id,
          actor: null,
        }),
      ),
    ).toBe("NOT_FOUND");
    expect(await memberRow(cast.tenantB.id, cast.ownerB.userId)).toBeDefined();
  });

  test("needs a handle at all", async () => {
    expect(
      await codeOf(() =>
        removeMemberFully(ctx, { tenantId: cast.tenantA.id, actor: null }),
      ),
    ).toBe("VALIDATION");
  });
});

describe("removeMemberFully — the removal itself", () => {
  test("drops this workspace's roles and pinned keys, and leaves the rest of the account alone", async () => {
    const target = cast.adminA.userId;

    // adminA belongs to TWO workspaces: `default` (every platform signup lands
    // there as `authenticated`) and workspace A (invited as `admin`). Without
    // that second membership the account-wide-wipe assertion below would be
    // vacuous — there would be nothing outside workspace A left to survive.
    const rolesInDefaultBefore = await roleIdsIn(cast.defaultTenant.id, target);
    const rolesInABefore = await roleIdsIn(cast.tenantA.id, target);
    expect(
      rolesInDefaultBefore.length,
      "adminA must hold roles in the default workspace for this test to mean anything",
    ).toBeGreaterThan(0);
    expect(rolesInABefore.length).toBeGreaterThan(0);
    // The two sets must be disjoint, or "workspace A's bindings are gone" and
    // "the default workspace's bindings survived" could both be true of the
    // same row.
    expect(rolesInABefore.some((id) => rolesInDefaultBefore.includes(id))).toBe(false);

    // A machine credential PINNED to workspace A: it can only ever address
    // workspace A, so it must not outlive the membership.
    const pinned = await createApiKey(ctx, {
      name: "pinned to workspace A",
      userId: target,
      tenantId: cast.tenantA.id,
    });
    // …and one that is NOT pinned. An unpinned key resolves its workspace from
    // the owner's own memberships on each request, so it is already denied
    // workspace A once the membership row is gone — while it stays valid for
    // the workspaces the same person still belongs to. Revoking it would be
    // the account-wide overreach this service exists to avoid.
    const unpinnedId = crypto.randomUUID();
    await (ctx.db as any).insert(s.apiKeys).values({
      id: unpinnedId,
      tenantId: null,
      prefix: `pak_${unpinnedId.slice(0, 8)}`,
      hashedKey: `hash-${unpinnedId}`,
      name: "not pinned anywhere",
      userId: target,
      mcpReadOnly: false,
    });
    // A pinned key belonging to SOMEBODY ELSE in the same workspace, so a
    // revoke scoped only by tenant would be caught.
    const bystander = await createApiKey(ctx, {
      name: "ownerA's key",
      userId: cast.ownerA.userId,
      tenantId: cast.tenantA.id,
    });

    // The per-isolate role bundle. `invalidateTenantMembership` does NOT reach
    // this cache — only `invalidateUserRoles` does — so priming it is what
    // pins the second of the two invalidations the service owes.
    const rolesKey = {
      plane: "platform" as const,
      tenantId: cast.tenantA.id,
      userId: target,
      apiKeyRoleId: null,
    };
    setCachedRoles(rolesKey, [{ id: "stale", name: "admin", admin: true }]);

    const removed = await removeMemberFully(ctx, {
      tenantId: cast.tenantA.id,
      userId: target,
      actor: { id: cast.ownerA.userId, role: "owner" },
    });

    expect(
      getCachedRoles(rolesKey),
      "invalidateUserRoles should have dropped the removed member's cached role bundle",
    ).toBeUndefined();

    expect(removed.userId).toBe(target);
    expect(removed.email).toBe(cast.adminA.email);
    expect(removed.role).toBe("admin");
    expect(removed.rolesRevoked.sort()).toEqual(rolesInABefore);
    expect(removed.apiKeysRevoked).toEqual([pinned.row.id]);

    // The membership row is gone.
    expect(await memberRow(cast.tenantA.id, target)).toBeUndefined();

    // Workspace A's bindings are gone…
    expect(await roleIdsIn(cast.tenantA.id, target)).toEqual([]);
    // …and the default workspace's are untouched. THIS is the assertion that
    // catches a `DELETE FROM user_roles WHERE user_id = ?`.
    expect(await roleIdsIn(cast.defaultTenant.id, target)).toEqual(rolesInDefaultBefore);

    // The pinned key is revoked, the unpinned one is not, and the bystander's
    // key is untouched.
    expect(await keyRevokedAt(pinned.row.id)).not.toBeNull();
    expect(await keyRevokedAt(unpinnedId)).toBeNull();
    expect(await keyRevokedAt(bystander.row.id)).toBeNull();

    // Removing an admin cannot change how many owners the workspace has, and
    // the sole remaining owner is still protected.
    expect(await countOwners(ctx, cast.tenantA.id)).toBe(1);
    expect(
      await codeOf(() =>
        removeMemberFully(ctx, {
          tenantId: cast.tenantA.id,
          userId: cast.ownerA.userId,
          actor: null,
        }),
      ),
    ).toBe("VALIDATION");
  });

  test("removing someone who is not a member is a NOT_FOUND, not a silent success", async () => {
    // adminA was removed by the test above, so the same call must now refuse.
    expect(
      await codeOf(() =>
        removeMemberFully(ctx, {
          tenantId: cast.tenantA.id,
          userId: cast.adminA.userId,
          actor: null,
        }),
      ),
    ).toBe("NOT_FOUND");
  });

  test("a member may remove themselves even though they don't outrank themselves", async () => {
    // Leaving is not an escalation, and refusing it would strand someone who
    // wants out. `ownerB` owns workspace B, so the last-owner guard is what
    // stops them here — but `defaultTenant`, where they are an ordinary
    // member, is the case that matters.
    const before = await memberRow(cast.defaultTenant.id, cast.ownerB.userId);
    expect(before, "every platform signup joins the default workspace").toBeDefined();
    const rolesElsewhere = await roleIdsIn(cast.tenantB.id, cast.ownerB.userId);
    expect(rolesElsewhere.length).toBeGreaterThan(0);

    const removed = await removeMemberFully(ctx, {
      tenantId: cast.defaultTenant.id,
      userId: cast.ownerB.userId,
      actor: { id: cast.ownerB.userId, role: before!.role },
    });
    expect(removed.memberId).toBe(before!.id);
    expect(await memberRow(cast.defaultTenant.id, cast.ownerB.userId)).toBeUndefined();
    // Their own workspace is untouched — they left one workspace, not the
    // product.
    expect(await memberRow(cast.tenantB.id, cast.ownerB.userId)).toBeDefined();
    expect(await roleIdsIn(cast.tenantB.id, cast.ownerB.userId)).toEqual(rolesElsewhere);
  });
});

describe("removeMemberFully — cache invalidation", () => {
  test("the removed member's cached membership does not survive the removal", async () => {
    // `getCachedMembership` is what `tenantMiddleware` consults on every
    // request; a stale `true` there keeps an evicted member working for the
    // cache TTL. Prime it, remove, and read it back.
    const key = { tenantId: cast.tenantB.id, userId: cast.ownerB.userId };
    // ownerB owns B and is its last owner, so a member who can actually be
    // removed is needed: invite one and accept it into B by hand is more
    // machinery than the point deserves — a pending invite exercises the same
    // invalidation, since the service calls it unconditionally.
    const invite = await createMemberInvite(ctx, {
      tenantId: cast.tenantB.id,
      email: `cache-probe-${Date.now()}@example.test`,
      role: "member",
      invitedBy: cast.ownerB.userId,
    });
    setCachedMembership(key, true);
    expect(getCachedMembership(key)).toBe(true);

    await removeMemberFully(ctx, {
      tenantId: cast.tenantB.id,
      memberId: invite.id,
      actor: null,
    });

    expect(
      getCachedMembership(key),
      "invalidateTenantMembership should have dropped workspace B's membership cache",
    ).toBeUndefined();
  });
});
