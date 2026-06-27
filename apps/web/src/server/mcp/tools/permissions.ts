import type { McpTool, ToolResult } from "../types";
import { readJson } from "../internal-fetch";

const textResult = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: value as object,
});

export const listRolePermissions: McpTool = {
  name: "permissions.list_for_role",
  description:
    "List the permission rows attached to a role. Each row pairs " +
    "(collection, action) with an optional condition (DSL) and field " +
    "allow-list. Use `roles.list` first to find the role id.",
  inputSchema: {
    type: "object",
    properties: {
      roleId: { type: "string" },
    },
    required: ["roleId"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const roleId = String(args.roleId ?? "");
    if (!roleId) throw new Error("VALIDATION: roleId is required");
    const res = await ctx.fetchInternal(
      `/api/roles/${encodeURIComponent(roleId)}/permissions`,
    );
    const body = await readJson<unknown>(res);
    return textResult(body);
  },
};

export const grantPermission: McpTool = {
  name: "permissions.grant",
  description:
    "Create a permission row on a role — binds (collection, action) with an " +
    "optional `condition` (permission DSL) and `fields` allow-list. Returns " +
    "the created row.",
  inputSchema: {
    type: "object",
    properties: {
      roleId: { type: "string" },
      collection: { type: "string", description: "Collection slug or `*` for any." },
      action: {
        type: "string",
        description: "One of `create`, `read`, `update`, `delete`.",
      },
      condition: {
        type: "object",
        description:
          "DSL condition map (`{field: {_eq: ...}}`, `_and`, `_or`, `$user.id`). " +
          "Omit for unconditional access.",
      },
      fields: {
        type: "array",
        description: "Optional field allow-list (omit for all fields).",
      },
    },
    required: ["roleId", "collection", "action"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const roleId = String(args.roleId ?? "");
    if (!roleId) throw new Error("VALIDATION: roleId is required");
    const { roleId: _r, ...payload } = args as Record<string, unknown>;
    const res = await ctx.fetchInternal(
      `/api/roles/${encodeURIComponent(roleId)}/permissions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      },
    );
    const body = await readJson<unknown>(res);
    return textResult(body);
  },
};

export const revokePermission: McpTool = {
  name: "permissions.revoke",
  description:
    "Delete a permission row by id. Use `permissions.list_for_role` to find ids.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Permission row id." },
    },
    required: ["id"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const id = String(args.id ?? "");
    if (!id) throw new Error("VALIDATION: id is required");
    const res = await ctx.fetchInternal(
      `/api/permissions/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
    const body = await readJson<unknown>(res);
    return textResult(body);
  },
};

export const simulatePermission: McpTool = {
  name: "permissions.simulate",
  description:
    "Dry-run the permission resolver: would a subject be allowed to perform " +
    "an action on a collection, and why? The subject is either an existing " +
    "user (`userId` — roles read live from the DB) or ad-hoc role names " +
    "(`roles`). Returns the full trace: matched roles + permission rules, the " +
    "resolved DSL variables ($user.id, $tenant.id, …), the compiled WHERE " +
    "clause, the field allow-list, and the allow/deny decision. Pass " +
    "`sampleRow` to test one concrete row against the combined condition. " +
    "Read-only — never changes state. Great for debugging 'why can't user X " +
    "read posts?'.",
  kind: "read",
  inputSchema: {
    type: "object",
    properties: {
      userId: { type: "string", description: "Existing user id to test as." },
      email: {
        type: "string",
        description: "Override email for `$user.email` (optional).",
      },
      roles: {
        type: "array",
        description:
          "Ad-hoc role names to test as (ignored when `userId` is set).",
      },
      plane: {
        type: "string",
        description: "`platform` (admin users, default) or `app` (end-users).",
      },
      collection: { type: "string", description: "Collection slug or `*`." },
      action: {
        type: "string",
        description: "One of `read`, `create`, `update`, `delete`, `publish`.",
      },
      sampleRow: {
        type: "object",
        description: "Optional row to evaluate against the combined condition.",
      },
    },
    required: ["collection", "action"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const collection = String(args.collection ?? "");
    const action = String(args.action ?? "");
    if (!collection) throw new Error("VALIDATION: collection is required");
    if (!action) throw new Error("VALIDATION: action is required");
    const res = await ctx.fetchInternal("/api/permissions/simulate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args),
    });
    const body = await readJson<unknown>(res);
    return textResult(body);
  },
};

export const permissionsTools: McpTool[] = [
  listRolePermissions,
  grantPermission,
  revokePermission,
  simulatePermission,
];
