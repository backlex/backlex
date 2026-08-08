import type { ClientCore } from "../core";

/** Workspace end-user provisioning (admin-scoped). Mirrors `/api/app-users`. */
export interface AppUsersClient {
  /** Invite an end-user: creates a pending `app_users` row (status `invited`,
   *  no credential), mints a 7-day one-shot invite token (also mailed
   *  best-effort), and optionally binds roles (`roleIds` — the admin role is
   *  rejected) and links a person row (`link` — stamps
   *  `<collection>.<itemId>.app_user_id` so `$user.id` permission conditions
   *  match after accept). The invitee completes the flow with
   *  `auth.acceptInvite({ token, password })` on an app-mode client. */
  invite(input: {
    email: string;
    name?: string;
    roleIds?: string[];
    link?: { collection: string; itemId: string };
  }): Promise<{ data: { id: string; email: string; token: string; expiresAt: number } }>;
}

export const makeAppUsers = (core: ClientCore): AppUsersClient => {
  // Workspace end-user provisioning (admin plane). The invitee accepts on an
  // app-mode client via `auth.acceptInvite`.
  const appUsers: AppUsersClient = {
    /** Invite an end-user (pending row + one-shot token; roles/link optional). */
    invite: (input: {
      email: string;
      name?: string;
      roleIds?: string[];
      link?: { collection: string; itemId: string };
    }) =>
      core.request<{ data: { id: string; email: string; token: string; expiresAt: number } }>(
        "POST",
        "/api/app-users/invite",
        input,
      ),
  };

  return appUsers;
};
