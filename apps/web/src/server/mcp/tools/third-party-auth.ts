import { readJson } from "../internal-fetch";
import type { McpTool, ToolResult } from "../types";

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

const BASE = "/api/admin/third-party-auth/providers";

export const listThirdPartyAuthProviders: McpTool = {
  name: "third_party_auth.providers_list",
  description:
    "List the external issuers whose JWTs this workspace accepts directly " +
    "(Clerk, Auth0, Firebase Auth, AWS Cognito, WorkOS). These are trusted " +
    "token issuers, not sign-in buttons — see `oidc` for the redirect flow. " +
    "Admin-only.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async (_args, ctx) => {
    const res = await ctx.fetchInternal(BASE);
    return textResult(await readJson<unknown>(res));
  },
};

export const createThirdPartyAuthProvider: McpTool = {
  name: "third_party_auth.providers_create",
  description:
    "Trust an external issuer. Give `discoveryUrl` when the provider publishes " +
    "an OpenID configuration (the JWKS endpoint is resolved from it and " +
    "stored); otherwise give `jwksUrl` directly. `issuer` must equal the `iss` " +
    "claim exactly and is unique across the whole instance. Admin-only.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Display label." },
      issuer: {
        type: "string",
        description:
          "Exact `iss` claim, e.g. `https://acme.clerk.accounts.dev` or " +
          "`https://securetoken.google.com/my-project`.",
      },
      discoveryUrl: {
        type: "string",
        description: "`.well-known/openid-configuration` URL. Preferred over jwksUrl.",
      },
      jwksUrl: { type: "string", description: "JWKS endpoint, when there is no discovery document." },
      audience: {
        type: "string",
        description:
          "Expected `aud`. Leave unset only when the issuer serves this workspace alone.",
      },
      subjectClaim: { type: "string", description: "Defaults to `sub`." },
      emailClaim: { type: "string", description: "Defaults to `email`." },
      nameClaim: { type: "string" },
      groupsClaim: { type: "string", description: "Claim carrying group membership." },
      groupsToRoles: {
        type: "object",
        description: "Map of IdP group string → backlex role id.",
      },
      defaultRoleId: { type: "string" },
      linkByVerifiedEmail: {
        type: "boolean",
        description:
          "Attach to an existing end-user with the same email. Off by default — an issuer that does not verify emails would make this an account-takeover path.",
      },
      autoProvision: {
        type: "boolean",
        description: "Create an end-user on first sight. Turn off when SCIM owns the lifecycle.",
      },
      enabled: { type: "boolean" },
    },
    required: ["name", "issuer"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const res = await ctx.fetchInternal(BASE, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args),
    });
    return textResult(await readJson<unknown>(res));
  },
};

export const updateThirdPartyAuthProvider: McpTool = {
  name: "third_party_auth.providers_update",
  description:
    "Patch a trusted issuer. Omitted fields keep their stored values. Admin-only.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      issuer: { type: "string" },
      discoveryUrl: { type: "string" },
      jwksUrl: { type: "string" },
      audience: { type: "string" },
      subjectClaim: { type: "string" },
      emailClaim: { type: "string" },
      nameClaim: { type: "string" },
      groupsClaim: { type: "string" },
      groupsToRoles: { type: "object" },
      defaultRoleId: { type: "string" },
      linkByVerifiedEmail: { type: "boolean" },
      autoProvision: { type: "boolean" },
      enabled: { type: "boolean" },
    },
    required: ["id"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const id = requireId(args);
    const { id: _drop, ...patch } = args;
    const res = await ctx.fetchInternal(`${BASE}/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    return textResult(await readJson<unknown>(res));
  },
};

export const deleteThirdPartyAuthProvider: McpTool = {
  name: "third_party_auth.providers_delete",
  // Destructive: every app authenticating with this issuer's tokens stops
  // being recognised the moment it is gone.
  kind: "destruct",
  description:
    "Stop trusting an issuer. Existing identity links are kept, so re-adding " +
    "the same issuer re-links the same people rather than duplicating them.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const id = requireId(args);
    const res = await ctx.fetchInternal(`${BASE}/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    return textResult(await readJson<unknown>(res));
  },
};

export const testThirdPartyAuthProvider: McpTool = {
  name: "third_party_auth.providers_test",
  description:
    "Verify a token against a configured issuer and report what the claim " +
    "mapping extracted. Provisions nothing and creates no session — this is " +
    "the tool for diagnosing why a token is rejected.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      token: { type: "string", description: "A JWT minted by the issuer." },
    },
    required: ["id", "token"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const id = requireId(args);
    const res = await ctx.fetchInternal(`${BASE}/${encodeURIComponent(id)}/test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: args.token }),
    });
    return textResult(await readJson<unknown>(res));
  },
};

export const thirdPartyAuthTools: McpTool[] = [
  listThirdPartyAuthProviders,
  createThirdPartyAuthProvider,
  updateThirdPartyAuthProvider,
  deleteThirdPartyAuthProvider,
  testThirdPartyAuthProvider,
];
