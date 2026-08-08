import type { ClientCore } from "../core";

/** A member's standing inside an organization. Distinct from the workspace
 *  `roles` they may also hold *within* that org. */
export type OrgRole = "owner" | "admin" | "member";

/** An app-plane organization — the B2B grouping level inside one workspace. */
export interface Org {
  id: string;
  slug: string;
  name: string;
  image: string | null;
  metadata: Record<string, unknown> | null;
  createdBy: string | null;
  createdAt: number | null;
  updatedAt: number | null;
  /** Present on list responses. */
  memberCount?: number;
  /** Present when the listing was scoped to one end-user (app mode). */
  role?: OrgRole;
}

export interface OrgMember {
  appUserId: string;
  email: string;
  name: string | null;
  status: string;
  role: OrgRole;
  /** Workspace roles bound to this member *within this org*. */
  roles: Array<{ id: string; name: string }>;
  createdAt: number | null;
}

export interface OrgInvite {
  id: string;
  orgId: string;
  email: string;
  role: OrgRole;
  roleIds: string[];
  invitedBy: string | null;
  expiresAt: number;
  acceptedAt: number | null;
  createdAt: number | null;
  /** Neither accepted nor expired. */
  pending: boolean;
}

/**
 * Organizations ("teams") — the same namespace on both planes, routed by the
 * client's mode:
 *
 *  - **app mode** (`workspace` set) → `/api/t/{workspace}/orgs`. Scoped to the
 *    signed-in end-user: they see their own orgs and act with their membership
 *    role. `create`, `acceptInvite`, `setActive` and `leave` are here.
 *  - **admin mode** → `/api/app-orgs`. The workspace operator's view: every org
 *    in the workspace, plus `addMember`.
 *
 * Members are addressed by `app_users.id`. Every id argument also accepts the
 * org's slug.
 */
export interface OrgsClient {
  /** App mode: the orgs I belong to (plus `active`, the org this client is
   *  currently acting in). Admin mode: every org in the workspace. */
  list(opts?: {
    q?: string;
  }): Promise<{ data: Org[]; active?: { orgId: string | null; role: OrgRole | null } }>;
  get(idOrSlug: string): Promise<{ data: Org }>;
  /** App mode: the caller becomes the first `owner`. Admin mode: pass
   *  `ownerAppUserId` to seed one, or omit it for an empty org. */
  create(input: {
    name: string;
    slug?: string;
    image?: string | null;
    metadata?: Record<string, unknown> | null;
    ownerAppUserId?: string;
  }): Promise<{ data: Org }>;
  update(
    idOrSlug: string,
    patch: {
      name?: string;
      slug?: string;
      image?: string | null;
      metadata?: Record<string, unknown> | null;
    },
  ): Promise<{ data: Org }>;
  delete(idOrSlug: string): Promise<{ ok: boolean }>;

  members(idOrSlug: string): Promise<{ data: OrgMember[] }>;
  /** Admin mode only — the app plane grows members through invitations. */
  addMember(
    idOrSlug: string,
    input: { appUserId: string; role?: OrgRole; roleIds?: string[] },
  ): Promise<{ data: OrgMember }>;
  /** Change the membership role and/or replace the member's org-scoped
   *  workspace roles. */
  updateMember(
    idOrSlug: string,
    appUserId: string,
    patch: { role?: OrgRole; roleIds?: string[] },
  ): Promise<{ data: OrgMember }>;
  removeMember(idOrSlug: string, appUserId: string): Promise<{ ok: boolean }>;

  invites(idOrSlug: string, opts?: { pending?: boolean }): Promise<{ data: OrgInvite[] }>;
  /** Mint a 7-day invitation (also mailed best-effort). The raw token comes
   *  back once, here — it is never listed again. */
  invite(
    idOrSlug: string,
    input: { email: string; role?: OrgRole; roleIds?: string[] },
  ): Promise<{
    data: { id: string; email: string; role: OrgRole; token: string; expiresAt: number };
  }>;
  revokeInvite(idOrSlug: string, inviteId: string): Promise<{ ok: boolean }>;
  /** App mode only. The signed-in account's email must match the invited one. */
  acceptInvite(token: string): Promise<{ data: { org: Org; role: OrgRole } }>;

  /** App mode only — pin this *session* to an org (`null` clears it). Only
   *  needed for multi-org end-users; a single-org one resolves automatically. */
  setActive(idOrSlug: string | null): Promise<{ data: Org | null }>;
  /** App mode only. The last owner must hand over first. */
  leave(idOrSlug: string): Promise<{ ok: boolean }>;

  /** Send `X-Backlex-Org` on every subsequent request from this client, so
   *  `$org.id` in permission rules resolves to it. Stateless alternative to
   *  {@link OrgsClient.setActive} — nothing is persisted server-side, and it
   *  works with access-JWT clients that have no session row. `null` clears. */
  use(idOrSlug: string | null): void;
  /** The org id/slug {@link OrgsClient.use} is currently sending, if any. */
  active(): string | null;
}

export const makeOrgs = (core: ClientCore): OrgsClient => {
  // Organizations. One namespace, two backends: an app-mode client talks to the
  // end-user surface under its workspace, an admin-mode client to the
  // control-plane one. Both are the same service behind different gates, so the
  // shapes coming back are identical.
  const orgBase = core.opts.workspace
    ? `/api/t/${encodeURIComponent(core.opts.workspace)}/orgs`
    : "/api/app-orgs";
  const orgPath = (idOrSlug: string, suffix = ""): string =>
    `${orgBase}/${encodeURIComponent(idOrSlug)}${suffix}`;

  const orgs: OrgsClient = {
    list: (o) =>
      core.request<{ data: Org[]; active?: { orgId: string | null; role: OrgRole | null } }>(
        "GET",
        `${orgBase}${o?.q ? `?q=${encodeURIComponent(o.q)}` : ""}`,
      ),
    get: (idOrSlug) => core.request<{ data: Org }>("GET", orgPath(idOrSlug)),
    create: (input) => core.request<{ data: Org }>("POST", orgBase, input),
    update: (idOrSlug, patch) =>
      core.request<{ data: Org }>("PATCH", orgPath(idOrSlug), patch),
    delete: (idOrSlug) => core.request<{ ok: boolean }>("DELETE", orgPath(idOrSlug)),

    members: (idOrSlug) =>
      core.request<{ data: OrgMember[] }>("GET", orgPath(idOrSlug, "/members")),
    addMember: (idOrSlug, input) =>
      core.request<{ data: OrgMember }>("POST", orgPath(idOrSlug, "/members"), input),
    updateMember: (idOrSlug, appUserId, patch) =>
      core.request<{ data: OrgMember }>(
        "PATCH",
        orgPath(idOrSlug, `/members/${encodeURIComponent(appUserId)}`),
        patch,
      ),
    removeMember: (idOrSlug, appUserId) =>
      core.request<{ ok: boolean }>(
        "DELETE",
        orgPath(idOrSlug, `/members/${encodeURIComponent(appUserId)}`),
      ),

    invites: (idOrSlug, o) =>
      core.request<{ data: OrgInvite[] }>(
        "GET",
        orgPath(idOrSlug, `/invites${o?.pending ? "?pending=true" : ""}`),
      ),
    invite: (idOrSlug, input) =>
      core.request<{
        data: { id: string; email: string; role: OrgRole; token: string; expiresAt: number };
      }>("POST", orgPath(idOrSlug, "/invites"), input),
    revokeInvite: (idOrSlug, inviteId) =>
      core.request<{ ok: boolean }>(
        "DELETE",
        orgPath(idOrSlug, `/invites/${encodeURIComponent(inviteId)}`),
      ),
    acceptInvite: (token) =>
      core.request<{ data: { org: Org; role: OrgRole } }>(
        "POST",
        `${orgBase}/invites/accept`,
        { token },
      ),

    setActive: (idOrSlug) =>
      core.request<{ data: Org | null }>("POST", `${orgBase}/set-active`, { orgId: idOrSlug }),
    leave: (idOrSlug) => core.request<{ ok: boolean }>("POST", orgPath(idOrSlug, "/leave")),

    use: (idOrSlug) => {
      core.setActiveOrg(idOrSlug);
    },
    active: () => core.getActiveOrg(),
  };

  return orgs;
};
