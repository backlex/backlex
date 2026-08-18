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

const SITE_PROPS = {
  name: { type: "string", description: "Display name." },
  domain: {
    type: "string",
    description:
      "Bare host. A full URL or a host:port is accepted and reduced to the host.",
  },
  excludedPaths: {
    type: "array",
    items: { type: "string" },
    description: "Paths never recorded. Supports a leading or trailing `*`.",
  },
  ignoredIps: {
    type: "array",
    items: { type: "string" },
    description: "Source IPs never recorded — an office, a monitoring probe.",
  },
  filterBots: {
    type: "boolean",
    description: "Drop declared crawlers instead of labelling them `bot`.",
  },
  requireKnownOrigin: {
    type: "boolean",
    description:
      "Refuse events whose origin is not the registered domain. Stops a snippet copied onto a staging host; `Origin` is forgeable, so it is not a security boundary.",
  },
} as const;

export const analyticsRealtimeTool: McpTool = {
  name: "analytics.realtime",
  kind: "read",
  description:
    "Who is on the site right now: the last 30 minutes bucketed by minute and " +
    "zero-filled, plus the top paths, referrers and countries inside that " +
    "window. `truncated` is true when a row cap bit, which makes the counts a " +
    "floor rather than a total. Optionally scoped to one registered site.",
  inputSchema: {
    type: "object",
    properties: {
      siteId: { type: "string", description: "Limit to one registered site." },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const res = await ctx.fetchInternal(
      `/api/admin/analytics/realtime${qs(args, ["siteId"])}`,
    );
    return textResult(await readJson<unknown>(res));
  },
};

export const analyticsSites: McpTool = {
  name: "analytics.sites",
  kind: "read",
  description:
    "Websites registered for tag-based measurement. Each site's id is what ships " +
    "in the public `<script>` snippet.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async (_args, ctx) => {
    const res = await ctx.fetchInternal("/api/admin/analytics/sites");
    return textResult(await readJson<unknown>(res));
  },
};

export const analyticsSiteCreate: McpTool = {
  name: "analytics.site_create",
  kind: "write",
  description:
    "Register a website. Returns the site, whose `id` goes into the snippet's " +
    "`data-site` attribute.",
  inputSchema: {
    type: "object",
    properties: { ...SITE_PROPS },
    required: ["name", "domain"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const res = await ctx.fetchInternal("/api/admin/analytics/sites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args ?? {}),
    });
    return textResult(await readJson<unknown>(res));
  },
};

export const analyticsSiteUpdate: McpTool = {
  name: "analytics.site_update",
  kind: "write",
  description: "Update a registered website's settings.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" }, ...SITE_PROPS },
    required: ["id"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const { id, ...patch } = (args ?? {}) as Record<string, unknown>;
    const res = await ctx.fetchInternal(
      `/api/admin/analytics/sites/${encodeURIComponent(String(id))}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      },
    );
    return textResult(await readJson<unknown>(res));
  },
};

export const analyticsSiteDelete: McpTool = {
  name: "analytics.site_delete",
  kind: "write",
  description:
    "Remove a registered website. Its snippet stops being accepted immediately; " +
    "events already recorded are pruned on the normal retention schedule.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const id = String((args as { id?: unknown })?.id ?? "");
    const res = await ctx.fetchInternal(
      `/api/admin/analytics/sites/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
    return textResult(await readJson<unknown>(res));
  },
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
  analyticsRealtimeTool,
  analyticsSites,
  analyticsSiteCreate,
  analyticsSiteUpdate,
  analyticsSiteDelete,
  analyticsEventNames,
  analyticsFunnel,
  analyticsRetention,
  analyticsEvents,
  listErrorGroups,
  getErrorGroup,
  updateErrorGroup,
  deleteErrorGroup,
];
