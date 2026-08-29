import type { McpTool, ToolResult } from "../types";

/**
 * Workspaces (tenants) and the people in them. Admin-scoped mirror of REST
 * `/api/tenants` and `/api/tenants/{id}/members/*`.
 *
 * Every tool proxies its REST route through `fetchInternal`, so the route's
 * guards — the workspace-scoped membership check, the rank ladder, the
 * last-owner protection — apply identically here. This file adds no
 * authorization logic of its own, and it must not: the whole point of routing
 * MCP through the same Hono app is that an agent cannot reach a capability a
 * browser could not.
 *
 * Until this phase the module had exactly two tools and one of them had never
 * worked (see `switchTenant`), so an agent could see which workspaces exist and
 * nothing else — while the REST plane grew role changes, ownership transfer and
 * invite lifecycle. That gap is what the house rule "REST + SDK + GraphQL + MCP
 * + CLI" exists to stop, and it is closed here for the two surfaces this area
 * actually reaches (the SDK deferral for the admin plane is argued in
 * `apps/web/tests/sdk-surfaces.test.ts` and deliberately left standing).
 */

/** Forward the REST response as-is so upstream codes reach the caller intact —
 *  VALIDATION when a change would leave the workspace ownerless, FORBIDDEN when
 *  the actor does not outrank the target — instead of being flattened into a
 *  generic failure an agent cannot reason about. */
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

const jsonInit = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const TENANT_ID_PROP = {
  type: "string",
  description: "Workspace id (the `id` from `tenants.list`).",
} as const;

const MEMBER_ID_PROP = {
  type: "string",
  description: "Membership row id — the `id` from `tenants.members`, NOT a user id.",
} as const;

const ROLE_PROP = {
  type: "string",
  enum: ["owner", "admin", "member"],
  description:
    "Workspace membership role: `owner` (may transfer ownership and cannot be " +
    "the last one removed), `admin` (may invite and manage members below them), " +
    "or `member`. Rows written before it was deprecated may still read back as " +
    "`editor`; it cannot be granted.",
} as const;

export const listTenants: McpTool = {
  name: "tenants.list",
  description:
    "List every tenant (workspace) the active user is a member of, plus " +
    "the active tenant marker. Use before `tenants.switch` to find ids.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async (_args, ctx) =>
    passthrough(await ctx.fetchInternal("/api/tenants"), "tenants.list"),
};

export const switchTenant: McpTool = {
  name: "tenants.switch",
  description:
    "Switch the active tenant for subsequent MCP calls. The change is " +
    "persisted on the user's profile and applies to every backlex surface " +
    "(REST, GraphQL, MCP) until switched again.",
  inputSchema: {
    type: "object",
    properties: {
      tenant: {
        type: "string",
        description: "Workspace id or slug — both are accepted, id is tried first.",
      },
    },
    required: ["tenant"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    // The body key is `tenant`, and getting that wrong is why this tool had
    // never once succeeded: it posted `{tenantId}`, `SwitchInput` requires
    // `{tenant}`, and `defaultHook` answered 422 to every call. Nothing caught
    // it because the old handler threw the upstream message as a plain Error,
    // which reads to an agent like the workspace was simply unavailable.
    const tenant = requireString(args, "tenant");
    return passthrough(
      await ctx.fetchInternal("/api/tenants/switch", jsonInit({ tenant })),
      "tenants.switch",
    );
  },
};

export const tenantMembers: McpTool = {
  name: "tenants.members",
  description:
    "List a workspace's members and pending invites: membership id, user id, " +
    "email, role and status. Caller must be a member of that workspace (the " +
    "instance operator bypasses). Invite tokens are never included.",
  inputSchema: {
    type: "object",
    properties: { id: TENANT_ID_PROP },
    required: ["id"],
    additionalProperties: false,
  },
  // "members" is not a verb the name heuristic knows, and its default is
  // `write` — which would badge a listing as a mutation and block it for
  // read-only keys. Classified explicitly for the same reason the heuristic
  // fails safe: the two must agree.
  kind: "read",
  handler: async (args, ctx) =>
    passthrough(
      await ctx.fetchInternal(`/api/tenants/${enc(requireString(args, "id"))}/members`),
      "tenants.members",
    ),
};

export const inviteMember: McpTool = {
  name: "tenants.invite",
  description:
    "Invite an email address into a workspace with a 7-day token. Owners and " +
    "admins only, and an admin cannot invite an owner. Returns the accept URL; " +
    "`sent: false` means no mail transport is configured and the URL has to be " +
    "shared by hand.",
  inputSchema: {
    type: "object",
    properties: {
      id: TENANT_ID_PROP,
      email: { type: "string" },
      role: ROLE_PROP,
    },
    required: ["id", "email"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const body: Record<string, unknown> = { email: requireString(args, "email") };
    if (typeof args.role === "string") body.role = args.role;
    return passthrough(
      await ctx.fetchInternal(
        `/api/tenants/${enc(requireString(args, "id"))}/members/invite`,
        jsonInit(body),
      ),
      "tenants.invite",
    );
  },
};

export const updateMember: McpTool = {
  name: "tenants.update_member",
  description:
    "Change a member's workspace role, their status, or both. The actor must " +
    "outrank the target (acting on yourself is always allowed — that is how a " +
    "person steps down), only an owner may grant `owner`, and the last owner " +
    "can be neither demoted nor suspended. To hand a workspace over, use " +
    "`tenants.transfer_ownership` rather than demoting the owner first: the " +
    "last-owner guard makes that order impossible.",
  inputSchema: {
    type: "object",
    properties: {
      id: TENANT_ID_PROP,
      memberId: MEMBER_ID_PROP,
      role: ROLE_PROP,
      status: {
        type: "string",
        enum: ["active", "suspended"],
        description:
          "`suspended` keeps the row and revokes every right it carries — a suspended owner or admin can no longer invite or evict anybody.",
      },
    },
    required: ["id", "memberId"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const body: Record<string, unknown> = {};
    if (typeof args.role === "string") body.role = args.role;
    if (typeof args.status === "string") body.status = args.status;
    // The route answers VALIDATION to an empty patch rather than 200-ing a
    // request that changed nothing, and saying so here saves a round-trip and
    // tells the agent which two keys it meant to send.
    if (Object.keys(body).length === 0)
      throw new Error("VALIDATION: send `role`, `status`, or both");
    return passthrough(
      await ctx.fetchInternal(
        `/api/tenants/${enc(requireString(args, "id"))}/members/${enc(requireString(args, "memberId"))}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      ),
      "tenants.update_member",
    );
  },
};

export const transferOwnership: McpTool = {
  name: "tenants.transfer_ownership",
  description:
    "Hand the workspace to another member: they become `owner` and the calling " +
    "owner steps down to `admin`, as one intent. Owners only, and the member " +
    "must have accepted their invite. This is the only way past the last-owner " +
    "guard, and the reason a workspace can never be left with nobody in charge.",
  inputSchema: {
    type: "object",
    properties: { id: TENANT_ID_PROP, memberId: MEMBER_ID_PROP },
    required: ["id", "memberId"],
    additionalProperties: false,
  },
  handler: async (args, ctx) =>
    passthrough(
      // Workspace-scoped, not member-scoped: the route moves TWO rows — the new
      // owner's and the caller's — so the member id is what the transfer names
      // rather than what it is addressed by.
      await ctx.fetchInternal(
        `/api/tenants/${enc(requireString(args, "id"))}/transfer-ownership`,
        jsonInit({ memberId: requireString(args, "memberId") }),
      ),
      "tenants.transfer_ownership",
    ),
};

export const resendInvite: McpTool = {
  name: "tenants.resend_invite",
  description:
    "Re-send a pending invite with a fresh token and a fresh 7-day expiry. The " +
    "previous token stops working, so this is also the way to recover an invite " +
    "whose link leaked or expired.",
  inputSchema: {
    type: "object",
    properties: { id: TENANT_ID_PROP, memberId: MEMBER_ID_PROP },
    required: ["id", "memberId"],
    additionalProperties: false,
  },
  handler: async (args, ctx) =>
    passthrough(
      await ctx.fetchInternal(
        `/api/tenants/${enc(requireString(args, "id"))}/members/${enc(requireString(args, "memberId"))}/resend-invite`,
        jsonInit({}),
      ),
      "tenants.resend_invite",
    ),
};

export const revokeInvite: McpTool = {
  name: "tenants.revoke_invite",
  description:
    "Withdraw a pending invite. The token is destroyed, so the link stops " +
    "admitting anyone. Refused on a member who has already accepted — remove " +
    "them with `tenants.remove_member` instead.",
  inputSchema: {
    type: "object",
    properties: { id: TENANT_ID_PROP, memberId: MEMBER_ID_PROP },
    required: ["id", "memberId"],
    additionalProperties: false,
  },
  handler: async (args, ctx) =>
    passthrough(
      await ctx.fetchInternal(
        `/api/tenants/${enc(requireString(args, "id"))}/members/${enc(requireString(args, "memberId"))}/invite`,
        { method: "DELETE" },
      ),
      "tenants.revoke_invite",
    ),
};

export const removeMember: McpTool = {
  name: "tenants.remove_member",
  description:
    "Evict a member from a workspace: the membership row, their workspace-scoped " +
    "role grants and the API keys pinned to this workspace all go, and the " +
    "response lists what was revoked. The actor must outrank the target (removing " +
    "yourself is leaving, and is allowed), and the last owner cannot be removed.",
  inputSchema: {
    type: "object",
    properties: { id: TENANT_ID_PROP, memberId: MEMBER_ID_PROP },
    required: ["id", "memberId"],
    additionalProperties: false,
  },
  // `remove` is not in the heuristic's destruct list, and this call revokes a
  // colleague's access to everything in the workspace. Classified explicitly so
  // the `destructiveHint` a client shows matches what the call actually does.
  kind: "destruct",
  handler: async (args, ctx) =>
    passthrough(
      await ctx.fetchInternal(
        `/api/tenants/${enc(requireString(args, "id"))}/members/${enc(requireString(args, "memberId"))}`,
        { method: "DELETE" },
      ),
      "tenants.remove_member",
    ),
};

export const tenantsTools: McpTool[] = [
  listTenants,
  switchTenant,
  tenantMembers,
  inviteMember,
  updateMember,
  transferOwnership,
  resendInvite,
  revokeInvite,
  removeMember,
];
