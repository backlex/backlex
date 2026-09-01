/**
 * One order, and the moves it may make next.
 *
 * The status buttons are built from the SERVER's answer (`transitions`), not
 * from a list in this file — a client that draws its own graph can offer a move
 * the server will refuse, and then the refusal looks like a bug in the app.
 */
import { useState } from "react";
import {
  addresses,
  customers,
  listAll,
  orderLines,
  orders,
  packages,
  products,
  shipments,
  type Order,
} from "../lib/backlex";
import {
  CHANNEL,
  ORDER_STATUS,
  PACKAGE_STATUS,
  PRIORITY,
  SHIPMENT_STATUS,
  fmtDateTime,
  fmtMoney,
  fmtNumber,
  fmtWeight,
} from "../lib/format";
import { errText, useAsync, useToast } from "../lib/hooks";
import { Badge, Button, Card, EmptyState, PageHeader, Skeleton, Table, TableScroll, TableSkeleton, Td, Th } from "@backlex-examples/shared";

export function OrderDetail({ id, go }: { id: string; go: (to: string) => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  const { data, loading, error, reload, setData } = useAsync(async () => {
    const order = await orders.one(id);
    const [lines, moves] = await Promise.all([
      orderLines.list({ filter: { order: { _eq: id } }, limit: 100 }),
      orders.transitions(id).catch(() => ({ data: [] })),
    ]);
    const [people, addr, prods, pkgs, shps] = await Promise.all([
      order.data.customer ? customers.one(String(order.data.customer)).catch(() => null) : null,
      order.data.shipping_address ? addresses.one(String(order.data.shipping_address)).catch(() => null) : null,
      listAll(products),
      packages.list({ filter: { order: { _eq: id } }, limit: 20 }),
      shipments.list({ filter: { order: { _eq: id } }, limit: 20 }),
    ]);
    return {
      order: order.data,
      lines: lines.data,
      moves: moves.data?.find((m) => m.field === "status")?.moves ?? [],
      customer: people?.data ?? null,
      address: addr?.data ?? null,
      products: new Map(prods.map((p) => [p.id, p])),
      packages: pkgs.data,
      shipments: shps.data,
    };
  }, [id]);

  async function move(to: string) {
    if (!data) return;
    const previous = data.order;
    setBusy(to);
    // Optimistic: the badge changes now, and rolls back if the server refuses.
    setData((d) => (d ? { ...d, order: { ...d.order, status: to as Order["status"] } } : d));
    try {
      await orders.update(id, { status: to as Order["status"] });
      toast(`Durum "${ORDER_STATUS[to]?.label ?? to}" olarak güncellendi`);
      reload();
    } catch (e) {
      setData((d) => (d ? { ...d, order: previous } : d));
      toast(errText(e), "err");
    } finally {
      setBusy(null);
    }
  }

  if (loading) {
    return (
      <>
        <Skeleton className="mb-5 h-8 w-56" />
        <div className="grid gap-4 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <TableSkeleton rows={4} cols={4} />
          </Card>
          <Card>
            <TableSkeleton rows={5} cols={2} />
          </Card>
        </div>
      </>
    );
  }
  if (error || !data) return <EmptyState title="Sipariş yüklenemedi" hint={String(error ?? "")} />;

  const { order, lines, moves } = data;

  return (
    <>
      <PageHeader
        title={order.order_no ?? "Sipariş"}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={ORDER_STATUS[order.status]?.tone}>{ORDER_STATUS[order.status]?.label ?? order.status}</Badge>
            <Badge tone={PRIORITY[String(order.priority)]?.tone}>
              {PRIORITY[String(order.priority)]?.label ?? order.priority}
            </Badge>
            <span className="text-ink-dim">{CHANNEL[String(order.channel)] ?? order.channel}</span>
            <span className="text-ink-dim">·</span>
            <span className="text-ink-dim">{fmtDateTime(order.placed_at)}</span>
          </span>
        }
        actions={<Button variant="ghost" onClick={() => go("/orders")}>← Liste</Button>}
      />

      {moves.length > 0 ? (
        <Card className="mb-4">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-dim">Sonraki adım</p>
          <div className="flex flex-wrap gap-2">
            {moves.map((m) => (
              <Button
                key={m.to}
                variant={m.allowed ? "default" : "ghost"}
                disabled={!m.allowed || busy !== null}
                title={m.allowed ? undefined : m.reason}
                onClick={() => move(m.to)}
              >
                {busy === m.to ? "…" : (m.label ?? ORDER_STATUS[m.to]?.label ?? m.to)}
              </Button>
            ))}
          </div>
        </Card>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <h2 className="mb-3 text-sm font-medium text-ink">Satırlar</h2>
          {lines.length === 0 ? (
            <EmptyState title="Satır yok" />
          ) : (
            <TableScroll>
              <Table>
                <thead>
                  <tr>
                    <Th>Ürün</Th>
                    <Th className="text-right">Adet</Th>
                    <Th className="text-right">Toplanan</Th>
                    <Th className="text-right">Birim</Th>
                    <Th className="text-right">Tutar</Th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l) => {
                    const p = data.products.get(String(l.product));
                    const partial = (l.qty_picked ?? 0) < l.qty;
                    return (
                      <tr key={l.id} className="border-t border-line">
                        <Td>
                          <span className="block max-w-[18rem] truncate">{p?.name ?? "—"}</span>
                          <span className="font-mono text-xs text-ink-dim">{p?.sku}</span>
                        </Td>
                        <Td className="text-right tabular-nums">{fmtNumber(l.qty)}</Td>
                        <Td className={`text-right tabular-nums ${partial ? "text-warn" : "text-ink-muted"}`}>
                          {fmtNumber(l.qty_picked ?? 0)}
                        </Td>
                        <Td className="text-right tabular-nums text-ink-muted">{fmtMoney(l.unit_price)}</Td>
                        <Td className="text-right tabular-nums">{fmtMoney(l.line_total)}</Td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
            </TableScroll>
          )}

          <dl className="mt-4 space-y-1 border-t border-line pt-3 text-sm">
            <Row label="Ürün toplamı" value={fmtMoney(order.items_total)} />
            <Row label="İndirim" value={fmtMoney(order.discount_total)} />
            <Row label="Kargo" value={fmtMoney(order.shipping_fee)} />
            <Row label="Genel toplam" value={fmtMoney(order.grand_total)} strong />
          </dl>
        </Card>

        <div className="space-y-4">
          <Card>
            <h2 className="mb-2 text-sm font-medium text-ink">Müşteri</h2>
            {data.customer ? (
              <div className="space-y-1 text-sm">
                <p className="font-medium">{data.customer.name}</p>
                <p className="font-mono text-xs text-ink-dim">{data.customer.code}</p>
                {data.customer.phone ? <p className="text-ink-muted">{data.customer.phone}</p> : null}
                {data.customer.email ? <p className="break-all text-ink-muted">{data.customer.email}</p> : null}
              </div>
            ) : (
              <p className="text-sm text-ink-dim">—</p>
            )}
            {data.address ? (
              <div className="mt-3 border-t border-line pt-3 text-sm text-ink-muted">
                <p className="text-xs uppercase tracking-wide text-ink-dim">{data.address.label}</p>
                <p className="mt-1">{data.address.line1}</p>
                <p>
                  {data.address.district ? `${data.address.district} / ` : ""}
                  {data.address.city} {data.address.postcode ?? ""}
                </p>
              </div>
            ) : null}
          </Card>

          <Card>
            <h2 className="mb-2 text-sm font-medium text-ink">Koliler</h2>
            {data.packages.length === 0 ? (
              <p className="text-sm text-ink-dim">Henüz paketlenmedi.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {data.packages.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-2">
                    <span className="font-mono text-xs">{p.package_no}</span>
                    <span className="text-ink-muted">{fmtWeight(p.weight_g)}</span>
                    <Badge tone={PACKAGE_STATUS[String(p.status)]?.tone}>
                      {PACKAGE_STATUS[String(p.status)]?.label ?? p.status}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <h2 className="mb-2 text-sm font-medium text-ink">Sevkiyat</h2>
            {data.shipments.length === 0 ? (
              <p className="text-sm text-ink-dim">Henüz kargoya verilmedi.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {data.shipments.map((s) => (
                  <li key={s.id} className="space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-xs">{s.shipment_no}</span>
                      <Badge tone={SHIPMENT_STATUS[s.status]?.tone}>
                        {SHIPMENT_STATUS[s.status]?.label ?? s.status}
                      </Badge>
                    </div>
                    {s.tracking_no ? <p className="font-mono text-xs text-ink-dim">{s.tracking_no}</p> : null}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex items-baseline justify-between gap-4 ${strong ? "pt-1 text-base font-semibold" : ""}`}>
      <dt className={strong ? "" : "text-ink-muted"}>{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}
