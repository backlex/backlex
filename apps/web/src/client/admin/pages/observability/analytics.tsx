// Analytics page — product analytics + crash reporting over
// `/api/admin/analytics` (#22).
//
// Five tabs on one page because they read the same event stream and share the
// time-window control: Overview (counters + daily series + top-N), Realtime,
// Funnel (an ordered conversion builder), Retention (a cohort grid), and Errors
// (crash groups + triage). The window select applies to Overview, Funnel and
// Retention — Realtime is fixed at the last 30 minutes and the Errors list is
// filtered by status and level, so the header hides it on those two rather than
// offering a control that does nothing.
//
// The site REGISTRY and the consent policy used to be tabs here and are now
// their own pages under the Website group. They never belonged: neither reads
// the event stream or the time window, and both are configuration a tag manager
// user needs without ever opening Analytics. What keeps Analytics here rather
// than moving with them is that `analytics_events.site_id` is NULLABLE — the
// stream it reports over is not site-scoped.
import type { PushToast } from "../../types";
import { useMemo, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { I } from "../../icons";
import { Badge, Button, EmptyState, PageHeader } from "../../ui";
import { useUrlTab } from "../../use-url-tab";
import { Select } from "../../select";
import { Card } from "@backlex/ui/components/card";
import { ScrollArea } from "@backlex/ui/components/scroll-area";
import { Tabs, TabsList, TabsTrigger } from "@backlex/ui/components/tabs";
import { Input } from "@backlex/ui/components/input";
import { Timeseries } from "./timeseries";
import { ConfirmDialog } from "../../sheet";
import { Skeleton } from "@backlex/ui/components/skeleton";
import { currencyExponent, formatMoney, fromMinorUnits } from "@backlex/db/money";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@backlex/ui/components/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@backlex/ui/components/table";
import {
  analyticsApi,
  type ApiAnalyticsOverview,
  type ApiAnalyticsSegment,
  type ApiErrorGroup,
  type ApiErrorStatus,
} from "../../api";
import {
  useAnalyticsEventNames,
  useAnalyticsFunnel,
  useAnalyticsIngestKey,
  useAnalyticsOverview,
  useAnalyticsSites,
  useAnalyticsChannels,
  useAnalyticsSegments,
  useCreateAnalyticsSegment,
  useDeleteAnalyticsSegment,
  useAnalyticsRealtime,
  useAnalyticsRevenue,
  useAnalyticsSessionStats,
  useAnalyticsRetention,
  useDeleteErrorGroup,
  useErrorGroup,
  useErrorGroups,
  useUpdateErrorGroup,
} from "../../queries";
import { AnalyticsSkeleton } from "../../page-skeletons";
import { useQueryClient } from "@tanstack/react-query";

const WINDOWS = ["7", "30", "90"] as const;
const TABS = [
  "overview",
  "realtime",
  "funnel",
  "retention",
  "errors",
] as const;
type Tab = (typeof TABS)[number];

const fmtCount = (n: number): string =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 10_000
      ? `${(n / 1000).toFixed(1)}k`
      : String(n);

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;

const fmtDateTime = (ms: number): string => {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} · ${hh}:${mm}`;
};

/** Short relative age — "3m", "2h", "5d". */
const fmtAgo = (ms: number): string => {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};

function StatTile({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <Card className="gap-0 px-[15px] py-3.5">
      <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
        {label}
      </div>
      <div className="mt-0.5 text-[25px] font-semibold leading-tight tabular-nums tracking-[-0.02em]">
        {value}
      </div>
      <div className="text-[11.5px] text-muted-foreground">{sub}</div>
    </Card>
  );
}

/** Per-day event bars with the unique-visitor slice drawn on top. */

/** A simple label→count list card, used for the top-N breakdowns. */
function BreakdownCard({
  title,
  rows,
  empty,
  metric = "count",
  unit,
}: {
  title: string;
  rows: { label: string; count: number; users?: number }[];
  empty: string;
  /**
   * Which figure the row leads with. A website report answers "how many
   * people" for a page or a country, and "how many times" for an event — so
   * the caller says which. The other figure rides in the row's tooltip on a
   * pointer device, and inline in a lighter weight below `sm:` — a tooltip is
   * unreachable on the viewport this admin is checked at.
   */
  metric?: "count" | "users";
  unit: string;
}) {
  const figure = (r: { count: number; users?: number }) =>
    metric === "users" ? (r.users ?? 0) : r.count;
  const max = Math.max(1, ...rows.map(figure));
  return (
    <Card className="gap-2 px-4 py-3.5">
      <div className="flex items-baseline justify-between gap-2">
        <div className="min-w-0 truncate text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
          {title}
        </div>
        <div className="shrink-0 text-[10.5px] uppercase tracking-[0.06em] text-muted-foreground/70">
          {unit}
        </div>
      </div>
      {rows.length === 0 ? (
        <p className="m-0 text-[13px] text-muted-foreground">{empty}</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {rows.map((r) => (
            <div
              key={r.label}
              className="flex items-center gap-2"
              title={
                r.users === undefined
                  ? `${r.count}`
                  : `${r.count} events · ${r.users} visitors`
              }
            >
              <div className="relative min-w-0 flex-1 overflow-hidden rounded-control bg-muted/60 px-2 py-1">
                <div
                  className="absolute inset-y-0 left-0 bg-primary/15"
                  style={{ width: `${Math.max(3, (figure(r) / max) * 100)}%` }}
                />
                <span className="relative block truncate text-[12.5px]">{r.label}</span>
              </div>
              <span className="shrink-0 tabular-nums text-[12.5px] text-muted-foreground">
                {fmtCount(figure(r))}
              </span>
              {/* The second figure lives in a `title` tooltip, which a touch
                  device never shows — so on a phone half the data in six to
                  eleven of these cards was unreachable. It trails the headline
                  figure in a lighter weight, never in front of it. */}
              {r.users !== undefined && (
                <span className="shrink-0 tabular-nums text-[11px] text-muted-foreground/60 sm:hidden">
                  {`· ${fmtCount(metric === "users" ? r.count : r.users)}`}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

export function AnalyticsPage({
  pushToast,
  setActiveNav,
}: {
  pushToast: PushToast;
  /** Prop-drilled rather than `useNavigate`, matching the sibling pages: the
   *  shell's `vNav` saves pane scroll, warms the target's lazy chunk and
   *  commits inside a view transition. */
  setActiveNav?: (id: string) => void;
}) {
  const { t } = useLingui();
  const qc = useQueryClient();
  const [tab, setTab] = useUrlTab(TABS, "overview");
  const [days, setDays] = useState(30);
  const [segmentId, setSegmentId] = useState<string>("");
  const [segOpen, setSegOpen] = useState(false);
  const segmentsQ = useAnalyticsSegments();
  const segments = segmentsQ.data?.data ?? [];
  const [keyOpen, setKeyOpen] = useState(false);

  const overviewQ = useAnalyticsOverview(days, segmentId || null);
  const overview = overviewQ.data?.data;
  // Read only to tell two empty states apart: a workspace with a website
  // registered is not missing an SDK key, it is missing traffic.
  const sitesQ = useAnalyticsSites();

  const tabLabels: Record<Tab, string> = {
    overview: t`Overview`,
    realtime: t`Realtime`,
    funnel: t`Funnel`,
    retention: t`Retention`,
    errors: t`Errors`,
  };

  // Which header controls this tab actually obeys. They used to sit above every
  // tab as if they applied to all five, and on two of them they were inert:
  // `RealtimeTab` is hard-coded to the last 30 minutes and takes no props, and
  // `useErrorGroups(status, level)` takes neither the window nor the segment.
  const usesWindow = tab === "overview" || tab === "funnel" || tab === "retention";
  const usesSegment = tab === "overview";

  return (
    <div className="flex flex-col gap-4.5">
      <PageHeader
        title={t`Analytics`}
        description={t`Product events and crash reports from your apps. Visitors are counted by an anonymous id, so pre-signup traffic is measured too.`}
        descriptionClassName="hidden sm:block"
        // A bare fragment: PageHeader already wraps `actions` in its own
        // `ml-auto flex flex-wrap items-center justify-end gap-2`, so the inner
        // div this used to pass made the row wrap against the wrong width.
        actions={
          <>
            {usesWindow && (
              <Select
                size="sm"
                value={String(days)}
                onChange={(v) => setDays(Number(v))}
                options={WINDOWS.map((d) => ({ value: d, label: t`Last ${d} days` }))}
                className="w-[130px]"
              />
            )}
            {usesSegment && (
              <>
                <Select
                  size="sm"
                  value={segmentId}
                  onValueChange={(v) => setSegmentId(v)}
                  className="w-[150px] min-w-0 [&>*]:min-w-0"
                  options={[
                    { value: "", label: t`All traffic` },
                    ...segments
                      // The optimistic row's placeholder id is not one the
                      // server knows; selecting it would filter by nothing.
                      .filter((sg: ApiAnalyticsSegment) => !sg.id.startsWith("pending-"))
                      .map((sg: ApiAnalyticsSegment) => ({
                        value: sg.id,
                        label: sg.name,
                      })),
                  ]}
                />
                <Button variant="outline" icon={I.Filter} onClick={() => setSegOpen(true)}>
                  <Trans>Segments</Trans>
                </Button>
              </>
            )}
            {/* Named for what it is. As "Ingest key" in the header of the page
                an operator opens after installing a website tag, it read as a
                required setup step — and the web tag reads no key at all. */}
            <Button variant="outline" icon={I.Key} onClick={() => setKeyOpen(true)}>
              <Trans>App SDK key</Trans>
            </Button>
            <Button
              variant="outline"
              icon={I.Refresh}
              disabled={overviewQ.isFetching}
              onClick={() => {
                void qc
                  .invalidateQueries({ queryKey: ["analytics"] })
                  .then(() => qc.invalidateQueries({ queryKey: ["errors"] }))
                  .then(() => pushToast(t`Analytics refreshed.`));
              }}
            >
              <Trans>Refresh</Trans>
            </Button>
          </>
        }
      />

      {/* The real Tabs primitive rather than five plain Buttons: it carries
          role/aria-selected and roving focus, and its list scrolls itself on a
          phone. logs.tsx already switches views this way. */}
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList>
          {TABS.map((id) => (
            <TabsTrigger key={id} value={id}>
              {tabLabels[id]}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {/* Both gates belong to Overview alone. Page-wide, a failing overview
          query took down crash triage with it, and deep-linking `?tab=errors`
          rendered an Overview-shaped skeleton for a tab that draws a table. */}
      {tab === "overview" &&
        (overviewQ.isError ? (
          <EmptyState
            icon={I.AlertTriangle}
            title={t`Couldn't load analytics`}
            description={
              (overviewQ.error as Error)?.message ||
              t`This is usually temporary — try again.`
            }
            action={
              <Button
                variant="primary"
                icon={I.Refresh}
                onClick={() => void overviewQ.refetch()}
              >
                <Trans>Try again</Trans>
              </Button>
            }
          />
        ) : overviewQ.isLoading && !overview ? (
          <AnalyticsSkeleton />
        ) : (
          <OverviewTab
            overview={overview}
            days={days}
            segmentId={segmentId || null}
            hasSites={(sitesQ.data?.data.length ?? 0) > 0}
            onOpenIngestKey={() => setKeyOpen(true)}
            onGoToWebsites={setActiveNav ? () => setActiveNav("websites") : undefined}
          />
        ))}
      {tab === "funnel" && <FunnelTab days={days} />}
      {tab === "retention" && <RetentionTab days={days} />}
      {tab === "errors" && <ErrorsTab pushToast={pushToast} />}
      {tab === "realtime" && <RealtimeTab />}

      <SegmentsDialog
        open={segOpen}
        onClose={() => setSegOpen(false)}
        pushToast={pushToast}
        selectedSegmentId={segmentId}
        onSegmentCleared={() => setSegmentId("")}
      />

      <IngestKeyDialog
        open={keyOpen}
        onClose={() => setKeyOpen(false)}
        pushToast={pushToast}
      />
    </div>
  );
}

/* ── Overview ─────────────────────────────────────────────────────────── */

function OverviewTab({
  overview,
  days,
  segmentId,
  hasSites,
  onOpenIngestKey,
  onGoToWebsites,
}: {
  overview: ApiAnalyticsOverview | undefined;
  days: number;
  segmentId: string | null;
  /** Whether this workspace has a website registered. It decides which of two
   *  very different "nothing here" stories is true. */
  hasSites: boolean;
  onOpenIngestKey: () => void;
  onGoToWebsites?: () => void;
}) {
  const { t } = useLingui();
  if (!overview) return null;

  // With rotating ids a range-wide unique count is inflated — one returning
  // person is a new id every day. Rather than print a number we know is wrong,
  // the visitor tile switches to the per-day figure, which is true, and says
  // so. Zero cookieless traffic (every workspace, until the web tag ships)
  // keeps the original label.
  const cookieless = overview.totals.cookielessShare > 0;

  // The two stories are not the same, and telling the wrong one was the single
  // most misleading thing on this page. A website's tag authenticates by its
  // site id — it reads no key, and never has — so telling an operator who has
  // just installed one to "mint an ingest key" sends them to fix a credential
  // that plays no part in why their page views are missing.
  if (overview.totals.events === 0) {
    return hasSites ? (
      <EmptyState
        icon={I.Globe}
        title={t`No events from your websites yet`}
        description={t`The website tag needs no key — it reports against the site it was issued for. Check its snippet is the first script in your head tag, and that the page you loaded is not on the excluded list.`}
        action={
          onGoToWebsites ? (
            <Button variant="primary" icon={I.Globe} onClick={onGoToWebsites}>
              <Trans>Check the snippet</Trans>
            </Button>
          ) : undefined
        }
      />
    ) : (
      <EmptyState
        icon={I.BarChart}
        title={t`No events tracked yet`}
        description={t`Register a website for pageviews with no key at all, or — for a mobile app, a server job or your own SDK calls — create an app SDK key and call client.analytics.track("page_view").`}
        action={
          <span className="flex flex-wrap items-center justify-center gap-1.5">
            {onGoToWebsites ? (
              <Button variant="primary" icon={I.Globe} onClick={onGoToWebsites}>
                <Trans>Add a website</Trans>
              </Button>
            ) : null}
            <Button variant="outline" icon={I.Key} onClick={onOpenIngestKey}>
              <Trans>Create an app SDK key</Trans>
            </Button>
          </span>
        }
      />
    );
  }

  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label={t`Events`}
          value={fmtCount(overview.totals.events)}
          sub={t`last ${days} days`}
        />
        <StatTile
          label={t`Visitors`}
          value={
            cookieless
              ? fmtCount(overview.totals.visitorsPerDay ?? 0)
              : fmtCount(overview.totals.users)
          }
          sub={cookieless ? t`per day, ids rotate daily` : t`unique, by anonymous id`}
        />
        <StatTile
          label={t`Sessions`}
          value={fmtCount(overview.totals.sessions)}
          sub={t`events carrying a session id`}
        />
        {/* The denominator has to be the figure printed next to it. With
            rotating ids the Visitors tile deliberately stops showing `users`,
            so dividing by `users` produced a ratio the reader could not
            reproduce from the two tiles either side of it. */}
        <StatTile
          label={cookieless ? t`Events / visitor-day` : t`Events / visitor`}
          value={
            cookieless
              ? (overview.totals.visitorsPerDay ?? 0) > 0
                ? (
                    overview.totals.events /
                    ((overview.totals.visitorsPerDay ?? 0) * days)
                  ).toFixed(1)
                : "—"
              : overview.totals.users > 0
                ? (overview.totals.events / overview.totals.users).toFixed(1)
                : "—"
          }
          sub={t`engagement depth`}
        />
      </div>

      <Card className="gap-2 px-4 py-3.5">
        <div className="flex items-center justify-between gap-2">
          <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
            <Trans>Events per day</Trans>
          </div>
          <div className="flex items-center gap-3 text-[11.5px] text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span className="size-2 rounded-[2px] bg-primary/35" />
              <Trans>Events</Trans>
            </span>
            <span className="flex items-center gap-1.5">
              <span className="size-2 rounded-[2px] bg-primary" />
              <Trans>Visitors</Trans>
            </span>
          </div>
        </div>
        <Timeseries
          data={overview.series.map((p) => ({
            label: p.day,
            total: p.events,
            accent: p.users,
          }))}
          totalLabel={t`Events`}
          accentLabel={t`Visitors`}
        />
      </Card>

      <div className="grid gap-3 lg:grid-cols-3">
        <BreakdownCard
          title={t`Top events`}
          unit={t`events`}
          rows={overview.topEvents.map((e) => ({
            label: e.name,
            count: e.count,
            users: e.users,
          }))}
          empty={t`No events in this window.`}
        />
        <BreakdownCard
          title={t`Top pages`}
          unit={t`visitors`}
          metric="users"
          rows={overview.topPaths.map((p) => ({
            label: p.path,
            count: p.count,
            users: p.users,
          }))}
          empty={t`No page paths recorded — send a path with your events.`}
        />
        <BreakdownCard
          title={t`Top referrers`}
          unit={t`visitors`}
          metric="users"
          rows={overview.topReferrers.map((r) => ({
            label: r.referrer,
            count: r.count,
            users: r.users,
          }))}
          empty={t`No referrers recorded.`}
        />
        <BreakdownCard
          title={t`Countries`}
          unit={t`visitors`}
          metric="users"
          rows={overview.topCountries.map((r) => ({
            label: r.value,
            count: r.count,
            users: r.users,
          }))}
          empty={t`No country resolved. Self-hosted deploys need a proxy that sets a geo header.`}
        />
        <BreakdownCard
          title={t`Devices`}
          unit={t`visitors`}
          metric="users"
          rows={overview.topDevices.map((r) => ({
            label: r.value,
            count: r.count,
            users: r.users,
          }))}
          empty={t`No device recorded — events sent server-side carry no user-agent.`}
        />
        <BreakdownCard
          title={t`Campaigns`}
          unit={t`visitors`}
          metric="users"
          rows={overview.topCampaigns.map((r) => ({
            label: r.value,
            count: r.count,
            users: r.users,
          }))}
          empty={t`No campaigns yet — tag a landing URL with ?utm_source=… to see it here.`}
        />
      </div>

      <SessionsBlock days={days} segmentId={segmentId} />
      <ChannelsBlock days={days} segmentId={segmentId} />
      <RevenueBlock days={days} segmentId={segmentId} />
    </>
  );
}

/**
 * Session metrics, shown only when there is tag traffic to compute them from.
 *
 * A workspace that only calls `track()` from its app has no sessions — server
 * events are not visits — and rendering "0% bounce rate, 0s average" for it
 * would be four confident zeros about something that was never measured.
 */
function SessionsBlock({ days, segmentId }: { days: number; segmentId: string | null }) {
  const { t } = useLingui();
  const q = useAnalyticsSessionStats(days, null, segmentId);
  const s = q.data?.data;
  if (!s || s.sessions === 0) return null;

  const duration = (ms: number) => {
    const total = Math.round(ms / 1000);
    const m = Math.floor(total / 60);
    const sec = total % 60;
    return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
  };

  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {/* Named apart from the top grid's "Sessions". Two tiles carrying one
            word for two different measurements — events that carried a session
            id, against visits cut on 30 minutes of inactivity — invited the
            reader to treat a disagreement between them as a bug. */}
        <StatTile
          label={t`Website visits`}
          value={fmtCount(s.sessions)}
          sub={t`cut on 30-minute inactivity`}
        />
        <StatTile
          label={t`Bounce rate`}
          value={`${Math.round(s.bounceRate * 100)}%`}
          sub={t`one-page sessions`}
        />
        <StatTile
          label={t`Avg duration`}
          value={duration(s.avgDurationMs)}
          sub={t`bounces count as zero`}
        />
        <StatTile
          label={t`Pages / session`}
          value={s.pagesPerSession.toFixed(2)}
          sub={t`depth of a visit`}
        />
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <BreakdownCard
          title={t`Landing pages`}
          unit={t`sessions`}
          rows={s.landingPages.map((r) => ({
            label: r.value,
            count: r.count,
            users: r.users,
          }))}
          empty={t`No landing pages in this window.`}
        />
        <BreakdownCard
          title={t`Exit pages`}
          unit={t`sessions`}
          rows={s.exitPages.map((r) => ({
            label: r.value,
            count: r.count,
            users: r.users,
          }))}
          empty={t`No exit pages in this window.`}
        />
      </div>
    </>
  );
}

/* ── Funnel ───────────────────────────────────────────────────────────── */

const FUNNEL_WINDOWS = ["1", "3", "7", "14", "30"] as const;

function FunnelTab({ days }: { days: number }) {
  const { t } = useLingui();
  const namesQ = useAnalyticsEventNames();
  const names = namesQ.data?.data ?? [];
  const [steps, setSteps] = useState<string[]>(["", ""]);
  const [windowDays, setWindowDays] = useState(7);

  const chosen = steps.filter(Boolean);
  const funnelQ = useAnalyticsFunnel(chosen, windowDays, days);
  const result = funnelQ.data?.data;

  // Steps are picked from what's actually been tracked — a typo'd event name
  // would silently return zero, which reads as "nobody converted".
  const options = useMemo(
    () => [
      { value: "", label: t`Pick an event…` },
      ...names.map((n) => ({ value: n, label: n })),
    ],
    [names, t],
  );

  const setStep = (i: number, v: string) =>
    setSteps((prev) => prev.map((s, j) => (j === i ? v : s)));

  // Asserted before anything had loaded, so every visit to this tab briefly
  // told a workspace with plenty of events that it had none.
  if (namesQ.isLoading) return <Skeleton className="h-[168px] w-full rounded-control" />;

  if (names.length === 0) {
    return (
      <EmptyState
        icon={I.Filter}
        title={t`No events to build a funnel from`}
        description={t`Track at least two different event names, then come back to measure how visitors move between them.`}
      />
    );
  }

  return (
    <>
      <Card className="gap-3 px-4 py-3.5">
        <div className="flex flex-col gap-2">
          {steps.map((s, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="w-5 shrink-0 text-[12px] tabular-nums text-muted-foreground">
                {i + 1}.
              </span>
              <Select
                value={s}
                onChange={(v) => setStep(i, v)}
                options={options}
                className="min-w-0 flex-1"
              />
              {steps.length > 2 && (
                <Button
                  variant="ghost"
                  icon={I.X}
                  aria-label={t`Remove step`}
                  onClick={() => setSteps((prev) => prev.filter((_, j) => j !== i))}
                />
              )}
            </div>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            icon={I.Plus}
            disabled={steps.length >= 8}
            onClick={() => setSteps((prev) => [...prev, ""])}
          >
            <Trans>Add step</Trans>
          </Button>
          <div className="flex items-center gap-2">
            <span className="text-[12.5px] text-muted-foreground">
              <Trans>Convert within</Trans>
            </span>
            {/* Bounded by the report window above it: on 7 days of data, a
                30-day conversion window is a range the query cannot answer. */}
            <Select
              value={String(Math.min(windowDays, days))}
              onChange={(v) => setWindowDays(Number(v))}
              options={FUNNEL_WINDOWS.filter((d) => Number(d) <= days).map((d) => ({
                value: d,
                label: t`${d} days`,
              }))}
              className="w-[110px]"
            />
          </div>
        </div>
      </Card>

      {chosen.length < 2 ? (
        <EmptyState
          icon={I.Filter}
          title={t`Pick at least two steps`}
          description={t`A funnel measures how many visitors who did the first event went on to do the next ones, in order.`}
        />
      ) : result ? (
        <Card className="gap-3 px-4 py-3.5">
          {result.steps.map((s, i) => (
            <div key={`${s.name}-${i}`} className="flex flex-col gap-1">
              <div className="flex items-baseline justify-between gap-2">
                <span className="min-w-0 truncate text-[13px] font-medium">
                  {i + 1}. {s.name}
                </span>
                <span className="shrink-0 tabular-nums text-[12.5px] text-muted-foreground">
                  {fmtCount(s.count)} · {pct(s.conversion)}
                </span>
              </div>
              <div className="h-2.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary"
                  style={{ width: `${Math.max(1, s.conversion * 100)}%` }}
                />
              </div>
              {i > 0 && s.dropOff > 0 && (
                <span className="text-[11.5px] text-muted-foreground">
                  <Trans>{pct(s.dropOff)} dropped off here</Trans>
                </span>
              )}
            </div>
          ))}
        </Card>
      ) : funnelQ.isFetching ? (
        // Changing a step or the window used to make the results card vanish
        // and reappear with no sign that anything was happening.
        <Card className="gap-3 px-4 py-3.5">
          {chosen.map((name) => (
            <Skeleton key={name} className="h-10 w-full" />
          ))}
        </Card>
      ) : null}
    </>
  );
}

/* ── Retention ────────────────────────────────────────────────────────── */

/** `YYYY-MM-DD` for today (UTC), and for a cohort day shifted by N days —
 *  used to blank out cells whose calendar day hasn't arrived yet. */
const utcToday = (): string => new Date().toISOString().slice(0, 10);
const offsetDay = (day: string, n: number): string =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Cell tint scales with the retained share so the grid reads at a glance. */
const retentionTint = (share: number): string => {
  if (share <= 0) return "bg-muted/40 text-muted-foreground";
  if (share < 0.2) return "bg-primary/10";
  if (share < 0.4) return "bg-primary/25";
  if (share < 0.6) return "bg-primary/40";
  if (share < 0.8) return "bg-primary/60 text-primary-foreground";
  return "bg-primary/80 text-primary-foreground";
};

function RetentionTab({ days }: { days: number }) {
  const { t } = useLingui();
  const namesQ = useAnalyticsEventNames();
  const names = namesQ.data?.data ?? [];
  const [event, setEvent] = useState("");
  const retentionQ = useAnalyticsRetention(event || null, days);
  const data = retentionQ.data?.data;

  // Long windows produce a very wide grid, and the ScrollArea scrolls it. The
  // cap that used to sit here scrolled only the 15 columns it built, so on a
  // 90-day window D15 onward were not "handled by the ScrollArea" — they were
  // dropped, and the comment said otherwise.
  const cols = data?.maxOffset ?? 0;
  const today = utcToday();

  return (
    <>
      <Card className="flex-row flex-wrap items-center gap-2 px-4 py-3">
        <span className="text-[12.5px] text-muted-foreground">
          <Trans>Count a visitor as active when they fire</Trans>
        </span>
        <Select
          value={event}
          onChange={setEvent}
          options={[
            { value: "", label: t`any event` },
            ...names.map((n) => ({ value: n, label: n })),
          ]}
          className="min-w-0 max-w-[240px] flex-1"
        />
      </Card>

      {retentionQ.isLoading ? (
        // "Not enough history yet" is a claim about the workspace's data, and
        // it was being made before any of that data had arrived.
        <Skeleton className="h-[280px] w-full rounded-control" />
      ) : !data || data.cohorts.length === 0 ? (
        <EmptyState
          icon={I.History}
          title={t`Not enough history yet`}
          description={t`Retention needs visitors whose first-ever day falls inside the selected window. Widen the window or come back after a few days of traffic.`}
        />
      ) : (
        <ScrollArea className="w-full rounded-control border">
          <div className="min-w-max">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[110px] whitespace-nowrap">
                    <Trans>Cohort</Trans>
                  </TableHead>
                  <TableHead className="w-[70px] text-right">
                    <Trans>Size</Trans>
                  </TableHead>
                  {Array.from({ length: cols + 1 }).map((_, i) => (
                    <TableHead key={i} className="w-[54px] text-center">
                      {`D${i}`}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.cohorts.map((c) => (
                  <TableRow key={c.day}>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {c.day}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{c.size}</TableCell>
                    {Array.from({ length: cols + 1 }).map((_, i) => {
                      // A day that hasn't happened yet has no data — leave the
                      // cell blank. Rendering it as 0% would read as "nobody
                      // came back" instead of "not measured".
                      if (offsetDay(c.day, i) > today) {
                        return (
                          <TableCell
                            key={i}
                            className="p-1 text-center text-[11.5px] text-muted-foreground/40"
                          >
                            ·
                          </TableCell>
                        );
                      }
                      const v = c.values[i] ?? 0;
                      const share = c.size > 0 ? v / c.size : 0;
                      return (
                        <TableCell key={i} className="p-1 text-center">
                          <span
                            className={`block rounded-[4px] px-1 py-1 text-[11.5px] tabular-nums ${retentionTint(share)}`}
                            title={`${v} / ${c.size}`}
                          >
                            {c.size > 0 ? `${Math.round(share * 100)}%` : "—"}
                          </span>
                        </TableCell>
                      );
                    })}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </ScrollArea>
      )}
    </>
  );
}

/* ── Errors ───────────────────────────────────────────────────────────── */

const levelVariant = (level: string): "secondary" | "destructive" | "outline" =>
  level === "fatal" || level === "error" ? "destructive" : "secondary";

const statusVariant = (status: string): "secondary" | "outline" =>
  status === "open" ? "secondary" : "outline";

function ErrorsTab({
  pushToast,
}: {
  pushToast: PushToast;
}) {
  const { t } = useLingui();
  const [status, setStatus] = useState("open");
  const [level, setLevel] = useState("all");
  const [openId, setOpenId] = useState<string | null>(null);
  const groupsQ = useErrorGroups(status, level);
  const groups = groupsQ.data?.data ?? [];
  const update = useUpdateErrorGroup();
  const filtered = status !== "open" || level !== "all";

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={status}
          onChange={setStatus}
          options={[
            { value: "open", label: t`Open` },
            { value: "resolved", label: t`Resolved` },
            { value: "ignored", label: t`Ignored` },
            { value: "all", label: t`All statuses` },
          ]}
          className="w-[150px]"
        />
        <Select
          value={level}
          onChange={setLevel}
          options={[
            { value: "all", label: t`All levels` },
            { value: "fatal", label: t`Fatal` },
            { value: "error", label: t`Error` },
            { value: "warning", label: t`Warning` },
          ]}
          className="w-[140px]"
        />
      </div>

      {groupsQ.isLoading ? (
        // The loading case used to fall through to the table branch with an
        // empty list: a bordered box of column headers on desktop, and nothing
        // at all on a phone, on every filter change.
        <div className="flex flex-col gap-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-14 w-full rounded-control" />
          ))}
        </div>
      ) : groups.length === 0 ? (
        // Filtered and unfiltered are different answers. Set status to
        // "Resolved" on a workspace that reports crashes daily and this used to
        // tell the operator to go and install the SDK.
        filtered ? (
          <EmptyState
            icon={I.AlertTriangle}
            title={t`No crashes match these filters`}
            description={t`Nothing here at this status and level. Widen the filters to see the rest.`}
            action={
              <Button
                variant="outline"
                icon={I.X}
                onClick={() => {
                  setStatus("open");
                  setLevel("all");
                }}
              >
                <Trans>Clear filters</Trans>
              </Button>
            }
          />
        ) : (
          <EmptyState
            icon={I.AlertTriangle}
            title={t`No crashes here`}
            description={t`Call client.analytics.captureErrors() in your app to forward uncaught errors and unhandled rejections automatically.`}
          />
        )
      ) : (
        <>
          {/* Phone: stacked cards. A horizontally scrolling table would park
              the count, status and the Resolve action off-screen. */}
          <div className="flex flex-col gap-2 sm:hidden">
            {groups.map((g) => (
              <Card
                key={g.id}
                className="cursor-pointer gap-2 px-3.5 py-3"
                role="button"
                tabIndex={0}
                onClick={() => setOpenId(g.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setOpenId(g.id);
                  }
                }}
              >
                <div className="flex min-w-0 flex-col">
                  <span className="truncate text-[13px] font-medium">
                    <span className="font-mono text-[12px] text-muted-foreground">
                      {g.type}
                    </span>{" "}
                    {g.message}
                  </span>
                  {g.culprit && (
                    <span className="truncate font-mono text-[11.5px] text-muted-foreground">
                      {g.culprit}
                    </span>
                  )}
                </div>
                <div
                  className="flex flex-wrap items-center justify-end gap-1.5"
                  onClick={(e) => e.stopPropagation()}
                >
                  <Badge variant={levelVariant(g.level)}>{g.level}</Badge>
                  <Badge variant={statusVariant(g.status)}>{g.status}</Badge>
                  <span className="tabular-nums text-[12px] text-muted-foreground">
                    {fmtCount(g.events)}× · {fmtAgo(g.lastSeen)}
                  </span>
                  {g.status !== "resolved" && (
                    <Button
                      variant="outline"
                      icon={I.Check}
                      onClick={() => {
                        update.mutate(
                          { id: g.id, status: "resolved" },
                          { onError: () => pushToast(t`Couldn't resolve.`, "error") },
                        );
                      }}
                    >
                      <Trans>Resolve</Trans>
                    </Button>
                  )}
                </div>
              </Card>
            ))}
          </div>

          <ScrollArea className="hidden w-full rounded-control border sm:block">
            <div className="min-w-[640px]">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>
                      <Trans>Error</Trans>
                    </TableHead>
                    <TableHead className="w-[90px]">
                      <Trans>Level</Trans>
                    </TableHead>
                    <TableHead className="w-[80px] text-right">
                      <Trans>Count</Trans>
                    </TableHead>
                    <TableHead className="w-[90px] whitespace-nowrap">
                      <Trans>Last seen</Trans>
                    </TableHead>
                    <TableHead className="w-[150px] text-right">
                      <Trans>Status</Trans>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {groups.map((g) => (
                    <TableRow
                      key={g.id}
                      className="cursor-pointer"
                      role="button"
                      tabIndex={0}
                      onClick={() => setOpenId(g.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setOpenId(g.id);
                        }
                      }}
                    >
                      <TableCell className="min-w-0">
                        <div className="flex min-w-0 flex-col">
                          <span className="truncate text-[13px] font-medium">
                            <span className="font-mono text-[12px] text-muted-foreground">
                              {g.type}
                            </span>{" "}
                            {g.message}
                          </span>
                          {g.culprit && (
                            <span className="truncate font-mono text-[11.5px] text-muted-foreground">
                              {g.culprit}
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant={levelVariant(g.level)}>{g.level}</Badge>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {fmtCount(g.events)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {fmtAgo(g.lastSeen)}
                      </TableCell>
                      <TableCell
                        className="text-right"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <div className="flex items-center justify-end gap-1.5">
                          <Badge variant={statusVariant(g.status)}>{g.status}</Badge>
                          {g.status !== "resolved" && (
                            <Button
                              variant="ghost"
                              icon={I.Check}
                              aria-label={t`Resolve`}
                              onClick={() => {
                                update.mutate(
                                  { id: g.id, status: "resolved" },
                                  {
                                    onError: () =>
                                      pushToast(t`Couldn't resolve.`, "error"),
                                  },
                                );
                              }}
                            />
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </ScrollArea>
        </>
      )}

      <ErrorDetailDialog
        id={openId}
        onClose={() => setOpenId(null)}
        pushToast={pushToast}
      />
    </>
  );
}

function ErrorDetailDialog({
  id,
  onClose,
  pushToast,
}: {
  id: string | null;
  onClose: () => void;
  pushToast: PushToast;
}) {
  const { t } = useLingui();
  const { data, isLoading } = useErrorGroup(id);
  const update = useUpdateErrorGroup();
  const remove = useDeleteErrorGroup();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const detail = data?.data;
  const group: ApiErrorGroup | undefined = detail?.group;
  const latest = detail?.occurrences[0];

  const setStatus = (status: ApiErrorStatus) => {
    if (!id) return;
    update.mutate(
      { id, status },
      { onError: () => pushToast(t`Couldn't update the status.`, "error") },
    );
  };

  return (
    <>
    <Dialog open={!!id} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-[720px]">
        <DialogHeader className="shrink-0">
          <DialogTitle className="min-w-0 truncate">
            {group ? `${group.type}: ${group.message}` : t`Error`}
          </DialogTitle>
          <DialogDescription>
            <Trans>
              Every occurrence of this bug, with the latest stack trace and how
              many visitors it reached.
            </Trans>
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          <div className="flex flex-col gap-3 px-1">
            {isLoading && !group && (
              // Clicking a row used to open a dialog titled "Error" with an
              // entirely empty body and a live footer.
              <div className="flex flex-col gap-3">
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <Skeleton key={i} className="h-[68px] w-full rounded-control" />
                  ))}
                </div>
                <Skeleton className="h-[160px] w-full rounded-control" />
              </div>
            )}
            {group && (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <StatTile
                  label={t`Occurrences`}
                  value={fmtCount(group.events)}
                  sub={t`lifetime`}
                />
                <StatTile
                  label={t`Visitors`}
                  value={fmtCount(detail?.users ?? 0)}
                  sub={t`affected`}
                />
                <StatTile
                  label={t`First seen`}
                  value={fmtAgo(group.firstSeen)}
                  sub={fmtDateTime(group.firstSeen)}
                />
                <StatTile
                  label={t`Last seen`}
                  value={fmtAgo(group.lastSeen)}
                  sub={fmtDateTime(group.lastSeen)}
                />
              </div>
            )}

            {group && (
              <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
                <Badge variant={levelVariant(group.level)}>{group.level}</Badge>
                {group.platform && <Badge variant="outline">{group.platform}</Badge>}
                {group.release && <Badge variant="outline">{group.release}</Badge>}
                {group.culprit && (
                  <span className="font-mono text-muted-foreground">{group.culprit}</span>
                )}
              </div>
            )}

            {latest?.stack && (
              <div className="flex flex-col gap-1">
                <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                  <Trans>Latest stack trace</Trans>
                </div>
                <ScrollArea
                  className="w-full rounded-control border bg-muted/40"
                  viewportClassName="max-h-[240px]"
                >
                  <pre className="m-0 whitespace-pre p-3 font-mono text-[11.5px] leading-relaxed">
                    {latest.stack}
                  </pre>
                </ScrollArea>
              </div>
            )}

            {latest?.url && (
              <div className="text-[12.5px] text-muted-foreground">
                <Trans>Page URL</Trans>{" "}
                <span className="font-mono break-all">{latest.url}</span>
              </div>
            )}

            {detail && detail.occurrences.length > 0 && (
              <div className="flex flex-col gap-1">
                <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                  <Trans>Recent occurrences</Trans>
                </div>
                <div className="flex flex-col gap-1">
                  {detail.occurrences.slice(0, 8).map((o) => (
                    <div
                      key={o.id}
                      className="flex items-center justify-between gap-2 rounded-control bg-muted/40 px-2 py-1.5 text-[12px]"
                    >
                      <span className="min-w-0 truncate">{o.message}</span>
                      <span className="shrink-0 whitespace-nowrap text-muted-foreground">
                        {fmtDateTime(o.ts)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </DialogBody>

        <DialogFooter className="shrink-0">
          <Button
            variant="destructive"
            icon={I.Trash}
            disabled={!group}
            onClick={() => setConfirmDelete(true)}
          >
            <Trans>Delete</Trans>
          </Button>
          {group?.status !== "ignored" && (
            <Button
              variant="outline"
              icon={I.EyeOff}
              disabled={!group}
              onClick={() => setStatus("ignored")}
            >
              <Trans>Ignore</Trans>
            </Button>
          )}
          {/* An ignored group could only be un-ignored by resolving it first
              and then reopening — `open` was reachable from `resolved` alone. */}
          {group?.status === "resolved" || group?.status === "ignored" ? (
            <Button variant="outline" icon={I.RotateCcw} onClick={() => setStatus("open")}>
              <Trans>Reopen</Trans>
            </Button>
          ) : null}
          {group?.status !== "resolved" && (
            <Button
              variant="primary"
              icon={I.Check}
              disabled={!group}
              onClick={() => setStatus("resolved")}
            >
              <Trans>Resolve</Trans>
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
      <ConfirmDialog
        open={confirmDelete}
        destructive
        title={t`Delete this crash group?`}
        description={t`Every occurrence recorded for it goes too, and a crash that happens again arrives as a brand-new group with no history.`}
        actionLabel={t`Delete group`}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => {
          setConfirmDelete(false);
          if (!id) return;
          remove.mutate(id, {
            onSuccess: () => pushToast(t`Crash group deleted.`),
            onError: () => pushToast(t`Couldn't delete the group.`, "error"),
          });
          onClose();
        }}
      />
    </>
  );
}

/* ── Ingest key ───────────────────────────────────────────────────────── */

function IngestKeyDialog({
  open,
  onClose,
  pushToast,
}: {
  open: boolean;
  onClose: () => void;
  pushToast: PushToast;
}) {
  const { t } = useLingui();
  const qc = useQueryClient();
  const { data, isLoading } = useAnalyticsIngestKey();
  const exists = data?.data.exists ?? false;
  // Shown once, right after minting — the server only ever stores its hash.
  const [minted, setMinted] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<"rotate" | "revoke" | null>(null);

  const close = () => {
    setMinted(null);
    setConfirm(null);
    onClose();
  };

  const mint = async () => {
    setBusy(true);
    try {
      const res = await analyticsApi.mintIngestKey();
      setMinted(res.data.key);
      await qc.invalidateQueries({ queryKey: queryKeysIngest });
    } catch {
      pushToast(t`Couldn't create the key.`, "error");
    } finally {
      setBusy(false);
    }
  };

  // Optimistic, like every other mutation in this admin: the badge used to sit
  // on "Key set" for the whole round trip plus a refetch.
  const revoke = async () => {
    setBusy(true);
    const prev = qc.getQueryData(queryKeysIngest);
    qc.setQueryData(queryKeysIngest, (old: { data: { exists: boolean } } | undefined) =>
      old ? { ...old, data: { ...old.data, exists: false } } : old,
    );
    try {
      await analyticsApi.revokeIngestKey();
      setMinted(null);
      pushToast(t`App SDK key revoked.`);
    } catch {
      if (prev) qc.setQueryData(queryKeysIngest, prev);
      pushToast(t`Couldn't revoke the key.`, "error");
    } finally {
      setBusy(false);
      await qc.invalidateQueries({ queryKey: queryKeysIngest });
    }
  };

  return (
    <>
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader className="shrink-0">
          <DialogTitle>
            <Trans>App SDK key</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>
              For events sent from an app — a mobile build, a server job, your own
              SDK calls. Websites do not use it.
            </Trans>
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          <div className="flex flex-col gap-3 px-1">
            {/* The distinction this dialog exists to make. A website's script
                tag authenticates by the site id baked into it and reads no key
                at all, so an operator who has just installed one and sees no
                data is not missing a credential. */}
            <p className="m-0 text-[13px] text-muted-foreground">
              <Trans>
                A publishable key you can ship inside app bundles. It only appends
                events and crash reports — it cannot read a single row back, and it
                grants nothing else.
              </Trans>
            </p>
            <p className="m-0 rounded-control border bg-muted/40 p-2.5 text-[12.5px] text-muted-foreground">
              <Trans>
                A website registered under Websites needs none of this: its script tag
                reports against the site it was issued for. Only reach for a key when
                the sender is not one of those sites.
              </Trans>
            </p>

            {isLoading && !minted ? (
              // While the status was in flight this asserted "No key" and the
              // button read "Mint key", so a fast click silently rotated a key
              // that was live in shipped bundles.
              <Skeleton className="h-6 w-56" />
            ) : minted ? (
              <div className="flex flex-col gap-2">
                <div className="rounded-control border border-primary/40 bg-primary/5 p-3">
                  <code className="block break-all font-mono text-[12.5px]">{minted}</code>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    icon={I.Copy}
                    onClick={() => {
                      void navigator.clipboard
                        .writeText(minted)
                        .then(() => pushToast(t`Copied to clipboard.`));
                    }}
                  >
                    <Trans>Copy</Trans>
                  </Button>
                  <span className="text-[12px] text-muted-foreground">
                    <Trans>Shown once — store it now.</Trans>
                  </span>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-[13px]">
                <Badge variant={exists ? "secondary" : "outline"}>
                  {exists ? <Trans>Key set</Trans> : <Trans>No key</Trans>}
                </Badge>
                <span className="text-muted-foreground">
                  {exists ? (
                    <Trans>Creating a new key immediately invalidates the old one.</Trans>
                  ) : (
                    <Trans>No key has been created for this workspace yet.</Trans>
                  )}
                </span>
              </div>
            )}
          </div>
        </DialogBody>

        <DialogFooter className="shrink-0">
          {exists && (
            <Button
              variant="destructive"
              icon={I.Trash}
              disabled={busy || isLoading}
              onClick={() => setConfirm("revoke")}
            >
              <Trans>Revoke</Trans>
            </Button>
          )}
          <Button
            variant="primary"
            icon={I.Key}
            disabled={busy || isLoading}
            onClick={() => (exists ? setConfirm("rotate") : void mint())}
          >
            {exists ? <Trans>Rotate key</Trans> : <Trans>Create key</Trans>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
      {/* Both actions break every app already shipping the current key, and
          both used to fire on a single click. */}
      <ConfirmDialog
        open={confirm !== null}
        destructive
        title={
          confirm === "revoke" ? t`Revoke this key?` : t`Rotate this key?`
        }
        description={
          confirm === "revoke"
            ? t`Apps sending with it stop being accepted immediately, and events they emit are lost rather than queued.`
            : t`The current key stops working the moment the new one is issued, so every app still shipping it stops reporting until you ship the replacement.`
        }
        actionLabel={confirm === "revoke" ? t`Revoke key` : t`Rotate key`}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          const action = confirm;
          setConfirm(null);
          if (action === "revoke") void revoke();
          else void mint();
        }}
      />
    </>
  );
}

/** Local alias so the dialog doesn't need the whole queryKeys import surface. */
const queryKeysIngest = ["analytics", "ingest-key"] as const;

/* ── Realtime ─────────────────────────────────────────────────────────── */

function RealtimeTab() {
  const { t } = useLingui();
  const [live, setLive] = useState(true);
  const q = useAnalyticsRealtime(live);
  const rt = q.data?.data;

  const fmtMinute = (ms: number) =>
    new Date(ms).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-end">
        {/* The label names the action, not the state: reading "Live" it was
            taken for a status chip, so nobody discovered it pauses polling. */}
        <Button
          variant={live ? "primary" : "outline"}
          icon={live ? I.Pause : I.Zap}
          aria-pressed={live}
          onClick={() => setLive((v) => !v)}
        >
          {live ? <Trans>Pause</Trans> : <Trans>Go live</Trans>}
        </Button>
      </div>

      {!rt ? (
        // Shaped like what replaces it — two tiles, a chart card and three
        // breakdowns. One short card meant the page jumped several hundred
        // pixels when the first poll landed.
        <>
          <div className="grid grid-cols-2 gap-3">
            {Array.from({ length: 2 }).map((_, i) => (
              <Skeleton key={i} className="h-[68px] w-full rounded-control" />
            ))}
          </div>
          <Card className="gap-2 px-4 py-3.5">
            <Skeleton className="h-3 w-32" />
            <Skeleton className="h-[120px] w-full" />
          </Card>
          <div className="grid gap-3 lg:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-[168px] w-full rounded-control" />
            ))}
          </div>
        </>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3">
            <StatTile
              label={t`Visitors now`}
              value={fmtCount(rt.visitorsNow)}
              sub={t`last 30 minutes`}
            />
            <StatTile
              label={t`Events`}
              value={fmtCount(rt.events)}
              sub={t`last 30 minutes`}
            />
          </div>

          {rt.truncated && (
            /* A clipped realtime count is a wrong number that renders
               perfectly, so it says so rather than quietly under-reporting. */
            <Card className="px-4 py-3">
              <p className="m-0 text-[12.5px] text-muted-foreground">
                <Trans>
                  Traffic exceeded the row cap for this window — these counts are
                  a floor, not a total.
                </Trans>
              </p>
            </Card>
          )}

          <Card className="gap-2 px-4 py-3.5">
            <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
              <Trans>Per minute</Trans>
            </div>
            <Timeseries
              data={rt.byMinute.map((b) => ({
                label: fmtMinute(b.minute),
                total: b.events,
                accent: b.visitors,
              }))}
              totalLabel={t`Events`}
              accentLabel={t`Visitors`}
            />
          </Card>

          <div className="grid gap-3 lg:grid-cols-3">
            <BreakdownCard
              title={t`Active pages`}
              unit={t`visitors`}
              metric="users"
              rows={rt.topPaths.map((r) => ({
                label: r.value,
                count: r.count,
                users: r.users,
              }))}
              empty={t`Nothing in the last 30 minutes.`}
            />
            <BreakdownCard
              title={t`Referrers`}
              unit={t`visitors`}
              metric="users"
              rows={rt.topReferrers.map((r) => ({
                label: r.value,
                count: r.count,
                users: r.users,
              }))}
              empty={t`No referrers in this window.`}
            />
            <BreakdownCard
              title={t`Countries`}
              unit={t`visitors`}
              metric="users"
              rows={rt.topCountries.map((r) => ({
                label: r.value,
                count: r.count,
                users: r.users,
              }))}
              empty={t`No country resolved in this window.`}
            />
          </div>
        </>
      )}
    </div>
  );
}

/* ── Channels ─────────────────────────────────────────────────────────── */

/**
 * Where sessions came from.
 *
 * The caveat under the cards is not boilerplate. This number looks exactly
 * like GA4's and is a weaker claim: attribution is scoped to a single session,
 * because a cookieless visitor id rotates at UTC midnight and a campaign from
 * an earlier day cannot be joined to this visit. Someone comparing the two
 * tools has to be told, not left to infer it.
 */
function ChannelsBlock({ days, segmentId }: { days: number; segmentId: string | null }) {
  const { t } = useLingui();
  const q = useAnalyticsChannels(days, null, segmentId);
  const c = q.data?.data;
  if (!c || c.totalSessions === 0) return null;

  return (
    <>
      <div className="grid gap-3 lg:grid-cols-2">
        <BreakdownCard
          title={t`Channels`}
          unit={t`sessions`}
          rows={c.channels.map((r) => ({
            label: r.channel,
            count: r.sessions,
            users: r.visitors,
          }))}
          empty={t`No sessions to attribute in this window.`}
        />
        <BreakdownCard
          title={t`Source / medium`}
          unit={t`sessions`}
          rows={c.sourceMedium.map((r) => ({
            label: r.value,
            count: r.sessions,
            users: r.visitors,
          }))}
          empty={t`No tagged traffic in this window.`}
        />
      </div>
      <p className="m-0 text-[11.5px] text-muted-foreground">
        <Trans>
          Attribution is the last non-direct touch within a session. Cookieless
          visitor ids rotate daily, so a campaign from an earlier day cannot be
          credited to this visit.
        </Trans>
      </p>
    </>
  );
}

/* ── Revenue ──────────────────────────────────────────────────────────── */

/**
 * Revenue, one card per currency.
 *
 * There is no combined total anywhere on this block, and that is the design.
 * The repo has no FX rate source, so a merged figure would be an addition of
 * quantities that are not commensurable — and it would look completely
 * plausible, which is what makes it dangerous. Amounts are stored in minor
 * units; this is the only place that divides.
 */
function RevenueBlock({ days, segmentId }: { days: number; segmentId: string | null }) {
  const { t } = useLingui();
  const q = useAnalyticsRevenue(days, null, segmentId);
  const r = q.data?.data;
  if (!r || r.byCurrency.length === 0) return null;

  // Uses the repo's own money module rather than dividing by 100.
  //
  // Not every currency has two decimals: JPY, KRW and VND have none, BHD and
  // KWD have three. A blanket /100 rendered a ¥150,000 order as ¥1,500 — off
  // by 100x, and entirely plausible-looking on the page, which is exactly the
  // kind of money bug that survives review. `currencyExponent` knows the right
  // answer per code and `formatMoney` falls back to "12.34 XYZ" for an
  // unrecognised one instead of throwing.
  const money = (minor: number, currency: string) =>
    formatMoney({
      amount: fromMinorUnits(minor, currencyExponent(currency)),
      currency,
    });

  return (
    <>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {r.byCurrency.map((c) => (
          <Card key={c.currency} className="gap-2 px-4 py-3.5">
            <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
              {t`Revenue`} · {c.currency}
            </div>
            <div className="text-[22px] font-semibold tabular-nums">
              {money(c.revenue, c.currency)}
            </div>
            <div className="text-[12.5px] text-muted-foreground">
              {c.transactions === 1
                ? t`1 order`
                : t`${c.transactions} orders`}{" · "}
              {money(c.aov, c.currency)} {t`AOV`}
            </div>
          </Card>
        ))}
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <BreakdownCard
          title={t`Revenue by channel`}
          unit={t`orders`}
          rows={r.byChannel.map((x) => ({
            label: `${x.channel} · ${money(x.revenue, x.currency)}`,
            count: x.transactions,
            users: x.transactions,
          }))}
          empty={t`No attributed revenue in this window.`}
        />
        <BreakdownCard
          title={t`Top items`}
          unit={t`sold`}
          rows={r.topItems.map((x) => ({
            label: `${x.name} · ${money(x.revenue, x.currency)}`,
            count: x.quantity,
            users: x.quantity,
          }))}
          empty={t`No items recorded — send props.items with a purchase.`}
        />
      </div>
    </>
  );
}

/* ── Segments ─────────────────────────────────────────────────────────── */

/**
 * Fields a segment may filter on, mirroring the server's closed allowlist.
 *
 * Duplicated here rather than fetched because it is a UI affordance, not the
 * check — the server refuses anything outside its own list regardless of what
 * this dropdown offers. Keeping it a dropdown is the point: a free-text field
 * name would invite exactly the input the server has to reject.
 */
function useSegmentFieldOptions() {
  const { t } = useLingui();
  return [
    { value: "path", label: t`Page path` },
    { value: "referrer", label: t`Referrer` },
    { value: "country", label: t`Country` },
    { value: "deviceType", label: t`Device` },
    { value: "browser", label: t`Browser` },
    { value: "os", label: t`OS` },
    { value: "utmSource", label: t`Campaign source` },
    { value: "utmMedium", label: t`Campaign medium` },
    { value: "utmCampaign", label: t`Campaign` },
    { value: "name", label: t`Event name` },
    { value: "currency", label: t`Currency` },
  ];
}

function useSegmentOpOptions() {
  const { t } = useLingui();
  return [
    { value: "eq", label: t`is` },
    { value: "neq", label: t`is not` },
    { value: "contains", label: t`contains` },
    { value: "startsWith", label: t`starts with` },
    { value: "endsWith", label: t`ends with` },
    { value: "isSet", label: t`is set` },
    { value: "isNotSet", label: t`is not set` },
  ];
}

interface DraftRow {
  /** Stable across a field change. Keyed on `field` the row remounted whenever
   *  the dropdown moved, which recreated the value Input and dropped focus. */
  id: string;
  field: string;
  op: string;
  value: string;
}

const emptyRow = (): DraftRow => ({
  id: crypto.randomUUID(),
  field: "path",
  op: "eq",
  value: "",
});

function SegmentsDialog({
  open,
  onClose,
  pushToast,
  selectedSegmentId,
  onSegmentCleared,
}: {
  open: boolean;
  onClose: () => void;
  pushToast: PushToast;
  /** Which segment the header is filtering by, so removing that one can clear
   *  it rather than leaving every query bound to a deleted id. */
  selectedSegmentId?: string;
  onSegmentCleared?: () => void;
}) {
  const { t } = useLingui();
  const segmentsQ = useAnalyticsSegments();
  const createSegment = useCreateAnalyticsSegment();
  const deleteSegment = useDeleteAnalyticsSegment();
  const segments = segmentsQ.data?.data ?? [];

  const [name, setName] = useState("");
  const [combine, setCombine] = useState<"all" | "any">("all");
  const [rows, setRows] = useState<DraftRow[]>([emptyRow()]);
  const fieldOptions = useSegmentFieldOptions();
  const opOptions = useSegmentOpOptions();

  const patch = (i: number, next: Partial<DraftRow>) =>
    setRows((r) => r.map((row, j) => (j === i ? { ...row, ...next } : row)));

  const needsValue = (op: string) => op !== "isSet" && op !== "isNotSet";
  const complete = rows.filter((r) => (needsValue(r.op) ? r.value.trim() !== "" : true));
  // Every row has to be complete, not just one: a half-filled second condition
  // used to be dropped silently, so the saved segment filtered by less than
  // what was on screen.
  const incomplete = rows.length - complete.length;
  const valid = name.trim() !== "" && incomplete === 0 && complete.length > 0;

  const save = () => {
    if (!valid) return;
    const leaves = complete.map((r) =>
      needsValue(r.op)
        ? { field: r.field, op: r.op, value: r.value.trim() }
        : { field: r.field, op: r.op },
    );
    // One level of and/or covers essentially every real segment; the server
    // accepts nesting, but a tree editor is a different product.
    const definition = leaves.length === 1 ? leaves[0] : { [combine]: leaves };
    createSegment.mutate(
      { name: name.trim(), definition },
      {
        onSuccess: () => pushToast(t`Segment saved.`),
        onError: () =>
          pushToast(t`Couldn't save the segment. Check the name isn't already used.`, "error"),
      },
    );
    setName("");
    setRows([emptyRow()]);
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-[560px] [&>*]:min-w-0">
        <DialogHeader>
          <DialogTitle>
            <Trans>Segments</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>
              A saved filter you can apply to every report from the header.
            </Trans>
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="flex flex-col gap-4">
            {segments.length > 0 && (
              <div className="flex flex-col gap-1.5">
                {segments.map((sg: ApiAnalyticsSegment) => (
                  <div
                    key={sg.id}
                    className="flex min-w-0 items-center gap-2 rounded-control bg-muted/50 px-2 py-1.5"
                  >
                    <span className="min-w-0 flex-1 truncate text-[13px]">{sg.name}</span>
                    <Button
                      variant="outline"
                      icon={I.Trash}
                      className="shrink-0"
                      onClick={() => {
                        // Applied elsewhere, the header Select would keep
                        // filtering by an id that no longer exists.
                        if (sg.id === selectedSegmentId) onSegmentCleared?.();
                        deleteSegment.mutate(sg.id, {
                          onSuccess: () => pushToast(t`Segment removed.`),
                          onError: () =>
                            pushToast(t`Couldn't remove the segment.`, "error"),
                        });
                      }}
                    >
                      <Trans>Remove</Trans>
                    </Button>
                  </div>
                ))}
              </div>
            )}

            <div className="flex flex-col gap-2.5">
              <Input
                value={name}
                placeholder={t`Name — e.g. Mobile from Germany`}
                onChange={(e) => setName(e.target.value)}
              />

              {/* Only offered once there is something to combine — with one
                  condition the choice is discarded on save. */}
              {rows.length > 1 && (
                <div className="flex items-center gap-2">
                  <span className="text-[12.5px] text-muted-foreground">
                    <Trans>Match</Trans>
                  </span>
                  <Select
                    size="sm"
                    value={combine}
                    onValueChange={(v) => setCombine(v as "all" | "any")}
                    className="w-[110px] min-w-0 [&>*]:min-w-0"
                    options={[
                      { value: "all", label: t`all of` },
                      { value: "any", label: t`any of` },
                    ]}
                  />
                </div>
              )}

              {rows.map((row, i) => (
                <div
                  key={row.id}
                  className="grid min-w-0 grid-cols-1 gap-1.5 [&>*]:min-w-0 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto]"
                >
                  {/* Every one of these is a dropdown rather than free text:
                      the value set is finite and known, and a typed field name
                      is exactly the input the server has to reject. */}
                  <Select
                    size="sm"
                    value={row.field}
                    onValueChange={(v) => patch(i, { field: v })}
                    className="min-w-0 [&>*]:min-w-0"
                    options={fieldOptions}
                  />
                  <Select
                    size="sm"
                    value={row.op}
                    onValueChange={(v) => patch(i, { op: v })}
                    className="min-w-0 [&>*]:min-w-0"
                    options={opOptions}
                  />
                  {needsValue(row.op) ? (
                    <Input
                      value={row.value}
                      placeholder={t`value`}
                      onChange={(e) => patch(i, { value: e.target.value })}
                    />
                  ) : (
                    <span />
                  )}
                  {/* Icon-only on a phone: as a full-width labelled button it
                      turned each condition into four stacked rows. */}
                  <Button
                    variant="ghost"
                    icon={I.Trash}
                    aria-label={t`Remove condition`}
                    className="justify-self-end"
                    disabled={rows.length === 1}
                    onClick={() => setRows((r) => r.filter((_, j) => j !== i))}
                  >
                    <span className="hidden sm:inline">
                      <Trans>Remove</Trans>
                    </span>
                  </Button>
                </div>
              ))}

              <div>
                <Button
                  variant="outline"
                  icon={I.Plus}
                  disabled={rows.length >= 10}
                  onClick={() => setRows((r) => [...r, emptyRow()])}
                >
                  <Trans>Add condition</Trans>
                </Button>
                {incomplete > 0 && (
                  <p className="m-0 mt-1.5 text-[11.5px] text-muted-foreground">
                    <Trans>Every condition needs a value before this can be saved.</Trans>
                  </p>
                )}
              </div>
            </div>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            <Trans>Close</Trans>
          </Button>
          <Button variant="primary" disabled={!valid} onClick={save}>
            <Trans>Save segment</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
