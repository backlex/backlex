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
  send: (msg: string) => void;
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

const passesFilter = (
  data: Record<string, unknown>,
  meta: SubscriptionMeta,
): boolean => {
  if (meta.conditions === null) return true;
  if (meta.conditions.length === 0) return false;
  return meta.conditions.some((c) => matchesCondition(data, c, meta.authSubject));
};

const subscribers = new Map<string, Set<Subscriber>>();

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

export const publishLocal = (channel: string, payload: unknown): void => {
  const set = subscribers.get(channel);
  if (!set) return;
  const isItem =
    typeof payload === "object" &&
    payload !== null &&
    "event" in payload &&
    "data" in payload;
  for (const sub of set) {
    try {
      if (sub.meta && isItem) {
        const p = payload as ItemEventPayload;
        if (!passesFilter(p.data, sub.meta)) continue;
        const out = sub.meta.fields
          ? { ...p, data: projectEventData(p.data, sub.meta.fields) }
          : p;
        sub.send(JSON.stringify(out));
      } else {
        sub.send(JSON.stringify(payload));
      }
    } catch {
      // ignore per-subscriber errors
    }
  }
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
