/**
 * Cargo: what left, where it is, and the tracking number to read out loud.
 */
import { useState } from "react";
import { carriers, listAll, orders, shipmentEvents, shipments, type Shipment } from "../lib/backlex";
import { SERVICE, SHIPMENT_STATUS, fmtDateTime, fmtMoney, fmtWeight } from "../lib/format";
import { errText, useAsync, useToast } from "../lib/hooks";
import { Badge, Button, Card, EmptyState, PageHeader, Table, TableScroll, TableSkeleton, Td, Th, cx, inputCls } from "../lib/ui";

const TABS: { key: string; label: string; statuses?: Shipment["status"][] }[] = [
  { key: "moving", label: "Yolda", statuses: ["created", "handed_over", "in_transit", "out_for_delivery"] },
  { key: "delivered", label: "Teslim", statuses: ["delivered"] },
  { key: "problem", label: "Sorunlu", statuses: ["returned", "lost"] },
  { key: "all", label: "Tümü" },
];

export function Shipments({ go }: { go: (to: string) => void }) {
  const toast = useToast();
  const [tab, setTab] = useState("moving");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  const active = TABS.find((t) => t.key === tab) ?? TABS[0]!;

  const { data, loading, error, reload, setData } = useAsync(async () => {
    const filter = active.statuses ? { status: { _in: active.statuses } } : undefined;
    const [rows, carrierRows, orderRows] = await Promise.all([
      shipments.list({ limit: 100, sort: "-created_at", ...(filter ? { filter } : {}), ...(q ? { q } : {}) }),
      carriers.list({ limit: 200 }),
      listAll(orders),
    ]);
    return {
      rows: rows.data,
      carriers: new Map(carrierRows.data.map((c) => [c.id, c])),
      orders: new Map(orderRows.map((o) => [o.id, o])),
    };
  }, [tab, q]);

  const { data: events, loading: eventsLoading } = useAsync(
    async () => (open ? (await shipmentEvents.list({ filter: { shipment: { _eq: open } }, limit: 50, sort: "-occurred_at" })).data : []),
    [open],
  );

  const NEXT: Partial<Record<Shipment["status"], Shipment["status"]>> = {
    created: "handed_over",
    handed_over: "in_transit",
    in_transit: "out_for_delivery",
    out_for_delivery: "delivered",
  };

  async function move(s: Shipment) {
    const to = NEXT[s.status];
    if (!to) return;
    const prev = s.status;
    setData((d) => (d ? { ...d, rows: d.rows.map((x) => (x.id === s.id ? { ...x, status: to } : x)) } : d));
    try {
      await shipments.update(s.id, {
        status: to,
        ...(to === "handed_over" ? { dispatched_at: Date.now() } : {}),
        ...(to === "delivered" ? { delivered_at: Date.now() } : {}),
      });
      await shipmentEvents.create({
        shipment: s.id,
        status: to,
        location: s.destination_city ?? "",
        description: SHIPMENT_STATUS[to]?.label ?? to,
      });
      reload();
    } catch (e) {
      setData((d) => (d ? { ...d, rows: d.rows.map((x) => (x.id === s.id ? { ...x, status: prev } : x)) } : d));
      toast(errText(e), "err");
    }
  }

  /**
   * The carrier's template is operator-entered data, and it ends up in an
   * `href`. `javascript:` and `data:` are both valid URL schemes and both run
   * in the page, so the scheme is checked before the link is offered — a
   * template that is not http(s) renders as plain text instead.
   */
  const trackingUrl = (s: Shipment) => {
    const tpl = data?.carriers.get(String(s.carrier))?.tracking_url_template;
    if (!tpl || !s.tracking_no) return null;
    const raw = tpl.replace("{{tracking_no}}", encodeURIComponent(s.tracking_no));
    try {
      const u = new URL(raw);
      return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
    } catch {
      return null;
    }
  };

  return (
    <>
      <PageHeader
        title="Sevkiyat"
        subtitle={loading ? undefined : `${data?.rows.length ?? 0} gönderi`}
        actions={
          <input
            className={cx(inputCls, "w-40 sm:w-64")}
            placeholder="Takip / sevkiyat no…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Sevkiyat ara"
          />
        }
      />

      <div className="-mx-4 mb-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <div className="flex gap-1">
          {TABS.map((t) => (
            <Button key={t.key} variant={tab === t.key ? "primary" : "ghost"} onClick={() => setTab(t.key)}>
              {t.label}
            </Button>
          ))}
        </div>
      </div>

      {error ? <EmptyState title="Sevkiyatlar yüklenemedi" hint={String(error)} /> : null}

      {loading ? (
        <TableSkeleton rows={8} cols={7} />
      ) : (data?.rows.length ?? 0) === 0 ? (
        <EmptyState
          title={q ? "Eşleşen gönderi yok" : "Bu kolonda gönderi yok"}
          hint={q ? `"${q}" için sonuç bulunamadı.` : "Koliler kargoya verildikçe burada görünür."}
        />
      ) : (
        <Card>
          <TableScroll>
            <Table>
              <thead>
                <tr>
                  <Th>Sevkiyat</Th>
                  <Th>Sipariş</Th>
                  <Th>Kargo</Th>
                  <Th>Takip no</Th>
                  <Th>Varış</Th>
                  <Th>Servis</Th>
                  <Th>Durum</Th>
                  <Th className="text-right">Ağırlık</Th>
                  <Th className="text-right">Ücret</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {data?.rows.map((s) => {
                  const url = trackingUrl(s);
                  return (
                    <>
                      <tr key={s.id} className="border-t border-white/5 hover:bg-white/5">
                        <Td>
                          <button
                            type="button"
                            className="font-mono text-xs underline-offset-2 hover:underline"
                            onClick={() => setOpen(open === s.id ? null : s.id)}
                            aria-expanded={open === s.id}
                          >
                            {s.shipment_no}
                          </button>
                        </Td>
                        <Td className="font-mono text-xs text-white/50">
                          <button type="button" className="underline-offset-2 hover:underline" onClick={() => go(`/orders/${s.order}`)}>
                            {data.orders.get(String(s.order))?.order_no ?? "—"}
                          </button>
                        </Td>
                        <Td className="text-white/60">{data.carriers.get(String(s.carrier))?.name ?? "—"}</Td>
                        <Td className="font-mono text-xs">
                          {url ? (
                            <a href={url} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                              {s.tracking_no}
                            </a>
                          ) : (
                            (s.tracking_no ?? "—")
                          )}
                        </Td>
                        <Td className="text-white/60">{s.destination_city ?? "—"}</Td>
                        <Td className="text-white/50">{SERVICE[String(s.service)] ?? s.service}</Td>
                        <Td>
                          <Badge tone={SHIPMENT_STATUS[s.status]?.tone}>
                            {SHIPMENT_STATUS[s.status]?.label ?? s.status}
                          </Badge>
                        </Td>
                        <Td className="text-right tabular-nums text-white/60">{fmtWeight(s.weight_g)}</Td>
                        <Td className="text-right tabular-nums text-white/60">{fmtMoney(s.cost)}</Td>
                        <Td className="text-right">
                          {NEXT[s.status] ? (
                            <Button onClick={() => move(s)} title={SHIPMENT_STATUS[NEXT[s.status]!]?.label}>
                              {SHIPMENT_STATUS[NEXT[s.status]!]?.label}
                            </Button>
                          ) : null}
                        </Td>
                      </tr>
                      {open === s.id ? (
                        <tr key={`${s.id}-events`} className="border-t border-white/5 bg-black/20">
                          <Td className="p-0" />
                          <td colSpan={9} className="px-3 py-3">
                            {eventsLoading ? (
                              <TableSkeleton rows={3} cols={3} />
                            ) : (events ?? []).length === 0 ? (
                              <p className="text-sm text-white/40">Bu gönderi için hareket kaydı yok.</p>
                            ) : (
                              <ol className="space-y-2">
                                {(events ?? []).map((e) => (
                                  <li key={e.id} className="flex flex-wrap items-baseline gap-2 text-sm">
                                    <span className="w-40 shrink-0 text-white/45">{fmtDateTime(e.occurred_at)}</span>
                                    <Badge tone={SHIPMENT_STATUS[String(e.status)]?.tone}>
                                      {SHIPMENT_STATUS[String(e.status)]?.label ?? e.status}
                                    </Badge>
                                    <span className="text-white/60">{e.location}</span>
                                    <span className="text-white/40">{e.description}</span>
                                  </li>
                                ))}
                              </ol>
                            )}
                          </td>
                        </tr>
                      ) : null}
                    </>
                  );
                })}
              </tbody>
            </Table>
          </TableScroll>
        </Card>
      )}
    </>
  );
}
