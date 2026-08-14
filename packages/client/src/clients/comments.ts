import type { ClientCore } from "../core";

/** One discussion comment on a record. */
export interface Comment {
  id: string;
  collection: string;
  itemId: string;
  /** The author, or `null` when the account has since been removed. */
  userId: string | null;
  body: string;
  createdAt: unknown;
}

/**
 * Per-record discussion (`/api/comments`).
 *
 * Comments are addressed by the record they hang off, never by themselves —
 * there is no "list every comment" — because the permission that governs a
 * comment is the read permission on the row it is about.
 */
export interface CommentsClient {
  /** Comments on one record, oldest first. */
  list(collection: string, itemId: string): Promise<{ data: Comment[] }>;
  /** Post a comment. The author is the calling identity; it is not settable. */
  post(input: { collection: string; itemId: string; body: string }): Promise<{ data: Comment }>;
  /** Delete a comment by its own id. */
  delete(id: string): Promise<{ ok: boolean }>;
}

export const makeComments = (core: ClientCore): CommentsClient => {
  const base = "/api/comments";
  return {
    list: (collection, itemId) => {
      const q = new URLSearchParams({ collection, itemId });
      return core.request<{ data: Comment[] }>("GET", `${base}?${q}`);
    },
    post: (input) => core.request<{ data: Comment }>("POST", base, input),
    delete: (id) => core.request<{ ok: boolean }>("DELETE", `${base}/${encodeURIComponent(id)}`),
  };
};
