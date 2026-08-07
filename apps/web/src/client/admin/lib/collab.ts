/**
 * Live collaboration client — presence and field awareness over ONE channel
 * per collection: `collab:list:<slug>`.
 *
 * Protocol (stateless, transport-agnostic): every editor announces itself
 * with `hello` on join, heartbeats with `ping` every 15s (carrying its record
 * id + focused field), claims/releases fields with `focus`/`blur`, and says
 * `bye` on leave. Every editor message carries `item` (the record id) so the
 * record editor's roster filters on it and the list view groups rows by it.
 * The roster is derived client-side from that stream with a 45s TTL sweep —
 * no server-side membership exists. On receiving another member's `hello`
 * (an editor's, or an OBSERVER hello from a list view — no `item`), each
 * editor replies with a jittered `ping` so newcomers build state within
 * ~half a second instead of waiting a full heartbeat cycle. Observers never
 * publish beyond that single hello, so an open table costs nothing recurring.
 *
 * Two pipes, one protocol. `GET /api/realtime/collab-config` picks the pipe:
 *  - `native` — SSE subscribe + REST publish through the backlex API; identity
 *    is stamped server-side, so peers can't be spoofed.
 *  - `ably` — the browser connects to Ably directly with a server-minted,
 *    channel-scoped TokenRequest (`POST /api/realtime/collab-token`). Ably
 *    pins the connection to the session user's `clientId`, and receivers trust
 *    that verified `clientId` over anything in the message body — only the
 *    display name is self-reported there. One channel per collection also
 *    means the token stays valid while navigating between records.
 *  - `off` — no viable transport; the hooks stay inert and the UI shows no
 *    collab affordances.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CollabMessage, CollabTransportKind } from "@backlex/core";
import { auth } from "@/lib/auth";

export interface CollabPeer {
  id: string;
  /** Display handle (email); null when unknown. */
  name: string | null;
  /** Field the peer currently holds focus on, or null. */
  field: string | null;
  /** UI color derived deterministically from the peer's user id. */
  color: string;
}

interface PeerState {
  name: string | null;
  field: string | null;
  /** Local-clock receive time — TTL sweeps compare against Date.now() here,
   *  not the server `at`, so client/server clock skew can't reap live peers. */
  lastSeen: number;
}

const PING_MS = 15_000;
const SWEEP_MS = 5_000;
const PEER_TTL_MS = 45_000;

/** Fixed 8-color palette — hues that stay legible on both themes. A user maps
 *  to the same color everywhere (avatar, field ring, badge). */
const COLLAB_COLORS = [
  "#0ea5e9", // sky
  "#8b5cf6", // violet
  "#f59e0b", // amber
  "#10b981", // emerald
  "#ef4444", // red
  "#ec4899", // pink
  "#14b8a6", // teal
  "#6366f1", // indigo
] as const;

export const collabColor = (userId: string): string => {
  let h = 0;
  for (let i = 0; i < userId.length; i++) h = (h * 31 + userId.charCodeAt(i)) >>> 0;
  return COLLAB_COLORS[h % COLLAB_COLORS.length]!;
};

/** Short human handle for a peer: the local part of the email. */
export const collabHandle = (peer: { name: string | null; id: string }): string => {
  if (peer.name) {
    const at = peer.name.indexOf("@");
    return at > 0 ? peer.name.slice(0, at) : peer.name;
  }
  return peer.id.slice(0, 6);
};

/** One capability probe per SPA session — the answer is deployment-static. */
let transportPromise: Promise<CollabTransportKind> | null = null;
const collabTransport = (): Promise<CollabTransportKind> => {
  transportPromise ??= fetch("/api/realtime/collab-config", { credentials: "include" })
    .then((r) => (r.ok ? r.json() : { transport: "off" }))
    .then((j: { transport?: CollabTransportKind }) => j.transport ?? "off")
    .catch(() => "off" as const);
  return transportPromise;
};

/** Body of an outbound frame — record id + focused field, both optional. */
interface CollabBody {
  item?: string;
  field?: string;
}

/** A connected send/receive channel — same protocol either way. */
interface CollabPipe {
  publish: (t: CollabMessage["t"], body?: CollabBody) => void;
  close: () => void;
}

/** Native pipe: EventSource subscribe + REST publish. The server validates the
 *  body and stamps identity from the session. */
const openNativePipe = (
  channel: string,
  onMessage: (msg: CollabMessage) => void,
): CollabPipe | null => {
  const base = `/api/realtime/${encodeURIComponent(channel)}`;
  let es: EventSource;
  try {
    es = new EventSource(`${base}/subscribe`, { withCredentials: true });
  } catch {
    return null; // EventSource unsupported — no collab
  }
  es.addEventListener("message", (ev) => {
    try {
      onMessage(JSON.parse((ev as MessageEvent).data as string) as CollabMessage);
    } catch {
      // malformed frame — skip
    }
  });
  return {
    publish: (t, body) => {
      void fetch(`${base}/publish`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          t,
          ...(body?.item ? { item: body.item } : {}),
          ...(body?.field ? { field: body.field } : {}),
        }),
        // `bye` fires during teardown/unload — keepalive lets it outlive the page.
        keepalive: t === "bye",
      }).catch(() => {
        // best-effort — a dropped awareness frame self-heals on the next ping
      });
    },
    close: () => es.close(),
  };
};

/** Ably pipe: direct browser↔Ably connection, token-authed per channel. The
 *  `ably` bundle loads lazily so native deployments never pay for it. */
const openAblyPipe = async (
  channel: string,
  self: { id: string; name: string | null },
  onMessage: (msg: CollabMessage) => void,
): Promise<CollabPipe | null> => {
  try {
    const Ably = await import("ably");
    const client = new Ably.Realtime({
      authCallback: (_params, cb) => {
        fetch("/api/realtime/collab-token", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ channels: [channel] }),
        })
          .then(async (r) => {
            if (!r.ok) throw new Error(`collab-token ${r.status}`);
            const j = (await r.json()) as { tokenRequest: object };
            cb(null, j.tokenRequest as never);
          })
          .catch((e: unknown) => cb(e instanceof Error ? e.message : String(e), null));
      },
      // We filter self by user id anyway; skipping the echo saves messages.
      echoMessages: false,
      closeOnUnload: true,
    });
    const ch = client.channels.get(channel);
    await ch.subscribe("collab", (msg) => {
      const data = (msg.data ?? {}) as CollabMessage;
      // Ably verified the publisher's clientId against its token — trust it
      // over the self-reported body. Only the display name stays client-set.
      if (msg.clientId) {
        data.user = { id: msg.clientId, name: data.user?.name ?? null };
      }
      onMessage(data);
    });
    return {
      publish: (t, body) => {
        void ch
          .publish("collab", {
            t,
            ...(body?.item ? { item: body.item } : {}),
            ...(body?.field ? { field: body.field } : {}),
            user: self,
            at: Date.now(),
          })
          .catch(() => {
            // best-effort — self-heals on the next ping
          });
      },
      close: () => client.close(),
    };
  } catch {
    return null; // ably failed to load/connect — degrade to no collab
  }
};

/** Resolve the transport and open the matching pipe for a collection channel. */
const openCollabPipe = async (
  channel: string,
  self: { id: string; name: string | null },
  onMessage: (msg: CollabMessage) => void,
): Promise<CollabPipe | null> => {
  const kind = await collabTransport();
  if (kind === "off") return null;
  return kind === "ably"
    ? openAblyPipe(channel, self, onMessage)
    : openNativePipe(channel, onMessage);
};

export interface UseCollabResult {
  /** Other members on this record (self excluded), stable-sorted. */
  peers: CollabPeer[];
  /** Peers keyed by the field they hold — drives the field awareness rings. */
  peersByField: Record<string, CollabPeer[]>;
  onFieldFocus: (field: string) => void;
  onFieldBlur: (field: string) => void;
}

export function useCollab(slug: string | null, itemId: string): UseCollabResult {
  const session = auth.useSession();
  const sessionUser =
    (session.data as { user?: { id?: string; email?: string | null } } | null)?.user ?? null;
  const selfId = sessionUser?.id ?? null;
  const selfEmail = sessionUser?.email ?? null;

  const [peerMap, setPeerMap] = useState<Record<string, PeerState>>({});
  const myFieldRef = useRef<string | null>(null);
  // Publish is bound per-channel inside the effect; the focus/blur callbacks
  // reach it through this ref so their identity stays stable across renders.
  const publishRef = useRef<((t: CollabMessage["t"], field?: string) => void) | null>(null);

  useEffect(() => {
    setPeerMap({});
    myFieldRef.current = null;
    publishRef.current = null;
    if (!slug || itemId === "new" || !selfId) return;

    const channel = `collab:list:${slug}`;
    let disposed = false;
    let pipe: CollabPipe | null = null;
    let pingTimer: ReturnType<typeof setInterval> | null = null;
    let sweepTimer: ReturnType<typeof setInterval> | null = null;

    const upsert = (id: string, patch: Partial<PeerState> & { name: string | null }) => {
      setPeerMap((prev) => ({
        ...prev,
        [id]: {
          field: patch.field !== undefined ? patch.field : (prev[id]?.field ?? null),
          name: patch.name ?? prev[id]?.name ?? null,
          lastSeen: Date.now(),
        },
      }));
    };

    // The channel is collection-wide: only messages for THIS record join the
    // roster. Any hello (another editor's, or an observer hello from a list
    // view) still gets a jittered ping reply so newcomers learn our state.
    const onMessage = (msg: CollabMessage) => {
      if (!msg || typeof msg !== "object" || !msg.user?.id || msg.user.id === selfId) return;
      if (msg.t === "hello") {
        setTimeout(() => {
          if (!disposed)
            pipe?.publish("ping", { item: itemId, field: myFieldRef.current ?? undefined });
        }, 100 + Math.random() * 400);
      }
      if (msg.item !== itemId) return;
      const name = msg.user.name ?? null;
      switch (msg.t) {
        case "hello":
        case "ping":
        case "focus":
          upsert(msg.user.id, { name, field: msg.field ?? null });
          break;
        case "blur":
          upsert(msg.user.id, { name, field: null });
          break;
        case "bye":
          setPeerMap((prev) => {
            if (!(msg.user.id in prev)) return prev;
            const next = { ...prev };
            delete next[msg.user.id];
            return next;
          });
          break;
      }
    };

    const sayBye = () => pipe?.publish("bye", { item: itemId });

    void openCollabPipe(channel, { id: selfId, name: selfEmail }, onMessage).then((opened) => {
      if (!opened) return;
      if (disposed) {
        opened.close();
        return;
      }
      pipe = opened;
      publishRef.current = (t, field) => pipe?.publish(t, { item: itemId, field });
      pipe.publish("hello", { item: itemId });
      pingTimer = setInterval(
        () => pipe?.publish("ping", { item: itemId, field: myFieldRef.current ?? undefined }),
        PING_MS,
      );
      sweepTimer = setInterval(() => {
        const cutoff = Date.now() - PEER_TTL_MS;
        setPeerMap((prev) => {
          const stale = Object.entries(prev).filter(([, p]) => p.lastSeen < cutoff);
          if (stale.length === 0) return prev;
          const next = { ...prev };
          for (const [id] of stale) delete next[id];
          return next;
        });
      }, SWEEP_MS);
      window.addEventListener("pagehide", sayBye);
    });

    return () => {
      disposed = true;
      if (pingTimer) clearInterval(pingTimer);
      if (sweepTimer) clearInterval(sweepTimer);
      window.removeEventListener("pagehide", sayBye);
      sayBye();
      publishRef.current = null;
      pipe?.close();
      pipe = null;
    };
  }, [slug, itemId, selfId, selfEmail]);

  const onFieldFocus = useCallback((field: string) => {
    if (myFieldRef.current === field) return;
    myFieldRef.current = field;
    publishRef.current?.("focus", field);
  }, []);

  const onFieldBlur = useCallback((field: string) => {
    if (myFieldRef.current !== field) return;
    myFieldRef.current = null;
    publishRef.current?.("blur");
  }, []);

  const peers = useMemo<CollabPeer[]>(
    () =>
      Object.entries(peerMap)
        .map(([id, p]) => ({ id, name: p.name, field: p.field, color: collabColor(id) }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    [peerMap],
  );

  const peersByField = useMemo<Record<string, CollabPeer[]>>(() => {
    const out: Record<string, CollabPeer[]> = {};
    for (const p of peers) {
      if (!p.field) continue;
      (out[p.field] ??= []).push(p);
    }
    return out;
  }, [peers]);

  return { peers, peersByField, onFieldFocus, onFieldBlur };
}

export interface UseListCollabResult {
  /** Editors currently on records of this collection, grouped by record id
   *  (self excluded, stable-sorted). Rows with nobody present are absent. */
  byItem: Record<string, CollabPeer[]>;
  /** False until the transport probe answers with a viable pipe — lets the
   *  table skip rendering the presence column entirely on `off` deployments. */
  active: boolean;
}

/**
 * Collection-wide presence for the items LIST view — who is on which record,
 * without opening it. Subscribes to the same `collab:list:<slug>` channel the
 * editors publish on, announces itself once with an OBSERVER hello (no `item`,
 * so editors reply with their state but never roster the observer), and from
 * then on only listens. An open table therefore costs one subscription and a
 * single message — no heartbeat.
 */
export function useListCollab(slug: string | null): UseListCollabResult {
  const session = auth.useSession();
  const sessionUser =
    (session.data as { user?: { id?: string; email?: string | null } } | null)?.user ?? null;
  const selfId = sessionUser?.id ?? null;
  const selfEmail = sessionUser?.email ?? null;

  // Peers keyed by `userId:itemId` — one editor can hold two records in two
  // tabs, and moving between records resolves via bye + TTL.
  const [peerMap, setPeerMap] = useState<Record<string, PeerState & { item: string }>>({});
  const [active, setActive] = useState(false);

  useEffect(() => {
    setPeerMap({});
    if (!slug || !selfId) return;

    const channel = `collab:list:${slug}`;
    let disposed = false;
    let pipe: CollabPipe | null = null;
    let sweepTimer: ReturnType<typeof setInterval> | null = null;

    const onMessage = (msg: CollabMessage) => {
      if (!msg || typeof msg !== "object" || !msg.user?.id || msg.user.id === selfId) return;
      // Observer hellos (no item) and anything malformed carry no row info.
      if (!msg.item) return;
      const key = `${msg.user.id}:${msg.item}`;
      if (msg.t === "bye") {
        setPeerMap((prev) => {
          if (!(key in prev)) return prev;
          const next = { ...prev };
          delete next[key];
          return next;
        });
        return;
      }
      const name = msg.user.name ?? null;
      setPeerMap((prev) => ({
        ...prev,
        [key]: {
          item: msg.item!,
          field:
            msg.t === "blur" ? null : msg.field !== undefined ? msg.field : (prev[key]?.field ?? null),
          name: name ?? prev[key]?.name ?? null,
          lastSeen: Date.now(),
        },
      }));
    };

    void openCollabPipe(channel, { id: selfId, name: selfEmail }, onMessage).then((opened) => {
      if (!opened) return;
      if (disposed) {
        opened.close();
        return;
      }
      pipe = opened;
      setActive(true);
      // Observer hello: editors reply with a jittered ping, so the table
      // fills within ~half a second instead of waiting a heartbeat cycle.
      pipe.publish("hello");
      sweepTimer = setInterval(() => {
        const cutoff = Date.now() - PEER_TTL_MS;
        setPeerMap((prev) => {
          const stale = Object.entries(prev).filter(([, p]) => p.lastSeen < cutoff);
          if (stale.length === 0) return prev;
          const next = { ...prev };
          for (const [id] of stale) delete next[id];
          return next;
        });
      }, SWEEP_MS);
    });

    return () => {
      disposed = true;
      if (sweepTimer) clearInterval(sweepTimer);
      pipe?.close();
      pipe = null;
    };
  }, [slug, selfId, selfEmail]);

  const byItem = useMemo<Record<string, CollabPeer[]>>(() => {
    const out: Record<string, CollabPeer[]> = {};
    for (const [key, p] of Object.entries(peerMap)) {
      const userId = key.slice(0, key.length - p.item.length - 1);
      (out[p.item] ??= []).push({
        id: userId,
        name: p.name,
        field: p.field,
        color: collabColor(userId),
      });
    }
    for (const list of Object.values(out)) list.sort((a, b) => a.id.localeCompare(b.id));
    return out;
  }, [peerMap]);

  return { byItem, active };
}
