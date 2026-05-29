import { createAuthClient } from "better-auth/react";
import { magicLinkClient } from "better-auth/client/plugins";
import { passkeyClient } from "@better-auth/passkey/client";

/**
 * Client plugin set must mirror what's enabled on the server (see
 * apps/web/src/server/context.ts). Magic-link is added unconditionally —
 * if the server doesn't have the plugin, the calls return a clear error
 * which the UI surfaces via toast.
 */
export const createBacklexAuthClient = (baseURL: string) =>
  createAuthClient({
    baseURL,
    plugins: [passkeyClient(), magicLinkClient()],
  });

export type BacklexAuthClient = ReturnType<typeof createBacklexAuthClient>;
