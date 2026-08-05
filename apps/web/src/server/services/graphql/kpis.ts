import { AppError } from "@backlex/core";
import { JSONScalar, type GqlCtx } from "./core";
import { requireFlowAdmin } from "./flows";
import {
  GraphQLError,
  GraphQLFloat,
  GraphQLID,
  GraphQLInputObjectType,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString,
  type GraphQLFieldConfig,
} from "graphql";
import {
  createKpi,
  deleteKpi,
  listKpis,
  requireKpi,
  runKpiForCaller,
  updateKpi,
  type KpiRow,
} from "../kpis";

// ── Named KPI definitions ────────────────────────────────────────────────────
// Static, admin-scoped surface mirroring REST `/api/admin/kpis` + MCP `kpis.*`
// + SDK `client.kpis.*` + CLI `backlex kpis`. Every one of them resolves
// through the same service, which is the entire point: a KPI that meant one
// thing over REST and another over GraphQL would be a definition layer that
// does not define anything.
const KpiType = new GraphQLObjectType({
  name: "Kpi",
  fields: {
    id: { type: new GraphQLNonNull(GraphQLID) },
    tenantId: { type: GraphQLString },
    slug: { type: new GraphQLNonNull(GraphQLString) },
    name: { type: new GraphQLNonNull(GraphQLString) },
    description: { type: GraphQLString },
    collection: { type: new GraphQLNonNull(GraphQLString) },
    agg: { type: new GraphQLNonNull(GraphQLString) },
    field: { type: GraphQLString },
    filter: { type: JSONScalar },
    dateField: { type: GraphQLString },
    groupBy: { type: GraphQLString },
    topN: { type: GraphQLInt },
    format: { type: new GraphQLNonNull(GraphQLString) },
    unit: { type: GraphQLString },
    decimals: { type: GraphQLInt },
    direction: { type: new GraphQLNonNull(GraphQLString) },
  },
});

const KpiInputType = new GraphQLInputObjectType({
  name: "KpiInput",
  fields: {
    slug: { type: GraphQLString },
    name: { type: GraphQLString },
    description: { type: GraphQLString },
    collection: { type: GraphQLString },
    agg: { type: GraphQLString },
    field: { type: GraphQLString },
    filter: { type: JSONScalar },
    dateField: { type: GraphQLString },
    groupBy: { type: GraphQLString },
    topN: { type: GraphQLInt },
    format: { type: GraphQLString },
    unit: { type: GraphQLString },
    decimals: { type: GraphQLInt },
    direction: { type: GraphQLString },
  },
});

const KpiWindowType = new GraphQLObjectType({
  name: "KpiWindow",
  fields: {
    from: { type: new GraphQLNonNull(GraphQLFloat) },
    to: { type: new GraphQLNonNull(GraphQLFloat) },
  },
});

// Every numeric field here is nullable on purpose. `value` is null for an
// avg/min/max over an empty window (which is NOT zero), and `deltaPct` is null
// when the baseline was zero (there is no proportion to report). A non-null
// wrapper would force a caller to invent one of those numbers.
const KpiPointType = new GraphQLObjectType({
  name: "KpiPoint",
  fields: {
    label: { type: GraphQLString },
    value: { type: GraphQLFloat },
    previousValue: { type: GraphQLFloat },
    delta: { type: GraphQLFloat },
    deltaPct: { type: GraphQLFloat },
    currency: { type: GraphQLString },
  },
});

const KpiResultType = new GraphQLObjectType({
  name: "KpiResult",
  fields: {
    slug: { type: new GraphQLNonNull(GraphQLString) },
    name: { type: new GraphQLNonNull(GraphQLString) },
    description: { type: GraphQLString },
    collection: { type: new GraphQLNonNull(GraphQLString) },
    format: { type: new GraphQLNonNull(GraphQLString) },
    unit: { type: GraphQLString },
    decimals: { type: GraphQLInt },
    direction: { type: new GraphQLNonNull(GraphQLString) },
    groupBy: { type: GraphQLString },
    /** Null when the KPI has no date column — no period comparison exists. */
    window: { type: KpiWindowType },
    previousWindow: { type: KpiWindowType },
    point: { type: KpiPointType },
    rows: { type: new GraphQLList(new GraphQLNonNull(KpiPointType)) },
    computedAt: { type: new GraphQLNonNull(GraphQLFloat) },
  },
});

const requireKpiAdmin = requireFlowAdmin;

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

const normalizeKpiRow = (r: KpiRow) => ({
  id: r.id,
  tenantId: r.tenantId,
  slug: r.slug,
  name: r.name,
  description: r.description ?? null,
  collection: r.collection,
  agg: r.agg,
  field: r.field ?? null,
  filter: r.filter ?? null,
  dateField: r.dateField ?? null,
  groupBy: r.groupBy ?? null,
  topN: r.topN ?? null,
  format: r.format,
  unit: r.unit ?? null,
  decimals: r.decimals ?? null,
  direction: r.direction,
});

/** The active workspace, for a caller who only needs to READ a KPI. Running
 *  one is not an admin act — the evaluation clamps to the caller's own read
 *  permission inside the service. */
const requireTenant = (gqlCtx: GqlCtx): string => {
  const tenantId = gqlCtx.auth?.tenantId;
  if (!tenantId) {
    throw new GraphQLError("Active tenant required", {
      extensions: { code: "UNAUTHORIZED" },
    });
  }
  return tenantId;
};

export const kpiQueryFields: Record<string, GraphQLFieldConfig<unknown, GqlCtx>> = {
  kpis: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(KpiType))),
    description: "List the workspace's named KPI definitions.",
    resolve: async (_src, _args, gqlCtx) =>
      surfacing(async () => {
        const tenantId = requireTenant(gqlCtx);
        const rows = await listKpis(gqlCtx.ctx, tenantId);
        return rows.map(normalizeKpiRow);
      }),
  },
  kpi: {
    type: KpiType,
    description: "Fetch a single KPI definition by slug or id.",
    args: { ref: { type: new GraphQLNonNull(GraphQLString) } },
    resolve: async (_src, args, gqlCtx) =>
      surfacing(async () => {
        const tenantId = requireTenant(gqlCtx);
        const row = await requireKpi(gqlCtx.ctx, tenantId, (args as { ref: string }).ref);
        return normalizeKpiRow(row);
      }),
  },
  runKpi: {
    type: KpiResultType,
    description:
      "Evaluate a KPI over a window and the window before it. `window` is null " +
      "when the KPI has no date column, and `deltaPct` is null when the previous " +
      "period was zero — neither is a zero.",
    args: {
      ref: { type: new GraphQLNonNull(GraphQLString) },
      rangeDays: { type: GraphQLInt },
      from: { type: GraphQLFloat },
      to: { type: GraphQLFloat },
    },
    resolve: async (_src, args, gqlCtx) =>
      surfacing(async () => {
        const tenantId = requireTenant(gqlCtx);
        const a = args as { ref: string; rangeDays?: number; from?: number; to?: number };
        const kpi = await requireKpi(gqlCtx.ctx, tenantId, a.ref);
        return runKpiForCaller(gqlCtx.ctx, gqlCtx.auth, tenantId, kpi, {
          rangeDays: a.rangeDays,
          from: a.from,
          to: a.to,
        });
      }),
  },
};

export const kpiMutationFields: Record<string, GraphQLFieldConfig<unknown, GqlCtx>> = {
  createKpi: {
    type: KpiType,
    description: "Define a KPI scoped to the active workspace (admin-only).",
    args: { data: { type: new GraphQLNonNull(KpiInputType) } },
    resolve: async (_src, args, gqlCtx) =>
      surfacing(async () => {
        const tenantId = requireKpiAdmin(gqlCtx);
        const data = (args as { data: Record<string, unknown> }).data;
        for (const key of ["slug", "name", "collection"] as const) {
          if (typeof data?.[key] !== "string" || !(data[key] as string).length) {
            throw new GraphQLError(`${key} is required`, {
              extensions: { code: "VALIDATION" },
            });
          }
        }
        const row = await createKpi(gqlCtx.ctx, gqlCtx.auth, tenantId, {
          ...(data as Record<string, unknown>),
          slug: data.slug as string,
          name: data.name as string,
          collection: data.collection as string,
          agg: (data.agg as string) ?? "count",
        });
        return normalizeKpiRow(row);
      }),
  },
  updateKpi: {
    type: KpiType,
    description: "Partial update of a KPI definition by id (admin-only).",
    args: {
      id: { type: new GraphQLNonNull(GraphQLID) },
      data: { type: new GraphQLNonNull(KpiInputType) },
    },
    resolve: async (_src, args, gqlCtx) =>
      surfacing(async () => {
        const tenantId = requireKpiAdmin(gqlCtx);
        const a = args as { id: string; data: Record<string, unknown> };
        const row = await updateKpi(gqlCtx.ctx, tenantId, a.id, a.data);
        return normalizeKpiRow(row);
      }),
  },
  deleteKpi: {
    type: new GraphQLNonNull(GraphQLString),
    description: "Delete a KPI definition by id (admin-only). Returns the id.",
    args: { id: { type: new GraphQLNonNull(GraphQLID) } },
    resolve: async (_src, args, gqlCtx) =>
      surfacing(async () => {
        const tenantId = requireKpiAdmin(gqlCtx);
        const id = (args as { id: string }).id;
        await deleteKpi(gqlCtx.ctx, tenantId, id);
        return id;
      }),
  },
};
