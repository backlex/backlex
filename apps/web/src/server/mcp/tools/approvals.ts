import type { McpTool, ToolResult } from "../types";
import { readJson } from "../internal-fetch";

/**
 * Approvals over MCP. Every tool proxies the admin REST routes through
 * `fetchInternal`, so the caller's identity, the workspace scoping, the
 * one-shot settle guard and the flow resumption all come from the one
 * implementation.
 *
 * Two deliberate absences, for the same reasons the signature tools have them:
 *
 * - **No decide tool.** Approving is the APPROVER's act, authenticated by a
 *   link token and nothing else. An agent holding an admin key approving on
 *   somebody else's behalf is precisely what the design refuses — and here it
 *   would also fire whatever the flow does next.
 * - **`approvals.request` does not return the links.** The REST response
 *   carries them once, and an agent's tool result is transcript that gets
 *   summarised, forwarded and stored. A decision link is a bearer credential;
 *   it belongs in the invitation email the call already sent.
 */
const textResult = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: value as object,
});

const BASE = "/api/admin/approvals";

export const listApprovalRequestsTool: McpTool = {
  name: "approvals.list",
  description:
    "List the workspace's approval requests with every approver's state. Pending requests sort " +
    "first, then by how soon they expire — the order for chasing outstanding answers.",
  inputSchema: {
    type: "object",
    properties: {
      status: {
        type: "string",
        enum: ["pending", "approved", "rejected", "expired", "cancelled"],
      },
      limit: { type: "number" },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const a = args as { status?: string; limit?: number };
    const q = new URLSearchParams();
    if (a.status) q.set("status", a.status);
    if (a.limit != null) q.set("limit", String(a.limit));
    const qs = q.toString();
    return textResult(await readJson<unknown>(await ctx.fetchInternal(`${BASE}${qs ? `?${qs}` : ""}`)));
  },
};

export const getApprovalRequestTool: McpTool = {
  name: "approvals.get",
  description:
    "One approval request with the full decision trail — who was asked, who answered, when, from " +
    "where and why, plus the summary the approvers were shown frozen at send time.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const { id } = args as { id: string };
    return textResult(await readJson<unknown>(await ctx.fetchInternal(`${BASE}/${encodeURIComponent(id)}`)));
  },
};

export const requestApprovalTool: McpTool = {
  name: "approvals.request",
  description:
    "Ask people to approve something — one emailed link per approver. `policy` decides what " +
    "settles it: `all` (default, and one rejection ends it), `any` (first approval wins), or " +
    "`quorum` with a number. The decision links are NOT returned here: they are bearer " +
    "credentials and they have already gone out by email.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string" },
      message: { type: "string" },
      approvers: {
        type: "array",
        items: {
          type: "object",
          properties: {
            email: { type: "string" },
            name: { type: "string" },
            role: {
              type: "string",
              description: 'The capacity they decide in — "Line manager", "Finance".',
            },
          },
          required: ["email"],
          additionalProperties: false,
        },
      },
      policy: { type: "string", enum: ["all", "any", "quorum"] },
      quorum: { type: "number", description: "How many approvals settle it. Only read with `policy: quorum`." },
      ordered: {
        type: "boolean",
        description: "Each link only opens once the one before it has decided.",
      },
      expiresInHours: {
        type: "number",
        description: "Default 72. On expiry the request REJECTS — an unanswered request is not approved.",
      },
      subject: {
        type: "object",
        description: "The row the decision is about.",
        properties: { collection: { type: "string" }, id: { type: "string" } },
        required: ["collection", "id"],
        additionalProperties: false,
      },
      summary: {
        type: "array",
        description: "What the approver is shown, frozen at send time.",
        items: {
          type: "object",
          properties: { label: { type: "string" }, value: { type: "string" } },
          required: ["label", "value"],
          additionalProperties: false,
        },
      },
      writeBack: {
        type: "object",
        description:
          "What is patched onto the subject row once the outcome is known. `collection`/`id` " +
          "default to the subject. An expiry writes `rejectedValue`.",
        properties: {
          collection: { type: "string" },
          id: { type: "string" },
          field: { type: "string" },
          approvedValue: {},
          rejectedValue: {},
        },
        required: ["field"],
        additionalProperties: false,
      },
      notifyEmails: { type: "array", items: { type: "string" } },
    },
    required: ["title", "approvers"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const out = await readJson<{
      data: { request: Record<string, unknown>; sent: boolean };
    }>(
      await ctx.fetchInternal(BASE, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(args),
      }),
    );
    // `links` is dropped on the way through, on purpose — see the module note.
    return textResult({ request: out.data.request, sent: out.data.sent });
  },
};

export const cancelApprovalRequestTool: McpTool = {
  name: "approvals.cancel",
  description:
    "Withdraw an approval request. Closes it and kills every outstanding link. A cancelled " +
    "request runs NEITHER flow branch — not the approved path and not the rejected one.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" }, reason: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const { id, reason } = args as { id: string; reason?: string };
    return textResult(
      await readJson<unknown>(
        await ctx.fetchInternal(`${BASE}/${encodeURIComponent(id)}/cancel`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reason: reason ?? null }),
        }),
      ),
    );
  },
};

export const approvalsTools: McpTool[] = [
  listApprovalRequestsTool,
  getApprovalRequestTool,
  requestApprovalTool,
  cancelApprovalRequestTool,
];
