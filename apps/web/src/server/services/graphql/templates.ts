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
import {
  applyTemplate,
  applyTemplateDefinition,
  clearTemplateSamples,
  countSeededSamples,
  extractTemplate,
  hasNoManagedCollections,
  parseCustomTemplate,
} from "../templates";
import { templateSummariesLazy } from "../../templates/lazy";

// ── Schema templates ───────────────────────────────────────────────────────
// Static, admin-scoped surface mirroring REST `/api/admin/templates` + MCP
// `templates.*` + SDK `client.templates.*`. Like flows, templates don't vary
// with tenant schema, so they're merged into EVERY schema build.
const nonNullStrings = new GraphQLNonNull(
  new GraphQLList(new GraphQLNonNull(GraphQLString)),
);

const TemplateCollectionSummaryType = new GraphQLObjectType({
  name: "TemplateCollectionSummary",
  fields: {
    slug: { type: new GraphQLNonNull(GraphQLString) },
    label: { type: new GraphQLNonNull(GraphQLString) },
    fieldCount: { type: new GraphQLNonNull(GraphQLInt) },
    group: { type: GraphQLString },
  },
});

/** How much of a working application a template brings, as counts — the same
 *  shape `templateSummaries()` returns for the admin picker. */
const TemplateBundlesType = new GraphQLObjectType({
  name: "TemplateBundles",
  fields: {
    kpis: { type: new GraphQLNonNull(GraphQLInt) },
    flows: { type: new GraphQLNonNull(GraphQLInt) },
    documents: { type: new GraphQLNonNull(GraphQLInt) },
    forms: { type: new GraphQLNonNull(GraphQLInt) },
    agents: { type: new GraphQLNonNull(GraphQLInt) },
    flags: { type: new GraphQLNonNull(GraphQLInt) },
    channels: { type: new GraphQLNonNull(GraphQLInt) },
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
    groups: { type: nonNullStrings },
    roles: { type: nonNullStrings },
    dashboards: { type: nonNullStrings },
    bundles: { type: new GraphQLNonNull(TemplateBundlesType) },
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
    created: { type: nonNullStrings },
    skipped: { type: nonNullStrings },
    seeded: { type: new GraphQLNonNull(GraphQLInt) },
    roles: { type: nonNullStrings },
    dashboards: { type: nonNullStrings },
    kpis: { type: nonNullStrings },
    flows: { type: nonNullStrings },
    documents: { type: nonNullStrings },
    /** Form NAMES. The one-time token is never reported on any surface. */
    forms: { type: nonNullStrings },
    agents: { type: nonNullStrings },
    flags: { type: nonNullStrings },
    channels: { type: nonNullStrings },
  },
});

const ClearTemplateSamplesResultType = new GraphQLObjectType({
  name: "ClearTemplateSamplesResult",
  fields: {
    removed: { type: new GraphQLNonNull(GraphQLInt) },
    collections: { type: nonNullStrings },
  },
});

/** Catalog metadata REST returns alongside the summaries — mirrored so the
 *  GraphQL surface can also drive the onboarding/clear-samples affordances. */
const TemplateSeedStatusType = new GraphQLObjectType({
  name: "TemplateSeedStatus",
  fields: {
    defaultTemplateId: { type: new GraphQLNonNull(GraphQLString) },
    hasCollections: { type: new GraphQLNonNull(GraphQLBoolean) },
    sampleSeeds: { type: new GraphQLNonNull(GraphQLInt) },
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

const rethrow = (e: unknown): never => {
  if (e instanceof AppError) {
    throw new GraphQLError(e.message, { extensions: { code: e.code } });
  }
  throw e;
};

/** Static template query fields, merged into every schema. */
export const templateQueryFields: Record<string, GraphQLFieldConfig<unknown, GqlCtx>> = {
  templates: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(TemplateSummaryType))),
    description: "List the schema-template catalog for the active workspace (admin-only).",
    resolve: (_src, _args, gqlCtx) => {
      requireTemplateAdmin(gqlCtx);
      return templateSummariesLazy();
    },
  },
  templateSeedStatus: {
    type: new GraphQLNonNull(TemplateSeedStatusType),
    description:
      "Workspace template state — the cloud-preselected default, whether managed collections exist, and how many seeded sample rows remain (admin-only). Mirrors the extra fields of REST `GET /api/admin/templates`.",
    resolve: async (_src, _args, gqlCtx) => {
      const tenantId = requireTemplateAdmin(gqlCtx);
      const { ctx } = gqlCtx;
      try {
        const dbCtx = { db: ctx.db, dialect: ctx.dialect };
        const empty = await hasNoManagedCollections(dbCtx, tenantId);
        const sampleSeeds = await countSeededSamples(dbCtx, tenantId);
        return {
          defaultTemplateId: ctx.env.SEED_TEMPLATE || "blank",
          hasCollections: !empty,
          sampleSeeds,
        };
      } catch (e) {
        return rethrow(e);
      }
    },
  },
  extractTemplate: {
    type: new GraphQLNonNull(GraphQLString),
    description:
      "Export the workspace's managed collections as a reusable schema template " +
      "(JSON-encoded — collections in dependency order + saved group headers). " +
      "Optionally narrow with `collections`. Apply elsewhere via `applyCustomTemplate` (admin-only).",
    args: {
      collections: { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) },
      samples: { type: GraphQLInt },
    },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireTemplateAdmin(gqlCtx);
      const { ctx } = gqlCtx;
      const a = args as { collections?: string[]; samples?: number | null };
      if (a.samples != null && (!Number.isInteger(a.samples) || a.samples < 1 || a.samples > 50)) {
        throw new GraphQLError("samples must be an integer between 1 and 50", {
          extensions: { code: "VALIDATION" },
        });
      }
      try {
        const template = await extractTemplate(
          { db: ctx.db, dialect: ctx.dialect },
          tenantId,
          { collections: a.collections, sampleRows: a.samples ?? undefined },
        );
        return JSON.stringify(template);
      } catch (e) {
        return rethrow(e);
      }
    },
  },
};

/** Static template mutation fields, merged into every schema. */
export const templateMutationFields: Record<string, GraphQLFieldConfig<unknown, GqlCtx>> = {
  applyTemplate: {
    type: new GraphQLNonNull(ApplyTemplateResultType),
    description:
      "Seed a vertical template's collections (grouped, with sample data and any bundled roles/dashboards) into the active workspace. Idempotent — existing collections are skipped (admin-only).",
    args: { templateId: { type: new GraphQLNonNull(GraphQLString) } },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireTemplateAdmin(gqlCtx);
      const { ctx } = gqlCtx;
      try {
        return await applyTemplate(ctx, tenantId, (args as { templateId: string }).templateId);
      } catch (e) {
        return rethrow(e);
      }
    },
  },
  applyCustomTemplate: {
    type: new GraphQLNonNull(ApplyTemplateResultType),
    description:
      "Apply a custom template (JSON-encoded — the `extractTemplate` shape) into the active workspace. Same idempotent semantics as `applyTemplate` (admin-only).",
    args: { template: { type: new GraphQLNonNull(GraphQLString) } },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireTemplateAdmin(gqlCtx);
      const { ctx } = gqlCtx;
      try {
        let raw: unknown;
        try {
          raw = JSON.parse((args as { template: string }).template);
        } catch {
          throw new AppError("VALIDATION", "template must be a JSON-encoded object");
        }
        return await applyTemplateDefinition(ctx, tenantId, parseCustomTemplate(raw));
      } catch (e) {
        return rethrow(e);
      }
    },
  },
  clearTemplateSamples: {
    type: new GraphQLNonNull(ClearTemplateSamplesResultType),
    description:
      "Delete every sample row a template apply seeded (tracked in the seed manifest) — user-created rows are never touched (admin-only).",
    resolve: async (_src, _args, gqlCtx) => {
      const tenantId = requireTemplateAdmin(gqlCtx);
      try {
        // Full ctx — vector cleanup needs the embedding adapter + env.
        return await clearTemplateSamples(gqlCtx.ctx, tenantId);
      } catch (e) {
        return rethrow(e);
      }
    },
  },
};
