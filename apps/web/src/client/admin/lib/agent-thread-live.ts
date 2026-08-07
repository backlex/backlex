/**
 * Live wire for a team agent thread — `agent:thread:<threadId>`.
 *
 * An agent thread is workspace-wide: any admin can open it, so several people
 * can be watching (and asking) at once. This hook keeps one SSE subscription
 * open for as long as a thread is on screen and hands every frame to the page,
 * which is how a teammate's question, the tool steps, and the final answer show
 * up for everyone rather than only for whoever pressed Send.
 *
 * It also carries the thread's presence roster on the same channel, using the
 * same stateless protocol as record collab (see `collab.ts`): `hello` on join,
 * `ping` every 15s, `typing` while composing, `bye` on leave, with a 45s TTL
 * sweep client-side. The server validates that envelope and stamps identity, so
 * a member can neither impersonate a teammate nor forge a turn event.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { collabColor, collabHandle } from "./collab";

/** Server-emitted turn events plus the client presence frame, as they arrive. */
export interface AgentThreadEvent {
  event: string;
  data: any;
}

export interface AgentPeer {
  id: string;
  /** Display handle (email local-part), or a short id when unknown. */
  name: string;
  color: string;
  typing: boolean;
}

const PING_MS = 15_000;
const SWEEP_MS = 5_000;
const PEER_TTL_MS = 45_000;
/** How long a `typing` frame keeps the indicator lit without a refresh. */
const TYPING_TTL_MS = 6_000;
/** Floor between outbound typing frames — one per keystroke would be silly. */
const TYPING_THROTTLE_MS = 3_000;

interface PeerState {
  name: string | null;
  /** Local-clock receive times, so client/server clock skew can't reap a live
   *  peer or leave a dead one lit. */
  lastSeen: number;
  typingAt: number;
}

const publish = (channel: string, t: "hello" | "ping" | "typing" | "bye"): void => {
  void fetch(`/api/realtime/${encodeURIComponent(channel)}/publish`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ t }),
    keepalive: t === "bye",
  }).catch(() => {
    /* presence is best-effort — a dropped frame just ages out */
  });
};

/**
 * Subscribe to a thread's live channel.
 *
 * @param threadId  open thread, or null when the composer is on a fresh one
 * @param meId      current user id — own presence frames are filtered out
 * @param onEvent   called for every turn event (`agent.message` / `.start` /
 *                  `.step` / `.final` / `.error`); presence is handled here
 */
export function useAgentThreadLive(
  threadId: string | null,
  meId: string | null,
  onEvent: (e: AgentThreadEvent) => void,
): { peers: AgentPeer[]; notifyTyping: () => void } {
  const [peerMap, setPeerMap] = useState<Record<string, PeerState>>({});
  // Keep the callback in a ref: the page rebuilds it every render, and
  // resubscribing on each keystroke would tear the stream down constantly.
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const lastTypingRef = useRef(0);
  const channel = threadId ? `agent:thread:${threadId}` : null;

  useEffect(() => {
    if (!channel) {
      setPeerMap({});
      return;
    }
    let es: EventSource | null = null;
    try {
      es = new EventSource(`/api/realtime/${encodeURIComponent(channel)}/subscribe`, {
        withCredentials: true,
      });
    } catch {
      return; // no EventSource — the page still works, just without live sync
    }
    es.addEventListener("message", (ev) => {
      let parsed: AgentThreadEvent;
      try {
        parsed = JSON.parse((ev as MessageEvent).data as string) as AgentThreadEvent;
      } catch {
        return; // heartbeat / non-JSON frame
      }
      if (parsed.event === "agent.presence") {
        const { t, user } = (parsed.data ?? {}) as {
          t?: string;
          user?: { id?: string; name?: string | null };
        };
        const id = user?.id;
        if (!id || id === meId) return;
        if (t === "bye") {
          setPeerMap((prev) => {
            if (!prev[id]) return prev;
            const next = { ...prev };
            delete next[id];
            return next;
          });
          return;
        }
        const now = Date.now();
        setPeerMap((prev) => ({
          ...prev,
          [id]: {
            name: user?.name ?? prev[id]?.name ?? null,
            lastSeen: now,
            typingAt: t === "typing" ? now : (prev[id]?.typingAt ?? 0),
          },
        }));
        // Answer a newcomer's hello so they see us within ~half a second
        // instead of waiting out a full heartbeat.
        if (t === "hello") setTimeout(() => publish(channel, "ping"), Math.random() * 500);
        return;
      }
      onEventRef.current(parsed);
    });

    publish(channel, "hello");
    const ping = setInterval(() => publish(channel, "ping"), PING_MS);
    const sweep = setInterval(() => {
      const cutoff = Date.now() - PEER_TTL_MS;
      setPeerMap((prev) => {
        const next: Record<string, PeerState> = {};
        let changed = false;
        for (const [id, p] of Object.entries(prev)) {
          if (p.lastSeen >= cutoff) next[id] = p;
          else changed = true;
        }
        // Re-render while a typing flag decays, even with no membership change.
        return changed || Object.values(prev).some((p) => p.typingAt > 0) ? next : prev;
      });
    }, SWEEP_MS);

    return () => {
      clearInterval(ping);
      clearInterval(sweep);
      es?.close();
      publish(channel, "bye");
      setPeerMap({});
    };
  }, [channel, meId]);

  const notifyTyping = useCallback(() => {
    if (!channel) return;
    const now = Date.now();
    if (now - lastTypingRef.current < TYPING_THROTTLE_MS) return;
    lastTypingRef.current = now;
    publish(channel, "typing");
  }, [channel]);

  const peers = useMemo(() => {
    const now = Date.now();
    return Object.entries(peerMap)
      .map(([id, p]) => ({
        id,
        name: collabHandle({ id, name: p.name }),
        color: collabColor(id),
        typing: now - p.typingAt < TYPING_TTL_MS,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [peerMap]);

  return { peers, notifyTyping };
}
