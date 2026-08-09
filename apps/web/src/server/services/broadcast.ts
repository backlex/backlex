/**
 * Broadcast channels — application-owned realtime pub/sub.
 *
 * ## What was missing
 *
 * Every realtime channel this product ships carries its own permission gate:
 * `items:*` resolves a `read` permission and filters every row per subscriber,
 * `signal:items:*` additionally demands that the permission be unconditional,
 * `collab:*` and `agent:thread:*` gate on the collection / the thread's
 * workspace, `collections` is admin-only. Everything ELSE — every channel name
 * an application invents for a chat room, a cursor feed, a notification bus —
 * fell through `gateForChannel` to a branch that returned an empty gate.
 *
 * An empty gate means: no sign-in to subscribe, no sign-in to publish, no
 * workspace scoping, no retention. So an application could not put anything
 * real on it, and reached for a hosted pub/sub instead. That is the gap.
 *
 * ## The load-bearing decisions
 *
 * **Default deny, and this is a behaviour change.** A free-form channel with
 * no matching rule is now refused instead of being open to the world. That
 * closes a hole rather than opening a feature, so the refusal names the
 * endpoint that creates a rule; `REALTIME_OPEN_CHANNELS=1` restores the old
 * behaviour for an install that depended on it, documented as what it is.
 *
 * **Rules match by PATTERN.** The channels an application invents are
 * per-room (`room:42`, `org:acme:feed`); enumerating them is the app's job,
 * not the operator's. A `{name}` segment captures its value, so one rule can
 * say "you may subscribe to `org:{org}:feed` when `{org}` is an org you belong
 * to" — evaluated by `matchesCondition`, the same DSL evaluator realtime
 * filtering and the permission simulator use. There is no second evaluator
 * here, deliberately: the one thing that reliably drifts is a rule language
 * written twice.
 *
 * **Presence is stateless.** Members announce themselves (hello / ping / bye)
 * and every client derives the roster with a TTL sweep — the protocol
 * `collab:*` already proved. A server-held roster would work only on the two
 * transports that can hold mutable membership (in-process, Durable Object) and
 * silently do nothing on the other two.
 *
 * **Replay is a reconnect aid, not an event store.** Retention is capped at 72
 * hours and a page is 25 messages, and the docs say so, because a workspace
 * that wants history should write rows to a collection where permissions,
 * search and backup already apply. Presence frames are never retained — a
 * replayed "hello" from yesterday is a claim about the present that is false.
 */
import { and, asc, eq, gt, lt, or, sql } from "drizzle-orm";
import {
  AppError,
  MAX_BROADCAST_PAYLOAD_BYTES,
  MAX_PRESENCE_STATE_BYTES,
  MAX_REPLAY_RETENTION_HOURS,
  REPLAY_PAGE_SIZE,
  matchPattern,
  normalizeCondition,
  patternSpecificity,
  splitChannel,
  validatePattern,
  type AuthSubject,
  type BroadcastFrame,
  type BroadcastPublishInput,
  type BroadcastRuleView,
  type ChannelAccess,
  type Condition,
} from "@backlex/core";
import { matchesCondition } from "@backlex/db";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { Ctx } from "../context";

type AnyDb = any;

const channelsTable = (dialect: "pg" | "sqlite") =>
  (dialect === "pg"
    ? pg.schema.broadcastChannels
    : sqlite.schema.broadcastChannels) as typeof pg.schema.broadcastChannels;

const messagesTable = (dialect: "pg" | "sqlite") =>
  (dialect === "pg"
    ? pg.schema.broadcastMessages
    : sqlite.schema.broadcastMessages) as typeof pg.schema.broadcastMessages;

/**
 * Channel names the managed gates already own. A rule whose pattern could
 * match one of these is refused at save time rather than stored and ignored:
 * a rule that can never fire is worse than an omission, because an operator
 * configures it and believes it is running.
 */
const RESERVED_ROOTS = [
  "items",
  "signal",
  "presence",
  "collab",
  "agent",
  "collections",
] as const;

/** Channels the managed gates own, as a predicate over a channel NAME. */
export const isManagedChannel = (channel: string): boolean =>
  channel === "collections" ||
  channel.startsWith("items:") ||
  channel.startsWith("signal:") ||
  channel.startsWith("presence:") ||
  channel.startsWith("collab:") ||
  channel.startsWith("agent:thread:");

export interface BroadcastRuleRow {
  id: string;
  tenantId: string;
  name: string;
  pattern: string;
  subscribe: unknown;
  publish: unknown;
  presence: boolean;
  replay: boolean;
  retentionHours: number;
  enabled: boolean;
  createdAt: Date | number | null;
  updatedAt: Date | number | null;
}

/**
 * Read one stored access object.
 *
 * THREE answers, not two: the rule is absent, the rule is readable, or the
 * rule is present and cannot be understood. The third is why this returns
 * `{ access: "none" }` for an unparseable value instead of a default — a
 * stored rule that a restore or a hand edit corrupted must refuse everyone,
 * not admit everyone. (`allowedEmailDomains` and `urlSchemes` both shipped the
 * other way round; this is the same shape and it fails closed.)
 */
export const readAccess = (raw: unknown): ChannelAccess => {
  const parsed = typeof raw === "string" ? safeJson(raw) : raw;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { access: "none" };
  }
  const o = parsed as Record<string, unknown>;
  const access = o.access;
  if (
    access !== "none" &&
    access !== "public" &&
    access !== "authenticated" &&
    access !== "roles"
  ) {
    return { access: "none" };
  }
  const roles = Array.isArray(o.roles)
    ? o.roles.filter((r): r is string => typeof r === "string")
    : undefined;
  // A `roles` rule whose list did not survive is not "any role" — it is a rule
  // nobody satisfies.
  if (access === "roles" && (!roles || roles.length === 0)) return { access: "none" };
  const condition =
    o.condition && typeof o.condition === "object" ? (o.condition as unknown) : undefined;
  return { access, roles, condition };
};

const safeJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

export const toRuleView = (row: BroadcastRuleRow): BroadcastRuleView => ({
  id: row.id,
  name: row.name,
  pattern: row.pattern,
  subscribe: readAccess(row.subscribe),
  publish: readAccess(row.publish),
  presence: Boolean(row.presence),
  replay: Boolean(row.replay),
  retentionHours: row.retentionHours,
  enabled: Boolean(row.enabled),
});

// --- Rule resolution --------------------------------------------------------

export interface ResolvedChannel {
  rule: BroadcastRuleView;
  /** Captures from the pattern, e.g. `{ org: "acme" }` for `org:{org}:feed`. */
  params: Record<string, string>;
}

/**
 * The single best rule for `channel`, or `null`.
 *
 * Two rules can match the same channel (`chat:*` and `chat:lobby`) and which
 * one applies must not depend on insertion order — an operator adding a narrow
 * rule expects it to beat the broad one already there. Specificity decides,
 * with the pattern string as a total tiebreak so the choice is reproducible
 * across dialects and across a re-read of the same rows in another order.
 */
export const resolveChannelRule = async (
  ctx: Ctx,
  tenantId: string | null | undefined,
  channel: string,
): Promise<ResolvedChannel | null> => {
  if (!tenantId) return null;
  if (!splitChannel(channel)) return null;
  const t = channelsTable(ctx.dialect);
  const rows = (await (ctx.db as AnyDb)
    .select()
    .from(t)
    .where(and(eq(t.tenantId, tenantId), eq(t.enabled, true)))) as BroadcastRuleRow[];
  let best: ResolvedChannel | null = null;
  let bestScore = -1;
  let bestPattern = "";
  for (const row of rows) {
    const m = matchPattern(row.pattern, channel);
    if (!m) continue;
    const score = patternSpecificity(row.pattern);
    if (score > bestScore || (score === bestScore && row.pattern > bestPattern)) {
      best = { rule: toRuleView(row), params: m.params };
      bestScore = score;
      bestPattern = row.pattern;
    }
  }
  return best;
};

/**
 * Does `auth` satisfy `access` on a channel whose captures are `params`?
 *
 * The condition is evaluated against the CAPTURES as if they were a row, which
 * is why no new evaluator exists: `{ org: { _eq: "$org.id" } }` on
 * `org:{org}:feed` is the same shape, the same operators and the same
 * variables as a permission condition on a collection.
 */
export const satisfiesAccess = (
  access: ChannelAccess,
  auth: AuthSubject,
  params: Record<string, string>,
): boolean => {
  switch (access.access) {
    case "none":
      return false;
    case "public":
      break;
    case "authenticated":
      if (!auth.userId) return false;
      break;
    case "roles": {
      if (!auth.userId) return false;
      const allowed = access.roles ?? [];
      if (!auth.roles.some((r) => allowed.includes(r))) return false;
      break;
    }
  }
  if (access.condition === undefined) return true;
  let cond: Condition;
  try {
    cond = normalizeCondition(access.condition);
  } catch {
    // An unusable stored rule matches nothing — same posture as the realtime
    // filter evaluator, which also runs inside a fan-out where one bad rule
    // must not take the delivery down.
    return false;
  }
  try {
    return matchesCondition({ ...params }, cond, auth);
  } catch {
    return false;
  }
};

// --- Publishing -------------------------------------------------------------

const byteLength = (v: unknown): number => {
  try {
    return new TextEncoder().encode(JSON.stringify(v ?? null)).length;
  } catch {
    // Circular / unserializable — treat as over the cap rather than as empty.
    return Number.MAX_SAFE_INTEGER;
  }
};

/**
 * Validate a publish body and turn it into the frame subscribers receive.
 *
 * Identity is stamped from the session here and nowhere else, so a member
 * cannot appear as another — the same rule collab publishes under. A presence
 * frame is refused outright on a channel whose rule does not enable presence,
 * rather than delivered as an ordinary message that clients would then have to
 * distinguish.
 */
export const buildBroadcastFrame = (
  input: unknown,
  rule: BroadcastRuleView,
  auth: { userId: string | null; email: string | null },
  now: number,
): BroadcastFrame => {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new AppError(
      "VALIDATION",
      "Broadcast body must be an object — `{ event?, data }` or `{ kind: \"presence\", t }`",
    );
  }
  const body = input as Record<string, unknown>;
  const from =
    auth.userId === null ? null : { id: auth.userId, name: auth.email ?? null };

  if (body.kind === "presence") {
    if (!rule.presence) {
      throw new AppError(
        "FORBIDDEN",
        `Presence is not enabled on the rule "${rule.name}" — turn it on to announce members here`,
      );
    }
    if (!from) {
      throw new AppError("UNAUTHORIZED", "Presence frames carry an identity — sign in first");
    }
    const t = body.t;
    if (t !== "hello" && t !== "ping" && t !== "bye") {
      throw new AppError("VALIDATION", "Presence `t` must be hello | ping | bye");
    }
    let state: Record<string, unknown> | undefined;
    if (body.state !== undefined && body.state !== null) {
      if (typeof body.state !== "object" || Array.isArray(body.state)) {
        throw new AppError("VALIDATION", "Presence `state` must be an object");
      }
      if (byteLength(body.state) > MAX_PRESENCE_STATE_BYTES) {
        throw new AppError(
          "VALIDATION",
          `Presence state exceeds ${MAX_PRESENCE_STATE_BYTES} bytes — presence repeats every few seconds`,
        );
      }
      state = body.state as Record<string, unknown>;
    }
    return { kind: "presence", t, state, from, at: now };
  }

  if (!("data" in body)) {
    throw new AppError("VALIDATION", "Broadcast message needs a `data` property");
  }
  const event = body.event === undefined ? "message" : body.event;
  if (typeof event !== "string" || event.length === 0 || event.length > 64) {
    throw new AppError("VALIDATION", "`event` must be a string of 1–64 characters");
  }
  if (byteLength(body.data) > MAX_BROADCAST_PAYLOAD_BYTES) {
    throw new AppError(
      "VALIDATION",
      `Broadcast payload exceeds ${MAX_BROADCAST_PAYLOAD_BYTES} bytes`,
    );
  }
  return { kind: "message", event, data: body.data, from, at: now };
};

/** UTC `YYYYMMDD` for the message log's range key. */
export const utcDayKey = (at: number): number => {
  const d = new Date(at);
  return d.getUTCFullYear() * 10_000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
};

/**
 * Retain a published message for replay. Presence frames are deliberately not
 * retained: they are claims about who is here NOW, and replaying one makes the
 * client believe in a member who left yesterday.
 */
/**
 * Message ids are TIME-ORDERED, not random.
 *
 * The replay cursor is the keyset `(created_at, id)`, so `id` is the tiebreak
 * whenever two messages share a millisecond — and a random UUID would make
 * that tiebreak arbitrary, i.e. three messages published in the same
 * millisecond would come back in a shuffled order. A hex timestamp prefix
 * plus a per-process counter makes the order within a process EXACTLY publish
 * order, and across processes still total and stable — which is the property
 * paging actually depends on (never skip, never repeat).
 */
let lastIdMs = 0;
let idSeq = 0;
const messageId = (at: number): string => {
  if (at === lastIdMs) idSeq += 1;
  else {
    lastIdMs = at;
    idSeq = 0;
  }
  return (
    at.toString(16).padStart(12, "0") +
    idSeq.toString(16).padStart(4, "0") +
    crypto.randomUUID().replace(/-/g, "").slice(0, 16)
  );
};

export const recordBroadcast = async (
  ctx: Ctx,
  tenantId: string,
  channel: string,
  frame: BroadcastFrame,
): Promise<void> => {
  if (frame.kind !== "message") return;
  const t = messagesTable(ctx.dialect);
  const at = new Date(frame.at);
  await (ctx.db as AnyDb).insert(t).values({
    id: messageId(frame.at),
    tenantId,
    channel,
    day: utcDayKey(frame.at),
    event: frame.event,
    // Serialized here, parsed in `readReplay` — the column is TEXT on both
    // dialects so one function decides what an unreadable row means.
    payload: frame.data === undefined ? null : JSON.stringify(frame.data),
    senderId: frame.from?.id ?? null,
    senderName: frame.from?.name ?? null,
    createdAt: at,
  });
};

// --- Replay -----------------------------------------------------------------

export interface ReplayMessage {
  id: string;
  event: string;
  data: unknown;
  from: { id: string; name: string | null } | null;
  at: number;
  /** Opaque keyset cursor to pass back as `since`. */
  cursor: string;
}

const toMs = (v: Date | number | string | null): number => {
  if (v === null) return 0;
  if (typeof v === "number") return v;
  if (v instanceof Date) return v.getTime();
  const n = Date.parse(v);
  return Number.isNaN(n) ? 0 : n;
};

const encodeCursor = (at: number, id: string): string => `${at}.${id}`;

const decodeCursor = (raw: string | undefined): { at: number; id: string } | null => {
  if (!raw) return null;
  const dot = raw.indexOf(".");
  if (dot <= 0) return null;
  const at = Number(raw.slice(0, dot));
  const id = raw.slice(dot + 1);
  if (!Number.isSafeInteger(at) || at < 0 || id.length === 0) return null;
  return { at, id };
};

/**
 * Read retained messages for a channel, oldest first, from `since` (exclusive).
 *
 * The window is clamped to the rule's retention on the way IN as well as by the
 * prune: a prune that has not run yet must not widen what a caller can read,
 * or turning retention down would be a change that only takes effect tomorrow.
 */
export const readReplay = async (
  ctx: Ctx,
  tenantId: string,
  channel: string,
  rule: BroadcastRuleView,
  since: string | undefined,
  limit: number,
): Promise<{ data: ReplayMessage[]; cursor: string | null }> => {
  if (!rule.replay) {
    throw new AppError(
      "VALIDATION",
      `Replay is not enabled on the rule "${rule.name}" — messages on this channel are not retained`,
    );
  }
  const t = messagesTable(ctx.dialect);
  const cap = Math.min(Math.max(1, limit), REPLAY_PAGE_SIZE);
  const windowStart = Date.now() - rule.retentionHours * 3_600_000;
  const cursor = decodeCursor(since);
  const floor = cursor ? Math.max(cursor.at, windowStart) : windowStart;
  const floorVal = ctx.dialect === "pg" ? new Date(floor) : floor;
  const cursorVal =
    cursor && ctx.dialect === "pg" ? new Date(cursor.at) : (cursor?.at as unknown);

  const where = cursor
    ? and(
        eq(t.tenantId, tenantId),
        eq(t.channel, channel),
        // Keyset on (created_at, id): a bare `created_at >` skips a message
        // that shared the millisecond, and `>=` repeats one forever.
        or(
          gt(t.createdAt, cursorVal as never),
          and(eq(t.createdAt, cursorVal as never), gt(t.id, cursor.id)),
        ),
        // …still clamped to the retention window.
        sql`${t.createdAt} >= ${floorVal}`,
      )
    : and(
        eq(t.tenantId, tenantId),
        eq(t.channel, channel),
        sql`${t.createdAt} >= ${floorVal}`,
      );

  const rows = (await (ctx.db as AnyDb)
    .select()
    .from(t)
    .where(where)
    .orderBy(asc(t.createdAt), asc(t.id))
    .limit(cap)) as Array<{
    id: string;
    event: string;
    payload: unknown;
    senderId: string | null;
    senderName: string | null;
    createdAt: Date | number | null;
  }>;

  const data: ReplayMessage[] = rows.map((r) => {
    const at = toMs(r.createdAt);
    return {
      id: r.id,
      event: r.event,
      data: typeof r.payload === "string" ? safeJson(r.payload) : (r.payload ?? null),
      from: r.senderId ? { id: r.senderId, name: r.senderName } : null,
      at,
      cursor: encodeCursor(at, r.id),
    };
  });
  return { data, cursor: data.length ? data[data.length - 1]!.cursor : null };
};

/**
 * Drop retained messages older than the longest retention any rule declares.
 *
 * One ranged DELETE on `day`, which is the whole reason `day` exists: the
 * alternative — deleting by timestamp per channel — is a scan on the read
 * index and would have to run once per rule. Pruning by the LONGEST retention
 * is deliberate: `readReplay` already clamps each channel to its own window,
 * so a shorter-retention channel is correct before the prune catches up, and
 * one statement is worth more here than one row of precision.
 */
export const pruneBroadcastMessages = async (
  ctx: Ctx,
  now: number = Date.now(),
): Promise<number> => {
  const t = messagesTable(ctx.dialect);
  const cutoffDay = utcDayKey(now - (MAX_REPLAY_RETENTION_HOURS + 24) * 3_600_000);
  const res = await (ctx.db as AnyDb).delete(t).where(lt(t.day, cutoffDay));
  return typeof res?.rowsAffected === "number" ? res.rowsAffected : 0;
};

// --- Rule CRUD --------------------------------------------------------------

export interface BroadcastRuleInput {
  name: string;
  pattern: string;
  subscribe: ChannelAccess;
  publish: ChannelAccess;
  presence?: boolean;
  replay?: boolean;
  retentionHours?: number;
  enabled?: boolean;
}

const assertAccess = (label: string, value: ChannelAccess): ChannelAccess => {
  const parsed = readAccess(value);
  // `readAccess` fails closed, so a caller who sent something unusable would
  // silently get `none`. On the WRITE path that is the wrong answer: say so.
  if (parsed.access === "none" && value?.access !== "none") {
    throw new AppError(
      "VALIDATION",
      `\`${label}.access\` must be none | public | authenticated | roles` +
        (value?.access === "roles" ? " — and `roles` must be a non-empty list" : ""),
    );
  }
  if (parsed.condition !== undefined) {
    try {
      normalizeCondition(parsed.condition);
    } catch (e) {
      throw new AppError(
        "VALIDATION",
        `\`${label}.condition\` is not a valid permission condition: ${(e as Error).message}`,
      );
    }
  }
  return parsed;
};

const assertPattern = (pattern: string): void => {
  const problem = validatePattern(pattern);
  if (problem) throw new AppError("VALIDATION", problem);
  const root = pattern.split(":")[0]!;
  if ((RESERVED_ROOTS as readonly string[]).includes(root) || root === "*" || root === "**") {
    throw new AppError(
      "VALIDATION",
      `"${root}" is reserved for a managed channel (items, signal, presence, collab, agent, collections) — ` +
        "a rule there could never fire, so it is refused rather than stored and ignored",
    );
  }
  if (/^\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(root)) {
    throw new AppError(
      "VALIDATION",
      "The first segment must be a literal — a leading capture would shadow every managed channel",
    );
  }
};

const normalizeInput = (input: BroadcastRuleInput) => {
  assertPattern(input.pattern);
  const retentionHours = input.retentionHours ?? 24;
  if (!Number.isInteger(retentionHours) || retentionHours < 1) {
    throw new AppError("VALIDATION", "`retentionHours` must be a positive whole number");
  }
  if (retentionHours > MAX_REPLAY_RETENTION_HOURS) {
    throw new AppError(
      "VALIDATION",
      `\`retentionHours\` is capped at ${MAX_REPLAY_RETENTION_HOURS} — replay is a reconnect aid, ` +
        "not an event store; write rows to a collection for history",
    );
  }
  if (!input.name || input.name.length > 120) {
    throw new AppError("VALIDATION", "`name` must be 1–120 characters");
  }
  return {
    name: input.name,
    pattern: input.pattern,
    subscribe: assertAccess("subscribe", input.subscribe),
    publish: assertAccess("publish", input.publish),
    presence: input.presence ?? false,
    replay: input.replay ?? false,
    retentionHours,
    enabled: input.enabled ?? true,
  };
};

/** The two access columns as they are STORED — see the schema comment. */
const serializedAccess = (v: { subscribe: ChannelAccess; publish: ChannelAccess }) => ({
  subscribe: JSON.stringify(v.subscribe),
  publish: JSON.stringify(v.publish),
});

export const listBroadcastRules = async (
  ctx: Ctx,
  tenantId: string,
): Promise<BroadcastRuleView[]> => {
  const t = channelsTable(ctx.dialect);
  const rows = (await (ctx.db as AnyDb)
    .select()
    .from(t)
    .where(eq(t.tenantId, tenantId))
    .orderBy(asc(t.pattern))) as BroadcastRuleRow[];
  return rows.map(toRuleView);
};

const uniqueOrThrow = async (
  ctx: Ctx,
  tenantId: string,
  pattern: string,
  exceptId?: string,
): Promise<void> => {
  const t = channelsTable(ctx.dialect);
  const rows = (await (ctx.db as AnyDb)
    .select({ id: t.id })
    .from(t)
    .where(and(eq(t.tenantId, tenantId), eq(t.pattern, pattern)))) as Array<{ id: string }>;
  if (rows.some((r) => r.id !== exceptId)) {
    // The unique index would raise this as a driver error the global handler
    // maps to a 500. Naming it here keeps a duplicate pattern a 422 with the
    // pattern in the message.
    throw new AppError("VALIDATION", `A rule for the pattern "${pattern}" already exists`);
  }
};

export const createBroadcastRule = async (
  ctx: Ctx,
  tenantId: string,
  input: BroadcastRuleInput,
): Promise<BroadcastRuleView> => {
  const v = normalizeInput(input);
  await uniqueOrThrow(ctx, tenantId, v.pattern);
  const t = channelsTable(ctx.dialect);
  const id = crypto.randomUUID();
  await (ctx.db as AnyDb)
    .insert(t)
    .values({ id, tenantId, ...v, ...serializedAccess(v), createdAt: new Date(), updatedAt: new Date() });
  return { id, ...v };
};

export const updateBroadcastRule = async (
  ctx: Ctx,
  tenantId: string,
  id: string,
  input: Partial<BroadcastRuleInput>,
): Promise<BroadcastRuleView> => {
  const t = channelsTable(ctx.dialect);
  const rows = (await (ctx.db as AnyDb)
    .select()
    .from(t)
    .where(and(eq(t.id, id), eq(t.tenantId, tenantId)))
    .limit(1)) as BroadcastRuleRow[];
  const existing = rows[0];
  if (!existing) throw new AppError("NOT_FOUND", "Channel rule not found");
  const current = toRuleView(existing);
  const merged = normalizeInput({
    name: input.name ?? current.name,
    pattern: input.pattern ?? current.pattern,
    subscribe: input.subscribe ?? current.subscribe,
    publish: input.publish ?? current.publish,
    presence: input.presence ?? current.presence,
    replay: input.replay ?? current.replay,
    retentionHours: input.retentionHours ?? current.retentionHours,
    enabled: input.enabled ?? current.enabled,
  });
  if (merged.pattern !== current.pattern) {
    await uniqueOrThrow(ctx, tenantId, merged.pattern, id);
  }
  await (ctx.db as AnyDb)
    .update(t)
    .set({ ...merged, ...serializedAccess(merged), updatedAt: new Date() })
    .where(and(eq(t.id, id), eq(t.tenantId, tenantId)));
  return { id, ...merged };
};

export const deleteBroadcastRule = async (
  ctx: Ctx,
  tenantId: string,
  id: string,
): Promise<void> => {
  const t = channelsTable(ctx.dialect);
  const rows = (await (ctx.db as AnyDb)
    .select({ id: t.id })
    .from(t)
    .where(and(eq(t.id, id), eq(t.tenantId, tenantId)))
    .limit(1)) as Array<{ id: string }>;
  if (!rows[0]) throw new AppError("NOT_FOUND", "Channel rule not found");
  await (ctx.db as AnyDb).delete(t).where(and(eq(t.id, id), eq(t.tenantId, tenantId)));
};

/**
 * Answer "what would happen if this identity touched this channel" without
 * touching it — the same affordance `permissions.simulate` gives for
 * collections. An operator debugging a pattern should not have to open a
 * WebSocket to find out that `chat:*` does not match `chat:room:1`.
 */
export interface ChannelExplain {
  channel: string;
  managed: boolean;
  matched: { id: string; name: string; pattern: string } | null;
  params: Record<string, string>;
  canSubscribe: boolean;
  canPublish: boolean;
  reason: string;
}

export const explainChannel = async (
  ctx: Ctx,
  tenantId: string,
  auth: AuthSubject,
  channel: string,
  /**
   * Whether the answer may NAME the rule that matched.
   *
   * The verdict — may I subscribe, may I publish — is about the caller and is
   * safe to give anyone signed in. The rule's name and pattern are the
   * workspace's channel topology, and an app-plane end-user probing names
   * could map it one guess at a time. So details are admin-only, and everyone
   * else gets the verdict with the rule withheld. Found in this branch's own
   * security review, together with the missing sign-in check.
   */
  includeRuleDetails: boolean,
): Promise<ChannelExplain> => {
  const base = {
    channel,
    managed: isManagedChannel(channel),
    matched: null,
    params: {},
    canSubscribe: false,
    canPublish: false,
  };
  if (base.managed) {
    return {
      ...base,
      reason:
        "Managed channel — its own permission gate applies (collection read, thread workspace, admin), not a broadcast rule",
    };
  }
  if (!splitChannel(channel)) {
    return { ...base, reason: "Not a legal channel name" };
  }
  const resolved = await resolveChannelRule(ctx, tenantId, channel);
  if (!resolved) {
    return {
      ...base,
      reason: "No enabled rule matches this channel — subscribe and publish are both refused",
    };
  }
  const { rule, params } = resolved;
  return {
    channel,
    managed: false,
    matched: includeRuleDetails
      ? { id: rule.id, name: rule.name, pattern: rule.pattern }
      : null,
    // The captures come from the channel name the CALLER supplied, so they
    // reveal nothing the caller did not already type.
    params,
    canSubscribe: satisfiesAccess(rule.subscribe, auth, params),
    canPublish: satisfiesAccess(rule.publish, auth, params),
    reason: includeRuleDetails
      ? `Matched "${rule.name}" (${rule.pattern})`
      : "A rule matches this channel",
  };
};

/** Whether the deployment still allows the legacy open free-form channels. */
export const openChannelsEnabled = (env: { REALTIME_OPEN_CHANNELS?: string }): boolean =>
  env.REALTIME_OPEN_CHANNELS === "1" || env.REALTIME_OPEN_CHANNELS === "true";

export type { BroadcastPublishInput };
