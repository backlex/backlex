import type { McpTool, ToolResult } from "../types";
import { readJson } from "../internal-fetch";

const textResult = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: value as object,
});

/** Clamp + serialize a `days` window argument the same way every advisor tool
 *  does. Returns "" when the caller didn't pass one (server default applies). */
const daysParam = (raw: unknown): string => {
  const n = Number(raw);
  if (!Number.isFinite(n)) return "";
  return `days=${Math.min(90, Math.max(1, Math.floor(n)))}`;
};

export const advisorRun: McpTool = {
  name: "advisor.run",
  // "run" isn't a recognized read verb — pin the kind so read-only keys can
  // still lint the workspace.
  kind: "read",
  description:
    "Run the advisor (admin-only): security + performance findings for the " +
    "workspace, a 0–100 health score, and the runtime window behind the " +
    "traffic-derived rules. Findings that the server can fix itself carry an " +
    "`action`; pass their `id` to `advisor.apply`.",
  inputSchema: {
    type: "object",
    properties: {
      days: {
        type: "number",
        description:
          "Window in days for the traffic-derived performance rules (default 7, max 90).",
      },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const qs = daysParam(args.days);
    const res = await ctx.fetchInternal(`/api/admin/advisor${qs ? `?${qs}` : ""}`);
    const body = await readJson<unknown>(res);
    return textResult(body);
  },
};

export const advisorInsights: McpTool = {
  name: "advisor.insights",
  kind: "read",
  description:
    "Runtime query insights (admin-only) aggregated from recorded request " +
    "spans: per-endpoint latency percentiles (p50/p95/p99) and error rates, " +
    "plus per-collection list traffic and which columns it filters / sorts " +
    "on. Counts are spans actually seen and are never extrapolated — when " +
    "`window.sampleRate` is below 1 the numbers describe a sample.",
  inputSchema: {
    type: "object",
    properties: {
      days: {
        type: "number",
        description: "Aggregation window in days (default 7, max 90).",
      },
      limit: {
        type: "number",
        description: "Max endpoint rows, slowest first (default 50, max 200).",
      },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const qs = new URLSearchParams();
    const days = daysParam(args.days);
    if (days) qs.set("days", days.slice("days=".length));
    const limit = Number(args.limit);
    if (Number.isFinite(limit))
      qs.set("limit", String(Math.min(200, Math.max(1, Math.floor(limit)))));
    const suffix = qs.size > 0 ? `?${qs}` : "";
    const res = await ctx.fetchInternal(`/api/admin/advisor/insights${suffix}`);
    const body = await readJson<unknown>(res);
    return textResult(body);
  },
};

export const advisorApply: McpTool = {
  name: "advisor.apply",
  description:
    "Apply the remediation attached to an advisor finding (admin-only) — " +
    "today always `CREATE INDEX IF NOT EXISTS` on a collection's physical " +
    "table. Takes only the finding `id`: the server re-runs the advisor and " +
    "executes the statement that fresh finding carries, so a fix can't be " +
    "applied for a finding that no longer holds. Findings with no `action` " +
    "are rejected.",
  inputSchema: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "The `id` of a finding returned by `advisor.run`.",
      },
      days: {
        type: "number",
        description:
          "Window the finding was produced under, when it wasn't the default 7.",
      },
    },
    required: ["id"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const body: Record<string, unknown> = { id: args.id };
    const n = Number(args.days);
    if (Number.isFinite(n)) body.days = Math.min(90, Math.max(1, Math.floor(n)));
    const res = await ctx.fetchInternal(`/api/admin/advisor/apply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return textResult(await readJson<unknown>(res));
  },
};

export const advisorTools: McpTool[] = [advisorRun, advisorInsights, advisorApply];
