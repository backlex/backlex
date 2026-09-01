/**
 * Price lists and the prices on them.
 *
 * A price is "what this variant costs, on this list, in this currency, at this
 * quantity" — a quantity break is the same row with a range rather than a
 * second mechanism. This screen is the one that proves the model can express
 * wholesale, a sale, and a bulk tier without three tables.
 */
import { useMemo, useState } from "react";
import type { PriceList, Variant } from "../lib/backlex";
import { backlex, channels, priceLists, prices, products, variants } from "../lib/backlex";
import { errText, useAsync, useToast } from "../lib/hooks";
import { fmtDate, fmtMoney } from "../lib/money";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNote,
  Field,
  Modal,
  PageHeader,
  Table,
  TableScroll,
  TableSkeleton,
  Td,
  Th,
  inputCls,
} from "@backlex-examples/shared";

const groups = backlex.from<{ id: string; name: string }>("customer_groups");

export function Pricing() {
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<PriceList | "new" | null>(null);
  const toast = useToast();

  const lists = useAsync(
    () => priceLists.list({ sort: ["-priority"], limit: 100, expand: ["customer_group", "channel"] }).then((r) => r.data),
    [],
  );

  const activeList = useMemo(
    () => (lists.data ?? []).find((l) => l.id === selected) ?? (lists.data ?? [])[0] ?? null,
    [lists.data, selected],
  );

  return (
    <>
      <PageHeader
        title="Pricing"
        subtitle="Highest priority wins where two lists both apply."
        actions={
          <Button variant="primary" onClick={() => setEditing("new")}>
            New price list
          </Button>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <h2 className="mb-3 font-medium">Price lists</h2>
          <ErrorNote error={lists.error ? errText(lists.error) : null} />
          {lists.data == null ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }, (_, i) => (
                <div key={i} className="h-14 animate-pulse rounded-control bg-raised" />
              ))}
            </div>
          ) : lists.data.length === 0 ? (
            <EmptyState title="No price lists" hint="A shop with one price per variant needs none — add one for wholesale or a sale." />
          ) : (
            <ul className="space-y-2">
              {lists.data.map((l) => {
                const on = activeList?.id === l.id;
                return (
                  <li key={l.id}>
                    <button
                      type="button"
                      onClick={() => setSelected(l.id)}
                      className={
                        "w-full rounded-control border px-3 py-2 text-left transition " +
                        (on ? "border-brand bg-brand/10" : "border-line hover:bg-raised")
                      }
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate font-medium">{l.name}</span>
                        <Badge tone={l.list_type === "sale" ? "red" : "blue"}>{l.list_type}</Badge>
                      </div>
                      <p className="mt-0.5 truncate text-xs text-ink-dim">
                        {relLabel(l.customer_group) ?? "everyone"} · {relLabel(l.channel) ?? "all channels"} · priority {l.priority ?? 0}
                      </p>
                      <p className="text-xs text-ink-dim">
                        {l.starts_at ? fmtDate(l.starts_at) : "—"} → {l.ends_at ? fmtDate(l.ends_at) : "open"}
                      </p>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <div className="lg:col-span-2">
          {activeList ? (
            <PricesPanel
              list={activeList}
              onEdit={() => setEditing(activeList)}
              onChanged={() => toast("Price saved.")}
            />
          ) : (
            <Card>
              <EmptyState title="Pick a price list" hint="Its prices show here." />
            </Card>
          )}
        </div>
      </div>

      {editing ? (
        <ListEditor
          list={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onDone={(msg) => {
            setEditing(null);
            toast(msg);
            lists.reload();
          }}
        />
      ) : null}
    </>
  );
}

function relLabel(v: unknown): string | null {
  if (!v) return null;
  if (typeof v === "string") return v.slice(0, 8);
  return (v as { name?: string }).name ?? null;
}

function PricesPanel({ list, onEdit, onChanged }: { list: PriceList; onEdit: () => void; onChanged: () => void }) {
  const [adding, setAdding] = useState(false);
  const toast = useToast();

  const rows = useAsync(
    () => prices.list({ filter: { price_list: { _eq: list.id } }, limit: 200, expand: ["variant"] }).then((r) => r.data),
    [list.id],
  );

  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-medium">
          {list.name} <span className="text-ink-dim">prices</span>
        </h2>
        <div className="ml-auto flex gap-2">
          <Button onClick={onEdit}>Edit list</Button>
          <Button variant="primary" onClick={() => setAdding(true)}>
            Add price
          </Button>
        </div>
      </div>
      <ErrorNote error={rows.error ? errText(rows.error) : null} />
      {rows.data == null ? (
        <TableSkeleton rows={5} cols={4} />
      ) : rows.data.length === 0 ? (
        <EmptyState title="No prices on this list" hint="Add one — a row with a quantity range from 10 is the price once ten are in the basket." />
      ) : (
        <TableScroll>
          <Table>
            <thead>
              <tr>
                <Th>Variant</Th>
                <Th>Quantity</Th>
                <Th className="text-right">Amount</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {rows.data.map((p) => {
                const v = p.variant as { title?: string; sku?: string } | string | null;
                return (
                  <tr key={p.id} className="border-t border-line">
                    <Td className="font-medium">{(v && typeof v === "object" && (v.title || v.sku)) || "—"}</Td>
                    <Td className="text-ink-muted">
                      {p.min_quantity || p.max_quantity
                        ? `${p.min_quantity ?? 1}–${p.max_quantity ?? "∞"}`
                        : "any"}
                    </Td>
                    <Td className="text-right tabular-nums">{fmtMoney(p.amount, p.currency)}</Td>
                    <Td className="text-right">
                      <Button
                        variant="ghost"
                        onClick={async () => {
                          try {
                            await prices.delete(p.id);
                            rows.reload();
                          } catch (e) {
                            toast(errText(e), "err");
                          }
                        }}
                      >
                        Delete
                      </Button>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </TableScroll>
      )}

      {adding ? (
        <AddPrice
          listId={list.id}
          onClose={() => setAdding(false)}
          onDone={() => {
            setAdding(false);
            rows.reload();
            onChanged();
          }}
        />
      ) : null}
    </Card>
  );
}

function AddPrice({ listId, onClose, onDone }: { listId: string; onClose: () => void; onDone: () => void }) {
  const [productId, setProductId] = useState("");
  const [variantId, setVariantId] = useState("");
  const [amount, setAmount] = useState("0");
  const [currency, setCurrency] = useState("USD");
  const [minQ, setMinQ] = useState("");
  const [maxQ, setMaxQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const prods = useAsync(() => products.list({ limit: 200, status: "all", sort: ["name"] }).then((r) => r.data), []);
  const vars = useAsync(
    () =>
      productId
        ? variants.list({ filter: { product: { _eq: productId } }, sort: ["position"], limit: 200 }).then((r) => r.data)
        : Promise.resolve([] as Variant[]),
    [productId],
  );

  async function submit() {
    setBusy(true);
    setErr("");
    try {
      await prices.create({
        variant: variantId,
        price_list: listId,
        amount: { amount: Number(amount), currency },
        currency,
        min_quantity: minQ === "" ? null : Number(minQ),
        max_quantity: maxQ === "" ? null : Number(maxQ),
      });
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
      title="Add price"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy || !variantId} onClick={submit}>
            {busy ? "Saving…" : "Add"}
          </Button>
        </>
      }
    >
      {err ? <p className="mb-3 rounded-control border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">{err}</p> : null}
      <div className="grid gap-3 sm:grid-cols-2 [&>*]:min-w-0">
        <Field label="Product" className="sm:col-span-2">
          <select
            className={inputCls}
            value={productId}
            onChange={(e) => {
              setProductId(e.target.value);
              setVariantId("");
            }}
          >
            <option value="">Pick a product…</option>
            {(prods.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Variant" className="sm:col-span-2">
          <select className={inputCls} value={variantId} disabled={!productId} onChange={(e) => setVariantId(e.target.value)}>
            <option value="">{productId ? "Pick a variant…" : "Pick a product first"}</option>
            {(vars.data ?? []).map((v) => (
              <option key={v.id} value={v.id}>
                {v.title ?? v.sku ?? v.id.slice(0, 8)} — {fmtMoney(v.price, v.currency)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Amount">
          <input className={inputCls} type="number" step="0.01" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label="Currency">
          <select className={inputCls} value={currency} onChange={(e) => setCurrency(e.target.value)}>
            {["USD", "EUR", "GBP", "TRY"].map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </Field>
        <Field label="From quantity" hint="Empty means the ordinary price.">
          <input className={inputCls} type="number" min="1" value={minQ} onChange={(e) => setMinQ(e.target.value)} />
        </Field>
        <Field label="To quantity" hint="Empty means no upper bound.">
          <input className={inputCls} type="number" min="1" value={maxQ} onChange={(e) => setMaxQ(e.target.value)} />
        </Field>
      </div>
      {vars.data && productId && vars.data.length === 0 ? (
        <p className="mt-3 text-sm text-warn">This product has no variants — a price is held against a variant, so generate one first.</p>
      ) : null}
    </Modal>
  );
}

function ListEditor({ list, onClose, onDone }: { list: PriceList | null; onClose: () => void; onDone: (msg: string) => void }) {
  const [f, setF] = useState(() => ({
    name: list?.name ?? "",
    code: list?.code ?? "",
    list_type: list?.list_type ?? "sale",
    status: list?.status ?? "draft",
    customer_group: list?.customer_group ?? "",
    channel: list?.channel ?? "",
    priority: String(list?.priority ?? 0),
    active: list?.active ?? true,
  }));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((p) => ({ ...p, [k]: v }));

  const grps = useAsync(() => groups.list({ limit: 100 }).then((r) => r.data), []);
  const chs = useAsync(() => channels.list({ limit: 100 }).then((r) => r.data), []);

  async function submit() {
    setBusy(true);
    setErr("");
    try {
      const patch = {
        name: f.name,
        code: f.code || null,
        list_type: f.list_type as PriceList["list_type"],
        status: f.status as PriceList["status"],
        customer_group: f.customer_group || null,
        channel: f.channel || null,
        priority: Number(f.priority),
        active: f.active,
      };
      if (list) {
        await priceLists.update(list.id, patch);
        onDone("Price list updated.");
      } else {
        await priceLists.create(patch);
        onDone("Price list created.");
      }
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
      title={list ? `Edit “${list.name}”` : "New price list"}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy || !f.name.trim()} onClick={submit}>
            {busy ? "Saving…" : list ? "Save" : "Create"}
          </Button>
        </>
      }
    >
      {err ? <p className="mb-3 rounded-control border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">{err}</p> : null}
      <div className="grid gap-3 sm:grid-cols-2 [&>*]:min-w-0">
        <Field label="Name" className="sm:col-span-2">
          <input className={inputCls} value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="Wholesale" />
        </Field>
        <Field label="Code">
          <input className={inputCls} value={f.code} onChange={(e) => set("code", e.target.value)} />
        </Field>
        <Field label="Kind" hint="A sale is struck through; an override is simply a different price.">
          <select className={inputCls} value={f.list_type} onChange={(e) => set("list_type", e.target.value as "sale")}>
            <option value="sale">Sale</option>
            <option value="override">Override</option>
          </select>
        </Field>
        <Field label="Customer group" hint="Blank means everyone.">
          <select className={inputCls} value={f.customer_group} onChange={(e) => set("customer_group", e.target.value)}>
            <option value="">Everyone</option>
            {(grps.data ?? []).map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Channel" hint="Blank means every channel.">
          <select className={inputCls} value={f.channel} onChange={(e) => set("channel", e.target.value)}>
            <option value="">All channels</option>
            {(chs.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Priority">
          <input className={inputCls} type="number" value={f.priority} onChange={(e) => set("priority", e.target.value)} />
        </Field>
        <Field label="Status">
          <select className={inputCls} value={f.status} onChange={(e) => set("status", e.target.value as "draft")}>
            {["draft", "active", "expired"].map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </Field>
        <label className="flex items-center gap-2 pb-1 text-sm sm:col-span-2">
          <input type="checkbox" checked={f.active} onChange={(e) => set("active", e.target.checked)} />
          Active
        </label>
      </div>
      {list ? (
        <p className="mt-3 text-xs text-ink-dim">
          Prices on this list are edited in the panel behind this dialog.
        </p>
      ) : null}
    </Modal>
  );
}
