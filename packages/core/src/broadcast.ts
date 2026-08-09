/**
 * Broadcast channels — the wire protocol and the pattern grammar for
 * application-owned realtime channels.
 *
 * Everything here is pure and dependency-free on purpose: the server matches a
 * published channel name against stored rules with it, and the admin's rule
 * editor previews a match with the SAME functions rather than a second
 * implementation that agrees today and drifts tomorrow.
 *
 * ## The pattern grammar is CLOSED
 *
 * A pattern is colon-separated segments, each one of:
 *
 *   `literal`  matches itself, exactly
 *   `*`        matches exactly one segment, whatever it is
 *   `{name}`   matches exactly one segment AND captures it as `name`
 *   `**`       matches one or more remaining segments; only valid as the last
 *
 * That is the whole grammar. It is closed for the same reason the sequence
 * pattern grammar is: a closed grammar can be DECODED, not merely matched —
 * `{name}` captures turn `org:{org}:feed` into `$channel.org`, which is what
 * lets one rule authorize every org's feed without the operator enumerating
 * orgs. A regex, or a glob with alternation, would match just as well and
 * capture nothing.
 */

/** Segments a channel name may be split into. Two colons in a row, a leading
 *  or trailing colon, or an empty name are all rejected rather than normalized
 *  — a channel called `a::b` and one called `a:b` must not be the same rule. */
export const MAX_CHANNEL_SEGMENTS = 8;
/** Ceiling on a channel name. Channel names are keys in a Durable Object
 *  namespace and in a Redis stream; unbounded names are unbounded storage. */
export const MAX_CHANNEL_NAME = 200;

/** Who a rule lets through.
 *
 *  Four answers, which is exactly why `subscribe`/`publish` are stored as one
 *  JSON object rather than as a nullable roles column beside a nullable
 *  condition column — two nullable columns can spell three answers, and the
 *  one they collapse ("nobody") is the safe one.
 *
 *   - `none`          — nobody. A read-only channel is `publish: none`.
 *   - `public`        — anyone, including an unauthenticated caller.
 *   - `authenticated` — any caller with a session or token in this workspace.
 *   - `roles`         — a caller holding at least one of `roles`.
 *
 *  `condition` narrows any of them (except `none`, where it can't matter) and
 *  is a permission-DSL condition evaluated against the pattern's captures. */
export type ChannelAccessKind = "none" | "public" | "authenticated" | "roles";

export interface ChannelAccess {
  access: ChannelAccessKind;
  /** Required (non-empty) when `access` is `roles`; ignored otherwise. */
  roles?: string[];
  /**
   * Permission-DSL condition over the channel's CAPTURES, not over a row:
   * `{ org: { _eq: "$org.id" } }` on the pattern `org:{org}:feed` means "the
   * org segment must be the org this request is acting in". Every `$user.*` /
   * `$org.*` / `$tenant.id` / `$now` variable resolves as it does anywhere
   * else, because this is evaluated by `matchesCondition` — the same evaluator
   * realtime filtering and the permission simulator use.
   */
  condition?: unknown;
}

export interface BroadcastRuleView {
  id: string;
  name: string;
  pattern: string;
  subscribe: ChannelAccess;
  publish: ChannelAccess;
  presence: boolean;
  replay: boolean;
  retentionHours: number;
  enabled: boolean;
}

/** Result of matching a channel name against a pattern. */
export interface PatternMatch {
  /** Captures from `{name}` segments. A `**` tail is captured as `_rest`. */
  params: Record<string, string>;
}

const SEGMENT_RE = /^[A-Za-z0-9_.@-]+$/;
const CAPTURE_RE = /^\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

/** Capture names that would land as object-model keys on the row a condition
 *  is evaluated against. `__proto__` matches the capture regex perfectly. */
const RESERVED_CAPTURE_NAMES = new Set(["__proto__", "constructor", "prototype"]);

/** Split a channel name into segments, or `null` when it is not a legal name.
 *  Rejects rather than normalizes: `a::b` is not `a:b`. */
export const splitChannel = (channel: string): string[] | null => {
  if (!channel || channel.length > MAX_CHANNEL_NAME) return null;
  const parts = channel.split(":");
  if (parts.length > MAX_CHANNEL_SEGMENTS) return null;
  for (const p of parts) {
    if (!SEGMENT_RE.test(p)) return null;
  }
  return parts;
};

/**
 * Validate a pattern, returning the problem as a string or `null` when it is
 * legal. Exported so the create/update endpoint and the admin editor refuse
 * the same patterns for the same stated reason.
 */
export const validatePattern = (pattern: string): string | null => {
  if (!pattern || pattern.length > MAX_CHANNEL_NAME) {
    return `Pattern must be 1–${MAX_CHANNEL_NAME} characters`;
  }
  const parts = pattern.split(":");
  if (parts.length > MAX_CHANNEL_SEGMENTS) {
    return `Pattern may have at most ${MAX_CHANNEL_SEGMENTS} segments`;
  }
  const seen = new Set<string>();
  for (let i = 0; i < parts.length; i += 1) {
    const p = parts[i]!;
    if (p === "**") {
      if (i !== parts.length - 1) return "`**` may only be the last segment";
      continue;
    }
    if (p === "*") continue;
    const cap = CAPTURE_RE.exec(p);
    if (cap) {
      const name = cap[1]!;
      if (name === "_rest") return "`{_rest}` is reserved for the `**` tail";
      // Captures become KEYS on the object the condition is evaluated against.
      // `__proto__` matches the capture regex, and a key by that name is a
      // property nothing downstream should have to reason about. Refused for
      // the same reason the auth-hook claim filter refuses it.
      if (RESERVED_CAPTURE_NAMES.has(name)) {
        return `"${name}" cannot be a capture name — it collides with an object-model key`;
      }
      if (seen.has(name)) return `Duplicate capture name: {${name}}`;
      seen.add(name);
      continue;
    }
    if (!SEGMENT_RE.test(p)) {
      return `Segment "${p}" must be a literal, \`*\`, \`**\` or \`{name}\``;
    }
  }
  return null;
};

/**
 * Match `channel` against `pattern`, returning its captures, or `null`.
 * Assumes `pattern` already passed {@link validatePattern}; an invalid pattern
 * simply fails to match (fail closed) rather than throwing into a fan-out.
 */
export const matchPattern = (pattern: string, channel: string): PatternMatch | null => {
  const parts = splitChannel(channel);
  if (!parts) return null;
  const pat = pattern.split(":");
  const params: Record<string, string> = Object.create(null) as Record<string, string>;
  for (let i = 0; i < pat.length; i += 1) {
    const p = pat[i]!;
    if (p === "**") {
      if (i !== pat.length - 1) return null;
      const rest = parts.slice(i);
      if (rest.length === 0) return null;
      params._rest = rest.join(":");
      return { params };
    }
    const seg = parts[i];
    if (seg === undefined) return null;
    if (p === "*") continue;
    const cap = CAPTURE_RE.exec(p);
    if (cap) {
      params[cap[1]!] = seg;
      continue;
    }
    if (p !== seg) return null;
  }
  return pat.length === parts.length ? { params } : null;
};

/**
 * Rank a pattern by SPECIFICITY, highest wins. Two rules can match the same
 * channel (`chat:*` and `chat:lobby`), and which one applies must not depend
 * on insertion order — an operator who adds a narrow rule expects it to beat
 * the broad one that was already there.
 *
 * Literals beat captures beat `*` beats `**`, weighted by position so an
 * earlier literal outranks a later one. Ties are broken by the caller on
 * `pattern` lexicographically, so the choice is total and reproducible.
 */
export const patternSpecificity = (pattern: string): number => {
  const pat = pattern.split(":");
  let score = 0;
  for (let i = 0; i < pat.length; i += 1) {
    const p = pat[i]!;
    const weight = MAX_CHANNEL_SEGMENTS - i;
    if (p === "**") score += 0;
    else if (p === "*") score += 1 * weight;
    else if (CAPTURE_RE.test(p)) score += 2 * weight;
    else score += 4 * weight;
  }
  return score;
};

// --- Wire protocol ----------------------------------------------------------

/** Who sent a broadcast message. Server-stamped from the session at publish
 *  time — never read from the body, so a member cannot appear as another. */
export interface BroadcastSender {
  id: string;
  name: string | null;
}

/** A published application message. */
export interface BroadcastMessageFrame {
  kind: "message";
  /** Caller-chosen name within the channel; `message` when unspecified. */
  event: string;
  data: unknown;
  from: BroadcastSender | null;
  /** Server epoch ms at publish time. */
  at: number;
}

/**
 * A presence frame. The roster is derived by each client from the message
 * stream (hello / ping with a TTL sweep, bye on leave) rather than held on the
 * server — the same stateless protocol `collab:*` uses, and for the same
 * reason: it survives every transport this product has (in-process, Durable
 * Object, Redis Stream, Ably) instead of only the two that can hold mutable
 * membership.
 */
export interface BroadcastPresenceFrame {
  kind: "presence";
  t: "hello" | "ping" | "bye";
  /** Small opaque state the member advertises (a cursor, a status). */
  state?: Record<string, unknown>;
  from: BroadcastSender;
  at: number;
}

export type BroadcastFrame = BroadcastMessageFrame | BroadcastPresenceFrame;

/** What a client sends to `POST /api/realtime/{channel}/publish`. */
export type BroadcastPublishInput =
  | { kind?: "message"; event?: string; data: unknown }
  | { kind: "presence"; t: "hello" | "ping" | "bye"; state?: Record<string, unknown> };

/** Serialized ceiling on one message's `data`. A broadcast fans out to every
 *  subscriber and, when `replay` is on, is stored per channel — so the cost of
 *  a large payload is multiplied twice over. */
export const MAX_BROADCAST_PAYLOAD_BYTES = 16_384;
/** Ceiling on a presence `state`. Presence frames repeat every few seconds. */
export const MAX_PRESENCE_STATE_BYTES = 1_024;
/** Hard ceiling on `retentionHours`, matching the three-day drop the design
 *  was measured against. Replay is a reconnect aid, not an event store: a
 *  workspace that needs history should write rows to a collection. */
export const MAX_REPLAY_RETENTION_HOURS = 72;
/** Messages one replay request may return. */
export const REPLAY_PAGE_SIZE = 25;
