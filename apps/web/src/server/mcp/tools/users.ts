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
    "Invite a user to the active workspace by email. They receive an " +
    "invitation and, on accepting, join with the membership standing named " +
    "in `workspaceRole` (`owner` | `admin` | `member`, default `member`). " +
    "Granting a standing above your own is refused. Idempotent — inviting " +
    "someone who is already a member is a no-op.",
  inputSchema: {
    type: "object",
    properties: {
      email: { type: "string" },
      workspaceRole: {
        type: "string",
        enum: ["owner", "admin", "member"],
        description:
          "Membership standing — what the invitee may do to the workspace itself.",
      },
    },
    required: ["email"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    // The property was `roleName`, and `UserInviteInput` has never had a field
    // by that name. `.strict()` was not in play, so zod stripped it silently
    // and every invitation this tool ever sent used the default standing while
    // the description promised otherwise — a 2xx that did nothing, which is the
    // house failure mode. The name now matches the route's own schema, and
    // `tenant-membership-surfaces.test.ts` drives the tool rather than the
    // route so a rename cannot re-open the gap.
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
