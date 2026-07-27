/**
 * @module
 *
 * Signal-plane transport for `items:*` events — the realtime path on stateless
 * serverless deployments (Vercel / Netlify Functions), where there is no
 * Durable Object and no long-lived process to hold an SSE stream open.
 *
 * The server publishes ID-ONLY signals (`{event, collection, id, at}`) to Ably;
 * the browser is connected to Ably directly, so delivery costs the deployment
 * zero function invocations. This module turns those signals back into the
 * ordinary `ItemEvent`s the rest of the SDK already consumes:
 *
 *   signal in  →  coalesce a burst  →  ONE `list({ id: { _in: [...] } })`
 *              →  emit `{event, transition, data: row}` per row
 *
 * The read-back is the point. A signal carries no row data, so nothing about a
 * row can leak through the pipe; the client fetches it through the normal REST
 * read path where the permission gate, row conditions and the field allow-list
 * all still apply. A row the caller may not read simply doesn't come back — and
 * an absent id is reported as a removal, which is exactly right: from this
 * caller's point of view, the row is gone.
 *
 * Passing the subscription's own `filter` into that read-back gives the same
 * membership answers the SSE plane computes server-side (reactive Stage 2): a
 * row that no longer matches doesn't come back either, so it's emitted as a
 * `leave` and `liveQuery` drops it — including for `$now` / `$user` filters the
 * client can't evaluate itself.
 *
 * What this plane does NOT reproduce: `Last-Event-ID` gap replay. Ably's own
 * connection recovery covers short drops; a longer outage is healed by the fact
 * that every consumer here re-reads from the server (`liveQuery` refetches on
 * reconnect), never by replaying a log.
 */
import type { Condition } from "./condition";
import type { ItemEvent } from "./types";

/** What `GET /api/realtime/items-config` reports. `sse` = the held `items:*`
 *  stream; `ably-signal` = this module's plane; `off` = no viable transport. */
export type ItemsTransportKind = "sse" | "ably-signal" | "off";

/** The wire payload on `signal:items:<slug>` — mirrors `ItemSignal` in
 *  `@backlex/core`, redeclared here so the SDK stays dependency-free. */
export interface ItemSignal {
  event: "created" | "updated" | "deleted";
  collection: string;
  id: string;
  at: number;
}

/** Message name every signal is published under. */
const SIGNAL_MESSAGE_NAME = "signal";
/** `signal:items:<slug>` for a collection. */
export const signalChannel = (slug: string): string => `signal:items:${slug}`;

/** How long to gather signals before one batched read-back. A bulk write fires
 *  one signal per row; without this window a 100-row insert would mean 100 REST
 *  round-trips. Short enough to stay imperceptible. */
const COALESCE_MS = 60;

// ── Connection hub ──────────────────────────────────────────────────────────
//
// One Ably connection per backlex client, shared by every subscription. When a
// new channel is needed the token is re-minted for the WIDENED set and the
// connection re-authorized before subscribing, so capability always covers what
// we're about to listen to. Attach/detach are serialized on a promise chain —
// two live queries starting in the same tick must not race the re-auth.

type SignalHandler = (signal: ItemSignal) => void;

/** Minimal structural view of the bits of `ably` we use, so the SDK doesn't
 *  take a type dependency on a package consumers may not have installed. */
interface AblyLike {
  auth: { authorize: () => Promise<unknown> };
  channels: {
    get: (name: string) => {
      subscribe: (name: string, cb: (msg: { data?: unknown }) => void) => Promise<unknown>;
      unsubscribe: () => void;
      detach: () => Promise<unknown>;
    };
  };
  close: () => void;
}

export interface SignalHubDeps {
  /** Mint a signed Ably TokenRequest covering `channels`
   *  (`POST /api/realtime/ably-token`). */
  token: (channels: string[]) => Promise<unknown>;
}

export interface SignalHub {
  attach: (channel: string, handler: SignalHandler) => Promise<() => void>;
}

export const createSignalHub = (deps: SignalHubDeps): SignalHub => {
  let client: AblyLike | null = null;
  const wanted = new Set<string>();
  const handlers = new Map<string, Set<SignalHandler>>();
  const channels = new Map<string, ReturnType<AblyLike["channels"]["get"]>>();
  // Serializes attach/detach so a re-auth can't interleave with a subscribe.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.then(fn, fn);
    // Keep the chain alive after a rejection so one failed attach doesn't wedge
    // every later one.
    queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const ensureClient = async (): Promise<AblyLike> => {
    if (client) return client;
    // Non-literal specifier on purpose: `ably` is an OPTIONAL peer dependency
    // (the SDK is otherwise dependency-free, and only signal-plane deployments
    // need it). A literal `import("ably")` would make every bundler try to
    // resolve it at build time and fail for the majority who never install it.
    const specifier = "ably";
    const Ably = (await import(/* @vite-ignore */ specifier)) as unknown as {
      Realtime: new (o: unknown) => AblyLike;
    };
    client = new Ably.Realtime({
      authCallback: (_params: unknown, cb: (err: unknown, token: unknown) => void) => {
        deps
          .token([...wanted])
          .then((t) => cb(null, t))
          .catch((e: unknown) => cb(e instanceof Error ? e.message : String(e), null));
      },
      closeOnUnload: true,
    });
    return client;
  };

  const teardown = () => {
    if (!client) return;
    client.close();
    client = null;
    channels.clear();
  };

  const attach = (channel: string, handler: SignalHandler): Promise<() => void> =>
    serial(async () => {
      let set = handlers.get(channel);
      if (!set) {
        set = new Set();
        handlers.set(channel, set);
      }
      set.add(handler);

      if (!channels.has(channel)) {
        const fresh = client === null;
        wanted.add(channel);
        const c = await ensureClient();
        // An existing connection holds a token scoped to the OLD channel set —
        // widen it before subscribing, or Ably refuses with 40160.
        if (!fresh) await c.auth.authorize();
        const ch = c.channels.get(channel);
        await ch.subscribe(SIGNAL_MESSAGE_NAME, (msg) => {
          const data = msg.data as ItemSignal | undefined;
          if (!data || typeof data !== "object" || typeof data.id !== "string") return;
          for (const h of handlers.get(channel) ?? []) {
            try {
              h(data);
            } catch {
              // one bad consumer must not stop the others
            }
          }
        });
        channels.set(channel, ch);
      }

      let released = false;
      return () => {
        if (released) return;
        released = true;
        void serial(async () => {
          const live = handlers.get(channel);
          live?.delete(handler);
          if (live && live.size > 0) return;
          handlers.delete(channel);
          wanted.delete(channel);
          const ch = channels.get(channel);
          channels.delete(channel);
          if (ch) {
            ch.unsubscribe();
            await ch.detach().catch(() => {
              // already gone — nothing to clean up
            });
          }
          // Last subscription closed: drop the connection so an idle tab stops
          // counting against the deployment's Ably connection budget.
          if (channels.size === 0) teardown();
        });
      };
    });

  return { attach };
};

// ── Signal → ItemEvent hydration ────────────────────────────────────────────

export interface SignalSubscriptionDeps<T> {
  /** Read rows back by id through the permission-filtered REST path. MUST
   *  apply the subscription's own filter too, so an id that's missing from the
   *  response means "not visible OR no longer a match" — both of which the
   *  caller should treat as a removal. */
  fetchByIds: (ids: string[]) => Promise<T[]>;
}

/**
 * Turn a stream of signals into `ItemEvent`s. Exported (and dependency-injected)
 * so the batching + membership rules are unit-testable without Ably.
 *
 * Returns the `push` a transport feeds signals into, plus `flush` for tests and
 * `close` to stop a pending batch from emitting after teardown.
 */
export const createSignalHydrator = <T extends Record<string, unknown>>(
  deps: SignalSubscriptionDeps<T>,
  onEvent: (e: ItemEvent<T>) => void,
  onError?: (err: unknown) => void,
): { push: (s: ItemSignal) => void; flush: () => Promise<void>; close: () => void } => {
  // Insertion-ordered, last-write-wins per id: a burst that creates then
  // immediately updates a row needs one read-back, not two.
  let batch = new Map<string, ItemSignal>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const flush = async (): Promise<void> => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (batch.size === 0 || closed) return;
    const pending = [...batch.values()];
    batch = new Map();

    const needRead = pending.filter((s) => s.event !== "deleted").map((s) => s.id);
    let byId = new Map<string, T>();
    if (needRead.length > 0) {
      try {
        const rows = await deps.fetchByIds(needRead);
        byId = new Map(
          rows.map((r) => [String((r as Record<string, unknown>).id), r] as const),
        );
      } catch (e) {
        // The read-back failed (offline, 5xx). Report it and drop the batch
        // rather than guess: emitting removals here would wipe rows that are
        // very much still there.
        onError?.(e);
        return;
      }
    }
    if (closed) return;

    for (const signal of pending) {
      const row = byId.get(signal.id);
      if (row) {
        // Only `created` / `updated` are ever read back, so the row branch
        // maps straight onto the enter/update transitions.
        onEvent({
          event: signal.event,
          transition: signal.event === "created" ? "enter" : "update",
          data: row,
        });
        continue;
      }
      // No row came back. For a `created` signal that just means the row isn't
      // visible to this caller (or doesn't match its filter) — it was never in
      // the result set, so there is nothing to report. For anything else the
      // caller may be holding the row: tell it to drop it.
      if (signal.event === "created") continue;
      onEvent({
        event: "deleted",
        transition: "leave",
        data: { id: signal.id } as unknown as T,
      });
    }
  };

  return {
    push: (s) => {
      if (closed) return;
      batch.delete(s.id);
      batch.set(s.id, s);
      timer ??= setTimeout(() => {
        timer = null;
        void flush();
      }, COALESCE_MS);
    },
    flush,
    close: () => {
      closed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      batch = new Map();
    },
  };
};

/** Narrow a subscription's filter to the ids a batch needs, without letting the
 *  ids widen what the filter allows. */
export const idBatchFilter = (
  filter: Condition | null,
  ids: string[],
): Condition => {
  const byId = { id: { _in: ids } } as unknown as Condition;
  return filter ? ({ $and: [filter, byId] } as unknown as Condition) : byId;
};
