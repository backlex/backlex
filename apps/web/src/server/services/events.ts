import { matchesCondition } from "@workeros/db";
import type { AuthSubject, Condition, EmailAdapter } from "@workeros/core";
import type { PgDb } from "@workeros/db/pg";
import type { SqliteDb } from "@workeros/db/sqlite";
import type { Ctx } from "../context";
import type { Env } from "../env";
import { dispatchWebhooks } from "./webhooks";
import { runFlows } from "./flows";
import { runEventFunctions } from "./functions";

export interface ItemEventPayload {
  event: "created" | "updated" | "deleted";
  data: Record<string, unknown>;
}

export interface SubscriptionMeta {
  authSubject: AuthSubject;
  /** null = unrestricted (admin or unconditional permission). */
  conditions: Condition[] | null;
  /** null = all fields readable. */
  fields: string[] | null;
}

export interface Subscriber {
  /** `id` is the monotonic per-channel sequence number for SSE `Last-Event-ID`
   *  resumption; `0` (or omitted) means the message is not replayable. */
  send: (msg: string, id?: number) => void;
  meta?: SubscriptionMeta;
}

const SYSTEM_FIELDS = new Set([
  "id",
  "createdAt",
  "updatedAt",
  "ownerId",
]);

export const projectEventData = (
  data: Record<string, unknown>,
  fields: string[],
): Record<string, unknown> => {
  const allow = new Set(fields);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (SYSTEM_FIELDS.has(k) || allow.has(k)) out[k] = v;
  }
  return out;
};

const isItemPayload = (payload: unknown): payload is ItemEventPayload =>
  typeof payload === "object" &&
  payload !== null &&
  "event" in payload &&
  "data" in payload;

const passesFilter = (
  data: Record<string, unknown>,
  meta: SubscriptionMeta,
): boolean => {
  if (meta.conditions === null) return true;
  if (meta.conditions.length === 0) return false;
  return meta.conditions.some((c) => matchesCondition(data, c, meta.authSubject));
};

/** Serialize `payload` for a single subscriber, applying the permission filter
 *  + field projection for ItemEvent-shaped payloads. Returns `null` when the
 *  subscriber must not see this event. */
const renderFor = (
  sub: Subscriber,
  payload: unknown,
  isItem: boolean,
): string | null => {
  if (sub.meta && isItem) {
    const p = payload as ItemEventPayload;
    if (!passesFilter(p.data, sub.meta)) return null;
    const out = sub.meta.fields
      ? { ...p, data: projectEventData(p.data, sub.meta.fields) }
      : p;
    return JSON.stringify(out);
  }
  return JSON.stringify(payload);
};

const subscribers = new Map<string, Set<Subscriber>>();

/** Bounded per-channel ring buffer of recent events so a reconnecting SSE
 *  subscriber can replay anything it missed (via `Last-Event-ID`). */
interface RecentEntry {
  id: number;
  /** JSON.stringify of the raw published payload — re-rendered per subscriber
   *  on replay so the permission filter still applies. */
  raw: string;
}
const RECENT_LIMIT = 50;
const recent = new Map<string, { seq: number; entries: RecentEntry[] }>();

const recordRecent = (channel: string, payload: unknown): number => {
  let r = recent.get(channel);
  if (!r) {
    r = { seq: 0, entries: [] };
    recent.set(channel, r);
  }
  r.seq += 1;
  r.entries.push({ id: r.seq, raw: JSON.stringify(payload) });
  if (r.entries.length > RECENT_LIMIT) {
    r.entries.splice(0, r.entries.length - RECENT_LIMIT);
  }
  return r.seq;
};

/** Highest sequence number currently recorded for `channel` (0 if none). */
export const currentSeq = (channel: string): number =>
  recent.get(channel)?.seq ?? 0;

export const subscribeLocal = (
  channel: string,
  sub: Subscriber,
): (() => void) => {
  let set = subscribers.get(channel);
  if (!set) {
    set = new Set();
    subscribers.set(channel, set);
  }
  set.add(sub);
  return () => {
    set!.delete(sub);
    if (set!.size === 0) subscribers.delete(channel);
  };
};

/** Replay events `after < id <= upTo` from the ring buffer to a single
 *  subscriber, applying its permission filter. */
export const replayLocal = (
  channel: string,
  sub: Subscriber,
  after: number,
  upTo: number,
): void => {
  const r = recent.get(channel);
  if (!r) return;
  for (const e of r.entries) {
    if (e.id <= after || e.id > upTo) continue;
    let payload: unknown;
    try {
      payload = JSON.parse(e.raw);
    } catch {
      payload = e.raw;
    }
    const msg = renderFor(sub, payload, isItemPayload(payload));
    if (msg === null) continue;
    try {
      sub.send(msg, e.id);
    } catch {
      // ignore per-subscriber errors
    }
  }
};

export const publishLocal = (channel: string, payload: unknown): void => {
  const id = recordRecent(channel, payload);
  const set = subscribers.get(channel);
  if (!set) return;
  const isItem = isItemPayload(payload);
  for (const sub of set) {
    try {
      const msg = renderFor(sub, payload, isItem);
      if (msg !== null) sub.send(msg, id);
    } catch {
      // ignore per-subscriber errors
    }
  }
};

// --- Presence (in-process / Bun) -------------------------------------------

export interface PresenceMember {
  userId: string;
  email: string | null;
}

export interface PresencePayload {
  event: "presence";
  data: { members: PresenceMember[] };
}

const presenceRooms = new Map<string, Map<Subscriber, PresenceMember>>();

const presenceMembers = (channel: string): PresenceMember[] => {
  const room = presenceRooms.get(channel);
  if (!room) return [];
  const byId = new Map<string, PresenceMember>();
  for (const m of room.values()) byId.set(m.userId, m);
  return [...byId.values()].sort((a, b) =>
    (a.email ?? a.userId).localeCompare(b.email ?? b.userId),
  );
};

const broadcastPresenceLocal = (channel: string): void => {
  publishLocal(channel, {
    event: "presence",
    data: { members: presenceMembers(channel) },
  } satisfies PresencePayload);
};

/** Register `sub` as a member of a `presence:*` channel and announce the
 *  updated roster. Returns a leave fn that deregisters + re-announces. */
export const joinPresence = (
  channel: string,
  sub: Subscriber,
  member: PresenceMember,
): (() => void) => {
  let room = presenceRooms.get(channel);
  if (!room) {
    room = new Map();
    presenceRooms.set(channel, room);
  }
  room.set(sub, member);
  broadcastPresenceLocal(channel);
  return () => {
    room!.delete(sub);
    if (room!.size === 0) presenceRooms.delete(channel);
    broadcastPresenceLocal(channel);
  };
};

export const publishEvent = async (
  env: Env,
  channel: string,
  payload: unknown,
  serverCtx?: {
    db: PgDb | SqliteDb;
    dialect: "pg" | "sqlite";
    email?: EmailAdapter;
    fullCtx?: Ctx;
    /** Active workspace for the originating request. Required for downstream
     *  fan-out (event functions/flows) so triggers from one workspace never
     *  fire handlers in another. */
    tenantId?: string | null;
  },
): Promise<void> => {
  if (env.REALTIME) {
    const id = env.REALTIME.idFromName(channel);
    const stub = env.REALTIME.get(id);
    await stub.fetch("https://do/publish", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  } else {
    publishLocal(channel, payload);
  }
  // Webhook + flow dispatch (fire-and-forget) for ItemEvent-shaped payloads.
  if (
    serverCtx &&
    typeof payload === "object" &&
    payload !== null &&
    "event" in payload &&
    "data" in payload
  ) {
    const evt = payload as ItemEventPayload;
    void dispatchWebhooks(serverCtx, channel, evt);
    if (serverCtx.fullCtx) {
      void runFlows(serverCtx.fullCtx, channel, evt);
      void runEventFunctions(
        serverCtx.fullCtx,
        serverCtx.tenantId ?? null,
        channel,
        evt,
        // Functions triggered by events run with the system principal — admin
        // can toggle the function active flag for trust gating.
        { userId: null, email: null, roles: [], tenantId: serverCtx.tenantId ?? null },
      );
    }
  }
};
