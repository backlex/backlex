import { type GqlCtx } from "./core";
import {
  GraphQLBoolean,
  GraphQLError,
  GraphQLFloat,
  GraphQLID,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString,
  type GraphQLFieldConfig,
} from "graphql";
import { AppError, SYSTEM_ROLES } from "@backlex/core";
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
} from "../app-orgs";

// ── App-plane organizations ────────────────────────────────────────────────
// Admin-scoped mirror of REST `/api/app-orgs`, MCP `app_orgs.*` and SDK
// `client.orgs.*`. Static (doesn't vary with tenant schema), so it merges into
// every schema build alongside the app-user fields.
//
// The end-user-facing half (`/api/t/{slug}/orgs`) is deliberately NOT exposed
// here: `/api/graphql` is a control-plane endpoint, and an app-plane identity
// reaching it would still be gated by the admin check below.

const OrgType = new GraphQLObjectType({
  name: "AppOrg",
  description:
    "An organization inside a workspace — the B2B grouping level whose members are `app_users`.",
  fields: {
    id: { type: new GraphQLNonNull(GraphQLID) },
    slug: { type: new GraphQLNonNull(GraphQLString) },
    name: { type: new GraphQLNonNull(GraphQLString) },
    image: { type: GraphQLString },
    createdBy: { type: GraphQLString },
    createdAt: { type: GraphQLFloat },
    updatedAt: { type: GraphQLFloat },
    memberCount: { type: GraphQLInt },
  },
});

const OrgMemberRoleType = new GraphQLObjectType({
  name: "AppOrgMemberRole",
  description: "A workspace role bound to this member within this org.",
  fields: {
    id: { type: new GraphQLNonNull(GraphQLID) },
    name: { type: new GraphQLNonNull(GraphQLString) },
  },
});

const OrgMemberType = new GraphQLObjectType({
  name: "AppOrgMember",
  fields: {
    appUserId: { type: new GraphQLNonNull(GraphQLID) },
    email: { type: new GraphQLNonNull(GraphQLString) },
    name: { type: GraphQLString },
    status: { type: new GraphQLNonNull(GraphQLString) },
    /** owner | admin | member — governs org administration, not data access. */
    role: { type: new GraphQLNonNull(GraphQLString) },
    roles: { type: new GraphQLList(new GraphQLNonNull(OrgMemberRoleType)) },
    createdAt: { type: GraphQLFloat },
  },
});

const OrgInviteType = new GraphQLObjectType({
  name: "AppOrgInvite",
  description:
    "A pending or accepted invitation. The raw token is never returned here — only once, from `inviteToAppOrg`.",
  fields: {
    id: { type: new GraphQLNonNull(GraphQLID) },
    orgId: { type: new GraphQLNonNull(GraphQLID) },
    email: { type: new GraphQLNonNull(GraphQLString) },
    role: { type: new GraphQLNonNull(GraphQLString) },
    roleIds: { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) },
    invitedBy: { type: GraphQLString },
    expiresAt: { type: new GraphQLNonNull(GraphQLFloat) },
    acceptedAt: { type: GraphQLFloat },
    createdAt: { type: GraphQLFloat },
    pending: { type: new GraphQLNonNull(GraphQLBoolean) },
  },
});

const OrgInviteResultType = new GraphQLObjectType({
  name: "AppOrgInviteResult",
  fields: {
    id: { type: new GraphQLNonNull(GraphQLID) },
    email: { type: new GraphQLNonNull(GraphQLString) },
    role: { type: new GraphQLNonNull(GraphQLString) },
    /** Raw one-shot invitation token (also mailed to the invitee). */
    token: { type: new GraphQLNonNull(GraphQLString) },
    expiresAt: { type: new GraphQLNonNull(GraphQLFloat) },
  },
});

const OkType = new GraphQLObjectType({
  name: "AppOrgOk",
  fields: { ok: { type: new GraphQLNonNull(GraphQLBoolean) } },
});

/** Org administration is admin-only on every control-plane surface — mirror
 *  that gate. Returns the active tenant id. */
const requireOrgAdmin = (gqlCtx: GqlCtx): string => {
  const { auth } = gqlCtx;
  if (!auth.roles.includes(SYSTEM_ROLES.admin)) {
    throw new GraphQLError("Admin role required", { extensions: { code: "FORBIDDEN" } });
  }
  if (!auth.tenantId) {
    throw new GraphQLError("Active tenant required", { extensions: { code: "UNAUTHORIZED" } });
  }
  return auth.tenantId;
};

const rethrow = (e: unknown): never => {
  if (e instanceof AppError) {
    throw new GraphQLError(e.message, { extensions: { code: e.code } });
  }
  throw e;
};

const db = (gqlCtx: GqlCtx) => ({
  db: gqlCtx.ctx.db,
  dialect: gqlCtx.ctx.dialect,
});

const asRole = (v: unknown): "owner" | "admin" | "member" | undefined =>
  v === "owner" || v === "admin" || v === "member" ? v : undefined;

export const appOrgQueryFields: Record<string, GraphQLFieldConfig<unknown, GqlCtx>> = {
  appOrgs: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(OrgType))),
    description:
      "Organizations in the active workspace, with member counts. Mirrors REST `GET /api/app-orgs` (admin-only).",
    args: { q: { type: GraphQLString } },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireOrgAdmin(gqlCtx);
      const a = args as { q?: string | null };
      try {
        return await listOrgs(db(gqlCtx), tenantId, { ...(a.q ? { q: a.q } : {}) });
      } catch (e) {
        return rethrow(e);
      }
    },
  },
  appOrg: {
    type: OrgType,
    description: "One organization by id or slug.",
    args: { id: { type: new GraphQLNonNull(GraphQLString) } },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireOrgAdmin(gqlCtx);
      try {
        return await requireOrg(db(gqlCtx), tenantId, (args as { id: string }).id);
      } catch (e) {
        return rethrow(e);
      }
    },
  },
  appOrgMembers: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(OrgMemberType))),
    description:
      "Members of an organization with their membership role and org-scoped workspace roles.",
    args: { orgId: { type: new GraphQLNonNull(GraphQLString) } },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireOrgAdmin(gqlCtx);
      try {
        const org = await requireOrg(db(gqlCtx), tenantId, (args as { orgId: string }).orgId);
        return await listMembers(db(gqlCtx), tenantId, org.id);
      } catch (e) {
        return rethrow(e);
      }
    },
  },
  appOrgInvites: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(OrgInviteType))),
    description: "Invitations for an organization, newest first.",
    args: {
      orgId: { type: new GraphQLNonNull(GraphQLString) },
      pending: { type: GraphQLBoolean },
    },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireOrgAdmin(gqlCtx);
      const a = args as { orgId: string; pending?: boolean | null };
      try {
        const org = await requireOrg(db(gqlCtx), tenantId, a.orgId);
        return await listInvites(db(gqlCtx), tenantId, org.id, {
          pendingOnly: a.pending === true,
        });
      } catch (e) {
        return rethrow(e);
      }
    },
  },
};

export const appOrgMutationFields: Record<string, GraphQLFieldConfig<unknown, GqlCtx>> = {
  createAppOrg: {
    type: new GraphQLNonNull(OrgType),
    description:
      "Create an organization in the active workspace. `ownerAppUserId` seeds the first owner. Mirrors REST `POST /api/app-orgs`.",
    args: {
      name: { type: new GraphQLNonNull(GraphQLString) },
      slug: { type: GraphQLString },
      image: { type: GraphQLString },
      ownerAppUserId: { type: GraphQLString },
    },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireOrgAdmin(gqlCtx);
      const a = args as {
        name: string;
        slug?: string | null;
        image?: string | null;
        ownerAppUserId?: string | null;
      };
      try {
        return await createOrg(db(gqlCtx), tenantId, {
          name: a.name,
          ...(a.slug ? { slug: a.slug } : {}),
          ...(a.image !== undefined ? { image: a.image } : {}),
          ...(a.ownerAppUserId ? { ownerAppUserId: a.ownerAppUserId } : {}),
        });
      } catch (e) {
        return rethrow(e);
      }
    },
  },
  updateAppOrg: {
    type: new GraphQLNonNull(OrgType),
    description: "Rename / re-slug / restyle an organization.",
    args: {
      id: { type: new GraphQLNonNull(GraphQLString) },
      name: { type: GraphQLString },
      slug: { type: GraphQLString },
      image: { type: GraphQLString },
    },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireOrgAdmin(gqlCtx);
      const a = args as {
        id: string;
        name?: string | null;
        slug?: string | null;
        image?: string | null;
      };
      try {
        return await updateOrg(db(gqlCtx), tenantId, a.id, {
          ...(a.name != null ? { name: a.name } : {}),
          ...(a.slug != null ? { slug: a.slug } : {}),
          ...(a.image !== undefined ? { image: a.image } : {}),
        });
      } catch (e) {
        return rethrow(e);
      }
    },
  },
  deleteAppOrg: {
    type: new GraphQLNonNull(OkType),
    description:
      "Delete an organization plus its memberships, org-scoped role bindings and invitations.",
    args: { id: { type: new GraphQLNonNull(GraphQLString) } },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireOrgAdmin(gqlCtx);
      try {
        await deleteOrg(db(gqlCtx), tenantId, (args as { id: string }).id);
        return { ok: true };
      } catch (e) {
        return rethrow(e);
      }
    },
  },
  addAppOrgMember: {
    type: new GraphQLNonNull(OrgMemberType),
    description:
      "Add an existing workspace end-user to an organization, optionally with a membership role and org-scoped workspace roles.",
    args: {
      orgId: { type: new GraphQLNonNull(GraphQLString) },
      appUserId: { type: new GraphQLNonNull(GraphQLString) },
      role: { type: GraphQLString },
      roleIds: { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) },
    },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireOrgAdmin(gqlCtx);
      const a = args as {
        orgId: string;
        appUserId: string;
        role?: string | null;
        roleIds?: string[] | null;
      };
      try {
        const org = await requireOrg(db(gqlCtx), tenantId, a.orgId);
        return await addMember(db(gqlCtx), tenantId, org.id, {
          appUserId: a.appUserId,
          ...(asRole(a.role) ? { role: asRole(a.role)! } : {}),
          ...(a.roleIds ? { roleIds: a.roleIds } : {}),
        });
      } catch (e) {
        return rethrow(e);
      }
    },
  },
  updateAppOrgMember: {
    type: new GraphQLNonNull(OrgMemberType),
    description:
      "Change a member's membership role and/or replace their org-scoped workspace roles. Demoting the last owner is rejected.",
    args: {
      orgId: { type: new GraphQLNonNull(GraphQLString) },
      appUserId: { type: new GraphQLNonNull(GraphQLString) },
      role: { type: GraphQLString },
      roleIds: { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) },
    },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireOrgAdmin(gqlCtx);
      const a = args as {
        orgId: string;
        appUserId: string;
        role?: string | null;
        roleIds?: string[] | null;
      };
      try {
        const org = await requireOrg(db(gqlCtx), tenantId, a.orgId);
        return await updateMember(
          db(gqlCtx),
          tenantId,
          org.id,
          a.appUserId,
          {
            ...(asRole(a.role) ? { role: asRole(a.role)! } : {}),
            ...(a.roleIds ? { roleIds: a.roleIds } : {}),
          },
          // `requireOrgAdmin` above means this is the control plane, which is
          // outside the org's own rank order.
          null,
        );
      } catch (e) {
        return rethrow(e);
      }
    },
  },
  removeAppOrgMember: {
    type: new GraphQLNonNull(OkType),
    description: "Remove a member. Removing the last owner is rejected.",
    args: {
      orgId: { type: new GraphQLNonNull(GraphQLString) },
      appUserId: { type: new GraphQLNonNull(GraphQLString) },
    },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireOrgAdmin(gqlCtx);
      const a = args as { orgId: string; appUserId: string };
      try {
        const org = await requireOrg(db(gqlCtx), tenantId, a.orgId);
        // `null` actor — control plane, outside the org's rank order.
        await removeMember(db(gqlCtx), tenantId, org.id, a.appUserId, null);
        return { ok: true };
      } catch (e) {
        return rethrow(e);
      }
    },
  },
  inviteToAppOrg: {
    type: new GraphQLNonNull(OrgInviteResultType),
    description:
      "Mint a 7-day organization invitation (also mailed best-effort). The invitee accepts, already signed in, via `POST /api/t/{slug}/orgs/invites/accept`; their account email must match the invited address.",
    args: {
      orgId: { type: new GraphQLNonNull(GraphQLString) },
      email: { type: new GraphQLNonNull(GraphQLString) },
      role: { type: GraphQLString },
      roleIds: { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) },
    },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireOrgAdmin(gqlCtx);
      const a = args as {
        orgId: string;
        email: string;
        role?: string | null;
        roleIds?: string[] | null;
      };
      try {
        const org = await requireOrg(db(gqlCtx), tenantId, a.orgId);
        const invite = await createOrgInvite(gqlCtx.ctx, tenantId, org.id, {
          email: a.email,
          ...(asRole(a.role) ? { role: asRole(a.role)! } : {}),
          ...(a.roleIds ? { roleIds: a.roleIds } : {}),
        });
        return { ...invite, expiresAt: invite.expiresAt.getTime() };
      } catch (e) {
        return rethrow(e);
      }
    },
  },
  revokeAppOrgInvite: {
    type: new GraphQLNonNull(OkType),
    description: "Delete an invitation so its token stops working.",
    args: {
      orgId: { type: new GraphQLNonNull(GraphQLString) },
      inviteId: { type: new GraphQLNonNull(GraphQLString) },
    },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireOrgAdmin(gqlCtx);
      const a = args as { orgId: string; inviteId: string };
      try {
        const org = await requireOrg(db(gqlCtx), tenantId, a.orgId);
        await revokeOrgInvite(db(gqlCtx), tenantId, org.id, a.inviteId);
        return { ok: true };
      } catch (e) {
        return rethrow(e);
      }
    },
  },
};
