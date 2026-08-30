import { api } from "@/lib/api";
import type { Envelope } from "./types";

export interface ApiSession {
  id: string;
  userId: string;
  userEmail: string;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  current?: boolean;
}

export interface ApiAuthConfigProvider {
  enabled?: boolean;
  configured?: boolean;
  clientId?: string | null;
  system?: boolean;
  /** Display name for custom OIDC providers. */
  name?: string;
  /** OIDC discovery / issuer URL for custom providers. */
  discoveryUrl?: string | null;
}

export interface ApiAuthConfig {
  tenantId: string;
  providers: Record<string, ApiAuthConfigProvider>;
  policy: Record<string, boolean>;
  sessionLifetime: string;
  redirectUrls: string[];
}

export const authAdminApi = {
  config: () => api<Envelope<ApiAuthConfig>>(`/api/admin/auth/config`),
  patch: (body: Partial<ApiAuthConfig>) =>
    api<{ ok: true }>(`/api/admin/auth/config`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  sessions: () => api<Envelope<ApiSession[]>>(`/api/admin/auth/sessions`),
  revokeSession: (id: string) =>
    api<{ ok: true }>(`/api/admin/auth/sessions/${id}`, { method: "DELETE" }),
  /**
   * Sign out every session but this one.
   *
   * `apiKeys` is a QUERY flag rather than a body because this is a bodyless
   * POST — see `routes/auth-admin.ts` for why giving it a body is the shape
   * that 500'd live in this repo twice.
   *
   * The response always reports `apiKeys`: the keys the caller still holds
   * after the call. They are not sessions and a sign-out never touched them,
   * which is the whole reason the number is surfaced.
   */
  revokeOthers: (opts?: { apiKeys?: boolean }) =>
    api<{ ok: true; removed: number; apiKeys: number; apiKeysRevoked: number }>(
      `/api/admin/auth/sessions/revoke-others${opts?.apiKeys ? "?apiKeys=1" : ""}`,
      { method: "POST" },
    ),
};

export interface ApiSamlProvider {
  id: string;
  tenantId: string;
  name: string;
  slug: string;
  idpTemplate: string | null;
  entityId: string;
  ssoUrl: string;
  sloUrl: string | null;
  /** True when an encrypted cert PEM is stored. Plaintext is never returned. */
  idpCertSet: boolean;
  spEntityId: string;
  attributeMap: Record<string, string>;
  defaultRoleId: string | null;
  groupsToRoles: Record<string, string> | null;
  signatureAlgorithm: string;
  wantSignedAssertions: boolean;
  linkByVerifiedEmail: boolean;
  nameIdFormat: string;
  enabled: boolean;
  createdAt: string | number;
  updatedAt: string | number;
}

export interface SamlProviderCreate {
  name: string;
  slug?: string;
  idpTemplate?: string | null;
  entityId: string;
  ssoUrl: string;
  sloUrl?: string | null;
  idpCertPem: string;
  spEntityId: string;
  attributeMap?: Record<string, string>;
  defaultRoleId?: string | null;
  groupsToRoles?: Record<string, string> | null;
  signatureAlgorithm?: "sha1" | "sha256" | "sha512";
  wantSignedAssertions?: boolean;
  linkByVerifiedEmail?: boolean;
  nameIdFormat?: string;
  enabled?: boolean;
}

export const samlAdminApi = {
  list: () => api<Envelope<ApiSamlProvider[]>>(`/api/admin/saml/providers`),
  create: (body: SamlProviderCreate) =>
    api<Envelope<ApiSamlProvider>>(`/api/admin/saml/providers`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  update: (id: string, body: Partial<SamlProviderCreate>) =>
    api<Envelope<ApiSamlProvider>>(`/api/admin/saml/providers/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  remove: (id: string) =>
    api<{ ok: true }>(`/api/admin/saml/providers/${id}`, { method: "DELETE" }),
  testAssertion: (id: string, samlResponse: string) =>
    api<Envelope<{
      nameId: string;
      issuer: string;
      audience: string;
      authnContext: string | null;
      sessionIndex: string | null;
      notOnOrAfter: string;
      attributes: Record<string, string[]>;
      mapped: { email: string | null; firstName: string | null; lastName: string | null; groups: string[] };
    }>>(`/api/admin/saml/providers/${id}/test-assertion`, {
      method: "POST",
      body: JSON.stringify({ samlResponse }),
    }),
  importMetadata: (body: { metadataXml?: string; metadataUrl?: string }) =>
    api<Envelope<{
      entityId: string;
      ssoUrl: string;
      sloUrl: string | null;
      idpCertPem: string;
      spEntityIdSuggested: string;
    }>>(`/api/admin/saml/providers/import-metadata`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
};

/** Sanitized generic OIDC / OAuth2 provider row from GET /api/admin/oidc/providers.
 *  The client secret has no read-back path — the server only tells us whether one
 *  is stored via `hasClientSecret`, so the edit form must never treat a blank
 *  secret field as "clear the credential". */
export interface ApiOidcProvider {
  id: string;
  name: string;
  slug: string;
  clientId: string;
  /** True when an encrypted client secret is stored. Plaintext never returned. */
  hasClientSecret: boolean;
  discoveryUrl: string | null;
  authorizationUrl: string | null;
  tokenUrl: string | null;
  userInfoUrl: string | null;
  scopes: string[];
  pkce: boolean;
  emailClaim: string | null;
  groupsClaim: string | null;
  defaultRoleId: string | null;
  groupsToRoles: Record<string, string> | null;
  linkByVerifiedEmail: boolean;
  enabled: boolean;
  createdAt: string | number | null;
  updatedAt: string | number | null;
}

export interface OidcProviderCreate {
  name: string;
  slug: string;
  clientId: string;
  /** Plaintext, write-only. Omit on PATCH to keep the stored credential. */
  clientSecret?: string;
  discoveryUrl?: string | null;
  authorizationUrl?: string | null;
  tokenUrl?: string | null;
  userInfoUrl?: string | null;
  scopes?: string[];
  pkce?: boolean;
  emailClaim?: string | null;
  groupsClaim?: string | null;
  defaultRoleId?: string | null;
  groupsToRoles?: Record<string, string> | null;
  linkByVerifiedEmail?: boolean;
  enabled?: boolean;
}

/** What POST /api/admin/oidc/discover resolves out of an IdP's
 *  `.well-known/openid-configuration`. Every field is optional because a
 *  discovery document is only required to carry authorize + token. */
export interface OidcDiscovery {
  issuer?: string;
  authorizationUrl?: string;
  tokenUrl?: string;
  userInfoUrl?: string;
  scopesSupported?: string[];
}

/** SCIM provisioning config. The bearer token is write-only: this shape carries
 *  a display prefix, never the token, and `POST /token` is the only place the
 *  plaintext ever appears. */
export interface ApiScimConfig {
  id: string;
  enabled: boolean;
  tokenPrefix: string;
  defaultRoleId: string | null;
  lastRequestAt: number | string | null;
  createdAt: number | string | null;
  updatedAt: number | string | null;
}

export const scimAdminApi = {
  get: () => api<Envelope<ApiScimConfig | null>>(`/api/admin/scim`),
  /** Creates or rotates. `token` is returned ONCE and is not recoverable. */
  issueToken: (body: { defaultRoleId?: string | null } = {}) =>
    api<Envelope<ApiScimConfig> & { token: string; baseUrl: string }>(`/api/admin/scim/token`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  update: (body: { enabled?: boolean; defaultRoleId?: string | null }) =>
    api<Envelope<ApiScimConfig>>(`/api/admin/scim`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  remove: () => api<{ ok: true }>(`/api/admin/scim`, { method: "DELETE" }),
};

export const oidcAdminApi = {
  list: () => api<Envelope<ApiOidcProvider[]>>(`/api/admin/oidc/providers`),
  create: (body: OidcProviderCreate) =>
    api<Envelope<ApiOidcProvider>>(`/api/admin/oidc/providers`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  update: (id: string, body: Partial<OidcProviderCreate>) =>
    api<Envelope<ApiOidcProvider>>(`/api/admin/oidc/providers/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  remove: (id: string) =>
    api<{ ok: true }>(`/api/admin/oidc/providers/${id}`, { method: "DELETE" }),
  discover: (url: string) =>
    api<Envelope<OidcDiscovery>>(`/api/admin/oidc/discover`, {
      method: "POST",
      body: JSON.stringify({ url }),
    }),
};

/** A trusted external issuer — the app arrives holding its own token instead of
 *  being redirected to sign in. The read-back is complete: verifying someone
 *  else's JWT needs only public keys, so unlike OIDC/SAML there is no
 *  write-only credential and no `has…Secret` flag. */
export interface ApiThirdPartyAuthProvider {
  id: string;
  name: string;
  slug: string;
  issuer: string;
  jwksUrl: string;
  discoveryUrl: string | null;
  audience: string | null;
  subjectClaim: string;
  emailClaim: string;
  nameClaim: string | null;
  groupsClaim: string | null;
  groupsToRoles: Record<string, string> | null;
  defaultRoleId: string | null;
  linkByVerifiedEmail: boolean;
  autoProvision: boolean;
  enabled: boolean;
  createdAt: string | number | null;
  updatedAt: string | number | null;
}

export interface ThirdPartyAuthProviderCreate {
  name: string;
  slug?: string;
  issuer: string;
  /** Either this or `discoveryUrl`; discovery wins when both are sent. */
  jwksUrl?: string;
  discoveryUrl?: string | null;
  audience?: string | null;
  subjectClaim?: string;
  emailClaim?: string;
  nameClaim?: string | null;
  groupsClaim?: string | null;
  groupsToRoles?: Record<string, string> | null;
  defaultRoleId?: string | null;
  linkByVerifiedEmail?: boolean;
  autoProvision?: boolean;
  enabled?: boolean;
}

/** Result of pasting a real token into the provider's test box. */
export interface ThirdPartyAuthTestResult {
  valid: boolean;
  reason?: string;
  subject?: string;
  email?: string | null;
  name?: string | null;
  groups?: string[] | null;
  wouldProvision?: boolean;
}

export const thirdPartyAuthApi = {
  list: () =>
    api<Envelope<ApiThirdPartyAuthProvider[]>>(`/api/admin/third-party-auth/providers`),
  create: (body: ThirdPartyAuthProviderCreate) =>
    api<Envelope<ApiThirdPartyAuthProvider>>(`/api/admin/third-party-auth/providers`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  update: (id: string, body: Partial<ThirdPartyAuthProviderCreate>) =>
    api<Envelope<ApiThirdPartyAuthProvider>>(
      `/api/admin/third-party-auth/providers/${id}`,
      { method: "PATCH", body: JSON.stringify(body) },
    ),
  remove: (id: string) =>
    api<Envelope<{ ok: true }>>(`/api/admin/third-party-auth/providers/${id}`, {
      method: "DELETE",
    }),
  test: (id: string, token: string) =>
    api<Envelope<ThirdPartyAuthTestResult>>(
      `/api/admin/third-party-auth/providers/${id}/test`,
      { method: "POST", body: JSON.stringify({ token }) },
    ),
};

/** Sanitized LDAP config row returned by GET /api/admin/ldap-config. The
 *  encrypted `bindPassword` + `caPem` never travel the wire — `secretsSet`
 *  carries a "is this set" flag per key instead. */
export interface ApiLdapConfig {
  tenantId: string;
  enabled: boolean;
  url: string;
  bindDn: string;
  baseDn: string;
  userFilter: string;
  groupFilter: string | null;
  attributeMap: { email: string; firstName: string; lastName: string; groups: string };
  defaultRoleId: string | null;
  groupsToRoles: Record<string, string> | null;
  tlsOptions: { rejectUnauthorized?: boolean } | null;
  secretsSet: { bindPassword: boolean; caPem: boolean };
  domainMatch: string[] | null;
  rateLimitPerMinute: number;
  updatedAt: string | number | null;
}

export interface LdapConfigPatch {
  enabled?: boolean;
  url?: string;
  bindDn?: string;
  baseDn?: string;
  userFilter?: string;
  groupFilter?: string | null;
  attributeMap?: Partial<{
    email: string;
    firstName: string;
    lastName: string;
    groups: string;
  }>;
  defaultRoleId?: string | null;
  groupsToRoles?: Record<string, string> | null;
  tlsOptions?: { rejectUnauthorized?: boolean } | null;
  domainMatch?: string[] | null;
  rateLimitPerMinute?: number;
  /** `""`/`null` clears a key; omitting one leaves the stored ciphertext
   *  in place. */
  secrets?: { bindPassword?: string | null; caPem?: string | null };
}

export const ldapAdminApi = {
  load: () => api<Envelope<ApiLdapConfig>>(`/api/admin/ldap-config`),
  save: (body: LdapConfigPatch) =>
    api<{ ok: true }>(`/api/admin/ldap-config`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  test: (username: string, password: string) =>
    api<
      | { ok: true; dn: string; attributes: { email: string | null; firstName: string | null; lastName: string | null; groups: string[] } }
      | { ok: false; reason: string }
    >(`/api/admin/ldap-config/test`, {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
};

// --- Platform (control-plane / admin) SSO — instance-global, no tenant. ---

/** Sanitized platform SAML provider (no `tenantId`; cert PEM never returned). */
export interface ApiPlatformSamlProvider {
  id: string;
  name: string;
  slug: string;
  idpTemplate: string | null;
  entityId: string;
  ssoUrl: string;
  sloUrl: string | null;
  idpCertSet: boolean;
  spEntityId: string;
  attributeMap: Record<string, string>;
  defaultRoleId: string | null;
  groupsToRoles: Record<string, { tenantId: string; roleId: string }> | null;
  signatureAlgorithm: string;
  wantSignedAssertions: boolean;
  linkByVerifiedEmail: boolean;
  nameIdFormat: string;
  /** JIT email-domain allow-list; null/empty = any IdP-authenticated email. */
  domainMatch: string[] | null;
  enabled: boolean;
  createdAt: string | number;
  updatedAt: string | number;
}

/** Platform SAML create input — the shared workspace shape plus the platform-
 *  only JIT `domainMatch` allow-list. */
export type PlatformSamlProviderCreate = Omit<SamlProviderCreate, "groupsToRoles"> & {
  domainMatch?: string[] | null;
  /** Tenant-aware group→role map (platform-only). */
  groupsToRoles?: Record<string, { tenantId: string; roleId: string }> | null;
};

export const platformSamlAdminApi = {
  list: () =>
    api<Envelope<ApiPlatformSamlProvider[]>>(`/api/admin/platform-saml/providers`),
  create: (body: PlatformSamlProviderCreate) =>
    api<Envelope<ApiPlatformSamlProvider>>(`/api/admin/platform-saml/providers`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  update: (id: string, body: Partial<PlatformSamlProviderCreate>) =>
    api<Envelope<ApiPlatformSamlProvider>>(`/api/admin/platform-saml/providers/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  remove: (id: string) =>
    api<{ ok: true }>(`/api/admin/platform-saml/providers/${id}`, { method: "DELETE" }),
  importMetadata: (body: { metadataXml?: string; metadataUrl?: string }) =>
    api<Envelope<{
      entityId: string;
      ssoUrl: string;
      sloUrl: string | null;
      idpCertPem: string;
      spEntityIdSuggested: string;
    }>>(`/api/admin/platform-saml/providers/import-metadata`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
};

/** Sanitized platform LDAP singleton config (`id` instead of `tenantId`). */
export interface ApiPlatformLdapConfig {
  id: string;
  enabled: boolean;
  url: string;
  bindDn: string;
  baseDn: string;
  userFilter: string;
  groupFilter: string | null;
  attributeMap: { email: string; firstName: string; lastName: string; groups: string };
  defaultRoleId: string | null;
  groupsToRoles: Record<string, { tenantId: string; roleId: string }> | null;
  tlsOptions: { rejectUnauthorized?: boolean } | null;
  secretsSet: { bindPassword: boolean; caPem: boolean };
  domainMatch: string[] | null;
  rateLimitPerMinute: number;
  updatedAt: string | number | null;
}

export const platformLdapAdminApi = {
  load: () => api<Envelope<ApiPlatformLdapConfig>>(`/api/admin/platform-ldap-config`),
  save: (body: LdapConfigPatch) =>
    api<{ ok: true }>(`/api/admin/platform-ldap-config`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  test: (username: string, password: string) =>
    api<
      | { ok: true; dn: string; attributes: { email: string | null; firstName: string | null; lastName: string | null; groups: string[] } }
      | { ok: false; reason: string }
    >(`/api/admin/platform-ldap-config/test`, {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
};

/* ── auth hooks ── */

/** The four moments a workspace can hook in its END-USER authentication. */
export type ApiAuthHookEvent =
  | "before-user-created"
  | "custom-access-token"
  | "password-verification"
  | "send-email";

export interface ApiAuthHook {
  id: string;
  event: ApiAuthHookEvent;
  targetType: "url" | "function";
  url: string | null;
  functionName: string | null;
  headers: Record<string, string> | null;
  timeoutMs: number;
  onError: "allow" | "deny";
  enabled: boolean;
  /** Presence only — the signing secret has no read-back path. */
  hasSecret: boolean;
  consecutiveFailures: number;
  lastFailureAt: string | number | null;
  disabledReason: string | null;
}

export interface AuthHookInput {
  event: ApiAuthHookEvent;
  targetType: "url" | "function";
  url?: string;
  functionName?: string;
  onError: "allow" | "deny";
  secret?: string;
  timeoutMs?: number;
  enabled?: boolean;
}

export interface AuthHookTestResult {
  ok: boolean;
  ms: number;
  error?: string;
  /** `custom-access-token` only — claims the hook returned that would be
   *  dropped as reserved, which is the usual reason one never appears. */
  droppedClaims?: string[];
  verdict?: {
    allow?: boolean;
    reason?: string;
    claims?: Record<string, unknown>;
    handled?: boolean;
  };
}

export const authHooksApi = {
  list: () => api<Envelope<ApiAuthHook[]>>(`/api/admin/auth-hooks`),
  create: (body: AuthHookInput) =>
    api<Envelope<ApiAuthHook>>(`/api/admin/auth-hooks`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  update: (id: string, body: Partial<AuthHookInput>) =>
    api<Envelope<ApiAuthHook>>(`/api/admin/auth-hooks/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  remove: (id: string) => api<{ ok: true }>(`/api/admin/auth-hooks/${id}`, { method: "DELETE" }),
  test: (id: string) =>
    api<AuthHookTestResult>(`/api/admin/auth-hooks/${id}/test`, { method: "POST" }),
};

/* ── captcha ── */

export type CaptchaTarget = "sign-up" | "sign-in" | "password-reset" | "forms";

export interface ApiCaptchaConfig {
  provider: "turnstile" | "hcaptcha" | "recaptcha" | null;
  /** The public half — what a browser needs to render the widget. */
  siteKey: string;
  protect: CaptchaTarget[];
  /** No safe default exists; see the card's copy. */
  onError: "allow" | "deny";
  enabled: boolean;
  /** Presence only — the secret has no read-back path. */
  hasSecret: boolean;
}

export const captchaApi = {
  get: () => api<{ data: ApiCaptchaConfig }>(`/api/admin/captcha`),
  set: (body: {
    provider: string;
    siteKey: string;
    secretKey?: string;
    protect: CaptchaTarget[];
    onError: "allow" | "deny";
    enabled?: boolean;
  }) =>
    api<{ data: ApiCaptchaConfig }>(`/api/admin/captcha`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  remove: () => api<{ ok: true }>(`/api/admin/captcha`, { method: "DELETE" }),
};

/* ── impersonation ── */

export interface ApiImpersonation {
  id: string;
  actorUserId: string;
  actorEmail: string | null;
  subjectUserId: string;
  subjectEmail: string | null;
  reason: string;
  readOnly: boolean;
  expiresAt: number;
  endedAt: number | null;
  endedBy: string | null;
  createdAt: number | null;
  active: boolean;
}

export const impersonationApi = {
  list: (activeOnly = false) =>
    api<{ data: ApiImpersonation[] }>(
      `/api/admin/impersonation${activeOnly ? "?activeOnly=true" : ""}`,
    ),
  /** Returns a working access token for the subject — treat it as a credential. */
  start: (body: { subjectUserId: string; reason: string; readOnly?: boolean; minutes?: number }) =>
    api<{ data: ApiImpersonation; token: string; expiresAt: number }>(
      `/api/admin/impersonation`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  end: (id: string) =>
    api<{ data: ApiImpersonation }>(`/api/admin/impersonation/${id}/end`, { method: "POST" }),
};

/* ── signing keys ── */

export interface ApiSigningKey {
  id: string;
  /** RFC 7638 thumbprint — derived from the key, never chosen. */
  kid: string;
  alg: "ES256" | "RS256";
  status: "standby" | "in_use" | "previously_used" | "revoked";
  note: string | null;
  createdAt: number | null;
  activatedAt: number | null;
  retiredAt: number | null;
  revokedAt: number | null;
  /** Whether the public half is currently in `/.well-known/jwks.json`. */
  published: boolean;
}

export const signingKeysApi = {
  list: () => api<Envelope<ApiSigningKey[]>>(`/api/admin/signing-keys`),
  /** Always lands in `standby` — a verifier caches the JWKS, so a key has to be
   *  visible before it signs. */
  generate: (body: { alg?: string; note?: string }) =>
    api<Envelope<ApiSigningKey>>(`/api/admin/signing-keys`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  promote: (id: string) =>
    api<Envelope<ApiSigningKey>>(`/api/admin/signing-keys/${id}/promote`, { method: "POST" }),
  revoke: (id: string) =>
    api<Envelope<ApiSigningKey>>(`/api/admin/signing-keys/${id}/revoke`, { method: "POST" }),
  restore: (id: string) =>
    api<Envelope<ApiSigningKey>>(`/api/admin/signing-keys/${id}/restore`, { method: "POST" }),
  remove: (id: string) =>
    api<{ ok: true }>(`/api/admin/signing-keys/${id}`, { method: "DELETE" }),
};

/* ── OAuth clients ── */

export interface ApiOAuthClient {
  id: string;
  clientId: string;
  name: string;
  /** `public` — PKCE, no secret. `confidential` — holds a secret. */
  type: string;
  redirectUrls: string[];
  disabled: boolean;
  /** True when the client registered itself — nobody vetted it. */
  dynamic: boolean;
  hasSecret: boolean;
  activeTokens: number;
  createdAt: number | null;
}

export interface ApiOAuthGrant {
  id: string;
  clientId: string;
  clientName: string;
  userId: string;
  scopes: string[];
  createdAt: number | null;
}

export const oauthClientsApi = {
  list: () =>
    api<Envelope<ApiOAuthClient[]> & { dynamicRegistration: boolean }>(
      `/api/admin/oauth-clients`,
    ),
  /** The secret comes back once, and only for a confidential client. */
  register: (body: { name: string; redirectUrls: string[]; type?: string }) =>
    api<Envelope<ApiOAuthClient> & { clientSecret: string | null }>(
      `/api/admin/oauth-clients`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  setDisabled: (clientId: string, disabled: boolean) =>
    api<{ ok: true }>(`/api/admin/oauth-clients/${clientId}`, {
      method: "PATCH",
      body: JSON.stringify({ disabled }),
    }),
  remove: (clientId: string) =>
    api<{ ok: true }>(`/api/admin/oauth-clients/${clientId}`, { method: "DELETE" }),
  grants: (query = "") =>
    api<Envelope<ApiOAuthGrant[]>>(`/api/admin/oauth-clients/grants${query}`),
  revokeGrant: (clientId: string, userId: string) =>
    api<{ ok: true; tokensRevoked: number }>(`/api/admin/oauth-clients/grants/revoke`, {
      method: "POST",
      body: JSON.stringify({ clientId, userId }),
    }),
};
