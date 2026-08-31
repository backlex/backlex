/**
 * Stock by bin, and the ledger behind it.
 *
 * `available` is `on_hand − committed` and is computed in ONE place
 * (`lib/backlex.ts`) — the server maintains `committed` as a rollup over held
 * reservations but does not maintain the difference, and a subtraction written
 * per screen is a subtraction that drifts per screen.
 */
import { useMemo, useState } from "react";
import { available, bins, listAll, products, stockLevels, stockMovements, warehouses } from "../lib/backlex";
import { MOVEMENT_REASON, fmtDateTime, fmtMoney, fmtNumber } from "../lib/format";
import { errText, useAsync, useToast } from "../lib/hooks";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Modal,
  PageHeader,
  Table,
  TableScroll,
  TableSkeleton,
  Td,
  Th,
  cx,
  inputCls,
} from "../lib/ui";

export function Stock() {
  const toast = useToast();
  const [warehouse, setWarehouse] = useState<string>("");
  const [onlyLow, setOnlyLow] = useState(false);
  const [adjust, setAdjust] = useState<{ levelId: string; label: string } | null>(null);
  const [delta, setDelta] = useState("");
  const [reason, setReason] = useState<"adjustment" | "receipt" | "damage" | "return">("adjustment");
  const [saving, setSaving] = useState(false);

  const { data, loading, error, reload } = useAsync(async () => {
    const [levels, prods, binRows, whs, moves] = await Promise.all([
      listAll(stockLevels, { sort: "-on_hand" }),
      listAll(products),
      listAll(bins),
      warehouses.list({ limit: 200 }),
      stockMovements.list({ limit: 20, sort: "-occurred_at" }),
    ]);
    return {
      levels,
      products: new Map(prods.map((p) => [p.id, p])),
      bins: new Map(binRows.map((b) => [b.id, b])),
      warehouses: whs.data,
      moves: moves.data,
    };
  }, []);

  const rows = useMemo(() => {
    if (!data) return [];
    return data.levels.filter((l) => {
      const bin = data.bins.get(String(l.bin));
      if (warehouse && bin?.warehouse !== warehouse) return false;
      if (onlyLow && !(typeof l.reorder_point === "number" && available(l) <= l.reorder_point)) return false;
      return true;
    });
  }, [data, warehouse, onlyLow]);

  const totals = useMemo(
    () => ({
      onHand: rows.reduce((n, l) => n + (l.on_hand ?? 0), 0),
      committed: rows.reduce((n, l) => n + (l.committed ?? 0), 0),
      value: rows.reduce((n, l) => n + (data?.products.get(String(l.product))?.list_price?.amount ?? 0) * (l.on_hand ?? 0), 0),
    }),
    [rows, data],
  );

  async function saveAdjust() {
    if (!adjust || !data) return;
    const n = Number(delta);
    if (!Number.isFinite(n) || n === 0) {
      toast("Sıfırdan farklı bir miktar girin", "err");
      return;
    }
    const level = data.levels.find((l) => l.id === adjust.levelId);
    if (!level) return;
    setSaving(true);
    try {
      // Ledger first, then the level. If the second write fails the movement is
      // still there to reconcile against — the reverse order loses the reason.
      await stockMovements.create({
        product: level.product,
        bin: level.bin,
        qty: Math.trunc(n),
        reason,
        reference: "MANUEL",
      });
      await stockLevels.update(level.id, { on_hand: Math.max(0, (level.on_hand ?? 0) + Math.trunc(n)) });
      toast(`${adjust.label}: ${n > 0 ? "+" : ""}${fmtNumber(Math.trunc(n))} işlendi`);
      setAdjust(null);
      setDelta("");
      reload();
    } catch (e) {
      toast(errText(e), "err");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Stok"
        subtitle={loading ? undefined : `${fmtNumber(rows.length)} raf kaydı · ${fmtNumber(totals.onHand)} adet elde`}
        actions={
          <>
            <select
              className={cx(inputCls, "w-36 sm:w-48")}
              value={warehouse}
              onChange={(e) => setWarehouse(e.target.value)}
              aria-label="Depo"
            >
              <option value="">Tüm depolar</option>
              {data?.warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
            <Button variant={onlyLow ? "primary" : "default"} onClick={() => setOnlyLow((v) => !v)}>
              Kritik
            </Button>
          </>
        }
      />

      <div className="mb-4 grid grid-cols-3 gap-3">
        <Card>
          <p className="text-xs uppercase tracking-wide text-white/40">Elde</p>
          <p className="mt-1 text-xl font-semibold tabular-nums">{fmtNumber(totals.onHand)}</p>
        </Card>
        <Card>
          <p className="text-xs uppercase tracking-wide text-white/40">Rezerve</p>
          <p className="mt-1 text-xl font-semibold tabular-nums text-amber-300">{fmtNumber(totals.committed)}</p>
        </Card>
        <Card>
          <p className="text-xs uppercase tracking-wide text-white/40">Liste değeri</p>
          <p className="mt-1 text-xl font-semibold tabular-nums">{fmtMoney({ amount: totals.value, currency: "TRY" })}</p>
        </Card>
      </div>

      {error ? <EmptyState title="Stok yüklenemedi" hint={String(error)} /> : null}

      {loading ? (
        <TableSkeleton rows={8} cols={6} />
      ) : rows.length === 0 ? (
        <EmptyState
          title={onlyLow ? "Kritik stok yok" : "Stok kaydı yok"}
          hint={onlyLow ? "Her rafta sipariş noktasının üzerinde stok var." : "Mal kabul yapıldıkça burada görünür."}
          action={onlyLow ? <Button onClick={() => setOnlyLow(false)}>Tümünü göster</Button> : undefined}
        />
      ) : (
        <Card>
          <TableScroll>
            <Table>
              <thead>
                <tr>
                  <Th>Ürün</Th>
                  <Th>Raf</Th>
                  <Th className="text-right">Elde</Th>
                  <Th className="text-right">Rezerve</Th>
                  <Th className="text-right">Kullanılabilir</Th>
                  <Th className="text-right">Sipariş nk.</Th>
                  <Th>Son sayım</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {rows.map((l) => {
                  const p = data?.products.get(String(l.product));
                  const b = data?.bins.get(String(l.bin));
                  const avail = available(l);
                  const low = typeof l.reorder_point === "number" && avail <= l.reorder_point;
                  return (
                    <tr key={l.id} className="border-t border-white/5 hover:bg-white/5">
                      <Td>
                        <span className="block max-w-[16rem] truncate">{p?.name ?? "—"}</span>
                        <span className="font-mono text-xs text-white/40">{p?.sku}</span>
                      </Td>
                      <Td className="font-mono text-xs">{b?.code ?? "—"}</Td>
                      <Td className="text-right tabular-nums">{fmtNumber(l.on_hand)}</Td>
                      <Td className="text-right tabular-nums text-white/50">{fmtNumber(l.committed ?? 0)}</Td>
                      <Td className={cx("text-right tabular-nums font-medium", avail < 0 ? "text-red-300" : low ? "text-amber-300" : "")}>
                        {fmtNumber(avail)}
                      </Td>
                      <Td className="text-right tabular-nums text-white/40">{fmtNumber(l.reorder_point)}</Td>
                      <Td className="whitespace-nowrap text-white/50">{fmtDateTime(l.counted_at)}</Td>
                      <Td className="text-right">
                        <Button onClick={() => setAdjust({ levelId: l.id, label: `${p?.sku ?? ""} @ ${b?.code ?? ""}` })}>
                          Düzelt
                        </Button>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          </TableScroll>
        </Card>
      )}

      <Card className="mt-4">
        <h2 className="mb-3 text-sm font-medium text-white/70">Son hareketler</h2>
        {loading ? (
          <TableSkeleton rows={5} cols={4} />
        ) : (data?.moves.length ?? 0) === 0 ? (
          <EmptyState title="Hareket yok" />
        ) : (
          <TableScroll>
            <Table>
              <thead>
                <tr>
                  <Th>Zaman</Th>
                  <Th>Ürün</Th>
                  <Th>Raf</Th>
                  <Th>Neden</Th>
                  <Th>Referans</Th>
                  <Th className="text-right">Miktar</Th>
                </tr>
              </thead>
              <tbody>
                {data?.moves.map((m) => (
                  <tr key={m.id} className="border-t border-white/5">
                    <Td className="whitespace-nowrap text-white/50">{fmtDateTime(m.occurred_at)}</Td>
                    <Td className="max-w-[14rem] truncate">{data.products.get(String(m.product))?.name ?? "—"}</Td>
                    <Td className="font-mono text-xs">{data.bins.get(String(m.bin))?.code ?? "—"}</Td>
                    <Td>
                      <Badge tone={m.qty < 0 ? "amber" : "green"}>{MOVEMENT_REASON[String(m.reason)] ?? m.reason}</Badge>
                    </Td>
                    <Td className="font-mono text-xs text-white/40">{m.reference ?? "—"}</Td>
                    <Td className={cx("text-right tabular-nums", m.qty < 0 ? "text-amber-300" : "text-emerald-300")}>
                      {m.qty > 0 ? "+" : ""}
                      {fmtNumber(m.qty)}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </TableScroll>
        )}
      </Card>

      <Modal
        open={adjust !== null}
        onClose={() => setAdjust(null)}
        title={`Stok düzeltmesi — ${adjust?.label ?? ""}`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setAdjust(null)}>
              Vazgeç
            </Button>
            <Button variant="primary" onClick={saveAdjust} disabled={saving}>
              {saving ? "Kaydediliyor…" : "Kaydet"}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Miktar" hint="Girişte artı, çıkışta eksi yazın. Hareket defterine bu işaretle düşer.">
            <input
              className={inputCls}
              type="number"
              inputMode="numeric"
              value={delta}
              onChange={(e) => setDelta(e.target.value)}
              placeholder="örn. -3"
            />
          </Field>
          <Field label="Neden" hint="Sonradan hangi farkın nereden geldiğini bu alan anlatır.">
            <select className={inputCls} value={reason} onChange={(e) => setReason(e.target.value as typeof reason)}>
              <option value="adjustment">Sayım farkı</option>
              <option value="receipt">Mal kabul</option>
              <option value="return">İade girişi</option>
              <option value="damage">Hasar / fire</option>
            </select>
          </Field>
        </div>
      </Modal>
    </>
  );
}
