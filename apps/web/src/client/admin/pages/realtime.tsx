// Realtime page — collection-derived channels + permission-filtered SSE tail
import { useEffect, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { I } from "../icons";
import { Badge, Button, PageHeader } from "../ui";
import { RealtimeTail, type RealtimeEvent } from "../extras";
import { RealtimeSkeleton } from "../page-skeletons";

/** Auto-refresh cadence for live subscriber counts. Cheap on Bun (in-process
 *  map read); on Workers it's one DO fetch per channel — keep it loose. */
const STATS_REFRESH_MS = 5_000;

export function RealtimePage({ events, active, onActiveChange, pushToast }: { events: RealtimeEvent[]; active: string; onActiveChange: (name: string) => void; pushToast: (m: string) => void }) {
  const { t } = useLingui();
  // Channels are derived from real collections — `items:<slug>` per
  // collection plus the system `collections` channel. Subscriber counts
  // come from `/api/admin/realtime/channels` (DO fetch on Workers, in-
  // process map on Bun; 503 on Vercel/Netlify Edge).
  type Channel = { name: string; subs: number | null; filter: string };
  const [channels, setChannels] = useState<Channel[]>([{ name: "collections", subs: null, filter: t`admin role only` }]);
  // First-load gate — drives the page skeleton until channels derive.
  const [loaded, setLoaded] = useState(false);
  // `statsByChannel` is merged into the channel rows on each render so the
  // /collections derivation and the /stats fetch can refresh independently.
  const [statsByChannel, setStatsByChannel] = useState<Record<string, number>>({});

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
          filter: c.ownerScoped ? t`owner_id _eq $user.id` : t`permission · read`,
        }));
        // Always include the system `collections` channel (admin-only schema events).
        built.push({ name: "collections", subs: null, filter: t`admin role only` });
        if (!cancelled) setChannels(built);
      } catch {
        // keep default
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Poll subscriber counts. Silent on 503 (edge runtimes that don't support
  // realtime) — the page still works as a derivation view.
  useEffect(() => {
    let cancelled = false;
    const pull = async () => {
      try {
        const r = await fetch("/api/admin/realtime/channels", { credentials: "include" });
        if (!r.ok || cancelled) return;
        const j = (await r.json()) as { data?: Array<{ channel: string; stats: { connectedSockets: number } }> };
        const next: Record<string, number> = {};
        for (const row of j.data ?? []) next[row.channel] = row.stats.connectedSockets;
        if (!cancelled) setStatsByChannel(next);
      } catch {
        // ignore; the badge just won't render
      }
    };
    void pull();
    const id = setInterval(pull, STATS_REFRESH_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // Merge live counts into the derived channel list at render time.
  const mergedChannels = channels.map((c) =>
    c.name in statsByChannel ? { ...c, subs: statsByChannel[c.name] ?? 0 } : c,
  );
  // Lock onto the first channel once derived if the parent's selection no
  // longer matches any known channel.
  useEffect(() => {
    if (channels.length === 0) return;
    if (!channels.some((c) => c.name === active)) onActiveChange(channels[0]!.name);
  }, [channels, active, onActiveChange]);
  const setActive = onActiveChange;
  const channelsToRender = mergedChannels;

  // First whole-page fetch — channels haven't derived yet.
  if (!loaded) return <RealtimeSkeleton />;

  return (
    <div className="flex flex-col gap-4.5">
      <PageHeader
        title={t`Realtime`}
        description={t`In-process pub/sub on Bun, Durable Objects on Workers. Permission filter applies on subscribe + publish.`}
        actions={<Button variant="outline" icon={I.Refresh} onClick={() => pushToast(t`Channels refreshed.`)}><Trans>Refresh</Trans></Button>}
      />
      <div className="grid grid-cols-[300px_minmax(0,1fr)] items-start gap-3.5 max-[900px]:grid-cols-[minmax(0,1fr)]">
        <div className="overflow-hidden rounded-2xl border border-border bg-card text-card-foreground">
          {channelsToRender.length === 0 && (
            <div className="px-3 py-4 text-xs text-muted-foreground"><Trans>No channels — create a collection to get one.</Trans></div>
          )}
          {channelsToRender.map((c) => (
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
              {c.subs != null && <Badge variant="outline" mono>{c.subs} <Trans>sub</Trans></Badge>}
            </div>
          ))}
        </div>

        <RealtimeTail events={events} channel={active} connected />
      </div>
    </div>
  );
}
