import type { ClientCore } from "../core";

/** A share link as it is listed back. Deliberately without its token. */
export interface SharedLink {
  id: string;
  createdAt: unknown;
  revokedAt: unknown;
}

/** What creating a link returns — the only time the token exists in the clear. */
export interface CreatedSharedLink {
  id: string;
  /**
   * The plaintext token, returned **once**. Only its hash is stored, so a link
   * that is not kept here cannot be recovered — revoke it and make another.
   */
  token: string;
  /** The relative `/s/<token>` path to hand out. */
  url: string;
}

/** The record behind a share token, as an unauthenticated visitor sees it. */
export interface SharedRecord {
  collection: string;
  item: Record<string, unknown>;
}

/**
 * Read-only share links for a single record (`/api/shared-links`), and the
 * public read they authorise (`/api/shared/:token`).
 *
 * The token is a bearer credential in a URL: anyone holding the link can read
 * that one record without signing in. So it is shown once on creation, stored
 * only as a hash, and `list` never carries it — a listing that did would put a
 * live credential into every screen and every log of one.
 */
export interface SharedLinksClient {
  /** Active links for one record. Never includes tokens. */
  list(collection: string, itemId: string): Promise<{ data: SharedLink[] }>;
  /** Mint a link. The token in the response is the only copy. */
  create(input: { collection: string; itemId: string }): Promise<{ data: CreatedSharedLink }>;
  /** Revoke a link by id. Takes effect immediately. */
  revoke(id: string): Promise<{ ok: boolean }>;
  /**
   * Resolve a share token to the record it opens — the call a public page
   * makes. Needs no session, which is the entire point, so it works on a
   * client with no credentials at all.
   */
  resolve(token: string): Promise<{ data: SharedRecord }>;
}

export const makeSharedLinks = (core: ClientCore): SharedLinksClient => {
  const base = "/api/shared-links";
  return {
    list: (collection, itemId) => {
      const q = new URLSearchParams({ collection, itemId });
      return core.request<{ data: SharedLink[] }>("GET", `${base}?${q}`);
    },
    create: (input) => core.request<{ data: CreatedSharedLink }>("POST", base, input),
    revoke: (id) => core.request<{ ok: boolean }>("DELETE", `${base}/${encodeURIComponent(id)}`),
    resolve: (token) =>
      core.request<{ data: SharedRecord }>("GET", `/api/shared/${encodeURIComponent(token)}`),
  };
};
