/**
 * Shared types for the @backlex/auth-ui package.
 *
 * The package is i18n-free and router-agnostic: every page receives a `copy`
 * object (already-translated strings), a `navigate` callback, and an auth
 * client that satisfies the minimal surface below. Consumers (the OSS admin
 * SPA, the upcoming backlex-cloud repo, …) wire React Router / Lingui /
 * better-auth on the outside.
 */

import type { ReactNode } from "react";

/** Mode the AuthShell is rendering — drives footer link visibility + copy. */
export type AuthMode = "sign-in" | "sign-up" | "magic" | "forgot" | "claim";

/** Workspace-level branding shown in the brand panel + form-column header. */
export interface AuthBranding {
  /** Logo URL (square; rendered at 28x28). When absent, falls back to an
   *  initial-letter chip from `name`. */
  logoUrl?: string | null;
  /** Workspace name (used in the lockup + initial-letter fallback). */
  name: string;
  /** Optional admin-overridden headline for the sign-in screen. */
  signInHeadline?: string | null;
  /** Optional admin-overridden tagline for the sign-in screen. */
  signInTagline?: string | null;
}

/** Generic result shape used by better-auth client methods. */
export interface AuthResult {
  error?: { message?: string } | null;
  data?: unknown;
}

/**
 * Minimal auth-client interface the pages need. Modeled after better-auth's
 * client; cloud / OSS pass their real client (extra methods are tolerated).
 */
export interface AuthClient {
  getSession: () => Promise<{ data?: { session?: unknown } | null } | unknown>;
  signIn: {
    email: (opts: {
      email: string;
      password: string;
    }) => Promise<AuthResult>;
    /** Optional — better-auth's passkey plugin. */
    passkey?: (opts?: { autoFill?: boolean }) => Promise<AuthResult>;
    /** Optional — better-auth's magic-link plugin. */
    magicLink?: (opts: {
      email: string;
      callbackURL?: string;
    }) => Promise<AuthResult>;
    /** Optional — better-auth's social plugin. */
    social?: (opts: {
      provider: string;
      callbackURL?: string;
    }) => Promise<AuthResult>;
  };
  signUp: {
    email: (opts: {
      email: string;
      password: string;
      name: string;
    }) => Promise<AuthResult>;
  };
  /** Optional — better-auth password-reset endpoints. */
  forgetPassword?: (opts: {
    email: string;
    redirectTo?: string;
  }) => Promise<AuthResult>;
  resetPassword?: (opts: {
    newPassword: string;
    token: string;
  }) => Promise<AuthResult>;
  /** Optional — better-auth passkey plugin (enrolment). */
  passkey?: {
    addPasskey?: (opts: {
      name: string;
      authenticatorAttachment?: "platform" | "cross-platform";
    }) => Promise<AuthResult>;
  };
}

/**
 * Router-agnostic Link component the consumer supplies. The default in the
 * OSS admin is `react-router-dom`'s `<Link to=…>`; cloud may use Next.js's
 * `<Link href=…>` and adapt accordingly.
 */
export type LinkComponent = (props: {
  to: string;
  className?: string;
  children: ReactNode;
}) => ReactNode;

/** Notifier callback — toast / inline / etc. Defaults to a no-op. */
export type Notifier = (message: string, context?: string) => void;

/** Shared "wiring" props injected into every page. */
export interface AuthWiring {
  /** Auth client (better-auth-shaped). */
  authClient: AuthClient;
  /** Push a route programmatically. */
  navigate: (to: string, opts?: { replace?: boolean }) => void;
  /** Read a query-string parameter from the current URL. */
  searchParam: (key: string) => string | null;
  /** Router-agnostic Link (e.g. React Router's `<Link to=…>`). */
  Link: LinkComponent;
  /** Optional notifier for transient errors (toast). */
  notify?: Notifier;
}

/** Copy strings the AuthShell renders. */
export interface AuthShellCopy {
  /** Per-mode brand-panel headline. `<em>` is rendered as the primary
   *  highlight; pass plain text or a ReactNode. */
  headline: ReactNode;
  /** Per-mode brand-panel sub-line. */
  lede: ReactNode;
  /** Footer link labels (also used for aria/visible text). */
  signInLabel: string;
  signUpLabel: string;
  magicLinkLabel: string;
  claimInstanceLabel: string;
  /** Theme toggle aria-label / title. */
  toggleTheme: string;
}

/** Surface flags pulled from `/api/auth/providers` (or any equivalent). */
export interface AuthSurfaceFlags {
  /** First-user mode (zero users in the DB). Drives "claim instance" link. */
  firstUserMode?: boolean;
  /** Whether public sign-up is open. */
  openSignup?: boolean;
  /** Whether new accounts must verify their email. */
  requireEmailVerification?: boolean;
  /** Whether the server has the passkey plugin enabled. Gates the sign-up
   *  passkey-enrolment checkbox (browser support alone isn't enough — the
   *  endpoint must exist). */
  passkey?: boolean;
}
