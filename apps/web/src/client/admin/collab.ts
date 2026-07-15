/**
 * Live collaboration client for the item editor — record-level presence and
 * field awareness over the `collab:item:<slug>:<id>` channel.
 *
 * Protocol (stateless, transport-agnostic): every member announces itself
 * with `hello` on join, heartbeats with `ping` every 15s (carrying its focused
 * field), claims/releases fields with `focus`/`blur`, and says `bye` on leave.
 * The roster is derived client-side from that stream with a 45s TTL sweep —
 * no server-side membership exists. On receiving another member's `hello`,
 * each member replies with a jittered `ping` so newcomers build the roster
 * within ~half a second instead of waiting a full heartbeat cycle.
 *
 * Two pipes, one protocol. `GET /api/realtime/collab-config` picks the pipe:
 *  - `native` — SSE subscribe + REST publish through the backlex API; identity
 *    is stamped server-side, so peers can't be spoofed.
 *  - `ably` — the browser connects to Ably directly with a server-minted,
 *    channel-scoped TokenRequest (`POST /api/realtime/collab-token`). Ably
 *    pins the connection to the session user's `clientId`, and receivers trust
 *    that verified `clientId` over anything in the message body — only the
 *    display name is self-reported there.
 *  - `off` — no viable transport; the hook stays inert and the UI shows no
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

/** A connected send/receive channel — same protocol either way. */
interface CollabPipe {
  publish: (t: CollabMessage["t"], field?: string) => void;
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
    publish: (t, field) => {
      void fetch(`${base}/publish`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(field ? { t, field } : { t }),
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
      publish: (t, field) => {
        void ch
          .publish("collab", {
            t,
            ...(field ? { field } : {}),
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

    const channel = `collab:item:${slug}:${itemId}`;
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

    const onMessage = (msg: CollabMessage) => {
      if (!msg || typeof msg !== "object" || !msg.user?.id || msg.user.id === selfId) return;
      const name = msg.user.name ?? null;
      switch (msg.t) {
        case "hello":
          upsert(msg.user.id, { name, field: msg.field ?? null });
          // Reply with a jittered ping so the newcomer sees us (and our held
          // field) immediately — this replaces any transport-level replay.
          setTimeout(() => {
            if (!disposed) pipe?.publish("ping", myFieldRef.current ?? undefined);
          }, 100 + Math.random() * 400);
          break;
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

    const sayBye = () => pipe?.publish("bye");

    void collabTransport().then(async (kind) => {
      if (disposed || kind === "off") return;
      const opened =
        kind === "ably"
          ? await openAblyPipe(channel, { id: selfId, name: selfEmail }, onMessage)
          : openNativePipe(channel, onMessage);
      if (!opened) return;
      if (disposed) {
        opened.close();
        return;
      }
      pipe = opened;
      publishRef.current = (t, field) => pipe?.publish(t, field);
      pipe.publish("hello");
      pingTimer = setInterval(() => pipe?.publish("ping", myFieldRef.current ?? undefined), PING_MS);
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
