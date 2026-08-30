import { and, eq, inArray, sql } from "drizzle-orm";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import { AppError, SYSTEM_ROLES } from "@backlex/core";
import type { Ctx } from "../context";
import { log } from "../lib/log";
import type { DbCtx } from "./seed";
import { invalidateUserRoles } from "./permissions-cache";
import { linkPersonRow } from "./portal-links";
import { hashToken } from "./shared-links";

/**
 * End-user invite tokens — the app-plane sibling of the platform member
 * invite (`tenant_members.invite_token`). The `app_users` table has no invite
 * columns, so the token + expiry live in `app_verifications` (the same table
 * better-auth and the SAML flow use for short-lived secrets), keyed as
 * `app-invite-h:<sha256(token)>` with a JSON `{ appUserId, email }` value.
 *
 * The key used to be `app-invite:<token>` — the credential itself. See
 * {@link hashedInviteIdentifier} for what changed and why the prefix moved
 * with it.
 *
 * Lifecycle: `POST /api/app-users/invite` (admin, control plane) writes one;
 * the invitee opens `/t/:slug/join/:token` (public, app plane) and that page
 * posts to `POST /api/t/:slug/auth/invite/accept`, which consumes the token and
 * sets the credential. Same 7-day expiry as the platform flow.
 */

export const APP_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Where an invitation is accepted — the accept PAGE, not the accept endpoint.
 *
 * The invitation used to mail the endpoint instead: the recipient was told to
 * `POST /api/t/{slug}/auth/invite/accept` with a JSON body holding the token
 * and a password of their choosing. Everybody an operator actually invites —
 * a customer, a member of staff, a supplier — reads that as a dead end, so the
 * whole admin-driven half of the end-user lifecycle only worked for people who
 * own an HTTP client. The link goes to a page that asks for a password now.
 *
 * The token travels only inside this URL. It is not repeated as a copyable
 * string in the mail body, because a token sitting in prose gets pasted into
 * chat, a ticket, or a reply-all, and it seats an account at whatever roles the
 * invitation carries.
 */
export const appInviteAcceptUrl = (
  appUrl: string | undefined,
  slug: string,
  token: string,
): string =>
  `${(appUrl ?? "").replace(/\/+$/, "")}/t/${encodeURIComponent(slug)}/join/${encodeURIComponent(token)}`;

/**
 * Why an invitation was refused, on the `details` of the CONFLICT it throws.
 *
 * A duplicate is two different situations wearing one status code, and only one
 * of them has a next move an operator can take. Machine-readable so a UI can
 * offer that move without parsing the message.
 */
export type InviteConflictReason =
  /** A pending invitation exists: no credential, no session. Re-send it. */
  | "already_invited"
  /** A real account exists (active or suspended). Open it instead. */
  | "already_a_user";

export interface InviteConflictDetails {
  reason: InviteConflictReason;
  /** `app_users.id` of the row already holding this address. */
  appUserId: string;
  email: string;
  status: string;
}

/**
 * The identifier a hashed invitation is stored under.
 *
 * This lifecycle has no token column — the credential IS the row key
 * (`app_verifications.identifier`), so hashing it needs no migration, only a
 * different string. The prefix changes with the scheme rather than staying
 * `app-invite:` for both, and that is the whole safety argument: were the
 * hashed form written under the SAME prefix, the stored identifier would read
 * `app-invite:<digest>`, and anyone who could read the table could submit
 * `<digest>` as their token — {@link legacyInviteIdentifier} would rebuild
 * exactly that string and match. Two prefixes make a value read out of the
 * table unusable as an input to either lookup.
 */
const hashedInviteIdentifier = (tokenHash: string) => `app-invite-h:${tokenHash}`;

/**
 * The identifier rows minted BEFORE hashing are stored under — the raw token
 * in the clear, as a row key.
 *
 * Kept only so an invitation already sitting in somebody's mailbox still opens.
 * Every read that resolves through it logs {@link LEGACY_PLAINTEXT_MSG}; when
 * that has been silent for a full {@link APP_INVITE_TTL_MS} plus a margin, no
 * such row can still be live (they are one-shot and self-expiring), and this
 * function and its branch in {@link findAppUserInvite} can go. Unlike the other
 * two lifecycles this one needs no migration to finish the job: the rows expire
 * out on their own.
 */
const legacyInviteIdentifier = (token: string) => `app-invite:${token}`;

/** See {@link legacyInviteIdentifier}. Logged, never silent, so the fallback is
 *  observably dead before anyone deletes it. */
const LEGACY_PLAINTEXT_MSG = "[app-user-invites] legacy plaintext invite token accepted";

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
    // Digest, not the token. The row used to BE the credential: `identifier`
    // read `app-invite:<token>`, so a dump of `app_verifications` was a list of
    // working invitations, each one a pending account waiting to be claimed.
    identifier: hashedInviteIdentifier(await hashToken(token)),
    value: JSON.stringify({ appUserId, email }),
    expiresAt: ctx.dialect === "pg" ? expiresAt : expiresAt.getTime(),
  });
  return { token, expiresAt };
};

/** Resolve a token to its invite. Returns the row even when expired (the
 *  accept endpoint surfaces "expired" distinctly); null only when unknown.
 *
 *  Hashed identifier first, plaintext identifier second and only for as long as
 *  invitations minted before hashing can still be live — see
 *  {@link legacyInviteIdentifier}. */
export const findAppUserInvite = async (
  ctx: DbCtx,
  tenantId: string,
  token: string,
): Promise<AppUserInvite | null> => {
  if (!token) return null;
  const t = verificationsFor(ctx.dialect);
  const lookup = async (identifier: string) =>
    (await (ctx.db as any)
      .select({ id: t.id, value: t.value, expiresAt: t.expiresAt })
      .from(t)
      .where(and(eq(t.tenantId, tenantId), eq(t.identifier, identifier)))
      .limit(1)) as Array<{ id: string; value: string; expiresAt: Date | number }>;
  let rows = await lookup(hashedInviteIdentifier(await hashToken(token)));
  if (!rows[0]) {
    rows = await lookup(legacyInviteIdentifier(token));
    if (rows[0])
      log.warn(LEGACY_PLAINTEXT_MSG, {
        lifecycle: "app_verifications",
        verificationId: rows[0].id,
        tenantId,
      });
  }
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

const tablesFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg"
    ? {
        appUsers: pg.schema.appUsers,
        appUserRoles: pg.schema.appUserRoles,
        roles: pg.schema.roles,
        tenants: pg.schema.tenants,
      }
    : {
        appUsers: sqlite.schema.appUsers,
        appUserRoles: sqlite.schema.appUserRoles,
        roles: sqlite.schema.roles,
        tenants: sqlite.schema.tenants,
      };

export interface AssignableRoleOptions {
  /**
   * The grant is being made from the **app plane** — a customer's own org admin
   * binding roles to members of their organization, rather than the operator
   * binding roles in the workspace.
   *
   * Those two callers have never been the same trust level, but until the
   * `roles.org_assignable` flag existed they shared one rule ("anything but
   * admin"), so a role written for internal staff was self-grantable by anyone
   * who ran an org. When this is set, a role must additionally be marked
   * org-assignable by its author.
   */
  orgScoped?: boolean;
}

/**
 * Validate a set of role ids for assignment to a workspace end-user: every id
 * must belong to the active workspace and the admin role is rejected — an
 * app-user can never hold the workspace admin bypass. Shared by
 * `PUT /api/app-users/{id}/roles` and every invite surface.
 *
 * `opts.orgScoped` adds the app-plane rule on top; see
 * {@link AssignableRoleOptions}. It is the ONE place both rules live, so a new
 * surface that binds roles cannot end up with a different idea of either.
 */
export const resolveAssignableRoles = async (
  ctx: DbCtx,
  tenantId: string,
  roleIds: string[],
  opts: AssignableRoleOptions = {},
): Promise<Array<{ id: string; name: string }>> => {
  const wanted = Array.from(new Set(roleIds));
  if (wanted.length === 0) return [];
  const t = tablesFor(ctx.dialect);
  const valid = (await (ctx.db as any)
    .select({
      id: t.roles.id,
      name: t.roles.name,
      admin: t.roles.admin,
      orgAssignable: t.roles.orgAssignable,
    })
    .from(t.roles)
    .where(and(eq(t.roles.tenantId, tenantId), inArray(t.roles.id, wanted)))) as Array<{
      id: string;
      name: string;
      admin: boolean;
      orgAssignable: boolean;
    }>;
  const validIds = new Set(valid.map((r) => r.id));
  const unknown = wanted.filter((id) => !validIds.has(id));
  if (unknown.length)
    throw new AppError("VALIDATION", `Unknown role(s) for this workspace: ${unknown.join(", ")}`);
  if (valid.some((r) => r.admin || r.name === SYSTEM_ROLES.admin))
    throw new AppError("VALIDATION", "The admin role cannot be assigned to a workspace end-user");
  if (opts.orgScoped) {
    // Named rather than counted: the org admin has to know WHICH role their
    // operator hasn't opened up, otherwise the only way forward is guessing.
    const barred = valid.filter((r) => !r.orgAssignable).map((r) => r.name);
    if (barred.length)
      throw new AppError(
        "VALIDATION",
        `Not assignable inside an organization: ${barred.join(", ")}. ` +
          "A workspace admin has to mark a role org-assignable first.",
      );
  }
  return valid.map((r) => ({ id: r.id, name: r.name }));
};

export interface InviteAppUserInput {
  email: string;
  name?: string;
  /** Roles bound at invite time — same rules as PUT /{id}/roles (must belong
   *  to the workspace; the admin role is rejected). */
  roleIds?: string[];
  /** Person row to link: sets `<collection>.<itemId>.app_user_id` to the
   *  invited user so `$user.id` permission conditions match after accept. */
  link?: { collection: string; itemId: string };
}

export interface InviteAppUserResult {
  id: string;
  email: string;
  token: string;
  expiresAt: Date;
}

/**
 * Admin-driven end-user provisioning — the counterpart to app-plane
 * self-signup, shared by REST `POST /api/app-users/invite`, the GraphQL
 * `inviteAppUser` mutation and MCP `app_users.invite`. Mirrors the platform
 * member invite: pending `app_users` row (`status: "invited"`, no credential)
 * + 7-day token + best-effort email (a mail-transport failure never fails the
 * invite). The invitee accepts on the app plane by opening the emailed
 * `/t/{slug}/join/{token}` page, which posts the token and the password they
 * choose to `POST /api/t/{slug}/auth/invite/accept`.
 *
 * A duplicate address throws CONFLICT carrying {@link InviteConflictDetails},
 * which says whether the address is a pending invitation or a real account.
 */
export const inviteAppUser = async (
  ctx: Ctx,
  tenantId: string,
  input: InviteAppUserInput,
): Promise<InviteAppUserResult> => {
  const t = tablesFor(ctx.dialect);
  const dbCtx: DbCtx = { db: ctx.db, dialect: ctx.dialect };

  // Emails are unique per (tenant, email) — better-auth lowercases on
  // sign-up, so normalize here and match case-insensitively for the
  // duplicate check.
  const email = input.email.trim().toLowerCase();
  const dup = (await (ctx.db as any)
    .select({ id: t.appUsers.id, status: t.appUsers.status })
    .from(t.appUsers)
    .where(
      and(
        eq(t.appUsers.tenantId, tenantId),
        sql`lower(${t.appUsers.email}) = ${email}`,
      ),
    )
    .limit(1)) as Array<{ id: string; status: string }>;
  const held = dup[0];
  if (held) {
    // Both branches are a 409, and until now they were indistinguishable: an
    // operator inviting somebody a colleague had already invited last week got
    // the same "already has an account" sentence as one inviting a customer who
    // signed up on their own — and the move the first case wants, send it
    // again, was unreachable from any surface. The reason rides on `details` so
    // a caller can offer that move instead of re-reading the message.
    const pending = held.status === "invited";
    const details: InviteConflictDetails = {
      reason: pending ? "already_invited" : "already_a_user",
      appUserId: held.id,
      email,
      status: held.status,
    };
    throw new AppError(
      "CONFLICT",
      pending
        ? `${email} has already been invited to this workspace and hasn't accepted yet`
        : `${email} already has an end-user account in this workspace`,
      details,
    );
  }

  // Validate roles + link target BEFORE creating anything, so a bad
  // request leaves no half-provisioned user behind.
  const roles = await resolveAssignableRoles(dbCtx, tenantId, input.roleIds ?? []);

  const appUserId = crypto.randomUUID();
  const now = ctx.dialect === "pg" ? new Date() : Date.now();
  await (ctx.db as any).insert(t.appUsers).values({
    id: appUserId,
    tenantId,
    email,
    emailVerified: false,
    name: input.name ?? null,
    status: "invited",
    createdAt: now,
    updatedAt: now,
  });

  for (const r of roles) {
    await (ctx.db as any)
      .insert(t.appUserRoles)
      .values({ appUserId, roleId: r.id });
  }
  if (roles.length) invalidateUserRoles(tenantId, appUserId);

  // Link the person row (employees/members/…) so the invitee's
  // `$user.id`-conditioned permissions match from the first sign-in.
  if (input.link) {
    await linkPersonRow(dbCtx, tenantId, input.link.collection, input.link.itemId, appUserId);
  }

  const { token, expiresAt } = await createAppUserInvite(dbCtx, tenantId, appUserId, email);

  // Best-effort mail through the workspace's transport (dev falls back to
  // the console adapter). Fire-and-forget with a swallow — a broken SMTP
  // config must never fail the invite; the admin still gets the token back.
  void (async () => {
    const slugRows = (await (ctx.db as any)
      .select({ slug: t.tenants.slug })
      .from(t.tenants)
      .where(eq(t.tenants.id, tenantId))
      .limit(1)) as Array<{ slug: string }>;
    const slug = slugRows[0]?.slug ?? tenantId;
    const transport = await ctx.emailFor(tenantId);
    const acceptUrl = appInviteAcceptUrl(ctx.env.APP_URL, slug, token);
    await transport.send({
      to: email,
      subject: "You've been invited",
      // One link, and nothing else worth copying. See {@link appInviteAcceptUrl}
      // for why the token appears only as part of that URL.
      text:
        "You've been invited to create an account.\n\n" +
        `Open this link to choose a password and sign in:\n${acceptUrl}\n\n` +
        `The link expires ${expiresAt.toISOString()}. ` +
        "If you weren't expecting this invitation, ignore this message — nothing happens until the link is opened.",
    });
  })().catch(() => {});

  return { id: appUserId, email, token, expiresAt };
};
