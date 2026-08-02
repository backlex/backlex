import type { McpTool, ToolResult } from "../types";
import { readJson } from "../internal-fetch";

const textResult = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: value as object,
});

export const listDashboards: McpTool = {
  name: "dashboards.list",
  description:
    "List embedded BI dashboards in the active workspace. Each row shows id, " +
    "name, description, and whether a public embed is enabled. Use " +
    "`dashboards.run` to render one's panels.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async (_args, ctx) => {
    const res = await ctx.fetchInternal(`/api/admin/dashboards`);
    const body = await readJson<unknown>(res);
    return textResult(body);
  },
};

export const getDashboard: McpTool = {
  name: "dashboards.get",
  description: "Fetch a single dashboard's definition by id.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const id = String(args.id ?? "");
    if (!id) throw new Error("VALIDATION: id is required");
    const res = await ctx.fetchInternal(
      `/api/admin/dashboards/${encodeURIComponent(id)}`,
    );
    const body = await readJson<unknown>(res);
    return textResult(body);
  },
};

export const runDashboard: McpTool = {
  name: "dashboards.run",
  description:
    "Run every panel in a dashboard and return their results. Each entry has " +
    "`{ panelId, name, viz, kind, data, error? }`.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const id = String(args.id ?? "");
    if (!id) throw new Error("VALIDATION: id is required");
    const res = await ctx.fetchInternal(
      `/api/admin/dashboards/${encodeURIComponent(id)}/run`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    const body = (await res.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body) {
      throw new Error(
        `dashboards.run: upstream returned non-JSON (status ${res.status})`,
      );
    }
    return {
      content: [{ type: "text", text: JSON.stringify(body, null, 2) }],
      structuredContent: body,
      isError: !res.ok,
    };
  },
};

export const deliverDashboardReport: McpTool = {
  name: "dashboards.report",
  description:
    "Print a dashboard to a PDF and store it. Pass `email.to` (one address or a comma-separated " +
    "list) to mail it as an attachment, one message per recipient. Returns the storage key, size " +
    "and how many panels ran — including how many FAILED, which the PDF prints rather than hides. " +
    "Errors when the deployment has no PDF renderer configured.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Dashboard id" },
      filename: { type: "string", description: "Defaults to <dashboard>-<date>.pdf" },
      email: {
        type: "object",
        properties: {
          to: { type: "string" },
          subject: { type: "string" },
          templateKey: { type: "string" },
        },
        required: ["to"],
        additionalProperties: false,
      },
      pageOptions: {
        type: "object",
        properties: {
          format: { type: "string", enum: ["A4", "Letter", "Legal", "A3", "A5"] },
          landscape: { type: "boolean" },
          printBackground: { type: "boolean" },
        },
        additionalProperties: false,
      },
    },
    required: ["id"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const id = String(args.id ?? "");
    if (!id) throw new Error("VALIDATION: id is required");
    const { id: _id, ...body } = args as Record<string, unknown>;
    const res = await ctx.fetchInternal(
      `/api/admin/dashboards/${encodeURIComponent(id)}/report`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    const parsed = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!parsed) {
      throw new Error(`dashboards.report: upstream returned non-JSON (status ${res.status})`);
    }
    return {
      content: [{ type: "text", text: JSON.stringify(parsed, null, 2) }],
      structuredContent: parsed,
      isError: !res.ok,
    };
  },
};

export const dashboardsTools: McpTool[] = [
  listDashboards,
  getDashboard,
  runDashboard,
  deliverDashboardReport,
];
