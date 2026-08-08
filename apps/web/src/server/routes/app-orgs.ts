import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { AppError, SYSTEM_ROLES } from "@backlex/core";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { SECURITY, OkSchema, errorResponses } from "../lib/openapi";
import { defaultHook } from "../lib/openapi-router";
import {
  addMember,
  createOrg,
  createOrgInvite,
  deleteOrg,
  listInvites,
  listMembers,
  listOrgs,
  removeMember,
  requireOrg,
  revokeOrgInvite,
  updateMember,
  updateOrg,
} from "../services/app-orgs";

/**
 * Control-plane administration of app-plane organizations. Admin-only and
 * scoped to the active workspace — the operator's view of the teams their
 * customers have formed.
 *
 * The end-user-facing half (create your own org, invite a colleague, switch
 * which org you're acting in) lives in `routes/app-orgs-public.ts` under
 * `/api/t/{slug}/orgs`. Both call the same service, so the guards can't be
 * bypassed by picking a surface.
 */

const requireAdmin: MiddlewareHandler<AppBindings> = async (c, next) => {
  const auth = c.get("auth");
  if (!auth.roles.includes(SYSTEM_ROLES.admin))
    throw new AppError("FORBIDDEN", "Admin role required");
  await next();
};

/** Active workspace or bust — every route here is tenant-scoped. */
const activeTenant = (c: { get: (k: "auth") => { tenantId?: string | null } }): string => {
  const tenantId = c.get("auth").tenantId;
  if (!tenantId) throw new AppError("VALIDATION", "No active workspace");
  return tenantId;
};

const TAG = "app-orgs";

export const OrgRoleSchema = z.enum(["owner", "admin", "member"]);

const _OrgRow = z
  .object({
    id: z.string(),
    slug: z.string(),
    name: z.string(),
    image: z.string().nullable(),
    metadata: z.record(z.string(), z.unknown()).nullable(),
    createdBy: z.string().nullable(),
    createdAt: z.number().nullable(),
    updatedAt: z.number().nullable(),
    memberCount: z.number(),
  })
  .openapi("AppOrgRow");

const CreateOrgInput = z
  .object({
    name: z.string().trim().min(1).max(200),
    /** Optional explicit handle; derived from `name` (and auto-suffixed on
     *  collision) when omitted. An explicit one that's taken is a CONFLICT. */
    slug: z.string().trim().min(1).max(60).optional(),
    image: z.string().max(2000).nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).nullable().optional(),
    /** End-user who becomes the first owner. Omit for an empty org. */
    ownerAppUserId: z.string().min(1).optional(),
  })
  .openapi("AppOrgCreateInput");

const UpdateOrgInput = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    slug: z.string().trim().min(1).max(60).optional(),
    image: z.string().max(2000).nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .openapi("AppOrgUpdateInput");

const AddMemberInput = z
  .object({
    appUserId: z.string().min(1),
    role: OrgRoleSchema.optional(),
    /** Org-scoped workspace roles. Same rules as the workspace-wide grant:
     *  must belong to this workspace, and the admin role is rejected. */
    roleIds: z.array(z.string().min(1)).max(50).optional(),
  })
  .openapi("AppOrgAddMemberInput");

const UpdateMemberInput = z
  .object({
    role: OrgRoleSchema.optional(),
    roleIds: z.array(z.string().min(1)).max(50).optional(),
  })
  .openapi("AppOrgUpdateMemberInput");

const InviteInput = z
  .object({
    email: z.string().email(),
    role: OrgRoleSchema.optional(),
    roleIds: z.array(z.string().min(1)).max(50).optional(),
  })
  .openapi("AppOrgInviteInput");

const jsonOk = (schema: z.ZodTypeAny) => ({
  200: {
    description: "OK",
    content: { "application/json": { schema } },
  },
  ...errorResponses,
});

export const appOrgsRoutes = new OpenAPIHono<AppBindings>({ defaultHook })
  .openapi(
    createRoute({
      method: "get",
      path: "/",
      tags: [TAG],
      summary: "List organizations",
      description:
        "Every `app_orgs` row in the active workspace with its member count. `q` filters by name/slug substring (case-insensitive).",
      security: SECURITY,
      middleware: [requireUser, requireAdmin],
      request: { query: z.object({ q: z.string().trim().max(200).optional() }) },
      responses: jsonOk(z.object({ data: z.array(z.any()) })),
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = c.get("auth").tenantId;
      if (!tenantId) return c.json({ data: [] });
      const { q } = c.req.valid("query");
      const data = await listOrgs({ db: ctx.db, dialect: ctx.dialect }, tenantId, {
        ...(q ? { q } : {}),
      });
      return c.json({ data });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/",
      tags: [TAG],
      summary: "Create an organization",
      description:
        "Creates an org in the active workspace. `ownerAppUserId` seeds the first `owner` member; omitting it leaves the org empty for members to be added explicitly.",
      security: SECURITY,
      middleware: [requireUser, requireAdmin],
      request: {
        body: { required: true, content: { "application/json": { schema: CreateOrgInput } } },
      },
      responses: {
        201: {
          description: "Created",
          content: { "application/json": { schema: z.object({ data: z.any() }) } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = activeTenant(c);
      const body = c.req.valid("json");
      const org = await createOrg({ db: ctx.db, dialect: ctx.dialect }, tenantId, body);
      return c.json({ data: org }, 201);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/{id}",
      tags: [TAG],
      summary: "Get an organization",
      description: "Resolves by id **or** slug within the active workspace.",
      security: SECURITY,
      middleware: [requireUser, requireAdmin],
      request: { params: z.object({ id: z.string() }) },
      responses: jsonOk(z.object({ data: z.any() })),
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = activeTenant(c);
      const { id } = c.req.valid("param");
      const org = await requireOrg({ db: ctx.db, dialect: ctx.dialect }, tenantId, id);
      return c.json({ data: org });
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/{id}",
      tags: [TAG],
      summary: "Update an organization",
      description: "Rename, re-slug, or set the image/metadata. A taken slug is a CONFLICT.",
      security: SECURITY,
      middleware: [requireUser, requireAdmin],
      request: {
        params: z.object({ id: z.string() }),
        body: { required: true, content: { "application/json": { schema: UpdateOrgInput } } },
      },
      responses: jsonOk(z.object({ data: z.any() })),
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = activeTenant(c);
      const { id } = c.req.valid("param");
      const org = await updateOrg(
        { db: ctx.db, dialect: ctx.dialect },
        tenantId,
        id,
        c.req.valid("json"),
      );
      return c.json({ data: org });
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/{id}",
      tags: [TAG],
      summary: "Delete an organization",
      description:
        "Drops the org plus its memberships, org-scoped role bindings and invitations. Sessions pinned to it fall back to no active org.",
      security: SECURITY,
      middleware: [requireUser, requireAdmin],
      request: { params: z.object({ id: z.string() }) },
      responses: jsonOk(OkSchema),
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = activeTenant(c);
      const { id } = c.req.valid("param");
      await deleteOrg({ db: ctx.db, dialect: ctx.dialect }, tenantId, id);
      return c.json({ ok: true });
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/{id}/members",
      tags: [TAG],
      summary: "List organization members",
      description:
        "Members with their membership role (owner/admin/member) and their org-scoped workspace roles.",
      security: SECURITY,
      middleware: [requireUser, requireAdmin],
      request: { params: z.object({ id: z.string() }) },
      responses: jsonOk(z.object({ data: z.array(z.any()) })),
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = activeTenant(c);
      const { id } = c.req.valid("param");
      const org = await requireOrg({ db: ctx.db, dialect: ctx.dialect }, tenantId, id);
      const data = await listMembers({ db: ctx.db, dialect: ctx.dialect }, tenantId, org.id);
      return c.json({ data });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/{id}/members",
      tags: [TAG],
      summary: "Add a member",
      description:
        "Adds an existing workspace end-user to the org, optionally with a membership role and org-scoped workspace roles.",
      security: SECURITY,
      middleware: [requireUser, requireAdmin],
      request: {
        params: z.object({ id: z.string() }),
        body: { required: true, content: { "application/json": { schema: AddMemberInput } } },
      },
      responses: {
        201: {
          description: "Added",
          content: { "application/json": { schema: z.object({ data: z.any() }) } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = activeTenant(c);
      const { id } = c.req.valid("param");
      const org = await requireOrg({ db: ctx.db, dialect: ctx.dialect }, tenantId, id);
      const member = await addMember(
        { db: ctx.db, dialect: ctx.dialect },
        tenantId,
        org.id,
        c.req.valid("json"),
      );
      return c.json({ data: member }, 201);
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/{id}/members/{appUserId}",
      tags: [TAG],
      summary: "Update a member",
      description:
        "Change the membership role and/or replace the member's org-scoped workspace roles. Demoting the last owner is rejected.",
      security: SECURITY,
      middleware: [requireUser, requireAdmin],
      request: {
        params: z.object({ id: z.string(), appUserId: z.string() }),
        body: { required: true, content: { "application/json": { schema: UpdateMemberInput } } },
      },
      responses: jsonOk(z.object({ data: z.any() })),
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = activeTenant(c);
      const { id, appUserId } = c.req.valid("param");
      const org = await requireOrg({ db: ctx.db, dialect: ctx.dialect }, tenantId, id);
      const member = await updateMember(
        { db: ctx.db, dialect: ctx.dialect },
        tenantId,
        org.id,
        appUserId,
        c.req.valid("json"),
        // Control plane: an operator administering a customer's org holds no
        // membership row and is outside the org's rank order.
        null,
      );
      return c.json({ data: member });
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/{id}/members/{appUserId}",
      tags: [TAG],
      summary: "Remove a member",
      description:
        "Removes the membership and its org-scoped role bindings. Removing the last owner is rejected.",
      security: SECURITY,
      middleware: [requireUser, requireAdmin],
      request: { params: z.object({ id: z.string(), appUserId: z.string() }) },
      responses: jsonOk(OkSchema),
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = activeTenant(c);
      const { id, appUserId } = c.req.valid("param");
      const org = await requireOrg({ db: ctx.db, dialect: ctx.dialect }, tenantId, id);
      // `null` actor — the control plane sits outside the org's rank order.
      await removeMember({ db: ctx.db, dialect: ctx.dialect }, tenantId, org.id, appUserId, null);
      return c.json({ ok: true });
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/{id}/invites",
      tags: [TAG],
      summary: "List organization invitations",
      description:
        "Newest first. `pending=true` narrows to invitations that are neither accepted nor expired.",
      security: SECURITY,
      middleware: [requireUser, requireAdmin],
      request: {
        params: z.object({ id: z.string() }),
        query: z.object({ pending: z.enum(["true", "false"]).optional() }),
      },
      responses: jsonOk(z.object({ data: z.array(z.any()) })),
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = activeTenant(c);
      const { id } = c.req.valid("param");
      const { pending } = c.req.valid("query");
      const org = await requireOrg({ db: ctx.db, dialect: ctx.dialect }, tenantId, id);
      const data = await listInvites(
        { db: ctx.db, dialect: ctx.dialect },
        tenantId,
        org.id,
        { pendingOnly: pending === "true" },
      );
      return c.json({ data });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/{id}/invites",
      tags: [TAG],
      summary: "Invite someone to an organization",
      description:
        "Mints a 7-day invitation and best-effort mails it. The invitee accepts, already signed in, via `POST /api/t/{slug}/orgs/invites/accept`. Their account email must match the invited address.",
      security: SECURITY,
      middleware: [requireUser, requireAdmin],
      request: {
        params: z.object({ id: z.string() }),
        body: { required: true, content: { "application/json": { schema: InviteInput } } },
      },
      responses: {
        201: {
          description: "Invitation created",
          content: {
            "application/json": {
              schema: z.object({
                data: z.object({
                  id: z.string(),
                  email: z.string(),
                  role: OrgRoleSchema,
                  token: z.string(),
                  expiresAt: z.number(),
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
      const tenantId = activeTenant(c);
      const { id } = c.req.valid("param");
      const org = await requireOrg({ db: ctx.db, dialect: ctx.dialect }, tenantId, id);
      const invite = await createOrgInvite(ctx, tenantId, org.id, c.req.valid("json"));
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
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/{id}/invites/{inviteId}",
      tags: [TAG],
      summary: "Revoke an invitation",
      description: "Deletes the invitation row so its token stops working.",
      security: SECURITY,
      middleware: [requireUser, requireAdmin],
      request: { params: z.object({ id: z.string(), inviteId: z.string() }) },
      responses: jsonOk(OkSchema),
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = activeTenant(c);
      const { id, inviteId } = c.req.valid("param");
      const org = await requireOrg({ db: ctx.db, dialect: ctx.dialect }, tenantId, id);
      await revokeOrgInvite({ db: ctx.db, dialect: ctx.dialect }, tenantId, org.id, inviteId);
      return c.json({ ok: true });
    },
  );
