/**
 * The picker's screen: one wave, its tasks in walk order, and a confirm button
 * per line.
 *
 * Confirming a pick writes THREE things — the task, the ledger row, and the
 * level — because no one of them implies the others. The task says the work
 * happened, `stock_movements` is the audit trail every stock report sums, and
 * `stock_levels.on_hand` is what the next order is checked against.
 */
import { useState } from "react";
import { bins, listAll, orderLines, orders, pickTasks, pickWaves, products, stockLevels, stockMovements, type PickTask } from "../lib/backlex";
import { TASK_STATUS, WAVE_STATUS, fmtDateTime, fmtNumber } from "../lib/format";
import { errText, useAsync, useToast } from "../lib/hooks";
import { Badge, Button, Card, controlCls, cx, EmptyState, PageHeader, Skeleton, Table, TableScroll, TableSkeleton, Td, Th } from "@backlex-examples/shared";

export function WaveDetail({ id, go }: { id: string; go: (to: string) => void }) {
  const toast = useToast();
  const [qty, setQty] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const { data, loading, error, reload, setData } = useAsync(async () => {
    const wave = await pickWaves.one(id);
    const [tasks, prods, binRows, orderRows] = await Promise.all([
      pickTasks.list({ filter: { wave: { _eq: id } }, limit: 200, sort: "sequence" }),
      listAll(products),
      listAll(bins),
      listAll(orders),
    ]);
    return {
      wave: wave.data,
      tasks: tasks.data,
      products: new Map(prods.map((p) => [p.id, p])),
      bins: new Map(binRows.map((b) => [b.id, b])),
      orders: new Map(orderRows.map((o) => [o.id, o])),
    };
  }, [id]);

  async function confirmPick(t: PickTask) {
    const typed = Number(qty[t.id] ?? t.qty_required);
    const picked = Number.isFinite(typed) ? Math.max(0, Math.trunc(typed)) : t.qty_required;
    const nextStatus: PickTask["status"] = picked >= t.qty_required ? "picked" : "short";
    const snapshot = data?.tasks ?? [];
    setBusy(t.id);
    setData((d) =>
      d ? { ...d, tasks: d.tasks.map((x) => (x.id === t.id ? { ...x, qty_picked: picked, status: nextStatus } : x)) } : d,
    );
    try {
      // `pending → picked` is not an edge; the lifecycle goes through `picking`.
      if (t.status === "pending") await pickTasks.update(t.id, { status: "picking" });
      await pickTasks.update(t.id, { status: nextStatus, qty_picked: picked, picked_at: Date.now() });
      if (picked > 0) {
        await stockMovements.create({
          product: t.product,
          bin: t.bin,
          qty: -picked,
          reason: "pick",
          reference: data?.orders.get(String(t.order))?.order_no ?? String(t.order),
        });
        const lvls = await stockLevels.list({ filter: { product: { _eq: String(t.product) }, bin: { _eq: String(t.bin) } }, limit: 1 });
        const lvl = lvls.data[0];
        if (lvl) await stockLevels.update(lvl.id, { on_hand: Math.max(0, lvl.on_hand - picked) });
        if (t.order_line) await orderLines.update(String(t.order_line), { qty_picked: picked });
      }
      toast(`${fmtNumber(picked)} adet toplandı`);
      reload();
    } catch (e) {
      setData((d) => (d ? { ...d, tasks: snapshot } : d));
      toast(errText(e), "err");
    } finally {
      setBusy(null);
    }
  }

  if (loading) {
    return (
      <>
        <Skeleton className="mb-5 h-8 w-48" />
        <Card>
          <TableSkeleton rows={8} cols={6} />
        </Card>
      </>
    );
  }
  if (error || !data) return <EmptyState title="Dalga yüklenemedi" hint={String(error ?? "")} />;

  const { wave, tasks } = data;
  const done = tasks.filter((t) => t.status === "picked").length;

  return (
    <>
      <PageHeader
        title={wave.wave_no ?? "Dalga"}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={WAVE_STATUS[wave.status]?.tone}>{WAVE_STATUS[wave.status]?.label ?? wave.status}</Badge>
            <span className="text-ink-dim">
              {fmtNumber(done)} / {fmtNumber(tasks.length)} görev tamam
            </span>
            <span className="text-ink-dim">·</span>
            <span className="text-ink-dim">{fmtDateTime(wave.planned_at)}</span>
          </span>
        }
        actions={<Button variant="ghost" onClick={() => go("/fulfillment")}>← Dalgalar</Button>}
      />

      <div className="mb-4 h-2 overflow-hidden rounded-full bg-raised">
        <div
          className="h-full rounded-full bg-ok/70 transition-[width]"
          style={{ width: `${tasks.length ? (done / tasks.length) * 100 : 0}%` }}
        />
      </div>

      {tasks.length === 0 ? (
        <EmptyState title="Bu dalgada görev yok" hint="Dalga boş oluşturulmuş olabilir." />
      ) : (
        <Card>
          <TableScroll>
            <Table>
              <thead>
                <tr>
                  <Th className="text-right">#</Th>
                  <Th>Raf</Th>
                  <Th>Ürün</Th>
                  <Th>Sipariş</Th>
                  <Th className="text-right">İstenen</Th>
                  <Th className="text-right">Toplanan</Th>
                  <Th>Durum</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {tasks.map((t) => {
                  const p = data.products.get(String(t.product));
                  const settled = t.status === "picked" || t.status === "short";
                  return (
                    <tr key={t.id} className={cx("border-t border-line", settled && "opacity-60")}>
                      <Td className="text-right tabular-nums text-ink-dim">{t.sequence}</Td>
                      <Td className="font-mono text-xs">{data.bins.get(String(t.bin))?.code ?? "—"}</Td>
                      <Td>
                        <span className="block max-w-[16rem] truncate">{p?.name ?? "—"}</span>
                        <span className="font-mono text-xs text-ink-dim">{p?.sku}</span>
                      </Td>
                      <Td className="font-mono text-xs text-ink-muted">
                        {data.orders.get(String(t.order))?.order_no ?? "—"}
                      </Td>
                      <Td className="text-right tabular-nums">{fmtNumber(t.qty_required)}</Td>
                      <Td className="text-right">
                        {settled ? (
                          <span className="tabular-nums">{fmtNumber(t.qty_picked ?? 0)}</span>
                        ) : (
                          <input
                            className={cx(controlCls, "w-20 text-right tabular-nums")}
                            type="number"
                            min={0}
                            max={t.qty_required}
                            inputMode="numeric"
                            aria-label={`${p?.name ?? "ürün"} için toplanan adet`}
                            value={qty[t.id] ?? String(t.qty_required)}
                            onChange={(e) => setQty((s) => ({ ...s, [t.id]: e.target.value }))}
                          />
                        )}
                      </Td>
                      <Td>
                        <Badge tone={TASK_STATUS[t.status]?.tone}>{TASK_STATUS[t.status]?.label ?? t.status}</Badge>
                      </Td>
                      <Td className="text-right">
                        {settled ? null : (
                          <Button variant="primary" disabled={busy === t.id} onClick={() => confirmPick(t)}>
                            {busy === t.id ? "…" : "Onayla"}
                          </Button>
                        )}
                      </Td>
                    </tr>
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
