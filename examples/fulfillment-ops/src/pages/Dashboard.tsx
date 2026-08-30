/**
 * The morning screen: what is waiting, what is moving, what is about to run out.
 *
 * Every figure comes from one `aggregate` call rather than from listing rows
 * and counting them in the browser — a warehouse has more rows than a page
 * limit, and a count computed off `data.length` is a count of the page.
 */
import { available, bins, campaigns, listAll, orders, products, shipments, stockLevels } from "../lib/backlex";
import { CAMPAIGN_STATUS, ORDER_STATUS, SHIPMENT_STATUS, fmtMoney, fmtNumber } from "../lib/format";
import { useAsync } from "../lib/hooks";
import { Badge, Card, EmptyState, PageHeader, Skeleton, Table, TableScroll, TableSkeleton, Td, Th } from "../lib/ui";

type Grouped = { label: string; value: number }[];

/** `aggregate` returns `label` as `unknown`, since a group key can be any
 *  column type. Every status column here is a dropdown, so it is a string. */
const asGrouped = (rows: { label?: unknown; value: number }[]): Grouped =>
  rows.map((r) => ({ label: String(r.label ?? ""), value: r.value }));

export function Dashboard({ go }: { go: (to: string) => void }) {
  const { data, loading, error } = useAsync(async () => {
    const [orderStatus, shipmentStatus, campaignStatus, revenue, levels, binRows, productRows, latest] =
      await Promise.all([
        orders.aggregate({ agg: "count", groupBy: "status" }),
        shipments.aggregate({ agg: "count", groupBy: "status" }),
        campaigns.aggregate({ agg: "count", groupBy: "status" }),
        // A money sum carries the currency it is denominated in — the server
        // refuses to add two, so there is exactly one to read off the row.
        orders.aggregate({ agg: "sum", field: "grand_total", filter: { status: { _neq: "cancelled" } } }),
        listAll(stockLevels),
        listAll(bins),
        listAll(products),
        orders.list({ limit: 8, sort: "-placed_at" }),
      ]);
    return {
      orderStatus: asGrouped(orderStatus.data),
      shipmentStatus: asGrouped(shipmentStatus.data),
      campaignStatus: asGrouped(campaignStatus.data),
      revenue: revenue.data[0],
      levels,
      binRows,
      productRows,
      latest,
    };
  }, []);

  if (error) {
    return (
      <>
        <PageHeader title="Panel" />
        <EmptyState title="Panel yüklenemedi" hint={String(error)} />
      </>
    );
  }

  const countOf = (rows: Grouped | undefined, key: string) => rows?.find((r) => r.label === key)?.value ?? 0;
  const open = data
    ? countOf(data.orderStatus, "new") + countOf(data.orderStatus, "confirmed") + countOf(data.orderStatus, "picking")
    : 0;
  const inTransit = data
    ? countOf(data.shipmentStatus, "handed_over") +
      countOf(data.shipmentStatus, "in_transit") +
      countOf(data.shipmentStatus, "out_for_delivery")
    : 0;

  const productById = new Map((data?.productRows ?? []).map((p) => [p.id, p]));
  const binById = new Map((data?.binRows ?? []).map((b) => [b.id, b]));
  const lowStock = (data?.levels ?? [])
    .filter((l) => typeof l.reorder_point === "number" && available(l) <= (l.reorder_point ?? 0))
    .sort((a, b) => available(a) - available(b))
    .slice(0, 8);

  return (
    <>
      <PageHeader title="Panel" subtitle="Bugünün operasyon özeti" />

      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <Stat label="Açık sipariş" value={open} hint="yeni + onaylı + toplanıyor" loading={loading} />
        <Stat label="Yolda gönderi" value={inTransit} hint="kargoya verilenden dağıtıma kadar" loading={loading} />
        <Stat
          label="Ciro"
          value={data ? fmtMoney({ amount: data.revenue?.value ?? 0, currency: String(data.revenue?.currency ?? "TRY") }) : ""}
          hint="iptaller hariç"
          loading={loading}
        />
        <Stat label="Kritik stok" value={lowStock.length} hint="sipariş noktasının altında" loading={loading} />
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <Card>
          <h2 className="mb-3 text-sm font-medium text-white/70">Sipariş durumları</h2>
          {loading ? <TableSkeleton rows={4} cols={2} /> : <Breakdown rows={data?.orderStatus ?? []} vocab={ORDER_STATUS} />}
        </Card>
        <Card>
          <h2 className="mb-3 text-sm font-medium text-white/70">Kargo durumları</h2>
          {loading ? (
            <TableSkeleton rows={4} cols={2} />
          ) : (
            <Breakdown rows={data?.shipmentStatus ?? []} vocab={SHIPMENT_STATUS} />
          )}
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card>
          <h2 className="mb-3 text-sm font-medium text-white/70">Son siparişler</h2>
          {loading ? (
            <TableSkeleton rows={5} cols={3} />
          ) : (data?.latest.data ?? []).length === 0 ? (
            <EmptyState title="Henüz sipariş yok" hint="İlk sipariş girildiğinde burada listelenir." />
          ) : (
            <TableScroll>
              <Table>
                <thead>
                  <tr>
                    <Th>Sipariş</Th>
                    <Th>Durum</Th>
                    <Th className="text-right">Tutar</Th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.latest.data ?? []).map((o) => (
                    <tr key={o.id} className="cursor-pointer border-t border-white/5 hover:bg-white/5" onClick={() => go(`/orders/${o.id}`)}>
                      <Td className="font-mono text-xs">{o.order_no ?? o.id.slice(0, 8)}</Td>
                      <Td>
                        <Badge tone={ORDER_STATUS[o.status]?.tone}>{ORDER_STATUS[o.status]?.label ?? o.status}</Badge>
                      </Td>
                      <Td className="text-right tabular-nums">{fmtMoney(o.grand_total)}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </TableScroll>
          )}
        </Card>

        <Card>
          <h2 className="mb-3 text-sm font-medium text-white/70">Sipariş noktasının altındakiler</h2>
          {loading ? (
            <TableSkeleton rows={5} cols={4} />
          ) : lowStock.length === 0 ? (
            <EmptyState title="Kritik stok yok" hint="Her rafta sipariş noktasının üzerinde stok var." />
          ) : (
            <TableScroll>
              <Table>
                <thead>
                  <tr>
                    <Th>Ürün</Th>
                    <Th>Raf</Th>
                    <Th className="text-right">Kullanılabilir</Th>
                    <Th className="text-right">Sipariş nk.</Th>
                  </tr>
                </thead>
                <tbody>
                  {lowStock.map((l) => (
                    <tr key={l.id} className="border-t border-white/5">
                      <Td className="max-w-[16rem] truncate">{productById.get(String(l.product))?.name ?? "—"}</Td>
                      <Td className="font-mono text-xs">{binById.get(String(l.bin))?.code ?? "—"}</Td>
                      <Td className="text-right tabular-nums text-amber-300">{fmtNumber(available(l))}</Td>
                      <Td className="text-right tabular-nums text-white/50">{fmtNumber(l.reorder_point)}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </TableScroll>
          )}
        </Card>
      </div>

      <Card className="mt-4">
        <h2 className="mb-3 text-sm font-medium text-white/70">Kampanyalar</h2>
        {loading ? <TableSkeleton rows={3} cols={2} /> : <Breakdown rows={data?.campaignStatus ?? []} vocab={CAMPAIGN_STATUS} />}
      </Card>
    </>
  );
}

function Stat({ label, value, hint, loading }: { label: string; value: number | string; hint?: string; loading: boolean }) {
  return (
    <Card>
      <p className="text-xs font-medium uppercase tracking-wide text-white/40">{label}</p>
      {loading ? (
        <Skeleton className="mt-2 h-7 w-20" />
      ) : (
        <p className="mt-1 text-2xl font-semibold tabular-nums">{typeof value === "number" ? fmtNumber(value) : value}</p>
      )}
      {hint ? <p className="mt-1 text-xs text-white/35">{hint}</p> : null}
    </Card>
  );
}

function Breakdown({ rows, vocab }: { rows: Grouped; vocab: Record<string, { label: string; tone: string }> }) {
  if (rows.length === 0) return <EmptyState title="Kayıt yok" />;
  const total = rows.reduce((n, r) => n + r.value, 0) || 1;
  return (
    <ul className="space-y-2">
      {rows.map((r) => (
        <li key={r.label ?? "null"} className="flex items-center gap-3">
          <span className="w-32 shrink-0">
            <Badge tone={vocab[r.label]?.tone}>{vocab[r.label]?.label ?? r.label ?? "—"}</Badge>
          </span>
          <span className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-white/5">
            <span className="block h-full rounded-full bg-indigo-400/70" style={{ width: `${(r.value / total) * 100}%` }} />
          </span>
          <span className="w-10 shrink-0 text-right text-sm tabular-nums text-white/60">{fmtNumber(r.value)}</span>
        </li>
      ))}
    </ul>
  );
}
