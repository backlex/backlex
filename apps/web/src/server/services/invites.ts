import { and, eq, isNotNull } from "drizzle-orm";
import { SYSTEM_ROLES } from "@backlex/core";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import { assignRoleByName, ensureSystemRoles, type DbCtx } from "./seed";

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
  inviteToken: string | null;
  inviteExpiresAt: Date | number | string | null;
}

const membersFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.tenantMembers : sqlite.schema.tenantMembers;

const tenantsFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.tenants : sqlite.schema.tenants;

const isExpired = (expiresAt: InviteRow["inviteExpiresAt"]): boolean =>
  Boolean(expiresAt && new Date(expiresAt) < new Date());

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
    const rows = (await (ctx.db as any)
      .select()
      .from(t)
      .where(and(eq(t.status, "invited"), isNotNull(t.inviteToken)))) as InviteRow[];
    for (const r of rows) {
      if (r.email.toLowerCase() === wanted && !isExpired(r.inviteExpiresAt)) return r;
    }
    return null;
  } catch {
    return null;
  }
};

/** Resolve an invite token to `{ invite, workspaceName }`. Returns the row even
 *  when expired (callers surface an "expired" state); null only when unknown. */
export const findInviteByToken = async (
  ctx: DbCtx,
  token: string,
): Promise<{ invite: InviteRow; workspaceName: string; expired: boolean } | null> => {
  const m = membersFor(ctx.dialect);
  const tn = tenantsFor(ctx.dialect);
  const rows = (await (ctx.db as any)
    .select()
    .from(m)
    .where(eq(m.inviteToken, token))
    .limit(1)) as InviteRow[];
  const invite = rows[0];
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
  const m = membersFor(ctx.dialect);
  await (ctx.db as any)
    .update(m)
    .set({
      userId,
      status: "active",
      joinedAt: new Date(),
      inviteToken: null,
      inviteExpiresAt: null,
    })
    .where(eq(m.id, inv.id));
  await ensureSystemRoles(ctx, inv.tenantId);
  const rbacRole =
    inv.role === "owner" || inv.role === "admin"
      ? SYSTEM_ROLES.admin
      : SYSTEM_ROLES.authenticated;
  await assignRoleByName(ctx, inv.tenantId, userId, rbacRole);
  return inv.tenantId;
};
