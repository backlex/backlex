import type { McpTool, ToolResult } from "../types";
import { readJson } from "../internal-fetch";

/**
 * Broadcast channels over MCP. Every tool proxies the REST routes through
 * `fetchInternal`, so the caller's identity and the workspace scoping come
 * from one implementation rather than being restated per surface.
 *
 * `channels.explain` is the one an agent reaches for most: "why can't my app
 * subscribe to `chat:room:1`" is answered by which rule matched (or that none
 * did), without opening a stream to find out.
 */
const textResult = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: value as object,
});

const ADMIN = "/api/admin/realtime-channels";
const rt = (channel: string) => `/api/realtime/${encodeURIComponent(channel)}`;

const ACCESS_SCHEMA = {
  type: "object",
  properties: {
    access: { type: "string", enum: ["none", "public", "authenticated", "roles"] },
    roles: { type: "array", items: { type: "string" } },
    condition: { type: "object" },
  },
  required: ["access"],
  additionalProperties: false,
} as const;

export const listChannelsTool: McpTool = {
  name: "channels.list",
  description:
    "List the workspace's broadcast channel rules — the patterns that decide who may subscribe to " +
    "and publish on application-owned realtime channels. A channel with no matching rule is refused " +
    "in both directions, so start here when a subscribe or publish is being rejected.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async (_args, ctx) =>
    textResult(await readJson<unknown>(await ctx.fetchInternal(ADMIN))),
};

export const createChannelTool: McpTool = {
  name: "channels.create",
  description:
    "Create a broadcast channel rule. `pattern` is colon-separated segments: a literal, `*` (one " +
    "segment), `**` (the rest, last only) or `{name}` (one segment, captured). A capture is " +
    "readable by `condition` as a plain field — on `org:{org}:feed`, " +
    '`{"org":{"_eq":"$org.id"}}` means the org segment must be the caller\'s active org. ' +
    "The first segment must be a literal and may not be one the managed channels own.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string" },
      pattern: { type: "string" },
      subscribe: ACCESS_SCHEMA,
      publish: ACCESS_SCHEMA,
      presence: { type: "boolean" },
      replay: { type: "boolean" },
      retentionHours: { type: "number", minimum: 1, maximum: 72 },
      enabled: { type: "boolean" },
    },
    required: ["name", "pattern", "subscribe", "publish"],
    additionalProperties: false,
  },
  handler: async (args, ctx) =>
    textResult(
      await readJson<unknown>(
        await ctx.fetchInternal(ADMIN, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(args),
        }),
      ),
    ),
};

export const updateChannelTool: McpTool = {
  name: "channels.update",
  description: "Update a broadcast channel rule. Only the fields you send are changed.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      pattern: { type: "string" },
      subscribe: ACCESS_SCHEMA,
      publish: ACCESS_SCHEMA,
      presence: { type: "boolean" },
      replay: { type: "boolean" },
      retentionHours: { type: "number", minimum: 1, maximum: 72 },
      enabled: { type: "boolean" },
    },
    required: ["id"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const { id, ...patch } = args as Record<string, unknown>;
    return textResult(
      await readJson<unknown>(
        await ctx.fetchInternal(`${ADMIN}/${encodeURIComponent(String(id))}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(patch),
        }),
      ),
    );
  },
};

export const deleteChannelTool: McpTool = {
  name: "channels.delete",
  description:
    "Delete a broadcast channel rule. The channels it matched stop being reachable from the next " +
    "request — a rule is the only thing that makes them reachable at all.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
  handler: async (args, ctx) =>
    textResult(
      await readJson<unknown>(
        await ctx.fetchInternal(`${ADMIN}/${encodeURIComponent(String(args.id))}`, {
          method: "DELETE",
        }),
      ),
    ),
};

export const explainChannelTool: McpTool = {
  name: "channels.explain",
  description:
    "Explain which rule governs a channel name and whether the calling identity may subscribe or " +
    "publish. Answers the question a failing subscribe raises — no rule matched, the pattern did " +
    "not match the way you expected, or the condition refused this caller.",
  inputSchema: {
    type: "object",
    properties: { channel: { type: "string" } },
    required: ["channel"],
    additionalProperties: false,
  },
  handler: async (args, ctx) =>
    textResult(
      await readJson<unknown>(
        await ctx.fetchInternal(`${rt(String(args.channel))}/explain`),
      ),
    ),
};

export const publishChannelTool: McpTool = {
  name: "channels.publish",
  description:
    "Publish a message on an application-owned channel. The sender identity is stamped from the " +
    "caller's session server-side, so it cannot be forged.",
  inputSchema: {
    type: "object",
    properties: {
      channel: { type: "string" },
      event: { type: "string" },
      data: {},
    },
    required: ["channel", "data"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const { channel, ...body } = args as Record<string, unknown>;
    return textResult(
      await readJson<unknown>(
        await ctx.fetchInternal(`${rt(String(channel))}/publish`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      ),
    );
  },
};

export const channelHistoryTool: McpTool = {
  name: "channels.history",
  description:
    "Read a channel's retained messages, oldest first, at most 25 per call — pass the returned " +
    "`cursor` back as `since`. Only available on a rule with replay on, and never further back " +
    "than its retention window.",
  inputSchema: {
    type: "object",
    properties: {
      channel: { type: "string" },
      since: { type: "string" },
      limit: { type: "number", minimum: 1, maximum: 25 },
    },
    required: ["channel"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const q = new URLSearchParams();
    if (args.since) q.set("since", String(args.since));
    if (args.limit) q.set("limit", String(args.limit));
    const qs = q.toString();
    return textResult(
      await readJson<unknown>(
        await ctx.fetchInternal(`${rt(String(args.channel))}/replay${qs ? `?${qs}` : ""}`),
      ),
    );
  },
};

export const channelsTools: McpTool[] = [
  listChannelsTool,
  createChannelTool,
  updateChannelTool,
  deleteChannelTool,
  explainChannelTool,
  publishChannelTool,
  channelHistoryTool,
];
