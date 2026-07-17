// Workspace user administration (list/invite/roles/suspend/sessions/2FA).
// Split out of the former routes/roles.ts god-file.
import { AppError } from "@backlex/core";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { AppBindings } from "../../app";
import { errorResponses, OkSchema, SECURITY } from "../../lib/openapi";
import { requireUser } from "../../middleware/session";
import {
  invalidateTenantMembership,
  invalidateUserRoles,
} from "../../services/permissions-cache";
import {
  assertTenantMember,
  requireAdminMw,
  requireTenant,
} from "../../services/roles/guards";
import { createMemberInvite } from "../../services/invites";
import { ensureRoleInTenant } from "../../services/roles/role-checks";
import {
  SessionRow,
  USERS_TAG,
  UserAttachRoleInput,
  UserInviteInput,
  UserRow,
  UserUpdateInput,
} from "../../services/roles/schemas";
import { tableFor } from "../../services/roles/tables";
import { defaultHook } from "../../lib/openapi-router";

export const usersRoutes = new OpenAPIHono<AppBindings>({ defaultHook })
  .openapi(
    createRoute({
      method: "get",
      path: "/",
      tags: USERS_TAG,
      summary: "List workspace users",
      description:
        "Admin-app users who are members of the active workspace, with their role bindings and last session timestamp.",
      security: SECURITY,
      middleware: [requireUser, requireAdminMw],
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": {
              schema: z.object({ data: z.array(UserRow) }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const t = tableFor(ctx.dialect);
      // Only list users who are members of the active tenant. The users
      // table itself is global (better-auth owns it) — workspace isolation
      // happens via the tenant_members join.
      const users = (await (ctx.db as any)
        .select({
          id: t.users.id,
          email: t.users.email,
          name: t.users.name,
          createdAt: t.users.createdAt,
          twoFactorEnabled: t.users.twoFactorEnabled,
          memberId: t.tenantMembers.id,
          memberStatus: t.tenantMembers.status,
        })
        .from(t.tenantMembers)
        .innerJoin(t.users, eq(t.tenantMembers.userId, t.users.id))
        .where(eq(t.tenantMembers.tenantId, tenantId))) as {
        id: string;
        email: string;
        name: string | null;
        createdAt: unknown;
        twoFactorEnabled: boolean | null;
        memberId: string;
        memberStatus: string | null;
      }[];
      // Pending invites (no user row yet) surface in the same list so an
      // admin sees the invite they just sent — id is the tenant_members row
      // id (never collides with user ids), actions are limited client-side.
      const pendingInvites = (await (ctx.db as any)
        .select({
          id: t.tenantMembers.id,
          email: t.tenantMembers.email,
          role: t.tenantMembers.role,
          invitedAt: t.tenantMembers.invitedAt,
          inviteToken: t.tenantMembers.inviteToken,
        })
        .from(t.tenantMembers)
        .where(
          and(
            eq(t.tenantMembers.tenantId, tenantId),
            eq(t.tenantMembers.status, "invited"),
            isNull(t.tenantMembers.userId),
          ),
        )) as {
        id: string;
        email: string;
        role: string;
        invitedAt: unknown;
        inviteToken: string | null;
      }[];
      const userIds = users.map((u) => u.id);
      const userRoles = userIds.length
        ? ((await (ctx.db as any)
            .select({
              userId: t.userRoles.userId,
              roleId: t.userRoles.roleId,
              name: t.roles.name,
            })
            .from(t.userRoles)
            .innerJoin(t.roles, eq(t.userRoles.roleId, t.roles.id))
            .where(
              and(
                eq(t.roles.tenantId, tenantId),
                inArray(t.userRoles.userId, userIds),
              ),
            )) as { userId: string; roleId: string; name: string }[])
        : [];
      // Last-seen comes from the most recent session row per user. Cheap on
      // small DBs; on larger deployments this should move to a materialized
      // `users.last_seen_at` updated by the session middleware.
      const sessionRows = userIds.length
        ? ((await (ctx.db as any)
            .select({ userId: t.sessions.userId, createdAt: t.sessions.createdAt })
            .from(t.sessions)
            .where(inArray(t.sessions.userId, userIds))) as {
            userId: string;
            createdAt: unknown;
          }[])
        : [];
      const lastByUser = new Map<string, number>();
      for (const s of sessionRows) {
        const ts =
          typeof s.createdAt === "number"
            ? s.createdAt
            : new Date(s.createdAt as string).getTime();
        const prev = lastByUser.get(s.userId) ?? 0;
        if (ts > prev) lastByUser.set(s.userId, ts);
      }

      const byUser = new Map<string, { id: string; name: string }[]>();
      for (const r of userRoles) {
        let bucket = byUser.get(r.userId);
        if (!bucket) {
          bucket = [];
          byUser.set(r.userId, bucket);
        }
        bucket.push({ id: r.roleId, name: r.name });
      }

      // Auth method per user. A platform federated identity (saml/ldap/cloud)
      // wins — it's the most security-relevant attribute — else the better-auth
      // account provider ("credential" → password, else github/google/…).
      const providerByUser = new Map<string, string>();
      if (userIds.length) {
        const accountRows = (await (ctx.db as any)
          .select({ userId: t.accounts.userId, providerId: t.accounts.providerId })
          .from(t.accounts)
          .where(inArray(t.accounts.userId, userIds))) as {
          userId: string;
          providerId: string;
        }[];
        for (const a of accountRows) {
          if (providerByUser.has(a.userId)) continue;
          providerByUser.set(a.userId, a.providerId === "credential" ? "password" : a.providerId);
        }
        const identRows = (await (ctx.db as any)
          .select({
            userId: t.platformExternalIdentities.userId,
            providerType: t.platformExternalIdentities.providerType,
          })
          .from(t.platformExternalIdentities)
          .where(inArray(t.platformExternalIdentities.userId, userIds))) as {
          userId: string;
          providerType: string;
        }[];
        for (const i of identRows) providerByUser.set(i.userId, i.providerType);
      }

      return c.json({
        data: [
          ...users.map(({ memberStatus, ...u }) => ({
            ...u,
            roles: byUser.get(u.id) ?? [],
            lastSeenAt: lastByUser.get(u.id) ?? null,
            provider: providerByUser.get(u.id) ?? "password",
            twoFactorEnabled: Boolean(u.twoFactorEnabled),
            status: memberStatus === "suspended" ? "suspended" : "active",
          })),
          ...pendingInvites.map((p) => ({
            id: p.id,
            email: p.email,
            name: null,
            createdAt: p.invitedAt,
            roles: [{ id: "", name: p.role }],
            lastSeenAt: null,
            provider: "invite",
            twoFactorEnabled: false,
            status: "invited" as const,
            memberId: p.id,
            inviteUrl: p.inviteToken
              ? `${ctx.env.APP_URL}/invite?token=${p.inviteToken}`
              : undefined,
          })),
        ],
      });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/{id}/roles",
      tags: USERS_TAG,
      summary: "Attach a role",
      description: "Bind a workspace-scoped role to the user. Idempotent.",
      security: SECURITY,
      middleware: [requireUser, requireAdminMw],
      request: {
        params: z.object({ id: z.string() }),
        body: {
          required: true,
          content: { "application/json": { schema: UserAttachRoleInput } },
        },
      },
      responses: {
        200: {
          description: "Bound",
          content: { "application/json": { schema: OkSchema } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const { id: userId } = c.req.valid("param");
      const body = c.req.valid("json");
      // Role must belong to active tenant.
      await ensureRoleInTenant(
        { db: ctx.db, dialect: ctx.dialect },
        tenantId,
        body.roleId,
      );
      const t = tableFor(ctx.dialect);
      // User must be a member of active tenant.
      const memberRows = (await (ctx.db as any)
        .select({ id: t.tenantMembers.id })
        .from(t.tenantMembers)
        .where(
          and(
            eq(t.tenantMembers.tenantId, tenantId),
            eq(t.tenantMembers.userId, userId),
          ),
        )
        .limit(1)) as { id: string }[];
      if (!memberRows[0])
        throw new AppError("NOT_FOUND", "User not in this workspace");
      await (ctx.db as any)
        .insert(t.userRoles)
        .values({ userId, roleId: body.roleId })
        .onConflictDoNothing();
      invalidateUserRoles(tenantId, userId);
      return c.json({ ok: true });
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/{id}/roles/{roleId}",
      tags: USERS_TAG,
      summary: "Detach a role",
      description: "Removes the (user, role) binding. Idempotent.",
      security: SECURITY,
      middleware: [requireUser, requireAdminMw],
      request: { params: z.object({ id: z.string(), roleId: z.string() }) },
      responses: {
        200: {
          description: "Removed",
          content: { "application/json": { schema: OkSchema } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const { id, roleId } = c.req.valid("param");
      await ensureRoleInTenant(
        { db: ctx.db, dialect: ctx.dialect },
        tenantId,
        roleId,
      );
      const t = tableFor(ctx.dialect);
      await (ctx.db as any)
        .delete(t.userRoles)
        .where(and(eq(t.userRoles.userId, id), eq(t.userRoles.roleId, roleId)));
      invalidateUserRoles(tenantId, id);
      return c.json({ ok: true });
    },
  )
  /**
   * Email-based invite. Creates a real workspace invite (`tenant_members`
   * row + 7-day token via the shared `createMemberInvite`) so the invitee can
   * sign up through `/invite?token=…` even while public sign-up is closed —
   * `hasValidInvite` admits the address and `acceptInviteForUser` binds the
   * membership + chosen role on account creation. The email itself is
   * best-effort; the response carries the accept link so no-SMTP deployments
   * can share it manually.
   */
  .openapi(
    createRoute({
      method: "post",
      path: "/invite",
      tags: USERS_TAG,
      summary: "Email-invite a user",
      description:
        "Creates a pending workspace invite (7-day token) and best-effort mails the accept link. The user record is created when the invitee accepts.",
      security: SECURITY,
      middleware: [requireUser, requireAdminMw],
      request: {
        body: {
          required: true,
          content: { "application/json": { schema: UserInviteInput } },
        },
      },
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": {
              schema: z.object({
                data: z.object({
                  id: z.string(),
                  email: z.string(),
                  token: z.string(),
                  /** Ready-to-share accept link (`{APP_URL}/invite?token=…`). */
                  url: z.string(),
                  /** False when the mail only hit the console fallback — the
                   *  UI should surface `url` for manual sharing instead. */
                  sent: z.boolean(),
                }),
              }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const tenantId = requireTenant(c);
      const body = c.req.valid("json");
      const { id, token } = await createMemberInvite(
        { db: ctx.db, dialect: ctx.dialect },
        {
          tenantId,
          email: body.email,
          role: body.role ?? "authenticated",
          invitedBy: auth?.userId ?? null,
        },
      );
      const url = `${ctx.env.APP_URL}/invite?token=${token}`;
      const sent = await ctx
        .emailFor(tenantId)
        .then(async (transport) => {
          await transport.send({
            to: body.email,
            subject: "You've been invited to backlex",
            text: `Open ${url} to accept.`,
          });
          return transport.provider !== "console";
        })
        .catch(() => false);
      return c.json({ data: { id, email: body.email, token, url, sent } });
    },
  )
  /** Revoke a pending invite (delete its tenant_members row). Scoped to the
   *  active workspace and to rows still in `invited` state — active members
   *  are removed via the tenants members endpoint instead. */
  .openapi(
    createRoute({
      method: "delete",
      path: "/invite/{memberId}",
      tags: USERS_TAG,
      summary: "Revoke a pending invite",
      description: "Deletes an unaccepted invite. Active members are unaffected.",
      security: SECURITY,
      middleware: [requireUser, requireAdminMw],
      request: { params: z.object({ memberId: z.string() }) },
      responses: {
        200: { description: "Revoked", content: { "application/json": { schema: OkSchema } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const { memberId } = c.req.valid("param");
      const t = tableFor(ctx.dialect);
      const rows = (await (ctx.db as any)
        .select({ id: t.tenantMembers.id, status: t.tenantMembers.status })
        .from(t.tenantMembers)
        .where(
          and(
            eq(t.tenantMembers.id, memberId),
            eq(t.tenantMembers.tenantId, tenantId),
          ),
        )
        .limit(1)) as { id: string; status: string }[];
      if (!rows[0]) throw new AppError("NOT_FOUND", "Invite not found");
      if (rows[0].status !== "invited")
        throw new AppError("VALIDATION", "Not a pending invite");
      await (ctx.db as any)
        .delete(t.tenantMembers)
        .where(eq(t.tenantMembers.id, memberId));
      return c.json({ ok: true });
    },
  )
  /** Suspend the user's membership in the active tenant. The global user
   *  record is left untouched — they may still belong to other workspaces.
   *  Global sessions are revoked because better-auth's session table isn't
   *  tenant-aware; the user can sign back in but won't see this workspace. */
  .openapi(
    createRoute({
      method: "patch",
      path: "/{id}/suspend",
      tags: USERS_TAG,
      summary: "Suspend a user",
      description:
        "Marks the workspace membership suspended and revokes the user's global sessions.",
      security: SECURITY,
      middleware: [requireUser, requireAdminMw],
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "Suspended",
          content: { "application/json": { schema: OkSchema } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const t = tableFor(ctx.dialect);
      const { id } = c.req.valid("param");
      await assertTenantMember(ctx, tenantId, id);
      await (ctx.db as any)
        .update(t.tenantMembers)
        .set({
          status: "suspended",
          updatedAt: ctx.dialect === "pg" ? new Date() : Date.now(),
        })
        .where(
          and(
            eq(t.tenantMembers.tenantId, tenantId),
            eq(t.tenantMembers.userId, id),
          ),
        );
      await (ctx.db as any).delete(t.sessions).where(eq(t.sessions.userId, id));
      // Suspension is only effective if the per-isolate auth caches drop the
      // user's now-stale membership + role bundle; otherwise re-login would
      // resolve their old roles for up to the cache TTL.
      invalidateTenantMembership(tenantId);
      invalidateUserRoles(tenantId, id);
      // Personal API keys carry the owner's identity; cascade-revoke them so a
      // suspended user can't keep authenticating with a machine key.
      await (ctx.db as any)
        .update(t.apiKeys)
        .set({ revokedAt: ctx.dialect === "pg" ? new Date() : Date.now() })
        .where(
          and(
            eq(t.apiKeys.tenantId, tenantId),
            eq(t.apiKeys.userId, id),
            isNull(t.apiKeys.revokedAt),
          ),
        );
      return c.json({ ok: true });
    },
  )
  /** Re-enable a suspended membership in the active tenant. */
  .openapi(
    createRoute({
      method: "patch",
      path: "/{id}/activate",
      tags: USERS_TAG,
      summary: "Reactivate a user",
      description: "Re-enables a suspended workspace membership.",
      security: SECURITY,
      middleware: [requireUser, requireAdminMw],
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "Activated",
          content: { "application/json": { schema: OkSchema } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const t = tableFor(ctx.dialect);
      const { id } = c.req.valid("param");
      await assertTenantMember(ctx, tenantId, id);
      await (ctx.db as any)
        .update(t.tenantMembers)
        .set({
          status: "active",
          updatedAt: ctx.dialect === "pg" ? new Date() : Date.now(),
        })
        .where(
          and(
            eq(t.tenantMembers.tenantId, tenantId),
            eq(t.tenantMembers.userId, id),
          ),
        );
      // Mirror the suspend path: drop the stale "suspended → no roles" cache
      // entries so the reactivated user regains access without waiting out the
      // TTL. (Their API keys stay revoked — re-issue is a deliberate step.)
      invalidateTenantMembership(tenantId);
      invalidateUserRoles(tenantId, id);
      return c.json({ ok: true });
    },
  )
  /** Force-revoke every session for a user. Sessions are global so this
   *  signs the user out of every workspace they belong to — gated on the
   *  user being a member of the active tenant so a tenant admin can't
   *  reach into unrelated users. */
  .openapi(
    createRoute({
      method: "post",
      path: "/{id}/sessions/revoke-all",
      tags: USERS_TAG,
      summary: "Revoke all user sessions",
      description:
        "Drops every better-auth session for the user. Gated on workspace membership.",
      security: SECURITY,
      middleware: [requireUser, requireAdminMw],
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "Revoked",
          content: { "application/json": { schema: OkSchema } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const t = tableFor(ctx.dialect);
      const { id } = c.req.valid("param");
      await assertTenantMember(ctx, tenantId, id);
      await (ctx.db as any).delete(t.sessions).where(eq(t.sessions.userId, id));
      return c.json({ ok: true });
    },
  )
  /** Reset a user's two-factor (TOTP) enrolment — for when they've lost both
   *  their authenticator and backup codes and can't get past the OTP prompt.
   *  Deletes the secret + backup codes, clears the `two_factor_enabled` flag,
   *  and force-revokes every session so the next sign-in is a clean slate.
   *  Gated on workspace membership so a tenant admin can't reach unrelated
   *  users. The user can re-enrol from Account → Security afterwards. */
  .openapi(
    createRoute({
      method: "post",
      path: "/{id}/reset-two-factor",
      tags: USERS_TAG,
      summary: "Reset a user's two-factor auth",
      description:
        "Removes the user's TOTP secret + backup codes and clears the 2FA flag, then revokes their sessions. Use to recover a user locked out of 2FA. Gated on workspace membership.",
      security: SECURITY,
      middleware: [requireUser, requireAdminMw],
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "Reset",
          content: { "application/json": { schema: OkSchema } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const t = tableFor(ctx.dialect);
      const { id } = c.req.valid("param");
      await assertTenantMember(ctx, tenantId, id);
      // Drop the enrolment row(s), clear the flag, and sign the user out
      // everywhere so a stale 2FA-gated session can't linger.
      await (ctx.db as any)
        .delete(t.twoFactors)
        .where(eq(t.twoFactors.userId, id));
      await (ctx.db as any)
        .update(t.users)
        .set({ twoFactorEnabled: false })
        .where(eq(t.users.id, id));
      await (ctx.db as any).delete(t.sessions).where(eq(t.sessions.userId, id));
      return c.json({ ok: true });
    },
  )
  /** Update the user's display name. The global user record is shared, but
   *  the write is gated on the user being a member of the active tenant so a
   *  tenant admin can't rename users outside their workspace. */
  .openapi(
    createRoute({
      method: "patch",
      path: "/{id}",
      tags: USERS_TAG,
      summary: "Update a user",
      description:
        "Updates the user's display name. Gated on workspace membership.",
      security: SECURITY,
      middleware: [requireUser, requireAdminMw],
      request: {
        params: z.object({ id: z.string() }),
        body: {
          required: true,
          content: { "application/json": { schema: UserUpdateInput } },
        },
      },
      responses: {
        200: {
          description: "Updated",
          content: { "application/json": { schema: OkSchema } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const t = tableFor(ctx.dialect);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      await assertTenantMember(ctx, tenantId, id);
      await (ctx.db as any)
        .update(t.users)
        .set({
          name: body.name,
          updatedAt: ctx.dialect === "pg" ? new Date() : Date.now(),
        })
        .where(eq(t.users.id, id));
      return c.json({ ok: true });
    },
  )
  /** List the user's better-auth sessions, newest first. Gated on the user
   *  being a member of the active tenant. */
  .openapi(
    createRoute({
      method: "get",
      path: "/{id}/sessions",
      tags: USERS_TAG,
      summary: "List a user's sessions",
      description:
        "Active better-auth sessions for the user, newest first. Gated on workspace membership.",
      security: SECURITY,
      middleware: [requireUser, requireAdminMw],
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": { schema: z.object({ data: z.array(SessionRow) }) },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const t = tableFor(ctx.dialect);
      const { id } = c.req.valid("param");
      await assertTenantMember(ctx, tenantId, id);
      const rows = (await (ctx.db as any)
        .select({
          id: t.sessions.id,
          userAgent: t.sessions.userAgent,
          ipAddress: t.sessions.ipAddress,
          createdAt: t.sessions.createdAt,
          updatedAt: t.sessions.updatedAt,
        })
        .from(t.sessions)
        .where(eq(t.sessions.userId, id))
        .orderBy(desc(t.sessions.createdAt))) as Array<Record<string, unknown>>;
      const ms = (v: unknown): number | null =>
        v == null ? null : typeof v === "number" ? v : new Date(v as string).getTime();
      return c.json({
        data: rows.map((s) => ({
          id: String(s.id),
          userAgent: (s.userAgent as string | null) ?? null,
          ipAddress: (s.ipAddress as string | null) ?? null,
          createdAt: ms(s.createdAt),
          updatedAt: ms(s.updatedAt),
        })),
      });
    },
  )
  /** Revoke a single session by id. Gated on workspace membership. */
  .openapi(
    createRoute({
      method: "delete",
      path: "/{id}/sessions/{sessionId}",
      tags: USERS_TAG,
      summary: "Revoke one user session",
      description:
        "Deletes a single better-auth session. Gated on workspace membership.",
      security: SECURITY,
      middleware: [requireUser, requireAdminMw],
      request: { params: z.object({ id: z.string(), sessionId: z.string() }) },
      responses: {
        200: {
          description: "Revoked",
          content: { "application/json": { schema: OkSchema } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const t = tableFor(ctx.dialect);
      const { id, sessionId } = c.req.valid("param");
      await assertTenantMember(ctx, tenantId, id);
      await (ctx.db as any)
        .delete(t.sessions)
        .where(and(eq(t.sessions.id, sessionId), eq(t.sessions.userId, id)));
      return c.json({ ok: true });
    },
  )
  /** Remove the user from the active tenant. The global user record is
   *  preserved — they keep access to any other workspaces they belong to.
   *  Role assignments in this tenant are dropped along the way. */
  .openapi(
    createRoute({
      method: "delete",
      path: "/{id}",
      tags: USERS_TAG,
      summary: "Remove from workspace",
      description:
        "Removes the user from the active workspace; the global user record is preserved.",
      security: SECURITY,
      middleware: [requireUser, requireAdminMw],
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "Removed",
          content: { "application/json": { schema: OkSchema } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const t = tableFor(ctx.dialect);
      const { id } = c.req.valid("param");
      await assertTenantMember(ctx, tenantId, id);
      // Drop role assignments that point at tenant-scoped roles (other
      // tenants' assignments must survive).
      const roleIds = (await (ctx.db as any)
        .select({ id: t.roles.id })
        .from(t.roles)
        .where(eq(t.roles.tenantId, tenantId))) as { id: string }[];
      if (roleIds.length) {
        await (ctx.db as any)
          .delete(t.userRoles)
          .where(
            and(
              eq(t.userRoles.userId, id),
              inArray(
                t.userRoles.roleId,
                roleIds.map((r) => r.id),
              ),
            ),
          );
      }
      await (ctx.db as any)
        .delete(t.tenantMembers)
        .where(
          and(
            eq(t.tenantMembers.tenantId, tenantId),
            eq(t.tenantMembers.userId, id),
          ),
        );
      invalidateUserRoles(tenantId, id);
      invalidateTenantMembership(tenantId);
      return c.json({ ok: true });
    },
  );
