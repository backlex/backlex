import type { ClientCore } from "../core";

/** A credential for the S3-compatible endpoint. The secret is never part of
 *  this shape — it is returned once, by {@link S3Client.create}. */
export interface S3Credential {
  id: string;
  name: string;
  accessKeyId: string;
  /** Restricts this credential to keys under one prefix. */
  prefix: string | null;
  /** Refuses every mutating verb. */
  readOnly: boolean;
  enabled: boolean;
  expiresAt: number | null;
  lastUsedAt: number | null;
  createdAt: number | null;
}

export interface S3CredentialInput {
  name: string;
  prefix?: string | null;
  readOnly?: boolean;
  /** Epoch ms. */
  expiresAt?: number | null;
}

export interface S3Client {
  list: () => Promise<{ data: S3Credential[] }>;
  /**
   * Mint a credential. `secretAccessKey` comes back ONCE and has no read-back
   * path — the stored copy is encrypted so a database dump does not yield it,
   * and an endpoint that decrypted it on request would undo that.
   *
   * Point any S3 tool at `<instance>/s3` with these credentials; the bucket
   * name is the workspace slug.
   */
  create: (input: S3CredentialInput) => Promise<{
    data: S3Credential;
    secretAccessKey: string;
  }>;
  update: (id: string, patch: Partial<S3CredentialInput> & { enabled?: boolean }) =>
    Promise<{ data: S3Credential }>;
  delete: (id: string) => Promise<{ ok: boolean }>;
}

export const makeS3 = (core: ClientCore): S3Client => {
  const base = "/api/admin/s3-credentials";
  const one = (id: string) => `${base}/${encodeURIComponent(id)}`;
  return {
    list: () => core.request<{ data: S3Credential[] }>("GET", base),
    create: (input) =>
      core.request<{ data: S3Credential; secretAccessKey: string }>("POST", base, input),
    update: (id, patch) => core.request<{ data: S3Credential }>("PATCH", one(id), patch),
    delete: (id) => core.request<{ ok: boolean }>("DELETE", one(id)),
  };
};
