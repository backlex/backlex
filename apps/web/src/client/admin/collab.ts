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
 * Identity in received messages is server-stamped (session user), so peers
 * can't be spoofed by a crafted publish body.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CollabMessage, CollabTransportKind } from "@backlex/core";
import { auth } from "@/lib/auth";

export interface CollabPeer {
  id: string;
  /** Display handle (email) as stamped by the server; null when unknown. */
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
  const selfId =
    (session.data as { user?: { id?: string } } | null)?.user?.id ?? null;

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
    const base = `/api/realtime/${encodeURIComponent(channel)}`;
    let disposed = false;
    let es: EventSource | null = null;
    let pingTimer: ReturnType<typeof setInterval> | null = null;
    let sweepTimer: ReturnType<typeof setInterval> | null = null;

    const publish = (t: CollabMessage["t"], field?: string) => {
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
    };

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

    const onMessage = (ev: MessageEvent) => {
      let msg: CollabMessage;
      try {
        msg = JSON.parse(ev.data as string) as CollabMessage;
      } catch {
        return;
      }
      if (!msg || typeof msg !== "object" || !msg.user?.id || msg.user.id === selfId) return;
      const name = msg.user.name ?? null;
      switch (msg.t) {
        case "hello":
          upsert(msg.user.id, { name, field: msg.field ?? null });
          // Reply with a jittered ping so the newcomer sees us (and our held
          // field) immediately — this replaces any transport-level replay.
          setTimeout(() => {
            if (!disposed) publish("ping", myFieldRef.current ?? undefined);
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

    const sayBye = () => publish("bye");

    void collabTransport().then((kind) => {
      if (disposed || kind !== "native") return;
      try {
        es = new EventSource(`${base}/subscribe`, { withCredentials: true });
        es.addEventListener("message", onMessage);
      } catch {
        return; // EventSource unsupported — no collab
      }
      publishRef.current = publish;
      publish("hello");
      pingTimer = setInterval(() => publish("ping", myFieldRef.current ?? undefined), PING_MS);
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
      if (publishRef.current) sayBye();
      publishRef.current = null;
      es?.close();
    };
  }, [slug, itemId, selfId]);

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
