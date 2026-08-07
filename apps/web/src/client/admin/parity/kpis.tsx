// @ts-nocheck
import type { PushToast } from "../types";
import { useEffect, useMemo, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { Card } from "@backlex/ui/components/card";
import { Input } from "@backlex/ui/components/input";
import { Textarea } from "@backlex/ui/components/textarea";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@backlex/ui/components/dialog";
import { I } from "../icons";
import { Select } from "../select";
import { Button, EmptyState, IconButton, PageHeader } from "../ui";
import { ConfirmDialog } from "../sheet";
import {
  collectionsApi,
  kpisApi,
  type ApiCollection,
  type ApiKpi,
  type ApiKpiInput,
  type ApiKpiResult,
} from "../api";
import { KpisSkeleton } from "../page-skeletons";
import { Sparkline } from "../sparkline";

/**
 * KPIs — the workspace's named figures, and the one place each one's formula
 * lives.
 *
 * The page exists because the same number used to be re-derived on every
 * surface that showed it: a dashboard panel held raw SQL, the Ask AI planner
 * invented aggregate arguments per question, a report computed it a third way.
 * Editing a row here changes what that figure MEANS everywhere at once, which
 * is why authoring is admin-only while reading is not.
 *
 * Each tile renders the definition evaluated over the selected window AND the
 * window before it. The delta is coloured by the KPI's own `direction`, not by
 * its sign — a rising cancellation rate is bad news at the same +12% a rising
 * order count is good news at.
 */

const AGG_OPTIONS = [
  { value: "count", label: "count", hint: "How many rows" },
  { value: "sum", label: "sum", hint: "Total of a numeric column" },
  { value: "avg", label: "avg", hint: "Mean of a numeric column" },
  { value: "min", label: "min", hint: "Smallest value" },
  { value: "max", label: "max", hint: "Largest value" },
];

const FORMAT_OPTIONS = [
  { value: "number", label: "Number", hint: "Plain count or quantity" },
  { value: "money", label: "Money", hint: "Currency comes from the column" },
  { value: "percent", label: "Percent", hint: "Stored as a ratio: 0.043 → 4.3%" },
  { value: "duration", label: "Duration", hint: "Milliseconds, printed as h/m/s" },
];

const ALERT_OPTIONS = [
  { value: "", label: "No alert", hint: "Nobody is notified about this figure" },
  { value: "above", label: "Value above", hint: "Notify when the number goes over" },
  { value: "below", label: "Value below", hint: "Notify when the number drops under" },
  { value: "change_above", label: "Change above", hint: "On the % change vs the previous period" },
  { value: "change_below", label: "Change below", hint: "On the % change vs the previous period" },
];

const DIRECTION_OPTIONS = [
  { value: "up", label: "Up is good", hint: "Rising is green — revenue, orders" },
  { value: "down", label: "Down is good", hint: "Rising is red — refunds, cancellations" },
  { value: "neutral", label: "Neutral", hint: "No judgement on the direction" },
];

/** Columns a sum/avg/min/max can target. Mirrors NUMERIC_FIELD_TYPES server-side. */
const NUMERIC_TYPES = new Set(["integer", "number", "money"]);

const BLANK: ApiKpiInput = {
  slug: "",
  name: "",
  description: null,
  collection: "",
  agg: "count",
  field: null,
  filter: null,
  dateField: null,
  groupBy: null,
  topN: null,
  format: "number",
  unit: null,
  decimals: null,
  direction: "neutral",
  alertOperator: null,
  alertValue: null,
  pinTo: null,
  pinField: null,
};

/** Print a value the way its KPI says it should be read. */
const formatValue = (
  value: number | null,
  kpi: { format: string; unit: string | null; decimals: number | null },
  currency?: string | null,
  locale = "en",
): string => {
  if (value === null || value === undefined) return "—";
  const decimals = kpi.decimals;
  if (kpi.format === "money") {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: currency || "USD",
      ...(decimals !== null ? { minimumFractionDigits: decimals, maximumFractionDigits: decimals } : {}),
    }).format(value);
  }
  if (kpi.format === "percent") {
    return new Intl.NumberFormat(locale, {
      style: "percent",
      minimumFractionDigits: decimals ?? 1,
      maximumFractionDigits: decimals ?? 1,
    }).format(value);
  }
  if (kpi.format === "duration") return formatDuration(value);
  const n = new Intl.NumberFormat(locale, {
    ...(decimals !== null ? { minimumFractionDigits: decimals, maximumFractionDigits: decimals } : {}),
  }).format(value);
  return kpi.unit ? `${n} ${kpi.unit}` : n;
};

/** Milliseconds → the largest unit that keeps the number readable. */
const formatDuration = (ms: number): string => {
  const abs = Math.abs(ms);
  if (abs < 1000) return `${Math.round(ms)}ms`;
  if (abs < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (abs < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  if (abs < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  return `${(ms / 86_400_000).toFixed(1)}d`;
};

/**
 * Decide how a delta should read.
 *
 * `deltaPct` is null whenever the baseline was zero or absent, and that is not
 * the same as "no change" — printing 0% there would claim the period was flat
 * when in fact there is nothing to compare against. Those render as a plain
 * "new" marker instead.
 */
const deltaTone = (
  delta: number | null,
  direction: string,
): "good" | "bad" | "flat" => {
  if (delta === null || delta === 0 || direction === "neutral") return "flat";
  const rising = delta > 0;
  if (direction === "up") return rising ? "good" : "bad";
  return rising ? "bad" : "good";
};

const TONE_CLASS: Record<string, string> = {
  good: "text-emerald-600 dark:text-emerald-400",
  bad: "text-red-600 dark:text-red-400",
  flat: "text-muted-foreground",
};

export function KpisPage({ pushToast }: { pushToast: PushToast }) {
  const { t, i18n } = useLingui();
  const [kpis, setKpis] = useState<ApiKpi[]>([]);
  const [results, setResults] = useState<Record<string, ApiKpiResult | { error: string }>>({});
  const [collections, setCollections] = useState<ApiCollection[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [rangeDays, setRangeDays] = useState("30");
  const [editing, setEditing] = useState<(ApiKpiInput & { id?: string }) | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<ApiKpi | null>(null);
  const locale = i18n?.locale ?? "en";

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [kpiRes, colRes] = await Promise.all([
          kpisApi.list(),
          collectionsApi.list().catch(() => ({ data: [] })),
        ]);
        if (cancelled) return;
        setKpis(kpiRes.data ?? []);
        setCollections((colRes.data ?? []) as ApiCollection[]);
      } catch {
        // Leave the list empty; the page still offers "New KPI".
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Re-evaluate whenever the definition set or the window changes. Each tile
  // resolves independently so one broken definition (a dropped column, a
  // revoked grant) leaves the rest of the page readable instead of blanking it.
  useEffect(() => {
    if (kpis.length === 0) return;
    let cancelled = false;
    const days = Number(rangeDays) || 30;
    void (async () => {
      const entries = await Promise.all(
        kpis.map(async (k) => {
          try {
            // The shape is worth the extra query on this page: it is the one
            // surface whose whole job is reading the figures.
            const res = await kpisApi.run(k.slug, { rangeDays: days, series: true });
            return [k.id, res.data] as const;
          } catch (e) {
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

  const collectionBySlug = useMemo(
    () => new Map(collections.map((c) => [c.slug, c])),
    [collections],
  );

  const editingCollection = editing ? collectionBySlug.get(editing.collection) : undefined;

  const fieldOptions = (predicate: (f: { type: string }) => boolean) => {
    const fields = (editingCollection?.fields ?? []).filter(predicate);
    return fields.map((f) => ({ value: f.name, label: f.name, hint: f.type }));
  };

  /** Timestamp columns a period window can hang off. `created_at` is always
   *  offered even though it never appears in `fields` — it is a system column,
   *  and it is the answer for most collections. */
  const dateFieldOptions = [
    { value: "", label: t`No period comparison`, hint: t`Reports a running total` },
    { value: "created_at", label: "created_at", hint: t`When the row was created` },
    { value: "updated_at", label: "updated_at", hint: t`When the row last changed` },
    ...fieldOptions((f) => f.type === "timestamp"),
  ];

  const upsert = async () => {
    if (!editing) return;
    const slug = editing.slug.trim();
    const name = editing.name.trim();
    if (!slug || !name || !editing.collection) {
      pushToast(t`A KPI needs a handle, a name and a collection.`);
      return;
    }
    if (editing.agg !== "count" && !editing.field) {
      pushToast(t`Pick the column to ${editing.agg}.`);
      return;
    }
    setSaving(true);
    const snapshot = kpis;
    const body: ApiKpiInput = { ...editing, slug, name };
    delete (body as { id?: string }).id;
    // Optimistic: the row lands (or updates) before the round-trip, and the
    // dialog closes with it. On failure both are rolled back.
    const optimistic: ApiKpi = {
      id: editing.id ?? `pending-${crypto.randomUUID()}`,
      tenantId: "",
      createdBy: null,
      ...body,
    };
    setKpis((prev) =>
      editing.id
        ? prev.map((k) => (k.id === editing.id ? optimistic : k))
        : [...prev, optimistic].sort((a, b) => a.name.localeCompare(b.name)),
    );
    setEditing(null);
    try {
      const res = editing.id
        ? await kpisApi.update(editing.id, body)
        : await kpisApi.create(body);
      const saved = res.data;
      setKpis((prev) => prev.map((k) => (k.id === optimistic.id ? saved : k)));
    } catch (e) {
      setKpis(snapshot);
      pushToast((e as Error).message || t`Could not save the KPI.`);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (kpi: ApiKpi) => {
    const snapshot = kpis;
    setKpis((prev) => prev.filter((k) => k.id !== kpi.id));
    setConfirmDelete(null);
    try {
      await kpisApi.remove(kpi.id);
    } catch (e) {
      setKpis(snapshot);
      pushToast((e as Error).message || t`Could not delete the KPI.`);
    }
  };

  if (!loaded) return <KpisSkeleton />;

  return (
    <div className="flex flex-col gap-4.5">
      <PageHeader
        title={<Trans>KPIs</Trans>}
        description={
          <Trans>
            A named figure and the formula behind it. Panels, Ask AI and reports all read
            from these definitions, so one edit changes the number everywhere it appears.
          </Trans>
        }
        descriptionClassName="hidden sm:block"
        actions={
          <div className="flex items-center gap-2">
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
              className="w-[130px]"
            />
            <Button
              variant="primary"
              icon={I.Plus}
              onClick={() => setEditing({ ...BLANK, collection: collections[0]?.slug ?? "" })}
            >
              <Trans>New KPI</Trans>
            </Button>
          </div>
        }
      />

      {kpis.length === 0 ? (
        <EmptyState
          icon={I.BarChart}
          title={<Trans>No KPIs defined yet</Trans>}
          description={
            <Trans>
              Define a figure once — revenue, open tickets, refund rate — and every panel,
              report and AI answer will quote the same number instead of re-deriving it.
            </Trans>
          }
          action={
            <Button
              variant="primary"
              icon={I.Plus}
              onClick={() => setEditing({ ...BLANK, collection: collections[0]?.slug ?? "" })}
            >
              <Trans>New KPI</Trans>
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
          {kpis.map((kpi) => (
            <KpiTile
              key={kpi.id}
              kpi={kpi}
              result={results[kpi.id]}
              locale={locale}
              onEdit={() => setEditing({ ...kpi })}
              onDelete={() => setConfirmDelete(kpi)}
            />
          ))}
        </div>
      )}

      <Dialog open={Boolean(editing)} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="sm:max-w-[620px]">
          <DialogHeader>
            <DialogTitle>
              {editing?.id ? <Trans>Edit KPI</Trans> : <Trans>New KPI</Trans>}
            </DialogTitle>
            <DialogDescription>
              <Trans>
                The handle is what panels and AI tool calls reference — renaming the display
                name is safe, changing the handle is not.
              </Trans>
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            {editing && (
              <div className="grid grid-cols-2 gap-3 max-[640px]:grid-cols-1 [&>*]:min-w-0">
                <Field label={t`Handle`} hint={t`Lowercase, e.g. net-revenue`}>
                  <Input
                    value={editing.slug}
                    onChange={(e) => setEditing({ ...editing, slug: e.target.value })}
                    placeholder="net-revenue"
                  />
                </Field>
                <Field label={t`Name`} hint={t`Shown on tiles and reports`}>
                  <Input
                    value={editing.name}
                    onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                    placeholder={t`Net revenue`}
                  />
                </Field>
                <Field label={t`Collection`} className="col-span-2 max-[640px]:col-span-1">
                  <Select
                    value={editing.collection}
                    onChange={(v) =>
                      // The field/groupBy/dateField choices below are all names
                      // from the OLD collection, so they cannot survive the move.
                      setEditing({ ...editing, collection: v, field: null, groupBy: null, dateField: null })
                    }
                    options={collections.map((c) => ({ value: c.slug, label: c.slug }))}
                    placeholder={t`Pick a collection`}
                    className="w-full min-w-0"
                  />
                </Field>
                <Field label={t`Aggregate`}>
                  <Select
                    value={editing.agg}
                    onChange={(v) =>
                      setEditing({ ...editing, agg: v, field: v === "count" ? null : editing.field })
                    }
                    options={AGG_OPTIONS}
                    className="w-full min-w-0"
                  />
                </Field>
                <Field
                  label={t`Column`}
                  hint={editing.agg === "count" ? t`Not needed for count` : t`Numeric columns only`}
                >
                  <Select
                    value={editing.field ?? ""}
                    onChange={(v) => setEditing({ ...editing, field: v || null })}
                    options={fieldOptions((f) => NUMERIC_TYPES.has(f.type))}
                    placeholder={t`Pick a column`}
                    disabled={editing.agg === "count"}
                    className="w-full min-w-0"
                  />
                </Field>
                <Field label={t`Date column`} hint={t`Drives the period comparison`}>
                  <Select
                    value={editing.dateField ?? ""}
                    onChange={(v) => setEditing({ ...editing, dateField: v || null })}
                    options={dateFieldOptions}
                    className="w-full min-w-0"
                  />
                </Field>
                <Field label={t`Group by`} hint={t`Turns the KPI into a ranking`}>
                  <Select
                    value={editing.groupBy ?? ""}
                    onChange={(v) => setEditing({ ...editing, groupBy: v || null })}
                    options={[
                      { value: "", label: t`No grouping`, hint: t`A single number` },
                      ...fieldOptions(() => true),
                    ]}
                    className="w-full min-w-0"
                  />
                </Field>
                <Field label={t`Format`}>
                  <Select
                    value={editing.format}
                    onChange={(v) => setEditing({ ...editing, format: v })}
                    options={FORMAT_OPTIONS}
                    className="w-full min-w-0"
                  />
                </Field>
                <Field label={t`Good direction`} hint={t`Which way the delta is green`}>
                  <Select
                    value={editing.direction}
                    onChange={(v) => setEditing({ ...editing, direction: v })}
                    options={DIRECTION_OPTIONS}
                    className="w-full min-w-0"
                  />
                </Field>
                <Field label={t`Unit`} hint={t`Suffix for plain numbers`}>
                  <Input
                    value={editing.unit ?? ""}
                    onChange={(e) => setEditing({ ...editing, unit: e.target.value || null })}
                    placeholder={t`orders`}
                  />
                </Field>
                <Field label={t`Decimals`} hint={t`Blank = automatic`}>
                  <Input
                    type="number"
                    min={0}
                    max={6}
                    value={editing.decimals ?? ""}
                    onChange={(e) =>
                      setEditing({
                        ...editing,
                        decimals: e.target.value === "" ? null : Number(e.target.value),
                      })
                    }
                  />
                </Field>
                <Field
                  label={t`Pin to`}
                  hint={t`Show on that collection's record page`}
                >
                  <Select
                    value={editing.pinTo ?? ""}
                    onChange={(v) =>
                      // The relation is a column of THIS KPI's collection, so a
                      // pin without one has nothing to narrow on — cleared and
                      // required together.
                      setEditing({ ...editing, pinTo: v || null, pinField: v ? editing.pinField : null })
                    }
                    options={[
                      { value: "", label: t`Not pinned`, hint: t`Collection-wide only` },
                      ...collections.map((c) => ({ value: c.slug, label: c.slug })),
                    ]}
                    className="w-full min-w-0"
                  />
                </Field>
                <Field
                  label={t`Linked by`}
                  hint={t`The relation on ${editing.collection || "this collection"} pointing back`}
                >
                  <Select
                    value={editing.pinField ?? ""}
                    onChange={(v) => setEditing({ ...editing, pinField: v || null })}
                    // Relations AND plain text: an adopted or legacy schema
                    // keeps its foreign key in a `text` column, and the server
                    // is happy to filter on either. Restricting to `relation`
                    // would make the feature unusable on exactly those tables.
                    options={fieldOptions((f) => f.type === "relation" || f.type === "text")}
                    placeholder={t`Pick the linking column`}
                    disabled={!editing.pinTo}
                    className="w-full min-w-0"
                  />
                </Field>
                <Field label={t`Alert`} hint={t`Notify the workspace on the way in`}>
                  <Select
                    value={editing.alertOperator ?? ""}
                    onChange={(v) =>
                      setEditing({
                        ...editing,
                        alertOperator: v || null,
                        // An operator with no threshold can never decide, so the
                        // two are cleared and required together.
                        alertValue: v ? (editing.alertValue ?? 0) : null,
                      })
                    }
                    options={ALERT_OPTIONS}
                    className="w-full min-w-0"
                  />
                </Field>
                <Field
                  label={t`Threshold`}
                  hint={
                    editing.alertOperator?.startsWith("change_")
                      ? t`A percentage, e.g. 20 for 20%`
                      : t`The value to compare against`
                  }
                >
                  <Input
                    type="number"
                    disabled={!editing.alertOperator}
                    value={
                      editing.alertValue === null || editing.alertValue === undefined
                        ? ""
                        : editing.alertOperator?.startsWith("change_")
                          ? editing.alertValue * 100
                          : editing.alertValue
                    }
                    onChange={(e) => {
                      const raw = e.target.value === "" ? null : Number(e.target.value);
                      setEditing({
                        ...editing,
                        // `change_*` thresholds are stored as fractions, the
                        // units deltaPct reports in; the field shows percent.
                        alertValue:
                          raw === null
                            ? null
                            : editing.alertOperator?.startsWith("change_")
                              ? raw / 100
                              : raw,
                      });
                    }}
                  />
                </Field>
                <Field
                  label={t`Description`}
                  className="col-span-2 max-[640px]:col-span-1"
                  hint={t`What this figure means, for whoever reads it next`}
                >
                  <Textarea
                    rows={2}
                    value={editing.description ?? ""}
                    onChange={(e) => setEditing({ ...editing, description: e.target.value || null })}
                  />
                </Field>
              </div>
            )}
          </DialogBody>
          <DialogFooter>
            <Button onClick={() => setEditing(null)}>
              <Trans>Cancel</Trans>
            </Button>
            <Button variant="primary" onClick={upsert} disabled={saving}>
              {saving ? <Trans>Saving…</Trans> : <Trans>Save KPI</Trans>}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={Boolean(confirmDelete)}
        onCancel={() => setConfirmDelete(null)}
        title={t`Delete this KPI?`}
        description={t`Panels and saved answers that reference "${confirmDelete?.slug ?? ""}" will stop resolving.`}
        actionLabel={t`Delete`}
        destructive
        onConfirm={() => confirmDelete && remove(confirmDelete)}
      />
    </div>
  );
}

/** One labelled control in the editor grid. */
function Field({
  label,
  hint,
  className,
  children,
}: {
  label: string;
  hint?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={`flex min-w-0 flex-col gap-1 ${className ?? ""}`}>
      <span className="text-[12.5px] font-medium">{label}</span>
      {children}
      {hint && <span className="text-[11.5px] text-muted-foreground">{hint}</span>}
    </label>
  );
}

/** A single KPI, evaluated over the selected window. */
function KpiTile({
  kpi,
  result,
  locale,
  onEdit,
  onDelete,
}: {
  kpi: ApiKpi;
  result: ApiKpiResult | { error: string } | undefined;
  locale: string;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useLingui();
  const failed = result && "error" in result ? result.error : null;
  const data = result && !("error" in result) ? result : null;

  return (
    <Card className="flex flex-col gap-2 p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-[13px] font-medium">{kpi.name}</span>
          <span className="truncate font-mono text-[11px] text-muted-foreground">
            {kpi.collection}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {kpi.alertFiring && (
            // Server-owned: this is the same flag the scheduler set when it
            // notified, so the page and the alert cannot disagree about
            // whether the figure is out of bounds.
            <span
              title={t`Outside its alert threshold`}
              className="mr-1 rounded bg-red-500/15 px-1.5 py-0.5 text-[10.5px] font-medium text-red-600 dark:text-red-400"
            >
              <Trans>Alert</Trans>
            </span>
          )}
          <IconButton icon={I.Pencil} title={t`Edit`} onClick={onEdit} />
          <IconButton icon={I.Trash} title={t`Delete`} onClick={onDelete} />
        </div>
      </div>

      {failed ? (
        <div className="text-[12px] text-muted-foreground">{failed}</div>
      ) : !data ? (
        // Not an error — the tile is still resolving. A number that has not
        // arrived must not be drawn as a zero.
        <div className="h-9 w-24 animate-pulse rounded bg-muted" />
      ) : data.rows ? (
        <div className="flex flex-col gap-1">
          {data.rows.slice(0, 5).map((row) => (
            <div key={row.label} className="flex items-baseline justify-between gap-2 text-[12.5px]">
              <span className="truncate text-muted-foreground">{row.label}</span>
              <span className="shrink-0 font-medium tabular-nums">
                {formatValue(row.value, kpi, row.currency, locale)}
              </span>
            </div>
          ))}
          {data.rows.length === 0 && (
            <span className="text-[12px] text-muted-foreground">
              <Trans>Nothing in this period</Trans>
            </span>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-0.5">
          <span className="text-2xl font-semibold tabular-nums">
            {formatValue(data.point?.value ?? null, kpi, data.point?.currency, locale)}
          </span>
          <DeltaLine point={data.point} kpi={kpi} locale={locale} hasWindow={Boolean(data.window)} />
          {data.series && (
            <KpiSparkline
              series={data.series}
              delta={data.point?.delta ?? null}
              direction={kpi.direction}
            />
          )}
        </div>
      )}
    </Card>
  );
}

/**
 * The shape behind the number — the same sparkline the Overview cards draw.
 *
 * Coloured from the SAME delta the badge above it uses, not from the first and
 * last bucket. Those two often disagree: a window whose edges are both empty
 * ends where it started while the period as a whole moved sharply, and a chart
 * painting that grey under a green "+17" is the tile contradicting itself.
 * `direction` decides which sign is good news — a rising cancellation rate and
 * a rising order count are both "up", and only the definition knows.
 */
function KpiSparkline({
  series,
  delta,
  direction,
}: {
  series: { t: number; value: number | null }[];
  delta: number | null;
  direction: string;
}) {
  const values = series.map((p) => p.value);
  const known = values.filter((v): v is number => v !== null);
  if (known.length < 2) return null;
  // Nothing happened at all. A flat line is a divider, not information, and the
  // headline figure already says zero.
  if (known.every((v) => v === 0)) return null;

  const tone = deltaTone(delta, direction);
  const color =
    tone === "good"
      ? "var(--color-emerald-500, #10b981)"
      : tone === "bad"
        ? "var(--color-red-500, #ef4444)"
        : "var(--muted-foreground)";

  return (
    <div className="mt-2 max-w-[200px]">
      <Sparkline data={values} color={color} height={30} />
    </div>
  );
}

/** The "vs previous period" line, or nothing when there is no period at all. */
function DeltaLine({
  point,
  kpi,
  locale,
  hasWindow,
}: {
  point: ApiKpiResult["point"];
  kpi: ApiKpi;
  locale: string;
  hasWindow: boolean;
}) {
  if (!hasWindow) {
    return (
      <span className="text-[11.5px] text-muted-foreground">
        <Trans>Running total</Trans>
      </span>
    );
  }
  if (!point || point.delta === null) {
    return (
      <span className="text-[11.5px] text-muted-foreground">
        <Trans>No prior period to compare</Trans>
      </span>
    );
  }
  const tone = deltaTone(point.delta, kpi.direction);
  const sign = point.delta > 0 ? "+" : "";
  // A null deltaPct means the baseline was zero — there is no proportion to
  // report, so the absolute change is shown on its own rather than as "+0%".
  const pct =
    point.deltaPct === null
      ? null
      : new Intl.NumberFormat(locale, {
          style: "percent",
          maximumFractionDigits: 1,
        }).format(point.deltaPct);
  return (
    <span className={`text-[11.5px] ${TONE_CLASS[tone]}`}>
      {pct ?? `${sign}${formatValue(point.delta, kpi, point.currency, locale)}`}
      <span className="ml-1 text-muted-foreground">
        <Trans>vs previous period</Trans>
      </span>
    </span>
  );
}
