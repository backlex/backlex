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
    plugins: [passkeyClient(), magicLinkClient(), twoFactorClient()],
  });

export type BacklexAuthClient = ReturnType<typeof createBacklexAuthClient>;
