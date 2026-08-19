/**
 * Cookie consent over MCP.
 *
 * Thin wrappers over `/api/admin/consent`, which calls the one shared
 * `services/consent` — so an agent sees exactly what the admin console does,
 * including the refusal.
 *
 * That refusal is the reason these descriptions are long. `consent.save_policy`
 * rejects a first save that omits `undecidedBehaviour` or `trackerCategory`,
 * and an agent that does not know WHY will simply retry with a guess. Naming
 * the consequence of each value in the schema is what turns "the call failed"
 * into "this is a decision the operator has to make" — which is the whole
 * point of the field having no default.
 */
import type { McpTool, ToolResult } from "../types";
import { readJson } from "../internal-fetch";

const textResult = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: value as object,
});

const SITE_ARG = {
  siteId: {
    type: "string",
    description: "The registered site the policy governs. One policy per site.",
  },
} as const;

const POLICY_PROPS = {
  ...SITE_ARG,
  undecidedBehaviour: {
    type: "string",
    enum: ["block", "allow"],
    description:
      "What happens between page load and the visitor's first answer. " +
      "`block` fires nothing optional until they decide — required under GDPR " +
      "and ePrivacy, and it costs measurement on visitors who ignore the " +
      "banner. `allow` fires optional tags until the visitor declines — the " +
      "CCPA/CPRA opt-out model, and NOT lawful in the EU. There is no default: " +
      "required on a first save, carried forward if omitted on a later one. Do " +
      "not guess — ask the operator.",
  },
  trackerCategory: {
    type: "string",
    enum: ["none", "analytics"],
    description:
      "How backlex's own cookieless analytics tag is classified. `none` treats " +
      "it as strictly necessary and measures everyone — defensible because the " +
      "tag stores nothing on the device and its visitor id rotates daily, but " +
      "that is a legal position, not a fact. `analytics` gates it like any " +
      "other tag. Also has no default, for the same reason.",
  },
  categoriesOffered: {
    type: "array",
    items: { type: "string", enum: ["functional", "analytics", "marketing"] },
    description:
      "Which optional categories the banner asks about. Strictly-necessary is " +
      "never offered — it is not a choice a visitor has.",
  },
  wording: {
    type: "object",
    description:
      "Per-locale banner copy, `{ en: { title, body, … } }`. Server-owned: the " +
      "page never supplies it, so the text a visitor was held to is the text " +
      "the workspace published.",
  },
  defaultLocale: { type: "string", description: "Locale used when none matches." },
  policyUrl: {
    type: "string",
    description: "Link to the operator's privacy policy. Must be http(s).",
  },
  position: { type: "string", enum: ["bottom", "top", "corner"] },
  cookieMaxAgeDays: {
    type: "number",
    description: "How long a decision stands before the visitor is asked again.",
  },
  enabled: { type: "boolean", description: "Whether the banner is served at all." },
} as const;

export const consentPolicies: McpTool = {
  name: "consent.policies",
  kind: "read",
  description:
    "Every site that has a cookie-consent policy. Sites without one are absent " +
    "from the list, not returned empty — no policy means nothing is asked and " +
    "nothing is blocked.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async (_args, ctx) => {
    const res = await ctx.fetchInternal("/api/admin/consent/policies");
    return textResult(await readJson<unknown>(res));
  },
};

export const consentPolicy: McpTool = {
  name: "consent.policy",
  kind: "read",
  description: "One site's consent policy, or null when it has never been configured.",
  inputSchema: {
    type: "object",
    properties: { ...SITE_ARG },
    required: ["siteId"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const res = await ctx.fetchInternal(
      `/api/admin/consent/policies/${encodeURIComponent(String(args.siteId))}`,
    );
    return textResult(await readJson<unknown>(res));
  },
};

export const consentSavePolicy: McpTool = {
  name: "consent.save_policy",
  kind: "write",
  description:
    "Create or replace a site's consent policy. A FIRST save must carry both " +
    "`undecidedBehaviour` and `trackerCategory`; each encodes a compliance " +
    "posture where neither answer is safe everywhere, so there is no default " +
    "and the server refuses rather than choosing. On a later save both may be " +
    "omitted and the stored choice is carried forward.",
  inputSchema: {
    type: "object",
    properties: { ...POLICY_PROPS },
    required: ["siteId"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const { siteId, ...body } = args as Record<string, unknown>;
    const res = await ctx.fetchInternal(
      `/api/admin/consent/policies/${encodeURIComponent(String(siteId))}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    const parsed = (await res.json().catch(() => null)) as object | null;
    return {
      content: [{ type: "text", text: JSON.stringify(parsed, null, 2) }],
      structuredContent: parsed ?? {},
      isError: !res.ok,
    };
  },
};

export const consentDeletePolicy: McpTool = {
  name: "consent.delete_policy",
  kind: "write",
  description:
    "Stop serving the banner for a site. Consent already recorded is evidence " +
    "and is left alone — it is removed through the erasure surface, never as a " +
    "side effect of reconfiguring a site.",
  inputSchema: {
    type: "object",
    properties: { ...SITE_ARG },
    required: ["siteId"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const res = await ctx.fetchInternal(
      `/api/admin/consent/policies/${encodeURIComponent(String(args.siteId))}`,
      { method: "DELETE" },
    );
    return textResult(await readJson<unknown>(res));
  },
};

export const consentSuggestedWording: McpTool = {
  name: "consent.suggested_wording",
  kind: "read",
  description:
    "Suggested banner copy, as a starting point an operator is expected to " +
    "edit. It is never applied automatically: a policy with no wording renders " +
    "the banner's own built-in strings rather than a legal statement nobody " +
    "reviewed.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async (_args, ctx) => {
    const res = await ctx.fetchInternal("/api/admin/consent/wording/suggested");
    return textResult(await readJson<unknown>(res));
  },
};

export const consentTools: McpTool[] = [
  consentPolicies,
  consentPolicy,
  consentSavePolicy,
  consentDeletePolicy,
  consentSuggestedWording,
];
