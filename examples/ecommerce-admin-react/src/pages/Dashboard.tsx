/**
 * The figures a merchant opens the day on.
 *
 * Every headline number comes from a **named KPI** rather than an aggregate
 * composed here, so this screen and the backlex admin's own dashboard cannot
 * disagree about what "net revenue" means. The window is a control because the
 * template's KPIs are date-bounded and a shop's sample data is rarely inside
 * the last thirty days.
 */
import { useState } from "react";
import { backlex, orders, products, inventoryLevels } from "../lib/backlex";
import type { KpiResult } from "backlex";
import { useAsync } from "../lib/hooks";
import { fmtDate, fmtMoney, fmtNumber } from "../lib/money";
import { Badge, Card, controlCls, cx, EmptyState, PageHeader, Skeleton, Table, TableScroll, Td, Th } from "@backlex-examples/shared";

const HEADLINE = ["net-revenue", "orders-placed", "average-order-value", "refunded-amount", "cancelled-orders"];

const RANGES = [
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
  { days: 365, label: "12 months" },
  { days: 1825, label: "All time" },
];

export function Dashboard({ go }: { go: (to: string) => void }) {
  const [days, setDays] = useState(365);

  const kpis = useAsync(
    async () => {
      const settled = await Promise.all(
        HEADLINE.map((slug) =>
          backlex.kpis
            .run(slug, { rangeDays: days })
            .then((r) => r.data)
            .catch(() => null),
        ),
      );
      return settled.filter(Boolean) as KpiResult[];
    },
    [days],
  );

  const recent = useAsync(
    () => orders.list({ sort: ["-placed_at"], limit: 8, expand: ["customer"] }).then((r) => r.data),
    [],
  );

  const lowStock = useAsync(
    () =>
      inventoryLevels
        .list({ limit: 200, expand: ["variant", "location"] })
        .then((r) => r.data.filter((l) => (l.available ?? 0) <= (l.reorder_point ?? 0))),
    [],
  );

  const catalog = useAsync(
    async () => {
      const [active, draft] = await Promise.all([
        products.list({ filter: { status: { _eq: "active" } }, limit: 1, meta: "filter_count" }),
        products.list({ filter: { status: { _eq: "draft" } }, limit: 1, meta: "filter_count", status: "all" }),
      ]);
      return { active: active.meta?.filter_count ?? 0, draft: draft.meta?.filter_count ?? 0 };
    },
    [],
  );

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle="Named KPIs, so this screen agrees with every other one."
        actions={
          <select className={cx(controlCls, "w-auto")} value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {RANGES.map((r) => (
              <option key={r.days} value={r.days}>
                {r.label}
              </option>
            ))}
          </select>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {kpis.data == null
          ? HEADLINE.map((s) => (
              <Card key={s}>
                <Skeleton className="h-3 w-24" />
                <Skeleton className="mt-3 h-7 w-20" />
              </Card>
            ))
          : kpis.data.map((k) => <KpiTile key={k.slug} kpi={k} />)}
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-medium">Recent orders</h2>
            <a href="#/orders" className="text-sm text-brand-ink hover:underline">
              All orders →
            </a>
          </div>
          {recent.data == null ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }, (_, i) => (
                <Skeleton key={i} className="h-9 w-full" />
              ))}
            </div>
          ) : recent.data.length === 0 ? (
            <EmptyState title="No orders yet" hint="Orders placed through any channel land here." />
          ) : (
            <TableScroll>
              <Table>
                <thead>
                  <tr>
                    <Th>Order</Th>
                    <Th>Placed</Th>
                    <Th>Customer</Th>
                    <Th>State</Th>
                    <Th className="text-right">Total</Th>
                  </tr>
                </thead>
                <tbody>
                  {recent.data.map((o) => {
                    const c = o.customer as { first_name?: string; last_name?: string; email?: string } | string | null;
                    const who =
                      c && typeof c === "object" ? [c.first_name, c.last_name].filter(Boolean).join(" ") || c.email : o.email;
                    return (
                      <tr
                        key={o.id}
                        className="cursor-pointer border-t border-line hover:bg-raised"
                        onClick={() => go(`/orders/${o.id}`)}
                      >
                        <Td className="whitespace-nowrap font-medium">{o.number ?? o.id.slice(0, 8)}</Td>
                        <Td className="text-ink-muted">{fmtDate(o.placed_at)}</Td>
                        <Td className="max-w-[16ch] truncate text-ink">{who || "—"}</Td>
                        <Td>
                          <Badge tone={stateTone(o.state)}>{o.state ?? "—"}</Badge>
                        </Td>
                        <Td className="text-right tabular-nums">{fmtMoney(o.total, o.currency)}</Td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
            </TableScroll>
          )}
        </Card>

        <div className="space-y-4">
          <Card>
            <h2 className="mb-3 font-medium">Catalog</h2>
            {catalog.data == null ? (
              <Skeleton className="h-16 w-full" />
            ) : (
              <dl className="grid grid-cols-2 gap-3">
                <div>
                  <dt className="text-xs text-ink-dim">Active</dt>
                  <dd className="text-xl font-semibold tabular-nums">{fmtNumber(catalog.data.active)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-ink-dim">Draft</dt>
                  <dd className="text-xl font-semibold tabular-nums">{fmtNumber(catalog.data.draft)}</dd>
                </div>
              </dl>
            )}
          </Card>

          <Card>
            <h2 className="mb-3 font-medium">At or below reorder point</h2>
            {lowStock.data == null ? (
              <Skeleton className="h-20 w-full" />
            ) : lowStock.data.length === 0 ? (
              <p className="text-sm text-ink-dim">Every stocked line is above its reorder point.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {lowStock.data.slice(0, 6).map((l) => {
                  const v = l.variant as { title?: string; sku?: string } | string | null;
                  const loc = l.location as { name?: string } | string | null;
                  return (
                    <li key={l.id} className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate">
                        {(v && typeof v === "object" && (v.title || v.sku)) || "Variant"}
                        <span className="text-ink-dim"> · {(loc && typeof loc === "object" && loc.name) || "—"}</span>
                      </span>
                      <Badge tone={(l.available ?? 0) <= 0 ? "red" : "amber"}>{l.available ?? 0} left</Badge>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}

function KpiTile({ kpi }: { kpi: KpiResult }) {
  // A grouped KPI has no single point — it answers with rows, one per group.
  // Money grouped by currency is the common case, and summing across currencies
  // would be a lie, so each is printed on its own line.
  const rows = kpi.rows ?? (kpi.point ? [kpi.point] : []);
  return (
    <Card>
      <p className="truncate text-xs text-ink-dim" title={kpi.description ?? kpi.name}>
        {kpi.name}
      </p>
      {rows.length === 0 ? (
        <p className="mt-2 text-2xl font-semibold text-ink-dim">—</p>
      ) : (
        <div className="mt-1 space-y-1">
          {rows.slice(0, 3).map((p, i) => (
            <div key={i} className="flex items-baseline gap-2">
              <span className="text-2xl font-semibold tabular-nums">{fmtKpi(kpi, p.value, p.currency ?? p.label)}</span>
              {p.deltaPct != null ? (
                <span className={cx("text-xs", goodness(kpi.direction, p.deltaPct))}>
                  {p.deltaPct > 0 ? "▲" : "▼"} {Math.abs(p.deltaPct * 100).toFixed(0)}%
                </span>
              ) : null}
            </div>
          ))}
        </div>
      )}
      {kpi.window ? (
        <p className="mt-2 text-[11px] text-ink-dim">
          {fmtDate(kpi.window.from)} – {fmtDate(kpi.window.to)}
        </p>
      ) : null}
    </Card>
  );
}

function fmtKpi(kpi: KpiResult, value: number | null, currency?: unknown): string {
  if (value == null) return "—";
  if (kpi.format === "money") return fmtMoney({ amount: value, currency: String(currency ?? "USD") });
  if (kpi.format === "percent") return `${value.toFixed(kpi.decimals ?? 1)}%`;
  return fmtNumber(value);
}

function goodness(direction: KpiResult["direction"], pct: number): string {
  if (direction === "neutral") return "text-ink-muted";
  const good = direction === "up" ? pct > 0 : pct < 0;
  return good ? "text-ok" : "text-bad";
}

export function stateTone(state: string | null | undefined): string {
  return { draft: "gray", open: "blue", completed: "green", cancelled: "red" }[state ?? ""] ?? "gray";
}
