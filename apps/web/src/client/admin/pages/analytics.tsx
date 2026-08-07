// Analytics page — product analytics + crash reporting over
// `/api/admin/analytics` (#22).
//
// Four tabs on one page because they read the same event stream and share the
// time-window control: Overview (counters + daily series + top-N), Funnel (an
// ordered conversion builder), Retention (a cohort grid), and Errors (crash
// groups + triage). The window select in the header applies to all four.
import type { PushToast } from "../types";
import { useMemo, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { I } from "../icons";
import { Badge, Button, EmptyState, PageHeader } from "../ui";
import { Select } from "../select";
import { Card } from "@backlex/ui/components/card";
import { ScrollArea } from "@backlex/ui/components/scroll-area";
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
  type ApiErrorGroup,
  type ApiErrorStatus,
} from "../api";
import {
  useAnalyticsEventNames,
  useAnalyticsFunnel,
  useAnalyticsIngestKey,
  useAnalyticsOverview,
  useAnalyticsRetention,
  useDeleteErrorGroup,
  useErrorGroup,
  useErrorGroups,
  useUpdateErrorGroup,
} from "../queries";
import { AnalyticsSkeleton } from "../page-skeletons";
import { useQueryClient } from "@tanstack/react-query";

const WINDOWS = ["7", "30", "90"] as const;
const TABS = ["overview", "funnel", "retention", "errors"] as const;
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
function DayChart({ series }: { series: ApiAnalyticsOverview["series"] }) {
  const max = Math.max(1, ...series.map((p) => p.events));
  const h = 120;
  const gap = 2;
  const n = series.length;
  const w = 600;
  const bw = Math.max(2, (w - gap * (n - 1)) / Math.max(1, n));
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      className="block h-[120px] w-full"
    >
      {series.map((p, i) => {
        const x = i * (bw + gap);
        const bh = Math.max(p.events > 0 ? 2 : 0, (p.events / max) * (h - 4));
        const uh = p.events > 0 ? (p.users / p.events) * bh : 0;
        return (
          <g key={p.day}>
            <rect
              x={x}
              y={h - bh}
              width={bw}
              height={bh}
              rx="1.5"
              fill="var(--primary)"
              opacity="0.35"
            >
              <title>{`${p.day} — ${p.events} events, ${p.users} visitors`}</title>
            </rect>
            {uh > 0.5 && (
              <rect x={x} y={h - uh} width={bw} height={uh} rx="1.5" fill="var(--primary)" />
            )}
          </g>
        );
      })}
    </svg>
  );
}

/** A simple label→count list card, used for the top-N breakdowns. */
function BreakdownCard({
  title,
  rows,
  empty,
}: {
  title: string;
  rows: { label: string; count: number }[];
  empty: string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <Card className="gap-2 px-4 py-3.5">
      <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
        {title}
      </div>
      {rows.length === 0 ? (
        <p className="m-0 text-[13px] text-muted-foreground">{empty}</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {rows.map((r) => (
            <div key={r.label} className="flex items-center gap-2">
              <div className="relative min-w-0 flex-1 overflow-hidden rounded-control bg-muted/60 px-2 py-1">
                <div
                  className="absolute inset-y-0 left-0 bg-primary/15"
                  style={{ width: `${Math.max(3, (r.count / max) * 100)}%` }}
                />
                <span className="relative block truncate text-[12.5px]">{r.label}</span>
              </div>
              <span className="shrink-0 tabular-nums text-[12.5px] text-muted-foreground">
                {fmtCount(r.count)}
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
  const [tab, setTab] = useState<Tab>("overview");
  const [days, setDays] = useState(30);
  const [keyOpen, setKeyOpen] = useState(false);

  const overviewQ = useAnalyticsOverview(days);
  const overview = overviewQ.data?.data;

  const tabLabels: Record<Tab, string> = {
    overview: t`Overview`,
    funnel: t`Funnel`,
    retention: t`Retention`,
    errors: t`Errors`,
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
          {tab === "overview" && <OverviewTab overview={overview} days={days} />}
          {tab === "funnel" && <FunnelTab days={days} />}
          {tab === "retention" && <RetentionTab days={days} />}
          {tab === "errors" && <ErrorsTab pushToast={pushToast} />}
        </>
      )}

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
}: {
  overview: ApiAnalyticsOverview | undefined;
  days: number;
}) {
  const { t } = useLingui();
  if (!overview) return null;

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
          value={fmtCount(overview.totals.users)}
          sub={t`unique, by anonymous id`}
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
        <DayChart series={overview.series} />
      </Card>

      <div className="grid gap-3 lg:grid-cols-3">
        <BreakdownCard
          title={t`Top events`}
          rows={overview.topEvents.map((e) => ({ label: e.name, count: e.count }))}
          empty={t`No events in this window.`}
        />
        <BreakdownCard
          title={t`Top pages`}
          rows={overview.topPaths.map((p) => ({ label: p.path, count: p.count }))}
          empty={t`No page paths recorded — send a path with your events.`}
        />
        <BreakdownCard
          title={t`Top referrers`}
          rows={overview.topReferrers.map((r) => ({ label: r.referrer, count: r.count }))}
          empty={t`No referrers recorded.`}
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
