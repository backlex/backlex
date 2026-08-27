/**
 * One order, and the four things a merchant does to it: take payment, ship it,
 * refund it, cancel it.
 *
 * Each of those writes the row the model expects rather than flipping a status
 * column and hoping: a payment writes a `transactions` row, a shipment writes a
 * `fulfillments` + `fulfillment_items` pair, a refund writes `refunds`. The
 * status column is then updated to match — it is a summary of the ledger, not
 * the ledger.
 */
import { useState } from "react";
import type { Order, OrderItem } from "../lib/backlex";
import { backlex, fulfillmentItems, fulfillments, locations, orderItems, orders, refunds } from "../lib/backlex";
import { errText, useAsync, useToast } from "../lib/hooks";
import { fmtDateTime, fmtMoney, moneyAmount } from "../lib/money";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNote,
  Field,
  Modal,
  PageHeader,
  Skeleton,
  Table,
  TableScroll,
  Td,
  Th,
  cx,
  inputCls,
} from "../lib/ui";
import { stateTone } from "./Dashboard";
import { payTone, shipTone } from "./Orders";

const transactions = backlex.from<{
  id: string;
  order?: string;
  kind?: string;
  status?: string;
  amount?: { amount: number; currency: string } | null;
  currency?: string;
  gateway?: string | null;
  reference?: string | null;
  processed_at?: number | null;
}>("transactions");

export function OrderDetail({ id, go }: { id: string; go: (to: string) => void }) {
  const toast = useToast();
  const [dialog, setDialog] = useState<null | "fulfil" | "refund" | "cancel">(null);

  const data = useAsync(async () => {
    const order = await orders.one(id, { expand: ["customer", "channel", "shipping_address", "shipping_rate"] }).then((r) => r.data);
    const [items, fuls, txs, rfs] = await Promise.all([
      orderItems.list({ filter: { order: { _eq: id } }, limit: 200, expand: ["variant"] }).then((r) => r.data),
      fulfillments.list({ filter: { order: { _eq: id } }, limit: 50 }).then((r) => r.data),
      transactions.list({ filter: { order: { _eq: id } }, sort: ["-processed_at"], limit: 50 }).then((r) => r.data),
      refunds.list({ filter: { order: { _eq: id } }, sort: ["-processed_at"], limit: 50 }).then((r) => r.data),
    ]);
    return { order, items, fuls, txs, rfs };
  }, [id]);

  if (data.error) {
    return (
      <>
        <PageHeader title="Order" actions={<Button onClick={() => go("/orders")}>Back</Button>} />
        <ErrorNote error={errText(data.error)} />
      </>
    );
  }
  if (!data.data) {
    return (
      <>
        <Skeleton className="h-8 w-56" />
        <div className="mt-4 grid gap-4 lg:grid-cols-3">
          <Skeleton className="h-64 lg:col-span-2" />
          <Skeleton className="h-64" />
        </div>
      </>
    );
  }

  const { order: o, items, fuls, txs, rfs } = data.data;
  const paid = txs.filter((t) => t.status === "success" && (t.kind === "sale" || t.kind === "capture")).reduce((s, t) => s + moneyAmount(t.amount), 0);
  const refunded = rfs.filter((r) => r.status === "success").reduce((s, r) => s + moneyAmount(r.amount), 0);
  const due = moneyAmount(o.total) - paid + refunded;

  async function markPaid() {
    try {
      await transactions.create({
        order: o.id,
        kind: "sale",
        status: "success",
        amount: { amount: moneyAmount(o.total), currency: o.currency ?? "USD" },
        currency: o.currency ?? "USD",
        gateway: "manual",
        processed_at: Date.now(),
      });
      await orders.update(o.id, { status: "paid" });
      toast("Payment recorded.");
      data.reload();
    } catch (e) {
      toast(errText(e), "err");
    }
  }

  return (
    <>
      <PageHeader
        title={`Order ${o.number ?? o.id.slice(0, 8)}`}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={stateTone(o.state)}>{o.state}</Badge>
            <Badge tone={payTone(o.status)}>{o.status}</Badge>
            <Badge tone={shipTone(o.fulfillment_status)}>{o.fulfillment_status}</Badge>
            <span className="text-white/40">{fmtDateTime(o.placed_at)}</span>
          </span>
        }
        actions={
          <>
            <Button onClick={() => go("/orders")}>Back</Button>
            {due > 0.005 && o.state !== "cancelled" ? (
              <Button variant="primary" onClick={markPaid}>
                Mark paid
              </Button>
            ) : null}
            {o.state !== "cancelled" && o.fulfillment_status !== "fulfilled" ? (
              <Button onClick={() => setDialog("fulfil")}>Fulfil</Button>
            ) : null}
            {paid - refunded > 0.005 ? <Button onClick={() => setDialog("refund")}>Refund</Button> : null}
            {o.state !== "cancelled" ? (
              <Button variant="danger" onClick={() => setDialog("cancel")}>
                Cancel
              </Button>
            ) : null}
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <h2 className="mb-3 font-medium">Items</h2>
            {items.length === 0 ? (
              <EmptyState title="No lines" hint="An order with no lines is usually a draft that was never completed." />
            ) : (
              <TableScroll>
                <Table>
                  <thead>
                    <tr>
                      <Th>Item</Th>
                      <Th>SKU</Th>
                      <Th className="text-right">Qty</Th>
                      <Th className="text-right">Unit</Th>
                      <Th className="text-right">Tax</Th>
                      <Th className="text-right">Line total</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((it) => (
                      <tr key={it.id} className="border-t border-white/5">
                        <Td className="max-w-[26ch] truncate font-medium">{it.title ?? "—"}</Td>
                        <Td className="font-mono text-xs text-white/50">{it.sku ?? "—"}</Td>
                        <Td className="text-right tabular-nums">{it.qty ?? 0}</Td>
                        <Td className="text-right tabular-nums">{fmtMoney(it.unit_price, o.currency)}</Td>
                        <Td className="text-right tabular-nums text-white/60">
                          {it.tax_rate != null ? `${it.tax_rate}%` : "—"}
                        </Td>
                        <Td className="text-right tabular-nums">{fmtMoney(it.line_total ?? null, o.currency)}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </TableScroll>
            )}
          </Card>

          <Card>
            <h2 className="mb-3 font-medium">Fulfillments</h2>
            {fuls.length === 0 ? (
              <p className="text-sm text-white/45">Nothing shipped yet.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {fuls.map((f) => (
                  <li key={f.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/10 px-3 py-2">
                    <span className="flex items-center gap-2">
                      <Badge tone={f.status === "success" ? "green" : f.status === "cancelled" ? "red" : "amber"}>{f.status}</Badge>
                      <span className="font-mono text-xs">{f.tracking_number ?? "no tracking"}</span>
                      <span className="text-white/40">{(f as { tracking_company?: string }).tracking_company ?? ""}</span>
                    </span>
                    <span className="text-white/40">{fmtDateTime(f.shipped_at)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <h2 className="mb-3 font-medium">Payment ledger</h2>
            {txs.length === 0 && rfs.length === 0 ? (
              <p className="text-sm text-white/45">No money has moved on this order.</p>
            ) : (
              <TableScroll>
                <Table>
                  <thead>
                    <tr>
                      <Th>Kind</Th>
                      <Th>Status</Th>
                      <Th>Gateway</Th>
                      <Th>When</Th>
                      <Th className="text-right">Amount</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {txs.map((t) => (
                      <tr key={t.id} className="border-t border-white/5">
                        <Td>{t.kind}</Td>
                        <Td><Badge tone={t.status === "success" ? "green" : "amber"}>{t.status}</Badge></Td>
                        <Td className="text-white/60">{t.gateway ?? "—"}</Td>
                        <Td className="whitespace-nowrap text-white/50">{fmtDateTime(t.processed_at)}</Td>
                        <Td className="text-right tabular-nums">{fmtMoney(t.amount, o.currency)}</Td>
                      </tr>
                    ))}
                    {rfs.map((r) => (
                      <tr key={r.id} className="border-t border-white/5">
                        <Td>refund</Td>
                        <Td><Badge tone={r.status === "success" ? "green" : "amber"}>{String(r.status ?? "")}</Badge></Td>
                        <Td className="text-white/60">{r.reason ?? "—"}</Td>
                        <Td className="whitespace-nowrap text-white/50">{fmtDateTime(r.processed_at)}</Td>
                        <Td className="text-right tabular-nums text-red-300">−{fmtMoney(r.amount, o.currency)}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </TableScroll>
            )}
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <h2 className="mb-3 font-medium">Totals</h2>
            <dl className="space-y-1.5 text-sm">
              <Line label="Subtotal" value={fmtMoney(o.subtotal, o.currency)} />
              <Line label="Discounts" value={fmtMoney(o.total_discounts, o.currency)} />
              <Line label="Shipping" value={fmtMoney(o.total_shipping, o.currency)} />
              <Line label="Tax" value={fmtMoney(o.total_tax, o.currency)} />
              <div className="my-2 border-t border-white/10" />
              <Line label="Total" value={fmtMoney(o.total, o.currency)} strong />
              <Line label="Paid" value={fmtMoney({ amount: paid, currency: o.currency ?? "USD" })} />
              {refunded > 0 ? <Line label="Refunded" value={`−${fmtMoney({ amount: refunded, currency: o.currency ?? "USD" })}`} /> : null}
              <Line
                label="Balance due"
                value={fmtMoney({ amount: due, currency: o.currency ?? "USD" })}
                strong
              />
            </dl>
          </Card>

          <Card>
            <h2 className="mb-3 font-medium">Customer</h2>
            <CustomerBlock order={o} />
          </Card>

          {o.state === "cancelled" ? (
            <Card>
              <h2 className="mb-2 font-medium">Cancelled</h2>
              <p className="text-sm text-white/60">
                {o.cancel_reason ?? "no reason recorded"} · {fmtDateTime(o.cancelled_at)}
              </p>
            </Card>
          ) : null}
        </div>
      </div>

      {dialog === "fulfil" ? (
        <FulfilDialog
          order={o}
          items={items}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            data.reload();
          }}
        />
      ) : null}
      {dialog === "refund" ? (
        <RefundDialog
          order={o}
          max={paid - refunded}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            data.reload();
          }}
        />
      ) : null}
      {dialog === "cancel" ? (
        <CancelDialog
          order={o}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            data.reload();
          }}
        />
      ) : null}
    </>
  );
}

function Line({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={cx("flex items-baseline justify-between gap-3", strong && "font-semibold")}>
      <dt className={cx(strong ? "text-white" : "text-white/50")}>{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}

function CustomerBlock({ order }: { order: Order }) {
  const c = order.customer as { first_name?: string; last_name?: string; email?: string; phone?: string } | string | null;
  const addr = order.shipping_address as Record<string, string> | string | null;
  return (
    <div className="space-y-2 text-sm">
      <p className="font-medium">
        {c && typeof c === "object" ? [c.first_name, c.last_name].filter(Boolean).join(" ") || c.email : "Guest"}
      </p>
      <p className="text-white/50">{(c && typeof c === "object" ? c.email : null) ?? order.email ?? "—"}</p>
      {addr && typeof addr === "object" ? (
        <address className="not-italic text-white/50">
          {[addr.line1, addr.line2, addr.city, addr.province, addr.postal_code, addr.country]
            .filter(Boolean)
            .join(", ")}
        </address>
      ) : null}
    </div>
  );
}

// ── Dialogs ─────────────────────────────────────────────────────────────────

function FulfilDialog({
  order,
  items,
  onClose,
  onDone,
}: {
  order: Order;
  items: OrderItem[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [qty, setQty] = useState<Record<string, number>>(() => Object.fromEntries(items.map((i) => [i.id, i.qty ?? 1])));
  const [tracking, setTracking] = useState("");
  const [carrier, setCarrier] = useState("UPS");
  const [locationId, setLocationId] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const locs = useAsync(() => locations.list({ limit: 100 }).then((r) => r.data), []);

  async function submit() {
    setBusy(true);
    setErr("");
    try {
      const { data: f } = await fulfillments.create({
        order: order.id,
        location: locationId || undefined,
        status: "success",
        tracking_number: tracking,
        tracking_company: carrier,
        shipped_at: Date.now(),
      });
      const lines = items.filter((i) => (qty[i.id] ?? 0) > 0);
      if (lines.length) {
        await fulfillmentItems.createMany(lines.map((i) => ({ fulfillment: f.id, order_item: i.id, qty: qty[i.id] as number })));
      }
      const full = items.every((i) => (qty[i.id] ?? 0) >= (i.qty ?? 0));
      await orders.update(order.id, { fulfillment_status: full ? "fulfilled" : "partial" });
      onDone();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Fulfil order"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy} onClick={submit}>
            {busy ? "Shipping…" : "Mark shipped"}
          </Button>
        </>
      }
    >
      {err ? <p className="mb-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">{err}</p> : null}
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2 [&>*]:min-w-0">
          <Field label="Carrier">
            <select className={inputCls} value={carrier} onChange={(e) => setCarrier(e.target.value)}>
              {["UPS", "FedEx", "DHL", "USPS", "Royal Mail", "Yurtiçi Kargo"].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </Field>
          <Field label="Tracking number" hint="Required once a fulfillment is marked successful.">
            <input className={inputCls} value={tracking} onChange={(e) => setTracking(e.target.value)} placeholder="1Z999AA1…" />
          </Field>
          <Field label="Ship from" className="sm:col-span-2">
            <select className={inputCls} value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              <option value="">Unspecified</option>
              {(locs.data ?? []).map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div>
          <p className="mb-1 text-xs font-medium text-white/60">What is in the box</p>
          <div className="space-y-1.5">
            {items.map((i) => (
              <div key={i.id} className="flex items-center justify-between gap-3 rounded-lg border border-white/10 px-3 py-1.5 text-sm">
                <span className="min-w-0 truncate">{i.title ?? i.sku ?? i.id.slice(0, 8)}</span>
                <input
                  className="w-16 rounded-md border border-white/15 bg-black/30 px-2 py-0.5 text-right text-sm tabular-nums"
                  type="number"
                  min="0"
                  max={i.qty ?? 1}
                  value={qty[i.id] ?? 0}
                  onChange={(e) => setQty((q) => ({ ...q, [i.id]: Number(e.target.value) }))}
                />
              </div>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}

function RefundDialog({ order, max, onClose, onDone }: { order: Order; max: number; onClose: () => void; onDone: () => void }) {
  const [amount, setAmount] = useState(String(max.toFixed(2)));
  const [reason, setReason] = useState("customer");
  const [restock, setRestock] = useState(true);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function submit() {
    setBusy(true);
    setErr("");
    try {
      const value = Number(amount);
      await refunds.create({
        order: order.id,
        amount: { amount: value, currency: order.currency ?? "USD" },
        currency: order.currency ?? "USD",
        status: "success",
        reason,
        restock,
        note: note || undefined,
        processed_at: Date.now(),
      });
      const full = value >= moneyAmount(order.total) - 0.005;
      await orders.update(order.id, { status: full ? "refunded" : "partially_refunded" });
      onDone();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Refund"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" disabled={busy || Number(amount) <= 0} onClick={submit}>
            {busy ? "Refunding…" : `Refund ${fmtMoney({ amount: Number(amount) || 0, currency: order.currency ?? "USD" })}`}
          </Button>
        </>
      }
    >
      {err ? <p className="mb-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">{err}</p> : null}
      <div className="grid gap-3 sm:grid-cols-2 [&>*]:min-w-0">
        <Field label="Amount" hint={`At most ${fmtMoney({ amount: max, currency: order.currency ?? "USD" })}`}>
          <input className={inputCls} type="number" step="0.01" min="0" max={max} value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label="Reason">
          <select className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)}>
            {["customer", "damaged", "wrong_item", "not_delivered", "other"].map((r) => (
              <option key={r} value={r}>
                {r.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Note" className="sm:col-span-2">
          <input className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What happened" />
        </Field>
        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <input type="checkbox" checked={restock} onChange={(e) => setRestock(e.target.checked)} />
          Put the items back into stock
        </label>
      </div>
    </Modal>
  );
}

function CancelDialog({ order, onClose, onDone }: { order: Order; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState("customer");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function submit() {
    setBusy(true);
    setErr("");
    try {
      // Cancellation lives on `state` and nowhere else. The reason column is
      // conditionally REQUIRED once state is cancelled, so both go in one write.
      await orders.update(order.id, { state: "cancelled", cancel_reason: reason, cancelled_at: Date.now() });
      onDone();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Cancel order"
      footer={
        <>
          <Button onClick={onClose}>Keep it</Button>
          <Button variant="danger" disabled={busy} onClick={submit}>
            {busy ? "Cancelling…" : "Cancel order"}
          </Button>
        </>
      }
    >
      {err ? <p className="mb-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">{err}</p> : null}
      <p className="mb-3 text-sm text-white/60">
        A cancelled order leaves every revenue figure — that is what the separate `state` axis is for.
      </p>
      <Field label="Why">
        <select className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)}>
          {["customer", "fraud", "inventory", "declined", "other"].map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </Field>
    </Modal>
  );
}
