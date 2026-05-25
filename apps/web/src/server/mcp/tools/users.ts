import type { McpTool, ToolResult } from "../types";
import { readJson } from "../internal-fetch";

const textResult = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: value as object,
});

export const listUsers: McpTool = {
  name: "users.list",
  description:
    "List control-plane users in the active workspace. Returns id, email, " +
    "name, status, last login, and assigned role names. Admin-only.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async (_args, ctx) => {
    const res = await ctx.fetchInternal(`/api/users`);
    const body = await readJson<unknown>(res);
    return textResult(body);
  },
};

export const inviteUser: McpTool = {
  name: "users.invite",
  description:
    "Invite a user to the active workspace by email. The user receives " +
    "an invitation email and lands in the workspace with the role you " +
    "name in `roleName` (defaults to `authenticated`). Idempotent — " +
    "inviting an already-member user is a no-op.",
  inputSchema: {
    type: "object",
    properties: {
      email: { type: "string" },
      roleName: { type: "string", description: "Role to assign on join." },
    },
    required: ["email"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const res = await ctx.fetchInternal(`/api/users/invite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args),
    });
    const body = await readJson<unknown>(res);
    return textResult(body);
  },
};

export const suspendUser: McpTool = {
  name: "users.suspend",
  description:
    "Suspend a user — they lose all access until reactivated. Existing " +
    "sessions are NOT revoked here; pair with `users.revoke_sessions` " +
    "for hard cut-off. Returns `{ ok: true }`.",
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
      `/api/users/${encodeURIComponent(id)}/suspend`,
      { method: "PATCH" },
    );
    const body = await readJson<unknown>(res);
    return textResult(body);
  },
};

export const activateUser: McpTool = {
  name: "users.activate",
  description: "Reactivate a previously-suspended user.",
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
      `/api/users/${encodeURIComponent(id)}/activate`,
      { method: "PATCH" },
    );
    const body = await readJson<unknown>(res);
    return textResult(body);
  },
};

export const usersTools: McpTool[] = [listUsers, inviteUser, suspendUser, activateUser];
