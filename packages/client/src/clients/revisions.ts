import type { ClientCore } from "../core";

/** One recorded snapshot of a row, as it stood after a write. */
export interface Revision {
  id: string;
  collection: string;
  itemId: string;
  tenantId: string | null;
  /** The author of the write, or `null` when the account has since gone. */
  userId: string | null;
  /** The full field map captured at write time. */
  snapshot: Record<string, unknown>;
  createdAt: unknown;
}

/**
 * Version history (`/api/revisions`).
 *
 * A revision is identified by its OWN id, not the row's — which is what makes
 * `revert` unambiguous when several revisions of one row are on screen. Newest
 * first, so `data[0]` is the state before the most recent change.
 */
export interface RevisionsClient {
  /** Every recorded revision of one row, newest first. */
  list(collection: string, itemId: string): Promise<{ data: Revision[] }>;
  /**
   * Put the live row back to a recorded revision, **by revision id**.
   *
   * This is itself a write: it records a new revision rather than erasing the
   * ones after it, so reverting is undoable and the history stays a history.
   */
  revert(revisionId: string): Promise<{ ok: boolean }>;
}

export const makeRevisions = (core: ClientCore): RevisionsClient => {
  const base = "/api/revisions";
  const seg = (s: string) => encodeURIComponent(s);
  return {
    list: (collection, itemId) =>
      core.request<{ data: Revision[] }>("GET", `${base}/${seg(collection)}/${seg(itemId)}`),
    revert: (revisionId) =>
      core.request<{ ok: boolean }>("POST", `${base}/${seg(revisionId)}/revert`),
  };
};
