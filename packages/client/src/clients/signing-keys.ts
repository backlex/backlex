import type { ClientCore } from "../core";

/**
 * Where a signing key is in its life.
 *
 *  - `standby` — published in the JWKS, signing nothing. A verifier caches the
 *    JWKS, so a key must be visible before it signs.
 *  - `in_use` — exactly one; new tokens carry its `kid`.
 *  - `previously_used` — no longer signs, still verifies: its tokens are live.
 *  - `revoked` — out of the JWKS; its tokens stop verifying.
 */
export type SigningKeyStatus = "standby" | "in_use" | "previously_used" | "revoked";

export interface SigningKey {
  id: string;
  /** RFC 7638 thumbprint — derived from the key, never chosen. */
  kid: string;
  alg: "ES256" | "RS256";
  status: SigningKeyStatus;
  note: string | null;
  createdAt: number | null;
  activatedAt: number | null;
  retiredAt: number | null;
  revokedAt: number | null;
  /** Whether the public half is currently in `/.well-known/jwks.json`. */
  published: boolean;
}

export interface SigningKeysClient {
  list: () => Promise<{ data: SigningKey[] }>;
  /** Generate a key pair. Always created in `standby` — promote it once the
   *  JWKS has propagated to whoever verifies your tokens. */
  generate: (input?: { alg?: "ES256" | "RS256"; note?: string }) => Promise<{ data: SigningKey }>;
  /** Import a PKCS#8 PEM — including the one in `AUTH_JWT_PRIVATE_KEY`, which
   *  is how a deployment moves off env vars without invalidating live tokens. */
  import: (privateKey: string, note?: string) => Promise<{ data: SigningKey }>;
  /** Sign with this key from now on; the incumbent becomes `previously_used`. */
  promote: (id: string) => Promise<{ data: SigningKey }>;
  /** Remove from the JWKS. Refused for the key currently in use. */
  revoke: (id: string) => Promise<{ data: SigningKey }>;
  /** Undo a revocation. Every transition is reversible. */
  restore: (id: string) => Promise<{ data: SigningKey }>;
  /** Only a revoked key — anything else still verifies live tokens. */
  delete: (id: string) => Promise<{ ok: boolean }>;
}

export const makeSigningKeys = (core: ClientCore): SigningKeysClient => {
  const base = "/api/admin/signing-keys";
  const one = (id: string) => `${base}/${encodeURIComponent(id)}`;
  return {
    list: () => core.request<{ data: SigningKey[] }>("GET", base),
    generate: (input) => core.request<{ data: SigningKey }>("POST", base, input ?? {}),
    import: (privateKey, note) =>
      core.request<{ data: SigningKey }>("POST", `${base}/import`, { privateKey, note }),
    promote: (id) => core.request<{ data: SigningKey }>("POST", `${one(id)}/promote`, {}),
    revoke: (id) => core.request<{ data: SigningKey }>("POST", `${one(id)}/revoke`, {}),
    restore: (id) => core.request<{ data: SigningKey }>("POST", `${one(id)}/restore`, {}),
    delete: (id) => core.request<{ ok: boolean }>("DELETE", one(id)),
  };
};
