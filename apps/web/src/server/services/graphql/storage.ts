import { AppError } from "@backlex/core";
import {
  GraphQLBoolean,
  GraphQLError,
  GraphQLFloat,
  GraphQLInputObjectType,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString,
  type GraphQLFieldConfig,
} from "graphql";
import { JSONScalar, type GqlCtx } from "./core";
import { resolvePermission } from "../permissions";
import { recordActivity } from "../activity";
import { FILES_COLLECTION } from "../storage/constants";
import {
  deleteFileScoped,
  listFilesScoped,
  patchFileScoped,
} from "../storage/files";
import { requireTenantId } from "../storage/keys";

// ── File storage (metadata plane) ────────────────────────────────────────────
// Mirrors REST `/api/storage` for everything that isn't a byte stream: listing
// and ACL/folder/metadata updates + delete. Upload/download/transform stay
// REST-only (multipart / binary responses don't fit GraphQL). Unlike the other
// admin twins this surface rides the data-plane permission DSL — the same
// `system_files` (collection, action) rows the REST middleware enforces,
// including the row-level `whereSql` clamp.

const StorageFileType = new GraphQLObjectType({
  name: "StorageFile",
  fields: {
    key: { type: new GraphQLNonNull(GraphQLString) },
    folderId: { type: GraphQLString },
    // Float, not Int — file sizes can exceed the 32-bit range.
    size: { type: new GraphQLNonNull(GraphQLFloat) },
    contentType: { type: GraphQLString },
    ownerId: { type: GraphQLString },
    acl: { type: new GraphQLNonNull(GraphQLString) },
    metadata: { type: JSONScalar },
    uploadedAt: { type: new GraphQLNonNull(GraphQLString) },
  },
});

const StorageFileListType = new GraphQLObjectType({
  name: "StorageFileList",
  fields: {
    data: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(StorageFileType))),
    },
    meta: { type: new GraphQLNonNull(JSONScalar) },
  },
});

const StorageFilePatchInputType = new GraphQLInputObjectType({
  name: "StorageFilePatchInput",
  fields: {
    acl: { type: GraphQLString },
    folderId: { type: GraphQLString },
    metadata: { type: JSONScalar },
  },
});

/** yoga masks non-GraphQLError throws — surface AppErrors with their code. */
const surfacing = async <T>(work: () => Promise<T> | T): Promise<T> => {
  try {
    return await work();
  } catch (e) {
    if (e instanceof AppError) {
      throw new GraphQLError(e.message, { extensions: { code: e.code } });
    }
    throw e;
  }
};

/** Resolve the caller's `system_files` permission for one action — the same
 *  gate REST's requirePermission middleware applies, incl. row-level SQL. */
const filePerm = async (gqlCtx: GqlCtx, action: "read" | "update" | "delete") => {
  const tenantId = await surfacing(() => requireTenantId(gqlCtx.auth));
  const perm = await resolvePermission(
    gqlCtx.ctx,
    gqlCtx.auth,
    FILES_COLLECTION,
    action,
    gqlCtx.permCache,
  );
  if (!perm.allowed)
    throw new GraphQLError(`Not allowed to ${action} files`, {
      extensions: { code: "FORBIDDEN" },
    });
  return { tenantId, perm };
};

export const storageQueryFields: Record<string, GraphQLFieldConfig<unknown, GqlCtx>> = {
  files: {
    type: new GraphQLNonNull(StorageFileListType),
    description:
      "Paginated file listing for the active workspace. Same prefix/folder/" +
      "search filters and permission clamp as REST `GET /api/storage`.",
    args: {
      prefix: { type: GraphQLString },
      folderId: {
        type: GraphQLString,
        description: "Folder UUID, or `__root__` to match files with no folder.",
      },
      search: { type: GraphQLString },
      limit: { type: GraphQLInt },
      offset: { type: GraphQLInt },
    },
    resolve: async (_src, args, gqlCtx) => {
      const { tenantId, perm } = await filePerm(gqlCtx, "read");
      const a = args as {
        prefix?: string | null;
        folderId?: string | null;
        search?: string | null;
        limit?: number | null;
        offset?: number | null;
      };
      return listFilesScoped(gqlCtx.ctx, {
        tenantId,
        prefix: a.prefix ?? "",
        folderId: a.folderId ?? undefined,
        search: a.search ?? "",
        limit: Math.max(1, Math.min(200, a.limit ?? 50)),
        offset: Math.max(0, a.offset ?? 0),
        permWhere: perm.whereSql,
      });
    },
  },
};

export const storageMutationFields: Record<string, GraphQLFieldConfig<unknown, GqlCtx>> = {
  updateFile: {
    type: new GraphQLNonNull(JSONScalar),
    description:
      "Update a file's ACL/folder/metadata (metadata merges; null keys clear). " +
      "Returns the applied patch `{ key, ... }`.",
    args: {
      key: { type: new GraphQLNonNull(GraphQLString) },
      data: { type: new GraphQLNonNull(StorageFilePatchInputType) },
    },
    resolve: async (_src, args, gqlCtx) => {
      const { tenantId, perm } = await filePerm(gqlCtx, "update");
      const a = args as {
        key: string;
        data: {
          acl?: string | null;
          folderId?: string | null;
          metadata?: Record<string, unknown> | null;
        };
      };
      if (a.data.acl != null && a.data.acl !== "public" && a.data.acl !== "private")
        throw new GraphQLError("acl must be public | private", {
          extensions: { code: "VALIDATION" },
        });
      const data = await surfacing(() =>
        patchFileScoped(gqlCtx.ctx, {
          tenantId,
          logicalKey: a.key,
          permWhere: perm.whereSql,
          patch: {
            ...(a.data.acl != null ? { acl: a.data.acl as "public" | "private" } : {}),
            ...(a.data.folderId !== undefined ? { folderId: a.data.folderId } : {}),
            ...(a.data.metadata !== undefined ? { metadata: a.data.metadata } : {}),
          },
        }),
      );
      await recordActivity(gqlCtx.ctx, {
        userId: gqlCtx.auth.userId ?? null,
        tenantId,
        action: "update",
        collection: FILES_COLLECTION,
        itemId: a.key,
        payload: a.data,
        response: { ok: true, data },
      });
      return data;
    },
  },
  deleteFile: {
    type: new GraphQLNonNull(GraphQLBoolean),
    description: "Delete an object (bytes + tracking row).",
    args: { key: { type: new GraphQLNonNull(GraphQLString) } },
    resolve: async (_src, args, gqlCtx) => {
      const { tenantId, perm } = await filePerm(gqlCtx, "delete");
      const key = (args as { key: string }).key;
      await surfacing(() =>
        deleteFileScoped(gqlCtx.ctx, {
          tenantId,
          logicalKey: key,
          permWhere: perm.whereSql,
        }),
      );
      await recordActivity(gqlCtx.ctx, {
        userId: gqlCtx.auth.userId ?? null,
        tenantId,
        action: "delete",
        collection: FILES_COLLECTION,
        itemId: key,
        response: { ok: true },
      });
      return true;
    },
  },
};
