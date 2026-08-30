import { AppError, SYSTEM_ROLES } from "@backlex/core";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import { and, eq, isNotNull, isNull, or } from "drizzle-orm";
import { log } from "../lib/log";
import { invalidateTenantMembership, invalidateUserRoles } from "./permissions-cache";
import { assignRoleByName, type DbCtx, ensureSystemRoles, getRoleByName } from "./seed";
import { hashToken } from "./shared-links";

/**
 * Shared workspace-invite logic, used by both the tenants route (`POST /accept`,
 * `GET /invite/{token}`) and the auth bootstrap hooks in `context.ts`. Keeping
 * it here (rather than importing a route file into context) lets a brand-new
 * user who signs up via an invite link bypass closed sign-up and land as an
 * active member in one step.
 */

export interface InviteRow {
  id: string;
  tenantId: string;
  email: string;
  role: string;
  status: string;
  /** LEGACY plaintext token. NULL on everything minted since hashing landed. */
  inviteToken: string | null;
  /** SHA-256 (hex) of the token — the only form a new invite stores. */
  inviteTokenHash: string | null;
  inviteExpiresAt: Date | number | string | null;
}

const membersFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.tenantMembers : sqlite.schema.tenantMembers;

const tenantsFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.tenants : sqlite.schema.tenants;

const isExpired = (expiresAt: InviteRow["inviteExpiresAt"]): boolean =>
  Boolean(expiresAt && new Date(expiresAt) < new Date());

/**
 * Every value the workspace membership ladder can hold, including the retired
 * one.
 *
 * `editor` is readable but no longer mintable (see `WORKSPACE_INVITE_ROLES` in
 * `services/roles/schemas.ts`). It has to stay in this list because it decides
 * a stored value's MEANING, and a row written two years ago means what it meant
 * then — dropping it here would reclassify those rows as RBAC role names.
 */
export const WORKSPACE_LADDER_ROLES = ["owner", "admin", "editor", "member"] as const;
export type WorkspaceLadderRole = (typeof WORKSPACE_LADDER_ROLES)[number];

/** Does this stored/incoming string name a membership standing rather than an
 *  RBAC role? The one question `tenant_members.role` could not answer while a
 *  single free-text column carried both vocabularies. */
export const isWorkspaceLadderRole = (value: string): value is WorkspaceLadderRole =>
  (WORKSPACE_LADDER_ROLES as readonly string[]).includes(value);

/**
 * The RBAC role a membership standing confers.
 *
 * `owner` and `admin` run the workspace, so they get the `admin` role that
 * bypasses permission checks; everyone else gets the `authenticated` baseline
 * both invite dialogs promise. Split out of `bindInvite` so the invite route
 * can tell the caller — in the mint response — which role their invite will
 * actually produce, instead of the caller finding out when the invitee signs in.
 */
export const standingToRbacRole = (standing: string): string =>
  standing === "owner" || standing === "admin"
    ? SYSTEM_ROLES.admin
    : SYSTEM_ROLES.authenticated;

/**
 * The one-time invite token, in the two forms a `tenant_members` row can hold.
 *
 * Every writer of an invite token goes through this — {@link createMemberInvite}
 * and the resend route in `routes/tenants.ts` — so neither can put a credential
 * back in the clear on its own. `inviteToken` is written as an explicit NULL
 * rather than omitted, because the resend route UPDATEs a row that may still
 * carry a legacy plaintext token, and leaving the column out would leave that
 * token alive next to the new digest.
 */
export const inviteTokenFields = async (
  token: string,
): Promise<{ inviteToken: null; inviteTokenHash: string }> => ({
  inviteToken: null,
  inviteTokenHash: await hashToken(token),
});

/**
 * The signal that retires the plaintext fallback.
 *
 * Every read that had to fall back to `tenant_members.invite_token` logs this
 * at warn, naming the member row it fired for. An operator watches for it: once
 * it has not appeared for a full invite TTL (7 days) plus a margin, no live
 * invite predates hashing, and the column and this branch can go in the
 * follow-up migration named in
 * `packages/db/drizzle/pg/20260830090000_invite_token_hash/migration.sql`.
 *
 * It is logged rather than silently tolerated for the reason a compatibility
 * path usually outlives its cause: nobody can tell an unused one from a
 * load-bearing one, so nobody ever dares delete it.
 */
const LEGACY_PLAINTEXT_MSG = "[invites] legacy plaintext invite token accepted";

/** Active (pending, unexpired, still-tokened) invite for an email, or null.
 *  Case-insensitive on email — the invite is stored as typed by the inviter, the
 *  sign-up email may differ in case. Reads degrade to null if the table isn't
 *  migrated yet. */
export const findActiveInviteByEmail = async (
  ctx: DbCtx,
  email: string,
): Promise<InviteRow | null> => {
  const t = membersFor(ctx.dialect);
  const wanted = email.trim().toLowerCase();
  try {
    // EITHER column proves a token was issued and not yet spent: a legacy row
    // carries the plaintext, a hashed row carries only the digest, and
    // `bindInvite` clears both on accept. Filtering on `invite_token` alone —
    // what this did before hashing — made every NEW invite invisible to the
    // closed-sign-up bypass and to the sign-up auto-accept, so the invite that
    // was supposed to let an invitee in would have turned them away at the
    // door. Silent, and only ever on a fresh invite.
    const rows = (await (ctx.db as any)
      .select()
      .from(t)
      .where(
        and(
          eq(t.status, "invited"),
          or(isNotNull(t.inviteToken), isNotNull(t.inviteTokenHash)),
        ),
      )) as InviteRow[];
    for (const r of rows) {
      if (r.email.toLowerCase() === wanted && !isExpired(r.inviteExpiresAt)) return r;
    }
    return null;
  } catch {
    return null;
  }
};

/**
 * Resolve a raw invite token to its member row.
 *
 * The ONE place a token out of a URL becomes a `tenant_members` row — the
 * public resolve route, `POST /api/tenants/accept` and the sign-up hooks all
 * arrive here — so no two readers can hold different ideas of how a token is
 * stored.
 *
 * Digest first; the plaintext column is consulted only for rows that have NO
 * digest. That `IS NULL` is load-bearing rather than tidiness: without it the
 * fallback is an oracle, because whoever can read the table could submit a
 * value they read OUT of it and be seated — the exact reading hashing exists to
 * defuse. With it, a row that has been hashed is reachable only by the token
 * itself.
 *
 * Returns the row even when expired (callers surface an "expired" state); null
 * only when unknown.
 */
export const findInviteByToken = async (
  ctx: DbCtx,
  token: string,
): Promise<{ invite: InviteRow; workspaceName: string; expired: boolean } | null> => {
  const m = membersFor(ctx.dialect);
  const tn = tenantsFor(ctx.dialect);
  if (!token) return null;
  const byHash = (await (ctx.db as any)
    .select()
    .from(m)
    .where(eq(m.inviteTokenHash, await hashToken(token)))
    .limit(1)) as InviteRow[];
  let invite = byHash[0];
  if (!invite) {
    const legacy = (await (ctx.db as any)
      .select()
      .from(m)
      .where(and(eq(m.inviteToken, token), isNull(m.inviteTokenHash)))
      .limit(1)) as InviteRow[];
    invite = legacy[0];
    if (invite)
      log.warn(LEGACY_PLAINTEXT_MSG, {
        lifecycle: "tenant_members",
        memberId: invite.id,
        tenantId: invite.tenantId,
      });
  }
  if (!invite) return null;
  const ws = (await (ctx.db as any)
    .select({ name: tn.name })
    .from(tn)
    .where(eq(tn.id, invite.tenantId))
    .limit(1)) as Array<{ name: string }>;
  return {
    invite,
    workspaceName: ws[0]?.name ?? "workspace",
    expired: isExpired(invite.inviteExpiresAt),
  };
};

/** True when a valid invite exists for this email — lets `onBeforeUserCreated`
 *  admit an invited sign-up even while public sign-up is closed. */
export const hasValidInvite = async (ctx: DbCtx, email: string): Promise<boolean> =>
  (await findActiveInviteByEmail(ctx, email)) !== null;

/**
 * Create a pending workspace invite: `tenant_members` row with status
 * `invited` + a 7-day one-time token. Single source of truth for BOTH invite
 * surfaces — `POST /api/tenants/{id}/members/invite` (workspace Members panel)
 * and `POST /api/users/invite` (Users page) — so the sign-up bypass
 * (`hasValidInvite`) and the accept flow behave identically no matter where
 * the invite was minted.
 *
 * `role` is stored verbatim in `tenant_members.role`, and callers should pass
 * a MEMBERSHIP STANDING (`owner`/`admin`/`member`). An RBAC role name is still
 * accepted, because rows written that way exist in the field and the Users-page
 * body still carries a deprecated `role` field for one release — `bindInvite`
 * classifies the stored value rather than guessing at it. New callers should
 * not add to that pile: a non-ladder value in this column is invisible to every
 * ladder reader (`assertWorkspaceAccess`, `WORKSPACE_RANK`), which scores it as
 * a plain member.
 *
 * Throws `CONFLICT` when the email is already a member of (or invited to)
 * the workspace.
 */
export const createMemberInvite = async (
  ctx: DbCtx,
  args: { tenantId: string; email: string; role: string; invitedBy: string | null },
): Promise<{ id: string; token: string; expiresAt: Date }> => {
  const t = membersFor(ctx.dialect);
  const email = args.email.trim().toLowerCase();
  const existing = (await (ctx.db as any)
    .select({ id: t.id, email: t.email })
    .from(t)
    .where(eq(t.tenantId, args.tenantId))) as { id: string; email: string }[];
  if (existing.some((r) => r.email.toLowerCase() === email))
    throw new AppError("CONFLICT", `${email} is already a member or invited`);
  const id = crypto.randomUUID();
  const token = crypto.randomUUID().replace(/-/g, "");
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await (ctx.db as any).insert(t).values({
    id,
    tenantId: args.tenantId,
    userId: null,
    email,
    role: args.role,
    status: "invited",
    invitedBy: args.invitedBy,
    invitedAt: new Date(),
    // The plaintext lives exactly as long as it takes to hand it back to the
    // caller, which mails it. No column ever holds it.
    ...(await inviteTokenFields(token)),
    inviteExpiresAt: expiresAt,
  });
  return { id, token, expiresAt };
};

/** Bind any active invite for `email` to the user: flip the member row to
 *  active, clear the token, ensure system roles, and assign the RBAC role that
 *  mirrors the membership level. Idempotent (no-op when there's no invite).
 *  Returns the tenantId bound, or null. Mirrors `POST /accept` so the two paths
 *  stay in lockstep. */
export const acceptInviteForUser = async (
  ctx: DbCtx,
  userId: string,
  email: string,
): Promise<string | null> => {
  const inv = await findActiveInviteByEmail(ctx, email);
  if (!inv) return null;
  return bindInvite(ctx, inv, userId);
};

/**
 * Bind a resolved invite row to a user: flip the member row to active, clear
 * the token, and grant the invite's role. Shared by BOTH accept paths — the
 * sign-up auto-accept (`acceptInviteForUser`) and the signed-in
 * `POST /api/tenants/accept` (existing users clicking an invite link) — so
 * role semantics can't drift between them.
 */
export const bindInvite = async (
  ctx: DbCtx,
  inv: InviteRow,
  userId: string,
): Promise<string> => {
  const m = membersFor(ctx.dialect);
  await (ctx.db as any)
    .update(m)
    .set({
      userId,
      status: "active",
      joinedAt: new Date(),
      // Both forms, not just whichever one this row happened to use — a spent
      // invite has to stop resolving on either path.
      inviteToken: null,
      inviteTokenHash: null,
      inviteExpiresAt: null,
    })
    .where(eq(m.id, inv.id));
  await ensureSystemRoles(ctx, inv.tenantId);
  // `tenant_members.role` carries two vocabularies, so the stored value has to
  // be CLASSIFIED before it can be resolved. The ladder wins: a value the
  // membership ladder owns is a standing, and its RBAC role follows from that.
  // Anything else is a legacy Users-page invite that stored an RBAC role name
  // (`authenticated`, a custom role) and is bound by exact name.
  //
  // This used to run the other way round — RBAC name first, ladder as the
  // fallback — which made `admin` mean whichever the database answered for
  // first, and let a workspace that happened to own a custom role called
  // `owner` or `member` silently outrank the ladder with it. Ladder-first is
  // deterministic and produces the same role as before for every value that
  // was not already ambiguous. Either way the user also gets the implicit
  // `authenticated` baseline both invite dialogs promise.
  let rbacRole: string;
  if (isWorkspaceLadderRole(inv.role)) {
    rbacRole = standingToRbacRole(inv.role);
  } else {
    const named = await getRoleByName(ctx, inv.tenantId, inv.role);
    rbacRole = named ? inv.role : SYSTEM_ROLES.authenticated;
  }
  await assignRoleByName(ctx, inv.tenantId, userId, rbacRole);
  if (rbacRole !== SYSTEM_ROLES.authenticated)
    await assignRoleByName(ctx, inv.tenantId, userId, SYSTEM_ROLES.authenticated);
  // Membership row + RBAC role both just changed for this tenant. Drop the
  // per-user roles entry too — the requesting session may have already cached
  // a pre-invite role set (e.g. just `authenticated`), which would otherwise
  // mask the invite's role until the cache expires.
  invalidateTenantMembership(inv.tenantId);
  invalidateUserRoles(inv.tenantId, userId);
  return inv.tenantId;
};
