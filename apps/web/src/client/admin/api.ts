// Lightweight typed client for the admin pages. Wraps the shared `api()`
// helper so the rest of the admin module only sees domain-shaped payloads.
import { api } from "@/lib/api";

export interface ApiTenant {
  id: string;
  slug: string;
  name: string;
  project: string;
  branch: string;
  env: string;
  mark: string | null;
  color: string | null;
  role: string;
}

export interface ApiTenantMember {
  id: string;
  tenantId: string;
  userId: string | null;
  email: string;
  role: string;
  status: "active" | "invited" | "suspended";
  invitedAt?: string | null;
  joinedAt?: string | null;
  createdAt?: string;
}

interface Envelope<T> {
  data: T;
  active?: string | null;
}

export interface ApiCollection {
  slug: string;
  singular?: string | null;
  plural?: string | null;
  note?: string | null;
  /** Mustache-style row-display template, e.g. `{{ title }} — {{ status }}`. */
  displayTemplate?: string | null;
  fields: {
    name: string;
    type: string;
    required?: boolean;
    unique?: boolean;
    /** Target collection slug — present when `type === "relation"`. */
    to?: string;
    interface?: string;
  }[];
  ownerScoped: boolean;
  tenantScoped?: boolean;
  versioned: boolean;
  /** When true, the physical table has a `deleted_at` column and DELETE
   *  soft-deletes. Managed-only. */
  softDelete?: boolean;
  /** When true, the collection is locked to a single live row. */
  singleton?: boolean;
  /** Opt-in sensitive-read auditing. When true, reads (list + by-id) record an
   *  `access.read` row in the audit log. Off by default. */
  auditReads?: boolean;
  /** Whether the physical table has created_at/updated_at columns. "Timestamps
   *  off" sends both as false. */
  hasCreatedAt?: boolean;
  hasUpdatedAt?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface ApiUser {
  id: string;
  email: string;
  name: string | null;
  status?: "active" | "suspended";
  createdAt?: string;
  roles: { id: string; name: string }[];
  /** Auth method: `password`/`github`/`google`/`magic` or a federated
   *  identity (`saml`/`ldap`/`cloud`). */
  provider?: string;
  lastSeenAt?: number | null;
}

/** A workspace end-user (the `app_users` pool — the customers of the app
 *  built on this workspace, distinct from the control-plane `ApiUser`). */
export interface ApiAppUser {
  id: string;
  email: string;
  name: string | null;
  emailVerified: boolean;
  status: "active" | "suspended";
  createdAt: string | number;
  roles: { id: string; name: string }[];
}

export interface ApiRole {
  id: string;
  name: string;
  description?: string | null;
  admin: boolean;
}

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

/** Per-workspace email transport config (`/api/admin/email-config`). Secret
 *  values are never sent to the browser — only the `secretsSet` flags. */
export interface ApiEmailConfig {
  tenantId: string;
  /** inherit | console | resend | sendgrid | mailgun | ses | smtp */
  provider: string;
  fromAddress: string | null;
  /** Non-secret provider params (mailgun: domain/host; ses: region/accessKeyId;
   *  smtp: host/port/secure/user). */
  config: Record<string, unknown>;
  secretsSet: { apiKey: boolean; secretAccessKey: boolean; pass: boolean };
  updatedAt: number | string | null;
  /** Deployment-level fallback, for context in the UI. */
  env: { provider: string | null; from: string | null };
  providerIds: readonly string[];
}

/** Resolved (public) workspace branding view returned by
 *  `GET /api/workspace-config` — workspace's own row merged onto `_global`
 *  for text/color/theme fields. `logoUrl` / `faviconUrl` already include the
 *  cache-busting query param when set. */
export interface ApiWorkspaceConfigResolved {
  workspaceName: string | null;
  description: string | null;
  logoUrl: string | null;
  faviconUrl: string | null;
  primaryColor: string | null;
  defaultTheme: "light" | "dark" | "system" | null;
}

/** Raw workspace branding row as returned by `/api/workspace-config/raw` —
 *  the workspace's own values (no `_global` fallback) so the admin form edits
 *  this workspace specifically. */
export interface ApiWorkspaceConfigRaw {
  tenantId: string;
  workspaceName: string | null;
  description: string | null;
  /** Logical file keys (no `tenants/<id>/` prefix). Build the preview URL as
   *  `/api/storage/<encoded-key>`. */
  logoFileKey: string | null;
  faviconFileKey: string | null;
  /** Raw OKLCH string or null (= use the design-system default). */
  primaryColor: string | null;
  /** "light" | "dark" | "system" | null (= leave to user). */
  defaultTheme: string | null;
  updatedAt: number | string | null;
}

export interface ApiEmailTemplate {
  id: string;
  tenantId: string | null;
  key: string;
  name: string;
  subject: string;
  fromAddress: string | null;
  bodyHtml: string;
  bodyText: string | null;
  variables: string[] | null;
}

export interface ApiFunction {
  id: string;
  tenantId: string | null;
  name: string;
  trigger: "http" | "event" | "cron";
  pattern: string | null;
  active: boolean;
  timeoutMs: number;
}

export interface ApiI18nString {
  id: string;
  tenantId: string | null;
  key: string;
  locale: string;
  value: string;
}

export interface ApiPanel {
  id: string;
  name: string;
  description: string | null;
  kind: "sql" | "items-aggregate" | "static";
  sql: string | null;
  viz: string;
  config: Record<string, unknown> | null;
  layout: { x: number; y: number; w: number; h: number } | null;
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

export interface ApiRuntime {
  adapter: "bun" | "workers" | "vercel";
  dialect: "pg" | "sqlite";
  bindings: { type: string; name: string; target: string; status: string }[];
  envVars: { key: string; set: boolean; secret: boolean; source: string }[];
  version: string;
}

export interface ApiActivity {
  id: string;
  userId: string | null;
  action: string;
  collection: string;
  itemId: string | null;
  ip: string | null;
  userAgent: string | null;
  payload: unknown;
  response: unknown;
  durationMs: number | null;
  createdAt: string;
}

export interface ApiBackup {
  id: string;
  kind: string;
  label: string | null;
  storageKey: string;
  size: number;
  tableCount: number;
  status: string;
  createdAt: string;
  completedAt: string | null;
}

export const tenantsApi = {
  list: () => api<Envelope<ApiTenant[]>>("/api/tenants"),
  create: (input: { name: string; project?: string; env?: string }) =>
    api<Envelope<{ id: string; slug: string; name: string }>>("/api/tenants", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  switchTo: (tenant: string) =>
    api<Envelope<{ id: string; slug: string }>>("/api/tenants/switch", {
      method: "POST",
      body: JSON.stringify({ tenant }),
    }),
  members: (id: string) =>
    api<Envelope<ApiTenantMember[]>>(`/api/tenants/${id}/members`),
  invite: (id: string, input: { email: string; role: string }) =>
    api<Envelope<{ id: string; token: string }>>(`/api/tenants/${id}/members/invite`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  removeMember: (tenantId: string, memberId: string) =>
    api<{ ok: true }>(`/api/tenants/${tenantId}/members/${memberId}`, {
      method: "DELETE",
    }),
};

export const collectionsApi = {
  list: () => api<Envelope<ApiCollection[]>>(`/api/collections`),
  get: (slug: string) => api<Envelope<ApiCollection>>(`/api/collections/${slug}`),
  create: (input: Partial<ApiCollection> & { slug: string; fields: ApiCollection["fields"] }) =>
    api<Envelope<ApiCollection>>(`/api/collections`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  patch: (slug: string, input: Partial<ApiCollection>) =>
    api<{ ok: true }>(`/api/collections/${slug}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  remove: (slug: string) =>
    api<{ ok: true; archived?: boolean }>(`/api/collections/${slug}`, { method: "DELETE" }),
  /** Re-activate an archived (adopted) collection. No-op on already-active rows. */
  restore: (slug: string) =>
    api<{ ok: true; alreadyActive?: boolean }>(`/api/collections/${slug}/restore`, {
      method: "POST",
    }),
  /** Fetch collections list, optionally including archived (adopted-soft-delete) rows. */
  listWithArchived: (includeArchived?: boolean) =>
    api<Envelope<ApiCollection[]>>(
      `/api/collections${includeArchived ? "?include_archived=true" : ""}`,
    ),
};

export interface TemplateSummary {
  id: string;
  label: string;
  description: string;
  collections: { slug: string; label: string; fieldCount: number }[];
}
export interface TemplateCatalog {
  data: TemplateSummary[];
  defaultTemplateId: string;
  hasCollections: boolean;
}
export const templatesApi = {
  list: () => api<TemplateCatalog>(`/api/admin/templates`),
  apply: (templateId: string) =>
    api<{ data: { templateId: string; created: string[]; skipped: string[] } }>(
      `/api/admin/templates/apply`,
      { method: "POST", body: JSON.stringify({ templateId }) },
    ),
};

export interface ItemsListResp<T = Record<string, unknown>> {
  data: T[];
  limit: number;
  offset: number;
  meta?: { filter_count?: number; total_count?: number };
}

export const itemsApi = {
  list: (slug: string, query?: Record<string, string | number>) => {
    const qs = query
      ? "?" + new URLSearchParams(
          Object.fromEntries(
            Object.entries(query).map(([k, v]) => [k, String(v)]),
          ),
        ).toString()
      : "";
    return api<ItemsListResp>(`/api/items/${slug}${qs}`);
  },
  get: (slug: string, id: string, query?: Record<string, string | number>) => {
    const qs = query
      ? "?" + new URLSearchParams(
          Object.fromEntries(
            Object.entries(query).map(([k, v]) => [k, String(v)]),
          ),
        ).toString()
      : "";
    return api<Envelope<Record<string, unknown>>>(`/api/items/${slug}/${id}${qs}`);
  },
  create: (slug: string, body: Record<string, unknown>) =>
    api<Envelope<Record<string, unknown>>>(`/api/items/${slug}`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  patch: (slug: string, id: string, body: Record<string, unknown>) =>
    api<Envelope<Record<string, unknown>>>(`/api/items/${slug}/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  remove: (slug: string, id: string) =>
    api<{ ok: true }>(`/api/items/${slug}/${id}`, { method: "DELETE" }),
};

export const usersApi = {
  list: () => api<Envelope<ApiUser[]>>(`/api/users`),
  invite: (email: string, role?: string) =>
    api<Envelope<{ email: string; sent: boolean }>>(`/api/users/invite`, {
      method: "POST",
      body: JSON.stringify({ email, role }),
    }),
  suspend: (id: string) =>
    api<{ ok: true }>(`/api/users/${id}/suspend`, { method: "PATCH" }),
  activate: (id: string) =>
    api<{ ok: true }>(`/api/users/${id}/activate`, { method: "PATCH" }),
  revokeAll: (id: string) =>
    api<{ ok: true }>(`/api/users/${id}/sessions/revoke-all`, { method: "POST" }),
  remove: (id: string) =>
    api<{ ok: true }>(`/api/users/${id}`, { method: "DELETE" }),
  addRole: (userId: string, roleId: string) =>
    api<{ ok: true }>(`/api/users/${userId}/roles`, {
      method: "POST",
      body: JSON.stringify({ roleId }),
    }),
  removeRole: (userId: string, roleId: string) =>
    api<{ ok: true }>(`/api/users/${userId}/roles/${roleId}`, { method: "DELETE" }),
  update: (id: string, body: { name: string }) =>
    api<{ ok: true }>(`/api/users/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  sessions: (id: string) =>
    api<Envelope<{ id: string; userAgent: string | null; ipAddress: string | null; createdAt: number | null; updatedAt: number | null }[]>>(
      `/api/users/${id}/sessions`,
    ),
  revokeSession: (id: string, sessionId: string) =>
    api<{ ok: true }>(`/api/users/${id}/sessions/${sessionId}`, { method: "DELETE" }),
};

export const rolesApi = {
  list: () => api<Envelope<ApiRole[]>>(`/api/roles`),
};

/** Workspace end-user pool admin (the `app_users` table). All endpoints are
 *  admin-only and scoped to the active workspace. */
export const appUsersApi = {
  list: () => api<Envelope<ApiAppUser[]>>(`/api/app-users`),
  setRoles: (id: string, roleIds: string[]) =>
    api<{ ok: true; roleIds: string[] }>(`/api/app-users/${id}/roles`, {
      method: "PUT",
      body: JSON.stringify({ roleIds }),
    }),
  patch: (id: string, body: { status?: "active" | "suspended"; name?: string }) =>
    api<{ ok: true }>(`/api/app-users/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  remove: (id: string) =>
    api<{ ok: true }>(`/api/app-users/${id}`, { method: "DELETE" }),
  sessions: (id: string) =>
    api<Envelope<{ id: string; userAgent: string | null; ipAddress: string | null; createdAt: number | null; updatedAt: number | null }[]>>(
      `/api/app-users/${id}/sessions`,
    ),
  revokeSession: (id: string, sessionId: string) =>
    api<{ ok: true }>(`/api/app-users/${id}/sessions/${sessionId}`, { method: "DELETE" }),
};

export const functionsApi = {
  list: () => api<Envelope<ApiFunction[]>>(`/api/functions`),
};

export const emailTemplatesApi = {
  list: () => api<Envelope<ApiEmailTemplate[]>>(`/api/admin/email-templates`),
  get: (id: string) => api<Envelope<ApiEmailTemplate>>(`/api/admin/email-templates/${id}`),
  create: (body: Omit<ApiEmailTemplate, "id" | "tenantId">) =>
    api<Envelope<ApiEmailTemplate>>(`/api/admin/email-templates`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  patch: (id: string, body: Partial<ApiEmailTemplate>) =>
    api<{ ok: true }>(`/api/admin/email-templates/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  remove: (id: string) =>
    api<{ ok: true }>(`/api/admin/email-templates/${id}`, { method: "DELETE" }),
  sendTest: (id: string, vars?: Record<string, string>) =>
    api<{ ok: true }>(`/api/admin/email-templates/${id}/send-test`, {
      method: "POST",
      body: JSON.stringify({ vars }),
    }),
};

export const workspaceConfigApi = {
  /** Public resolved view — used by `main.tsx` boot-time branding injection. */
  getResolved: () =>
    api<Envelope<ApiWorkspaceConfigResolved>>(`/api/workspace-config`),
  /** Admin form: workspace's own row, no `_global` fallback applied. */
  getRaw: () => api<Envelope<ApiWorkspaceConfigRaw>>(`/api/workspace-config/raw`),
  put: (body: {
    workspaceName?: string | null;
    description?: string | null;
    logoFileKey?: string | null;
    faviconFileKey?: string | null;
    primaryColor?: string | null;
    defaultTheme?: "light" | "dark" | "system" | "" | null;
  }) =>
    api<{ ok: true }>(`/api/workspace-config`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
};

export const emailConfigApi = {
  get: () => api<Envelope<ApiEmailConfig>>(`/api/admin/email-config`),
  put: (body: {
    provider: string;
    fromAddress?: string | null;
    config?: Record<string, unknown>;
    secrets?: Record<string, string | null>;
  }) =>
    api<{ ok: true }>(`/api/admin/email-config`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  sendTest: (to?: string) =>
    api<{ ok: true; to: string }>(`/api/admin/email-config/test`, {
      method: "POST",
      body: JSON.stringify({ to }),
    }),
};

export const i18nApi = {
  list: () => api<Envelope<ApiI18nString[]>>(`/api/admin/i18n`),
  matrix: () =>
    api<{
      data: Record<string, Record<string, string>>;
      locales: string[];
      configuredLocales: string[];
      defaultLocale: string;
    }>(`/api/admin/i18n/_matrix`),
  upsert: (key: string, locale: string, value: string) =>
    api<Envelope<ApiI18nString>>(`/api/admin/i18n`, {
      method: "PUT",
      body: JSON.stringify({ key, locale, value }),
    }),
  bulkUpsert: (rows: { key: string; locale: string; value: string }[]) =>
    api<{ ok: true; upserts: number }>(`/api/admin/i18n/_bulk`, {
      method: "PUT",
      body: JSON.stringify(rows),
    }),
  autoTranslate: (input: {
    targetLocale: string;
    sourceLocale?: string;
    keys?: string[];
    onlyMissing?: boolean;
  }) =>
    api<{
      ok: true;
      translated: number;
      remaining?: number;
      rows: { id: string; key: string; locale: string; value: string }[];
    }>(`/api/admin/i18n/_auto-translate`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
};

export const panelsApi = {
  list: () => api<Envelope<ApiPanel[]>>(`/api/admin/panels`),
  create: (body: Omit<ApiPanel, "id">) =>
    api<Envelope<ApiPanel>>(`/api/admin/panels`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  update: (id: string, body: Partial<Omit<ApiPanel, "id">>) =>
    api<Envelope<ApiPanel>>(`/api/admin/panels/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  remove: (id: string) =>
    api<{ ok: true }>(`/api/admin/panels/${id}`, { method: "DELETE" }),
  run: (id: string) =>
    api<Envelope<Record<string, unknown>[]> & { ms: number }>(`/api/admin/panels/${id}/run`, {
      method: "POST",
    }),
  preview: (body: { kind: "sql" | "items-aggregate"; sql?: string; config?: unknown }) =>
    api<Envelope<Record<string, unknown>[]> & { ms: number }>(`/api/admin/panels/preview`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
};

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

export const settingsApi = {
  load: () => api<Envelope<Record<string, unknown>>>(`/api/admin/settings`),
  patch: (body: Record<string, unknown>) =>
    api<{ ok: true }>(`/api/admin/settings`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  runtime: () => api<Envelope<ApiRuntime>>(`/api/admin/settings/runtime`),
};

export const dbAdminApi = {
  runSql: (sql: string, opts?: { writes?: boolean }) =>
    api<{ data: { rows: Record<string, unknown>[]; ms: number }[]; ms: number; count: number }>(
      `/api/admin/db/sql/run${opts?.writes ? "?writes=1" : ""}`,
      {
        method: "POST",
        headers: opts?.writes ? { "x-backlex-confirm": "yes" } : undefined,
        body: JSON.stringify({ sql }),
      },
    ),
  tables: () => api<Envelope<{ name: string; rows: number }[]>>(`/api/admin/db/tables`),
  migrations: () =>
    api<Envelope<{ id: string | number; hash: string; created_at: string | number; tag: string | null; applied: boolean }[]>>(`/api/admin/db/migrations`),
  backups: () => api<Envelope<ApiBackup[]>>(`/api/admin/db/backups`),
  backupNow: (label?: string) =>
    api<Envelope<{ id: string; storageKey: string; status: string }>>(`/api/admin/db/backups/now`, {
      method: "POST",
      body: JSON.stringify({ label }),
    }),
};

export interface ActivityListParams {
  limit?: number;
  offset?: number;
  /** Action namespace prefix — `item` matches `item.create`, `item.update`, … */
  action?: string;
  /** Inclusive lower bound on `createdAt`, epoch milliseconds. */
  from?: number;
  /** Inclusive upper bound on `createdAt`, epoch milliseconds. */
  to?: number;
  collection?: string;
  itemId?: string;
  /** `"count"` → response carries `meta.count` (total matching the filters). */
  meta?: "count";
}

export const activityApi = {
  list: (opts?: ActivityListParams) => {
    const qs = new URLSearchParams();
    if (opts?.limit != null) qs.set("limit", String(opts.limit));
    if (opts?.offset != null) qs.set("offset", String(opts.offset));
    if (opts?.action) qs.set("action", opts.action);
    if (opts?.from != null) qs.set("from", String(opts.from));
    if (opts?.to != null) qs.set("to", String(opts.to));
    if (opts?.collection) qs.set("collection", opts.collection);
    if (opts?.itemId) qs.set("itemId", opts.itemId);
    if (opts?.meta) qs.set("meta", opts.meta);
    const tail = qs.toString();
    return api<
      Envelope<ApiActivity[]> & {
        limit: number;
        offset: number;
        meta?: { count: number };
      }
    >(`/api/activity${tail ? `?${tail}` : ""}`);
  },
};

export interface ApiMetrics {
  range: string;
  windowMs: number;
  bucketMs: number;
  series: { ts: number; requests: number; errors: number }[];
  totals: { requests: number; errors: number; errorRate: number; activeUsers: number; p95Ms?: number };
  counts: {
    collections: number;
    files: number;
    flows: number;
    functions: number;
    activeFlows: number;
    pausedFlows: number;
  };
  topCollections?: { slug: string; rows: number; bytes?: number; lastWrite: number | null; writes24h?: number }[];
  recent?: { t: number; action: string; collection?: string; itemId?: string | null; userId?: string | null; ms?: number | null; error?: boolean }[];
  recentErrors?: { code: string; resource: string; msg: string; count: number; last: number }[];
}

export interface ApiEntityMetrics {
  flows: Record<string, { runs: number; lastRun: number | null }>;
  functions: Record<string, { invocations: number; p95Ms: number; lastInvoke: number | null }>;
  webhooks: Record<string, { deliveries: number; lastDelivery: number | null }>;
}

export const metricsApi = {
  overview: (range = "1h") => api<Envelope<ApiMetrics>>(`/api/admin/metrics/overview?range=${range}`),
  entities: () => api<Envelope<ApiEntityMetrics>>(`/api/admin/metrics/entities`),
};

/** Minimal "who am I" identity surface (`GET /api/me`). */
export interface ApiMe {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
  roles: string[];
  isAdmin: boolean;
  tenantId: string | null;
}

export const meApi = {
  get: () => api<Envelope<ApiMe>>(`/api/me`),
};

/** Resolved locale + time-zone preferences for the signed-in admin
 *  (`GET /api/account/preferences`). `user.*` is the raw, possibly-unset
 *  choice; `effective.*` is what the UI should actually use. */
export interface ApiAccountPreferences {
  user: { locale: string | null; timezone: string | null };
  workspace: { defaultLocale: string; locales: string[]; timezone: string };
  effective: { locale: string; timezone: string };
}

export const accountApi = {
  getPreferences: () =>
    api<Envelope<ApiAccountPreferences>>(`/api/account/preferences`),
  /** Pass `null` to clear a field back to the workspace default; omit it to
   *  leave the stored value unchanged. */
  patchPreferences: (body: {
    locale?: string | null;
    timezone?: string | null;
  }) =>
    api<{ ok: true }>(`/api/account/preferences`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
};

/** In-app notification row (`/api/notifications`). The real schema has no
 *  `kind`/`icon`/`who` columns — the bell derives an icon from `flowId`. */
export interface ApiNotification {
  id: string;
  userId: string | null;
  title: string;
  body: string | null;
  url: string | null;
  flowId: string | null;
  /** Unix-ms / ISO / null. `null` = unread. */
  readAt: unknown | null;
  createdAt: unknown;
}

export const notificationsApi = {
  list: (opts?: { unread?: boolean; limit?: number }) => {
    const qs = new URLSearchParams();
    if (opts?.unread) qs.set("unread", "1");
    if (opts?.limit != null) qs.set("limit", String(opts.limit));
    const tail = qs.toString();
    return api<Envelope<ApiNotification[]>>(
      `/api/notifications${tail ? `?${tail}` : ""}`,
    );
  },
  unreadCount: () =>
    api<Envelope<{ count: number }>>(`/api/notifications/_unread-count`),
  markRead: (id: string) =>
    api<{ ok: true }>(`/api/notifications/${id}/read`, { method: "POST" }),
  markAllRead: () =>
    api<{ ok: true }>(`/api/notifications/_read-all`, { method: "POST" }),
};

/** Per-item discussion comment (`/api/comments`). */
export interface ApiComment {
  id: string;
  collection: string;
  itemId: string;
  userId: string | null;
  body: string;
  createdAt: unknown;
}

export const commentsApi = {
  list: (collection: string, itemId: string) =>
    api<Envelope<ApiComment[]>>(
      `/api/comments?collection=${encodeURIComponent(collection)}&itemId=${encodeURIComponent(itemId)}`,
    ),
  create: (input: { collection: string; itemId: string; body: string }) =>
    api<Envelope<ApiComment>>(`/api/comments`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  remove: (id: string) =>
    api<{ ok: true }>(`/api/comments/${id}`, { method: "DELETE" }),
};

/** A public read-only share link for a record (`/api/shared-links`).
 *  The plaintext `token` is only present on the create response. */
export interface ApiSharedLink {
  id: string;
  createdAt: unknown;
  revokedAt: unknown;
}

export interface ApiCreatedSharedLink {
  id: string;
  /** One-time plaintext token — only returned here, never on list. */
  token: string;
  /** Relative `/s/<token>` path. */
  url: string;
}

export const sharedLinksApi = {
  list: (collection: string, itemId: string) =>
    api<Envelope<ApiSharedLink[]>>(
      `/api/shared-links?collection=${encodeURIComponent(collection)}&itemId=${encodeURIComponent(itemId)}`,
    ),
  create: (input: { collection: string; itemId: string }) =>
    api<Envelope<ApiCreatedSharedLink>>(`/api/shared-links`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  revoke: (id: string) =>
    api<{ ok: true }>(`/api/shared-links/${id}`, { method: "DELETE" }),
};

/** The public, unauthenticated record-share payload (`GET /api/shared/:token`). */
export interface ApiSharedRecord {
  collection: string;
  item: Record<string, unknown>;
  fields: { name: string; type: string }[];
}

export const sharedPublicApi = {
  get: (token: string) =>
    api<Envelope<ApiSharedRecord>>(`/api/shared/${encodeURIComponent(token)}`),
};

/** Advisor finding (`GET /api/admin/advisor`). */
export interface ApiAdvisorCheck {
  id: string;
  kind: "security" | "performance";
  level: "error" | "warn" | "info";
  /** Stable rule-family identifier — findings sharing it are grouped. */
  rule: string;
  /** Category label shown when several findings share the same `rule`. */
  groupTitle: string;
  title: string;
  body: string;
  fix: string;
  resource: string;
  /** Optional admin SPA route path to the relevant surface. */
  link?: string;
}

/** Advisor run result (`GET /api/admin/advisor`). */
export interface ApiAdvisorResult {
  data: ApiAdvisorCheck[];
  /** 0–100 server-computed health score. */
  score: number;
  /** ISO timestamp — one honest value per run. */
  generatedAt: string;
}

export const advisorApi = {
  list: () => api<ApiAdvisorResult>(`/api/admin/advisor`),
};
