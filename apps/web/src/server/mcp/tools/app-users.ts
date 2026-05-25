import type { McpTool, ToolResult } from "../types";
import { readJson } from "../internal-fetch";

const textResult = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: value as object,
});

const requireId = (args: Record<string, unknown>): string => {
  const id = args.id;
  if (typeof id !== "string" || id.length === 0)
    throw new Error("VALIDATION: id is required");
  return id;
};

export const listAppUsers: McpTool = {
  name: "app_users.list",
  description:
    "List workspace end-users (the `app_users` pool — distinct from the " +
    "control-plane `users.list`). Includes email, status, last-login, and " +
    "assigned app-plane roles. Admin-only.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async (_args, ctx) => {
    const res = await ctx.fetchInternal(`/api/app-users`);
    const body = await readJson<unknown>(res);
    return textResult(body);
  },
};

export const setAppUserRoles: McpTool = {
  name: "app_users.set_roles",
  description:
    "Replace an app-user's role assignments with the given list. Empty " +
    "array strips every assigned role (leaving them with just the implicit " +
    "`authenticated` role). Admin-only.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      roleIds: { type: "array", description: "Array of role ids in this workspace." },
    },
    required: ["id", "roleIds"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const id = requireId(args);
    const roleIds = Array.isArray(args.roleIds) ? args.roleIds : null;
    if (!roleIds) throw new Error("VALIDATION: roleIds must be an array");
    const res = await ctx.fetchInternal(`/api/app-users/${encodeURIComponent(id)}/roles`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roleIds }),
    });
    const body = await readJson<unknown>(res);
    return textResult(body);
  },
};

export const updateAppUser: McpTool = {
  name: "app_users.update",
  description:
    "Patch an app-user's metadata (`name`, `status`). `status` can be " +
    "`active` or `suspended` — suspended users lose all access immediately.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      status: { type: "string", description: "`active` or `suspended`." },
    },
    required: ["id"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const id = requireId(args);
    const { id: _id, ...patch } = args as Record<string, unknown> & { id?: string };
    const res = await ctx.fetchInternal(`/api/app-users/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    const body = await readJson<unknown>(res);
    return textResult(body);
  },
};

export const appUsersTools: McpTool[] = [listAppUsers, setAppUserRoles, updateAppUser];
