import type { McpTool, ToolResult } from "../types";
import { readJson } from "../internal-fetch";

/**
 * E-signature over MCP. Every tool proxies the admin REST routes through
 * `fetchInternal`, so the caller's identity, the workspace scoping, the
 * snapshot rule and the token rotation all come from the one implementation.
 *
 * Two deliberate absences:
 *
 * - **No signing tool.** Signing is the SIGNER's act, authenticated by a link
 *   token and nothing else. An agent holding an admin key signing on somebody
 *   else's behalf is precisely what the whole design refuses.
 * - **`signatures.send` does not return the links.** The REST response carries
 *   them once, and an agent's tool result is transcript that gets summarised,
 *   forwarded and stored. A signing link is a bearer credential; it belongs in
 *   the invitation email the call already sent.
 */
const textResult = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: value as object,
});

const BASE = "/api/admin/signatures";

export const listSignatureRequestsTool: McpTool = {
  name: "signatures.list",
  description:
    "List the workspace's signature requests with each signer's state. `status` filters; note " +
    "`expired` is derived from the expiry timestamp rather than stored, so it matches requests " +
    "nothing has swept yet.",
  inputSchema: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["pending", "completed", "declined", "voided", "expired"] },
      limit: { type: "number" },
      offset: { type: "number" },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const a = args as { status?: string; limit?: number; offset?: number };
    const q = new URLSearchParams();
    if (a.status) q.set("status", a.status);
    if (a.limit != null) q.set("limit", String(a.limit));
    if (a.offset != null) q.set("offset", String(a.offset));
    const qs = q.toString();
    return textResult(await readJson<unknown>(await ctx.fetchInternal(`${BASE}${qs ? `?${qs}` : ""}`)));
  },
};

export const getSignatureRequestTool: McpTool = {
  name: "signatures.get",
  description:
    "One signature request, including the document HTML exactly as it was FROZEN when it was " +
    "sent — not as the template renders today. Use this to see what somebody actually signed.",
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

export const sendSignatureRequestTool: McpTool = {
  name: "signatures.send",
  description:
    "Freeze a document and send it out for signature — one emailed link per signer. Exactly one " +
    "of `templateKey` or `html`; `vars` is the render context (usually `{ data: { …the row… } }`). " +
    "The signing links are NOT returned here: they are bearer credentials for somebody else's " +
    "signature and they have already gone out by email. Requires a configured PDF renderer.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string" },
      message: { type: "string" },
      templateKey: { type: "string" },
      html: { type: "string" },
      vars: { type: "object", additionalProperties: true },
      filename: { type: "string" },
      signers: {
        type: "array",
        items: {
          type: "object",
          properties: {
            email: { type: "string" },
            name: { type: "string" },
            role: { type: "string", description: 'Shown on the certificate — "Tenant", "Landlord".' },
          },
          required: ["email"],
          additionalProperties: false,
        },
      },
      ordered: {
        type: "boolean",
        description: "Each link only opens once the one before it has signed.",
      },
      expiresInDays: { type: "number" },
      writeBack: {
        type: "object",
        description: "Where the SIGNED document's storage key lands once everyone has signed.",
        properties: {
          collection: { type: "string" },
          id: { type: "string" },
          field: { type: "string" },
        },
        required: ["collection", "id", "field"],
        additionalProperties: false,
      },
      notifyEmails: { type: "array", items: { type: "string" } },
    },
    required: ["signers"],
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

export const voidSignatureRequestTool: McpTool = {
  name: "signatures.void",
  description:
    "Cancel a signature request. Replaces every outstanding token, so links already delivered " +
    "stop working. A request everybody has already signed cannot be cancelled.",
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
        await ctx.fetchInternal(`${BASE}/${encodeURIComponent(id)}/void`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reason: reason ?? null }),
        }),
      ),
    );
  },
};

export const resendSignatureInviteTool: McpTool = {
  name: "signatures.resend",
  description:
    "Re-send one signer's invitation with a FRESH link. The previous link stops working — " +
    "resending exists for a link that went astray, and one that left the old link live would fix " +
    "nothing. Returns whether the mail went and to which address.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" }, signerId: { type: "string" } },
    required: ["id", "signerId"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const { id, signerId } = args as { id: string; signerId: string };
    return textResult(
      await readJson<unknown>(
        await ctx.fetchInternal(
          `${BASE}/${encodeURIComponent(id)}/signers/${encodeURIComponent(signerId)}/resend`,
          { method: "POST" },
        ),
      ),
    );
  },
};

export const signaturesTools: McpTool[] = [
  listSignatureRequestsTool,
  getSignatureRequestTool,
  sendSignatureRequestTool,
  voidSignatureRequestTool,
  resendSignatureInviteTool,
];
