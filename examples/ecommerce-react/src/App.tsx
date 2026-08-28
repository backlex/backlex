import { BacklexError } from "backlex";
import { useLiveQuery, useSession } from "backlex/react";
import { AuthForm, Centered, SetupCheck, type ExampleUser } from "@backlex-examples/shared";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  backlex,
  type Category,
  categories,
  type Money,
  type OrderItem,
  orderItems,
  orders,
  type Product,
  products,
} from "./backlex";

export function App() {
  // Gate the whole app behind a config check so a missing/wrong `.env` shows
  // actionable guidance instead of a blank screen.
  return (
    <SetupCheck client={backlex}>
      <AuthGate />
    </SetupCheck>
  );
}

function AuthGate() {
  // One hook replaces the `booting` flag, the session probe, the user state and
  // the sign-out plumbing this file used to hand-roll. It reads the session
  // from the client rather than from a copy, so a sign-in ANYWHERE — this
  // form, another component, a plain `backlex.auth` call — moves it.
  const { status, user } = useSession(backlex);

  if (status === "unknown") return <Centered>Loading…</Centered>;
  if (status === "anonymous") return <AuthForm client={backlex} />;
  return <Store user={user as ExampleUser} />;
}

// ── Store ─────────────────────────────────────────────────────────────────
/**
 * The one currency this storefront trades in.
 *
 * A money field carries its own currency per row, so anything that COMPARES or
 * AGGREGATES amounts has to name one — the server refuses to answer across
 * currencies rather than answer wrongly. A real multi-currency store would read
 * this from the customer's selection; naming it once here keeps the demo honest
 * about where the choice is being made.
 */
const STORE_CURRENCY = "USD";

// Sort modes map directly onto the query builder's `orderBy` argument.
type Sort = "newest" | "price-asc" | "price-desc";
type Stats = { count: number; avg: number };
// The cart is a plain `Map<productId, qty>` held in React state.
type Cart = Map<string, number>;

function Store({ user }: { user: ExampleUser }) {
  const { signOut } = useSession(backlex);
  const [cats, setCats] = useState<Category[]>([]);
  const [category, setCategory] = useState<string | null>(null); // a category id
  const [sort, setSort] = useState<Sort>("newest");
  const [minPrice, setMinPrice] = useState(0); // a plain amount, in the input
  const [stats, setStats] = useState<Stats>({ count: 0, avg: 0 });
  const [cart, setCart] = useState<Cart>(new Map());
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // `category` is a relation on the template's products (stores a category id),
  // so we load the `categories` collection once and resolve ids → names. The
  // map powers both the filter buttons and the per-card category label.
  const catName = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of cats) m.set(c.id, c.name);
    return m;
  }, [cats]);

  // Aggregates: two single-function calls power the header. `count` counts
  // every readable product; `avg` over `price` is computed server-side, so we
  // never pull the whole table down just to total it.
  //
  // The average is grouped BY CURRENCY, and not for tidiness: averaging a
  // money column whose currency varies per row is a question with no single
  // answer, so the server requires the grouping instead of returning a number
  // that means nothing. We read the row for this store's own currency.
  const refreshStats = useCallback(async () => {
    try {
      const [countRes, avgRes] = await Promise.all([
        products.aggregate({ agg: "count" }),
        products.aggregate({ agg: "avg", field: "price", groupBy: "currency" }),
      ]);
      const count = countRes.data[0]?.value ?? 0;
      const avgRow =
        avgRes.data.find((r) => String(r.label) === STORE_CURRENCY) ?? avgRes.data[0];
      setStats({ count, avg: avgRow?.value ?? 0 });
    } catch {
      // The collection may be empty on first run — non-fatal.
    }
  }, []);

  // The fluent query builder still composes the filters — `.where(...)` maps
  // the category + min-price controls onto the canonical JSON `Condition` the
  // REST API speaks — but it is handed to `useLiveQuery` rather than to
  // `list()`. `toQuery()` produces exactly the shape the hook takes.
  //
  // What that replaces is a manual `list()` plus a `subscribe()` whose reducer
  // put every changed row at the FRONT of the array, regardless of the sort the
  // user had picked. The hook keeps the result consistent with the query it was
  // given, which is the part that is genuinely hard to hand-roll.
  const query = useMemo(() => {
    const orderKey =
      sort === "price-asc" ? "price" : sort === "price-desc" ? "-price" : "-created_at";
    return products
      .query()
      .where((f) => {
        // Build only the active sub-conditions, then AND them together.
        // `and()` of zero conds is a no-op match-all; of one, it's that cond.
        // `category` filters by the related row's id.
        const conds = [
          ...(category ? [f.eq("category", category)] : []),
          // A money comparison must say WHICH currency. `price` holds a
          // per-row currency, and 10 EUR is not 10 USD — so the server
          // refuses a bare number rather than comparing minor units across
          // currencies and answering confidently wrong. This storefront is
          // single-currency, so it names its own.
          ...(minPrice > 0 ? [f.gte("price", { amount: minPrice, currency: STORE_CURRENCY })] : []),
        ];
        return f.and(...conds);
      })
      .orderBy(orderKey)
      .limit(100)
      .toQuery();
  }, [category, sort, minPrice]);

  const { data: items, error: listError } = useLiveQuery<Product>(backlex, "products", query);
  // The hook reports its own load/reconcile failures; show them in the same
  // place the app's own errors go rather than swallowing them.
  const shownError =
    error ?? (listError ? (listError instanceof Error ? listError.message : String(listError)) : null);

  // Load the category list once (template `categories` collection).
  const refreshCategories = useCallback(async () => {
    try {
      const res = await categories.query().orderBy("name").limit(100).list();
      setCats(res.data);
    } catch {
      // Collection absent (template not applied yet) — non-fatal.
    }
  }, []);

  useEffect(() => {
    refreshStats();
    refreshCategories();
  }, [refreshStats, refreshCategories]);

  // The product list needs no effect at all: `useLiveQuery` runs the initial
  // page and then keeps it in step over the realtime stream. Only the counters
  // beside it still refresh by hand.
  useEffect(() => {
    const off = backlex.subscribe<Product>("items:products", () => refreshStats());
    return off;
  }, [refreshStats]);

  // ── Cart actions ──────────────────────────────────────────────────────────
  function addToCart(id: string) {
    setCart((cur) => {
      const next = new Map(cur);
      next.set(id, (next.get(id) ?? 0) + 1);
      return next;
    });
    setConfirmation(null);
  }
  function setQty(id: string, qty: number) {
    setCart((cur) => {
      const next = new Map(cur);
      if (qty <= 0) next.delete(id);
      else next.set(id, qty);
      return next;
    });
  }

  // The cart lines, resolved against the loaded products (so we can show name +
  // price). A product can leave the catalog between add + checkout — filter
  // those out defensively (`noUncheckedIndexedAccess` makes the lookup `| undefined`).
  const cartLines = useMemo(() => {
    const lines: { product: Product; qty: number }[] = [];
    for (const [id, qty] of cart) {
      const product = items.find((p) => p.id === id);
      if (product) lines.push({ product, qty });
    }
    return lines;
  }, [cart, items]);

  const cartTotal = cartLines.reduce((sum, l) => sum + amountOf(l.product.price) * l.qty, 0);

  async function checkout() {
    if (cartLines.length === 0) return;
    setError(null);
    try {
      // 1. Create the order header. `status` is the template's payment state
      //    (financial_status); subtotal + total are summed from the cart in
      //    dollars. The template also tracks `fulfillment_status` separately —
      //    left at its `unfulfilled` default here.
      const { data: order } = await orders.create({
        subtotal: { amount: cartTotal, currency: STORE_CURRENCY },
        total: { amount: cartTotal, currency: STORE_CURRENCY },
        status: "paid",
        currency: STORE_CURRENCY,
      });
      // 2. Insert every line in a SINGLE batched write. `createMany` posts one
      //    `/batch` request with an op per row, so a 10-item cart is one round
      //    trip, not ten. We snapshot `title` + `sku` + `unit_price` so later
      //    catalog edits don't rewrite this order's history. `line_total` is a
      //    computed column — never sent. `order` / `product` carry relation ids.
      const rows: Partial<OrderItem>[] = cartLines.map((l) => ({
        order: order.id,
        product: l.product.id,
        title: l.product.name,
        sku: l.product.sku,
        // A line item has no currency column of its own — the parent order
        // carries it — so the template stores a bare amount here. Send the
        // number, not the money object.
        unit_price: amountOf(l.product.price),
        qty: l.qty,
      }));
      const res = await orderItems.createMany(rows);
      setCart(new Map());
      setConfirmation(
        `Order ${order.id.slice(0, 8)} placed — ${res.data.succeeded} item(s), ${formatMoney(order.total)}.`,
      );
    } catch (err) {
      setError(err instanceof BacklexError ? err.message : String(err));
    }
  }

  return (
    <div className="mx-auto min-h-dvh max-w-5xl space-y-6 p-6 text-neutral-900">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Storefront</h1>
          <p className="text-sm text-neutral-500">
            {user.email} · {stats.count} products · avg {formatAmount(stats.avg)}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void signOut()}
          className="text-sm text-neutral-500 hover:text-neutral-800"
        >
          Sign out
        </button>
      </header>

      {/* Seller area — add a product (with a photo uploaded to backlex storage). */}
      <ProductComposer cats={cats} onCreated={refreshStats} onError={setError} />

      {/* Filter + sort controls feed the query builder above. */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex flex-wrap gap-1 rounded-lg bg-neutral-100 p-1">
          <CatButton active={category === null} onClick={() => setCategory(null)}>
            All
          </CatButton>
          {cats.map((c) => (
            <CatButton key={c.id} active={category === c.id} onClick={() => setCategory(c.id)}>
              {c.name}
            </CatButton>
          ))}
        </div>

        <select
          className={inputCls + " w-auto"}
          value={sort}
          onChange={(e) => setSort(e.target.value as Sort)}
        >
          <option value="newest">Newest</option>
          <option value="price-asc">Price: low → high</option>
          <option value="price-desc">Price: high → low</option>
        </select>

        <label className="flex items-center gap-2 text-sm text-neutral-600">
          Min $
          <input
            className={inputCls + " w-24"}
            type="number"
            min={0}
            value={minPrice}
            onChange={(e) => setMinPrice(Math.max(0, Number(e.target.value) || 0))}
          />
        </label>
      </div>

      {shownError && <p className="text-sm text-red-600">{shownError}</p>}
      {confirmation && (
        <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {confirmation}
        </p>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_18rem]">
        {/* Product grid. */}
        <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          {items.length === 0 && (
            <li className="col-span-full rounded-xl border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-400">
              No products match — add one above or relax the filters.
            </li>
          )}
          {items.map((p) => (
            <ProductCard
              key={p.id}
              product={p}
              categoryName={p.category ? catName.get(p.category) : undefined}
              onAdd={() => addToCart(p.id)}
            />
          ))}
        </ul>

        {/* Cart sidebar. */}
        <CartPanel lines={cartLines} total={cartTotal} onSetQty={setQty} onCheckout={checkout} />
      </div>
    </div>
  );
}

// ── Product composer (seller) ─────────────────────────────────────────────
function ProductComposer({
  cats,
  onCreated,
  onError,
}: {
  cats: Category[];
  onCreated: () => void;
  onError: (m: string) => void;
}) {
  const [name, setName] = useState("");
  const [price, setPrice] = useState(""); // dollars in the input
  const [category, setCategory] = useState(""); // a category id (relation)
  const [description, setDescription] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  async function create(e: FormEvent) {
    e.preventDefault();
    const n = name.trim();
    const dollars = Number(price);
    if (!n || !Number.isFinite(dollars)) return;
    setBusy(true);
    try {
      // 1. If a photo was picked, upload it to backlex storage first. The key
      //    is namespaced under `products/` and made unique with
      //    `crypto.randomUUID()` (always available in the browser). `put` does
      //    a single PUT; for large files you'd reach for `uploadResumable`.
      let imageKey: string | undefined;
      if (file) {
        const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
        const key = `products/${crypto.randomUUID()}-${safe}`;
        await backlex.storage.put(key, file, file.type);
        imageKey = key;
      }
      // 2. Create the product row. Price is a decimal number of dollars
      //    (template `price`, validated `min: 0`); `featured_image` stores the
      //    storage object key (not the bytes); `category` is the related row id.
      const { data: created } = await products.create({
        name: n,
        status: "active",
        // Send the canonical `{ amount, currency }`. A bare number is accepted
        // too — the row's `currency` column would qualify it — but naming the
        // currency at the point the amount is typed is what keeps the two from
        // ever drifting apart.
        price: { amount: Math.max(0, Math.round(dollars * 100) / 100), currency: STORE_CURRENCY },
        // No `stock`: the template derives it from the product's inventory
        // levels, so the column refuses a write. A new product is out of stock
        // until a variant is stocked at a location.
        category: category || undefined,
        description: description.trim() || undefined,
        featured_image: imageKey,
      });
      // 3. The template's `products` is a versioned collection, so a new row
      //    starts as a draft. Publish it so it's live in the storefront (this is
      //    the SDK's draft → publish flow in one line).
      await products.publish(created.id);
      setName("");
      setPrice("");
      setCategory("");
      setDescription("");
      setFile(null);
      onCreated();
      // The new row also arrives over realtime, which updates the grid.
    } catch (err) {
      onError(err instanceof BacklexError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={create}
      className="space-y-3 rounded-xl border border-neutral-200 bg-white p-4 shadow-sm"
    >
      <h2 className="text-sm font-medium text-neutral-700">Add a product</h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <input
          className={inputCls}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Product name"
        />
        <input
          className={inputCls}
          type="number"
          min={0}
          step="0.01"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          placeholder="Price (USD)"
        />
        <select
          className={inputCls}
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        >
          <option value="">Category (optional)</option>
          {cats.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
      <textarea
        className={inputCls + " min-h-20"}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Description (optional)"
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <input
          type="file"
          accept="image/*"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="text-sm text-neutral-600 file:mr-3 file:rounded-lg file:border-0 file:bg-neutral-100 file:px-3 file:py-1.5 file:text-sm"
        />
        <button type="submit" disabled={busy} className={primaryBtnCls + " w-auto px-4"}>
          {busy ? "Saving…" : "Add product"}
        </button>
      </div>
    </form>
  );
}

// ── Product card ───────────────────────────────────────────────────────────
function ProductCard({
  product,
  categoryName,
  onAdd,
}: {
  product: Product;
  categoryName?: string;
  onAdd: () => void;
}) {
  // `stock` totals the product's inventory levels, kept by the server — so
  // this reads the real figure rather than a number somebody last typed.
  const out = typeof product.stock === "number" && product.stock <= 0;
  // Compare the AMOUNTS, and only within one currency — a "was" price in a
  // different currency is not a higher price, it is a different question.
  const onSale =
    !!product.compare_at_price &&
    product.compare_at_price.currency === product.price.currency &&
    product.compare_at_price.amount > product.price.amount;
  return (
    <li className="flex flex-col overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm">
      <ProductImage imageKey={product.featured_image} alt={product.name} />
      <div className="flex flex-1 flex-col gap-1 p-3">
        <div className="flex items-start justify-between gap-2">
          <h3 className="truncate text-sm font-medium">{product.name}</h3>
          <span className="flex shrink-0 items-baseline gap-1 text-sm font-semibold">
            {onSale && (
              <span className="text-xs font-normal text-neutral-400 line-through">
                {formatMoney(product.compare_at_price)}
              </span>
            )}
            {formatMoney(product.price)}
          </span>
        </div>
        {categoryName && (
          <span className="w-fit rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-500">
            {categoryName}
          </span>
        )}
        {product.description && (
          <p className="line-clamp-2 text-xs text-neutral-500">{product.description}</p>
        )}
        <button
          type="button"
          onClick={onAdd}
          disabled={out}
          className={primaryBtnCls + " mt-auto py-1.5 text-xs"}
        >
          {out ? "Out of stock" : "Add to cart"}
        </button>
      </div>
    </li>
  );
}

// ── Product image ───────────────────────────────────────────────────────────
// One line, and the browser does the rest.
//
// `storage.url()` composes the URL an object is served at — it issues no
// request, so the result goes straight into `src` and the browser fetches it
// the way it fetches any image: cached, lazily, and resized server-side by the
// transform params. The alternative, which this example used to carry, is to
// download the bytes, wrap them in a blob, hand out an object URL and revoke
// it on unmount — forty lines that give up the cache, the lazy loading, and
// the transform, and leak a blob if the cleanup is ever missed.
function ProductImage({ imageKey, alt }: { imageKey?: string; alt: string }) {
  if (!imageKey) {
    return (
      <div className="flex aspect-square w-full items-center justify-center bg-neutral-100 text-xs text-neutral-400">
        No image
      </div>
    );
  }
  return (
    <img
      src={backlex.storage.url(imageKey, { width: 480, format: "webp" })}
      alt={alt}
      loading="lazy"
      className="aspect-square w-full object-cover"
    />
  );
}

// ── Cart panel ─────────────────────────────────────────────────────────────
function CartPanel({
  lines,
  total,
  onSetQty,
  onCheckout,
}: {
  lines: { product: Product; qty: number }[];
  total: number;
  onSetQty: (id: string, qty: number) => void;
  onCheckout: () => void;
}) {
  return (
    <aside className="h-fit space-y-3 rounded-xl border border-neutral-200 bg-white p-4 shadow-sm">
      <h2 className="text-sm font-medium text-neutral-700">Cart</h2>
      {lines.length === 0 ? (
        <p className="text-sm text-neutral-400">Empty — add a product.</p>
      ) : (
        <ul className="space-y-2">
          {lines.map(({ product, qty }) => (
            <li key={product.id} className="flex items-center justify-between gap-2 text-sm">
              <span className="min-w-0 flex-1 truncate">{product.name}</span>
              <input
                className="w-14 rounded border border-neutral-300 px-1 py-0.5 text-right text-xs"
                type="number"
                min={0}
                value={qty}
                onChange={(e) => onSetQty(product.id, Number(e.target.value) || 0)}
              />
              <span className="w-16 text-right text-neutral-500">
                {formatAmount(product.price.amount * qty, product.price.currency)}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center justify-between border-t border-neutral-200 pt-3 text-sm font-medium">
        <span>Total</span>
        <span>{formatAmount(total)}</span>
      </div>
      <button
        type="button"
        onClick={onCheckout}
        disabled={lines.length === 0}
        className={primaryBtnCls}
      >
        Checkout
      </button>
    </aside>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────
/** The numeric part of a money field, for arithmetic. Missing reads as 0. */
function amountOf(money: Money | null | undefined): number {
  return money?.amount ?? 0;
}

/**
 * Render a money field.
 *
 * The pair goes to `Intl.NumberFormat` rather than having a `$` glued to a
 * number: the field carries its own currency, and half the world writes the
 * symbol after the amount anyway. Passing `amount` alone would mean deciding
 * the currency here — which is the thing a money field exists to stop.
 */
function formatMoney(money: Money | null | undefined, fallbackCurrency = STORE_CURRENCY): string {
  const { amount, currency } = money ?? { amount: 0, currency: fallbackCurrency };
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amount);
  } catch {
    // `Intl` throws a RangeError on a currency code it does not recognise, and
    // the code comes from the row rather than from this file. Rendering the
    // amount beside the raw code is worse than the ideal output and far better
    // than the alternative, which is that one bad row takes down the page.
    return `${amount} ${currency}`;
  }
}

/** Format a computed total (cart maths) in a known currency. */
function formatAmount(amount: number, currency = STORE_CURRENCY): string {
  return formatMoney({ amount, currency });
}

function CatButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "rounded-md px-3 py-1 text-sm capitalize " +
        (active ? "bg-white shadow-sm" : "text-neutral-500 hover:text-neutral-800")
      }
    >
      {children}
    </button>
  );
}

const inputCls =
  "w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-900";
const primaryBtnCls =
  "w-full rounded-lg bg-neutral-900 px-3 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50";
