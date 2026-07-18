import { JSONScalar, type GqlCtx } from "./core";
import {
  GraphQLBoolean,
  GraphQLError,
  GraphQLFloat,
  GraphQLID,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString,
  type GraphQLFieldConfig,
} from "graphql";
import { AppError, SYSTEM_ROLES } from "@backlex/core";
import {
  getExtension,
  installFromNpm,
  installFromUpload,
  invokeExtensionHook,
  listExtensions,
  setExtensionEnabled,
  uninstallExtension,
  type ExtensionRow,
} from "../extensions";

// ── Extensions ──────────────────────────────────────────────────────────────
// Static, admin-scoped query/mutation fields merged into every schema.
// Mirrors REST `/api/extensions` + MCP `extensions.*` + SDK
// `client.extensions.*`. All resolvers call the ONE shared service so
// validation / size caps / registry pinning stay identical across surfaces.

const ExtensionType = new GraphQLObjectType({
  name: "Extension",
  fields: {
    id: { type: new GraphQLNonNull(GraphQLID) },
    name: { type: new GraphQLNonNull(GraphQLString) },
    version: { type: new GraphQLNonNull(GraphQLString) },
    source: { type: new GraphQLNonNull(GraphQLString) },
    npmPackage: { type: GraphQLString },
    manifest: { type: new GraphQLNonNull(JSONScalar) },
    enabled: { type: new GraphQLNonNull(GraphQLBoolean) },
  },
});

const ExtensionInvokeResultType = new GraphQLObjectType({
  name: "ExtensionInvokeResult",
  fields: {
    ok: { type: new GraphQLNonNull(GraphQLBoolean) },
    logs: { type: new GraphQLNonNull(JSONScalar) },
    error: { type: GraphQLString },
    durationMs: { type: new GraphQLNonNull(GraphQLFloat) },
    value: { type: JSONScalar },
  },
});

const requireExtensionAdmin = (gqlCtx: GqlCtx): string => {
  const { auth } = gqlCtx;
  if (!auth.roles.includes(SYSTEM_ROLES.admin)) {
    throw new GraphQLError("Admin role required", { extensions: { code: "FORBIDDEN" } });
  }
  if (!auth.tenantId) {
    throw new GraphQLError("Active tenant required", { extensions: { code: "UNAUTHORIZED" } });
  }
  return auth.tenantId;
};

const serialize = (row: ExtensionRow) => ({
  id: row.id,
  name: row.name,
  version: row.version,
  source: row.source,
  npmPackage: row.npmPackage,
  manifest: row.manifest,
  enabled: row.enabled === true || row.enabled === 1,
});

/** Re-throw service AppErrors as GraphQLErrors with the same code. */
const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof AppError) {
      throw new GraphQLError(e.message, { extensions: { code: e.code } });
    }
    throw e;
  }
};

export const extensionQueryFields: Record<string, GraphQLFieldConfig<unknown, GqlCtx>> = {
  extensions: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(ExtensionType))),
    description: "List installed extensions in the active workspace (admin-only).",
    resolve: async (_src, _args, gqlCtx) => {
      const tenantId = requireExtensionAdmin(gqlCtx);
      const rows = await listExtensions(gqlCtx.ctx, tenantId);
      return rows.map(serialize);
    },
  },
  extension: {
    type: ExtensionType,
    description: "Fetch a single installed extension by name (admin-only).",
    args: { name: { type: new GraphQLNonNull(GraphQLString) } },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireExtensionAdmin(gqlCtx);
      const row = await getExtension(
        gqlCtx.ctx,
        tenantId,
        (args as { name: string }).name,
      );
      return row ? serialize(row) : null;
    },
  },
};

export const extensionMutationFields: Record<string, GraphQLFieldConfig<unknown, GqlCtx>> = {
  installExtension: {
    type: new GraphQLNonNull(ExtensionType),
    description:
      "Install (or upgrade) an extension from the npm registry (admin-only).",
    args: {
      package: { type: new GraphQLNonNull(GraphQLString) },
      version: { type: GraphQLString },
    },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireExtensionAdmin(gqlCtx);
      const a = args as { package: string; version?: string };
      const row = await wrap(() =>
        installFromNpm(gqlCtx.ctx, tenantId, a.package, a.version ?? undefined),
      );
      return serialize(row);
    },
  },
  uploadExtension: {
    type: new GraphQLNonNull(ExtensionType),
    description:
      "Install an extension from a `path → content` file map (admin-only).",
    args: { files: { type: new GraphQLNonNull(JSONScalar) } },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireExtensionAdmin(gqlCtx);
      const files = (args as { files: unknown }).files;
      if (
        typeof files !== "object" ||
        files === null ||
        Array.isArray(files) ||
        Object.values(files).some((v) => typeof v !== "string")
      ) {
        throw new GraphQLError("files must be a string → string map", {
          extensions: { code: "VALIDATION" },
        });
      }
      const row = await wrap(() =>
        installFromUpload(gqlCtx.ctx, tenantId, files as Record<string, string>),
      );
      return serialize(row);
    },
  },
  setExtensionEnabled: {
    type: new GraphQLNonNull(ExtensionType),
    description: "Enable or disable an installed extension (admin-only).",
    args: {
      name: { type: new GraphQLNonNull(GraphQLString) },
      enabled: { type: new GraphQLNonNull(GraphQLBoolean) },
    },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireExtensionAdmin(gqlCtx);
      const a = args as { name: string; enabled: boolean };
      const row = await wrap(() =>
        setExtensionEnabled(gqlCtx.ctx, tenantId, a.name, a.enabled),
      );
      return serialize(row);
    },
  },
  uninstallExtension: {
    type: new GraphQLNonNull(GraphQLBoolean),
    description: "Uninstall an extension and delete its assets (admin-only).",
    args: { name: { type: new GraphQLNonNull(GraphQLString) } },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireExtensionAdmin(gqlCtx);
      await wrap(() =>
        uninstallExtension(gqlCtx.ctx, tenantId, (args as { name: string }).name),
      );
      return true;
    },
  },
  invokeExtensionHook: {
    type: new GraphQLNonNull(ExtensionInvokeResultType),
    description:
      "Run an extension hook in the functions sandbox with an arbitrary input payload (admin-only).",
    args: {
      name: { type: new GraphQLNonNull(GraphQLString) },
      hookId: { type: new GraphQLNonNull(GraphQLString) },
      input: { type: JSONScalar },
    },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireExtensionAdmin(gqlCtx);
      const a = args as { name: string; hookId: string; input?: unknown };
      const row = await getExtension(gqlCtx.ctx, tenantId, a.name);
      if (!row) {
        throw new GraphQLError("Extension not found", { extensions: { code: "NOT_FOUND" } });
      }
      if (!(row.enabled === true || row.enabled === 1)) {
        throw new GraphQLError("Extension is disabled", { extensions: { code: "FORBIDDEN" } });
      }
      const input =
        a.input && typeof a.input === "object" ? (a.input as Record<string, unknown>) : {};
      return wrap(() =>
        invokeExtensionHook(gqlCtx.ctx, row, a.hookId, gqlCtx.auth, input),
      );
    },
  },
};
