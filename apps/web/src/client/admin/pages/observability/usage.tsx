// Usage page — the metering dashboard over GET /api/admin/usage/overview.
//
// Four stat tiles (requests / errors / storage / rows, each with its limit
// bar when one is set), a per-day request chart, the per-key month table
// (with inline limit editing), and the workspace limits editor. Limits saved
// here are the `usageLimits` app-setting; fields pinned by `USAGE_LIMIT_*`
// env vars render read-only — the platform plan wins at enforcement time.
import type { PushToast } from "../../types";
import { useMemo, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { useQueryClient } from "@tanstack/react-query";
import { I } from "../../icons";
import { Badge, Button, EmptyState, PageHeader } from "../../ui";
import { Select } from "../../select";
import { Input } from "@backlex/ui/components/input";
import { Card } from "@backlex/ui/components/card";
import {
  Dialog,
  DialogBody,
  DialogContent,
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
  usageApi,
  type ApiUsageLimits,
  type ApiUsageOverview,
} from "../../api";
import { queryKeys, useUsageOverview } from "../../queries";
import { UsageSkeleton } from "../../page-skeletons";
import { Skeleton } from "@backlex/ui/components/skeleton";

const fmtBytes = (n: number | null): string => {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
};

const fmtCount = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : String(n);

/** Progress toward a limit; >100% clamps and tints destructive. */
function LimitBar({ used, limit }: { used: number; limit: number }) {
  const pct = Math.min(100, (used / limit) * 100);
  const over = used >= limit;
  return (
    <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <div
        className={`h-full rounded-full ${over ? "bg-destructive" : pct >= 80 ? "bg-amber-500" : "bg-primary"}`}
        style={{ width: `${Math.max(2, pct)}%` }}
      />
    </div>
  );
}

/** Per-day request bars with the error slice stacked in red on top. */
function DayChart({ series }: { series: ApiUsageOverview["series"] }) {
  const max = Math.max(1, ...series.map((p) => p.requests));
  const h = 120;
  const gap = 2;
  const n = series.length;
  const w = 600;
  const bw = Math.max(2, (w - gap * (n - 1)) / Math.max(1, n));
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="block h-[120px] w-full">
      {series.map((p, i) => {
        const x = i * (bw + gap);
        const bh = Math.max(p.requests > 0 ? 2 : 0, (p.requests / max) * (h - 4));
        const eh = p.requests > 0 ? (p.errors / p.requests) * bh : 0;
        return (
          <g key={p.day}>
            <rect x={x} y={h - bh} width={bw} height={bh} rx="1.5" fill="var(--primary)" opacity="0.75">
              <title>{`${p.day} — ${p.requests} req, ${p.errors} err`}</title>
            </rect>
            {eh > 0.5 && (
              <rect x={x} y={h - bh} width={bw} height={eh} rx="1.5" fill="var(--destructive)" />
            )}
          </g>
        );
      })}
    </svg>
  );
}

const WINDOWS = ["7", "30", "90"] as const;

export function UsagePage({
  pushToast,
}: {
  pushToast: PushToast;
}) {
  const { t } = useLingui();
  const [days, setDays] = useState(30);
  const { data, isLoading, isError, refetch, isFetching } = useUsageOverview(days);
  const overview = data?.data;

  const [limitsOpen, setLimitsOpen] = useState(false);
  const [editKey, setEditKey] = useState<ApiUsageOverview["byKey"][number] | null>(null);
  // Chart consumer filter — "all", "session" (the ""-id bucket), or "k:<id>".
  const [chartKey, setChartKey] = useState("all");

  const consumerOptions = useMemo(() => {
    const opts = [{ value: "all", label: t`All consumers` }];
    for (const k of overview?.byKey ?? [])
      opts.push({
        value: k.id === "" ? "session" : `k:${k.id}`,
        label: k.id === "" ? t`Sessions & admin` : k.name,
      });
    return opts;
  }, [overview, t]);

  // Pad the series so the chart always spans the whole window even when only
  // a few days have traffic (rows only exist for days with requests). With a
  // consumer selected, the per-key day points feed the same padding.
  const paddedSeries = useMemo(() => {
    if (!overview) return [];
    const src =
      chartKey === "all"
        ? overview.series
        : overview.keySeries.filter(
            (p) => p.apiKeyId === (chartKey === "session" ? "" : chartKey.slice(2)),
          );
    const byDay = new Map(src.map((p) => [p.day, p]));
    const out: ApiUsageOverview["series"] = [];
    for (let i = days - 1; i >= 0; i--) {
      const day = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
      const p = byDay.get(day);
      out.push(p ? { day, requests: p.requests, errors: p.errors } : { day, requests: 0, errors: 0 });
    }
    return out;
  }, [overview, days, chartKey]);

  // Month-to-date is the natural billing window; the server defaults match.
  const exportCsv = () => {
    const a = document.createElement("a");
    a.href = "/api/admin/usage/export?format=csv";
    a.download = "";
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const limits = overview?.limits;
  const over = overview?.over ?? [];

  if (isLoading && !overview) return <UsageSkeleton />;

  return (
    <div className="flex flex-col gap-4.5">
      <PageHeader
        title={t`Usage`}
        description={t`Metered API traffic per workspace and API key, storage and row footprints, and the plan limits enforced against them.`}
        actions={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Select
              size="sm"
              value={String(days)}
              onChange={(v) => setDays(Number(v))}
              options={WINDOWS.map((d) => ({ value: d, label: t`${d} days` }))}
              className="w-[110px]"
            />
            <Button variant="outline" icon={I.Download} onClick={exportCsv}>
              <Trans>Export</Trans>
            </Button>
            <Button variant="outline" icon={I.Settings} onClick={() => setLimitsOpen(true)}>
              <Trans>Limits</Trans>
            </Button>
            <Button
              variant="outline"
              icon={I.Refresh}
              disabled={isFetching}
              onClick={() => {
                void refetch().then(() => pushToast(t`Usage refreshed.`));
              }}
            >
              <Trans>Refresh</Trans>
            </Button>
          </div>
        }
      />

      {limits && limits.mode !== "off" && over.length > 0 && (
        <Card className="flex-row items-center gap-3 border-destructive/40 bg-destructive/5 px-4 py-3">
          <I.AlertTriangle size={16} className="shrink-0 text-destructive" />
          <p className="m-0 text-[13px]">
            {limits.mode === "hard" ? (
              <Trans>Over limit: {over.join(", ")}. Hard enforcement is on — over-budget traffic is being rejected.</Trans>
            ) : (
              <Trans>Over limit: {over.join(", ")}. Soft mode — nothing is blocked, but the budget is exhausted.</Trans>
            )}
          </p>
        </Card>
      )}

      {isError ? (
        <Card className="items-center gap-3 px-6 py-12 text-center">
          <div className="grid size-10 place-items-center rounded-control bg-muted text-primary">
            <I.AlertTriangle size={18} />
          </div>
          <h4 className="m-0 text-[15px] font-semibold">
            <Trans>Couldn't load usage</Trans>
          </h4>
          <p className="m-0 max-w-[360px] text-[13px] text-muted-foreground">
            <Trans>The usage endpoint returned an error. Refresh to try again.</Trans>
          </p>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile
              label={t`Requests · ${overview?.month ?? ""}`}
              value={overview ? fmtCount(overview.monthTotals.requests) : "—"}
              sub={
                limits?.maxRequestsPerMonth != null
                  ? t`of ${fmtCount(limits.maxRequestsPerMonth)}`
                  : t`no limit`
              }
              over={over.includes("requests")}
              bar={
                limits?.maxRequestsPerMonth != null && overview ? (
                  <LimitBar used={overview.monthTotals.requests} limit={limits.maxRequestsPerMonth} />
                ) : null
              }
            />
            <StatTile
              label={t`Errors · ${overview?.month ?? ""}`}
              value={overview ? fmtCount(overview.monthTotals.errors) : "—"}
              sub={t`5xx responses`}
              over={false}
              bar={null}
            />
            <StatTile
              label={t`Storage`}
              value={fmtBytes(overview?.gauges.storageBytes ?? null)}
              sub={
                limits?.maxStorageBytes != null
                  ? t`of ${fmtBytes(limits.maxStorageBytes)}`
                  : t`no limit`
              }
              over={over.includes("storage")}
              bar={
                limits?.maxStorageBytes != null && overview?.gauges.storageBytes != null ? (
                  <LimitBar used={overview.gauges.storageBytes} limit={limits.maxStorageBytes} />
                ) : null
              }
            />
            <StatTile
              label={t`Rows`}
              value={overview?.gauges.dbRows == null ? "—" : fmtCount(overview.gauges.dbRows)}
              sub={
                limits?.maxDbRows != null ? t`of ${fmtCount(limits.maxDbRows)}` : t`no limit`
              }
              over={over.includes("rows")}
              bar={
                limits?.maxDbRows != null && overview?.gauges.dbRows != null ? (
                  <LimitBar used={overview.gauges.dbRows} limit={limits.maxDbRows} />
                ) : null
              }
            />
          </div>

          <Card className="gap-2 px-4 py-3.5">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                  <Trans>Requests per day</Trans>
                </div>
                {overview?.gauges.measuredAt != null && (
                  <div className="hidden text-[11px] text-muted-foreground sm:block">
                    <Trans>gauges measured {new Date(overview.gauges.measuredAt).toLocaleString()}</Trans>
                  </div>
                )}
              </div>
              <Select
                value={chartKey}
                onChange={setChartKey}
                options={consumerOptions}
                className="w-[170px] shrink-0"
              />
            </div>
            {isLoading || !overview ? (
              <Skeleton className="h-[120px] w-full" />
            ) : paddedSeries.every((p) => p.requests === 0) ? (
              <EmptyState
                bare
                icon={I.Gauge}
                title={chartKey === "all" ? t`No metered traffic yet` : t`No traffic for this consumer`}
                description={
                  chartKey === "all"
                    ? t`Requests are counted per workspace and API key as they arrive. Make an API call, then refresh.`
                    : t`This consumer has no metered requests in the selected window.`
                }
              />
            ) : (
              <DayChart series={paddedSeries} />
            )}
          </Card>

          {overview && overview.byKey.length > 0 && (
            <Card className="gap-0 overflow-hidden p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>
                      <Trans>Consumer</Trans>
                    </TableHead>
                    <TableHead className="w-[110px] text-right">
                      <Trans>Requests</Trans>
                    </TableHead>
                    <TableHead className="hidden w-[90px] text-right sm:table-cell">
                      <Trans>Errors</Trans>
                    </TableHead>
                    <TableHead className="hidden w-[110px] text-right sm:table-cell">
                      <Trans>Rate/min</Trans>
                    </TableHead>
                    <TableHead className="w-[140px] text-right">
                      <Trans>Quota</Trans>
                    </TableHead>
                    <TableHead className="w-[60px]" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {overview.byKey.map((k) => (
                    <TableRow key={k.id || "__session"}>
                      <TableCell>
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="truncate font-medium">
                            {k.id === "" ? <Trans>Sessions & admin</Trans> : k.name}
                          </span>
                          {k.prefix && (
                            <span className="hidden shrink-0 font-mono text-[11px] text-muted-foreground sm:inline">
                              {k.prefix}
                            </span>
                          )}
                          {k.revoked && (
                            <Badge variant="outline" className="shrink-0 text-[10px]">
                              <Trans>revoked</Trans>
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {fmtCount(k.monthRequests)}
                      </TableCell>
                      <TableCell className="hidden text-right tabular-nums sm:table-cell">
                        {fmtCount(k.monthErrors)}
                      </TableCell>
                      <TableCell className="hidden text-right tabular-nums text-muted-foreground sm:table-cell">
                        {k.rateLimitPerMinute ?? "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        {k.monthlyQuota == null ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          <div className="flex flex-col items-end">
                            <span
                              className={`tabular-nums ${k.monthRequests >= k.monthlyQuota ? "text-destructive" : ""}`}
                            >
                              {fmtCount(k.monthRequests)} / {fmtCount(k.monthlyQuota)}
                            </span>
                            <div className="mt-1 h-1 w-20 overflow-hidden rounded-full bg-muted">
                              <div
                                className={`h-full ${k.monthRequests >= k.monthlyQuota ? "bg-destructive" : "bg-primary"}`}
                                style={{
                                  width: `${Math.min(100, (k.monthRequests / k.monthlyQuota) * 100)}%`,
                                }}
                              />
                            </div>
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {k.id !== "" && !k.revoked && (
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label={t`Edit key limits`}
                            onClick={() => setEditKey(k)}
                          >
                            <I.Settings size={14} />
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          )}
        </>
      )}

      {overview && (
        <LimitsDialog
          open={limitsOpen}
          onClose={() => setLimitsOpen(false)}
          overview={overview}
          days={days}
          pushToast={pushToast}
        />
      )}
      <KeyLimitsDialog
        keyRow={editKey}
        days={days}
        onClose={() => setEditKey(null)}
        pushToast={pushToast}
      />
    </div>
  );
}

function StatTile({
  label,
  value,
  sub,
  over,
  bar,
}: {
  label: string;
  value: string;
  sub: string;
  over: boolean;
  bar: React.ReactNode;
}) {
  return (
    <Card className="gap-0 px-[15px] py-3.5">
      <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
        {label}
      </div>
      <div
        className={`mt-0.5 text-[25px] font-semibold leading-tight tabular-nums tracking-[-0.02em] ${over ? "text-destructive" : ""}`}
      >
        {value}
      </div>
      <div className="text-[11.5px] text-muted-foreground">{sub}</div>
      {bar}
    </Card>
  );
}

/** Positive int or null from a free input; empty string = null (unlimited). */
const parseLimit = (v: string): number | null | undefined => {
  const s = v.trim();
  if (s === "") return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 1) return undefined;
  return Math.floor(n);
};

function LimitsDialog({
  open,
  onClose,
  overview,
  days,
  pushToast,
}: {
  open: boolean;
  onClose: () => void;
  overview: ApiUsageOverview;
  days: number;
  pushToast: PushToast;
}) {
  const { t } = useLingui();
  const qc = useQueryClient();
  const s = overview.settingsLimits;
  const pinned = new Set(overview.envPinned);
  const [mode, setMode] = useState<ApiUsageLimits["mode"]>(s.mode);
  const [reqs, setReqs] = useState(s.maxRequestsPerMonth?.toString() ?? "");
  const [storage, setStorage] = useState(s.maxStorageBytes?.toString() ?? "");
  const [rows, setRows] = useState(s.maxDbRows?.toString() ?? "");

  const save = async () => {
    const maxRequestsPerMonth = parseLimit(reqs);
    const maxStorageBytes = parseLimit(storage);
    const maxDbRows = parseLimit(rows);
    if (
      maxRequestsPerMonth === undefined ||
      maxStorageBytes === undefined ||
      maxDbRows === undefined
    ) {
      pushToast(t`Limits must be positive numbers (or empty for unlimited).`, "error");
      return;
    }
    const next: ApiUsageLimits = { mode, maxRequestsPerMonth, maxStorageBytes, maxDbRows };
    // Optimistic: patch the cached overview + close, reconcile in background.
    const key = queryKeys.usage(days);
    const prev = qc.getQueryData(key);
    qc.setQueryData(key, (cur: { data: ApiUsageOverview } | undefined) =>
      cur ? { ...cur, data: { ...cur.data, settingsLimits: next } } : cur,
    );
    onClose();
    try {
      await usageApi.setLimits(next);
      pushToast(t`Usage limits saved.`);
      void qc.invalidateQueries({ queryKey: ["usage"] });
    } catch {
      qc.setQueryData(key, prev);
      pushToast(t`Couldn't save limits.`, "error");
    }
  };

  const pinnedHint = (field: string) =>
    pinned.has(field as never) ? (
      <span className="text-[11px] text-muted-foreground">
        <Trans>Pinned by the platform plan (env) — the pinned value wins.</Trans>
      </span>
    ) : null;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="[&>*]:min-w-0 sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            <Trans>Workspace usage limits</Trans>
          </DialogTitle>
        </DialogHeader>
        <DialogBody>
        <div className="flex flex-col gap-3.5 px-1">
          <label className="flex flex-col gap-1.5 text-[13px] font-medium">
            <Trans>Enforcement</Trans>
            <Select
              value={mode}
              onChange={(v) => setMode(v as ApiUsageLimits["mode"])}
              disabled={pinned.has("mode")}
              options={[
                { value: "off", label: t`Off`, hint: t`limits are not evaluated` },
                { value: "soft", label: t`Soft`, hint: t`overage is reported, nothing is blocked` },
                { value: "hard", label: t`Hard`, hint: t`over-budget traffic gets 429` },
              ]}
            />
            {pinnedHint("mode")}
          </label>
          <label className="flex flex-col gap-1.5 text-[13px] font-medium">
            <Trans>Max requests / month</Trans>
            <Input
              value={reqs}
              onChange={(e) => setReqs(e.target.value)}
              inputMode="numeric"
              placeholder={t`unlimited`}
              disabled={pinned.has("maxRequestsPerMonth")}
            />
            {pinnedHint("maxRequestsPerMonth")}
          </label>
          <label className="flex flex-col gap-1.5 text-[13px] font-medium">
            <Trans>Max storage (bytes)</Trans>
            <Input
              value={storage}
              onChange={(e) => setStorage(e.target.value)}
              inputMode="numeric"
              placeholder={t`unlimited`}
              disabled={pinned.has("maxStorageBytes")}
            />
            <span className="text-[11px] text-muted-foreground">
              <Trans>Uploads are rejected once stored bytes reach this. 1 GB = 1073741824.</Trans>
            </span>
            {pinnedHint("maxStorageBytes")}
          </label>
          <label className="flex flex-col gap-1.5 text-[13px] font-medium">
            <Trans>Max rows</Trans>
            <Input
              value={rows}
              onChange={(e) => setRows(e.target.value)}
              inputMode="numeric"
              placeholder={t`unlimited`}
              disabled={pinned.has("maxDbRows")}
            />
            <span className="text-[11px] text-muted-foreground">
              <Trans>Checked against the half-hourly row gauge — approximate by design.</Trans>
            </span>
            {pinnedHint("maxDbRows")}
          </label>
        </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Button onClick={() => void save()}>
            <Trans>Save limits</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function KeyLimitsDialog({
  keyRow,
  days,
  onClose,
  pushToast,
}: {
  keyRow: ApiUsageOverview["byKey"][number] | null;
  days: number;
  onClose: () => void;
  pushToast: PushToast;
}) {
  const { t } = useLingui();
  const qc = useQueryClient();
  const [rate, setRate] = useState("");
  const [quota, setQuota] = useState("");
  const [openedFor, setOpenedFor] = useState<string | null>(null);

  // Seed the inputs when a new key is opened (render-time state sync — the
  // dialog is reused across keys).
  if (keyRow && openedFor !== keyRow.id) {
    setOpenedFor(keyRow.id);
    setRate(keyRow.rateLimitPerMinute?.toString() ?? "");
    setQuota(keyRow.monthlyQuota?.toString() ?? "");
  }

  const save = async () => {
    if (!keyRow) return;
    const rateLimitPerMinute = parseLimit(rate);
    const monthlyQuota = parseLimit(quota);
    if (rateLimitPerMinute === undefined || monthlyQuota === undefined) {
      pushToast(t`Limits must be positive numbers (or empty for unlimited).`, "error");
      return;
    }
    const key = queryKeys.usage(days);
    const prev = qc.getQueryData(key);
    qc.setQueryData(key, (cur: { data: ApiUsageOverview } | undefined) =>
      cur
        ? {
            ...cur,
            data: {
              ...cur.data,
              byKey: cur.data.byKey.map((k) =>
                k.id === keyRow.id ? { ...k, rateLimitPerMinute, monthlyQuota } : k,
              ),
            },
          }
        : cur,
    );
    onClose();
    try {
      await usageApi.setKeyLimits(keyRow.id, { rateLimitPerMinute, monthlyQuota });
      pushToast(t`Key limits saved.`);
      void qc.invalidateQueries({ queryKey: ["usage"] });
    } catch {
      qc.setQueryData(key, prev);
      pushToast(t`Couldn't save key limits.`, "error");
    }
  };

  return (
    <Dialog open={!!keyRow} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="[&>*]:min-w-0 sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>
            <Trans>Limits for {keyRow?.name}</Trans>
          </DialogTitle>
        </DialogHeader>
        <DialogBody>
        <div className="flex flex-col gap-3.5 px-1">
          <label className="flex flex-col gap-1.5 text-[13px] font-medium">
            <Trans>Requests per minute</Trans>
            <Input
              value={rate}
              onChange={(e) => setRate(e.target.value)}
              inputMode="numeric"
              placeholder={t`shared global budget`}
            />
            <span className="text-[11px] text-muted-foreground">
              <Trans>Enforced even where the global API limiter is off.</Trans>
            </span>
          </label>
          <label className="flex flex-col gap-1.5 text-[13px] font-medium">
            <Trans>Monthly request quota</Trans>
            <Input
              value={quota}
              onChange={(e) => setQuota(e.target.value)}
              inputMode="numeric"
              placeholder={t`unmetered`}
            />
            <span className="text-[11px] text-muted-foreground">
              <Trans>Over-quota calls get 429 until the month rolls over.</Trans>
            </span>
          </label>
        </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Button onClick={() => void save()}>
            <Trans>Save</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
