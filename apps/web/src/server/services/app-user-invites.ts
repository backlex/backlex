import { and, eq } from "drizzle-orm";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { DbCtx } from "./seed";

/**
 * End-user invite tokens — the app-plane sibling of the platform member
 * invite (`tenant_members.invite_token`). The `app_users` table has no invite
 * columns, so the token + expiry live in `app_verifications` (the same table
 * better-auth and the SAML flow use for short-lived secrets), keyed as
 * `app-invite:<token>` with a JSON `{ appUserId, email }` value.
 *
 * Lifecycle: `POST /api/app-users/invite` (admin, control plane) writes one;
 * `POST /api/t/:slug/auth/invite/accept` (public, app plane) consumes it and
 * sets the credential. Same 7-day expiry as the platform flow.
 */

export const APP_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const inviteIdentifier = (token: string) => `app-invite:${token}`;

const verificationsFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.appVerifications : sqlite.schema.appVerifications;

export interface AppUserInvite {
  /** `app_verifications.id` — pass to {@link consumeAppUserInvite}. */
  id: string;
  appUserId: string;
  email: string;
  expired: boolean;
}

/** Mint a 7-day invite token for an end-user. Returns the raw token (mailed
 *  to the invitee and echoed to the admin) + its expiry. */
export const createAppUserInvite = async (
  ctx: DbCtx,
  tenantId: string,
  appUserId: string,
  email: string,
): Promise<{ token: string; expiresAt: Date }> => {
  const t = verificationsFor(ctx.dialect);
  const token = crypto.randomUUID().replace(/-/g, "");
  const expiresAt = new Date(Date.now() + APP_INVITE_TTL_MS);
  await (ctx.db as any).insert(t).values({
    id: crypto.randomUUID(),
    tenantId,
    identifier: inviteIdentifier(token),
    value: JSON.stringify({ appUserId, email }),
    expiresAt: ctx.dialect === "pg" ? expiresAt : expiresAt.getTime(),
  });
  return { token, expiresAt };
};

/** Resolve a token to its invite. Returns the row even when expired (the
 *  accept endpoint surfaces "expired" distinctly); null only when unknown. */
export const findAppUserInvite = async (
  ctx: DbCtx,
  tenantId: string,
  token: string,
): Promise<AppUserInvite | null> => {
  const t = verificationsFor(ctx.dialect);
  const rows = (await (ctx.db as any)
    .select({ id: t.id, value: t.value, expiresAt: t.expiresAt })
    .from(t)
    .where(and(eq(t.tenantId, tenantId), eq(t.identifier, inviteIdentifier(token))))
    .limit(1)) as Array<{ id: string; value: string; expiresAt: Date | number }>;
  const row = rows[0];
  if (!row) return null;
  let parsed: { appUserId?: unknown; email?: unknown };
  try {
    parsed = JSON.parse(row.value) as { appUserId?: unknown; email?: unknown };
  } catch {
    return null;
  }
  if (typeof parsed.appUserId !== "string" || typeof parsed.email !== "string") return null;
  const exp =
    row.expiresAt instanceof Date ? row.expiresAt.getTime() : Number(row.expiresAt);
  return {
    id: row.id,
    appUserId: parsed.appUserId,
    email: parsed.email,
    expired: exp <= Date.now(),
  };
};

/** One-shot: delete the verification row so the token can't be replayed. */
export const consumeAppUserInvite = async (ctx: DbCtx, id: string): Promise<void> => {
  const t = verificationsFor(ctx.dialect);
  await (ctx.db as any).delete(t).where(eq(t.id, id));
};
