import { useEffect, useState } from "react";
import { createBacklexAuthClient } from "@backlex/auth/client";
import { api } from "./api";

export const auth = createBacklexAuthClient(
  import.meta.env.VITE_API_URL ?? window.location.origin,
);

export interface PublicProvider {
  id: string;
  kind: "credential" | "magic-link" | "email-otp" | "passkey" | "social";
  label: string;
  enabled: boolean;
}

export interface AuthSurface {
  tenantId: string | null;
  providers: PublicProvider[];
  policy: {
    openSignup: boolean;
    requireEmailVerification: boolean;
    [key: string]: unknown;
  };
  firstUserMode: boolean;
  /** When in first-user mode and the deployment pinned an owner (managed
   *  cloud), the email allowed to claim the first-admin account. */
  ownerEmail?: string;
  /** Admin-customised sign-in screen copy. Empty strings = use the default. */
  branding?: {
    signInHeadline: string;
    signInTagline: string;
    /** Absolute URLs for the sign-up consent links; empty = hide that link. */
    termsUrl?: string;
    privacyUrl?: string;
  };
}

let surfaceCache: Promise<AuthSurface> | null = null;
const fetchAuthSurface = (): Promise<AuthSurface> => {
  if (!surfaceCache) {
    surfaceCache = api<{ data: AuthSurface }>("/api/auth/providers")
      .then((r) => r.data)
      .catch((err) => {
        // Don't poison the cache on transient failures — let the next render retry.
        surfaceCache = null;
        throw err;
      });
  }
  return surfaceCache;
};

/**
 * Flatten the auth surface into the `AuthSurfaceFlags` shape the `@backlex/auth-ui`
 * pages consume (they read `openSignup` / `requireEmailVerification` at the top
 * level, while the API nests them under `policy`). Without this the "Sign-up is
 * disabled" / "verify your email" branches never trigger.
 */
export const toSurfaceFlags = (
  s: AuthSurface | null | undefined,
): {
  firstUserMode: boolean;
  openSignup: boolean;
  requireEmailVerification: boolean;
  passkey: boolean;
  ownerEmail?: string;
} | null =>
  s
    ? {
        firstUserMode: s.firstUserMode,
        openSignup: s.policy.openSignup,
        requireEmailVerification: s.policy.requireEmailVerification,
        passkey: s.providers.some((p) => p.id === "passkey" && p.enabled),
        ownerEmail: s.ownerEmail,
      }
    : null;

/** Drop the cached `/api/auth/providers` response so a fresh fetch happens
 *  on the next `useAuthSurface()` read — useful after first sign-up so the
 *  "claim instance" UI disappears immediately. */
export const invalidateAuthSurface = () => {
  surfaceCache = null;
};

/**
 * Fetch and memoize the public auth surface for this instance — which
 * providers are configured + enabled, the policy flags a sign-in screen
 * needs, and whether this is still a fresh "first user" instance.
 *
 * The first call hits `/api/auth/providers`; later calls share the same
 * promise so multiple components on one screen don't fan out duplicate
 * requests. The fetch failing leaves `surface` null — the screens degrade
 * gracefully (no socials, no claim banner, normal email form).
 */
export const useAuthSurface = (): {
  surface: AuthSurface | null;
  loading: boolean;
  error: Error | null;
} => {
  const [surface, setSurface] = useState<AuthSurface | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchAuthSurface()
      .then((s) => {
        if (cancelled) return;
        setSurface(s);
        setLoading(false);
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setError(e);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { surface, loading, error };
};
