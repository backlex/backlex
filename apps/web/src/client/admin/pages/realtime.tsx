// Realtime page — collection-derived channels + permission-filtered SSE tail
import { useEffect, useState } from "react";
import { I } from "../icons";
import { Badge, Button, PageHeader } from "../ui";
import { RealtimeTail, type RealtimeEvent } from "../extras";

export function RealtimePage({ events, active, onActiveChange, pushToast }: { events: RealtimeEvent[]; active: string; onActiveChange: (name: string) => void; pushToast: (m: string) => void }) {
  // Channels are derived from real collections — `items:<slug>` per
  // collection plus the system `collections` channel. Subscriber counts
  // aren't exposed by the API yet so we hide that column rather than
  // showing fabricated numbers.
  type Channel = { name: string; subs: number | null; filter: string };
  const [channels, setChannels] = useState<Channel[]>([{ name: "collections", subs: null, filter: "admin role only" }]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch("/api/collections", { credentials: "include" });
        if (!r.ok || cancelled) return;
        const j = (await r.json()) as { data?: { slug: string; ownerScoped?: boolean }[] };
        const slugs = j.data ?? [];
        const built: Channel[] = slugs.map((c) => ({
          name: `items:${c.slug}`,
          subs: null,
          filter: c.ownerScoped ? "owner_id _eq $user.id" : "permission · read",
        }));
        // Always include the system `collections` channel (admin-only schema events).
        built.push({ name: "collections", subs: null, filter: "admin role only" });
        if (!cancelled) setChannels(built);
      } catch {
        // keep default
      }
    })();
    return () => { cancelled = true; };
  }, []);
  // Lock onto the first channel once derived if the parent's selection no
  // longer matches any known channel.
  useEffect(() => {
    if (channels.length === 0) return;
    if (!channels.some((c) => c.name === active)) onActiveChange(channels[0]!.name);
  }, [channels, active, onActiveChange]);
  const setActive = onActiveChange;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <PageHeader
        title="Realtime"
        description="In-process pub/sub on Bun, Durable Objects on Workers. Permission filter applies on subscribe + publish."
        actions={<Button variant="outline" icon={I.Refresh} onClick={() => pushToast("Channels refreshed.")}>Refresh</Button>}
      />
      <div className="master-detail" style={{ "--md-aside": "300px" } as React.CSSProperties}>
        <div className="card">
          {channels.length === 0 && (
            <div className="muted" style={{ padding: "16px 12px", fontSize: 12 }}>No channels — create a collection to get one.</div>
          )}
          {channels.map((c) => (
            <div key={c.name} onClick={() => setActive(c.name)} className="schema-row" style={{ gridTemplateColumns: "20px 1fr auto", cursor: "pointer", background: active === c.name ? "var(--accent)" : "transparent" }}>
              <span><span className="dot" /></span>
              <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                <span className="font-mono" style={{ fontSize: 12.5 }}>{c.name}</span>
                <span className="muted" style={{ fontSize: 11 }}>{c.filter}</span>
              </div>
              {c.subs != null && <Badge variant="outline" mono>{c.subs} sub</Badge>}
            </div>
          ))}
        </div>

        <RealtimeTail events={events} channel={active} connected />
      </div>
    </div>
  );
}
