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

/** Forward the REST response as-is (same shape as templates.apply) so upstream
 *  errors — duplicate email → CONFLICT, unknown role → VALIDATION — surface
 *  with their codes instead of being swallowed. */
const passthrough = async (res: Response, what: string): Promise<ToolResult> => {
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) {
    throw new Error(`${what}: upstream returned non-JSON (status ${res.status})`);
  }
  return {
    content: [{ type: "text", text: JSON.stringify(body, null, 2) }],
    structuredContent: body,
    isError: !res.ok,
  };
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

export const inviteAppUser: McpTool = {
  name: "app_users.invite",
  description:
    "Invite a workspace end-user: creates a pending `app_users` row (status " +
    "`invited`, no credential), mints a 7-day one-shot invite token, and " +
    "best-effort mails it. Optionally bind app-plane roles (`roleIds` — the " +
    "admin role is rejected) and link a person row (`link` — stamps " +
    "`<collection>.<itemId>.app_user_id` so `$user.id` permission conditions " +
    "match after accept). The invitee accepts via " +
    "`POST /api/t/{slug}/auth/invite/accept` with `{ token, password }`. " +
    "Returns `{ id, email, token, expiresAt }`. Admin-only.",
  inputSchema: {
    type: "object",
    properties: {
      email: { type: "string", description: "Invitee email (stored lowercased)." },
      name: { type: "string" },
      roleIds: {
        type: "array",
        items: { type: "string" },
        description: "Role ids in this workspace to bind at invite time.",
      },
      link: {
        type: "object",
        properties: {
          collection: { type: "string" },
          itemId: { type: "string" },
        },
        required: ["collection", "itemId"],
        additionalProperties: false,
        description: "Person row whose `app_user_id` gets set to the invited user.",
      },
    },
    required: ["email"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const email = typeof args.email === "string" ? args.email : "";
    if (!email) throw new Error("VALIDATION: email is required");
    const body: Record<string, unknown> = { email };
    if (typeof args.name === "string") body.name = args.name;
    if (Array.isArray(args.roleIds)) body.roleIds = args.roleIds;
    if (args.link && typeof args.link === "object") body.link = args.link;
    const res = await ctx.fetchInternal(`/api/app-users/invite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return passthrough(res, "app_users.invite");
  },
};

export const appUsersTools: McpTool[] = [
  listAppUsers,
  setAppUserRoles,
  updateAppUser,
  inviteAppUser,
];
