import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { streamSSE } from "hono/streaming";
import type { SSEStreamingApi } from "hono/streaming";
import type { Context as HonoContext } from "hono";
import {
  AppError,
  SYSTEM_ROLES,
  type AuthSubject,
  type Condition,
  isAppError,
  normalizeCondition,
} from "@backlex/core";
import type { AppBindings } from "../app";
import type { Ctx } from "../context";
import type { Env } from "../env";
import { SECURITY, OkSchema, errorResponses } from "../lib/openapi";
import { resolvePermission } from "../services/permissions";
import { resolveOrgContext } from "../services/app-orgs";
import { ORG_HEADER, resolveTenantAccess } from "../middleware/tenant";
import { appSessionLive } from "../middleware/session";
import {
  loadCollection,
  type CollectionRow,
} from "../services/items/collection-loader";
import {
  currentSeq,
  joinPresence,
  publishLocal,
  renderEventForMeta,
  replayLocal,
  subscribeLocal,
  type ItemEventPayload,
  type SubscriptionMeta,
} from "../services/events";
import {
  redisLatestId,
  redisPublish,
  redisRealtimeEnabled,
  redisReadSince,
} from "../services/realtime-redis";
import { rateLimitOk } from "../lib/rate-limit";
import { isStatelessEdge } from "../lib/runtime";
import { defaultHook } from "../lib/openapi-router";
import {
  AgentPresenceSchema,
  COLLAB_PREFIX,
  CollabPublishSchema,
  buildAgentPresenceMessage,
  buildCollabMessage,
  collabConfig,
  mintAblyTokenRequest,
  type AblyTokenRequest,
  parseAgentThreadChannel,
  parseCollabChannel,
} from "../services/collab";
import { getThread } from "../services/agents/store";
import { splitChannel, REPLAY_PAGE_SIZE } from "@backlex/core";
import {
  buildBroadcastFrame,
  explainChannel,
  isManagedChannel,
  openChannelsEnabled,
  readReplay,
  recordBroadcast,
  resolveChannelRule,
  satisfiesAccess,
  type ResolvedChannel,
} from "../services/broadcast";
import {
  SIGNAL_ROOT,
  itemsConfig,
  itemsTransportKind,
  parseSignalChannel,
  signalChannel,
  signalScopeAllowsConditional,
} from "../services/realtime-signal";
import { readJson } from "../lib/body";

/** Poll interval for the Redis-Stream subscribe loop (serverless transport). */
const REDIS_POLL_MS = 1_000;
/** Max time a single serverless long-poll holds before closing so the client's
 *  EventSource reconnects (Vercel: functions "should not subscribe to data
 *  events" / hold connections open). Well under the function execution limit. */
const REDIS_HOLD_MS = 20_000;

const ITEMS_PREFIX = "items:";
const PRESENCE_PREFIX = "presence:";
/** Comment-frame keep-alive so idle SSE connections survive proxy timeouts —
 *  and, since the identity refresh rides the same timer, the ceiling on how
 *  long a revoked subscriber keeps receiving rows. See `refreshGate`. */
const HEARTBEAT_MS = 25_000;
/** The live heartbeat period. Only tests move it, through
 *  `__setRealtimeHeartbeatMs` — a held SSE stream has no other clock, so a spec
 *  that has to observe a refresh would otherwise have to wait 25 real seconds. */
let heartbeatMs: number = HEARTBEAT_MS;
/** Test-only override for {@link HEARTBEAT_MS}. Pass `null` to restore the
 *  production period. Named with the `__` prefix the other test hooks in this
 *  codebase use (`services/permissions-cache.ts::__cacheStats`) so it reads as
 *  what it is at every call site. */
export const __setRealtimeHeartbeatMs = (ms: number | null): void => {
  heartbeatMs = ms ?? HEARTBEAT_MS;
};
/** Hint the browser's EventSource reconnect delay (ms). */
const RECONNECT_HINT_MS = 3_000;
/** Backpressure bound for the in-process SSE outbound queue. A slow or dead
 *  client whose stream can't drain as fast as a publisher fills it would
 *  otherwise let the queue grow without limit → unbounded memory.
 *
 *  Policy: DISCONNECT the slow consumer rather than drop-oldest. Drop-oldest
 *  would silently punch gaps into the stream that the client never learns
 *  about; disconnecting triggers the browser's EventSource auto-reconnect,
 *  and the `Last-Event-ID` resume path replays the missed [since, snapshot]
 *  range — so the client recovers the gap cleanly instead of losing events.
 *  Slow consumers must not keep accumulating resources. */
const SSE_QUEUE_MAX = 1_000;
/** Free-form publish budget per (channel, client) in a 10s window. */
const PUBLISH_RATE_MAX = 30;
const PUBLISH_RATE_WINDOW_MS = 10_000;
const ITEM_EVENTS = new Set<ItemEventPayload["event"]>(["created", "updated", "deleted"]);

interface Gate {
  meta?: SubscriptionMeta;
  /** true for `presence:*` channels — the subscribe handler joins the roster. */
  presence?: boolean;
  /** true for `collab:*` channels — publish bodies are schema-validated and
   *  identity-stamped instead of forwarded as-is. */
  collab?: boolean;
  /** true for `agent:thread:*` channels — same treatment as collab, but the
   *  only publishable message is thread presence/typing. */
  agentThread?: boolean;
  /** true for `signal:items:*` channels — the id-only data plane. Carries no
   *  `meta` because there is no row to filter: the payload is a signal, and the
   *  actual permission gate happens on the client's follow-up REST read. */
  signal?: boolean;
  /** Set for an application-owned channel authorized by a `broadcast_channels`
   *  rule. Publish bodies are validated + identity-stamped against the rule,
   *  and retained when the rule enables replay. */
  broadcast?: ResolvedChannel;
}

const clientIp = (c: { req: { header: (n: string) => string | undefined } }): string =>
  c.req.header("cf-connecting-ip") ??
  c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
  "local";

/** System columns a realtime filter may always reference (they're always
 *  projected to the subscriber, so filtering on them leaks nothing). */
const SYSTEM_FILTER_FIELDS = new Set([
  "id",
  "created_at",
  "updated_at",
  "owner_id",
  "_status",
  "_published_at",
  "_publish_at",
]);

/** Collect the (possibly dotted) leaf field names a normalized Condition
 *  references, so we can validate them against the caller's read allow-list. */
const collectConditionFields = (cond: Condition, out: Set<string>): void => {
  const c = cond as Record<string, unknown>;
  if (Array.isArray(c.$and)) {
    for (const x of c.$and) collectConditionFields(x as Condition, out);
    return;
  }
  if (Array.isArray(c.$or)) {
    for (const x of c.$or) collectConditionFields(x as Condition, out);
    return;
  }
  if (c.$not !== undefined) {
    collectConditionFields(c.$not as Condition, out);
    return;
  }
  for (const k of Object.keys(c)) out.add(k);
};

/**
 * Parse + validate a live-query `filter` for a realtime subscription. The
 * filter is evaluated IN-MEMORY against each event's flat row, so:
 *  - nested/relation (dotted) paths are rejected — there's no joined row to
 *    walk at emit time (the client refetches those, as today);
 *  - every referenced field must exist AND be readable by the caller —
 *    otherwise a subscriber could probe an unreadable column's value by
 *    observing which events its filter lets through.
 */
const parseRealtimeFilter = (
  filterRaw: string,
  collection: CollectionRow,
  permFields: Set<string> | null,
): Condition => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(filterRaw);
  } catch {
    throw new AppError("VALIDATION", "Invalid realtime `filter` JSON");
  }
  const relationFields = new Set(
    collection.fields
      .filter((f) => f.type === "relation" || f.type === "relation_many")
      .map((f) => f.name),
  );
  const cond = normalizeCondition(parsed, { relationFields });
  const refs = new Set<string>();
  collectConditionFields(cond, refs);
  const known = new Set(collection.fields.map((f) => f.name));
  for (const field of refs) {
    if (field.includes(".")) {
      throw new AppError(
        "VALIDATION",
        `Realtime filter can't use the nested path "${field}" — events carry a flat row; filter client-side for relations`,
      );
    }
    if (!known.has(field) && !SYSTEM_FILTER_FIELDS.has(field)) {
      throw new AppError("VALIDATION", `Unknown field in realtime filter: ${field}`);
    }
    if (permFields && !permFields.has(field) && !SYSTEM_FILTER_FIELDS.has(field)) {
      throw new AppError("FORBIDDEN", `No permission to filter on field: ${field}`);
    }
  }
  return cond;
};

const gateForChannel = async (
  ctx: Ctx,
  auth: { userId: string | null; email: string | null; roles: string[]; tenantId?: string | null },
  channel: string,
  isPublish: boolean,
  filterRaw?: string,
): Promise<Gate> => {
  if (channel.startsWith(ITEMS_PREFIX)) {
    const slug = channel.slice(ITEMS_PREFIX.length);
    if (isPublish) {
      throw new AppError(
        "FORBIDDEN",
        "items:* channels are published by the API; client publish is disabled",
      );
    }
    const perm = await resolvePermission(ctx, auth, slug, "read");
    if (!perm.allowed) {
      throw new AppError(
        auth.userId ? "FORBIDDEN" : "UNAUTHORIZED",
        auth.userId
          ? `No read permission for ${slug}`
          : "Sign in required",
      );
    }
    let conditions: Condition[] | null = perm.isAdmin ? null : perm.conditions;
    // Load the collection once if we need it — for the versioned draft gate
    // (non-admin) and/or to validate a live-query filter.
    let collection: CollectionRow | null = null;
    if (auth.tenantId && (filterRaw || !perm.isAdmin)) {
      try {
        collection = await loadCollection(ctx, auth.tenantId, slug);
      } catch {
        collection = null;
      }
    }
    // Versioned collections: a subscriber without publish/update sees only
    // published items, so AND a `_status='published'` clause into every
    // permission condition (matched in-memory against each event's payload).
    if (!perm.isAdmin && collection?.versioned) {
      const canSeeDrafts =
        (await resolvePermission(ctx, auth, slug, "publish")).allowed ||
        (await resolvePermission(ctx, auth, slug, "update")).allowed;
      if (!canSeeDrafts) {
        const pub: Condition = { _status: { _eq: "published" } } as Condition;
        conditions =
          conditions && conditions.length
            ? conditions.map((c) => ({ _and: [c, pub] }) as Condition)
            : [pub];
      }
    }
    // Live-query filter (reactive Stage 1) — AND'd on top of the permission
    // conditions, narrowing what this subscriber receives.
    let queryFilter: Condition | null = null;
    if (filterRaw) {
      if (!collection) {
        throw new AppError("VALIDATION", "Realtime filter requires an active workspace");
      }
      queryFilter = parseRealtimeFilter(filterRaw, collection, perm.fields ?? null);
    }
    return {
      meta: {
        authSubject: auth,
        conditions,
        fields: perm.fields ? [...perm.fields] : null,
        queryFilter,
        // Frozen with the rest of the gate, and for the same reason: the
        // predicate that decides what this socket sees has to fold case the way
        // the store does, or it matches a superset of what a REST refetch would
        // return. A Durable Object has no database binding, so the dialect
        // travels in the meta rather than being looked up at delivery time.
        dialect: ctx.dialect,
      },
    };
  }
  if (channel.startsWith(SIGNAL_ROOT)) {
    const signalSlug = parseSignalChannel(channel);
    if (!signalSlug) {
      throw new AppError(
        "VALIDATION",
        "Malformed signal channel — expected signal:items:<slug>",
      );
    }
    // Signal-only data plane (`signal:items:<slug>`) — see
    // services/realtime-signal.ts for why it exists and what it deliberately
    // does NOT carry. Two gates apply:
    //
    //  1. the same `read` permission a native `items:*` subscribe requires; and
    //  2. that permission must be UNCONDITIONAL. Signals carry no row data, but
    //     they do reveal the id + timing of every change — including rows a
    //     row-level condition hides. A caller who can already enumerate the
    //     collection over REST learns nothing new; a conditioned caller would.
    //     `REALTIME_SIGNAL_SCOPE=all` waives (2) for deployments where change
    //     timing isn't sensitive.
    if (isPublish) {
      throw new AppError(
        "FORBIDDEN",
        "signal:items:* channels are published by the API; client publish is disabled",
      );
    }
    if (!auth.userId) {
      throw new AppError("UNAUTHORIZED", "Sign in required for signal channels");
    }
    const perm = await resolvePermission(ctx, auth, signalSlug, "read");
    if (!perm.allowed) {
      throw new AppError("FORBIDDEN", `No read permission for ${signalSlug}`);
    }
    if (!signalScopeAllowsConditional(ctx.env)) {
      // `conditions === null` means at least one grant is condition-free, i.e.
      // every row of the collection is readable.
      let unconditional = perm.isAdmin || perm.conditions === null;
      // A versioned collection adds an implicit `_status = 'published'` clause
      // for readers who can't see drafts — that's a row condition too, so it
      // disqualifies them just the same.
      if (unconditional && !perm.isAdmin && auth.tenantId) {
        let versioned = false;
        try {
          versioned = Boolean((await loadCollection(ctx, auth.tenantId, signalSlug)).versioned);
        } catch {
          versioned = false;
        }
        if (versioned) {
          unconditional =
            (await resolvePermission(ctx, auth, signalSlug, "publish")).allowed ||
            (await resolvePermission(ctx, auth, signalSlug, "update")).allowed;
        }
      }
      if (!unconditional) {
        throw new AppError(
          "FORBIDDEN",
          `Row-level read conditions on ${signalSlug} — change signals would reveal ids this role can't read. ` +
            "Set REALTIME_SIGNAL_SCOPE=all to allow it.",
        );
      }
    }
    return { signal: true };
  }
  if (channel === "collections") {
    if (!auth.roles.includes(SYSTEM_ROLES.admin)) {
      throw new AppError(
        auth.userId ? "FORBIDDEN" : "UNAUTHORIZED",
        "Admin only",
      );
    }
    if (isPublish) {
      throw new AppError(
        "FORBIDDEN",
        "collections channel is published by the API",
      );
    }
    return {
      meta: { authSubject: auth, conditions: null, fields: null },
    };
  }
  if (channel.startsWith(PRESENCE_PREFIX)) {
    if (isPublish) {
      throw new AppError(
        "FORBIDDEN",
        "presence:* channels broadcast the roster automatically; client publish is disabled",
      );
    }
    if (!auth.userId) {
      throw new AppError("UNAUTHORIZED", "Sign in required for presence channels");
    }
    return {
      meta: { authSubject: auth, conditions: null, fields: null },
      presence: true,
    };
  }
  if (channel.startsWith(COLLAB_PREFIX)) {
    // Collaboration channels: record-level presence + field awareness.
    // Both subscribe AND publish are open to any signed-in user who can READ
    // the collection — messages carry only non-sensitive metadata (user id,
    // email, field name), and identity is stamped server-side at publish.
    const parsed = parseCollabChannel(channel);
    if (!parsed) {
      throw new AppError("VALIDATION", "Malformed collab channel — expected collab:list:<slug> or collab:item:<slug>:<id>");
    }
    if (!auth.userId) {
      throw new AppError("UNAUTHORIZED", "Sign in required for collab channels");
    }
    const perm = await resolvePermission(ctx, auth, parsed.slug, "read");
    if (!perm.allowed) {
      throw new AppError("FORBIDDEN", `No read permission for ${parsed.slug}`);
    }
    return { collab: true };
  }
  const agentThreadId = parseAgentThreadChannel(channel);
  if (agentThreadId) {
    // An agent transcript is workspace data — the turn events carry the
    // questions, the tool observations, and the answer. Gate it like the
    // /api/agents routes it mirrors: admin, and the thread must belong to the
    // caller's active workspace. (This channel used to fall through to the
    // free-form branch, i.e. readable by anyone who guessed a thread id.)
    if (!auth.userId) {
      throw new AppError("UNAUTHORIZED", "Sign in required for agent thread channels");
    }
    if (!auth.roles.includes(SYSTEM_ROLES.admin)) {
      throw new AppError("FORBIDDEN", "Admin role required for agent thread channels");
    }
    if (!auth.tenantId) {
      throw new AppError("UNAUTHORIZED", "Active tenant required");
    }
    const thread = await getThread(ctx, agentThreadId, auth.tenantId);
    if (!thread) throw new AppError("NOT_FOUND", "Thread not found");
    return {
      meta: { authSubject: auth, conditions: null, fields: null },
      agentThread: true,
    };
  }
  // Application-owned (broadcast) channel. Everything above carries its own
  // gate; this branch used to return an empty one — no sign-in to subscribe,
  // no sign-in to publish, no workspace scoping. It is now authorized by a
  // `broadcast_channels` rule, and DEFAULT DENY: an unmatched channel is
  // refused rather than open to the world.
  if (openChannelsEnabled(ctx.env)) {
    // Legacy behaviour, explicitly opted into. Documented in docs/realtime.md
    // as what it is: anonymous read AND write on every unmanaged channel.
    return {};
  }
  if (!splitChannel(channel)) {
    throw new AppError(
      "VALIDATION",
      "Channel names are colon-separated segments of letters, digits, `_`, `.`, `@` or `-`",
    );
  }
  const resolved = await resolveChannelRule(ctx, auth.tenantId, channel);
  if (!resolved) {
    throw new AppError(
      auth.userId ? "FORBIDDEN" : "UNAUTHORIZED",
      `No channel rule matches "${channel}". Create one at POST /api/admin/realtime-channels ` +
        "(Automation → Realtime → Channels) — free-form channels are no longer open by default.",
    );
  }
  const { rule, params } = resolved;
  const access = isPublish ? rule.publish : rule.subscribe;
  if (!satisfiesAccess(access, auth, params)) {
    throw new AppError(
      auth.userId ? "FORBIDDEN" : "UNAUTHORIZED",
      auth.userId
        ? `The rule "${rule.name}" does not let you ${isPublish ? "publish on" : "subscribe to"} "${channel}"`
        : "Sign in required for this channel",
    );
  }
  return { broadcast: resolved };
};

/**
 * ── Identity refresh on a held subscription ────────────────────────────────
 *
 * `gateForChannel` runs ONCE, at subscribe time, and its answer is frozen into
 * the subscription's `meta`. `services/realtime-filter.ts` then evaluates every
 * event against that frozen `authSubject` — and `packages/db/src/permission.ts`
 * resolves `$org.id`, `$org.role` and `$user.orgs` straight out of it.
 *
 * So, before this: removing an end-user from an organization, demoting them,
 * revoking the role that granted the read, or deleting the org itself did not
 * stop an already-open SSE stream from delivering that org's rows. The REST
 * path's staleness is bounded at 30s by the permission cache's TTL; this one
 * was bounded only by how long the browser tab stayed open, which for a
 * dashboard is hours. It was the one surface where a revoked B2B customer kept
 * receiving live data with no ceiling at all.
 *
 * The refresh deliberately rides the EXISTING heartbeat rather than adding a
 * timer of its own. The heartbeat already runs on every held stream, on both
 * transports; coupling to it means the refresh cadence and the liveness cadence
 * cannot drift apart, and it costs no extra wakeups on an idle connection.
 */

/** What a refresh concluded about a subscription that is currently open. */
type GateRefresh =
  /** Nothing that affects delivery moved — keep streaming. */
  | { kind: "unchanged" }
  /** The subscriber is still allowed on this channel, but with a different
   *  identity or a different row scope. The new `meta` replaces the stored one. */
  | { kind: "changed"; meta: SubscriptionMeta | undefined }
  /** They can no longer subscribe at all. Close the stream. */
  | { kind: "revoked"; reason: string };

/**
 * The parts of an `AuthSubject` that actually change what a subscriber
 * receives: every variable the permission DSL can resolve out of it. Anything
 * else on `auth` (request ids, API-key metering fields) is deliberately not
 * compared — a difference there must not cost a stream a reconnect.
 */
const identityKey = (s: AuthSubject): string =>
  JSON.stringify([
    s.plane ?? "platform",
    s.userId,
    s.email,
    [...s.roles].sort(),
    s.tenantId ?? null,
    s.access ?? "member",
    s.orgId ?? null,
    s.orgRole ?? null,
    [...(s.orgIds ?? [])].sort(),
  ]);

/** Whether two gates deliver identically. `queryFilter` is re-parsed from the
 *  same immutable `?filter=` on every refresh, so it can never differ and is
 *  not compared; `conditions` and `fields` both can, and both do change what
 *  goes on the wire. */
const sameMeta = (
  a: SubscriptionMeta | undefined,
  b: SubscriptionMeta | undefined,
): boolean => {
  if (a === undefined || b === undefined) return a === b;
  return (
    identityKey(a.authSubject) === identityKey(b.authSubject) &&
    JSON.stringify(a.conditions) === JSON.stringify(b.conditions) &&
    JSON.stringify(a.fields) === JSON.stringify(b.fields)
  );
};

/**
 * Re-answer, from the database, both halves of "may this subscriber still
 * receive this channel, and as whom?" — the workspace/organization context
 * `tenantMiddleware` resolves at the top of a request, and then the channel
 * gate itself.
 *
 * Every lookup underneath rides the same per-isolate caches the REST path uses
 * (`services/permissions-cache.ts`, 30s TTL with explicit invalidation from the
 * mutating routes), so a refresh on an unchanged subscription is a handful of
 * map hits, and the isolate that served the revoke sees it on the very next
 * beat.
 *
 * NOTE — what this does NOT re-check: whether an app-plane subscriber's
 * `app_sessions` row is still live (owner suspended, session revoked). That
 * authority is `middleware/session.ts::appSessionLive`, which is module-private
 * there; duplicating its query here is exactly the drift this file's own
 * comments warn about, so it is left to the follow-up that exports it.
 */
const refreshGate = async (
  c: HonoContext<AppBindings>,
  channel: string,
  filterRaw: string | undefined,
  current: SubscriptionMeta | undefined,
): Promise<GateRefresh> => {
  const ctx = c.get("ctx");
  const auth = c.get("auth");
  try {
    let subject = auth;
    if (auth.userId && auth.tenantId) {
      if (auth.plane === "app") {
        // Is the subscriber's SESSION still live? Asked before the org context,
        // because a suspended or deleted end-user has no org context worth
        // computing — and because this is the case a stream fails at worst:
        // the REST path's staleness is bounded at 30s by the cache TTL, while
        // an unrefreshed stream keeps delivering for as long as the tab is
        // open, which for a dashboard is hours.
        //
        // `appSessionLive` is imported rather than reimplemented. The read path
        // and the stream disagreeing about whether a credential is still valid
        // is exactly the two-paths drift `services/realtime-filter.ts` was
        // written to prevent for conditions.
        //
        // An impersonation subscriber is exempt for the same reason it is on
        // the request path: its `sid` is the synthetic `imp:<row-id>` and names
        // no `app_sessions` row. Its own liveness authority is the
        // impersonation row, which `sessionMiddleware` re-reads per request —
        // and a held stream re-enters this function through that middleware, so
        // an ended impersonation already closes it.
        const sid = auth.appSessionId ?? null;
        if (sid && !sid.startsWith("imp:")) {
          const live = await appSessionLive(
            { db: ctx.db, dialect: ctx.dialect },
            sid,
          );
          if (!live) {
            return {
              kind: "revoked",
              reason: "this sign-in has been revoked or the account suspended",
            };
          }
        }
        // The app plane's org context. `resolveOrgContext` throws FORBIDDEN
        // when an `X-Backlex-Org` the caller sent is no longer one of their
        // memberships — which is precisely the "removed from the org" case, and
        // the reason this is inside the try rather than beside it.
        const org = await resolveOrgContext(
          { db: ctx.db, dialect: ctx.dialect },
          auth.tenantId,
          auth.userId,
          {
            requestedOrg: c.req.header(ORG_HEADER) ?? null,
            appSessionId: auth.appSessionId ?? null,
          },
        );
        subject = {
          ...auth,
          orgId: org.orgId,
          orgRole: org.orgRole,
          orgIds: org.orgIds,
        };
      } else {
        // The control plane's workspace access — the same call `tenantMiddleware`
        // makes, so a membership removed or a role revoked mid-stream is seen
        // here the same way it would be on the next REST request.
        const access = await resolveTenantAccess(
          ctx.db,
          ctx.dialect,
          auth.tenantId,
          auth.userId,
          {
            apiKeyRoleId: auth.apiKeyRoleId ?? null,
            apiKeyId: auth.apiKeyId ?? null,
            env: ctx.env,
            email: auth.email,
            plane: auth.plane,
          },
        );
        // `roles: null` is "refused", which is a different answer from "no
        // roles" — see `resolveTenantAccess`. Only the first one closes a stream.
        const roles = access.roles;
        if (!roles) {
          return {
            kind: "revoked",
            reason: "no longer a member of this workspace",
          };
        }
        subject = { ...auth, roles, access: access.access };
      }
    }
    const next = await gateForChannel(ctx, subject, channel, false, filterRaw);
    return sameMeta(current, next.meta)
      ? { kind: "unchanged" }
      : { kind: "changed", meta: next.meta };
  } catch (err) {
    // A gate that says "no" is a revocation and must close the stream. Anything
    // else — a DB blip, a driver timeout — is infrastructure, and closing every
    // open stream on the instance because one query hiccuped would turn a blip
    // into a reconnect stampede. Keep the current gate and try again on the next
    // beat; the ceiling on staleness is then two heartbeats instead of one.
    if (
      isAppError(err) &&
      (err.code === "FORBIDDEN" ||
        err.code === "UNAUTHORIZED" ||
        err.code === "NOT_FOUND")
    ) {
      return { kind: "revoked", reason: err.message };
    }
    console.warn(
      `[realtime] identity refresh failed on "${channel}" — keeping the current gate:`,
      err,
    );
    return { kind: "unchanged" };
  }
};

/**
 * Gate every requested channel, then sign one Ably TokenRequest scoped to
 * exactly those channels. Shared by `/collab-token` (collab plane only) and
 * `/ably-token` (collab + the signal data plane), so the two can't drift on
 * what a token is allowed to reach.
 *
 * Ops are per plane: collab members publish AND subscribe (that's the whole
 * protocol), while signal subscribers are `subscribe`-only — signals are
 * server-emitted, and a client able to publish them could fabricate change
 * notifications that make other readers refetch (or miss) rows.
 */
const gateAndMintAblyToken = async (
  ctx: Ctx,
  auth: { userId: string | null; email: string | null; roles: string[]; tenantId?: string | null },
  channels: string[],
  allowSignal: boolean,
): Promise<AblyTokenRequest> => {
  if (!ctx.env.ABLY_API_KEY) {
    throw new AppError("UNAVAILABLE", "Ably is not configured on this deployment");
  }
  const capabilities: Record<string, string[]> = {};
  for (const channel of channels) {
    const isSignal = channel.startsWith(SIGNAL_ROOT);
    const isCollab = channel.startsWith(COLLAB_PREFIX);
    if (isSignal && !allowSignal) {
      throw new AppError("VALIDATION", "collab-token only covers collab:* channels");
    }
    if (!isSignal && !isCollab && !allowSignal) {
      throw new AppError("VALIDATION", "collab-token only covers collab:* channels");
    }
    if (!isSignal && !isCollab && isManagedChannel(channel)) {
      throw new AppError(
        "VALIDATION",
        "ably-token covers collab:*, signal:items:* and application-owned channels — " +
          "`items:*`, `presence:*`, `agent:thread:*` and `collections` stream over SSE, where " +
          "per-subscriber row filtering happens",
      );
    }
    const gate = await gateForChannel(ctx, auth, channel, false);
    if (isSignal) {
      // Server-emitted: a client able to publish these could fabricate change
      // notifications that make other readers refetch (or miss) rows.
      capabilities[channel] = ["subscribe"];
    } else if (isCollab) {
      capabilities[channel] = ["publish", "subscribe"];
    } else {
      // Application-owned: the token's capability mirrors the rule, so Ably
      // enforces the same split the REST publish endpoint does. Asking the
      // gate a second time with `isPublish` is what decides it — a caller who
      // may only listen must not get a publishing token.
      const canPublish =
        gate.broadcast !== undefined &&
        satisfiesAccess(gate.broadcast.rule.publish, auth, gate.broadcast.params);
      capabilities[channel] = canPublish ? ["publish", "subscribe"] : ["subscribe"];
    }
  }
  return mintAblyTokenRequest(ctx.env.ABLY_API_KEY, auth.userId!, capabilities);
};

/** Parse a `Last-Event-ID` header into a positive sequence number, or 0. */
const parseSince = (raw: string | undefined): number => {
  if (!raw || !/^\d+$/.test(raw)) return 0;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
};

type QueueItem =
  | { kind: "msg"; id?: number; data: string }
  | { kind: "ping" };

/** Enqueue `item` onto a bounded SSE outbound `queue`. Returns `false` when the
 *  queue is already at `SSE_QUEUE_MAX` — the caller must then tear the
 *  subscriber down (slow/dead consumer). The item is NOT enqueued in that case,
 *  so the queue never exceeds the cap. */
const boundedEnqueue = (
  queue: QueueItem[],
  channel: string,
  item: QueueItem,
): boolean => {
  if (queue.length >= SSE_QUEUE_MAX) {
    console.warn(
      `[realtime] SSE queue overflow on "${channel}" (>= ${SSE_QUEUE_MAX}); ` +
        "disconnecting slow consumer — it can reconnect and replay via Last-Event-ID",
    );
    return false;
  }
  queue.push(item);
  return true;
};

/** Drain `queue` to the SSE stream until `isDone()` flips, parking on `setWake`
 *  between flushes. Shared by the Bun (in-process) and Workers (DO-bridge)
 *  subscribe paths.
 *
 *  `farewell` is consulted once, after the loop exits, and returns a reason
 *  string when the SERVER is the one ending the stream — today, when the
 *  heartbeat's identity refresh finds the subscriber may no longer read the
 *  channel. It is written here rather than pushed onto `queue` because the loop
 *  re-checks `isDone()` before draining, so anything enqueued in the same tick
 *  that flips it would be dropped. A client-side abort returns null and nothing
 *  is written: there is nobody left to tell. */
const pumpSSE = async (
  stream: SSEStreamingApi,
  channel: string,
  queue: QueueItem[],
  isDone: () => boolean,
  setWake: (resolve: (() => void) | null) => void,
  farewell?: () => string | null,
): Promise<void> => {
  await stream.writeSSE({ event: "ready", data: channel, retry: RECONNECT_HINT_MS });
  while (!isDone()) {
    while (queue.length > 0) {
      const item = queue.shift()!;
      if (item.kind === "ping") {
        // SSE comment frame — keeps proxies from reaping an idle connection,
        // never surfaces to the EventSource client.
        await stream.write(": ping\n\n");
      } else {
        await stream.writeSSE({
          event: "message",
          data: item.data,
          id: item.id ? String(item.id) : undefined,
        });
      }
    }
    if (isDone()) break;
    await new Promise<void>((resolve) => setWake(resolve));
  }
  const reason = farewell?.();
  if (reason) {
    try {
      await stream.writeSSE({ event: "revoked", data: reason });
    } catch {
      // The socket went away first — the client is already gone, which is the
      // outcome the frame was trying to bring about.
    }
  }
};

const publishToChannel = async (
  env: Env,
  channel: string,
  payload: unknown,
): Promise<void> => {
  if (env.REALTIME) {
    const stub = env.REALTIME.get(env.REALTIME.idFromName(channel));
    await stub.fetch("https://do/publish", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  } else if (redisRealtimeEnabled(env)) {
    // Stateless serverless (Vercel / Netlify) with Upstash configured: fan out
    // through a Redis Stream so subscribers on other invocations see it.
    await redisPublish(env, channel, payload);
  } else if (isStatelessEdge()) {
    // Vercel Edge / Netlify Edge: every invocation is a fresh isolate, so
    // module-level subscribers from `publishLocal` would never see the
    // publish. Deploy to Cloudflare Workers (with REALTIME DO binding) or
    // Bun self-host for realtime.
    throw new AppError(
      "UNAVAILABLE",
      "Realtime is not available on Vercel Edge / Netlify Edge — deploy to Cloudflare Workers (with REALTIME Durable Object binding) or Bun.",
    );
  } else {
    publishLocal(channel, payload);
  }
};

const TestPublishInput = z
  .object({
    event: z.enum(["created", "updated", "deleted"]),
    data: z.record(z.string(), z.unknown()),
  })
  .openapi("RealtimeTestPublishInput");

const TAG = "realtime";

export const realtimeRoutes = new OpenAPIHono<AppBindings>({ defaultHook })
  .openapi(
    createRoute({
      method: "post",
      path: "/{channel}/publish",
      tags: [TAG],
      summary: "Publish to a free-form channel",
      description:
        "Application-owned channels only — `items:*`, `signal:*`, `collections` and `presence:*` are managed by " +
        "the API and reject client publish. An application-owned channel needs a matching `broadcast_channels` " +
        "rule whose `publish` access this caller satisfies; the body is `{ event?, data }`, or " +
        "`{ kind: \"presence\", t, state? }` on a rule with presence enabled. The sender identity is stamped " +
        "server-side. Rate limited per `(channel, ip)`.",
      security: SECURITY,
      request: {
        params: z.object({ channel: z.string() }),
        body: {
          required: true,
          content: {
            "application/json": {
              schema: z.unknown().openapi({
                description: "Free-form payload — forwarded to every subscriber as-is.",
              }),
            },
          },
        },
      },
      responses: {
        200: {
          description: "Published",
          content: { "application/json": { schema: OkSchema } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const { channel } = c.req.valid("param");
      const gate = await gateForChannel(ctx, auth, channel, true);

      if (!(await rateLimitOk(ctx.env, `pub:${channel}:${clientIp(c)}`, PUBLISH_RATE_MAX, PUBLISH_RATE_WINDOW_MS))) {
        throw new AppError("RATE_LIMITED", "Too many publishes — slow down");
      }
      let payload = await readJson(c.req);
      if (gate.collab) {
        // Collab channels never forward the raw body: validate the shape and
        // stamp identity + timestamp from the session so a member can't
        // impersonate another (the gate guarantees userId is set).
        const parsed = CollabPublishSchema.safeParse(payload);
        if (!parsed.success) {
          throw new AppError("VALIDATION", "Invalid collab message — expected { t, item?, field? }");
        }
        payload = buildCollabMessage(parsed.data, {
          userId: auth.userId!,
          email: auth.email,
        });
      }
      if (gate.agentThread) {
        // Turn events are server-emitted; the only thing a client may put on an
        // agent thread channel is its own presence (identity stamped here, so
        // nobody can forge an `agent.final` or appear as a teammate).
        const parsed = AgentPresenceSchema.safeParse(payload);
        if (!parsed.success) {
          throw new AppError(
            "VALIDATION",
            "Invalid agent presence message — expected { t: hello | ping | typing | bye }",
          );
        }
        payload = buildAgentPresenceMessage(parsed.data, {
          userId: auth.userId!,
          email: auth.email,
        });
      }
      if (gate.broadcast) {
        // Same posture as collab: the raw body is never forwarded. The frame is
        // built here so the sender identity comes from the session, and so a
        // presence frame is refused on a channel whose rule has presence off
        // rather than being delivered as an ordinary message.
        const frame = buildBroadcastFrame(
          payload,
          gate.broadcast.rule,
          { userId: auth.userId, email: auth.email },
          Date.now(),
        );
        payload = frame;
        if (gate.broadcast.rule.replay && auth.tenantId) {
          // Retained BEFORE the fan-out: a subscriber that reconnects and
          // replays must not find a hole where a message it saw live should be.
          await recordBroadcast(ctx, auth.tenantId, channel, frame);
        }
      }
      await publishToChannel(ctx.env, channel, payload);
      return c.json({ ok: true });
    },
  )
  // Retained history for an application-owned channel whose rule enables
  // replay. Paged by an opaque `(created_at, id)` keyset cursor — a bare
  // timestamp cursor skips a message that shared a millisecond, or repeats one
  // forever. The window is clamped to the rule's retention on the way in, so
  // turning retention down takes effect immediately rather than whenever the
  // prune next runs.
  .openapi(
    createRoute({
      method: "get",
      path: "/{channel}/replay",
      tags: [TAG],
      summary: "Read a broadcast channel's retained messages",
      description:
        "Requires the same subscribe permission as a live subscription. Oldest first, " +
        `at most ${REPLAY_PAGE_SIZE} per request; pass the returned \`cursor\` back as \`since\`.`,
      security: SECURITY,
      request: {
        params: z.object({ channel: z.string() }),
        query: z.object({
          since: z.string().optional().openapi({
            description: "Cursor from a previous response. Omit to start at the window's edge.",
          }),
          limit: z.coerce.number().int().min(1).max(REPLAY_PAGE_SIZE).optional(),
        }),
      },
      responses: {
        200: {
          description: "Retained messages, oldest first",
          content: {
            "application/json": {
              schema: z
                .object({
                  data: z.array(
                    z.object({
                      id: z.string(),
                      event: z.string(),
                      data: z.unknown(),
                      from: z
                        .object({ id: z.string(), name: z.string().nullable() })
                        .nullable(),
                      at: z.number(),
                      cursor: z.string(),
                    }),
                  ),
                  cursor: z.string().nullable(),
                })
                .openapi("BroadcastReplayResponse"),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const { channel } = c.req.valid("param");
      const { since, limit } = c.req.valid("query");
      const gate = await gateForChannel(ctx, auth, channel, false);
      if (!gate.broadcast) {
        throw new AppError(
          "VALIDATION",
          "Replay is only available on application-owned channels — managed channels resume over `Last-Event-ID`",
        );
      }
      if (!auth.tenantId) throw new AppError("UNAUTHORIZED", "Active workspace required");
      return c.json(
        await readReplay(
          ctx,
          auth.tenantId,
          channel,
          gate.broadcast.rule,
          since,
          limit ?? REPLAY_PAGE_SIZE,
        ),
      );
    },
  )
  // "What would happen if I touched this channel" — the affordance
  // `permissions.simulate` gives for collections. An operator debugging a
  // pattern should not have to open a stream to learn that `chat:*` does not
  // match `chat:room:1`.
  .openapi(
    createRoute({
      method: "get",
      path: "/{channel}/explain",
      tags: [TAG],
      summary: "Explain which rule governs a channel",
      security: SECURITY,
      request: { params: z.object({ channel: z.string() }) },
      responses: {
        200: {
          description: "The matching rule and this caller's verdict",
          content: {
            "application/json": {
              schema: z
                .object({
                  channel: z.string(),
                  managed: z.boolean(),
                  matched: z
                    .object({ id: z.string(), name: z.string(), pattern: z.string() })
                    .nullable(),
                  params: z.record(z.string(), z.string()),
                  canSubscribe: z.boolean(),
                  canPublish: z.boolean(),
                  reason: z.string(),
                })
                .openapi("ChannelExplain"),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      // Signed in, always. The answer NAMES the matching rule, so an anonymous
      // caller could enumerate a workspace's channel topology — including
      // rules it has no access to — by probing names. Found in this branch's
      // own security review: the endpoint resolved the workspace from the
      // default tenant and answered without a session.
      if (!auth.userId) {
        throw new AppError("UNAUTHORIZED", "Sign in required to explain a channel");
      }
      if (!auth.tenantId) throw new AppError("UNAUTHORIZED", "Active workspace required");
      return c.json(
        await explainChannel(
          c.get("ctx"),
          auth.tenantId,
          auth,
          c.req.param("channel")!,
          auth.roles.includes(SYSTEM_ROLES.admin),
        ),
      );
    },
  )
  // How the admin SPA should reach collab channels on this deployment —
  // `native` (SSE subscribe + REST publish work) or `off` (no viable
  // transport; the UI hides collab affordances). Phase 2 adds `ably`.
  .openapi(
    createRoute({
      method: "get",
      path: "/collab-config",
      tags: [TAG],
      summary: "Collaboration transport capability",
      security: SECURITY,
      responses: {
        200: {
          description: "Transport the client should use for collab channels",
          content: {
            "application/json": {
              schema: z
                .object({ transport: z.enum(["native", "ably", "off"]) })
                .openapi("CollabConfig"),
            },
          },
        },
        ...errorResponses,
      },
    }),
    (c) => c.json(collabConfig(c.get("ctx").env)),
  )
  // How a client should receive DATA-plane row events on this deployment:
  // `sse` (the held `items:*` stream, full server-side filtering), `ably-signal`
  // (id-only signals over Ably + a permission-filtered refetch — the free-tier
  // path on Vercel/Netlify), or `off`.
  .openapi(
    createRoute({
      method: "get",
      path: "/items-config",
      tags: [TAG],
      summary: "Data-plane transport capability",
      security: SECURITY,
      responses: {
        200: {
          description: "Transport the client should use for `items:*` events",
          content: {
            "application/json": {
              schema: z
                .object({ transport: z.enum(["sse", "ably-signal", "off"]) })
                .openapi("ItemsConfig"),
            },
          },
        },
        ...errorResponses,
      },
    }),
    (c) => c.json(itemsConfig(c.get("ctx").env)),
  )
  // Ably token auth for collab channels: the browser's ably-js authCallback
  // POSTs the channels it wants; each one passes the same permission gate as a
  // native subscribe, and the response is a TokenRequest whose capability is
  // scoped to exactly those channels with `clientId` pinned to the session
  // user (Ably then enforces the identity on every publish). The API key
  // secret never leaves the server.
  .openapi(
    createRoute({
      method: "post",
      path: "/collab-token",
      tags: [TAG],
      summary: "Mint an Ably TokenRequest scoped to collab channels",
      security: SECURITY,
      request: {
        body: {
          required: true,
          content: {
            "application/json": {
              schema: z
                .object({ channels: z.array(z.string()).min(1).max(10) })
                .openapi("CollabTokenInput"),
            },
          },
        },
      },
      responses: {
        200: {
          description: "Signed Ably TokenRequest for the requested channels",
          content: {
            "application/json": {
              schema: z
                .object({ tokenRequest: z.record(z.string(), z.unknown()) })
                .openapi("CollabTokenResponse"),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const tokenRequest = await gateAndMintAblyToken(
        c.get("ctx"),
        c.get("auth"),
        c.req.valid("json").channels,
        false,
      );
      return c.json({ tokenRequest });
    },
  )
  // Same flow, widened to the signal data plane: `collab:*` (publish+subscribe)
  // AND `signal:items:*` (subscribe only). The SDK and the admin both use this
  // one endpoint so a single connection can carry awareness and row signals.
  .openapi(
    createRoute({
      method: "post",
      path: "/ably-token",
      tags: [TAG],
      summary: "Mint an Ably TokenRequest scoped to collab + signal channels",
      security: SECURITY,
      request: {
        body: {
          required: true,
          content: {
            "application/json": {
              schema: z
                .object({ channels: z.array(z.string()).min(1).max(20) })
                .openapi("AblyTokenInput"),
            },
          },
        },
      },
      responses: {
        200: {
          description: "Signed Ably TokenRequest for the requested channels",
          content: {
            "application/json": {
              schema: z
                .object({ tokenRequest: z.record(z.string(), z.unknown()) })
                .openapi("AblyTokenResponse"),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const tokenRequest = await gateAndMintAblyToken(
        c.get("ctx"),
        c.get("auth"),
        c.req.valid("json").channels,
        true,
      );
      return c.json({ tokenRequest });
    },
  )
  // Admin-only synthetic event injector — lets you fire a fake ItemEvent at an
  // `items:*` channel to verify per-subscriber permission filtering / field
  // projection without performing real CRUD. No webhook/flow side effects.
  .openapi(
    createRoute({
      method: "post",
      path: "/{channel}/test-publish",
      tags: [TAG],
      summary: "Admin-only synthetic event injector",
      description:
        "Fires a synthetic `ItemEventPayload` at an `items:*` channel to verify per-subscriber permission filtering. No webhook/flow side effects.",
      security: SECURITY,
      request: {
        params: z.object({
          channel: z.string().openapi({ description: "Must start with `items:`." }),
        }),
        body: {
          required: true,
          content: { "application/json": { schema: TestPublishInput } },
        },
      },
      responses: {
        200: {
          description: "Injected",
          content: { "application/json": { schema: OkSchema } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const ctx = c.get("ctx");
      const { channel } = c.req.valid("param");
      if (!auth.roles.includes(SYSTEM_ROLES.admin)) {
        throw new AppError(
          auth.userId ? "FORBIDDEN" : "UNAUTHORIZED",
          "Admin only",
        );
      }
      if (!channel.startsWith(ITEMS_PREFIX)) {
        throw new AppError("VALIDATION", "test-publish is only for items:* channels");
      }
      const body = c.req.valid("json") as { event: ItemEventPayload["event"]; data: Record<string, unknown> };
      if (typeof body.event !== "string" || !ITEM_EVENTS.has(body.event)) {
        throw new AppError("VALIDATION", "event must be one of created|updated|deleted");
      }
      if (body.data == null || typeof body.data !== "object" || Array.isArray(body.data)) {
        throw new AppError("VALIDATION", "data must be an object");
      }
      await publishToChannel(ctx.env, channel, {
        event: body.event,
        data: body.data,
      } satisfies ItemEventPayload);
      return c.json({ ok: true });
    },
  )
  // SSE subscribe — kept as a plain Hono `.get(...)` because the response is a
  // long-lived `text/event-stream`, not a JSON body suitable for OpenAPI
  // validation. The OpenAPI doc for this endpoint is registered separately by
  // `lib/openapi.ts` consumers if needed.
  .get("/:channel/subscribe", (c) =>
    openRealtimeSubscribe(c, c.req.param("channel"), c.req.query("filter")),
  );

/**
 * Open a permission-gated SSE subscription on `channel` for the calling
 * request, picking the right transport for the runtime (Workers DO bridge /
 * Redis-Stream long-poll / in-process bus). Exported so other streaming
 * surfaces (the GraphQL `/api/graphql/stream` subscription endpoint) reuse
 * the exact same gate + transports instead of reimplementing them.
 */
export const openRealtimeSubscribe = async (
  c: HonoContext<AppBindings>,
  channel: string,
  filterRaw: string | undefined,
): Promise<Response> => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    // Disable proxy buffering for the SSE stream. Without this, Vercel/Netlify
    // (and nginx-style proxies) buffer `text/event-stream` responses and only
    // flush when the function ends — frames never reach the client live. This
    // header tells the proxy to pass bytes through as they're written.
    c.header("X-Accel-Buffering", "no");
    // `?filter=<json>` opts a subscription into server-side narrowing: only
    // events whose row matches the filter (AND the caller's permission) are
    // delivered (reactive invalidation Stage 1).
    const gate = await gateForChannel(ctx, auth, channel, false, filterRaw);
    const since = parseSince(c.req.header("Last-Event-ID"));

    // Signal-plane deployment: there is no cross-instance `items:*` fan-out to
    // stream. Without this the request would fall through to the in-process bus
    // and hold a function invocation open on a stream that can never deliver —
    // the exact cost the signal plane exists to avoid. Fail loudly instead.
    if (channel.startsWith(ITEMS_PREFIX) && itemsTransportKind(ctx.env) === "ably-signal") {
      throw new AppError(
        "UNAVAILABLE",
        `This deployment streams row events as ID-only signals over Ably. Subscribe to "${signalChannel(channel.slice(ITEMS_PREFIX.length))}" with a token from POST /api/realtime/ably-token (the backlex SDK does this automatically), then read the changed rows back over REST.`,
      );
    }

    // Workers: bridge a hibernatable WebSocket from the RealtimeRoom DO into an
    // SSE response so the EventSource client works the same on both runtimes.
    if (ctx.env.REALTIME) {
      const url = new URL("https://do/subscribe");
      if (gate.meta) url.searchParams.set("meta", btoa(JSON.stringify(gate.meta)));
      if (since > 0) url.searchParams.set("since", String(since));
      if (gate.presence) url.searchParams.set("presence", "1");
      const id = ctx.env.REALTIME.idFromName(channel);
      const stub = ctx.env.REALTIME.get(id);
      const upstream = await stub.fetch(url.toString(), {
        headers: { upgrade: "websocket" },
      });
      const ws = upstream.webSocket;
      if (!ws) throw new AppError("INTERNAL", "realtime room did not upgrade");

      return streamSSE(c, async (stream) => {
        const queue: QueueItem[] = [];
        let wake: (() => void) | null = null;
        const wakeUp = () => {
          if (wake) {
            wake();
            wake = null;
          }
        };
        let done = false;
        // Bounded enqueue: a slow SSE client can't outrun the DO WebSocket
        // feed forever — overflow flags the stream done so `pumpSSE` exits,
        // `finally` closes the upstream socket, and the client reconnects.
        const enqueue = (item: QueueItem) => {
          if (done) return;
          if (!boundedEnqueue(queue, channel, item)) {
            done = true;
          }
          wakeUp();
        };
        ws.addEventListener("message", (ev: MessageEvent) => {
          const raw = typeof ev.data === "string" ? ev.data : "";
          let id: number | undefined;
          let data = raw;
          try {
            const parsed = JSON.parse(raw) as unknown;
            if (
              parsed &&
              typeof parsed === "object" &&
              "__seq" in parsed &&
              "msg" in parsed
            ) {
              const s = (parsed as { __seq: unknown }).__seq;
              if (typeof s === "number") id = s;
              data = String((parsed as { msg: unknown }).msg);
            }
          } catch {
            // not a wrapped frame; forward as-is
          }
          enqueue({ kind: "msg", id, data });
        });
        ws.addEventListener("close", () => {
          done = true;
          wakeUp();
        });
        ws.addEventListener("error", () => {
          done = true;
          wakeUp();
        });
        c.req.raw.signal.addEventListener("abort", () => {
          done = true;
          try {
            ws.close();
          } catch {
            // already closed
          }
          wakeUp();
        });
        // Heartbeat + identity refresh (see `refreshGate`). On this transport
        // the gate lives INSIDE the Durable Object — `meta` was base64'd into
        // the `/subscribe` URL once and there is no channel back to amend it —
        // so a subscription whose scope has narrowed is closed rather than
        // patched. The browser's EventSource reconnects, the new request runs
        // `gateForChannel` from scratch, and it comes back with the scope the
        // subscriber actually has now. Closing is also the only honest answer
        // to a full revocation, which is what the local path does too.
        let refreshing = false;
        let revokedReason: string | null = null;
        const hb = setInterval(() => {
          enqueue({ kind: "ping" });
          if (refreshing || done) return;
          refreshing = true;
          void refreshGate(c, channel, filterRaw, gate.meta)
            .then((verdict) => {
              if (done || verdict.kind === "unchanged") return;
              revokedReason =
                verdict.kind === "revoked"
                  ? verdict.reason
                  : "your access to this channel changed — reconnect to resume";
              done = true;
              wakeUp();
            })
            .finally(() => {
              refreshing = false;
            });
        }, heartbeatMs);
        // Accept only after listeners are wired so DO-side replay frames
        // (queued during the `/subscribe` fetch) aren't dispatched into the void.
        ws.accept();
        try {
          await pumpSSE(
            stream,
            channel,
            queue,
            () => done,
            (r) => {
              wake = r;
            },
            () => revokedReason,
          );
        } finally {
          clearInterval(hb);
          try {
            ws.close();
          } catch {
            // already closed
          }
        }
      });
    }

    // Stateless serverless (Vercel / Netlify Functions) with Upstash Redis:
    // stream the channel's Redis Stream over SSE. Cross-instance fan-out +
    // `Last-Event-ID` replay come from the stream ids. Presence rosters need
    // shared mutable membership we don't track here, so presence channels still
    // fall through to the unsupported path below.
    //
    // This transport needs no identity refresh: it carries no heartbeat because
    // it holds nothing open — every long-poll closes at `REDIS_HOLD_MS` (or as
    // soon as it delivers a batch) and the client's reconnect runs
    // `gateForChannel` again from scratch. Staleness here is already bounded by
    // the hold window, which is shorter than the heartbeat period.
    if (redisRealtimeEnabled(ctx.env) && !gate.presence) {
      return streamSSE(c, async (stream) => {
        // Capture the resume position BEFORE announcing ready: resume from the
        // client's Last-Event-ID, else from "now" (the latest stream id) so a
        // fresh subscriber only sees future events. Capturing first means a
        // publish that lands between here and the first poll isn't skipped.
        const lastHeader = c.req.header("Last-Event-ID");
        let cursor =
          lastHeader && lastHeader.length > 0
            ? lastHeader
            : await redisLatestId(ctx.env, channel);
        await stream.writeSSE({ event: "ready", data: channel, retry: RECONNECT_HINT_MS });
        let aborted = false;
        c.req.raw.signal.addEventListener("abort", () => {
          aborted = true;
        });
        // Long-poll, not a held subscription: serverless functions must respond
        // quickly and not hold a stream open (Vercel guidance). Poll Redis for a
        // bounded window; the moment we deliver a batch, CLOSE so the proxy
        // flushes it and the browser's EventSource auto-reconnects with
        // Last-Event-ID to resume. An idle stream closes at REDIS_HOLD_MS and the
        // client reconnects. (Bun / Workers keep the held stream above.)
        const startedAt = Date.now();
        let delivered = false;
        while (!aborted && Date.now() - startedAt < REDIS_HOLD_MS) {
          let entries: Awaited<ReturnType<typeof redisReadSince>> = [];
          try {
            entries = await redisReadSince(ctx.env, channel, cursor);
          } catch {
            // transient REST hiccup — retry next tick
          }
          for (const entry of entries) {
            cursor = entry.id;
            // Same permission filter + field projection as the in-process path.
            const rendered = renderEventForMeta(gate.meta, entry.payload);
            if (rendered === null) continue;
            await stream.writeSSE({ event: "message", data: rendered, id: entry.id });
            delivered = true;
          }
          if (delivered || aborted) break;
          await new Promise((r) => setTimeout(r, REDIS_POLL_MS));
        }
      });
    }

    // Stateless edges (Vercel Edge / Netlify Edge) lose subscribers between
    // invocations — the in-process `subscribeLocal` map doesn't survive. Bail
    // with a clear 503 instead of pretending the stream is live.
    if (isStatelessEdge()) {
      throw new AppError(
        "UNAVAILABLE",
        "Realtime is not available on Vercel Edge / Netlify Edge — deploy to Cloudflare Workers (with REALTIME Durable Object binding) or Bun.",
      );
    }

    // Bun / self-host: in-process pub/sub straight onto an SSE stream.
    return streamSSE(c, async (stream) => {
      const queue: QueueItem[] = [];
      let wake: (() => void) | null = null;
      const wakeUp = () => {
        if (wake) {
          wake();
          wake = null;
        }
      };
      let aborted = false;
      // Bounded enqueue: if the outbound queue is full the consumer can't keep
      // up — flag the stream done so `pumpSSE` exits and `finally` unsubscribes.
      const enqueue = (item: QueueItem) => {
        if (aborted) return;
        if (!boundedEnqueue(queue, channel, item)) {
          aborted = true;
        }
        wakeUp();
      };
      const sub = {
        send: (msg: string, id?: number) => {
          enqueue({ kind: "msg", id, data: msg });
        },
        meta: gate.meta,
      };
      const unsub = subscribeLocal(channel, sub);
      // Snapshot the sequence at subscribe time: events with id <= this were
      // recorded before we joined the fan-out set, so replay [since, snapshot]
      // exactly fills the gap without duplicating anything delivered live.
      const snapshot = currentSeq(channel);
      c.req.raw.signal.addEventListener("abort", () => {
        aborted = true;
        wakeUp();
      });
      // Heartbeat + identity refresh (see `refreshGate`). The fan-out reads
      // `sub.meta` afresh for every event (`services/events.ts::renderFor`), so
      // on this transport a narrowed scope is applied by swapping the stored
      // gate in place — no reconnect, and the very next published event is
      // already filtered against the subscriber's current identity. Only a
      // subscriber who may no longer read the channel AT ALL is disconnected.
      let refreshing = false;
      let revokedReason: string | null = null;
      const hb = setInterval(() => {
        enqueue({ kind: "ping" });
        if (refreshing || aborted) return;
        refreshing = true;
        void refreshGate(c, channel, filterRaw, sub.meta)
          .then((verdict) => {
            if (aborted) return;
            if (verdict.kind === "changed") {
              sub.meta = verdict.meta;
              return;
            }
            if (verdict.kind === "revoked") {
              revokedReason = verdict.reason;
              aborted = true;
              wakeUp();
            }
          })
          .finally(() => {
            refreshing = false;
          });
      }, heartbeatMs);
      if (since > 0 && since < snapshot) replayLocal(channel, sub, since, snapshot);
      const leavePresence =
        gate.presence && gate.meta?.authSubject.userId
          ? joinPresence(channel, sub, {
              userId: gate.meta.authSubject.userId,
              email: gate.meta.authSubject.email ?? null,
            })
          : null;
      try {
        await pumpSSE(
          stream,
          channel,
          queue,
          () => aborted,
          (r) => {
            wake = r;
          },
          () => revokedReason,
        );
      } finally {
        clearInterval(hb);
        leavePresence?.();
        unsub();
      }
    });
};
