import { AppError } from "@backlex/core";
import { JSONScalar, type GqlCtx } from "./core";
import { requireFlowAdmin } from "./flows";
import {
  GraphQLBoolean,
  GraphQLError,
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
  createDashboard,
  deleteDashboard,
  getDashboard,
  listDashboards,
  revokeDashboardEmbed,
  runDashboard,
  shareDashboard,
  updateDashboard,
} from "../dashboards";
import { deliverReport } from "../reports";

// ── Embedded BI dashboards ───────────────────────────────────────────────────
// Static, admin-scoped surface mirroring REST `/api/admin/dashboards` + MCP
// `dashboards.*` + SDK `client.dashboards.*`. Reuses the service layer so the
// SQL stays in one place. Like flows, dashboards don't vary with collection
// schema, so the fields merge into every schema.
const DashboardType = new GraphQLObjectType({
  name: "Dashboard",
  fields: {
    id: { type: new GraphQLNonNull(GraphQLID) },
    tenantId: { type: GraphQLString },
    name: { type: new GraphQLNonNull(GraphQLString) },
    description: { type: GraphQLString },
    layout: { type: JSONScalar },
    embedEnabled: { type: new GraphQLNonNull(GraphQLBoolean) },
    embedRoleId: { type: GraphQLString },
  },
});

const DashboardInputType = new GraphQLInputObjectType({
  name: "DashboardInput",
  fields: {
    name: { type: GraphQLString },
    description: { type: GraphQLString },
    layout: { type: JSONScalar },
  },
});

const DashboardPanelResultType = new GraphQLObjectType({
  name: "DashboardPanelResult",
  fields: {
    panelId: { type: new GraphQLNonNull(GraphQLID) },
    name: { type: new GraphQLNonNull(GraphQLString) },
    viz: { type: new GraphQLNonNull(GraphQLString) },
    kind: { type: new GraphQLNonNull(GraphQLString) },
    config: { type: JSONScalar },
    data: { type: new GraphQLNonNull(JSONScalar) },
    note: { type: GraphQLString },
    error: { type: GraphQLString },
  },
});

const DashboardReportPageOptionsInput = new GraphQLInputObjectType({
  name: "DashboardReportPageOptionsInput",
  fields: {
    format: { type: GraphQLString },
    landscape: { type: GraphQLBoolean },
    printBackground: { type: GraphQLBoolean },
  },
});

const DashboardReportEmailInput = new GraphQLInputObjectType({
  name: "DashboardReportEmailInput",
  fields: {
    /** One address or a comma-separated list — validated in the service. */
    to: { type: new GraphQLNonNull(GraphQLString) },
    subject: { type: GraphQLString },
    templateKey: { type: GraphQLString },
  },
});

const DashboardReportInputType = new GraphQLInputObjectType({
  name: "DashboardReportInput",
  fields: {
    filename: { type: GraphQLString },
    pageOptions: { type: DashboardReportPageOptionsInput },
    email: { type: DashboardReportEmailInput },
  },
});

const DashboardReportType = new GraphQLObjectType({
  name: "DashboardReport",
  fields: {
    key: { type: new GraphQLNonNull(GraphQLString) },
    filename: { type: new GraphQLNonNull(GraphQLString) },
    size: { type: new GraphQLNonNull(GraphQLInt) },
    renderer: { type: new GraphQLNonNull(GraphQLString) },
    panels: { type: new GraphQLNonNull(GraphQLInt) },
    failedPanels: { type: new GraphQLNonNull(GraphQLInt) },
    sentTo: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLString))) },
    attachmentsDropped: { type: GraphQLBoolean },
  },
});

const DashboardShareResultType = new GraphQLObjectType({
  name: "DashboardShareResult",
  fields: {
    token: { type: new GraphQLNonNull(GraphQLString) },
    url: { type: new GraphQLNonNull(GraphQLString) },
  },
});

/** Dashboards are admin-only on every other surface — reuse the flow gate. */
const requireDashboardAdmin = requireFlowAdmin;

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

/** Coerce sqlite 0/1 → boolean and drop the token hash for the API shape. */
const normalizeDashboardRow = (r: any) => ({
  id: r.id,
  tenantId: r.tenantId,
  name: r.name,
  description: r.description ?? null,
  layout: r.layout ?? null,
  embedEnabled: Boolean(r.embedEnabled),
  embedRoleId: r.embedRoleId ?? null,
});

export const dashboardQueryFields: Record<string, GraphQLFieldConfig<unknown, GqlCtx>> = {
  dashboards: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(DashboardType))),
    description: "List BI dashboards in the active workspace (admin-only).",
    resolve: async (_src, _args, gqlCtx) => {
      const tenantId = requireDashboardAdmin(gqlCtx);
      const rows = await listDashboards(gqlCtx.ctx, tenantId);
      return rows.map((r) => normalizeDashboardRow(r));
    },
  },
  dashboard: {
    type: DashboardType,
    description: "Fetch a single dashboard by id (admin-only).",
    args: { id: { type: new GraphQLNonNull(GraphQLID) } },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireDashboardAdmin(gqlCtx);
      const row = await getDashboard(gqlCtx.ctx, tenantId, (args as { id: string }).id);
      return row ? normalizeDashboardRow(row) : null;
    },
  },
};

export const dashboardMutationFields: Record<string, GraphQLFieldConfig<unknown, GqlCtx>> = {
  createDashboard: {
    type: DashboardType,
    description: "Create a dashboard scoped to the active workspace (admin-only).",
    args: { data: { type: new GraphQLNonNull(DashboardInputType) } },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireDashboardAdmin(gqlCtx);
      const data = (args as { data: Record<string, unknown> }).data;
      if (typeof data?.name !== "string" || data.name.length === 0)
        throw new GraphQLError("name is required", { extensions: { code: "VALIDATION" } });
      const row = await createDashboard(gqlCtx.ctx, gqlCtx.auth, tenantId, {
        name: data.name,
        description: (data.description as string | null) ?? null,
        layout: (data.layout as Record<string, unknown> | null) ?? null,
      });
      return normalizeDashboardRow(row);
    },
  },
  updateDashboard: {
    type: DashboardType,
    description: "Partial update of a dashboard by id (admin-only).",
    args: {
      id: { type: new GraphQLNonNull(GraphQLID) },
      data: { type: new GraphQLNonNull(DashboardInputType) },
    },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireDashboardAdmin(gqlCtx);
      const a = args as { id: string; data: Record<string, unknown> };
      await updateDashboard(gqlCtx.ctx, tenantId, a.id, a.data);
      const row = await getDashboard(gqlCtx.ctx, tenantId, a.id);
      return row ? normalizeDashboardRow(row) : null;
    },
  },
  deleteDashboard: {
    type: new GraphQLNonNull(GraphQLBoolean),
    description: "Delete a dashboard by id (admin-only).",
    args: { id: { type: new GraphQLNonNull(GraphQLID) } },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireDashboardAdmin(gqlCtx);
      await deleteDashboard(gqlCtx.ctx, tenantId, (args as { id: string }).id);
      return true;
    },
  },
  runDashboard: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(DashboardPanelResultType))),
    description: "Run every panel in a dashboard and return their results (admin-only).",
    args: { id: { type: new GraphQLNonNull(GraphQLID) } },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireDashboardAdmin(gqlCtx);
      const id = (args as { id: string }).id;
      const dash = await getDashboard(gqlCtx.ctx, tenantId, id);
      if (!dash)
        throw new GraphQLError("Dashboard not found", { extensions: { code: "NOT_FOUND" } });
      return runDashboard(gqlCtx.ctx, gqlCtx.auth, tenantId, id);
    },
  },
  shareDashboard: {
    type: new GraphQLNonNull(DashboardShareResultType),
    description: "Enable the public embed; mints a one-time token (admin-only).",
    args: {
      id: { type: new GraphQLNonNull(GraphQLID) },
      roleId: { type: GraphQLString },
    },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireDashboardAdmin(gqlCtx);
      const a = args as { id: string; roleId?: string | null };
      return shareDashboard(gqlCtx.ctx, tenantId, a.id, { roleId: a.roleId ?? null });
    },
  },
  deliverDashboardReport: {
    type: new GraphQLNonNull(DashboardReportType),
    description:
      "Print a dashboard to a PDF and store it; with `email` it is mailed too (admin-only). " +
      "Errors when no PDF renderer is configured.",
    args: {
      id: { type: new GraphQLNonNull(GraphQLID) },
      input: { type: DashboardReportInputType },
    },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireDashboardAdmin(gqlCtx);
      const a = args as { id: string; input?: Record<string, any> | null };
      const input = a.input ?? {};
      // The service owns every guard — recipient parsing, the missing-renderer
      // refusal, the storage prefix. Re-checking any of them here is how two
      // surfaces end up disagreeing about what is allowed. What DOES belong
      // here is translating the refusal: yoga masks a non-GraphQLError throw as
      // "Unexpected error.", so without this the caller is told nothing.
      return surfacing(() =>
        deliverReport(gqlCtx.ctx, gqlCtx.auth, tenantId, {
          dashboardId: a.id,
          ...(input.filename ? { filename: String(input.filename) } : {}),
          ...(input.pageOptions ? { pageOptions: input.pageOptions } : {}),
          ...(input.email ? { email: input.email } : {}),
        }),
      );
    },
  },
  revokeDashboardEmbed: {
    type: new GraphQLNonNull(GraphQLBoolean),
    description: "Disable the public embed and forget the token (admin-only).",
    args: { id: { type: new GraphQLNonNull(GraphQLID) } },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireDashboardAdmin(gqlCtx);
      await revokeDashboardEmbed(gqlCtx.ctx, tenantId, (args as { id: string }).id);
      return true;
    },
  },
};

