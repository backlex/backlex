// Realtime page — collection-derived channels + permission-filtered SSE tail
import { useEffect, useState } from "react";
import { I } from "../icons";
import { Badge, Button, PageHeader } from "../ui";
import { RealtimeTail, type RealtimeEvent } from "../extras";
import { RealtimeSkeleton } from "../page-skeletons";

export function RealtimePage({ events, active, onActiveChange, pushToast }: { events: RealtimeEvent[]; active: string; onActiveChange: (name: string) => void; pushToast: (m: string) => void }) {
  // Channels are derived from real collections — `items:<slug>` per
  // collection plus the system `collections` channel. Subscriber counts
  // aren't exposed by the API yet so we hide that column rather than
  // showing fabricated numbers.
  type Channel = { name: string; subs: number | null; filter: string };
  const [channels, setChannels] = useState<Channel[]>([{ name: "collections", subs: null, filter: "admin role only" }]);
  // First-load gate — drives the page skeleton until channels derive.
  const [loaded, setLoaded] = useState(false);
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
      } finally {
        if (!cancelled) setLoaded(true);
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

  // First whole-page fetch — channels haven't derived yet.
  if (!loaded) return <RealtimeSkeleton />;

  return (
    <div className="flex flex-col gap-4.5">
      <PageHeader
        title="Realtime"
        description="In-process pub/sub on Bun, Durable Objects on Workers. Permission filter applies on subscribe + publish."
        actions={<Button variant="outline" icon={I.Refresh} onClick={() => pushToast("Channels refreshed.")}>Refresh</Button>}
      />
      <div className="grid grid-cols-[300px_minmax(0,1fr)] items-start gap-3.5 max-[900px]:grid-cols-[minmax(0,1fr)]">
        <div className="overflow-hidden rounded-2xl border border-border bg-card text-card-foreground">
          {channels.length === 0 && (
            <div className="px-3 py-4 text-xs text-muted-foreground">No channels — create a collection to get one.</div>
          )}
          {channels.map((c) => (
            <div
              key={c.name}
              onClick={() => setActive(c.name)}
              className={`grid cursor-pointer grid-cols-[20px_1fr_auto] items-center gap-3 border-b border-border px-3.5 py-[11px] text-[13px] last:border-b-0 ${active === c.name ? "bg-accent" : ""}`}
            >
              <span>
                <span className="block size-[7px] shrink-0 rounded-full bg-primary shadow-[0_0_0_3px_color-mix(in_oklch,var(--primary)_20%,transparent)]" />
              </span>
              <div className="flex min-w-0 flex-col">
                <span className="font-mono text-[12.5px]">{c.name}</span>
                <span className="text-[11px] text-muted-foreground">{c.filter}</span>
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
