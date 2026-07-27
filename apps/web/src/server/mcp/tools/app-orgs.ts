import type { McpTool, ToolResult } from "../types";

/**
 * App-plane organizations ("teams"). Admin-scoped mirror of REST
 * `/api/app-orgs`, GraphQL `appOrgs`/`createAppOrg`/… and SDK `client.orgs.*`.
 *
 * Every tool proxies the REST route through `fetchInternal`, so the service's
 * guards (last-owner protection, admin-role rejection on org-scoped grants)
 * apply identically here — this file adds no authorization logic of its own.
 */

/** Forward the REST response as-is so upstream codes — CONFLICT on a duplicate
 *  invite, VALIDATION on demoting the last owner — reach the caller intact
 *  instead of being flattened into a generic failure. */
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

const requireString = (args: Record<string, unknown>, key: string): string => {
  const v = args[key];
  if (typeof v !== "string" || v.length === 0)
    throw new Error(`VALIDATION: ${key} is required`);
  return v;
};

const enc = encodeURIComponent;

const ORG_ID_PROP = {
  type: "string",
  description: "Organization id or slug.",
} as const;

const ROLE_PROP = {
  type: "string",
  description:
    "Membership role: `owner` (may delete + transfer), `admin` (may invite + manage members), or `member`. Defaults to `member`.",
} as const;

const ROLE_IDS_PROP = {
  type: "array",
  items: { type: "string" },
  description:
    "Workspace role ids bound to this member WITHIN this org. Org-scoped: the same person can hold different roles in different orgs. The workspace admin role is rejected.",
} as const;

export const listAppOrgs: McpTool = {
  name: "app_orgs.list",
  description:
    "List organizations in the active workspace with their member counts. An " +
    "org is the B2B grouping level inside a workspace — its members are " +
    "`app_users` (end-users), not control-plane users. Admin-only.",
  inputSchema: {
    type: "object",
    properties: { q: { type: "string", description: "Name/slug substring filter." } },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const q = typeof args.q === "string" && args.q ? `?q=${enc(args.q)}` : "";
    return passthrough(await ctx.fetchInternal(`/api/app-orgs${q}`), "app_orgs.list");
  },
};

export const getAppOrg: McpTool = {
  name: "app_orgs.get",
  description: "Fetch one organization by id or slug. Admin-only.",
  inputSchema: {
    type: "object",
    properties: { id: ORG_ID_PROP },
    required: ["id"],
    additionalProperties: false,
  },
  handler: async (args, ctx) =>
    passthrough(
      await ctx.fetchInternal(`/api/app-orgs/${enc(requireString(args, "id"))}`),
      "app_orgs.get",
    ),
};

export const createAppOrg: McpTool = {
  name: "app_orgs.create",
  description:
    "Create an organization. `slug` is derived from `name` (and auto-suffixed " +
    "on collision) unless given explicitly. `ownerAppUserId` seeds the first " +
    "`owner` member; omit it to create an empty org. Admin-only.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string" },
      slug: { type: "string", description: "Optional explicit URL handle." },
      image: { type: "string" },
      ownerAppUserId: {
        type: "string",
        description: "`app_users.id` of the end-user who becomes the first owner.",
      },
    },
    required: ["name"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const body: Record<string, unknown> = { name: requireString(args, "name") };
    if (typeof args.slug === "string") body.slug = args.slug;
    if (typeof args.image === "string") body.image = args.image;
    if (typeof args.ownerAppUserId === "string") body.ownerAppUserId = args.ownerAppUserId;
    return passthrough(
      await ctx.fetchInternal("/api/app-orgs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      "app_orgs.create",
    );
  },
};

export const updateAppOrg: McpTool = {
  name: "app_orgs.update",
  description: "Rename, re-slug or restyle an organization. Admin-only.",
  inputSchema: {
    type: "object",
    properties: {
      id: ORG_ID_PROP,
      name: { type: "string" },
      slug: { type: "string" },
      image: { type: "string" },
    },
    required: ["id"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const id = requireString(args, "id");
    const { id: _id, ...patch } = args as Record<string, unknown> & { id?: string };
    return passthrough(
      await ctx.fetchInternal(`/api/app-orgs/${enc(id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      }),
      "app_orgs.update",
    );
  },
};

export const deleteAppOrg: McpTool = {
  name: "app_orgs.delete",
  description:
    "Delete an organization along with its memberships, org-scoped role " +
    "bindings and invitations. Irreversible. Admin-only.",
  inputSchema: {
    type: "object",
    properties: { id: ORG_ID_PROP },
    required: ["id"],
    additionalProperties: false,
  },
  handler: async (args, ctx) =>
    passthrough(
      await ctx.fetchInternal(`/api/app-orgs/${enc(requireString(args, "id"))}`, {
        method: "DELETE",
      }),
      "app_orgs.delete",
    ),
};

export const listAppOrgMembers: McpTool = {
  name: "app_orgs.members",
  // The name heuristic reads the leading verb ("members") and defaults to
  // write; this is a plain read, so say so or read-only keys lose it.
  kind: "read",
  description:
    "List an organization's members with their membership role and the " +
    "workspace roles bound to them within that org. Admin-only.",
  inputSchema: {
    type: "object",
    properties: { id: ORG_ID_PROP },
    required: ["id"],
    additionalProperties: false,
  },
  handler: async (args, ctx) =>
    passthrough(
      await ctx.fetchInternal(`/api/app-orgs/${enc(requireString(args, "id"))}/members`),
      "app_orgs.members",
    ),
};

export const addAppOrgMember: McpTool = {
  name: "app_orgs.add_member",
  description:
    "Add an existing workspace end-user to an organization. Admin-only.",
  inputSchema: {
    type: "object",
    properties: {
      id: ORG_ID_PROP,
      appUserId: { type: "string", description: "`app_users.id` to add." },
      role: ROLE_PROP,
      roleIds: ROLE_IDS_PROP,
    },
    required: ["id", "appUserId"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const id = requireString(args, "id");
    const body: Record<string, unknown> = { appUserId: requireString(args, "appUserId") };
    if (typeof args.role === "string") body.role = args.role;
    if (Array.isArray(args.roleIds)) body.roleIds = args.roleIds;
    return passthrough(
      await ctx.fetchInternal(`/api/app-orgs/${enc(id)}/members`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      "app_orgs.add_member",
    );
  },
};

export const updateAppOrgMember: McpTool = {
  name: "app_orgs.update_member",
  description:
    "Change a member's membership role and/or replace their org-scoped " +
    "workspace roles. Demoting the org's last owner is rejected. Admin-only.",
  inputSchema: {
    type: "object",
    properties: {
      id: ORG_ID_PROP,
      appUserId: { type: "string" },
      role: ROLE_PROP,
      roleIds: ROLE_IDS_PROP,
    },
    required: ["id", "appUserId"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const id = requireString(args, "id");
    const appUserId = requireString(args, "appUserId");
    const body: Record<string, unknown> = {};
    if (typeof args.role === "string") body.role = args.role;
    if (Array.isArray(args.roleIds)) body.roleIds = args.roleIds;
    return passthrough(
      await ctx.fetchInternal(`/api/app-orgs/${enc(id)}/members/${enc(appUserId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      "app_orgs.update_member",
    );
  },
};

export const removeAppOrgMember: McpTool = {
  name: "app_orgs.remove_member",
  // "remove" isn't in the destruct verb list but this drops a membership row.
  kind: "destruct",
  description:
    "Remove a member from an organization. Removing the last owner is " +
    "rejected. Admin-only.",
  inputSchema: {
    type: "object",
    properties: { id: ORG_ID_PROP, appUserId: { type: "string" } },
    required: ["id", "appUserId"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const id = requireString(args, "id");
    const appUserId = requireString(args, "appUserId");
    return passthrough(
      await ctx.fetchInternal(`/api/app-orgs/${enc(id)}/members/${enc(appUserId)}`, {
        method: "DELETE",
      }),
      "app_orgs.remove_member",
    );
  },
};

export const listAppOrgInvites: McpTool = {
  name: "app_orgs.invites",
  // Same reason as app_orgs.members — "invites" isn't a known read verb.
  kind: "read",
  description:
    "List an organization's invitations, newest first. Set `pending` to see " +
    "only the ones still actionable. Raw tokens are never listed. Admin-only.",
  inputSchema: {
    type: "object",
    properties: { id: ORG_ID_PROP, pending: { type: "boolean" } },
    required: ["id"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const id = requireString(args, "id");
    const q = args.pending === true ? "?pending=true" : "";
    return passthrough(
      await ctx.fetchInternal(`/api/app-orgs/${enc(id)}/invites${q}`),
      "app_orgs.invites",
    );
  },
};

export const inviteToAppOrg: McpTool = {
  name: "app_orgs.invite",
  description:
    "Mint a 7-day organization invitation and best-effort mail it. The " +
    "invitee accepts, already signed in as a workspace end-user, via " +
    "`POST /api/t/{slug}/orgs/invites/accept` with `{ token }` — their account " +
    "email must match the invited address. Returns the raw token once. " +
    "Admin-only.",
  inputSchema: {
    type: "object",
    properties: {
      id: ORG_ID_PROP,
      email: { type: "string", description: "Invitee email (stored lowercased)." },
      role: ROLE_PROP,
      roleIds: ROLE_IDS_PROP,
    },
    required: ["id", "email"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const id = requireString(args, "id");
    const body: Record<string, unknown> = { email: requireString(args, "email") };
    if (typeof args.role === "string") body.role = args.role;
    if (Array.isArray(args.roleIds)) body.roleIds = args.roleIds;
    return passthrough(
      await ctx.fetchInternal(`/api/app-orgs/${enc(id)}/invites`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      "app_orgs.invite",
    );
  },
};

export const revokeAppOrgInvite: McpTool = {
  name: "app_orgs.revoke_invite",
  description: "Delete an invitation so its token stops working. Admin-only.",
  inputSchema: {
    type: "object",
    properties: { id: ORG_ID_PROP, inviteId: { type: "string" } },
    required: ["id", "inviteId"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const id = requireString(args, "id");
    const inviteId = requireString(args, "inviteId");
    return passthrough(
      await ctx.fetchInternal(`/api/app-orgs/${enc(id)}/invites/${enc(inviteId)}`, {
        method: "DELETE",
      }),
      "app_orgs.revoke_invite",
    );
  },
};

export const appOrgsTools: McpTool[] = [
  listAppOrgs,
  getAppOrg,
  createAppOrg,
  updateAppOrg,
  deleteAppOrg,
  listAppOrgMembers,
  addAppOrgMember,
  updateAppOrgMember,
  removeAppOrgMember,
  listAppOrgInvites,
  inviteToAppOrg,
  revokeAppOrgInvite,
];
