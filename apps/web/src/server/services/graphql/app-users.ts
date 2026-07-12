import { type GqlCtx } from "./core";
import {
  GraphQLError,
  GraphQLFloat,
  GraphQLID,
  GraphQLInputObjectType,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString,
  type GraphQLFieldConfig,
} from "graphql";
import { AppError, SYSTEM_ROLES } from "@backlex/core";
import { inviteAppUser } from "../app-user-invites";

// ── Workspace end-user invites ─────────────────────────────────────────────
// Static, admin-scoped surface mirroring REST `POST /api/app-users/invite` +
// MCP `app_users.invite` + SDK `client.appUsers.invite`. Like templates, this
// doesn't vary with tenant schema, so it's merged into EVERY schema build.

const InviteAppUserLinkInput = new GraphQLInputObjectType({
  name: "InviteAppUserLinkInput",
  description:
    "Person row to link at invite time: sets `<collection>.<itemId>.app_user_id` " +
    "to the invited user so `$user.id` permission conditions match after accept.",
  fields: {
    collection: { type: new GraphQLNonNull(GraphQLString) },
    itemId: { type: new GraphQLNonNull(GraphQLString) },
  },
});

const InviteAppUserResultType = new GraphQLObjectType({
  name: "InviteAppUserResult",
  fields: {
    id: { type: new GraphQLNonNull(GraphQLID) },
    email: { type: new GraphQLNonNull(GraphQLString) },
    /** Raw one-shot invite token (also mailed to the invitee). */
    token: { type: new GraphQLNonNull(GraphQLString) },
    /** Expiry as a ms-epoch — same shape REST returns. */
    expiresAt: { type: new GraphQLNonNull(GraphQLFloat) },
  },
});

/** App-user management is admin-only on every surface — mirror that gate
 *  (FORBIDDEN for non-admins). Returns the active tenant id. */
const requireAppUserAdmin = (gqlCtx: GqlCtx): string => {
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

/** Static app-user mutation fields, merged into every schema. */
export const appUserMutationFields: Record<string, GraphQLFieldConfig<unknown, GqlCtx>> = {
  inviteAppUser: {
    type: new GraphQLNonNull(InviteAppUserResultType),
    description:
      "Invite a workspace end-user: creates a pending `app_users` row (status " +
      "`invited`, no credential), mints a 7-day one-shot token, and best-effort " +
      "mails it. Optionally binds roles (admin role rejected) and links a person " +
      "row's `app_user_id`. The invitee accepts on the app plane via " +
      "`POST /api/t/{slug}/auth/invite/accept` with `{ token, password }`. " +
      "Mirrors REST `POST /api/app-users/invite` (admin-only).",
    args: {
      email: { type: new GraphQLNonNull(GraphQLString) },
      name: { type: GraphQLString },
      roleIds: { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) },
      link: { type: InviteAppUserLinkInput },
    },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireAppUserAdmin(gqlCtx);
      const a = args as {
        email: string;
        name?: string | null;
        roleIds?: string[] | null;
        link?: { collection: string; itemId: string } | null;
      };
      try {
        const result = await inviteAppUser(gqlCtx.ctx, tenantId, {
          email: a.email,
          name: a.name ?? undefined,
          roleIds: a.roleIds ?? undefined,
          link: a.link ?? undefined,
        });
        return { ...result, expiresAt: result.expiresAt.getTime() };
      } catch (e) {
        return rethrow(e);
      }
    },
  },
};
