import type { AuthResult, AuthSession, AuthSurface, AuthUser, ClientCore } from "../core";

/** Auth surface for a workspace's end-users (and the admin pool). See `createClient`. */
export interface AuthClient {
  /** Email + password sign-up (app mode → a workspace end-user). */
  signUp(input: { email: string; password: string; name?: string }): Promise<AuthResult>;
  /** Email + password sign-in. */
  signIn(input: { email: string; password: string }): Promise<AuthResult>;
  /** Begin an OAuth sign-in; returns the provider authorize `url` to navigate to. */
  signInSocial(
    provider: string,
    input?: { callbackURL?: string; errorCallbackURL?: string },
  ): Promise<{ url: string; redirect: boolean }>;
  /** Send a one-time sign-in link by email (magic-link provider). */
  signInMagicLink(input: { email: string; callbackURL?: string }): Promise<{ status: boolean }>;
  /** Email a one-time numeric code (email-otp provider). */
  sendVerificationOTP(input: {
    email: string;
    type?: "sign-in" | "email-verification" | "forget-password";
  }): Promise<{ success: boolean }>;
  /** Complete an email-OTP sign-in with the emailed code. */
  signInEmailOTP(input: { email: string; otp: string }): Promise<AuthResult>;
  /** Send a password-reset email. */
  requestPasswordReset(input: { email: string; redirectTo?: string }): Promise<{ status: boolean }>;
  /** Complete a reset with the emailed token and a new password. */
  resetPassword(input: { newPassword: string; token: string }): Promise<{ status: boolean }>;
  /** Accept an admin-issued end-user invite (app mode only — the admin plane
   *  has no invite/accept endpoint): sets the password on the pending account
   *  and signs straight in; the session token is captured like `signIn`. */
  acceptInvite(input: { token: string; password: string }): Promise<AuthResult>;
  /** Mint a fresh short-lived access JWT from the stored session token (app mode). */
  refresh(): Promise<{ accessToken: string; refreshToken: string; expiresIn: number; tokenType: string }>;
  /** Change the signed-in user's password. */
  changePassword(input: {
    newPassword: string;
    currentPassword: string;
    revokeOtherSessions?: boolean;
  }): Promise<Record<string, unknown>>;
  /** Update the signed-in user's profile (e.g. `{ name, image }`). */
  updateUser(attributes: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Send an email-verification link to the signed-in (or named) user. */
  sendVerificationEmail(input: { email: string; callbackURL?: string }): Promise<{ status: boolean }>;
  /** Sign out the current session. */
  signOut(): Promise<{ success: boolean }>;
  /** Current session, or `{ user: null }`. */
  getSession(): Promise<{ user: AuthUser | null } & Record<string, unknown>>;
  /** List the signed-in user's active sessions. */
  listSessions(): Promise<AuthSession[]>;
  /** Revoke one session by its token. */
  revokeSession(input: { token: string }): Promise<{ status: boolean }>;
  /** Revoke every session except the current one. */
  revokeOtherSessions(): Promise<{ status: boolean }>;
  /** Revoke all sessions, including the current one. */
  revokeSessions(): Promise<{ status: boolean }>;
  /** Public description of this workspace's auth surface (providers + policy). */
  providers(): Promise<AuthSurface>;
  /** The current workspace session token (app mode) — persist across reloads. */
  getToken(): string | null;
  /** Restore a workspace session token (app mode). */
  setToken(token: string | null): void;
}

export const makeAuth = (core: ClientCore): AuthClient => {
  const captureToken = (r: AuthResult): AuthResult => {
    if (core.opts.workspace && typeof r.token === "string") core.setToken(r.token);
    return r;
  };

  const auth: AuthClient = {
    /** Email + password sign-up. In app mode this creates a *workspace* end-
     *  user (in `app_users`), not a control-plane account. */
    signUp: (input: { email: string; password: string; name?: string }) =>
      core.request<AuthResult>("POST", `${core.authBase}/sign-up/email`, input).then(captureToken),
    /** Email + password sign-in. */
    signIn: (input: { email: string; password: string }) =>
      core.request<AuthResult>("POST", `${core.authBase}/sign-in/email`, input).then(captureToken),
    /**
     * Begin an OAuth sign-in. Returns `{ url }` — the provider's authorize
     * page — which a browser app should navigate to (`location.href = url`).
     * `provider` must be one of the ids returned by `auth.providers()`.
     */
    signInSocial: (
      provider: string,
      input?: { callbackURL?: string; errorCallbackURL?: string },
    ) =>
      core.request<{ url: string; redirect: boolean }>("POST", `${core.authBase}/sign-in/social`, {
        provider,
        ...input,
        // ask better-auth for the URL instead of a 302, so the caller controls
        // the navigation.
        disableRedirect: true,
      }),
    /** Send a one-time sign-in link by email (requires the `magic` provider
     *  to be enabled for the workspace). */
    signInMagicLink: (input: { email: string; callbackURL?: string }) =>
      core.request<{ status: boolean }>("POST", `${core.authBase}/sign-in/magic-link`, input),
    /** Email a one-time numeric code (requires the `email-otp` provider). `type`
     *  defaults to `"sign-in"`; use `"email-verification"` / `"forget-password"`
     *  for those flows. Complete a sign-in with `signInEmailOTP`. */
    sendVerificationOTP: (input: {
      email: string;
      type?: "sign-in" | "email-verification" | "forget-password";
    }) =>
      core.request<{ success: boolean }>("POST", `${core.authBase}/email-otp/send-verification-otp`, {
        type: "sign-in",
        ...input,
      }),
    /** Complete an email-OTP sign-in with the code from `sendVerificationOTP`. In
     *  app mode the returned session token is captured and replayed as a bearer. */
    signInEmailOTP: (input: { email: string; otp: string }) =>
      core.request<AuthResult>("POST", `${core.authBase}/sign-in/email-otp`, input).then(captureToken),
    /** Send a password-reset email. `redirectTo` is the link the email points at. */
    requestPasswordReset: (input: { email: string; redirectTo?: string }) =>
      core.request<{ status: boolean }>("POST", `${core.authBase}/request-password-reset`, input),
    /** Complete a reset with the token from the email and a new password. */
    resetPassword: (input: { newPassword: string; token: string }) =>
      core.request<{ status: boolean }>("POST", `${core.authBase}/reset-password`, input),
    /** Accept an admin-issued end-user invite (`appUsers.invite` on the admin
     *  plane): `{ token, password }` activates the pending account and signs
     *  in. App mode only — `/api/t/<slug>/auth/invite/accept`. */
    acceptInvite: (input: { token: string; password: string }) =>
      core.request<AuthResult>("POST", `${core.authBase}/invite/accept`, input).then(captureToken),
    /** Mint a fresh short-lived access JWT from the stored session token (app
     *  mode). The SDK's own requests keep using the session token; use this when a
     *  downstream service needs a proper access token. */
    refresh: () =>
      core.request<{ accessToken: string; refreshToken: string; expiresIn: number; tokenType: string }>(
        "POST",
        `${core.authBase}/token/refresh`,
        { refreshToken: core.getToken() },
      ),
    /** Change the signed-in user's password (requires the current password). */
    changePassword: (input: {
      newPassword: string;
      currentPassword: string;
      revokeOtherSessions?: boolean;
    }) => core.request<Record<string, unknown>>("POST", `${core.authBase}/change-password`, input),
    /** Update the signed-in user's profile (e.g. `{ name, image }`). */
    updateUser: (attributes: Record<string, unknown>) =>
      core.request<Record<string, unknown>>("POST", `${core.authBase}/update-user`, attributes),
    /** Send an email-verification link to the signed-in (or named) user. */
    sendVerificationEmail: (input: { email: string; callbackURL?: string }) =>
      core.request<{ status: boolean }>("POST", `${core.authBase}/send-verification-email`, input),
    signOut: () => core.request<{ success: boolean }>("POST", `${core.authBase}/sign-out`).then((r) => {
      if (core.opts.workspace) core.setToken(null);
      return r;
    }),
    /** Current session, or `{ user: null }`. */
    getSession: () =>
      core.request<{ user: AuthUser | null } & Record<string, unknown>>("GET", `${core.authBase}/get-session`),
    /** List the signed-in user's active sessions (one row per device/login). */
    listSessions: () => core.request<AuthSession[]>("GET", `${core.authBase}/list-sessions`),
    /** Revoke one session by its `token` (from `listSessions`). */
    revokeSession: (input: { token: string }) =>
      core.request<{ status: boolean }>("POST", `${core.authBase}/revoke-session`, input),
    /** Revoke every session **except** the current one (sign out other devices). */
    revokeOtherSessions: () =>
      core.request<{ status: boolean }>("POST", `${core.authBase}/revoke-other-sessions`),
    /** Revoke **all** sessions, including the current one. */
    revokeSessions: () => core.request<{ status: boolean }>("POST", `${core.authBase}/revoke-sessions`),
    /** Public description of this workspace's auth surface (provider list +
     *  policy flags) — what a sign-in screen needs to render. No secrets. */
    providers: () =>
      core.request<{ data: AuthSurface }>("GET", `${core.authBase}/providers`).then((r) => r.data),
    /** The current workspace session token (app mode) — persist this across
     *  reloads and pass it back via `createClient({ token })`. */
    getToken: (): string | null => core.getToken(),
    /** Restore a workspace session token (app mode). */
    setToken: (token: string | null): void => {
      core.setToken(token);
    },
  };

  return auth;
};
