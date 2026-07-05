import {
  GraphQLBoolean,
  GraphQLError,
  GraphQLID,
  GraphQLInputObjectType,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString,
  type GraphQLFieldConfig,
} from "graphql";
import { JSONScalar, type GqlCtx } from "./core";
import { requireFlowAdmin } from "./flows";
import {
  bulkUpsertI18nStrings,
  deleteI18nString,
  listI18nStrings,
  loadMatrix,
  upsertI18nString,
} from "../i18n";

// ── i18n strings ─────────────────────────────────────────────────────────────
// Static, admin-scoped surface mirroring REST `/api/i18n`. Upsert/delete
// funnel through services/i18n.ts helpers so the (key, locale) upsert and
// tenant-vs-global scoping rules stay in one place.

const I18nStringType = new GraphQLObjectType({
  name: "I18nString",
  fields: {
    id: { type: new GraphQLNonNull(GraphQLID) },
    tenantId: { type: GraphQLString },
    key: { type: new GraphQLNonNull(GraphQLString) },
    locale: { type: new GraphQLNonNull(GraphQLString) },
    value: { type: new GraphQLNonNull(GraphQLString) },
  },
});

const I18nStringInputType = new GraphQLInputObjectType({
  name: "I18nStringInput",
  fields: {
    key: { type: new GraphQLNonNull(GraphQLString) },
    locale: { type: new GraphQLNonNull(GraphQLString) },
    value: { type: new GraphQLNonNull(GraphQLString) },
  },
});

/** Mirror the REST zod contract: key 1–120 chars, locale 2–8 chars. */
const validateI18nInput = (row: { key: string; locale: string; value: string }) => {
  if (row.key.length < 1 || row.key.length > 120)
    throw new GraphQLError("key must be 1–120 characters", {
      extensions: { code: "VALIDATION" },
    });
  if (row.locale.length < 2 || row.locale.length > 8)
    throw new GraphQLError("locale must be 2–8 characters", {
      extensions: { code: "VALIDATION" },
    });
  return row;
};

export const i18nQueryFields: Record<string, GraphQLFieldConfig<unknown, GqlCtx>> = {
  i18nStrings: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(I18nStringType))),
    description:
      "i18n string rows for the workspace plus global fallback rows (admin-only).",
    resolve: (_src, _args, gqlCtx) => {
      const tenantId = requireFlowAdmin(gqlCtx);
      return listI18nStrings(gqlCtx.ctx.db, gqlCtx.ctx.dialect, tenantId);
    },
  },
  i18nMatrix: {
    type: new GraphQLNonNull(JSONScalar),
    description:
      "Pivoted key×locale matrix, including empty columns for configured-but-" +
      "untranslated locales (admin-only).",
    resolve: (_src, _args, gqlCtx) => {
      const tenantId = requireFlowAdmin(gqlCtx);
      return loadMatrix(gqlCtx.ctx.db, gqlCtx.ctx.dialect, tenantId);
    },
  },
};

export const i18nMutationFields: Record<string, GraphQLFieldConfig<unknown, GqlCtx>> = {
  setI18nString: {
    type: new GraphQLNonNull(I18nStringType),
    description: "Upsert a single (key, locale) string (admin-only).",
    args: { data: { type: new GraphQLNonNull(I18nStringInputType) } },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireFlowAdmin(gqlCtx);
      const data = validateI18nInput(
        (args as { data: { key: string; locale: string; value: string } }).data,
      );
      const { id } = await upsertI18nString(
        gqlCtx.ctx.db,
        gqlCtx.ctx.dialect,
        tenantId,
        data,
      );
      return { id, tenantId, ...data };
    },
  },
  setI18nStrings: {
    type: new GraphQLNonNull(JSONScalar),
    description:
      "Bulk upsert i18n strings; returns `{ ok, upserts }` (admin-only).",
    args: {
      data: {
        type: new GraphQLNonNull(
          new GraphQLList(new GraphQLNonNull(I18nStringInputType)),
        ),
      },
    },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireFlowAdmin(gqlCtx);
      const rows = (args as { data: { key: string; locale: string; value: string }[] })
        .data;
      for (const row of rows) validateI18nInput(row);
      const upserts = await bulkUpsertI18nStrings(
        gqlCtx.ctx.db,
        gqlCtx.ctx.dialect,
        tenantId,
        rows,
      );
      return { ok: true, upserts };
    },
  },
  deleteI18nString: {
    type: new GraphQLNonNull(GraphQLBoolean),
    description: "Delete one i18n row by id (admin-only).",
    args: { id: { type: new GraphQLNonNull(GraphQLID) } },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireFlowAdmin(gqlCtx);
      await deleteI18nString(
        gqlCtx.ctx.db,
        gqlCtx.ctx.dialect,
        tenantId,
        (args as { id: string }).id,
      );
      return true;
    },
  },
};
