import { createAuthClient } from "better-auth/react";
import { magicLinkClient, twoFactorClient } from "better-auth/client/plugins";
import { passkeyClient } from "@better-auth/passkey/client";

/**
 * Client plugin set must mirror what's enabled on the server (see
 * apps/web/src/server/context.ts). Magic-link is added unconditionally —
 * if the server doesn't have the plugin, the calls return a clear error
 * which the UI surfaces via toast. The two-factor plugin is always on the
 * server, so its client counterpart is always present too — it exposes
 * `auth.twoFactor.*` (enable / verifyTotp / disable / generateBackupCodes)
 * and makes `signIn.email` return `{ twoFactorRedirect: true }` for users
 * who have TOTP enabled.
 */
export const createBacklexAuthClient = (baseURL: string) =>
  createAuthClient({
    baseURL,
    // Hard cap every auth request. `better-fetch` aborts once the timeout
    // fires, so a stalled instance (cold Worker + slow/provisioning DB) turns
    // into a surfaced error instead of an auth call that never resolves — the
    // symptom being the "Claiming…" / "Signing in…" button frozen forever with
    // no feedback and no way to retry. The WebAuthn ceremony is browser-native
    // (not a fetch), so this doesn't cut short a biometric prompt.
    fetchOptions: { timeout: 30_000 },
    plugins: [passkeyClient(), magicLinkClient(), twoFactorClient()],
  });

export type BacklexAuthClient = ReturnType<typeof createBacklexAuthClient>;
