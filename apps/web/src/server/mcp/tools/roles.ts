import type { McpTool, ToolResult } from "../types";
import { readJson } from "../internal-fetch";

const textResult = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: value as object,
});

export const listRoles: McpTool = {
  name: "roles.list",
  description:
    "List every role in the active workspace. Returns id, name, " +
    "admin-flag, and metadata. Use this to discover role ids before " +
    "assigning to users or attaching permissions.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async (_args, ctx) => {
    const res = await ctx.fetchInternal(`/api/roles`);
    const body = await readJson<unknown>(res);
    return textResult(body);
  },
};

export const createRole: McpTool = {
  name: "roles.create",
  description:
    "Create a role in the active workspace. `name` is a free-form label; " +
    "`admin: true` grants DSL bypass — be careful with that flag.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string" },
      description: { type: "string" },
      admin: { type: "boolean" },
    },
    required: ["name"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const res = await ctx.fetchInternal(`/api/roles`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args),
    });
    const body = await readJson<unknown>(res);
    return textResult(body);
  },
};

export const assignRole: McpTool = {
  name: "roles.assign",
  description:
    "Assign a role to a user. The user must already exist in the tenant. " +
    "Idempotent: re-assigning the same role is a no-op.",
  inputSchema: {
    type: "object",
    properties: {
      userId: { type: "string" },
      roleId: { type: "string" },
    },
    required: ["userId", "roleId"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const userId = String(args.userId ?? "");
    const roleId = String(args.roleId ?? "");
    if (!userId || !roleId)
      throw new Error("VALIDATION: userId and roleId are required");
    const res = await ctx.fetchInternal(
      `/api/users/${encodeURIComponent(userId)}/roles`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roleId }),
      },
    );
    const body = await readJson<unknown>(res);
    return textResult(body);
  },
};

export const unassignRole: McpTool = {
  name: "roles.unassign",
  description: "Remove a role from a user. No-op when the assignment doesn't exist.",
  inputSchema: {
    type: "object",
    properties: {
      userId: { type: "string" },
      roleId: { type: "string" },
    },
    required: ["userId", "roleId"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const userId = String(args.userId ?? "");
    const roleId = String(args.roleId ?? "");
    if (!userId || !roleId)
      throw new Error("VALIDATION: userId and roleId are required");
    const res = await ctx.fetchInternal(
      `/api/users/${encodeURIComponent(userId)}/roles/${encodeURIComponent(roleId)}`,
      { method: "DELETE" },
    );
    const body = await readJson<unknown>(res);
    return textResult(body);
  },
};

export const rolesTools: McpTool[] = [listRoles, createRole, assignRole, unassignRole];
