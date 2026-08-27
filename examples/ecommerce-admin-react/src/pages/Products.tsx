/**
 * The catalog list: search, filter, sort, page — and the create dialog.
 *
 * `products` is a **versioned** collection in the template, so a newly created
 * row is a draft until it is published. The list therefore asks for
 * `status: "all"` and says which state each row is in, rather than quietly
 * showing a merchant a shorter catalog than they have.
 */
import { useState } from "react";
import type { ComparisonObj } from "backlex";
import type { Category, Product } from "../lib/backlex";
import { brands, categories, productTypes, products } from "../lib/backlex";
import { errText, useAsync, useToast } from "../lib/hooks";
import { fmtMoney, fmtNumber } from "../lib/money";
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
  cx,
  inputCls,
} from "../lib/ui";

const PAGE = 20;

export function Products({ go }: { go: (to: string) => void }) {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [sort, setSort] = useState("name");
  const [offset, setOffset] = useState(0);
  const [creating, setCreating] = useState(false);
  const toast = useToast();

  const cats = useAsync(() => categories.list({ sort: ["position"], limit: 200 }).then((r) => r.data), []);

  const list = useAsync(async () => {
    // Typed as the condition leaf map rather than `Record<string, unknown>`:
    // the looser record does not satisfy the `Condition` union.
    const filter: Record<string, ComparisonObj> = {};
    if (status) filter.status = { _eq: status };
    if (categoryId) filter.category = { _eq: categoryId };
    return products.list({
      // `status: "all"` is the versioned-collection escape hatch: without it a
      // draft product is invisible to the person who just created it.
      status: "all",
      q: q || undefined,
      filter: Object.keys(filter).length ? filter : undefined,
      sort: [sort],
      limit: PAGE,
      offset,
      meta: "filter_count",
      expand: ["category", "brand"],
    });
  }, [q, status, categoryId, sort, offset]);

  const total = list.data?.meta?.filter_count ?? 0;

  return (
    <>
      <PageHeader
        title="Products"
        subtitle={list.data ? `${fmtNumber(total)} in the catalog` : undefined}
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            New product
          </Button>
        }
      />

      <Card className="mb-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Search">
            <input
              className={inputCls}
              value={q}
              placeholder="Name, description, SKU…"
              onChange={(e) => {
                setOffset(0);
                setQ(e.target.value);
              }}
            />
          </Field>
          <Field label="Status">
            <select
              className={inputCls}
              value={status}
              onChange={(e) => {
                setOffset(0);
                setStatus(e.target.value);
              }}
            >
              <option value="">Any</option>
              <option value="active">Active</option>
              <option value="draft">Draft</option>
              <option value="archived">Archived</option>
            </select>
          </Field>
          <Field label="Category">
            <select
              className={inputCls}
              value={categoryId}
              onChange={(e) => {
                setOffset(0);
                setCategoryId(e.target.value);
              }}
            >
              <option value="">Any</option>
              {(cats.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Sort">
            <select className={inputCls} value={sort} onChange={(e) => setSort(e.target.value)}>
              <option value="name">Name A–Z</option>
              <option value="-name">Name Z–A</option>
              <option value="-price">Price high → low</option>
              <option value="price">Price low → high</option>
              <option value="-created_at">Newest</option>
              <option value="-rating">Best rated</option>
            </select>
          </Field>
        </div>
      </Card>

      <Card>
        <ErrorNote error={list.error ? errText(list.error) : null} />
        {list.data == null ? (
          <TableSkeleton rows={8} cols={6} />
        ) : list.data.data.length === 0 ? (
          <EmptyState
            title="Nothing matches"
            hint="Clear the filters, or add the first product to this catalog."
            action={
              <Button variant="primary" onClick={() => setCreating(true)}>
                New product
              </Button>
            }
          />
        ) : (
          <>
            <TableScroll>
              <Table>
                <thead>
                  <tr>
                    <Th>Product</Th>
                    <Th>Status</Th>
                    <Th>Category</Th>
                    <Th>SKU</Th>
                    <Th className="text-right">Price</Th>
                    <Th className="text-right">Stock</Th>
                    <Th className="text-right">Rating</Th>
                  </tr>
                </thead>
                <tbody>
                  {list.data.data.map((p) => (
                    <tr
                      key={p.id}
                      className="cursor-pointer border-t border-white/5 hover:bg-white/5"
                      onClick={() => go(`/products/${p.id}`)}
                    >
                      <Td className="max-w-[28ch] truncate font-medium">{p.name}</Td>
                      <Td>
                        <Badge tone={p.status === "active" ? "green" : p.status === "archived" ? "slate" : "gray"}>
                          {p.status ?? "—"}
                        </Badge>
                      </Td>
                      <Td className="text-white/60">{relName(p.category)}</Td>
                      <Td className="font-mono text-xs text-white/50">{p.sku ?? "—"}</Td>
                      <Td className="text-right tabular-nums">{fmtMoney(p.price, p.currency)}</Td>
                      <Td className="text-right tabular-nums">{fmtNumber(p.stock)}</Td>
                      <Td className="text-right tabular-nums text-white/60">
                        {p.rating != null ? `${p.rating.toFixed(1)} (${p.review_count ?? 0})` : "—"}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </TableScroll>

            <div className="mt-3 flex items-center justify-between text-sm text-white/50">
              <span>
                {offset + 1}–{Math.min(offset + PAGE, total || offset + list.data.data.length)} of {fmtNumber(total)}
              </span>
              <div className="flex gap-2">
                <Button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
                  Previous
                </Button>
                <Button disabled={!list.data.has_more} onClick={() => setOffset(offset + PAGE)}>
                  Next
                </Button>
              </div>
            </div>
          </>
        )}
      </Card>

      {creating ? (
        <NewProduct
          categories={cats.data ?? []}
          onClose={() => setCreating(false)}
          onCreated={(p) => {
            setCreating(false);
            toast(`“${p.name}” created as a draft.`);
            go(`/products/${p.id}`);
          }}
        />
      ) : null}
    </>
  );
}

export function relName(v: unknown): string {
  if (!v) return "—";
  if (typeof v === "string") return v.slice(0, 8);
  const o = v as { name?: string; title?: string; value?: string };
  return o.name ?? o.title ?? o.value ?? "—";
}

function NewProduct({
  categories: cats,
  onClose,
  onCreated,
}: {
  categories: Category[];
  onClose: () => void;
  onCreated: (p: Product) => void;
}) {
  const [name, setName] = useState("");
  const [price, setPrice] = useState("0");
  const [currency, setCurrency] = useState("USD");
  const [sku, setSku] = useState("");
  const [category, setCategory] = useState("");
  const [type, setType] = useState("");
  const [brand, setBrand] = useState("");
  const [publishNow, setPublishNow] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const types = useAsync(() => productTypes.list({ limit: 100 }).then((r) => r.data), []);
  const brandList = useAsync(() => brands.list({ limit: 100 }).then((r) => r.data), []);

  async function submit() {
    setBusy(true);
    setErr("");
    try {
      const { data } = await products.create({
        name,
        price: { amount: Number(price), currency },
        currency,
        sku: sku || undefined,
        category: category || undefined,
        product_type: type || undefined,
        brand: brand || undefined,
        status: "active",
      });
      // A versioned collection creates a DRAFT; publishing is a separate,
      // deliberate act, which is why it is a checkbox and not a side effect.
      if (publishNow) await products.publish(data.id);
      onCreated(data);
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
      title="New product"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy || !name.trim()} onClick={submit}>
            {busy ? "Creating…" : "Create"}
          </Button>
        </>
      }
    >
      {err ? <p className="mb-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">{err}</p> : null}
      <div className="grid gap-3 sm:grid-cols-2 [&>*]:min-w-0">
        <Field label="Name" className="sm:col-span-2">
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="Merino crew" />
        </Field>
        <Field label="Base price">
          <input className={inputCls} type="number" min="0" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} />
        </Field>
        <Field label="Currency">
          <select className={inputCls} value={currency} onChange={(e) => setCurrency(e.target.value)}>
            {["USD", "EUR", "GBP", "TRY"].map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </Field>
        <Field label="SKU" hint="Must be unique across the catalog.">
          <input className={inputCls} value={sku} onChange={(e) => setSku(e.target.value)} placeholder="CREW-001" />
        </Field>
        <Field label="Primary category">
          <select className={cx(inputCls)} value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">None</option>
            {cats.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Product type">
          <select className={inputCls} value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">None</option>
            {(types.data ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Brand">
          <select className={inputCls} value={brand} onChange={(e) => setBrand(e.target.value)}>
            <option value="">None</option>
            {(brandList.data ?? []).map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </Field>
        <label className="mt-1 flex items-center gap-2 text-sm sm:col-span-2">
          <input type="checkbox" checked={publishNow} onChange={(e) => setPublishNow(e.target.checked)} />
          Publish immediately — otherwise it stays a draft only staff can see.
        </label>
      </div>
    </Modal>
  );
}
