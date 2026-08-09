import type { ClientCore } from "../core";

/**
 * Who a channel rule lets through. Four answers, so the field is one object
 * rather than a nullable roles list beside a nullable condition — the answer
 * two nullable fields would collapse is "nobody", which is the safe one.
 */
export interface ChannelAccess {
  access: "none" | "public" | "authenticated" | "roles";
  /** Required and non-empty when `access` is `roles`. */
  roles?: string[];
  /**
   * Permission-DSL condition over the pattern's CAPTURES, not over a row. On
   * the pattern `org:{org}:feed`, `{ org: { _eq: "$org.id" } }` means the org
   * segment must be the org this request is acting in.
   */
  condition?: unknown;
}

/** A rule governing the application-owned channels matching `pattern`. */
export interface ChannelRule {
  id: string;
  name: string;
  /**
   * Colon-separated segments: a literal, `*` (one segment), `**` (the rest,
   * last only) or `{name}` (one segment, captured for the condition).
   */
  pattern: string;
  subscribe: ChannelAccess;
  publish: ChannelAccess;
  /** Members may announce themselves (`hello` / `ping` / `bye`). */
  presence: boolean;
  /** Messages are retained so `history()` can read the recent past back. */
  replay: boolean;
  /** How far back `history()` reaches. Capped at 72. */
  retentionHours: number;
  enabled: boolean;
}

export type ChannelRuleInput = Omit<ChannelRule, "id"> & {
  presence?: boolean;
  replay?: boolean;
  retentionHours?: number;
  enabled?: boolean;
};

/** A retained message, as `history()` returns it. */
export interface ChannelMessage {
  id: string;
  event: string;
  data: unknown;
  /** Who published it — server-stamped, so it cannot be forged. */
  from: { id: string; name: string | null } | null;
  at: number;
  /** Opaque keyset cursor; pass the page's last one back as `since`. */
  cursor: string;
}

export interface ChannelExplain {
  channel: string;
  /** True for `items:*`, `collab:*`, `presence:*`, `agent:thread:*`,
   *  `signal:*` and `collections` — those carry their own gates, not a rule. */
  managed: boolean;
  matched: { id: string; name: string; pattern: string } | null;
  params: Record<string, string>;
  canSubscribe: boolean;
  canPublish: boolean;
  reason: string;
}

export interface ChannelsClient {
  /** Admin: the workspace's channel rules. */
  list: () => Promise<{ data: ChannelRule[] }>;
  create: (input: ChannelRuleInput) => Promise<{ data: ChannelRule }>;
  update: (id: string, patch: Partial<ChannelRuleInput>) => Promise<{ data: ChannelRule }>;
  delete: (id: string) => Promise<{ ok: boolean }>;
  /**
   * Publish an application message. The sender identity is stamped from the
   * session server-side; anything you put in `data` travels as-is.
   */
  publish: (channel: string, data: unknown, event?: string) => Promise<{ ok: boolean }>;
  /**
   * Announce yourself on a channel whose rule enables presence. The roster is
   * derived by each client from these frames with a TTL sweep — there is no
   * server-held membership, which is what lets presence work on every
   * transport rather than only the two that could hold one.
   */
  presence: (
    channel: string,
    t: "hello" | "ping" | "bye",
    state?: Record<string, unknown>,
  ) => Promise<{ ok: boolean }>;
  /**
   * Retained messages, oldest first, at most 25 per call. Pass the previous
   * response's `cursor` as `since` to continue. Only available on a rule with
   * `replay` on, and never further back than its `retentionHours`.
   */
  history: (
    channel: string,
    opts?: { since?: string; limit?: number },
  ) => Promise<{ data: ChannelMessage[]; cursor: string | null }>;
  /** What would happen if this caller touched `channel`, and which rule decides. */
  explain: (channel: string) => Promise<ChannelExplain>;
}

export const makeChannels = (core: ClientCore): ChannelsClient => {
  const admin = "/api/admin/realtime-channels";
  const rule = (id: string) => `${admin}/${encodeURIComponent(id)}`;
  const ch = (channel: string) => `/api/realtime/${encodeURIComponent(channel)}`;
  return {
    list: () => core.request<{ data: ChannelRule[] }>("GET", admin),
    create: (input) => core.request<{ data: ChannelRule }>("POST", admin, input),
    update: (id, patch) => core.request<{ data: ChannelRule }>("PATCH", rule(id), patch),
    delete: (id) => core.request<{ ok: boolean }>("DELETE", rule(id)),
    publish: (channel, data, event) =>
      core.request<{ ok: boolean }>("POST", `${ch(channel)}/publish`, { event, data }),
    presence: (channel, t, state) =>
      core.request<{ ok: boolean }>("POST", `${ch(channel)}/publish`, {
        kind: "presence",
        t,
        state,
      }),
    history: (channel, opts) => {
      const q = new URLSearchParams();
      if (opts?.since) q.set("since", opts.since);
      if (opts?.limit) q.set("limit", String(opts.limit));
      const qs = q.toString();
      return core.request<{ data: ChannelMessage[]; cursor: string | null }>(
        "GET",
        `${ch(channel)}/replay${qs ? `?${qs}` : ""}`,
      );
    },
    explain: (channel) => core.request<ChannelExplain>("GET", `${ch(channel)}/explain`),
  };
};
