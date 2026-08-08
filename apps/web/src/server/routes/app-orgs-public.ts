import { Hono, type Context } from "hono";
import { AppError } from "@backlex/core";
import type { AppBindings } from "../app";
import { findTenantBySlugOrId } from "../services/tenant-auth";
import {
  acceptOrgInvite,
  createOrg,
  createOrgInvite,
  deleteOrg,
  leaveOrg,
  listInvites,
  listMembers,
  listOrgs,
  removeMember,
  requireOrg,
  requireOrgRole,
  revokeOrgInvite,
  setActiveOrg,
  updateMember,
  updateOrg,
} from "../services/app-orgs";

/**
 * End-user-facing organization surface, mounted at `/api/t/:slug/orgs`.
 *
 * This is the half a workspace's own application calls: list the orgs I belong
 * to, start a new one, invite a colleague, switch which org I'm acting in.
 * Everything is authenticated as an **app-plane** identity (the bearer token or
 * cookie issued by `/api/t/:slug/auth/*`) — a control-plane admin session is
 * deliberately NOT accepted here; admins use `/api/app-orgs` instead, which is
 * the same service behind an admin gate.
 *
 * Authorization inside an org is the membership role: `admin` may invite and
 * manage members, `owner` may additionally rename and delete. Nothing here can
 * grant a workspace `admin` role — `resolveAssignableRoles` rejects it on every
 * path that binds org-scoped roles.
 */

/** The signed-in end-user, or 401. Also pins the request to the workspace named
 *  in the path: the session already carries its own tenant, so a mismatched
 *  slug means the caller is pointing a token at the wrong workspace. */
const requireAppUser = async (
  c: Context<AppBindings>,
): Promise<{ tenantId: string; appUserId: string }> => {
  const auth = c.get("auth");
  if (auth.plane !== "app" || !auth.userId)
    throw new AppError("UNAUTHORIZED", "Workspace end-user sign-in required");
  const tenantId = auth.tenantId;
  if (!tenantId) throw new AppError("UNAUTHORIZED", "Session is not bound to a workspace");

  const ctx = c.get("ctx");
  const slug = c.req.param("slug");
  const tenant = slug
    ? await findTenantBySlugOrId({ db: ctx.db, dialect: ctx.dialect }, slug)
    : null;
  if (!tenant) throw new AppError("NOT_FOUND", `Workspace "${slug ?? ""}" not found`);
  if (tenant.id !== tenantId)
    throw new AppError("FORBIDDEN", "Session belongs to a different workspace");
  return { tenantId, appUserId: auth.userId };
};

const dbCtx = (c: Context<AppBindings>) => {
  const ctx = c.get("ctx");
  return { db: ctx.db, dialect: ctx.dialect };
};

/** Parse a JSON body, tolerating a bodyless POST (which arrives with no
 *  content-type and would otherwise throw inside `c.req.json()`). */
const body = async <T,>(c: Context<AppBindings>): Promise<Partial<T>> => {
  try {
    return ((await c.req.json()) ?? {}) as Partial<T>;
  } catch {
    return {};
  }
};

const asRole = (v: unknown): "owner" | "admin" | "member" | undefined =>
  v === "owner" || v === "admin" || v === "member" ? v : undefined;

const asStringArray = (v: unknown): string[] | undefined =>
  Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : undefined;

export const appOrgsPublicRoutes = new Hono<AppBindings>()
  /** Orgs I belong to, with my membership role and each org's member count. */
  .get("/:slug/orgs", async (c) => {
    const { tenantId, appUserId } = await requireAppUser(c);
    const q = c.req.query("q");
    const data = await listOrgs(dbCtx(c), tenantId, {
      appUserId,
      ...(q ? { q } : {}),
    });
    return c.json({
      data,
      // Echo what the permission DSL will see this request as, so a client can
      // render "acting as <org>" without a second round-trip.
      active: { orgId: c.get("auth").orgId ?? null, role: c.get("auth").orgRole ?? null },
    });
  })

  /**
   * Start a new org. The creator becomes its first `owner` — an org with no
   * owner would be unadministerable, and self-serve creation is the whole
   * point of this endpoint.
   */
  .post("/:slug/orgs", async (c) => {
    const { tenantId, appUserId } = await requireAppUser(c);
    const input = await body<{
      name: string;
      slug?: string;
      image?: string | null;
      metadata?: Record<string, unknown> | null;
    }>(c);
    if (typeof input.name !== "string" || !input.name.trim())
      throw new AppError("VALIDATION", "Organization name is required");
    const org = await createOrg(dbCtx(c), tenantId, {
      name: input.name,
      ...(input.slug ? { slug: input.slug } : {}),
      ...(input.image !== undefined ? { image: input.image } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      ownerAppUserId: appUserId,
    });
    return c.json({ data: { ...org, role: "owner", memberCount: 1 } }, 201);
  })

  /**
   * Accept an invitation. Registered before `/:slug/orgs/:orgId` so the literal
   * `invites` segment isn't swallowed by the param route.
   */
  .post("/:slug/orgs/invites/accept", async (c) => {
    const { tenantId, appUserId } = await requireAppUser(c);
    const input = await body<{ token: string }>(c);
    if (typeof input.token !== "string" || !input.token)
      throw new AppError("VALIDATION", "An invitation token is required");
    const result = await acceptOrgInvite(dbCtx(c), tenantId, input.token, appUserId);
    return c.json({ data: { org: result.org, role: result.role } });
  })

  /** One org I belong to. */
  .get("/:slug/orgs/:orgId", async (c) => {
    const { tenantId, appUserId } = await requireAppUser(c);
    const org = await requireOrg(dbCtx(c), tenantId, c.req.param("orgId"));
    const role = await requireOrgRole(dbCtx(c), org.id, appUserId, "member");
    return c.json({ data: { ...org, role } });
  })

  /** Rename / re-slug / restyle. Owners only. */
  .patch("/:slug/orgs/:orgId", async (c) => {
    const { tenantId, appUserId } = await requireAppUser(c);
    const org = await requireOrg(dbCtx(c), tenantId, c.req.param("orgId"));
    await requireOrgRole(dbCtx(c), org.id, appUserId, "owner");
    const patch = await body<{
      name?: string;
      slug?: string;
      image?: string | null;
      metadata?: Record<string, unknown> | null;
    }>(c);
    const updated = await updateOrg(dbCtx(c), tenantId, org.id, patch);
    return c.json({ data: updated });
  })

  /** Delete the org. Owners only, and irreversible. */
  .delete("/:slug/orgs/:orgId", async (c) => {
    const { tenantId, appUserId } = await requireAppUser(c);
    const org = await requireOrg(dbCtx(c), tenantId, c.req.param("orgId"));
    await requireOrgRole(dbCtx(c), org.id, appUserId, "owner");
    await deleteOrg(dbCtx(c), tenantId, org.id);
    return c.json({ ok: true });
  })

  /**
   * Pin this session to an org (`{ "orgId": null }` clears it). Only meaningful
   * for multi-org end-users — a single-org one resolves to their sole
   * membership automatically. Stateless-JWT clients can skip this and send
   * `X-Backlex-Org` per request instead.
   *
   * Registered before `/:slug/orgs/:orgId` so the literal segment wins.
   */
  .post("/:slug/orgs/set-active", async (c) => {
    const { tenantId, appUserId } = await requireAppUser(c);
    const appSessionId = c.get("auth").appSessionId;
    if (!appSessionId)
      throw new AppError(
        "VALIDATION",
        "This session can't pin an organization — send the X-Backlex-Org header instead",
      );
    const input = await body<{ orgId: string | null }>(c);
    const orgId = input.orgId ?? null;
    if (orgId !== null && typeof orgId !== "string")
      throw new AppError("VALIDATION", "orgId must be an organization id, slug, or null");
    const org = await setActiveOrg(dbCtx(c), tenantId, appSessionId, appUserId, orgId);
    return c.json({ data: org });
  })

  /** Leave an org. The last owner has to hand over first. */
  .post("/:slug/orgs/:orgId/leave", async (c) => {
    const { tenantId, appUserId } = await requireAppUser(c);
    const org = await requireOrg(dbCtx(c), tenantId, c.req.param("orgId"));
    const role = await requireOrgRole(dbCtx(c), org.id, appUserId, "member");
    await leaveOrg(dbCtx(c), tenantId, org.id, appUserId, role);
    return c.json({ ok: true });
  })

  /** Who else is in here. Any member may look. */
  .get("/:slug/orgs/:orgId/members", async (c) => {
    const { tenantId, appUserId } = await requireAppUser(c);
    const org = await requireOrg(dbCtx(c), tenantId, c.req.param("orgId"));
    await requireOrgRole(dbCtx(c), org.id, appUserId, "member");
    const data = await listMembers(dbCtx(c), tenantId, org.id);
    return c.json({ data });
  })

  /**
   * Change someone's membership role, or replace their org-scoped workspace
   * roles. Org admins may do both — but only an owner can mint another owner,
   * and nobody can act on a member who outranks them, so an admin can neither
   * promote themselves past their own ceiling nor depose the owner above it.
   */
  .patch("/:slug/orgs/:orgId/members/:appUserId", async (c) => {
    const { tenantId, appUserId: actorId } = await requireAppUser(c);
    const org = await requireOrg(dbCtx(c), tenantId, c.req.param("orgId"));
    const actorRole = await requireOrgRole(dbCtx(c), org.id, actorId, "admin");
    const patch = await body<{ role?: string; roleIds?: string[] }>(c);
    const role = asRole(patch.role);
    if (patch.role !== undefined && !role)
      throw new AppError("VALIDATION", "role must be one of: owner, admin, member");
    const roleIds = asStringArray(patch.roleIds);
    if (patch.roleIds !== undefined && !roleIds)
      throw new AppError("VALIDATION", "roleIds must be an array of role ids");
    // The rank guards (can't mint an owner unless you are one, can't act on
    // someone above you) live in the service so every surface inherits them.
    const member = await updateMember(
      dbCtx(c),
      tenantId,
      org.id,
      c.req.param("appUserId"),
      {
        ...(role ? { role } : {}),
        ...(roleIds ? { roleIds } : {}),
      },
      { appUserId: actorId, role: actorRole },
    );
    return c.json({ data: member });
  })

  /** Remove someone. Org admins may — but never someone who outranks them, and
   *  the last owner can't be removed at all. */
  .delete("/:slug/orgs/:orgId/members/:appUserId", async (c) => {
    const { tenantId, appUserId: actorId } = await requireAppUser(c);
    const org = await requireOrg(dbCtx(c), tenantId, c.req.param("orgId"));
    const actorRole = await requireOrgRole(dbCtx(c), org.id, actorId, "admin");
    await removeMember(dbCtx(c), tenantId, org.id, c.req.param("appUserId"), {
      appUserId: actorId,
      role: actorRole,
    });
    return c.json({ ok: true });
  })

  /** Pending + accepted invitations for this org. */
  .get("/:slug/orgs/:orgId/invites", async (c) => {
    const { tenantId, appUserId } = await requireAppUser(c);
    const org = await requireOrg(dbCtx(c), tenantId, c.req.param("orgId"));
    await requireOrgRole(dbCtx(c), org.id, appUserId, "admin");
    // `OrgInviteRow` carries no `token` on purpose: the raw token is write-only,
    // handed back once by the create call and mailed to the invitee. Listing it
    // would let any org admin replay somebody else's invitation link.
    const data = await listInvites(dbCtx(c), tenantId, org.id, {
      pendingOnly: c.req.query("pending") === "true",
    });
    return c.json({ data });
  })

  /** Invite a colleague by email. Org admins may. */
  .post("/:slug/orgs/:orgId/invites", async (c) => {
    const { tenantId, appUserId } = await requireAppUser(c);
    const ctx = c.get("ctx");
    const org = await requireOrg(dbCtx(c), tenantId, c.req.param("orgId"));
    const actorRole = await requireOrgRole(dbCtx(c), org.id, appUserId, "admin");
    const input = await body<{ email: string; role?: string; roleIds?: string[] }>(c);
    if (typeof input.email !== "string" || !input.email.includes("@"))
      throw new AppError("VALIDATION", "A valid email is required");
    const role = asRole(input.role);
    if (input.role !== undefined && !role)
      throw new AppError("VALIDATION", "role must be one of: owner, admin, member");
    if (role === "owner" && actorRole !== "owner")
      throw new AppError("FORBIDDEN", "Only an owner can invite another owner");
    const roleIds = asStringArray(input.roleIds);
    if (input.roleIds !== undefined && !roleIds)
      throw new AppError("VALIDATION", "roleIds must be an array of role ids");
    const invite = await createOrgInvite(ctx, tenantId, org.id, {
      email: input.email,
      ...(role ? { role } : {}),
      ...(roleIds ? { roleIds } : {}),
      invitedBy: appUserId,
    });
    return c.json(
      {
        data: {
          id: invite.id,
          email: invite.email,
          role: invite.role,
          token: invite.token,
          expiresAt: invite.expiresAt.getTime(),
        },
      },
      201,
    );
  })

  /** Revoke a pending invitation. */
  .delete("/:slug/orgs/:orgId/invites/:inviteId", async (c) => {
    const { tenantId, appUserId } = await requireAppUser(c);
    const org = await requireOrg(dbCtx(c), tenantId, c.req.param("orgId"));
    await requireOrgRole(dbCtx(c), org.id, appUserId, "admin");
    await revokeOrgInvite(dbCtx(c), tenantId, org.id, c.req.param("inviteId"));
    return c.json({ ok: true });
  });
