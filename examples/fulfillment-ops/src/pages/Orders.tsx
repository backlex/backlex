/**
 * The order queue. Filtering happens on the SERVER — a warehouse's order table
 * outgrows a page long before it outgrows a day, so narrowing in the browser
 * would narrow one page and call it the answer.
 */
import { useMemo, useState } from "react";
import { customers, listAll, orders, type Order } from "../lib/backlex";
import { CHANNEL, ORDER_STATUS, PRIORITY, fmtDateTime, fmtMoney, fmtNumber } from "../lib/format";
import { useAsync } from "../lib/hooks";
import { Badge, Button, controlCls, cx, EmptyState, PageHeader, Table, TableScroll, TableSkeleton, Td, Th } from "@backlex-examples/shared";

const TABS: { key: string; label: string; statuses?: Order["status"][] }[] = [
  { key: "open", label: "Açık", statuses: ["new", "confirmed", "picking"] },
  { key: "packed", label: "Paketlendi", statuses: ["packed"] },
  { key: "shipped", label: "Yolda", statuses: ["shipped"] },
  { key: "delivered", label: "Teslim", statuses: ["delivered"] },
  { key: "all", label: "Tümü" },
];

export function Orders({ go }: { go: (to: string) => void }) {
  const [tab, setTab] = useState("open");
  const [q, setQ] = useState("");

  const active = TABS.find((t) => t.key === tab) ?? TABS[0]!;

  const { data, loading, error } = useAsync(async () => {
    const filter = active.statuses ? { status: { _in: active.statuses } } : undefined;
    const [rows, people] = await Promise.all([
      orders.list({ limit: 100, sort: "-placed_at", ...(filter ? { filter } : {}), ...(q ? { q } : {}) }),
      listAll(customers),
    ]);
    return { rows: rows.data, people: new Map(people.map((c) => [c.id, c])) };
  }, [tab, q]);

  const counts = useMemo(() => data?.rows.length ?? 0, [data]);

  return (
    <>
      <PageHeader
        title="Siparişler"
        subtitle={loading ? undefined : `${fmtNumber(counts)} sipariş`}
        actions={
          <input
            className={cx(controlCls, "w-40 sm:w-64")}
            placeholder="Sipariş no ara…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Sipariş ara"
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

      {error ? <EmptyState title="Siparişler yüklenemedi" hint={String(error)} /> : null}

      {loading ? (
        <TableSkeleton rows={8} cols={6} />
      ) : (data?.rows.length ?? 0) === 0 ? (
        <EmptyState
          title={q ? "Eşleşen sipariş yok" : "Bu kolonda sipariş yok"}
          hint={q ? `"${q}" için sonuç bulunamadı.` : "Yeni siparişler geldikçe burada görünür."}
        />
      ) : (
        <TableScroll>
          <Table>
            <thead>
              <tr>
                <Th>Sipariş</Th>
                <Th>Müşteri</Th>
                <Th>Kanal</Th>
                <Th>Öncelik</Th>
                <Th>Durum</Th>
                <Th className="text-right">Satır</Th>
                <Th className="text-right">Tutar</Th>
                <Th>Tarih</Th>
              </tr>
            </thead>
            <tbody>
              {data?.rows.map((o) => (
                <tr
                  key={o.id}
                  className="cursor-pointer border-t border-line hover:bg-raised"
                  onClick={() => go(`/orders/${o.id}`)}
                >
                  <Td className="font-mono text-xs">{o.order_no ?? o.id.slice(0, 8)}</Td>
                  <Td className="max-w-[14rem] truncate">{data.people.get(String(o.customer))?.name ?? "—"}</Td>
                  <Td className="text-ink-muted">{CHANNEL[String(o.channel)] ?? o.channel}</Td>
                  <Td>
                    <Badge tone={PRIORITY[String(o.priority)]?.tone}>
                      {PRIORITY[String(o.priority)]?.label ?? o.priority}
                    </Badge>
                  </Td>
                  <Td>
                    <Badge tone={ORDER_STATUS[o.status]?.tone}>{ORDER_STATUS[o.status]?.label ?? o.status}</Badge>
                  </Td>
                  <Td className="text-right tabular-nums text-ink-muted">{fmtNumber(o.line_count)}</Td>
                  <Td className="text-right tabular-nums">{fmtMoney(o.grand_total)}</Td>
                  <Td className="whitespace-nowrap text-ink-muted">{fmtDateTime(o.placed_at)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </TableScroll>
      )}
    </>
  );
}
