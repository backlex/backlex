/**
 * Order preparation: the waves waiting to be picked, and the button that
 * builds a new one out of everything confirmed but not yet started.
 */
import { useState } from "react";
import {
  bins,
  listAll,
  orderLines,
  orders,
  pickTasks,
  pickWaves,
  stockLevels,
  warehouses,
  type PickWave,
} from "../lib/backlex";
import { WAVE_STATUS, fmtDateTime, fmtNumber } from "../lib/format";
import { errText, useAsync, useToast } from "../lib/hooks";
import { Badge, Button, Card, EmptyState, PageHeader, Table, TableScroll, TableSkeleton, Td, Th } from "@backlex-examples/shared";

export function Fulfillment({ go }: { go: (to: string) => void }) {
  const toast = useToast();
  const [building, setBuilding] = useState(false);

  const { data, loading, error, reload, setData } = useAsync(async () => {
    const [waves, whs, pending] = await Promise.all([
      pickWaves.list({ limit: 50, sort: "-planned_at" }),
      warehouses.list({ limit: 200 }),
      orders.list({ filter: { status: { _eq: "confirmed" } }, limit: 200 }),
    ]);
    return {
      waves: waves.data,
      warehouses: new Map(whs.data.map((w) => [w.id, w])),
      firstWarehouse: whs.data[0] ?? null,
      pending: pending.data,
    };
  }, []);

  /**
   * Build a wave out of every confirmed order in the warehouse.
   *
   * One task per (line × bin holding that product), sequenced by the bin's own
   * `pick_sequence` so the picker walks the aisle once rather than criss-crossing
   * it — which is the entire reason `bins.pick_sequence` is an `order` field.
   */
  async function buildWave() {
    if (!data?.firstWarehouse) return;
    setBuilding(true);
    try {
      const wh = data.firstWarehouse;
      const ready = data.pending.filter((o) => o.warehouse === wh.id);
      if (ready.length === 0) {
        toast("Toplanacak onaylı sipariş yok", "err");
        return;
      }
      // `limit` tops out at 200 and the server answers 422 rather than clamping,
      // so anything that could exceed it is PAGED, never asked for in one go.
      const [binRows, levelRows] = await Promise.all([
        bins.list({ filter: { warehouse: { _eq: wh.id } }, limit: 200, sort: "pick_sequence" }),
        listAll(stockLevels),
      ]);
      const binOrder = new Map(binRows.data.map((b, i) => [b.id, b.pick_sequence ?? i]));
      const levelsHere = levelRows.filter((l) => binOrder.has(String(l.bin)));

      const wave = await pickWaves.create({ warehouse: wh.id, status: "planned", assigned_to: "" });

      type Draft = { order: string; line: string; product: string; bin: string; qty: number; seq: number };
      const perOrder = await Promise.all(
        ready.map((o) => orderLines.list({ filter: { order: { _eq: o.id } }, limit: 200 })),
      );
      const drafts: Draft[] = [];
      ready.forEach((o, oi) => {
        for (const l of perOrder[oi]?.data ?? []) {
          const lvl = levelsHere.find((x) => x.product === l.product);
          if (!lvl) continue;
          drafts.push({
            order: o.id,
            line: l.id,
            product: String(l.product),
            bin: String(lvl.bin),
            qty: l.qty,
            seq: binOrder.get(String(lvl.bin)) ?? 0,
          });
        }
      });
      drafts.sort((a, b) => a.seq - b.seq);

      // One round trip for every task, and one for every order — a wave of a
      // hundred lines is otherwise a hundred sequential requests, and the
      // operator watches a spinner for a minute.
      if (drafts.length > 0) {
        await pickTasks.batch(
          drafts.map((d, i) => ({
            op: "create",
            data: {
              wave: wave.data.id,
              order: d.order,
              order_line: d.line,
              product: d.product,
              bin: d.bin,
              qty_required: d.qty,
              status: "pending" as const,
              sequence: i + 1,
            },
          })),
        );
      }
      await orders.batch(ready.map((o) => ({ op: "update", id: o.id, data: { status: "picking" as const } })));

      toast(`${wave.data.wave_no} oluşturuldu — ${drafts.length} görev`);
      go(`/fulfillment/${wave.data.id}`);
    } catch (e) {
      toast(errText(e), "err");
      reload();
    } finally {
      setBuilding(false);
    }
  }

  async function move(w: PickWave, to: PickWave["status"]) {
    const prev = w.status;
    setData((d) =>
      d ? { ...d, waves: d.waves.map((x) => (x.id === w.id ? { ...x, status: to } : x)) } : d,
    );
    try {
      await pickWaves.update(w.id, { status: to, ...(to === "released" ? { released_at: Date.now() } : {}) });
      reload();
    } catch (e) {
      setData((d) => (d ? { ...d, waves: d.waves.map((x) => (x.id === w.id ? { ...x, status: prev } : x)) } : d));
      toast(errText(e), "err");
    }
  }

  const NEXT: Partial<Record<PickWave["status"], PickWave["status"]>> = {
    planned: "released",
    released: "in_progress",
    in_progress: "completed",
  };

  return (
    <>
      <PageHeader
        title="Hazırlık"
        subtitle={loading ? undefined : `${fmtNumber(data?.pending.length ?? 0)} onaylı sipariş toplanmayı bekliyor`}
        actions={
          <Button variant="primary" onClick={buildWave} disabled={building || loading}>
            {building ? "Oluşturuluyor…" : "Dalga oluştur"}
          </Button>
        }
      />

      {error ? <EmptyState title="Dalgalar yüklenemedi" hint={String(error)} /> : null}

      {loading ? (
        <TableSkeleton rows={6} cols={6} />
      ) : (data?.waves.length ?? 0) === 0 ? (
        <EmptyState
          title="Henüz toplama dalgası yok"
          hint="Onaylı siparişleri tek bir yürüyüşe toplamak için bir dalga oluşturun."
        />
      ) : (
        <Card>
          <TableScroll>
            <Table>
              <thead>
                <tr>
                  <Th>Dalga</Th>
                  <Th>Depo</Th>
                  <Th>Durum</Th>
                  <Th>Toplayıcı</Th>
                  <Th className="text-right">Görev</Th>
                  <Th className="text-right">Toplanan</Th>
                  <Th>Planlanma</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {data?.waves.map((w) => (
                  <tr key={w.id} className="border-t border-line hover:bg-raised">
                    <Td>
                      <button type="button" className="font-mono text-xs underline-offset-2 hover:underline" onClick={() => go(`/fulfillment/${w.id}`)}>
                        {w.wave_no}
                      </button>
                    </Td>
                    <Td className="text-ink-muted">{data.warehouses.get(String(w.warehouse))?.name ?? "—"}</Td>
                    <Td>
                      <Badge tone={WAVE_STATUS[w.status]?.tone}>{WAVE_STATUS[w.status]?.label ?? w.status}</Badge>
                    </Td>
                    <Td className="text-ink-muted">{w.assigned_to || "—"}</Td>
                    <Td className="text-right tabular-nums">{fmtNumber(w.task_count)}</Td>
                    <Td className="text-right tabular-nums text-ink-muted">{fmtNumber(w.units_picked)}</Td>
                    <Td className="whitespace-nowrap text-ink-muted">{fmtDateTime(w.planned_at)}</Td>
                    <Td className="text-right">
                      {NEXT[w.status] ? (
                        <Button onClick={() => move(w, NEXT[w.status]!)}>
                          {WAVE_STATUS[NEXT[w.status]!]?.label}
                        </Button>
                      ) : null}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </TableScroll>
        </Card>
      )}
    </>
  );
}
