/**
 * Product analytics + crash reporting over MCP (#22).
 *
 * Thin wrappers over the admin REST endpoints (which in turn call the one
 * shared `services/analytics`), so an agent sees exactly what the admin UI
 * does. The reporting verbs (`overview`, `funnel`, `retention`, `events`)
 * carry an explicit `kind: "read"` — the name heuristic defaults unknown verbs
 * to `write`, which would wrongly block them for read-only keys.
 */
import type { McpTool, ToolResult } from "../types";
import { readJson } from "../internal-fetch";

const textResult = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: value as object,
});

/** Build a `?from=…&to=…` style query string from the tool args. */
const qs = (args: Record<string, unknown>, keys: string[]): string => {
  const params = new URLSearchParams();
  for (const k of keys) {
    const v = args[k];
    if (v !== undefined && v !== null && v !== "") params.set(k, String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : "";
};

const RANGE_PROPS = {
  from: { type: "number", description: "Inclusive epoch-ms lower bound." },
  to: { type: "number", description: "Inclusive epoch-ms upper bound." },
} as const;

const postJson = async (
  ctx: Parameters<McpTool["handler"]>[1],
  path: string,
  body: unknown,
  label: string,
): Promise<ToolResult> => {
  const res = await ctx.fetchInternal(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed = (await res.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!parsed) {
    throw new Error(`${label}: upstream returned non-JSON (status ${res.status})`);
  }
  return {
    content: [{ type: "text", text: JSON.stringify(parsed, null, 2) }],
    structuredContent: parsed,
    isError: !res.ok,
  };
};

export const analyticsOverview: McpTool = {
  name: "analytics.overview",
  kind: "read",
  description:
    "Product analytics overview for a time range: total events, unique visitors " +
    "and sessions, a zero-filled daily series, and the top event names, paths, " +
    "referrers and sources. Visitors are counted by anonymous `distinctId`, so " +
    "pre-signup traffic is included. Defaults to the last 30 days.",
  inputSchema: {
    type: "object",
    properties: { ...RANGE_PROPS },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const res = await ctx.fetchInternal(
      `/api/admin/analytics/overview${qs(args, ["from", "to"])}`,
    );
    return textResult(await readJson<unknown>(res));
  },
};

export const analyticsEventNames: McpTool = {
  name: "analytics.event_names",
  kind: "read",
  description:
    "Distinct tracked event names ordered by volume — the vocabulary available " +
    "as funnel steps or as a retention `event` filter.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async (_args, ctx) => {
    const res = await ctx.fetchInternal("/api/admin/analytics/event-names");
    return textResult(await readJson<unknown>(res));
  },
};

export const analyticsFunnel: McpTool = {
  name: "analytics.funnel",
  kind: "read",
  description:
    "Run an ordered conversion funnel over 2–8 event names. A visitor counts at " +
    "a step only if they fired it after the previous step and within " +
    "`windowDays` of their own entry. Returns per-step counts, conversion share " +
    "and drop-off.",
  inputSchema: {
    type: "object",
    properties: {
      steps: {
        type: "array",
        items: { type: "string" },
        description: "Event names, in order. Between 2 and 8.",
      },
      windowDays: {
        type: "number",
        description: "Days a visitor has to complete the funnel. Default 7.",
      },
      ...RANGE_PROPS,
    },
    required: ["steps"],
    additionalProperties: false,
  },
  handler: async (args, ctx) =>
    postJson(ctx, "/api/admin/analytics/funnel", args, "analytics.funnel"),
};

export const analyticsRetention: McpTool = {
  name: "analytics.retention",
  kind: "read",
  description:
    "Cohort retention grid. Visitors are grouped by their first-ever active day, " +
    "and each cohort's `values[n]` is how many were still active n days later. " +
    "Pass `event` to define activity as one specific event.",
  inputSchema: {
    type: "object",
    properties: {
      event: {
        type: "string",
        description: "Optional event name that defines 'active'.",
      },
      ...RANGE_PROPS,
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) =>
    postJson(ctx, "/api/admin/analytics/retention", args, "analytics.retention"),
};

export const analyticsEvents: McpTool = {
  name: "analytics.events",
  kind: "read",
  description:
    "Recent raw tracked events — the debug view behind the aggregates. Filter by " +
    "event `name` and/or `distinctId` to check what a client is actually sending.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string" },
      distinctId: { type: "string" },
      limit: { type: "number", description: "Max rows (1–500). Default 100." },
      ...RANGE_PROPS,
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const res = await ctx.fetchInternal(
      `/api/admin/analytics/events${qs(args, ["name", "distinctId", "limit", "from", "to"])}`,
    );
    return textResult(await readJson<unknown>(res));
  },
};

export const listErrorGroups: McpTool = {
  name: "errors.list",
  description:
    "List deduplicated crash groups, most recently seen first. Each group folds " +
    "every occurrence of one bug (matched by type + normalized message + top " +
    "stack frames) and carries a lifetime `events` counter.",
  inputSchema: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["open", "resolved", "ignored"] },
      level: { type: "string", enum: ["error", "warning", "fatal"] },
      since: {
        type: "number",
        description: "Only groups last seen at/after this epoch-ms.",
      },
      limit: { type: "number", description: "Max rows (1–200). Default 50." },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const res = await ctx.fetchInternal(
      `/api/admin/analytics/errors${qs(args, ["status", "level", "since", "limit"])}`,
    );
    return textResult(await readJson<unknown>(res));
  },
};

export const getErrorGroup: McpTool = {
  name: "errors.get",
  description:
    "One crash group with its most recent occurrences (stack traces and context), " +
    "a per-day occurrence series and the number of distinct visitors affected.",
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
      `/api/admin/analytics/errors/${encodeURIComponent(id)}`,
    );
    return textResult(await readJson<unknown>(res));
  },
};

export const updateErrorGroup: McpTool = {
  name: "errors.update",
  description:
    "Triage a crash group: set its status to open, resolved or ignored. A later " +
    "occurrence reopens a resolved group (regressions are news); an ignored group " +
    "stays ignored.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      status: { type: "string", enum: ["open", "resolved", "ignored"] },
    },
    required: ["id", "status"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const id = String(args.id ?? "");
    if (!id) throw new Error("VALIDATION: id is required");
    const res = await ctx.fetchInternal(
      `/api/admin/analytics/errors/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: args.status }),
      },
    );
    return textResult(await readJson<unknown>(res));
  },
};

export const deleteErrorGroup: McpTool = {
  name: "errors.delete",
  description:
    "Delete a crash group and every captured occurrence. If the bug recurs it " +
    "comes back as a fresh group.",
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
      `/api/admin/analytics/errors/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
    return textResult(await readJson<unknown>(res));
  },
};

export const analyticsTools: McpTool[] = [
  analyticsOverview,
  analyticsEventNames,
  analyticsFunnel,
  analyticsRetention,
  analyticsEvents,
  listErrorGroups,
  getErrorGroup,
  updateErrorGroup,
  deleteErrorGroup,
];
