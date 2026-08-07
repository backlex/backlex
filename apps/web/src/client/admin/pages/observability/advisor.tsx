// Advisor page — security + performance checks, plus the runtime insights the
// traffic-derived performance rules are computed from.
//
// Findings come from GET /api/admin/advisor (services/advisor.ts) — every
// check is computed from live DB / env state, the score is server-computed,
// and `generatedAt` is one honest per-run timestamp. The page runs the check
// on demand (there is no server cron/cache). Dismiss is persisted to
// localStorage (there is no dismiss endpoint).
//
// The Insights tab (GET /api/admin/advisor/insights) shows the raw span
// aggregation: slowest endpoints and per-collection list traffic. Counts there
// are spans actually recorded — never extrapolated — so when sampling is on or
// the window outran span retention, the tab says so instead of implying the
// numbers are the whole story.
import type { PushToast } from "../../types";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Trans, useLingui } from "@lingui/react/macro";
import { I, type IconComponent } from "../../icons";
import { Button, PageHeader } from "../../ui";
import { useAdvisor, useAdvisorInsights, queryKeys } from "../../queries";
import { advisorApi, type ApiAdvisorInsights } from "../../api";
import { Card } from "@backlex/ui/components/card";
import { Tabs, TabsList, TabsTrigger } from "@backlex/ui/components/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@backlex/ui/components/select";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@backlex/ui/components/collapsible";
import { ScrollArea } from "@backlex/ui/components/scroll-area";
import { Skeleton } from "@backlex/ui/components/skeleton";
import { AdvisorSkeleton } from "../../page-skeletons";

type CheckKind = "security" | "performance";
type TabKey = CheckKind | "insights";
type CheckLevel = "error" | "warn" | "info";

interface AdvisorAction {
  type: "create-index";
  table: string;
  indexName: string;
  columns: string[];
  sql: string;
}

interface AdvisorCheck {
  id: string;
  kind: CheckKind;
  level: CheckLevel;
  rule: string;
  groupTitle: string;
  title: string;
  body: string;
  fix: string;
  resource: string;
  link?: string;
  action?: AdvisorAction;
  evidence?: {
    requests: number;
    windowDays: number;
    p95?: number;
    errorRate?: number;
    share?: number;
  };
}

type LevelCounts = { error: number; warn: number; info: number };

const DISMISSED_KEY = "backlex.advisor.dismissed";

/** Selectable aggregation windows for the traffic-derived rules + Insights. */
const WINDOW_DAYS = [1, 7, 30, 90] as const;

/** `12.4%` — the one share format used across findings and the Insights tab. */
const pct = (share: number): string => `${(share * 100).toFixed(1)}%`;

/** error → warn → info, for severity ordering. */
const LEVEL_RANK: Record<CheckLevel, number> = { error: 0, warn: 1, info: 2 };

/** Read the dismissed-finding id set from localStorage (best-effort). */
function loadDismissed(): Set<string> {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return new Set(parsed.filter((v) => typeof v === "string"));
  } catch {
    // localStorage unavailable / malformed — start empty.
  }
  return new Set();
}

/** Persist the dismissed-finding id set to localStorage (best-effort). */
function saveDismissed(ids: Set<string>): void {
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify([...ids]));
  } catch {
    // localStorage unavailable — dismiss stays in-memory for this session.
  }
}

/** A run-level local time string, e.g. "14:32 · May 22". */
function formatGeneratedAt(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const date = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${hh}:${mm} · ${date}`;
}

export function AdvisorPage({ pushToast }: { pushToast: PushToast }) {
  const { t } = useLingui();
  const [tab, setTab] = useState<TabKey>("security");
  const [days, setDays] = useState<number>(7);
  const [dismissed, setDismissed] = useState<Set<string>>(loadDismissed);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data, isLoading, isError, isFetching } = useAdvisor(days);
  // Only fetched once the tab is opened — the aggregation is a full pass over
  // the span window and nobody pays for it until they ask to see it.
  const insights = useAdvisorInsights(days, tab === "insights");
  const checks = useMemo<AdvisorCheck[]>(() => data?.data ?? [], [data]);
  const score = data?.score ?? 100;
  const generatedAt = data?.generatedAt ?? null;
  const runtime = data?.runtime ?? null;

  // Applying a fix removes the finding immediately, then reconciles: the
  // server is the authority on whether the index really landed.
  const applyFix = useMutation({
    mutationFn: (id: string) => advisorApi.apply(id, days),
    onMutate: async (id: string) => {
      await qc.cancelQueries({ queryKey: queryKeys.advisor() });
      const key = queryKeys.advisor(days);
      const prev = qc.getQueryData<typeof data>(key);
      if (prev) {
        qc.setQueryData(key, {
          ...prev,
          data: prev.data.filter((c) => c.id !== id),
        });
      }
      return { key, prev };
    },
    onError: (err, _id, context) => {
      if (context?.prev) qc.setQueryData(context.key, context.prev);
      pushToast(
        err instanceof Error ? err.message : t`Could not apply the fix.`,
        "error",
      );
    },
    onSuccess: (res) => {
      pushToast(t`Created index ${res.applied.indexName}.`);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.advisor() });
    },
  });

  const dismiss = (id: string, title: string) => {
    setDismissed((prev) => {
      const next = new Set(prev);
      next.add(id);
      saveDismissed(next);
      return next;
    });
    pushToast(t`Dismissed "${title}".`);
  };

  const all = useMemo(
    () => checks.filter((c) => !dismissed.has(c.id)),
    [checks, dismissed],
  );
  const list = useMemo(
    () => (tab === "insights" ? [] : all.filter((c) => c.kind === tab)),
    [all, tab],
  );

  const counts = useMemo(() => {
    const out: Record<CheckKind, LevelCounts> = {
      security: { error: 0, warn: 0, info: 0 },
      performance: { error: 0, warn: 0, info: 0 },
    };
    for (const c of all) out[c.kind][c.level]++;
    return out;
  }, [all]);

  const windowSelect = (
    <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
      <SelectTrigger size="sm" className="min-w-0 w-[124px]" aria-label={t`Traffic window`}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {WINDOW_DAYS.map((d) => (
          <SelectItem key={d} value={String(d)}>
            {d === 1 ? t`Last 24 hours` : t`Last ${d} days`}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  // Group the visible findings by `rule`, preserving severity order: each
  // group inherits the rank of its worst finding so groups + singletons sort
  // together. Individual findings still drive every count.
  const groups = useMemo(() => {
    const byRule = new Map<string, AdvisorCheck[]>();
    for (const c of list) {
      const arr = byRule.get(c.rule);
      if (arr) arr.push(c);
      else byRule.set(c.rule, [c]);
    }
    const result = [...byRule.values()].map((items) => {
      const sorted = [...items].sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level]);
      const worst = sorted[0]!;
      return { rule: worst.rule, items: sorted, worst };
    });
    result.sort((a, b) => LEVEL_RANK[a.worst.level] - LEVEL_RANK[b.worst.level]);
    return result;
  }, [list]);

  // Hidden on narrow screens: with three tabs the badges push "Insights" off
  // the strip at 390px, and the summary tiles directly above already carry the
  // same per-category counts.
  const countCls =
    "rounded-sm border border-border bg-muted px-[5px] py-px font-mono text-[11px] text-muted-foreground max-[420px]:hidden";

  const onCopy = (fix: string) => {
    try {
      void navigator.clipboard.writeText(fix);
      pushToast(t`Fix copied to clipboard.`);
    } catch {
      pushToast(t`Could not copy fix.`, "error");
    }
  };

  // First whole-page fetch — advisor findings haven't landed yet.
  if (isLoading) return <AdvisorSkeleton />;

  return (
    <div className="flex flex-col gap-4.5">
      <PageHeader
        title={t`Advisor`}
        description={t`Automated lint over schema, permissions, and configuration. Runs on demand against live workspace state.`}
        actions={
          <div className="flex items-center gap-2">
            {windowSelect}
            <Button
              variant="outline"
              icon={I.Refresh}
              disabled={isFetching}
              onClick={() => {
                void qc
                  .invalidateQueries({ queryKey: queryKeys.advisor() })
                  .then(() => pushToast(t`Advisor re-ran.`));
              }}
            >
              {isFetching ? <Trans>Re-running…</Trans> : <Trans>Re-run all</Trans>}
            </Button>
          </div>
        }
      />

      {/* Score card */}
      <Card className="grid grid-cols-[160px_1fr] max-[640px]:grid-cols-1 max-[640px]:justify-items-center items-center gap-[22px] p-5">
        <div className="relative size-[140px]">
          <ScoreRing score={score} />
          <div className="absolute inset-0 grid place-items-center text-center">
            <div>
              <div className="font-mono text-[36px] font-semibold tabular-nums tracking-[-0.02em]">
                {score}
              </div>
              <div className="text-[10.5px] uppercase tracking-[0.06em] text-muted-foreground">
                <Trans>health</Trans>
              </div>
            </div>
          </div>
        </div>
        <div className="flex flex-col gap-3.5">
          <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
            <SummaryCard
              counts={counts.security}
              active={tab === "security"}
              onClick={() => setTab("security")}
              icon={I.ShieldAlert}
              label={t`Security`}
            />
            <SummaryCard
              counts={counts.performance}
              active={tab === "performance"}
              onClick={() => setTab("performance")}
              icon={I.Cpu}
              label={t`Performance`}
            />
          </div>
          <div className="flex flex-col gap-1">
            {generatedAt && (
              <div className="text-[11.5px] text-muted-foreground">
                <Trans>Last run: {formatGeneratedAt(generatedAt)}</Trans>
              </div>
            )}
            {runtime && <RuntimeNote runtime={runtime} />}
          </div>
        </div>
      </Card>

      <Tabs value={tab} onValueChange={(v) => setTab(v as TabKey)}>
        <TabsList>
          <TabsTrigger value="security">
            <I.ShieldAlert size={13} /><Trans>Security</Trans>{" "}
            <span className={countCls}>{counts.security.error + counts.security.warn + counts.security.info}</span>
          </TabsTrigger>
          <TabsTrigger value="performance">
            <I.Cpu size={13} /><Trans>Performance</Trans>{" "}
            <span className={countCls}>{counts.performance.error + counts.performance.warn + counts.performance.info}</span>
          </TabsTrigger>
          <TabsTrigger value="insights">
            <I.Activity size={13} /><Trans>Insights</Trans>
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {tab === "insights" ? (
        <InsightsPanel
          query={insights}
          days={days}
          onOpenCollection={(slug) => navigate(`/collections/${slug}`)}
        />
      ) : (
      /* Findings */
      <div className="flex flex-col gap-2.5">
        {isError ? (
          <Card className="items-center gap-3 px-6 py-12 text-center">
            <div className="grid size-10 place-items-center rounded-control bg-muted text-primary"><I.AlertTriangle size={18} /></div>
            <h4 className="m-0 text-[15px] font-semibold"><Trans>Couldn't load advisor findings</Trans></h4>
            <p className="m-0 max-w-[360px] text-[13px] text-muted-foreground"><Trans>The advisor endpoint returned an error. Re-run to try again.</Trans></p>
          </Card>
        ) : list.length === 0 ? (
          <Card className="items-center gap-3 px-6 py-12 text-center">
            <div className="grid size-10 place-items-center rounded-control bg-muted text-primary"><I.CheckCircle size={18} /></div>
            <h4 className="m-0 text-[15px] font-semibold"><Trans>All clear in this category</Trans></h4>
            <p className="m-0 max-w-[360px] text-[13px] text-muted-foreground"><Trans>No outstanding findings. Re-run after a schema or permission change.</Trans></p>
          </Card>
        ) : (
          groups.map((g) =>
            g.items.length === 1 ? (
              <AdvisorRow
                key={g.items[0]!.id}
                c={g.items[0]!}
                onDismiss={() => dismiss(g.items[0]!.id, g.items[0]!.title)}
                onCopy={() => onCopy(g.items[0]!.fix)}
                onOpen={g.items[0]!.link ? () => navigate(g.items[0]!.link!) : undefined}
                onApply={() => applyFix.mutate(g.items[0]!.id)}
                applying={applyFix.isPending && applyFix.variables === g.items[0]!.id}
              />
            ) : (
              <AdvisorGroup
                key={g.rule}
                title={g.worst.groupTitle}
                level={g.worst.level}
                items={g.items}
                onDismiss={dismiss}
                onCopy={onCopy}
                onOpen={(link) => navigate(link)}
                onApply={(id) => applyFix.mutate(id)}
                applyingId={applyFix.isPending ? (applyFix.variables ?? null) : null}
              />
            ),
          )
        )}
      </div>
      )}
    </div>
  );
}

/** One line saying what the traffic-derived rules had to work with. Rendered
 *  always — "no findings" with zero spans means something different from "no
 *  findings" with 40k spans, and the page should not let those look alike. */
function RuntimeNote({
  runtime,
}: {
  runtime: { windowDays: number; spanCount: number; sampleRate: number; truncated: boolean };
}) {
  if (runtime.spanCount === 0) {
    return (
      <div className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
        <I.Info size={12} />
        <Trans>
          No request spans recorded in the last {runtime.windowDays} day(s) — the
          traffic-derived rules had nothing to measure.
        </Trans>
      </div>
    );
  }
  return (
    <div className="text-[11.5px] text-muted-foreground">
      <Trans>
        Traffic rules read {runtime.spanCount} span(s) over {runtime.windowDays} day(s).
      </Trans>
      {runtime.sampleRate < 1 && (
        <>
          {" "}
          <Trans>Spans are sampled at {pct(runtime.sampleRate)}, so counts describe a sample.</Trans>
        </>
      )}
      {runtime.truncated && (
        <>
          {" "}
          <Trans>Only the most recent spans in the window were aggregated.</Trans>
        </>
      )}
    </div>
  );
}

function SummaryCard({
  counts,
  active,
  onClick,
  icon: IconComp,
  label,
}: {
  counts: LevelCounts;
  active: boolean;
  onClick: () => void;
  icon: IconComponent;
  label: string;
}) {
  return (
    <button type="button" onClick={onClick} className={`flex cursor-pointer flex-col rounded-control border px-4 py-3.5 text-left hover:bg-accent ${active ? "border-[color-mix(in_oklch,var(--foreground)_30%,var(--border))] bg-accent" : "border-border bg-card"}`}>
      <div className="mb-2.5 flex items-center gap-2">
        <IconComp size={15} />
        <span className="text-[13px] font-medium">{label}</span>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        <span className="flex items-center gap-1.5 text-xs">
          <span className="inline-block size-2 rounded-full bg-destructive" />
          <span className="font-mono tabular-nums">{counts.error}</span>
          <span className="text-muted-foreground"><Trans>err</Trans></span>
        </span>
        <span className="flex items-center gap-1.5 text-xs">
          <span className="inline-block size-2 rounded-full bg-[oklch(0.7_0.18_70)]" />
          <span className="font-mono tabular-nums">{counts.warn}</span>
          <span className="text-muted-foreground"><Trans>warn</Trans></span>
        </span>
        <span className="flex items-center gap-1.5 text-xs">
          <span className="inline-block size-2 rounded-full bg-muted-foreground" />
          <span className="font-mono tabular-nums">{counts.info}</span>
          <span className="text-muted-foreground"><Trans>info</Trans></span>
        </span>
      </div>
    </button>
  );
}

function ScoreRing({ score }: { score: number }) {
  const R = 60;
  const C = 2 * Math.PI * R;
  const off = C - (C * score) / 100;
  const color = score >= 80 ? "var(--primary)" : score >= 50 ? "oklch(0.75 0.18 70)" : "var(--destructive)";
  return (
    <svg width={140} height={140} viewBox="0 0 140 140">
      <circle cx="70" cy="70" r={R} fill="none" stroke="var(--muted)" strokeWidth="10" />
      <circle
        cx="70"
        cy="70"
        r={R}
        fill="none"
        stroke={color}
        strokeWidth="10"
        strokeLinecap="round"
        strokeDasharray={C}
        strokeDashoffset={off}
        transform="rotate(-90 70 70)"
      />
    </svg>
  );
}

/**
 * Insights tab — the raw span aggregation the traffic rules are computed from.
 *
 * Two tables: slowest endpoints, and per-collection list traffic with the
 * columns it filters / sorts on. Both scroll horizontally inside their own
 * ScrollArea so a long route or column list never pushes the page sideways on
 * a phone.
 */
function InsightsPanel({
  query,
  days,
  onOpenCollection,
}: {
  query: {
    data?: ApiAdvisorInsights;
    isLoading: boolean;
    isError: boolean;
  };
  days: number;
  onOpenCollection: (slug: string) => void;
}) {
  if (query.isLoading) return <InsightsTabSkeleton />;
  if (query.isError || !query.data) {
    return (
      <Card className="items-center gap-3 px-6 py-12 text-center">
        <div className="grid size-10 place-items-center rounded-control bg-muted text-primary"><I.AlertTriangle size={18} /></div>
        <h4 className="m-0 text-[15px] font-semibold"><Trans>Couldn't load runtime insights</Trans></h4>
        <p className="m-0 max-w-[360px] text-[13px] text-muted-foreground">
          <Trans>The insights endpoint returned an error. Re-run to try again.</Trans>
        </p>
      </Card>
    );
  }

  const { endpoints, collections, window: win } = query.data;

  if (win.spanCount === 0) {
    return (
      <Card className="items-center gap-3 px-6 py-12 text-center">
        <div className="grid size-10 place-items-center rounded-control bg-muted text-primary"><I.Activity size={18} /></div>
        <h4 className="m-0 text-[15px] font-semibold"><Trans>No traffic recorded yet</Trans></h4>
        <p className="m-0 max-w-[400px] text-[13px] text-muted-foreground">
          <Trans>
            Nothing was recorded in the last {days} day(s). Request spans appear
            here once the API serves traffic, unless `TRACES_SAMPLE_RATE` is 0
            or span retention already pruned this window.
          </Trans>
        </p>
      </Card>
    );
  }

  // Span retention can cut the window short — say so rather than letting an
  // empty stretch read as "no traffic then".
  const retentionCut =
    win.oldestSpanAt !== null && win.oldestSpanAt - win.from > 24 * 60 * 60 * 1000;

  const th = "px-3 py-2 text-left text-[11px] font-medium uppercase tracking-[0.05em] text-muted-foreground";
  const td = "px-3 py-2 text-[12.5px]";
  const num = `${td} text-right font-mono tabular-nums`;

  return (
    <div className="flex flex-col gap-2.5">
      {retentionCut && (
        <div className="flex items-start gap-2 rounded-surface border border-border bg-muted px-3.5 py-2.5 text-[12px] text-muted-foreground">
          <I.Info size={13} className="mt-px shrink-0" />
          <span>
            <Trans>
              The oldest recorded span is newer than the start of this window —
              span retention, not traffic, is what bounds it.
            </Trans>
          </span>
        </div>
      )}

      <Card className="gap-0 p-0">
        <div className="border-b border-border px-4 py-3">
          <h4 className="m-0 text-[13.5px] font-semibold"><Trans>Slowest endpoints</Trans></h4>
          <p className="m-0 mt-0.5 text-[11.5px] text-muted-foreground">
            <Trans>
              By p95 over {win.spanCount} recorded span(s). Counts are spans
              seen, never extrapolated.
            </Trans>
          </p>
        </div>
        <ScrollArea className="w-full">
          <table className="w-full min-w-[560px] border-collapse">
            <thead>
              <tr className="border-b border-border">
                <th className={th}><Trans>Endpoint</Trans></th>
                <th className={`${th} text-right`}><Trans>Reqs</Trans></th>
                <th className={`${th} text-right`}>p50</th>
                <th className={`${th} text-right`}>p95</th>
                <th className={`${th} text-right`}>p99</th>
                <th className={`${th} text-right`}><Trans>5xx</Trans></th>
              </tr>
            </thead>
            <tbody>
              {endpoints.map((e) => (
                <tr key={e.route} className="border-b border-dashed border-border last:border-b-0">
                  {/* nowrap: the ScrollArea handles width, so a long route
                      scrolls rather than wrapping to two lines. */}
                  <td className={`${td} whitespace-nowrap font-mono text-[11.5px]`}>{e.route}</td>
                  <td className={num}>{e.requests}</td>
                  <td className={num}>{e.p50}</td>
                  <td className={`${num} ${e.p95 >= 500 ? "text-[oklch(0.55_0.18_70)] dark:text-[oklch(0.85_0.18_70)]" : ""}`}>
                    {e.p95}
                  </td>
                  <td className={num}>{e.p99}</td>
                  <td className={`${num} ${e.serverErrors > 0 ? "text-destructive" : "text-muted-foreground"}`}>
                    {e.serverErrors > 0 ? pct(e.errorRate) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollArea>
      </Card>

      <Card className="gap-0 p-0">
        <div className="border-b border-border px-4 py-3">
          <h4 className="m-0 text-[13.5px] font-semibold"><Trans>Collection list traffic</Trans></h4>
          <p className="m-0 mt-0.5 text-[11.5px] text-muted-foreground">
            <Trans>
              Which columns real list requests filter and sort on — the input
              behind the missing-index findings.
            </Trans>
          </p>
        </div>
        {collections.length === 0 ? (
          <div className="px-4 py-6 text-center text-[12.5px] text-muted-foreground">
            <Trans>No item-list requests recorded in this window.</Trans>
          </div>
        ) : (
          <ScrollArea className="w-full">
            <table className="w-full min-w-[560px] border-collapse">
              <thead>
                <tr className="border-b border-border">
                  <th className={th}><Trans>Collection</Trans></th>
                  <th className={`${th} text-right`}><Trans>Lists</Trans></th>
                  <th className={`${th} text-right`}>p95</th>
                  <th className={th}><Trans>Filtered by</Trans></th>
                  <th className={th}><Trans>Sorted by</Trans></th>
                </tr>
              </thead>
              <tbody>
                {collections.map((c) => (
                  <tr key={c.collection} className="border-b border-dashed border-border last:border-b-0">
                    <td className={td}>
                      <button
                        type="button"
                        className="cursor-pointer border-0 bg-transparent p-0 text-left font-medium text-foreground underline-offset-2 hover:underline"
                        onClick={() => onOpenCollection(c.collection)}
                      >
                        {c.collection}
                      </button>
                    </td>
                    <td className={num}>{c.listRequests}</td>
                    <td className={num}>{c.p95}</td>
                    <td className={td}><ColumnUses uses={c.filters} /></td>
                    <td className={td}><ColumnUses uses={c.sorts} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollArea>
        )}
      </Card>
    </div>
  );
}

/** Top few columns with their share of the collection's list traffic. */
function ColumnUses({ uses }: { uses: { column: string; share: number }[] }) {
  if (uses.length === 0) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {uses.slice(0, 3).map((u) => (
        <span
          key={u.column}
          className="rounded-sm border border-border bg-muted px-1.5 py-px font-mono text-[11px]"
        >
          {u.column} <span className="text-muted-foreground">{pct(u.share)}</span>
        </span>
      ))}
      {uses.length > 3 && (
        <span className="px-1 py-px text-[11px] text-muted-foreground">
          +{uses.length - 3}
        </span>
      )}
    </span>
  );
}

/** Two table cards — matches InsightsPanel's layout so the swap doesn't jump. */
function InsightsTabSkeleton() {
  return (
    <div className="flex flex-col gap-2.5">
      {Array.from({ length: 2 }).map((_, card) => (
        <Card key={card} className="gap-0 p-0">
          <div className="flex flex-col gap-1.5 border-b border-border px-4 py-3">
            <Skeleton className="h-3.5 w-40" />
            <Skeleton className="h-2.5 w-64 max-w-full" />
          </div>
          <div className="flex flex-col gap-2 px-4 py-3">
            {Array.from({ length: 5 }).map((_, row) => (
              <Skeleton key={row} className="h-4 w-full" />
            ))}
          </div>
        </Card>
      ))}
    </div>
  );
}

/** Severity-driven icon + border/icon tints, shared by rows and groups. */
function levelStyles(level: CheckLevel) {
  const Icon = level === "error" ? I.AlertTriangle : level === "warn" ? I.AlertCircle : I.Info;
  const border = level === "error"
    ? "border-[color-mix(in_oklch,var(--destructive)_28%,var(--border))]"
    : level === "warn"
      ? "border-[color-mix(in_oklch,oklch(0.7_0.18_70)_30%,var(--border))]"
      : "border-border";
  const ico = level === "error"
    ? "bg-[color-mix(in_oklch,var(--destructive)_16%,var(--card))] text-destructive"
    : level === "warn"
      ? "bg-[color-mix(in_oklch,oklch(0.75_0.18_70)_18%,var(--card))] text-[oklch(0.55_0.18_70)] dark:text-[oklch(0.85_0.18_70)]"
      : "bg-muted text-muted-foreground";
  return { Icon, border, ico };
}

/** The expanded detail body of a single finding — shared by the standalone
 *  row and the per-finding entries inside a group. */
function FindingDetail({
  c,
  onDismiss,
  onCopy,
  onOpen,
  onApply,
  applying,
}: {
  c: AdvisorCheck;
  onDismiss: () => void;
  onCopy: () => void;
  onOpen?: () => void;
  onApply?: () => void;
  applying?: boolean;
}) {
  return (
    <div className="flex flex-col gap-3 border-t border-dashed border-border px-4 pb-4 pl-[60px] pt-1">
      <p className="m-0 text-[13px] text-foreground">{c.body}</p>
      {c.evidence && <EvidenceChips evidence={c.evidence} />}
      <div>
        <div className="mb-1.5 text-[11px] uppercase tracking-[0.05em] text-muted-foreground">
          <Trans>suggested fix</Trans>
        </div>
        <ScrollArea className="rounded-surface"><pre className="m-0 whitespace-pre rounded-surface bg-muted px-3 py-2.5 font-mono text-[11.5px]">{c.fix}</pre></ScrollArea>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {onApply && c.action && (
          <Button size="sm" icon={I.Zap} disabled={applying} onClick={onApply}>
            {applying ? <Trans>Applying…</Trans> : <Trans>Apply fix</Trans>}
          </Button>
        )}
        <Button variant="outline" size="sm" icon={I.Copy} onClick={onCopy}>
          <Trans>Copy fix</Trans>
        </Button>
        <Button variant="ghost" size="sm" onClick={onDismiss}>
          <Trans>Dismiss</Trans>
        </Button>
        <div className="flex-1" />
        {onOpen && (
          <Button variant="ghost" size="sm" iconRight={I.ExternalLink} onClick={onOpen}>
            <Trans>Open resource</Trans>
          </Button>
        )}
      </div>
    </div>
  );
}

/** The measured numbers behind a traffic-derived finding, so the reader can
 *  judge the advice instead of taking it on faith. */
function EvidenceChips({
  evidence,
}: {
  evidence: NonNullable<AdvisorCheck["evidence"]>;
}) {
  const chip = "rounded-sm border border-border bg-muted px-1.5 py-px font-mono text-[11px]";
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[11px] uppercase tracking-[0.05em] text-muted-foreground">
        <Trans>measured</Trans>
      </span>
      <span className={chip}>
        <Trans>{evidence.requests} req / {evidence.windowDays}d</Trans>
      </span>
      {evidence.p95 !== undefined && <span className={chip}>p95 {evidence.p95}ms</span>}
      {evidence.errorRate !== undefined && (
        <span className={chip}>
          <Trans>5xx {pct(evidence.errorRate)}</Trans>
        </span>
      )}
      {evidence.share !== undefined && (
        <span className={chip}>
          <Trans>{pct(evidence.share)} of lists</Trans>
        </span>
      )}
    </div>
  );
}

function AdvisorRow({
  c,
  onDismiss,
  onCopy,
  onOpen,
  onApply,
  applying,
}: {
  c: AdvisorCheck;
  onDismiss: () => void;
  onCopy: () => void;
  onOpen?: () => void;
  onApply?: () => void;
  applying?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { Icon, border, ico } = levelStyles(c.level);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className={`overflow-hidden rounded-surface border bg-card ${border}`}>
      <CollapsibleTrigger asChild>
        <button type="button" className="grid w-full cursor-pointer grid-cols-[32px_1fr_auto_16px] max-[640px]:grid-cols-[32px_1fr_16px] items-center gap-3 border-0 bg-transparent px-4 py-3 text-left hover:bg-accent">
          <span className={`grid size-7 place-items-center rounded-control ${ico}`}><Icon size={14} /></span>
          <span className="min-w-0 truncate text-[13.5px] font-medium">{c.title}</span>
          <span className="font-mono text-[11.5px] text-muted-foreground max-[640px]:hidden">{c.resource}</span>
          <I.ChevronDown size={12} className="text-muted-foreground transition-transform data-[open=true]:rotate-180" data-open={open} />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <FindingDetail
          c={c}
          onDismiss={onDismiss}
          onCopy={onCopy}
          onOpen={onOpen}
          onApply={onApply}
          applying={applying}
        />
      </CollapsibleContent>
    </Collapsible>
  );
}

/** A collapsible group of findings that share a `rule`. The header shows the
 *  category label + a count badge + the worst severity icon; expanding lists
 *  each individual finding. */
function AdvisorGroup({
  title,
  level,
  items,
  onDismiss,
  onCopy,
  onOpen,
  onApply,
  applyingId,
}: {
  title: string;
  level: CheckLevel;
  items: AdvisorCheck[];
  onDismiss: (id: string, title: string) => void;
  onCopy: (fix: string) => void;
  onOpen: (link: string) => void;
  onApply: (id: string) => void;
  /** Finding currently being applied, so only that row shows a busy state. */
  applyingId: string | null;
}) {
  const [open, setOpen] = useState(false);
  const { Icon, border, ico } = levelStyles(level);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className={`overflow-hidden rounded-surface border bg-card ${border}`}>
      <CollapsibleTrigger asChild>
        <button type="button" className="grid w-full cursor-pointer grid-cols-[32px_1fr_auto_16px] items-center gap-3 border-0 bg-transparent px-4 py-3 text-left hover:bg-accent">
          <span className={`grid size-7 place-items-center rounded-control ${ico}`}><Icon size={14} /></span>
          <span className="min-w-0 truncate text-[13.5px] font-medium">{title}</span>
          <span className="rounded-sm border border-border bg-muted px-[6px] py-px font-mono text-[11px] text-muted-foreground">{items.length}</span>
          <I.ChevronDown size={12} className="text-muted-foreground transition-transform data-[open=true]:rotate-180" data-open={open} />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="flex flex-col border-t border-dashed border-border">
          {items.map((c) => (
            <GroupedFinding
              key={c.id}
              c={c}
              onDismiss={() => onDismiss(c.id, c.title)}
              onCopy={() => onCopy(c.fix)}
              onOpen={c.link ? () => onOpen(c.link!) : undefined}
              onApply={() => onApply(c.id)}
              applying={applyingId === c.id}
            />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** A single finding rendered inside a group — its own nested collapsible so
 *  each finding's specific title / resource / body / fix stays addressable. */
function GroupedFinding({
  c,
  onDismiss,
  onCopy,
  onOpen,
  onApply,
  applying,
}: {
  c: AdvisorCheck;
  onDismiss: () => void;
  onCopy: () => void;
  onOpen?: () => void;
  onApply?: () => void;
  applying?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { Icon, ico } = levelStyles(c.level);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="border-b border-dashed border-border last:border-b-0">
      <CollapsibleTrigger asChild>
        <button type="button" className="grid w-full cursor-pointer grid-cols-[32px_1fr_auto_16px] max-[640px]:grid-cols-[32px_1fr_16px] items-center gap-3 border-0 bg-transparent px-4 py-2.5 pl-7 text-left hover:bg-accent">
          <span className={`grid size-6 place-items-center rounded-control ${ico}`}><Icon size={12} /></span>
          <span className="min-w-0 truncate text-[13px]">{c.title}</span>
          <span className="font-mono text-[11px] text-muted-foreground max-[640px]:hidden">{c.resource}</span>
          <I.ChevronDown size={11} className="text-muted-foreground transition-transform data-[open=true]:rotate-180" data-open={open} />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <FindingDetail
          c={c}
          onDismiss={onDismiss}
          onCopy={onCopy}
          onOpen={onOpen}
          onApply={onApply}
          applying={applying}
        />
      </CollapsibleContent>
    </Collapsible>
  );
}
