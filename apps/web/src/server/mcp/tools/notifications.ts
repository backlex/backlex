import type { McpTool, ToolResult } from "../types";
import { readJson } from "../internal-fetch";

const textResult = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: value as object,
});

export const listNotifications: McpTool = {
  name: "notifications.list",
  description:
    "List notifications addressed to the active user. Returns id, kind, " +
    "title, body, link, read state, and timestamp. Supports `unreadOnly` " +
    "and `limit`.",
  inputSchema: {
    type: "object",
    properties: {
      unreadOnly: { type: "boolean" },
      limit: { type: "number" },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const qs = new URLSearchParams();
    if (args.unreadOnly === true) qs.set("unread_only", "true");
    if (typeof args.limit === "number") qs.set("limit", String(args.limit));
    const path = `/api/notifications` + (qs.toString() ? `?${qs.toString()}` : "");
    const res = await ctx.fetchInternal(path);
    const body = await readJson<unknown>(res);
    return textResult(body);
  },
};

export const sendNotification: McpTool = {
  name: "notifications.send",
  description:
    "Send a notification to one or more users in the active workspace. " +
    "`recipients` is an array of user ids. `kind` is a free-form label.",
  inputSchema: {
    type: "object",
    properties: {
      recipients: { type: "array", description: "Array of recipient user ids." },
      kind: { type: "string" },
      title: { type: "string" },
      body: { type: "string" },
      link: { type: "string", description: "Optional deep-link URL." },
      data: { type: "object", description: "Optional structured payload." },
    },
    required: ["recipients", "title"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const res = await ctx.fetchInternal(`/api/notifications`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args),
    });
    const body = await readJson<unknown>(res);
    return textResult(body);
  },
};

export const markRead: McpTool = {
  name: "notifications.mark_read",
  description:
    "Mark a single notification as read by id, or all of the user's " +
    "notifications when `all: true` is supplied.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      all: { type: "boolean" },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const path = args.all === true
      ? `/api/notifications/_read-all`
      : `/api/notifications/${encodeURIComponent(String(args.id ?? ""))}/read`;
    if (args.all !== true && !args.id) {
      throw new Error("VALIDATION: id is required (or pass all: true)");
    }
    const res = await ctx.fetchInternal(path, { method: "POST" });
    const body = await readJson<unknown>(res);
    return textResult(body);
  },
};

export const notificationsTools: McpTool[] = [
  listNotifications,
  sendNotification,
  markRead,
];
