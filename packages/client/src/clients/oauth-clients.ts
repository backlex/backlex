import type { ClientCore } from "../core";

/** A client registered with this instance's authorization server. */
export interface OAuthClient {
  id: string;
  clientId: string;
  name: string;
  /** `public` — PKCE, no secret. `confidential` — holds a secret. */
  type: string;
  redirectUrls: string[];
  disabled: boolean;
  /** True when the client registered itself dynamically — nobody vetted it. */
  dynamic: boolean;
  hasSecret: boolean;
  activeTokens: number;
  createdAt: number | null;
}

/** A consent somebody gave a client. */
export interface OAuthGrant {
  id: string;
  clientId: string;
  clientName: string;
  userId: string;
  scopes: string[];
  createdAt: number | null;
}

export interface OAuthClientsClient {
  list: () => Promise<{ data: OAuthClient[]; dynamicRegistration: boolean }>;
  /**
   * Register a client. `clientSecret` comes back ONCE and only for a
   * confidential client — a public one gets none, because PKCE is what protects
   * it and a secret shipped in a browser is not a secret.
   */
  register: (input: {
    name: string;
    redirectUrls: string[];
    type?: "public" | "confidential";
  }) => Promise<{ data: OAuthClient; clientSecret: string | null }>;
  /** Disabling stops the client immediately and keeps its history. */
  setDisabled: (clientId: string, disabled: boolean) => Promise<{ ok: boolean }>;
  /** Cascades the client's tokens and consents away. Prefer disabling. */
  delete: (clientId: string) => Promise<{ ok: boolean }>;
  grants: (opts?: { userId?: string; clientId?: string; limit?: number }) =>
    Promise<{ data: OAuthGrant[] }>;
  /** Deletes the consent AND every token issued under it. */
  revokeGrant: (clientId: string, userId: string) =>
    Promise<{ ok: boolean; tokensRevoked: number }>;
}

export const makeOAuthClients = (core: ClientCore): OAuthClientsClient => {
  const base = "/api/admin/oauth-clients";
  const one = (id: string) => `${base}/${encodeURIComponent(id)}`;
  return {
    list: () =>
      core.request<{ data: OAuthClient[]; dynamicRegistration: boolean }>("GET", base),
    register: (input) =>
      core.request<{ data: OAuthClient; clientSecret: string | null }>("POST", base, input),
    setDisabled: (clientId, disabled) =>
      core.request<{ ok: boolean }>("PATCH", one(clientId), { disabled }),
    delete: (clientId) => core.request<{ ok: boolean }>("DELETE", one(clientId)),
    grants: (opts) => {
      const q = new URLSearchParams();
      if (opts?.userId) q.set("userId", opts.userId);
      if (opts?.clientId) q.set("clientId", opts.clientId);
      if (opts?.limit) q.set("limit", String(opts.limit));
      const qs = q.toString();
      return core.request<{ data: OAuthGrant[] }>("GET", `${base}/grants${qs ? `?${qs}` : ""}`);
    },
    revokeGrant: (clientId, userId) =>
      core.request<{ ok: boolean; tokensRevoked: number }>("POST", `${base}/grants/revoke`, {
        clientId,
        userId,
      }),
  };
};
