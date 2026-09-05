import { api } from "@/lib/api";
import type { Envelope } from "./types";

export interface ApiUser {
  id: string;
  email: string;
  name: string | null;
  status?: "active" | "suspended" | "invited";
  createdAt?: string;
  roles: { id: string; name: string }[];
  /** Auth method: `password`/`github`/`google`/`magic` or a federated
   *  identity (`saml`/`ldap`/`cloud`) — `invite` for pending invite rows. */
  provider?: string;
  lastSeenAt?: number | null;
  /** Whether the user has an authenticator-app (TOTP) second factor enrolled. */
  twoFactorEnabled?: boolean;
  /** tenant_members row id — present on pending-invite rows (revoke target). */
  memberId?: string;
  /** Shareable accept link — present on pending-invite rows. */
  inviteUrl?: string;
}

/** A workspace end-user (the `app_users` pool — the customers of the app
 *  built on this workspace, distinct from the control-plane `ApiUser`). */
export interface ApiAppUser {
  id: string;
  email: string;
  name: string | null;
  emailVerified: boolean;
  /**
   * `invited` is a real row with no credential behind it — the invitation has
   * been sent and not accepted. It was missing from this union while the only
   * way to become an end-user was self-signup; an admin-issued invitation
   * writes one on every create, so a page that treats "not suspended" as
   * "active" now says the opposite of the truth about a third of its rows.
   */
  status: "active" | "suspended" | "invited";
  createdAt: string | number;
  roles: { id: string; name: string }[];
}

/** What `POST /api/app-users/invite` answers. */
export interface ApiAppUserInvite {
  id: string;
  email: string;
  /**
   * The raw invite token. Deliberately not rendered anywhere in the admin: the
   * invitee receives it inside the emailed accept link, and a token that is
   * also a string on an operator's screen is a credential that outlives the
   * mailbox it was addressed to.
   */
  token: string;
  expiresAt: number;
}

export interface InviteAppUserBody {
  email: string;
  name?: string;
  /** Workspace roles bound at invite time. The admin role is refused by the
   *  server (`resolveAssignableRoles`), so never offer it. */
  roleIds?: string[];
}

/**
 * Why the server refused an invitation, off the CONFLICT's `details`. Mirrors
 * `server/services/app-user-invites.ts::InviteConflictDetails` — the two are
 * the same contract seen from either end.
 */
export interface AppUserInviteConflict {
  reason: "already_invited" | "already_a_user";
  appUserId: string;
  email: string;
  status: string;
}

/** Read the conflict shape off a thrown `ApiError`, or null when the failure
 *  was something else. Written defensively because `details` is whatever the
 *  server put there — an older deploy puts nothing. */
export const appUserInviteConflict = (err: unknown): AppUserInviteConflict | null => {
  const d = (err as { details?: unknown } | null)?.details as
    | Partial<AppUserInviteConflict>
    | undefined;
  if (!d || (d.reason !== "already_invited" && d.reason !== "already_a_user")) return null;
  if (typeof d.appUserId !== "string" || typeof d.email !== "string") return null;
  return {
    reason: d.reason,
    appUserId: d.appUserId,
    email: d.email,
    status: typeof d.status === "string" ? d.status : "invited",
  };
};

export interface ApiRole {
  id: string;
  name: string;
  description?: string | null;
  admin: boolean;
}

export const usersApi = {
  list: () => api<Envelope<ApiUser[]>>(`/api/users`),
  invite: (email: string, role?: string) =>
    api<
      Envelope<{ id: string; email: string; token: string; url: string; sent: boolean }>
    >(`/api/users/invite`, {
      method: "POST",
      body: JSON.stringify({ email, role }),
    }),
  suspend: (id: string) =>
    api<{ ok: true }>(`/api/users/${id}/suspend`, { method: "PATCH" }),
  activate: (id: string) =>
    api<{ ok: true }>(`/api/users/${id}/activate`, { method: "PATCH" }),
  revokeInvite: (memberId: string) =>
    api<{ ok: true }>(`/api/users/invite/${memberId}`, { method: "DELETE" }),
  revokeAll: (id: string) =>
    api<{ ok: true }>(`/api/users/${id}/sessions/revoke-all`, { method: "POST" }),
  /** Recover a user locked out of 2FA: clears their TOTP secret + backup
   *  codes and revokes their sessions so they can sign in and re-enrol. */
  resetTwoFactor: (id: string) =>
    api<{ ok: true }>(`/api/users/${id}/reset-two-factor`, { method: "POST" }),
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

export type PermissionAction = "read" | "create" | "update" | "delete" | "publish";

export interface PermissionSimRule {
  permissionId: string;
  roleId: string;
  roleName: string;
  collection: string;
  condition: unknown | null;
  fields: string[] | null;
  rowMatch?: boolean;
}

export interface PermissionSimulation {
  subject: {
    userId: string | null;
    email: string | null;
    roles: string[];
    tenantId: string | null;
    plane: "platform" | "app";
  };
  collection: string;
  action: string;
  allowed: boolean;
  isAdmin: boolean;
  reason: string;
  roles: { id: string; name: string; admin: boolean }[];
  matchedRules: PermissionSimRule[];
  resolvedVars: Record<string, unknown>;
  whereSql: { sql: string; params: unknown[] } | null;
  fields: string[] | null;
  rowMatch?: boolean;
}

export interface PermissionSimulateInput {
  collection: string;
  action: PermissionAction;
  userId?: string | null;
  email?: string | null;
  roles?: string[] | null;
  plane?: "platform" | "app";
  sampleRow?: Record<string, unknown> | null;
}

export const permissionsApi = {
  /** Dry-run the permission resolver and return the full allow/deny trace. */
  simulate: (input: PermissionSimulateInput) =>
    api<Envelope<PermissionSimulation>>(`/api/permissions/simulate`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
};

/** Written outside the namespace so `resendInvite` can call both without the
 *  object having to refer to itself. */
const inviteAppUser = (body: InviteAppUserBody) =>
  api<Envelope<ApiAppUserInvite>>(`/api/app-users/invite`, {
    method: "POST",
    body: JSON.stringify(body),
  });

const deleteAppUser = (id: string) =>
  api<{ ok: true }>(`/api/app-users/${id}`, { method: "DELETE" });

/** Workspace end-user pool admin (the `app_users` table). All endpoints are
 *  admin-only and scoped to the active workspace. */
export const appUsersApi = {
  /** `q` = email/name substring search; `ids` = batch label resolution for
   *  `interface: "user"` fields. */
  list: (params?: { q?: string; ids?: string[] }) => {
    const qs = new URLSearchParams();
    if (params?.q) qs.set("q", params.q);
    if (params?.ids?.length) qs.set("ids", params.ids.join(","));
    const query = qs.toString();
    return api<Envelope<ApiAppUser[]>>(`/api/app-users${query ? `?${query}` : ""}`);
  },
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
  remove: deleteAppUser,
  sessions: (id: string) =>
    api<Envelope<{ id: string; userAgent: string | null; ipAddress: string | null; createdAt: number | null; updatedAt: number | null }[]>>(
      `/api/app-users/${id}/sessions`,
    ),
  revokeSession: (id: string, sessionId: string) =>
    api<{ ok: true }>(`/api/app-users/${id}/sessions/${sessionId}`, { method: "DELETE" }),
  /**
   * Provision an end-user the operator names, rather than waiting for one to
   * sign themselves up. Writes a pending row and mails an accept link; the
   * account exists but cannot sign in until that link is opened.
   *
   * A repeat of an address already in the pool throws — read the failure with
   * {@link appUserInviteConflict} to learn which kind.
   */
  invite: inviteAppUser,
  /**
   * Withdraw an invitation nobody has accepted.
   *
   * The pending row IS the invitation, so deleting it is what withdrawal means:
   * the outstanding token then resolves to nothing and the accept endpoint
   * answers "Invited end-user no longer exists". There is no separate revoke
   * route because there is nothing else to revoke.
   */
  revokeInvite: deleteAppUser,
  /**
   * Send a fresh invitation to somebody who never accepted the first one.
   *
   * Composed rather than a single call: `/api/app-users/invite` has no resend
   * counterpart, so the only honest way to mint a new token is to withdraw the
   * pending invitation and issue another. Safe precisely because the row is
   * pending — it has no credential, no session and no OAuth account, and the
   * roles come from the dialog that is calling. It is NOT an update: the new
   * invitation carries a new `app_users.id`, so anything that recorded the old
   * one (a person row linked at invite time via `link`) still points at the
   * withdrawn row. Only offer it for `status: "invited"`.
   */
  resendInvite: async (appUserId: string, body: InviteAppUserBody) => {
    await deleteAppUser(appUserId);
    return inviteAppUser(body);
  },
};

/** A member's standing inside an organization — governs org administration,
 *  not data access. The workspace roles bound to them *within* the org do
 *  that, and live on `ApiOrgMember.roles`. */
export type OrgRole = "owner" | "admin" | "member";

export interface ApiOrg {
  id: string;
  slug: string;
  name: string;
  image: string | null;
  metadata: Record<string, unknown> | null;
  createdBy: string | null;
  createdAt: number | null;
  updatedAt: number | null;
  memberCount: number;
}

export interface ApiOrgMember {
  appUserId: string;
  email: string;
  name: string | null;
  status: string;
  role: OrgRole;
  /** Workspace roles bound to this member within this org. */
  roles: { id: string; name: string }[];
  createdAt: number | null;
}

export interface ApiOrgInvite {
  id: string;
  orgId: string;
  email: string;
  role: OrgRole;
  roleIds: string[];
  invitedBy: string | null;
  expiresAt: number;
  acceptedAt: number | null;
  createdAt: number | null;
  pending: boolean;
}

/** App-plane organizations ("teams"). Admin-only, scoped to the active
 *  workspace. Every id argument also accepts the org's slug. */
export const appOrgsApi = {
  list: (params?: { q?: string }) => {
    const qs = params?.q ? `?q=${encodeURIComponent(params.q)}` : "";
    return api<Envelope<ApiOrg[]>>(`/api/app-orgs${qs}`);
  },
  create: (body: { name: string; slug?: string; ownerAppUserId?: string }) =>
    api<Envelope<ApiOrg>>(`/api/app-orgs`, { method: "POST", body: JSON.stringify(body) }),
  patch: (id: string, body: { name?: string; slug?: string; image?: string | null }) =>
    api<Envelope<ApiOrg>>(`/api/app-orgs/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  remove: (id: string) => api<{ ok: true }>(`/api/app-orgs/${id}`, { method: "DELETE" }),

  members: (id: string) => api<Envelope<ApiOrgMember[]>>(`/api/app-orgs/${id}/members`),
  addMember: (id: string, body: { appUserId: string; role?: OrgRole; roleIds?: string[] }) =>
    api<Envelope<ApiOrgMember>>(`/api/app-orgs/${id}/members`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  patchMember: (id: string, appUserId: string, body: { role?: OrgRole; roleIds?: string[] }) =>
    api<Envelope<ApiOrgMember>>(`/api/app-orgs/${id}/members/${appUserId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  removeMember: (id: string, appUserId: string) =>
    api<{ ok: true }>(`/api/app-orgs/${id}/members/${appUserId}`, { method: "DELETE" }),

  invites: (id: string, params?: { pending?: boolean }) =>
    api<Envelope<ApiOrgInvite[]>>(
      `/api/app-orgs/${id}/invites${params?.pending ? "?pending=true" : ""}`,
    ),
  invite: (id: string, body: { email: string; role?: OrgRole; roleIds?: string[] }) =>
    api<Envelope<{ id: string; email: string; role: OrgRole; token: string; expiresAt: number }>>(
      `/api/app-orgs/${id}/invites`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  revokeInvite: (id: string, inviteId: string) =>
    api<{ ok: true }>(`/api/app-orgs/${id}/invites/${inviteId}`, { method: "DELETE" }),
};

/** Minimal "who am I" identity surface (`GET /api/me`). */
export interface ApiMe {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
  roles: string[];
  isAdmin: boolean;
  /** Instance operator — a STRICT subset of `isAdmin`. The `admin` role is
   *  self-serve (creating a workspace grants it there), so instance-global
   *  surfaces — the JWT keyring, the OAuth client registry, control-plane SSO,
   *  `sql` panels, the SQL console — are gated on this one instead. Optional
   *  so an older server (no field) reads as "not proven", never as `true`. */
  isOperator?: boolean;
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
  /** Per-user list-view columns (slug → ordered field names). PATCH replaces
   *  the full map; drop a slug to fall back to the workspace default. */
  getListColumns: () =>
    api<Envelope<Record<string, string[]>>>(`/api/account/list-columns`),
  patchListColumns: (listColumns: Record<string, string[]>) =>
    api<{ ok: true }>(`/api/account/list-columns`, {
      method: "PATCH",
      body: JSON.stringify({ listColumns }),
    }),
};

/* ── row-level security ── */

export interface RlsOmission {
  collection: string;
  role: string;
  action: string;
  reason: string;
}

export interface RlsStatusResult {
  /** False on SQLite/D1 — there is nothing to compile policies into. */
  supported: boolean;
  appliesTo: string;
  installed: Array<{ table: string; name: string; command: string }>;
  expected: Array<{ table: string; name: string }>;
  /** Installed but no longer expected — a rule changed since the last apply. */
  stale: Array<{ table: string; name: string; command: string }>;
  /** Expected but not installed — a rule was added since. */
  missing: Array<{ table: string; name: string }>;
  omissions: RlsOmission[];
  notOwned: string[];
}

export interface RlsPlanResult {
  helpers: string[];
  enables: string[];
  policies: Array<{
    collection: string;
    table: string;
    role: string;
    action: string;
    name: string;
    statements: string[];
  }>;
  omissions: RlsOmission[];
  notOwned: string[];
}

export const rlsApi = {
  status: () => api<RlsStatusResult>(`/api/admin/rls/status`),
  plan: () => api<RlsPlanResult>(`/api/admin/rls/plan`),
  apply: () =>
    api<{ applied: number; tables: string[]; statements: number; omissions: RlsOmission[] }>(
      `/api/admin/rls/apply`,
      { method: "POST" },
    ),
  disable: () =>
    api<{ dropped: number; disabled: string[] }>(`/api/admin/rls/disable`, { method: "POST" }),
};
