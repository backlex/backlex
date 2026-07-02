import { type GqlCtx } from "./core";
import {
  GraphQLBoolean,
  GraphQLError,
  GraphQLID,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString,
  type GraphQLFieldConfig,
} from "graphql";
import {
  AppError,
  SYSTEM_ROLES,
} from "@backlex/core";
import { applyTemplate } from "../templates";
import { invalidateTenantCollections } from "../collections-cache";
import { templateSummaries } from "../../templates/catalog";

// ── Schema templates ───────────────────────────────────────────────────────
// Static, admin-scoped surface mirroring REST `/api/admin/templates` + MCP
// `templates.*` + SDK `client.templates.*`. Like flows, templates don't vary
// with tenant schema, so they're merged into EVERY schema build.
const TemplateCollectionSummaryType = new GraphQLObjectType({
  name: "TemplateCollectionSummary",
  fields: {
    slug: { type: new GraphQLNonNull(GraphQLString) },
    label: { type: new GraphQLNonNull(GraphQLString) },
    fieldCount: { type: new GraphQLNonNull(GraphQLInt) },
  },
});

const TemplateSummaryType = new GraphQLObjectType({
  name: "TemplateSummary",
  fields: {
    id: { type: new GraphQLNonNull(GraphQLID) },
    label: { type: new GraphQLNonNull(GraphQLString) },
    description: { type: new GraphQLNonNull(GraphQLString) },
    category: { type: new GraphQLNonNull(GraphQLString) },
    recommended: { type: new GraphQLNonNull(GraphQLBoolean) },
    sampleRows: { type: new GraphQLNonNull(GraphQLInt) },
    collections: {
      type: new GraphQLNonNull(
        new GraphQLList(new GraphQLNonNull(TemplateCollectionSummaryType)),
      ),
    },
  },
});

const ApplyTemplateResultType = new GraphQLObjectType({
  name: "ApplyTemplateResult",
  fields: {
    templateId: { type: new GraphQLNonNull(GraphQLString) },
    created: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLString))) },
    skipped: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLString))) },
    seeded: { type: new GraphQLNonNull(GraphQLInt) },
  },
});

/** Templates are admin-only on every surface — mirror that gate (FORBIDDEN for
 *  non-admins, not a silent empty list). Returns the active tenant id. */
const requireTemplateAdmin = (gqlCtx: GqlCtx): string => {
  const { auth } = gqlCtx;
  if (!auth.roles.includes(SYSTEM_ROLES.admin)) {
    throw new GraphQLError("Admin role required", { extensions: { code: "FORBIDDEN" } });
  }
  if (!auth.tenantId) {
    throw new GraphQLError("Active tenant required", { extensions: { code: "UNAUTHORIZED" } });
  }
  return auth.tenantId;
};

const applyTemplateResolver = async (gqlCtx: GqlCtx, templateId: string) => {
  const tenantId = requireTemplateAdmin(gqlCtx);
  const { ctx } = gqlCtx;
  try {
    const result = await applyTemplate(
      { db: ctx.db, dialect: ctx.dialect },
      tenantId,
      templateId,
    );
    // Drop the cached collection list so the freshly-seeded collections resolve
    // immediately (mirrors the REST apply route).
    invalidateTenantCollections(tenantId);
    return result;
  } catch (e) {
    if (e instanceof AppError) {
      throw new GraphQLError(e.message, { extensions: { code: e.code } });
    }
    throw e;
  }
};

/** Static template query fields, merged into every schema. */
export const templateQueryFields: Record<string, GraphQLFieldConfig<unknown, GqlCtx>> = {
  templates: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(TemplateSummaryType))),
    description: "List the schema-template catalog for the active workspace (admin-only).",
    resolve: (_src, _args, gqlCtx) => {
      requireTemplateAdmin(gqlCtx);
      return templateSummaries();
    },
  },
};

/** Static template mutation fields, merged into every schema. */
export const templateMutationFields: Record<string, GraphQLFieldConfig<unknown, GqlCtx>> = {
  applyTemplate: {
    type: new GraphQLNonNull(ApplyTemplateResultType),
    description:
      "Seed a vertical template's collections (and sample data) into the active workspace. Idempotent — existing collections are skipped (admin-only).",
    args: { templateId: { type: new GraphQLNonNull(GraphQLString) } },
    resolve: (_src, args, gqlCtx) =>
      applyTemplateResolver(gqlCtx, (args as { templateId: string }).templateId),
  },
};

