import type { AuthResult, AuthSession, AuthSurface, AuthUser, ClientCore } from "../core";

/**
 * Who the client currently believes it is.
 *
 * `status` has three values rather than a boolean because "we have not asked
 * yet" is a real state and every application was hand-rolling it. Four of the
 * four example SPAs opened with a `booting` flag whose only job was to keep
 * the sign-in form from flashing before the stored session had been checked;
 * `"unknown"` is that flag, computed once, in the one place that can know.
 */
export interface AuthSessionState {
  /** `"unknown"` until the first {@link AuthClient.resolve}; then settled. */
  status: "unknown" | "authenticated" | "anonymous";
  /** The app-mode session token, if there is one. `null` on the cookie plane. */
  token: string | null;
  /** The signed-in user, once resolved. */
  user: AuthUser | null;
}

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
  /**
   * The session as a value, with no request.
   *
   * **Returns the same reference until something actually changes.** That is a
   * contract, not an optimisation: `useSyncExternalStore` compares snapshots by
   * identity, so a getter that built a fresh object each call would re-render
   * forever under React 19.
   */
  getState(): AuthSessionState;
  /** Subscribe to session changes; returns an unsubscribe. Fires on sign-in,
   *  sign-out, and any other write to the token — including one made in a
   *  different part of the app. */
  onChange(fn: (state: AuthSessionState) => void): () => void;
  /**
   * Ask the server who this is and settle {@link getState} from the answer.
   *
   * Idempotent and de-duplicated: concurrent callers share one in-flight
   * request, so a page mounting six components that each want the session
   * still makes one call.
   */
  resolve(): Promise<AuthSessionState>;
}

export const makeAuth = (core: ClientCore): AuthClient => {
  const captureToken = (r: AuthResult): AuthResult => {
    if (core.opts.workspace && typeof r.token === "string") core.setToken(r.token);
    return r;
  };

  // The cached snapshot. Replaced only when a field really differs, so the
  // reference is stable and `useSyncExternalStore` settles.
  let state: AuthSessionState = { status: "unknown", token: core.getToken(), user: null };
  const listeners = new Set<(s: AuthSessionState) => void>();

  const publish = (next: AuthSessionState): AuthSessionState => {
    if (next.status === state.status && next.token === state.token && next.user === state.user) {
      return state;
    }
    state = next;
    for (const fn of listeners) fn(state);
    return state;
  };

  // A token write is the one signal available without asking the server.
  // Clearing it is knowable on its own — nobody is signed in. Setting one says
  // a DIFFERENT person may be signed in, which is only knowable by asking, so
  // the status drops back to "unknown" rather than claiming the previous user.
  core.onTokenChange((token) => {
    publish(
      token === null
        ? { status: "anonymous", token: null, user: null }
        : { status: "unknown", token, user: null },
    );
  });

  /**
   * The body sent by the auth POSTs that take no parameters.
   *
   * It exists to make a HEADER appear, not to carry anything. better-auth
   * refuses a POST without `content-type: application/json` with a 415 before
   * its handler runs, and `core.request` only sets that header when there is a
   * body — deliberately, because a bodyless POST to one of backlex's OWN routes
   * made the server's validator try to parse an empty string. So the two rules
   * are each right for their own side and disagree here; an empty object is the
   * smallest thing that satisfies both, and better-auth ignores it.
   *
   * Do not "simplify" this back to a bodyless call: `signOut` then rejects
   * before reaching the code that clears the token, which leaves the app signed
   * in with the session still live — the exact failure the persistence work was
   * meant to end.
   */
  const NO_PARAMS = {};

  /** Shared in-flight `resolve`, so six components mounting at once make one
   *  request rather than six. */
  let inFlight: Promise<AuthSessionState> | null = null;

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
    signOut: () =>
      core.request<{ success: boolean }>("POST", `${core.authBase}/sign-out`, NO_PARAMS).then((r) => {
      if (core.opts.workspace) core.setToken(null);
      // Also published directly: on the cookie plane there is no token to
      // clear, so the token listener never fires and the state would stay
      // `authenticated` with the session already gone.
      publish({ status: "anonymous", token: core.getToken(), user: null });
      return r;
    }),
    /** Current session, or `{ user: null }`. Settles the cached state on the
     *  way past, so a caller who asks the long way round still updates
     *  anything watching `onChange`. */
    getSession: () =>
      core
        // Widened to `| null` because that is what actually arrives: better-auth
        // answers a signed-OUT probe with a bare `null` body under HTTP 200, on
        // both planes, not with `{ user: null }`. `core.request<T>` casts
        // whatever it parsed to `T`, so the narrower type was a claim nothing
        // checked — and dereferencing the `null` threw a TypeError inside this
        // `.then`. That rejected `resolve()`, leaving the status on "unknown"
        // for good; `useSession` catches the rejection into `error`, so it
        // failed with nothing in the console while every app sat on its loading
        // branch. Normalize here rather than in `core.request`: other endpoints
        // may return null legitimately, and matching this method's own declared
        // return type is this method's job.
        .request<({ user: AuthUser | null } & Record<string, unknown>) | null>(
          "GET",
          `${core.authBase}/get-session`,
        )
        .then((r) => {
          const session = r ?? { user: null };
          publish(
            session.user
              ? { status: "authenticated", token: core.getToken(), user: session.user }
              : { status: "anonymous", token: core.getToken(), user: null },
          );
          // Returned normalized too: the signature promises an object, and a
          // caller destructuring `{ user }` is the documented way to read it.
          return session;
        }),
    /** List the signed-in user's active sessions (one row per device/login). */
    listSessions: () => core.request<AuthSession[]>("GET", `${core.authBase}/list-sessions`),
    /** Revoke one session by its `token` (from `listSessions`). */
    revokeSession: (input: { token: string }) =>
      core.request<{ status: boolean }>("POST", `${core.authBase}/revoke-session`, input),
    /** Revoke every session **except** the current one (sign out other devices). */
    revokeOtherSessions: () =>
      core.request<{ status: boolean }>(
        "POST",
        `${core.authBase}/revoke-other-sessions`,
        NO_PARAMS,
      ),
    /** Revoke **all** sessions, including the current one. */
    revokeSessions: () =>
      core.request<{ status: boolean }>("POST", `${core.authBase}/revoke-sessions`, NO_PARAMS),
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
    getState: () => state,
    onChange: (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    resolve: () => {
      if (inFlight) return inFlight;
      inFlight = auth
        .getSession()
        .then(() => state)
        .catch((err) => {
          // A failed probe is not proof of anonymity — a dropped connection
          // would otherwise sign the user out of the interface while their
          // session is perfectly good. The status stays where it was and the
          // caller decides what to show.
          throw err;
        })
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },
  };

  return auth;
};
