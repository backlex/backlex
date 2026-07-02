import { JSONScalar, type GqlCtx } from "./core";
import { requireAgentAdmin } from "./agents";
import {
  GraphQLBoolean,
  GraphQLID,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString,
  type GraphQLFieldConfig,
} from "graphql";
import {
  type Action,
  type AuthPlane,
} from "@backlex/core";
import {
  simulatePermission,
} from "../permissions";

// ── Permission simulator ─────────────────────────────────────────────────────
// Static, admin-scoped surface mirroring REST `/api/permissions/simulate` + MCP
// `permissions.simulate` + SDK `client.permissions.simulate`. Read-only — it
// dry-runs the resolver and returns the full allow/deny trace.
const PermissionSimRuleType = new GraphQLObjectType({
  name: "PermissionSimRule",
  fields: {
    permissionId: { type: new GraphQLNonNull(GraphQLID) },
    roleId: { type: new GraphQLNonNull(GraphQLID) },
    roleName: { type: new GraphQLNonNull(GraphQLString) },
    collection: { type: new GraphQLNonNull(GraphQLString) },
    condition: { type: JSONScalar },
    fields: { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) },
    rowMatch: { type: GraphQLBoolean },
  },
});

const PermissionSimSubjectType = new GraphQLObjectType({
  name: "PermissionSimSubject",
  fields: {
    userId: { type: GraphQLID },
    email: { type: GraphQLString },
    roles: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLString))) },
    tenantId: { type: GraphQLID },
    plane: { type: new GraphQLNonNull(GraphQLString) },
  },
});

const PermissionSimRoleType = new GraphQLObjectType({
  name: "PermissionSimRole",
  fields: {
    id: { type: new GraphQLNonNull(GraphQLID) },
    name: { type: new GraphQLNonNull(GraphQLString) },
    admin: { type: new GraphQLNonNull(GraphQLBoolean) },
  },
});

const PermissionSimWhereSqlType = new GraphQLObjectType({
  name: "PermissionSimWhereSql",
  fields: {
    sql: { type: new GraphQLNonNull(GraphQLString) },
    params: { type: new GraphQLNonNull(JSONScalar) },
  },
});

const PermissionSimulationType = new GraphQLObjectType({
  name: "PermissionSimulation",
  fields: {
    subject: { type: new GraphQLNonNull(PermissionSimSubjectType) },
    collection: { type: new GraphQLNonNull(GraphQLString) },
    action: { type: new GraphQLNonNull(GraphQLString) },
    allowed: { type: new GraphQLNonNull(GraphQLBoolean) },
    isAdmin: { type: new GraphQLNonNull(GraphQLBoolean) },
    reason: { type: new GraphQLNonNull(GraphQLString) },
    roles: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(PermissionSimRoleType))),
    },
    matchedRules: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(PermissionSimRuleType))),
    },
    resolvedVars: { type: new GraphQLNonNull(JSONScalar) },
    whereSql: { type: PermissionSimWhereSqlType },
    fields: { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) },
    rowMatch: { type: GraphQLBoolean },
  },
});

export const permissionQueryFields: Record<string, GraphQLFieldConfig<unknown, GqlCtx>> = {
  permissionSimulation: {
    type: new GraphQLNonNull(PermissionSimulationType),
    description:
      "Dry-run the permission resolver for a subject against a " +
      "(collection, action) and return the full allow/deny trace (admin-only).",
    args: {
      collection: { type: new GraphQLNonNull(GraphQLString) },
      action: { type: new GraphQLNonNull(GraphQLString) },
      userId: { type: GraphQLID },
      email: { type: GraphQLString },
      roles: { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) },
      plane: { type: GraphQLString },
      sampleRow: { type: JSONScalar },
    },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireAgentAdmin(gqlCtx);
      const a = args as {
        collection: string;
        action: string;
        userId?: string | null;
        email?: string | null;
        roles?: string[] | null;
        plane?: string | null;
        sampleRow?: Record<string, unknown> | null;
      };
      return simulatePermission(gqlCtx.ctx, {
        collection: a.collection,
        action: a.action as Action,
        userId: a.userId ?? null,
        email: a.email ?? null,
        roles: a.roles ?? null,
        plane: (a.plane as AuthPlane | undefined) ?? undefined,
        sampleRow: a.sampleRow ?? null,
        tenantId,
      });
    },
  },
};

