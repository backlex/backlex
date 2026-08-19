// Analytics page — product analytics + crash reporting over
// `/api/admin/analytics` (#22).
//
// Four tabs on one page because they read the same event stream and share the
// time-window control: Overview (counters + daily series + top-N), Funnel (an
// ordered conversion builder), Retention (a cohort grid), and Errors (crash
// groups + triage). The window select in the header applies to all four.
import type { PushToast } from "../../types";
import { useMemo, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { I } from "../../icons";
import { Badge, Button, EmptyState, PageHeader } from "../../ui";
import { useUrlTab } from "../../use-url-tab";
import { Select } from "../../select";
import { Card } from "@backlex/ui/components/card";
import { ScrollArea } from "@backlex/ui/components/scroll-area";
import { Input } from "@backlex/ui/components/input";
import { Timeseries } from "./timeseries";
import { ConsentTab } from "./consent-tab";
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
  type ApiAnalyticsSite,
  type ApiErrorGroup,
  type ApiErrorStatus,
} from "../../api";
import {
  useAnalyticsEventNames,
  useAnalyticsFunnel,
  useAnalyticsIngestKey,
  useAnalyticsOverview,
  useAnalyticsChannels,
  useAnalyticsSegments,
  useCreateAnalyticsSegment,
  useDeleteAnalyticsSegment,
  useAnalyticsRealtime,
  useAnalyticsRevenue,
  useAnalyticsSessionStats,
  useAnalyticsRetention,
  useAnalyticsSites,
  useCreateAnalyticsSite,
  useDeleteAnalyticsSite,
  useDeleteErrorGroup,
  useErrorGroup,
  useErrorGroups,
  useUpdateAnalyticsSite,
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
  "sites",
  "consent",
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
   * the caller says which. The other figure rides in the row's tooltip rather
   * than a second column, which would not survive a 390px viewport.
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
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

export function AnalyticsPage({
  pushToast,
}: {
  pushToast: PushToast;
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

  const tabLabels: Record<Tab, string> = {
    overview: t`Overview`,
    realtime: t`Realtime`,
    funnel: t`Funnel`,
    retention: t`Retention`,
    errors: t`Errors`,
    sites: t`Sites`,
    consent: t`Consent`,
  };

  if (overviewQ.isLoading && !overview) return <AnalyticsSkeleton />;

  return (
    <div className="flex flex-col gap-4.5">
      <PageHeader
        title={t`Analytics`}
        description={t`Product events and crash reports from your apps. Visitors are counted by an anonymous id, so pre-signup traffic is measured too.`}
        actions={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Select
              size="sm"
              value={String(days)}
              onChange={(v) => setDays(Number(v))}
              options={WINDOWS.map((d) => ({ value: d, label: t`${d} days` }))}
              className="w-[110px]"
            />
            <Button variant="outline" icon={I.Key} onClick={() => setKeyOpen(true)}>
              <Trans>Ingest key</Trans>
            </Button>
            <Select
              size="sm"
              value={segmentId}
              onValueChange={(v) => setSegmentId(v)}
              className="w-[150px] min-w-0 [&>*]:min-w-0"
              options={[
                { value: "", label: t`All traffic` },
                ...segments.map((sg: ApiAnalyticsSegment) => ({
                  value: sg.id,
                  label: sg.name,
                })),
              ]}
            />
            <Button variant="outline" icon={I.Filter} onClick={() => setSegOpen(true)}>
              <Trans>Segments</Trans>
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
          </div>
        }
      />

      {/* Tab strip. Scrolls horizontally on a phone rather than wrapping into
          a second row that pushes the content down. */}
      <ScrollArea className="w-full" viewportClassName="max-w-full">
        <div className="flex items-center gap-1.5 pb-1">
          {TABS.map((id) => (
            <Button
              key={id}
              variant={tab === id ? "primary" : "outline"}
              onClick={() => setTab(id)}
            >
              {tabLabels[id]}
            </Button>
          ))}
        </div>
      </ScrollArea>

      {overviewQ.isError ? (
        <Card className="items-center gap-3 px-6 py-12 text-center">
          <div className="grid size-10 place-items-center rounded-control bg-muted text-primary">
            <I.AlertTriangle size={18} />
          </div>
          <h4 className="m-0 text-[15px] font-semibold">
            <Trans>Couldn't load analytics</Trans>
          </h4>
          <p className="m-0 max-w-[360px] text-[13px] text-muted-foreground">
            <Trans>The analytics endpoint returned an error. Refresh to try again.</Trans>
          </p>
        </Card>
      ) : (
        <>
          {tab === "overview" && (
            <OverviewTab overview={overview} days={days} segmentId={segmentId || null} />
          )}
          {tab === "funnel" && <FunnelTab days={days} />}
          {tab === "retention" && <RetentionTab days={days} />}
          {tab === "errors" && <ErrorsTab pushToast={pushToast} />}
          {tab === "realtime" && <RealtimeTab />}
          {tab === "sites" && <SitesTab pushToast={pushToast} />}
          {tab === "consent" && <ConsentTab pushToast={pushToast} />}
        </>
      )}

      <SegmentsDialog
        open={segOpen}
        onClose={() => setSegOpen(false)}
        pushToast={pushToast}
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
}: {
  overview: ApiAnalyticsOverview | undefined;
  days: number;
  segmentId: string | null;
}) {
  const { t } = useLingui();
  if (!overview) return null;

  // With rotating ids a range-wide unique count is inflated — one returning
  // person is a new id every day. Rather than print a number we know is wrong,
  // the visitor tile switches to the per-day figure, which is true, and says
  // so. Zero cookieless traffic (every workspace, until the web tag ships)
  // keeps the original label.
  const cookieless = overview.totals.cookielessShare > 0;

  if (overview.totals.events === 0) {
    return (
      <EmptyState
        icon={I.BarChart}
        title={t`No events tracked yet`}
        description={t`Mint an ingest key, then call client.analytics.track("page_view") from your app. Events show up here within seconds.`}
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
          sub={t`with a session id`}
        />
        <StatTile
          label={t`Events / visitor`}
          value={
            overview.totals.users > 0
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
        <StatTile
          label={t`Sessions`}
          value={fmtCount(s.sessions)}
          sub={t`30-minute inactivity`}
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
            <Select
              value={String(windowDays)}
              onChange={(v) => setWindowDays(Number(v))}
              options={FUNNEL_WINDOWS.map((d) => ({ value: d, label: t`${d} days` }))}
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

  // Long windows produce a very wide grid; cap the visible columns so the
  // table stays readable and let the ScrollArea handle the rest.
  const cols = Math.min(data?.maxOffset ?? 0, 14);
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

      {!data || data.cohorts.length === 0 ? (
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

      {!groupsQ.isLoading && groups.length === 0 ? (
        <EmptyState
          icon={I.AlertTriangle}
          title={t`No crashes here`}
          description={t`Call client.analytics.captureErrors() in your app to forward uncaught errors and unhandled rejections automatically.`}
        />
      ) : (
        <>
          {/* Phone: stacked cards. A horizontally scrolling table would park
              the count, status and the Resolve action off-screen. */}
          <div className="flex flex-col gap-2 sm:hidden">
            {groups.map((g) => (
              <Card
                key={g.id}
                className="cursor-pointer gap-2 px-3.5 py-3"
                onClick={() => setOpenId(g.id)}
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
                      onClick={() => setOpenId(g.id)}
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
  const { data } = useErrorGroup(id);
  const update = useUpdateErrorGroup();
  const remove = useDeleteErrorGroup();
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

            {group?.culprit && (
              <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
                <Badge variant="outline">{group.level}</Badge>
                {group.platform && <Badge variant="outline">{group.platform}</Badge>}
                {group.release && <Badge variant="outline">{group.release}</Badge>}
                <span className="font-mono text-muted-foreground">{group.culprit}</span>
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
                <Trans>Last seen at</Trans>{" "}
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
            variant="outline"
            icon={I.Trash}
            onClick={() => {
              if (!id) return;
              remove.mutate(id, {
                onError: () => pushToast(t`Couldn't delete the group.`, "error"),
              });
              onClose();
            }}
          >
            <Trans>Delete</Trans>
          </Button>
          {group?.status !== "ignored" && (
            <Button variant="outline" icon={I.Eye} onClick={() => setStatus("ignored")}>
              <Trans>Ignore</Trans>
            </Button>
          )}
          {group?.status === "resolved" ? (
            <Button variant="outline" icon={I.RotateCcw} onClick={() => setStatus("open")}>
              <Trans>Reopen</Trans>
            </Button>
          ) : (
            <Button variant="primary" icon={I.Check} onClick={() => setStatus("resolved")}>
              <Trans>Resolve</Trans>
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
  const { data } = useAnalyticsIngestKey();
  const exists = data?.data.exists ?? false;
  // Shown once, right after minting — the server only ever stores its hash.
  const [minted, setMinted] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const close = () => {
    setMinted(null);
    onClose();
  };

  const mint = async () => {
    setBusy(true);
    try {
      const res = await analyticsApi.mintIngestKey();
      setMinted(res.data.key);
      await qc.invalidateQueries({ queryKey: queryKeysIngest });
    } catch {
      pushToast(t`Couldn't mint an ingest key.`, "error");
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    setBusy(true);
    try {
      await analyticsApi.revokeIngestKey();
      setMinted(null);
      await qc.invalidateQueries({ queryKey: queryKeysIngest });
      pushToast(t`Ingest key revoked.`);
    } catch {
      pushToast(t`Couldn't revoke the ingest key.`, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader className="shrink-0">
          <DialogTitle>
            <Trans>Analytics ingest key</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>The publishable key your client apps send when tracking.</Trans>
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          <div className="flex flex-col gap-3 px-1">
            <p className="m-0 text-[13px] text-muted-foreground">
              <Trans>
                A publishable key you can ship inside browser and mobile bundles. It
                only allows appending events and crash reports — it can't read any
                data back. Cross-origin callers still need their origin on the
                workspace's allowed-origins list.
              </Trans>
            </p>

            {minted ? (
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
                    <Trans>Minting a new key immediately invalidates the old one.</Trans>
                  ) : (
                    <Trans>No key has been minted for this workspace yet.</Trans>
                  )}
                </span>
              </div>
            )}
          </div>
        </DialogBody>

        <DialogFooter className="shrink-0">
          {exists && (
            <Button variant="outline" icon={I.Trash} disabled={busy} onClick={revoke}>
              <Trans>Revoke</Trans>
            </Button>
          )}
          <Button variant="primary" icon={I.Key} disabled={busy} onClick={mint}>
            {exists ? <Trans>Rotate key</Trans> : <Trans>Mint key</Trans>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Local alias so the dialog doesn't need the whole queryKeys import surface. */
const queryKeysIngest = ["analytics", "ingest-key"] as const;

/* ── Sites ────────────────────────────────────────────────────────────── */

/** The snippet an operator pastes. Built from the browser's own origin so a
 *  workspace on a custom domain needs no configuration to get it right. */
const snippetFor = (siteId: string): string =>
  `<script defer src="${typeof window === "undefined" ? "" : window.location.origin}/api/analytics/script.js" data-site="${siteId}"></script>`;

function SitesTab({ pushToast }: { pushToast: PushToast }) {
  const { t } = useLingui();
  const sitesQ = useAnalyticsSites();
  const createSite = useCreateAnalyticsSite();
  const updateSite = useUpdateAnalyticsSite();
  const deleteSite = useDeleteAnalyticsSite();
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<ApiAnalyticsSite | null>(null);
  const sites = sitesQ.data?.data ?? [];

  const copy = (text: string) => {
    void navigator.clipboard
      ?.writeText(text)
      .then(() => pushToast(t`Snippet copied.`))
      .catch(() => pushToast(t`Could not copy — select the snippet manually.`));
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-end">
        <Button variant="primary" icon={I.Plus} onClick={() => setAddOpen(true)}>
          <Trans>Add site</Trans>
        </Button>
      </div>

      {sites.length === 0 ? (
        <EmptyState
          icon={I.BarChart}
          title={t`No websites registered`}
          description={t`Register a site to get a one-line script tag. It measures pageviews with no cookie and no consent banner — visitors are counted by a hash that rotates every day.`}
        />
      ) : (
        <div className="flex flex-col gap-3">
          {sites.map((s: ApiAnalyticsSite) => (
            <Card key={s.id} className="gap-3 px-4 py-3.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-[14px] font-medium">{s.name}</div>
                  <div className="truncate text-[12.5px] text-muted-foreground">
                    {s.domain}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button
                    variant="outline"
                    icon={I.Copy}
                    onClick={() => copy(snippetFor(s.id))}
                  >
                    <Trans>Copy snippet</Trans>
                  </Button>
                  <Button
                    variant="outline"
                    icon={I.Settings}
                    onClick={() => setEditing(s)}
                  >
                    <Trans>Settings</Trans>
                  </Button>
                  <Button
                    variant="outline"
                    icon={I.Trash}
                    onClick={() => {
                      deleteSite.mutate(s.id, {
                        onError: () => pushToast(t`Could not remove the site.`),
                      });
                      pushToast(t`Site removed.`);
                    }}
                  >
                    <Trans>Remove</Trans>
                  </Button>
                </div>
              </div>

              {/* The snippet is long and full of punctuation — the classic
                  mobile overflow. Its own scroll container keeps the card and
                  the page from ever scrolling sideways. */}
              <ScrollArea className="w-full rounded-control border bg-muted/40">
                <div className="p-2">
                  <code className="block whitespace-pre text-[11.5px] leading-relaxed">
                    {snippetFor(s.id)}
                  </code>
                </div>
              </ScrollArea>

              <div className="flex flex-wrap items-center gap-1.5">
                <Button
                  variant={s.filterBots ? "primary" : "outline"}
                  onClick={() =>
                    updateSite.mutate({ id: s.id, patch: { filterBots: !s.filterBots } })
                  }
                >
                  {s.filterBots ? <Trans>Bots filtered</Trans> : <Trans>Bots kept</Trans>}
                </Button>
                <Button
                  variant={s.requireKnownOrigin ? "primary" : "outline"}
                  onClick={() =>
                    updateSite.mutate({
                      id: s.id,
                      patch: { requireKnownOrigin: !s.requireKnownOrigin },
                    })
                  }
                >
                  {s.requireKnownOrigin ? (
                    <Trans>Origin checked</Trans>
                  ) : (
                    <Trans>Any origin</Trans>
                  )}
                </Button>
                <Badge variant="secondary">
                  <Trans>Cookieless</Trans>
                </Badge>
              </div>
            </Card>
          ))}
        </div>
      )}

      <SiteSettingsDialog
        site={editing}
        onClose={() => setEditing(null)}
        onSave={(patch) => {
          if (!editing) return;
          updateSite.mutate(
            { id: editing.id, patch },
            { onError: () => pushToast(t`Could not save the settings.`) },
          );
          setEditing(null);
          pushToast(t`Site settings saved.`);
        }}
      />

      <AddSiteDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onSubmit={(input) => {
          // Optimistic: the row is in the list before the request resolves, and
          // the dialog closes immediately. `onError` rolls the cache back.
          createSite.mutate(input, {
            onError: () => pushToast(t`Could not add the site.`),
          });
          setAddOpen(false);
          pushToast(t`Site added — copy its snippet.`);
        }}
      />
    </div>
  );
}

function AddSiteDialog({
  open,
  onClose,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (input: { name: string; domain: string }) => void;
}) {
  const [name, setName] = useState("");
  const [domain, setDomain] = useState("");
  const valid = name.trim().length > 0 && domain.trim().length > 0;

  const submit = () => {
    if (!valid) return;
    onSubmit({ name: name.trim(), domain: domain.trim() });
    setName("");
    setDomain("");
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-[440px]">
        <DialogHeader>
          <DialogTitle>
            <Trans>Add a website</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>
              You get a one-line script tag. It stores nothing on the visitor's
              device, so it needs no cookie banner.
            </Trans>
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-1.5">
              <span className="text-[12.5px] text-muted-foreground">
                <Trans>Name</Trans>
              </span>
              <Input
                value={name}
                placeholder="Marketing site"
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submit()}
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-[12.5px] text-muted-foreground">
                <Trans>Domain</Trans>
              </span>
              <Input
                value={domain}
                placeholder="example.com"
                onChange={(e) => setDomain(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submit()}
              />
              <span className="text-[11.5px] text-muted-foreground">
                <Trans>
                  A full URL is fine — it is reduced to the host. Subdomains
                  count as the same site.
                </Trans>
              </span>
            </label>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Button variant="primary" disabled={!valid} onClick={submit}>
            <Trans>Add site</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

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
        <Button
          variant={live ? "primary" : "outline"}
          icon={I.Zap}
          onClick={() => setLive((v) => !v)}
        >
          {live ? <Trans>Live</Trans> : <Trans>Go live</Trans>}
        </Button>
      </div>

      {!rt ? (
        <Card className="gap-2 px-4 py-3.5">
          <Skeleton className="h-3 w-32" />
          <Skeleton className="h-[120px] w-full" />
        </Card>
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
const SEGMENT_FIELD_OPTIONS = [
  { value: "path", label: "Page path" },
  { value: "referrer", label: "Referrer" },
  { value: "country", label: "Country" },
  { value: "deviceType", label: "Device" },
  { value: "browser", label: "Browser" },
  { value: "os", label: "OS" },
  { value: "utmSource", label: "Campaign source" },
  { value: "utmMedium", label: "Campaign medium" },
  { value: "utmCampaign", label: "Campaign" },
  { value: "name", label: "Event name" },
  { value: "currency", label: "Currency" },
] as const;

const SEGMENT_OP_OPTIONS = [
  { value: "eq", label: "is" },
  { value: "neq", label: "is not" },
  { value: "contains", label: "contains" },
  { value: "startsWith", label: "starts with" },
  { value: "endsWith", label: "ends with" },
  { value: "isSet", label: "is set" },
  { value: "isNotSet", label: "is not set" },
] as const;

interface DraftRow {
  field: string;
  op: string;
  value: string;
}

function SegmentsDialog({
  open,
  onClose,
  pushToast,
}: {
  open: boolean;
  onClose: () => void;
  pushToast: PushToast;
}) {
  const { t } = useLingui();
  const segmentsQ = useAnalyticsSegments();
  const createSegment = useCreateAnalyticsSegment();
  const deleteSegment = useDeleteAnalyticsSegment();
  const segments = segmentsQ.data?.data ?? [];

  const [name, setName] = useState("");
  const [combine, setCombine] = useState<"all" | "any">("all");
  const [rows, setRows] = useState<DraftRow[]>([{ field: "path", op: "eq", value: "" }]);

  const patch = (i: number, next: Partial<DraftRow>) =>
    setRows((r) => r.map((row, j) => (j === i ? { ...row, ...next } : row)));

  const needsValue = (op: string) => op !== "isSet" && op !== "isNotSet";
  const complete = rows.filter((r) => (needsValue(r.op) ? r.value.trim() !== "" : true));
  const valid = name.trim() !== "" && complete.length > 0;

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
      { onError: () => pushToast(t`Could not save the segment.`) },
    );
    pushToast(t`Segment saved.`);
    setName("");
    setRows([{ field: "path", op: "eq", value: "" }]);
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
                        deleteSegment.mutate(sg.id, {
                          onError: () => pushToast(t`Could not remove the segment.`),
                        });
                        pushToast(t`Segment removed.`);
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

              {rows.map((row, i) => (
                <div
                  key={`${row.field}-${i}`}
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
                    options={SEGMENT_FIELD_OPTIONS.map((o) => ({ ...o }))}
                  />
                  <Select
                    size="sm"
                    value={row.op}
                    onValueChange={(v) => patch(i, { op: v })}
                    className="min-w-0 [&>*]:min-w-0"
                    options={SEGMENT_OP_OPTIONS.map((o) => ({ ...o }))}
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
                  <Button
                    variant="outline"
                    icon={I.Trash}
                    disabled={rows.length === 1}
                    onClick={() => setRows((r) => r.filter((_, j) => j !== i))}
                  >
                    <Trans>Remove</Trans>
                  </Button>
                </div>
              ))}

              <div>
                <Button
                  variant="outline"
                  icon={I.Plus}
                  disabled={rows.length >= 10}
                  onClick={() =>
                    setRows((r) => [...r, { field: "path", op: "eq", value: "" }])
                  }
                >
                  <Trans>Add condition</Trans>
                </Button>
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

/**
 * Per-site collection settings.
 *
 * These are the controls that actually bound what a public write endpoint
 * accepts, and every one of them is enforced SERVER-side. The tag's own
 * opt-outs (DNT, GPC, skipping localhost) are advice a modified script can
 * decline to follow; these are not.
 */
function SiteSettingsDialog({
  site,
  onClose,
  onSave,
}: {
  site: ApiAnalyticsSite | null;
  onClose: () => void;
  onSave: (patch: { excludedPaths: string[]; ignoredIps: string[] }) => void;
}) {
  const [paths, setPaths] = useState("");
  const [ips, setIps] = useState("");
  const [loadedFor, setLoadedFor] = useState<string | null>(null);

  // Seed the fields from the site the first time this opens for it. Doing it
  // in render rather than an effect keeps the dialog a pure function of props
  // and avoids the StrictMode double-effect that has bitten this codebase.
  if (site && loadedFor !== site.id) {
    setLoadedFor(site.id);
    setPaths(site.excludedPaths.join("\n"));
    setIps(site.ignoredIps.join("\n"));
  }

  const lines = (v: string) =>
    v
      .split(/[\n,]/)
      .map((x) => x.trim())
      .filter(Boolean)
      .slice(0, 50);

  return (
    <Dialog open={!!site} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-[520px] [&>*]:min-w-0">
        <DialogHeader>
          <DialogTitle>
            <Trans>Collection settings</Trans>
          </DialogTitle>
          <DialogDescription>
            {site ? site.domain : ""}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="flex min-w-0 flex-col gap-3">
            <label className="flex min-w-0 flex-col gap-1.5">
              <span className="text-[12.5px] text-muted-foreground">
                <Trans>Excluded paths</Trans>
              </span>
              <Input
                value={paths}
                placeholder="/admin/*, /health"
                onChange={(e) => setPaths(e.target.value)}
              />
              <span className="text-[11.5px] text-muted-foreground">
                <Trans>
                  Comma separated. A leading or trailing * is supported. Never
                  recorded, and enforced on the server.
                </Trans>
              </span>
            </label>
            <label className="flex min-w-0 flex-col gap-1.5">
              <span className="text-[12.5px] text-muted-foreground">
                <Trans>Ignored IPs</Trans>
              </span>
              <Input
                value={ips}
                placeholder="203.0.113.4, 198.51.100.9"
                onChange={(e) => setIps(e.target.value)}
              />
              <span className="text-[11.5px] text-muted-foreground">
                <Trans>
                  Your office, a monitoring probe. The address is compared and
                  discarded — it is never stored on an event.
                </Trans>
              </span>
            </label>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Button
            variant="primary"
            onClick={() => onSave({ excludedPaths: lines(paths), ignoredIps: lines(ips) })}
          >
            <Trans>Save</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
