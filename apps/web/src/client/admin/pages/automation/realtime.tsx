// Realtime page — collection-derived channels + permission-filtered SSE tail
import type { PushToast } from "../../types";
import { useEffect, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { I } from "../../icons";
import { Badge, Button, EmptyState, PageHeader } from "../../ui";
import { Card } from "@backlex/ui/components/card";
import { Input } from "@backlex/ui/components/input";
import { ScrollArea } from "@backlex/ui/components/scroll-area";
import { RealtimeTail, type RealtimeEvent, type TailStatus } from "../../extras";
import { RealtimeSkeleton } from "../../page-skeletons";
import { ChannelsCard } from "./channels-card";
import { CdcCard } from "./cdc-card";

/** Auto-refresh cadence for live subscriber counts. Cheap on Bun (in-process
 *  map read); on Workers it's one DO fetch per channel — keep it loose. */
const STATS_REFRESH_MS = 5_000;

/** Past this many channels the list gets a filter box; below it one would be
 *  a control with nothing to narrow. */
const CHANNEL_FILTER_MIN = 8;

/** `items:orders` → a muted `items:` and the slug, which is the part that tells
 *  sixty rows apart. */
function ChannelName({ name }: { name: string }) {
  if (!name.startsWith("items:")) return <>{name}</>;
  return (
    <>
      <span className="text-muted-foreground">items:</span>
      {name.slice("items:".length)}
    </>
  );
}

export function RealtimePage({ events, tailStatus, active, onActiveChange, pushToast }: { events: RealtimeEvent[]; tailStatus: TailStatus; active: string; onActiveChange: (name: string) => void; pushToast: PushToast }) {
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
  const [filter, setFilter] = useState("");
  const query = filter.trim().toLowerCase();
  const channelsToRender = query ? mergedChannels.filter((c) => c.name.toLowerCase().includes(query)) : mergedChannels;

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
        <Card className="py-0 gap-0">
          <div className="flex min-h-[49px] items-center gap-2 border-b border-border px-3.5 py-2.5">
            <h3 className="m-0 text-[13px] font-semibold"><Trans>Channels</Trans></h3>
            <span className="text-[11px] tabular-nums text-muted-foreground">{mergedChannels.length}</span>
            {mergedChannels.length > CHANNEL_FILTER_MIN && (
              <Input
                className="ml-auto h-7 w-40 min-w-0 text-[12px]"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder={t`Filter channels…`}
                aria-label={t`Filter channels`}
              />
            )}
          </div>
          {/* Capped, because one channel per collection means the list is as
              long as the schema: with a sixty-collection template it ran for
              thousands of pixels and pushed the broadcast and CDC cards below
              it out of reach. */}
          <ScrollArea type="auto" viewportClassName="max-h-[min(560px,calc(100vh-260px))] max-[900px]:max-h-[360px]">
            <div className="flex flex-col">
              {mergedChannels.length === 0 && (
                <EmptyState size="sm" icon={I.Zap} title={<Trans>No channels — create a collection to get one.</Trans>} />
              )}
              {mergedChannels.length > 0 && channelsToRender.length === 0 && (
                <span className="px-3.5 py-3 text-[12px] text-muted-foreground"><Trans>No channels match.</Trans></span>
              )}
              {channelsToRender.map((c) => (
                <div
                  key={c.name}
                  onClick={() => setActive(c.name)}
                  title={c.name}
                  // `minmax(0,1fr)`: a bare `1fr` floors at the name's width, and
                  // `items:inventory_reservations` ran under the sub badge.
                  className={`grid cursor-pointer grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-3 border-b border-border px-3.5 py-[11px] text-[13px] last:border-b-0 ${active === c.name ? "bg-accent" : ""}`}
                >
                  <span>
                    <span className="block size-[7px] shrink-0 rounded-full bg-primary shadow-[0_0_0_3px_color-mix(in_oklch,var(--primary)_20%,transparent)]" />
                  </span>
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate font-mono text-[12.5px]"><ChannelName name={c.name} /></span>
                    <span className="truncate text-[11px] text-muted-foreground">{c.filter}</span>
                  </div>
                  {c.subs != null && <Badge variant="outline" mono>{c.subs} <Trans>sub</Trans></Badge>}
                </div>
              ))}
            </div>
          </ScrollArea>
        </Card>

        <RealtimeTail events={events} channel={active} status={tailStatus} />
      </div>

      {/* The list above is DERIVED from collections — every managed channel
          this workspace has. The card below is the other half: the channels
          the workspace's own application invents, which exist only because a
          rule says they may. */}
      <ChannelsCard pushToast={pushToast} />
      {/* The same change stream, but leaving the building. */}
      <CdcCard pushToast={pushToast} />
    </div>
  );
}
