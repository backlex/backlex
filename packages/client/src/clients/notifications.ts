import type { ClientCore } from "../core";

/** One in-app notification, as the bell renders it. */
export interface Notification {
  id: string;
  title: string;
  body: string | null;
  url: string | null;
  /** The recipient, or `null` for a broadcast everyone in the workspace sees. */
  userId: string | null;
  readAt: unknown;
  createdAt: unknown;
}

/**
 * In-app notifications (`/api/notifications`) — the bell an application draws.
 *
 * Distinct from `messaging`, which is push and SMS: a notification here lives
 * in the workspace and is read in the application, so it needs no device
 * registration and survives the user not having the app open.
 */
export interface NotificationsClient {
  /** The caller's notifications plus workspace broadcasts, newest first. */
  list(opts?: { limit?: number; unread?: boolean }): Promise<{ data: Notification[] }>;
  /** How many are unread — the number on the bell. */
  unreadCount(): Promise<{ data: { count: number } }>;
  /**
   * Send one.
   *
   * **An administrator may target any user; anyone else may only notify
   * themselves.** That rule lives on the server; this method does not check it
   * and does not hide it.
   */
  send(input: {
    title: string;
    body?: string;
    url?: string;
    /**
     * Target user. **Omitting it sends to the caller**, not to everyone — the
     * server falls back to the calling identity. Workspace-wide broadcasts
     * exist as stored rows, but they are written by flows rather than through
     * this endpoint.
     */
    userId?: string | null;
    /** Also fan out to that user's push devices. Ignored for broadcasts. */
    push?: boolean;
    // Only the new row's id comes back, not the row: the caller already holds
    // everything they sent, so re-reading it would be a second query nobody
    // learns anything from.
  }): Promise<{ data: { id: string } }>;
  /** Mark one read. */
  markRead(id: string): Promise<{ ok: boolean }>;
  /** Mark every one of the caller's notifications read. */
  markAllRead(): Promise<{ ok: boolean }>;
}

export const makeNotifications = (core: ClientCore): NotificationsClient => {
  const base = "/api/notifications";
  return {
    list: (opts) => {
      const q = new URLSearchParams();
      if (opts?.limit) q.set("limit", String(opts.limit));
      // The server spells this `unread=1`, not a boolean — matched exactly
      // rather than translated, so the SDK and a hand-written request agree.
      if (opts?.unread) q.set("unread", "1");
      const qs = q.toString();
      return core.request<{ data: Notification[] }>("GET", `${base}${qs ? `?${qs}` : ""}`);
    },
    unreadCount: () => core.request<{ data: { count: number } }>("GET", `${base}/_unread-count`),
    send: (input) => core.request<{ data: { id: string } }>("POST", base, input),
    markRead: (id) =>
      core.request<{ ok: boolean }>("POST", `${base}/${encodeURIComponent(id)}/read`),
    markAllRead: () => core.request<{ ok: boolean }>("POST", `${base}/_read-all`),
  };
};
