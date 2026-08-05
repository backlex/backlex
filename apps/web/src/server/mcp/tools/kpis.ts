/**
 * KPI tools — the agent's route to a figure the dashboard would also show.
 *
 * These exist so an agent asked "how is revenue doing?" stops composing its
 * own `collections.aggregate` call. An improvised aggregate is a guess at the
 * definition — which rows count as revenue, whether refunds are netted, which
 * column carries the date — and the guess changes from question to question,
 * so the agent's answer and the dashboard's tile disagree while both sound
 * authoritative. `kpis.run` evaluates the stored definition through the same
 * `runKpi()` the tile does.
 */
import type { McpTool, ToolResult } from "../types";
import { readJson } from "../internal-fetch";

const textResult = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: value as object,
});

export const listKpis: McpTool = {
  name: "kpis.list",
  description:
    "List the workspace's named KPI definitions — the agreed formula behind each " +
    "figure. Each row shows slug, name, collection, aggregate, filter, date column, " +
    "grouping and how it should be printed. ALWAYS check this before composing a " +
    "`collections.aggregate` call: if a KPI already defines the figure, run it " +
    "instead, so your answer matches the number the dashboard shows.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async (_args, ctx) => {
    const res = await ctx.fetchInternal(`/api/admin/kpis`);
    const body = await readJson<unknown>(res);
    return textResult(body);
  },
};

export const getKpi: McpTool = {
  name: "kpis.get",
  description:
    "Fetch one KPI definition by slug (or id) without evaluating it — use when you " +
    "need to explain what a figure MEANS rather than what it currently is.",
  inputSchema: {
    type: "object",
    properties: {
      ref: { type: "string", description: "The KPI's slug, or its id." },
    },
    required: ["ref"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const ref = String(args.ref ?? "");
    if (!ref) throw new Error("VALIDATION: ref is required");
    const res = await ctx.fetchInternal(`/api/admin/kpis/${encodeURIComponent(ref)}`);
    const body = await readJson<unknown>(res);
    return textResult(body);
  },
};

export const runKpiTool: McpTool = {
  name: "kpis.run",
  description:
    "Evaluate a KPI over a window and the window immediately before it. Returns " +
    "`{ point: { value, previousValue, delta, deltaPct } }` for a plain figure, or " +
    "`{ rows: [...] }` for a grouped one (top products, revenue by country). " +
    "Read the result honestly: `window` is null when the KPI has no date column, " +
    "so there is NO period comparison to report; `deltaPct` is null when the " +
    "previous period was zero, which means there is no percentage to quote — say " +
    "the absolute change instead of inventing '+100%'. Scoped to your own read " +
    "permission on the KPI's collection.",
  inputSchema: {
    type: "object",
    properties: {
      ref: { type: "string", description: "The KPI's slug, or its id." },
      rangeDays: {
        type: "number",
        description: "Window length in days, ending now. Defaults to 30.",
      },
      from: { type: "number", description: "Window start, epoch ms. Overrides rangeDays." },
      to: { type: "number", description: "Window end, epoch ms. Defaults to now." },
      series: {
        type: "boolean",
        description:
          "Also return the window sliced into buckets (`series`), oldest first — the " +
          "shape behind the number. Costs one extra query, so ask only when the shape " +
          "is part of the answer. Null for a KPI with no date column or a grouped one.",
      },
      buckets: { type: "number", description: "How many slices (2-200, default 24)." },
    },
    required: ["ref"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const ref = String(args.ref ?? "");
    if (!ref) throw new Error("VALIDATION: ref is required");
    const qs = new URLSearchParams();
    for (const key of ["rangeDays", "from", "to", "series", "buckets"] as const) {
      const v = args[key];
      if (v !== undefined && v !== null) qs.set(key, String(v));
    }
    const suffix = qs.toString() ? `?${qs}` : "";
    const res = await ctx.fetchInternal(
      `/api/admin/kpis/${encodeURIComponent(ref)}/run${suffix}`,
    );
    const parsed = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!parsed) {
      throw new Error(`kpis.run: upstream returned non-JSON (status ${res.status})`);
    }
    return {
      content: [{ type: "text", text: JSON.stringify(parsed, null, 2) }],
      structuredContent: parsed,
      isError: !res.ok,
    };
  },
};

export const kpisTools: McpTool[] = [listKpis, getKpi, runKpiTool];
