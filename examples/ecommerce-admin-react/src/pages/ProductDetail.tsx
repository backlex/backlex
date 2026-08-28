/**
 * One product, in the four shapes a merchant edits it in.
 *
 * The Variants tab is the interesting one and the reason the template's
 * `variant_option_values` table exists: a variant is not its title, it is the
 * set of option values it selects. "Generate variants" walks the cartesian
 * product of the option values and writes one variant plus one link row per
 * axis, which is the only way a storefront swatch grid can resolve a selection
 * back to a sellable unit.
 */
import { useMemo, useState } from "react";
import type { InventoryLevel, OptionValue, Product, ProductOption, Variant, VariantOptionValue } from "../lib/backlex";
import {
  brands,
  categories,
  channels,
  inventoryLevels,
  locations,
  optionValues,
  productOptions,
  productTypes,
  products,
  variantOptionValues,
  variants,
  backlex,
} from "../lib/backlex";
import { errText, useAsync, useToast } from "../lib/hooks";
import { fmtMoney, fmtNumber, moneyAmount } from "../lib/money";
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
  TableSkeleton,
  Td,
  Th,
  cx,
  inputCls,
} from "../lib/ui";

type Tab = "details" | "variants" | "inventory" | "channels";

/**
 * Read every row of a filtered set, 200 at a time.
 *
 * The API's page ceiling is 200 and a larger `limit` is **refused**, not
 * trimmed — so `limit: 500` is a 422 at runtime, not a slightly slow query.
 * These sets (an option's values, a product's variant links, a price list's
 * rows) are unbounded in principle, so they page.
 */
async function listAll<T extends { id: string }>(
  handle: { list: (q: Record<string, unknown>) => Promise<{ data: T[]; has_more?: boolean }> },
  query: Record<string, unknown>,
  cap = 2000,
): Promise<T[]> {
  const out: T[] = [];
  let offset = 0;
  for (;;) {
    const page = await handle.list({ ...query, limit: 200, offset });
    out.push(...page.data);
    if (!page.has_more || page.data.length === 0 || out.length >= cap) return out;
    offset += 200;
  }
}


export function ProductDetail({ id, go }: { id: string; go: (to: string) => void }) {
  const [tab, setTab] = useState<Tab>("details");
  const toast = useToast();

  const prod = useAsync(() => products.one(id).then((r) => r.data), [id]);

  if (prod.error) {
    return (
      <>
        <PageHeader title="Product" actions={<Button onClick={() => go("/products")}>Back</Button>} />
        <ErrorNote error={errText(prod.error)} />
      </>
    );
  }
  if (!prod.data) {
    return (
      <>
        <Skeleton className="h-8 w-64" />
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-56 w-full" />
          <Skeleton className="h-56 w-full" />
        </div>
      </>
    );
  }
  const p = prod.data;

  return (
    <>
      <PageHeader
        title={p.name}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={p.status === "active" ? "green" : p.status === "archived" ? "slate" : "gray"}>{p.status}</Badge>
            <span className="font-mono text-xs">{p.sku ?? "no SKU"}</span>
          </span>
        }
        actions={
          <>
            <Button onClick={() => go("/products")}>Back</Button>
            <Button
              onClick={async () => {
                try {
                  await products.publish(p.id);
                  toast("Published.");
                  prod.reload();
                } catch (e) {
                  toast(errText(e), "err");
                }
              }}
            >
              Publish
            </Button>
            <Button
              variant="danger"
              onClick={async () => {
                try {
                  await products.unpublish(p.id);
                  toast("Unpublished — back to a draft.");
                  prod.reload();
                } catch (e) {
                  toast(errText(e), "err");
                }
              }}
            >
              Unpublish
            </Button>
          </>
        }
      />

      <div className="mb-4 flex gap-1 overflow-x-auto border-b border-white/10">
        {(
          [
            ["details", "Details"],
            ["variants", "Options & variants"],
            ["inventory", "Inventory"],
            ["channels", "Channels"],
          ] as [Tab, string][]
        ).map(([k, label]) => (
          <button
            key={k}
            type="button"
            onClick={() => setTab(k)}
            className={cx(
              "whitespace-nowrap px-3 py-2 text-sm transition",
              tab === k ? "border-b-2 border-indigo-400 text-white" : "text-white/50 hover:text-white",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "details" ? <Details p={p} onSaved={prod.reload} /> : null}
      {tab === "variants" ? <VariantsTab productId={p.id} /> : null}
      {tab === "inventory" ? <InventoryTab productId={p.id} /> : null}
      {tab === "channels" ? <ChannelsTab productId={p.id} /> : null}
    </>
  );
}

// ── Details ─────────────────────────────────────────────────────────────────

function Details({ p, onSaved }: { p: Product; onSaved: () => void }) {
  const [form, setForm] = useState(() => ({
    name: p.name ?? "",
    description: String(p.description ?? ""),
    status: p.status ?? "active",
    price: String(moneyAmount(p.price)),
    compare_at_price: p.compare_at_price ? String(moneyAmount(p.compare_at_price)) : "",
    currency: p.currency ?? p.price?.currency ?? "USD",
    sku: p.sku ?? "",
    barcode: p.barcode ?? "",
    condition: p.condition ?? "new",
    featured: !!p.featured,
    category: p.category ?? "",
    brand: p.brand ?? "",
    product_type: p.product_type ?? "",
    min_purchase_qty: String(p.min_purchase_qty ?? 1),
    max_purchase_qty: p.max_purchase_qty == null ? "" : String(p.max_purchase_qty),
  }));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const toast = useToast();

  const cats = useAsync(() => categories.list({ limit: 200, sort: ["position"] }).then((r) => r.data), []);
  const brandList = useAsync(() => brands.list({ limit: 200 }).then((r) => r.data), []);
  const types = useAsync(() => productTypes.list({ limit: 200 }).then((r) => r.data), []);

  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  async function save() {
    setBusy(true);
    setErr("");
    try {
      await products.update(p.id, {
        name: form.name,
        description: form.description,
        status: form.status as Product["status"],
        price: { amount: Number(form.price), currency: form.currency },
        compare_at_price:
          form.compare_at_price === "" ? null : { amount: Number(form.compare_at_price), currency: form.currency },
        currency: form.currency,
        sku: form.sku || null,
        barcode: form.barcode || null,
        // No `stock`: the server totals it from this product's inventory levels
        // and refuses a write. Edit it on the Inventory tab, per location.
        condition: form.condition as Product["condition"],
        featured: form.featured,
        category: form.category || null,
        brand: form.brand || null,
        product_type: form.product_type || null,
        min_purchase_qty: Number(form.min_purchase_qty),
        max_purchase_qty: form.max_purchase_qty === "" ? null : Number(form.max_purchase_qty),
      });
      toast("Saved.");
      onSaved();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <ErrorNote error={err || null} />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 [&>*]:min-w-0">
        <Field label="Name" className="sm:col-span-2 lg:col-span-3">
          <input className={inputCls} value={form.name} onChange={(e) => set("name", e.target.value)} />
        </Field>
        <Field label="Description" className="sm:col-span-2 lg:col-span-3">
          <textarea className={cx(inputCls, "h-24 resize-y")} value={form.description} onChange={(e) => set("description", e.target.value)} />
        </Field>
        <Field label="Status">
          <select className={inputCls} value={form.status} onChange={(e) => set("status", e.target.value as Product["status"] & string)}>
            <option value="draft">Draft</option>
            <option value="active">Active</option>
            <option value="archived">Archived</option>
          </select>
        </Field>
        <Field label="Condition">
          <select className={inputCls} value={form.condition} onChange={(e) => set("condition", e.target.value as "new")}>
            <option value="new">New</option>
            <option value="refurbished">Refurbished</option>
            <option value="used">Used</option>
          </select>
        </Field>
        <Field label="Currency">
          <select className={inputCls} value={form.currency} onChange={(e) => set("currency", e.target.value)}>
            {["USD", "EUR", "GBP", "TRY"].map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </Field>
        <Field label="Base price">
          <input className={inputCls} type="number" step="0.01" min="0" value={form.price} onChange={(e) => set("price", e.target.value)} />
        </Field>
        <Field label="Compare-at price" hint="Struck through in the storefront when higher.">
          <input
            className={inputCls}
            type="number"
            step="0.01"
            min="0"
            value={form.compare_at_price}
            onChange={(e) => set("compare_at_price", e.target.value)}
          />
        </Field>
        <Field
          label="Total on hand"
          hint="Totalled from this product's inventory levels — edit it there, per location. On hand, not sellable: units already promised to an order are still counted."
        >
          <output className={`${inputCls} block tabular-nums text-neutral-500`}>{fmtNumber(p.stock)}</output>
        </Field>
        <Field label="SKU">
          <input className={inputCls} value={form.sku} onChange={(e) => set("sku", e.target.value)} />
        </Field>
        <Field label="Barcode">
          <input className={inputCls} value={form.barcode} onChange={(e) => set("barcode", e.target.value)} />
        </Field>
        <Field label="Primary category">
          <select className={inputCls} value={form.category} onChange={(e) => set("category", e.target.value)}>
            <option value="">None</option>
            {(cats.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Brand">
          <select className={inputCls} value={form.brand} onChange={(e) => set("brand", e.target.value)}>
            <option value="">None</option>
            {(brandList.data ?? []).map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Product type">
          <select className={inputCls} value={form.product_type} onChange={(e) => set("product_type", e.target.value)}>
            <option value="">None</option>
            {(types.data ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Minimum per order">
          <input className={inputCls} type="number" min="1" value={form.min_purchase_qty} onChange={(e) => set("min_purchase_qty", e.target.value)} />
        </Field>
        <Field label="Maximum per order" hint="Leave empty for no cap.">
          <input className={inputCls} type="number" min="1" value={form.max_purchase_qty} onChange={(e) => set("max_purchase_qty", e.target.value)} />
        </Field>
        <label className="flex items-end gap-2 pb-1 text-sm">
          <input type="checkbox" checked={form.featured} onChange={(e) => set("featured", e.target.checked)} />
          Featured
        </label>
      </div>
      <div className="mt-4 flex justify-end">
        <Button variant="primary" disabled={busy} onClick={save}>
          {busy ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </Card>
  );
}

// ── Options & variants ──────────────────────────────────────────────────────

function VariantsTab({ productId }: { productId: string }) {
  const toast = useToast();
  const [addingOption, setAddingOption] = useState(false);
  const [generating, setGenerating] = useState(false);

  const data = useAsync(async () => {
    const [opts, vars] = await Promise.all([
      productOptions.list({ filter: { product: { _eq: productId } }, sort: ["position"], limit: 50 }).then((r) => r.data),
      variants.list({ filter: { product: { _eq: productId } }, sort: ["position"], limit: 200 }).then((r) => r.data),
    ]);
    const optIds = opts.map((o) => o.id);
    const values = optIds.length
      ? await listAll<OptionValue>(optionValues, { filter: { option: { _in: optIds } }, sort: ["position"] })
      : [];
    const links = vars.length
      ? await listAll<VariantOptionValue>(variantOptionValues, { filter: { variant: { _in: vars.map((v) => v.id) } } })
      : [];
    return { opts, values, vars, links };
  }, [productId]);

  const valuesByOption = useMemo(() => {
    const m = new Map<string, OptionValue[]>();
    for (const v of data.data?.values ?? []) {
      const k = String(v.option ?? "");
      m.set(k, [...(m.get(k) ?? []), v]);
    }
    return m;
  }, [data.data]);

  /** The option values a variant selects, resolved through the link table. */
  const selectionFor = (variantId: string): string => {
    const byId = new Map((data.data?.values ?? []).map((v) => [v.id, v] as const));
    const optById = new Map((data.data?.opts ?? []).map((o) => [o.id, o] as const));
    const rows = (data.data?.links ?? []).filter((l) => l.variant === variantId);
    if (!rows.length) return "—";
    return rows
      .map((l) => `${optById.get(String(l.option))?.name ?? "?"}: ${byId.get(String(l.value))?.value ?? "?"}`)
      .join(" · ");
  };

  async function generate() {
    const opts = data.data?.opts ?? [];
    const axes = opts.map((o) => valuesByOption.get(o.id) ?? []).filter((a) => a.length > 0);
    if (axes.length === 0) {
      toast("Add at least one option value first.", "err");
      return;
    }
    setGenerating(true);
    try {
      // Cartesian product of the axes — one combination per sellable unit.
      let combos: OptionValue[][] = [[]];
      for (const axis of axes) combos = combos.flatMap((c) => axis.map((v) => [...c, v]));

      const existing = new Set(
        (data.data?.vars ?? []).map((v) =>
          (data.data?.links ?? [])
            .filter((l) => l.variant === v.id)
            .map((l) => String(l.value))
            .sort()
            .join("|"),
        ),
      );

      const wanted = combos.filter((c) => !existing.has(c.map((v) => v.id).sort().join("|")));
      if (!wanted.length) {
        toast("Every combination already has a variant.");
        return;
      }

      const base = data.data?.vars[0];
      const created = await variants.createMany(
        wanted.map((combo, i) => ({
          product: productId,
          title: combo.map((v) => v.value).join(" / "),
          price: { amount: moneyAmount(base?.price) || 0, currency: base?.currency ?? "USD" },
          currency: base?.currency ?? "USD",
          position: (data.data?.vars.length ?? 0) + i + 1,
          // No `inventory_quantity`: it is summed from the variant's inventory
          // levels, so the server owns it and a value here is refused.
        })),
      );

      // `createMany` answers with a per-row BATCH result, not a row array —
      // each entry carries `ok`, `id` and the created `data`.
      const newIds = created.data.results.map((r) => r.id ?? (r.data as Variant | undefined)?.id ?? "");
      const links = wanted.flatMap((combo, i) =>
        combo.map((val) => ({
          variant: newIds[i] as string,
          option: String(val.option),
          value: val.id,
        })),
      );
      if (links.length) await variantOptionValues.createMany(links);
      toast(`${wanted.length} variant(s) generated.`);
      data.reload();
    } catch (e) {
      toast(errText(e), "err");
    } finally {
      setGenerating(false);
    }
  }

  if (data.error) return <Card><ErrorNote error={errText(data.error)} /></Card>;
  if (!data.data) return <Card><TableSkeleton rows={5} cols={4} /></Card>;

  return (
    <div className="space-y-4">
      <Card>
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="font-medium">Options</h2>
          <Button onClick={() => setAddingOption(true)}>Add option</Button>
        </div>
        {data.data.opts.length === 0 ? (
          <EmptyState
            title="No options"
            hint="An option is an axis — Size, Colour. Its values are what a variant selects."
            action={<Button variant="primary" onClick={() => setAddingOption(true)}>Add option</Button>}
          />
        ) : (
          <div className="space-y-3">
            {data.data.opts.map((o) => (
              <OptionRow key={o.id} option={o} values={valuesByOption.get(o.id) ?? []} onChanged={data.reload} />
            ))}
          </div>
        )}
      </Card>

      <Card>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-medium">Variants</h2>
          <Button variant="primary" disabled={generating} onClick={generate}>
            {generating ? "Generating…" : "Generate missing variants"}
          </Button>
        </div>
        {data.data.vars.length === 0 ? (
          <EmptyState title="No variants" hint="Generate them from the options above, or a single-variant product needs none." />
        ) : (
          <TableScroll>
            <Table>
              <thead>
                <tr>
                  <Th>Title</Th>
                  <Th>Selection</Th>
                  <Th>SKU</Th>
                  <Th className="text-right">Price</Th>
                  <Th className="text-right">On hand</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {data.data.vars.map((v) => (
                  <tr key={v.id} className="border-t border-white/5">
                    <Td className="font-medium">
                      {v.title ?? "—"} {v.is_default ? <Badge tone="blue">default</Badge> : null}
                    </Td>
                    <Td className="text-white/60">{selectionFor(v.id)}</Td>
                    <Td className="font-mono text-xs text-white/50">{v.sku ?? "—"}</Td>
                    <Td className="text-right tabular-nums">{fmtMoney(v.price, v.currency)}</Td>
                    <Td className="text-right tabular-nums">{fmtNumber(v.inventory_quantity)}</Td>
                    <Td className="text-right">
                      <Button
                        variant="ghost"
                        onClick={async () => {
                          try {
                            await variants.delete(v.id);
                            toast("Variant deleted.");
                            data.reload();
                          } catch (e) {
                            toast(errText(e), "err");
                          }
                        }}
                      >
                        Delete
                      </Button>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </TableScroll>
        )}
      </Card>

      {addingOption ? (
        <AddOption
          productId={productId}
          position={(data.data.opts.length ?? 0) + 1}
          onClose={() => setAddingOption(false)}
          onDone={() => {
            setAddingOption(false);
            data.reload();
          }}
        />
      ) : null}
    </div>
  );
}

function OptionRow({ option, values, onChanged }: { option: ProductOption; values: OptionValue[]; onChanged: () => void }) {
  const [adding, setAdding] = useState("");
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  async function addValue() {
    const v = adding.trim();
    if (!v) return;
    setBusy(true);
    try {
      await optionValues.create({ option: option.id, value: v, position: values.length + 1 });
      setAdding("");
      onChanged();
    } catch (e) {
      toast(errText(e), "err");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-white/10 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="font-medium">{option.name}</span>
        <Button
          variant="ghost"
          onClick={async () => {
            try {
              await productOptions.delete(option.id);
              onChanged();
            } catch (e) {
              toast(errText(e), "err");
            }
          }}
        >
          Remove
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {values.map((v) => (
          <span key={v.id} className="inline-flex items-center gap-1 rounded-md bg-white/10 px-2 py-0.5 text-xs">
            {v.swatch ? <span className="size-2.5 rounded-full" style={{ background: v.swatch }} /> : null}
            {v.value}
            <button
              type="button"
              className="text-white/40 hover:text-red-300"
              onClick={async () => {
                try {
                  await optionValues.delete(v.id);
                  onChanged();
                } catch (e) {
                  toast(errText(e), "err");
                }
              }}
            >
              ×
            </button>
          </span>
        ))}
        <input
          className="w-28 rounded-md border border-white/15 bg-black/30 px-2 py-0.5 text-xs outline-none focus:border-indigo-400/60"
          placeholder="Add value"
          value={adding}
          disabled={busy}
          onChange={(e) => setAdding(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addValue()}
        />
      </div>
    </div>
  );
}

function AddOption({
  productId,
  position,
  onClose,
  onDone,
}: {
  productId: string;
  position: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const [name, setName] = useState("");
  const [values, setValues] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function submit() {
    setBusy(true);
    setErr("");
    try {
      const { data: opt } = await productOptions.create({ product: productId, name: name.trim(), position });
      const parts = values
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (parts.length) {
        await optionValues.createMany(parts.map((v, i) => ({ option: opt.id, value: v, position: i + 1 })));
      }
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
      title="Add option"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy || !name.trim()} onClick={submit}>
            {busy ? "Adding…" : "Add"}
          </Button>
        </>
      }
    >
      {err ? <p className="mb-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">{err}</p> : null}
      <div className="space-y-3">
        <Field label="Option name">
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="Size" />
        </Field>
        <Field label="Values" hint="Comma separated — S, M, L">
          <input className={inputCls} value={values} onChange={(e) => setValues(e.target.value)} placeholder="S, M, L" />
        </Field>
      </div>
    </Modal>
  );
}

// ── Inventory ───────────────────────────────────────────────────────────────

function InventoryTab({ productId }: { productId: string }) {
  const toast = useToast();
  const data = useAsync(async () => {
    const vars = await variants.list({ filter: { product: { _eq: productId } }, sort: ["position"], limit: 200 }).then((r) => r.data);
    const locs = await locations.list({ limit: 100 }).then((r) => r.data);
    const levels = vars.length
      ? await listAll<InventoryLevel>(inventoryLevels, { filter: { variant: { _in: vars.map((v) => v.id) } } })
      : [];
    return { vars, locs, levels };
  }, [productId]);

  if (data.error) return <Card><ErrorNote error={errText(data.error)} /></Card>;
  if (!data.data) return <Card><TableSkeleton rows={5} cols={5} /></Card>;
  const { vars, locs, levels } = data.data;

  if (!vars.length) {
    return (
      <Card>
        <EmptyState title="No variants to stock" hint="Inventory is held per variant per location — generate variants first." />
      </Card>
    );
  }

  return (
    <Card>
      <p className="mb-3 text-sm text-white/45">
        Available is generated as on hand minus committed — the server owns it, so it can never disagree with the two numbers above it.
      </p>
      <TableScroll>
        <Table>
          <thead>
            <tr>
              <Th>Variant</Th>
              <Th>Location</Th>
              <Th className="text-right">On hand</Th>
              <Th className="text-right">Committed</Th>
              <Th className="text-right">Available</Th>
              <Th className="text-right">Reorder at</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {vars.flatMap((v) =>
              locs.map((loc) => {
                const level = levels.find((l) => l.variant === v.id && l.location === loc.id);
                return (
                  <LevelRow
                    key={`${v.id}:${loc.id}`}
                    title={v.title ?? v.sku ?? v.id.slice(0, 8)}
                    locationName={loc.name}
                    level={level}
                    onSave={async (onHand) => {
                      try {
                        if (level) {
                          await inventoryLevels.update(level.id, { on_hand: onHand });
                        } else {
                          // `committed` is not passed: it is summed from the
                          // reservations held against the level, and the server
                          // refuses a write to it. `product` is, because that is
                          // what lets the product total its own stock.
                          await inventoryLevels.create({ product: productId, variant: v.id, location: loc.id, on_hand: onHand });
                        }
                        toast("Stock updated.");
                        data.reload();
                      } catch (e) {
                        toast(errText(e), "err");
                      }
                    }}
                  />
                );
              }),
            )}
          </tbody>
        </Table>
      </TableScroll>
    </Card>
  );
}

function LevelRow({
  title,
  locationName,
  level,
  onSave,
}: {
  title: string;
  locationName: string;
  level: { on_hand?: number; committed?: number; available?: number; reorder_point?: number } | undefined;
  onSave: (onHand: number) => Promise<void>;
}) {
  const [draft, setDraft] = useState(String(level?.on_hand ?? 0));
  const dirty = Number(draft) !== (level?.on_hand ?? 0);
  return (
    <tr className="border-t border-white/5">
      <Td className="font-medium">{title}</Td>
      <Td className="text-white/60">{locationName}</Td>
      <Td className="text-right">
        <input
          className="w-20 rounded-md border border-white/15 bg-black/30 px-2 py-1 text-right text-sm tabular-nums outline-none focus:border-indigo-400/60"
          type="number"
          min="0"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
      </Td>
      <Td className="text-right tabular-nums text-white/60">{level?.committed ?? 0}</Td>
      <Td className="text-right tabular-nums">
        <Badge tone={(level?.available ?? 0) <= 0 ? "red" : "green"}>{level?.available ?? 0}</Badge>
      </Td>
      <Td className="text-right tabular-nums text-white/50">{level?.reorder_point ?? 0}</Td>
      <Td className="text-right">
        <Button disabled={!dirty} onClick={() => onSave(Number(draft))}>
          Save
        </Button>
      </Td>
    </tr>
  );
}

// ── Channels ────────────────────────────────────────────────────────────────

function ChannelsTab({ productId }: { productId: string }) {
  const toast = useToast();
  const data = useAsync(async () => {
    const [chs, listings] = await Promise.all([
      channels.list({ limit: 100 }).then((r) => r.data),
      backlex
        .from<{ id: string; product?: string; channel?: string; is_published?: boolean; visible_in_listings?: boolean }>(
          "product_channel_listings",
        )
        .list({ filter: { product: { _eq: productId } }, limit: 100 })
        .then((r) => r.data),
    ]);
    return { chs, listings };
  }, [productId]);

  const listingsApi = backlex.from<{ id: string; product?: string; channel?: string; is_published?: boolean }>(
    "product_channel_listings",
  );

  if (data.error) return <Card><ErrorNote error={errText(data.error)} /></Card>;
  if (!data.data) return <Card><TableSkeleton rows={3} cols={3} /></Card>;

  return (
    <Card>
      <p className="mb-3 text-sm text-white/45">
        A product that is draft or archived is off everywhere. These rows only narrow one that is otherwise active.
      </p>
      <div className="space-y-2">
        {data.data.chs.map((c) => {
          const listing = data.data?.listings.find((l) => l.channel === c.id);
          const on = listing?.is_published ?? false;
          return (
            <div key={c.id} className="flex items-center justify-between gap-3 rounded-lg border border-white/10 px-3 py-2">
              <div className="min-w-0">
                <p className="truncate font-medium">{c.name}</p>
                <p className="text-xs text-white/40">{c.currency ?? "—"}</p>
              </div>
              <Button
                variant={on ? "danger" : "primary"}
                onClick={async () => {
                  try {
                    if (listing) await listingsApi.update(listing.id, { is_published: !on });
                    else await listingsApi.create({ product: productId, channel: c.id, is_published: true });
                    toast(on ? "Unlisted." : "Listed.");
                    data.reload();
                  } catch (e) {
                    toast(errText(e), "err");
                  }
                }}
              >
                {on ? "Unlist" : "List"}
              </Button>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
