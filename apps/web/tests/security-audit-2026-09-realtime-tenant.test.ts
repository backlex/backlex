/**
 * Phase 3 of the 2026-09 pre-prod audit — the realtime bus must route per
 * workspace, and the versioned-draft clause must actually narrow.
 *
 * ── the reproduction, before any of this was fixed ──────────────────────────
 *
 * Two workspaces each own a collection called `orders` (per-workspace
 * collections make that ordinary). Workspace B's owner opens
 * `GET /api/realtime/items:orders/subscribe`. Workspace A's owner then POSTs a
 * row. B's stream delivers it, in full:
 *
 *   {"event":"created","data":{"id":"7a7b…","secret":"WORKSPACE-A-ONLY",…}}
 *
 * Every transport keyed its room on the channel STRING alone — the Durable
 * Object on `idFromName("items:orders")`, Upstash on `rt:items:orders`, the
 * in-process bus on a `Map` key, Ably on the channel name — so both workspaces
 * published into one room. `renderItemEvent` could not stop it: it applies the
 * SUBSCRIBER's row conditions, and a workspace admin has none.
 *
 * The fix puts the workspace in the ROUTING KEY (`services/realtime-topic.ts`)
 * and leaves the channel name alone, because that name is also the trigger key
 * webhooks/flows/integrations match on, the SDK's `subscribe()` argument and
 * the admin's channel list. Renaming it would have broken every configured
 * `items:orders` trigger to buy isolation the routing key already provides —
 * so the last block here pins that the name did NOT move.
 *
 * ── the second half: a guard that read as a field name ──────────────────────
 *
 * `gateForChannel` ANDs `_status = 'published'` into a subscriber's conditions
 * on a versioned collection when they cannot see drafts. It built that with
 * `{_and: […]}` — an INPUT alias only `normalizeCondition` understands — and
 * handed it straight to the in-memory evaluator, which understood `$and` only.
 * `_and` fell through to the field-map loop, matched no column, and the whole
 * condition returned TRUE: the draft clause AND the caller's own row conditions
 * both erased. Both evaluators now accept what the normalizer accepts.
 *
 * Every block asserts both directions — the refusal AND that the neighbouring
 * legitimate case still works — and each guard was verified by breaking it
 * (see [[verify-a-guard-by-breaking-it]]). 11 of 12 breaks were caught.
 *
 * ── the one break nothing catches, and why that is the honest answer ────────
 *
 * Reverting `gateForChannel` to `{_and: …}` changes NOTHING once the evaluator
 * accepts the alias, and the gate's condition has exactly one consumer
 * (`renderItemEvent` → `matchesCondition`, on both transports). The two halves
 * of the fix are not independent guards masking each other — after the
 * evaluator fix the route's spelling is genuinely equivalent, so there is no
 * case that could separate them and a test asserting otherwise would be
 * asserting a fiction. The route emits `$and` because that is the canonical
 * form every other producer emits, not because behaviour depends on it. The
 * behaviour is pinned by "the in-memory evaluator understands `$and` only
 * again", which fails loudly.
 *
 * One coverage gap closed on the way: nothing drove `publishEvent`'s Durable
 * Object path, so a publisher that stopped stating its workspace would have
 * darkened realtime on Cloudflare with the suite green. See the
 * `publishEvent over the Durable Object namespace` block.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { matchesCondition } from "@backlex/db";
import type { AuthSubject, Condition } from "@backlex/core";
import { eventIsForSubscriber } from "../src/server/services/realtime-filter";
import { parseTopic, topicFor } from "../src/server/services/realtime-topic";
import { ablyRoom, ablyRoomPrefix } from "../src/server/services/realtime-signal";
import { buildTwoPlaneCast, json, type TwoPlaneCast } from "./fixtures/two-plane-cast";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const JSON_HEADERS = { "Content-Type": "application/json" };

interface SSEFrame {
  event: string;
  data: string;
}

async function* readSSE(res: Response): AsyncGenerator<SSEFrame> {
  if (!res.body) throw new Error("no body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        if (!block || block.startsWith(":")) continue;
        let event = "message";
        let data = "";
        for (const raw of block.split("\n")) {
          if (raw.startsWith("event:")) event = raw.slice(6).trim();
          else if (raw.startsWith("data:")) data += raw.slice(5).trimStart();
        }
        yield { event, data };
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* released */
    }
  }
}

/**
 * Drain `res` for `ms` and return every frame seen.
 *
 * A time-boxed drain, not "wait for the next frame" — the assertions here are
 * mostly NEGATIVE (a workspace must see NOTHING), and a helper that waits for a
 * frame cannot express that. The paired positive assertion in each block is
 * what keeps the window honest: if 400ms were too short, the positive half
 * would fail too, rather than the negative half passing vacuously.
 * See [[negative-assertions-need-the-loaded-state]].
 */
const drain = async (res: Response, ms = 400): Promise<SSEFrame[]> => {
  const out: SSEFrame[] = [];
  const it = readSSE(res);
  const timer = new Promise<null>((r) => setTimeout(() => r(null), ms));
  while (true) {
    const nxt = await Promise.race([it.next(), timer]);
    if (nxt === null) break;
    const step = nxt as IteratorResult<SSEFrame>;
    if (step.done) break;
    out.push(step.value);
  }
  return out;
};

const messages = (frames: SSEFrame[]): string[] =>
  frames.filter((f) => f.event === "message").map((f) => f.data);

const inTenant = (slug: string, init: RequestInit = {}): RequestInit => ({
  ...init,
  headers: { ...(init.headers ?? {}), "X-Backlex-Tenant": slug },
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. The address itself
// ─────────────────────────────────────────────────────────────────────────────

describe("realtime topics — the address is (workspace, channel)", () => {
  test("two workspaces never share a topic for the same channel", () => {
    const a = topicFor({ tenantId: "aaaa-1111", channel: "items:orders" });
    const b = topicFor({ tenantId: "bbbb-2222", channel: "items:orders" });
    expect(a).not.toBe(b);
    expect(parseTopic(a)).toEqual({ tenantId: "aaaa-1111", channel: "items:orders" });
    expect(parseTopic(b)).toEqual({ tenantId: "bbbb-2222", channel: "items:orders" });
  });

  test("no workspace is a room of its own, not a wildcard", () => {
    const none = topicFor({ tenantId: null, channel: "system" });
    const some = topicFor({ tenantId: "aaaa-1111", channel: "system" });
    expect(none).not.toBe(some);
    expect(parseTopic(none)).toEqual({ tenantId: null, channel: "system" });
  });

  test("a channel name cannot spell another workspace's topic", () => {
    // The separator is `|`, which a channel segment may not contain
    // (`[A-Za-z0-9_.@-]` joined by `:`, see `splitChannel`). So the boundary
    // holds by CONSTRUCTION rather than by argument: the closest a caller can
    // come is a channel that merely looks like a topic, and it lands inside
    // their own prefix.
    const victim = topicFor({ tenantId: "victim", channel: "items:orders" });
    const forged = topicFor({ tenantId: "attacker", channel: victim });
    expect(forged).not.toBe(victim);
    expect(parseTopic(forged)?.tenantId).toBe("attacker");
  });

  test("parseTopic refuses a string it did not produce", () => {
    expect(parseTopic("items:orders")).toBeNull();
    expect(parseTopic("t|only-a-tenant")).toBeNull();
    expect(parseTopic("t|tenant|")).toBeNull();
  });
});

describe("delivery-time workspace check", () => {
  test("an event only reaches a subscriber of the same workspace", () => {
    expect(eventIsForSubscriber("a", "a")).toBe(true);
    expect(eventIsForSubscriber(null, null)).toBe(true);
    expect(eventIsForSubscriber("a", "b")).toBe(false);
    expect(eventIsForSubscriber("a", null)).toBe(false);
    expect(eventIsForSubscriber(null, "a")).toBe(false);
  });

  test("an unstated workspace is a mismatch, never a wildcard", () => {
    // `undefined` is a frame in a Durable Object's replay log, or a hibernated
    // socket attachment, written by a build before the field existed — possible
    // for the length of one deploy. Dropping costs a reconnect; passing costs
    // the leak. Fail closed.
    expect(eventIsForSubscriber(undefined, "a")).toBe(false);
    expect(eventIsForSubscriber("a", undefined)).toBe(false);
    expect(eventIsForSubscriber(undefined, undefined)).toBe(false);
    expect(eventIsForSubscriber(undefined, null)).toBe(false);
  });
});

/**
 * The Durable Object is the Cloudflare transport — the one every cloud tenant
 * actually runs — and nothing in the suite drives it, because the harness has no
 * `REALTIME` binding and `/subscribe` needs `WebSocketPair`, a workerd global.
 *
 * `/publish` needs neither: it reads `getWebSockets()` and calls `deliver` per
 * socket. So the room is driven directly with a fake state and fake sockets.
 * That covers the two things the DO decides on its own — dropping a frame whose
 * workspace is not the socket's, and building the presence roster — which would
 * otherwise ship to production unexercised.
 */
describe("RealtimeRoom (the Workers transport) drops what is not its subscriber's", () => {
  interface FakeSocket {
    sent: string[];
    attachment: Record<string, unknown>;
  }

  const socket = (attachment: Record<string, unknown>) => {
    const s: FakeSocket = { sent: [], attachment };
    return {
      handle: {
        send: (msg: string) => s.sent.push(msg),
        close: () => {},
        serializeAttachment: (a: Record<string, unknown>) => {
          s.attachment = a;
        },
        deserializeAttachment: () => s.attachment,
      } as unknown as WebSocket,
      state: s,
    };
  };

  const roomWith = async (sockets: WebSocket[]) => {
    const store = new Map<string, unknown>();
    const state = {
      storage: {
        get: async (k: string) => store.get(k),
        put: async (patch: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(patch)) store.set(k, v);
        },
      },
      blockConcurrencyWhile: async (fn: () => Promise<void>) => fn(),
      getWebSockets: () => sockets,
      acceptWebSocket: () => {},
    };
    const { RealtimeRoom } = await import("../src/server/durable-objects/realtime-room");
    return new RealtimeRoom(state as unknown as DurableObjectState);
  };

  const publish = (room: { fetch: (r: Request) => Promise<Response> }, tenant: string | null, body: unknown) =>
    room.fetch(
      new Request("https://do/publish", {
        method: "POST",
        headers: { "x-backlex-event-tenant": tenant ?? "" },
        body: JSON.stringify(body),
      }),
    );

  const meta = {
    authSubject: { userId: "u", email: null, roles: [], tenantId: null },
    conditions: null,
    fields: null,
  };

  test("a frame reaches only the sockets of its own workspace", async () => {
    const a = socket({ meta, presence: null, tenant: "ws-a" });
    const b = socket({ meta, presence: null, tenant: "ws-b" });
    const stale = socket({ meta, presence: null }); // pre-upgrade attachment
    const room = await roomWith([a.handle, b.handle, stale.handle]);

    await publish(room, "ws-a", { event: "created", data: { id: "1", secret: "A-ONLY" } });

    expect(a.state.sent.join("")).toContain("A-ONLY");
    expect(b.state.sent.join("")).toBe("");
    // An attachment written before this field existed is a MISMATCH, not a
    // wildcard: the socket goes quiet and its client reconnects with a fresh
    // gate, rather than being handed a workspace it never proved standing in.
    expect(stale.state.sent.join("")).toBe("");
  });

  test("the presence roster is grouped by workspace, not by room", async () => {
    const a = socket({ meta, presence: { userId: "user-a", email: "a@x.test" }, tenant: "ws-a" });
    const b = socket({ meta, presence: { userId: "user-b", email: "b@x.test" }, tenant: "ws-b" });
    const room = await roomWith([a.handle, b.handle]);

    // `webSocketClose` re-announces — the ordinary trigger, and the one that
    // does not need `WebSocketPair`.
    const leaving = socket({ meta, presence: { userId: "user-gone", email: null }, tenant: "ws-a" });
    await room.webSocketClose(leaving.handle);

    const rosterOf = (s: FakeSocket): string[] => {
      const last = s.sent.at(-1);
      if (!last) return [];
      const frame = JSON.parse(last) as { msg: string };
      const payload = JSON.parse(frame.msg) as { data: { members: { userId: string }[] } };
      return payload.data.members.map((m) => m.userId);
    };
    // A roster names people — it is the one payload on this channel with no
    // permission filter in front of it.
    expect(rosterOf(a.state)).toEqual(["user-a"]);
    expect(rosterOf(b.state)).toEqual(["user-b"]);
  });
});

/**
 * `publishEvent` → Durable Object, wired end to end against REAL rooms.
 *
 * This block exists because a break harness found nothing to catch when the
 * publish envelope stopped stating its workspace — and the consequence of that
 * regression is not a leak but a BLACKOUT: every frame would arrive with an
 * unstated workspace, the delivery check would (correctly) drop it, and
 * realtime on Cloudflare — the runtime every cloud tenant runs — would go
 * silently dark with the whole suite green. Fail-closed is the right design
 * and this is the test that makes its failure mode visible.
 */
describe("publishEvent over the Durable Object namespace", () => {
  const rooms = new Map<
    string,
    { fetch: (input: Request | string, init?: RequestInit) => Promise<Response> }
  >();
  const sockets = new Map<string, { sent: string[]; attachment: Record<string, unknown> }>();

  /** A namespace that routes `idFromName` to a real `RealtimeRoom`, so the
   *  address the publisher computes is the address the room is found at. */
  const namespace = async () => {
    const { RealtimeRoom } = await import("../src/server/durable-objects/realtime-room");
    return {
      idFromName: (name: string) => name,
      get: (name: string) => {
        let room = rooms.get(name);
        if (!room) {
          const store = new Map<string, unknown>();
          const state = {
            storage: {
              get: async (k: string) => store.get(k),
              put: async (patch: Record<string, unknown>) => {
                for (const [k, v] of Object.entries(patch)) store.set(k, v);
              },
            },
            blockConcurrencyWhile: async (fn: () => Promise<void>) => fn(),
            getWebSockets: () =>
              [...sockets.entries()]
                .filter(([key]) => key.startsWith(`${name}::`))
                .map(([, s]) => ({
                  send: (m: string) => s.sent.push(m),
                  close: () => {},
                  serializeAttachment: () => {},
                  deserializeAttachment: () => s.attachment,
                })) as unknown as WebSocket[],
            acceptWebSocket: () => {},
          };
          const instance = new RealtimeRoom(state as unknown as DurableObjectState);
          // A DO STUB takes `(url, init)` and builds the Request; the class
          // itself takes a Request. Adapting here rather than in the caller
          // keeps `publishEvent` calling exactly what it calls in production.
          room = {
            fetch: (input: Request | string, init?: RequestInit) =>
              instance.fetch(typeof input === "string" ? new Request(input, init) : input),
          };
          rooms.set(name, room);
        }
        return room;
      },
    };
  };

  const listen = (topic: string, tenant: string | null | undefined) => {
    const s = {
      sent: [] as string[],
      attachment: {
        meta: { authSubject: { userId: "u", email: null, roles: [], tenantId: tenant ?? null }, conditions: null, fields: null },
        presence: null,
        ...(tenant === undefined ? {} : { tenant }),
      },
    };
    sockets.set(`${topic}::${sockets.size}`, s);
    return s;
  };

  test("a row event reaches its own workspace's room, and only that room", async () => {
    const { publishEvent } = await import("../src/server/services/events");
    const env = { REALTIME: await namespace() } as never;

    const topicA = topicFor({ tenantId: "ws-a", channel: "items:orders" });
    const topicB = topicFor({ tenantId: "ws-b", channel: "items:orders" });
    const inA = listen(topicA, "ws-a");
    const inB = listen(topicB, "ws-b");

    await publishEvent(env, { tenantId: "ws-a", channel: "items:orders" }, {
      event: "created",
      data: { id: "1", secret: "A-ONLY" },
    });

    // The positive half is the one the blackout regression breaks: a publisher
    // that stops stating its workspace still addresses the right ROOM, and the
    // socket in it receives nothing.
    expect(inA.sent.join("")).toContain("A-ONLY");
    expect(inB.sent.join("")).toBe("");
    expect(rooms.has(topicA)).toBe(true);
    expect(rooms.has("items:orders")).toBe(false);
  });
});

/**
 * The published SDK's Ably hub sends TWO names to two different places, and
 * getting them the wrong way round is silent.
 *
 * `createSignalHub` mints its token from the same set it attaches with
 * (`wanted.add(channel)` → `deps.token([...wanted])`), so prefixing at the
 * ATTACH site also sent the prefixed name to `/api/realtime/ably-token` — which
 * namespaces it a second time, and refuses it outright because
 * `t.<id>:signal:items:x` no longer matches the `signal:` gate. That shipped in
 * the first draft of this phase and nothing caught it: the hub had no test, and
 * there is no Ably in the suite.
 */
describe("the SDK signal hub keeps the token name and the room name apart", () => {
  test("token gets the LOGICAL channel; attach gets the ROOM", async () => {
    const tokenAskedFor: string[][] = [];
    const attachedTo: string[] = [];

    const realtime = {
      auth: { authorize: async () => undefined },
      channels: {
        get: (name: string) => {
          attachedTo.push(name);
          return {
            subscribe: async () => undefined,
            unsubscribe: () => {},
            detach: async () => undefined,
          };
        },
      },
      close: () => {},
    };

    const ablyModule = await import("ably");
    mock.module("ably", () => ({
      // ably invokes `authCallback` itself on connect; the fake fires it once
      // at construction so the token request is observable without a socket.
      Realtime: function (opts: { authCallback: (p: unknown, cb: () => void) => void }) {
        opts.authCallback(null, () => {});
        return realtime;
      },
    }));
    try {
      const { createSignalHub } = await import("../../../packages/client/src/signal");
      const hub = createSignalHub({
        token: async (channels) => {
          tokenAskedFor.push([...channels]);
          return {};
        },
        room: (channel) => `t.ws-a:${channel}`,
      });
      const off = await hub.attach("signal:items:orders", () => {});
      off();

      // The two names, and they are NOT the same one.
      expect(attachedTo).toEqual(["t.ws-a:signal:items:orders"]);
      expect(tokenAskedFor).toEqual([["signal:items:orders"]]);
    } finally {
      // Restore by the captured namespace value, never by re-importing — see
      // [[mock-module-namespace-restore-trap]].
      mock.module("ably", () => ablyModule);
    }
  });
});

describe("Ably rooms — the one plane whose name the client constructs", () => {
  test("the prefix separates workspaces and stays inside the channel charset", () => {
    expect(ablyRoomPrefix("aaaa")).not.toBe(ablyRoomPrefix("bbbb"));
    expect(ablyRoomPrefix(null)).not.toBe(ablyRoomPrefix("aaaa"));
    // Ably and `splitChannel` both accept `[A-Za-z0-9_.@-]` segments joined by
    // `:` — a room name that left that charset would be rejected by the broker.
    for (const seg of ablyRoom("aaaa-1111", "signal:items:orders").split(":")) {
      expect(seg).toMatch(/^[A-Za-z0-9_.@-]+$/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. The reproduction, end to end over SSE
// ─────────────────────────────────────────────────────────────────────────────

describe("a workspace's row events stay inside it", () => {
  let cast: TwoPlaneCast;
  const SLUG = `rtx_${`${Date.now()}`.slice(-7)}`;

  beforeAll(async () => {
    cast = await buildTwoPlaneCast();
    for (const [who, ws] of [
      [cast.ownerA, cast.tenantA],
      [cast.ownerB, cast.tenantB],
    ] as const) {
      const r = await who.fetch(
        "/api/collections",
        inTenant(ws.slug, json("POST", { slug: SLUG, fields: [{ name: "secret", type: "text" }] })),
      );
      expect(r.status, `create ${SLUG} in ${ws.slug}`).toBe(201);
    }
  });
  afterAll(() => cast.cleanup());

  /**
   * Open a stream and hand back the abort with it.
   *
   * Every test here MUST close what it opened: the socket-count block asserts a
   * workspace has ZERO connected sockets, and a stream another test left open
   * makes that number 1 — a failure that only appears when the file runs whole,
   * which is the least useful moment to discover it.
   */
  const subscribe = async (
    who: TwoPlaneCast["ownerA"],
    slug: string,
    channel = `items:${SLUG}`,
  ): Promise<{ res: Response; close: () => void }> => {
    const ac = new AbortController();
    const res = await who.fetch(
      `/api/realtime/${channel}/subscribe`,
      inTenant(slug, { signal: ac.signal }),
    );
    return { res, close: () => ac.abort() };
  };

  const write = (who: TwoPlaneCast["ownerA"], slug: string, secret: string) =>
    who.fetch(`/api/items/${SLUG}`, inTenant(slug, json("POST", { secret })));

  test("workspace B does not receive workspace A's rows — and does receive its own", async () => {
    const subB = await subscribe(cast.ownerB, cast.tenantB.slug);
    expect(subB.res.status).toBe(200);
    try {
      // The write that used to leak.
      expect((await write(cast.ownerA, cast.tenantA.slug, "A-ONLY")).status).toBe(201);
      // The write that proves the stream is live at all — without it a stream
      // that is simply broken would satisfy the assertion above.
      expect((await write(cast.ownerB, cast.tenantB.slug, "B-OWN")).status).toBe(201);

      const seen = messages(await drain(subB.res)).join("\n");
      expect(seen).not.toContain("A-ONLY");
      expect(seen).toContain("B-OWN");
    } finally {
      subB.close();
    }
  });

  test("the channel NAME is unchanged — the room is what moved", async () => {
    // The `ready` frame echoes the channel the caller asked for. The fix
    // deliberately did NOT rename `items:<slug>`: that string is also the
    // trigger key webhooks/flows/integrations match on and the SDK's
    // `subscribe()` argument, so a rename would have silently unhooked every
    // configured trigger. This is the guard on that decision.
    const sub = await subscribe(cast.ownerA, cast.tenantA.slug);
    expect(sub.res.status).toBe(200);
    try {
      const frames = await drain(sub.res, 150);
      expect(frames.find((f) => f.event === "ready")?.data).toBe(`items:${SLUG}`);
    } finally {
      sub.close();
    }
  });

  test("a channel spelled like another workspace's topic reaches nothing", async () => {
    // `t|<tenantA>|items:<slug>` as a literal channel name. It is not a valid
    // channel (the `|` is outside the segment charset), so it is refused before
    // it can address anything — and refused as a shape, not as a permission,
    // which is why the assertion names the status rather than the body.
    const forged = topicFor({ tenantId: cast.tenantA.id, channel: `items:${SLUG}` });
    const res = await cast.ownerB.fetch(
      `/api/realtime/${encodeURIComponent(forged)}/subscribe`,
      inTenant(cast.tenantB.slug),
    );
    expect(res.status).toBe(422);
  });

  test("presence rosters do not cross workspaces", async () => {
    const room = "presence:audit-faz3";
    const subA = await subscribe(cast.ownerA, cast.tenantA.slug, room);
    const subB = await subscribe(cast.ownerB, cast.tenantB.slug, room);
    expect(subA.res.status).toBe(200);
    expect(subB.res.status).toBe(200);
    try {
      // A roster names people. Each side must see itself and only itself.
      const [framesA, framesB] = await Promise.all([drain(subA.res), drain(subB.res)]);
      const rosterOf = (frames: SSEFrame[]): string[] => {
        const last = messages(frames).at(-1);
        if (!last) return [];
        const parsed = JSON.parse(last) as { data?: { members?: { userId: string }[] } };
        return (parsed.data?.members ?? []).map((m) => m.userId);
      };
      expect(rosterOf(framesA)).toEqual([cast.ownerA.userId]);
      expect(rosterOf(framesB)).toEqual([cast.ownerB.userId]);
    } finally {
      subA.close();
      subB.close();
    }
  });

  test("channel stats answer about the caller's workspace only", async () => {
    // Same channel name, two workspaces. Before the fix this endpoint reported
    // the other workspace's socket count for any name an admin could guess.
    const sub = await subscribe(cast.ownerA, cast.tenantA.slug);
    expect(sub.res.status).toBe(200);
    try {
      await drain(sub.res, 100);

      const statsFor = async (who: TwoPlaneCast["ownerA"], slug: string) => {
        const res = await who.fetch(
          `/api/admin/realtime/channels/${encodeURIComponent(`items:${SLUG}`)}/stats`,
          inTenant(slug),
        );
        expect(res.status).toBe(200);
        return ((await res.json()) as { data: { stats: { connectedSockets: number } } }).data.stats;
      };

      expect((await statsFor(cast.ownerA, cast.tenantA.slug)).connectedSockets).toBeGreaterThan(0);
      expect((await statsFor(cast.ownerB, cast.tenantB.slug)).connectedSockets).toBe(0);
    } finally {
      sub.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. The handler fan-out reads the same address
// ─────────────────────────────────────────────────────────────────────────────

describe("webhooks fire for their own workspace's writes", () => {
  let cast: TwoPlaneCast;
  const SLUG = `rtw_${`${Date.now()}`.slice(-7)}`;

  beforeAll(async () => {
    cast = await buildTwoPlaneCast();
    for (const [who, ws] of [
      [cast.ownerA, cast.tenantA],
      [cast.ownerB, cast.tenantB],
    ] as const) {
      const r = await who.fetch(
        "/api/collections",
        inTenant(ws.slug, json("POST", { slug: SLUG, fields: [{ name: "secret", type: "text" }] })),
      );
      expect(r.status).toBe(201);
    }
    // Only workspace B has a webhook.
    const hook = await cast.ownerB.fetch(
      "/api/webhooks",
      inTenant(
        cast.tenantB.slug,
        json("POST", {
          name: "faz3",
          url: "https://faz3-sink.example.test/hook",
          // `<channel>:<event>` — the literal `items:<slug>` a user would type.
          events: [`items:${SLUG}:created`],
        }),
      ),
    );
    expect(hook.status, await hook.text().catch(() => "")).toBe(201);
  });
  afterAll(() => cast.cleanup());

  test("the trigger still matches `items:<slug>`, and only in its own workspace", async () => {
    expect(
      (
        await cast.ownerA.fetch(
          `/api/items/${SLUG}`,
          inTenant(cast.tenantA.slug, json("POST", { secret: "A-ONLY" })),
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await cast.ownerB.fetch(
          `/api/items/${SLUG}`,
          inTenant(cast.tenantB.slug, json("POST", { secret: "B-OWN" })),
        )
      ).status,
    ).toBe(201);

    // Delivery is a durable `webhook.deliver` job, so the ENQUEUED job is the
    // observable — asserting on the outbound HTTP would only be testing the
    // queue runner, and the scope decision has already been made by the time
    // the job exists.
    let jobs: { type: string; payload?: { body?: string } }[] = [];
    for (let i = 0; i < 30 && jobs.length === 0; i++) {
      const res = await cast.ownerB.fetch("/api/jobs?queue=webhooks", inTenant(cast.tenantB.slug));
      jobs = ((await res.json()) as { jobs: typeof jobs }).jobs;
      if (jobs.length === 0) await new Promise((r) => setTimeout(r, 15));
    }
    const bodies = jobs
      .filter((j) => j.type === "webhook.deliver")
      .map((j) => j.payload?.body ?? "")
      .join("\n");
    // The positive half is what proves the channel name did not move: the hook
    // is registered against the literal `items:<slug>:created` a user typed.
    expect(bodies).toContain("B-OWN");
    expect(bodies).not.toContain("A-ONLY");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. The `_and` alias — a guard that erased the conditions it was narrowing
// ─────────────────────────────────────────────────────────────────────────────

describe("the in-memory evaluator understands what the normalizer accepts", () => {
  const subject: AuthSubject = { userId: "u1", email: "u@x.test", roles: [], tenantId: "t1" };
  const row = { _status: "draft", owner: "someone-else" };

  test("`_and` narrows instead of vanishing", () => {
    const cond = {
      _and: [{ owner: { _eq: "u1" } }, { _status: { _eq: "published" } }],
    } as unknown as Condition;
    // Before the fix this returned TRUE: `_and` was read as a column name, the
    // row had no such column, every comparison was skipped, and the whole
    // condition passed — taking the caller's own conditions down with it.
    expect(matchesCondition(row, cond, subject)).toBe(false);
    expect(
      matchesCondition(
        { _status: "published", owner: "u1" },
        cond,
        subject,
      ),
    ).toBe(true);
  });

  test("`_or` and `_not` too, and the `$` spellings are unchanged", () => {
    const or = { _or: [{ owner: { _eq: "u1" } }, { _status: { _eq: "draft" } }] } as unknown as Condition;
    expect(matchesCondition(row, or, subject)).toBe(true);
    const not = { _not: { _status: { _eq: "draft" } } } as unknown as Condition;
    expect(matchesCondition(row, not, subject)).toBe(false);
    const canonical = { $and: [{ _status: { _eq: "draft" } }] } as unknown as Condition;
    expect(matchesCondition(row, canonical, subject)).toBe(true);
  });

  test("a `_`-prefixed FIELD is still a field", () => {
    // `_status` / `_publish_at` are real columns. Only the three combinator
    // names are combinators — a blanket rule about `_` would have broken the
    // very clause this phase was fixing.
    expect(matchesCondition(row, { _status: { _eq: "draft" } } as Condition, subject)).toBe(true);
    expect(matchesCondition(row, { _status: { _eq: "published" } } as Condition, subject)).toBe(false);
  });
});

describe("the versioned-draft clause actually narrows over SSE", () => {
  let h: TestHarness;
  const slug = `rtv_${`${Date.now()}`.slice(-7)}`;
  let reader: { token: string; id: string };

  const asReader = (path: string, init: RequestInit = {}) =>
    h.app.request(path, {
      ...init,
      headers: { ...JSON_HEADERS, ...(init.headers ?? {}), Authorization: `Bearer ${reader.token}` },
    });

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);

    const created = await h.fetch(
      "/api/collections",
      json("POST", {
        slug,
        versioned: true,
        fields: [
          { name: "title", type: "text" },
          { name: "owner", type: "text" },
        ],
      }),
    );
    expect(created.status, await created.text().catch(() => "")).toBe(201);

    // A CONDITIONED read grant, and nothing else — no publish, no update. That
    // combination is what triggers the draft clause, and the condition is what
    // the broken clause erased along with it.
    const roles = (await (await h.fetch("/api/roles")).json()) as {
      data: { id: string; name: string }[];
    };
    const authRole = roles.data.find((r) => r.name === "authenticated");
    expect(authRole, "the `authenticated` role should exist").toBeDefined();
    const granted = await h.fetch(
      `/api/roles/${authRole!.id}/permissions`,
      json("POST", {
        collection: slug,
        action: "read",
        condition: { owner: { _eq: "$user.email" } },
      }),
    );
    expect(granted.status).toBeLessThan(300);

    const invited = await h.fetch(
      "/api/app-users/invite",
      json("POST", { email: `reader-${Date.now()}@faz3.test` }),
    );
    expect(invited.status).toBe(201);
    const inv = (await invited.json()) as { data: { id: string; email: string; token: string } };
    const accepted = await h.app.request(
      "/api/t/default/auth/invite/accept",
      json("POST", { token: inv.data.token, password: "faz3-reader-12345" }),
    );
    expect(accepted.status).toBe(200);
    const session = (await accepted.json()) as { accessToken?: string; token: string };
    reader = { token: session.accessToken ?? session.token, id: inv.data.id };
    readerEmail = inv.data.email;
  });
  afterAll(() => h.cleanup());

  let readerEmail = "";

  test("a conditioned reader sees only its own PUBLISHED rows", async () => {
    // NB: never `await res.text()` on this response, even in an assertion
    // message — it is a live `text/event-stream` and reading it to completion
    // waits for a stream that is designed never to end.
    const ac = new AbortController();
    const sub = await asReader(`/api/realtime/items:${slug}/subscribe`, { signal: ac.signal });
    expect(sub.status).toBe(200);
    try {
      // Three writes. Only the last is both the reader's AND published, so only
      // it may appear — and it MUST appear, or the block would pass on a stream
      // that delivers nothing at all.
      //
      // A row on a versioned collection is born a draft; `_status` is not a
      // writable field, so publishing is its own endpoint. That second call is
      // what puts a `published` event on the channel.
      const create = async (title: string, owner: string): Promise<string> => {
        const res = await h.fetch(`/api/items/${slug}`, json("POST", { title, owner }));
        expect(res.status, `create ${title}`).toBe(201);
        return String(((await res.json()) as { data: { id: unknown } }).data.id);
      };
      const publish = async (id: string) => {
        const res = await h.fetch(`/api/items/${slug}/${id}/publish`, { method: "POST" });
        expect(res.status, `publish ${id}`).toBe(200);
      };

      await publish(await create("OTHER-PUBLISHED", "someone@else.test"));
      await create("MINE-DRAFT", readerEmail);
      await publish(await create("MINE-PUBLISHED", readerEmail));

      const seen = messages(await drain(sub, 600)).join("\n");
      expect(seen).toContain("MINE-PUBLISHED");
      expect(seen).not.toContain("MINE-DRAFT");
      expect(seen).not.toContain("OTHER-PUBLISHED");
    } finally {
      ac.abort();
    }
  });
});
