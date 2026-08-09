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
  revokeOthers: () =>
    api<{ ok: true; removed: number }>(`/api/admin/auth/sessions/revoke-others`, {
      method: "POST",
    }),
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
