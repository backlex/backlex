// @ts-nocheck
import { useEffect, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { Card } from "@backlex/ui/components/card";
import { Skeleton } from "@backlex/ui/components/skeleton";
import { I } from "./icons";
import { Select } from "./select";
import { Button, EmptyState } from "./ui";
import { kpisApi, type ApiKpi, type ApiKpiResult } from "./api";

/**
 * The KPIs tab of a collection — this workspace's agreed figures for these
 * rows, sitting beside Items / Schema / Settings.
 *
 * A tab rather than a band above the items: the rows are what the page is for,
 * and metrics pushed in above them are a cost paid on every visit whether or
 * not anyone wanted the numbers. The tab is the disclosure, so nothing is
 * fetched or evaluated until it is opened.
 *
 * The figures come from the stored definitions, so this tab, the dashboard
 * tile and Ask AI cannot quietly disagree about what "revenue" means.
 */

/** Print a value the way its KPI says it should be read. Mirrors the KPIs
 *  page — kept in step by the shared `format`/`unit`/`decimals` on the row. */
const formatValue = (
  value: number | null,
  kpi: Pick<ApiKpi, "format" | "unit" | "decimals">,
  currency?: string | null,
  locale = "en",
): string => {
  if (value === null || value === undefined) return "—";
  const d = kpi.decimals;
  if (kpi.format === "money") {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: currency || "USD",
      ...(d !== null && d !== undefined ? { minimumFractionDigits: d, maximumFractionDigits: d } : {}),
    }).format(value);
  }
  if (kpi.format === "percent") {
    return new Intl.NumberFormat(locale, {
      style: "percent",
      minimumFractionDigits: d ?? 1,
      maximumFractionDigits: d ?? 1,
    }).format(value);
  }
  if (kpi.format === "duration") {
    const abs = Math.abs(value);
    if (abs < 1000) return `${Math.round(value)}ms`;
    if (abs < 60_000) return `${(value / 1000).toFixed(1)}s`;
    if (abs < 3_600_000) return `${(value / 60_000).toFixed(1)}m`;
    return `${(value / 3_600_000).toFixed(1)}h`;
  }
  const n = new Intl.NumberFormat(locale, {
    ...(d !== null && d !== undefined ? { minimumFractionDigits: d, maximumFractionDigits: d } : {}),
  }).format(value);
  return kpi.unit ? `${n} ${kpi.unit}` : n;
};

/** Good news is green — decided by the KPI's `direction`, not by the sign. A
 *  rising cancellation rate and a rising order count are both "+12%". */
const toneClass = (delta: number | null, direction: string): string => {
  if (delta === null || delta === 0 || direction === "neutral") return "text-muted-foreground";
  const rising = delta > 0;
  const good = direction === "up" ? rising : !rising;
  return good ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400";
};

export function CollectionKpisPanel({
  collection,
  onOpenKpisPage,
}: {
  collection: string;
  onOpenKpisPage?: () => void;
}) {
  const { t, i18n } = useLingui();
  const locale = i18n?.locale ?? "en";
  const [kpis, setKpis] = useState<ApiKpi[] | null>(null);
  const [results, setResults] = useState<Record<string, ApiKpiResult | { error: string }>>({});
  const [rangeDays, setRangeDays] = useState("30");

  useEffect(() => {
    let cancelled = false;
    setKpis(null);
    setResults({});
    void (async () => {
      try {
        const r = await kpisApi.list();
        if (cancelled) return;
        setKpis((r.data ?? []).filter((k) => k.collection === collection));
      } catch {
        // A workspace predating the table, or a caller without the list grant —
        // the strip simply doesn't appear rather than showing an error banner
        // over somebody's items.
        if (!cancelled) setKpis([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [collection]);

  useEffect(() => {
    if (!kpis || kpis.length === 0) return;
    let cancelled = false;
    const days = Number(rangeDays) || 30;
    void (async () => {
      const entries = await Promise.all(
        kpis.map(async (k) => {
          try {
            const res = await kpisApi.run(k.slug, { rangeDays: days });
            return [k.id, res.data] as const;
          } catch (e) {
            // Per-tile, so one broken definition leaves the rest readable.
            return [k.id, { error: (e as Error).message }] as const;
          }
        }),
      );
      if (!cancelled) setResults(Object.fromEntries(entries));
    })();
    return () => {
      cancelled = true;
    };
  }, [kpis, rangeDays]);

  // The list is one cheap read; until it lands, a skeleton rather than an
  // empty state, so "no KPIs yet" is never shown to somebody who has them.
  if (kpis === null) {
    return (
      <Card className="gap-0 rounded-surface p-0">
        <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-x-4 gap-y-3 px-3.5 py-3.5">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex flex-col gap-1.5">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-6 w-20" />
            </div>
          ))}
        </div>
      </Card>
    );
  }

  if (kpis.length === 0) {
    return (
      <EmptyState
        icon={I.Gauge}
        size="md"
        title={<Trans>No KPIs for this collection</Trans>}
        description={
          <Trans>
            Define a figure once — revenue, open tickets, refund rate — and this tab, your
            dashboards and Ask AI will all quote the same number.
          </Trans>
        }
        action={
          onOpenKpisPage ? (
            <Button variant="primary" icon={I.Plus} onClick={onOpenKpisPage}>
              <Trans>New KPI</Trans>
            </Button>
          ) : undefined
        }
      />
    );
  }

  return (
    <Card className="gap-0 rounded-surface p-0">
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="text-[12px] font-medium text-muted-foreground">
          <Trans>Period</Trans>
        </span>
        <div className="flex-1" />
        <Select
          value={rangeDays}
          onChange={setRangeDays}
          options={[
            { value: "1", label: t`Today` },
            { value: "7", label: t`7 days` },
            { value: "30", label: t`30 days` },
            { value: "90", label: t`90 days` },
          ]}
          size="sm"
          className="w-[112px]"
        />
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-x-4 gap-y-3 border-t border-border px-3.5 py-3.5">
        {kpis.map((kpi) => {
          const r = results[kpi.id];
          const failed = r && "error" in r ? r.error : null;
          const data = r && !("error" in r) ? r : null;
          return (
            <div key={kpi.id} className="flex min-w-0 flex-col gap-0.5">
              <span className="truncate text-[11.5px] text-muted-foreground">{kpi.name}</span>
              {failed ? (
                <span className="truncate text-[12px] text-muted-foreground" title={failed}>
                  —
                </span>
              ) : !data ? (
                // Still resolving. A number that has not arrived must not be
                // drawn as a zero.
                <Skeleton className="h-6 w-20" />
              ) : data.rows ? (
                <span className="text-[15px] font-semibold tabular-nums">
                  {data.rows.length === 0
                    ? "—"
                    : `${data.rows[0]?.label ?? "—"} · ${formatValue(data.rows[0]?.value ?? null, kpi, data.rows[0]?.currency, locale)}`}
                </span>
              ) : (
                <>
                  <span className="truncate text-[17px] font-semibold tabular-nums">
                    {formatValue(data.point?.value ?? null, kpi, data.point?.currency, locale)}
                  </span>
                  <DeltaLine data={data} kpi={kpi} locale={locale} />
                </>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function DeltaLine({
  data,
  kpi,
  locale,
}: {
  data: ApiKpiResult;
  kpi: ApiKpi;
  locale: string;
}) {
  if (!data.window) {
    return (
      <span className="text-[11px] text-muted-foreground">
        <Trans>Running total</Trans>
      </span>
    );
  }
  const point = data.point;
  if (!point || point.delta === null) {
    return (
      <span className="text-[11px] text-muted-foreground">
        <Trans>No prior period</Trans>
      </span>
    );
  }
  // A null deltaPct means the baseline was zero — there is no proportion to
  // report, so the absolute change is shown rather than a fabricated "+100%".
  const pct =
    point.deltaPct === null
      ? null
      : new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 }).format(
          point.deltaPct,
        );
  const sign = point.delta > 0 ? "+" : "";
  return (
    <span className={`truncate text-[11px] ${toneClass(point.delta, kpi.direction)}`}>
      {pct ?? `${sign}${new Intl.NumberFormat(locale).format(point.delta)}`}
    </span>
  );
}
