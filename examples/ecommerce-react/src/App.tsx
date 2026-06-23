import { BacklexError } from "backlex";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  backlex,
  type OrderItem,
  orderItems,
  orders,
  persistToken,
  type Product,
  products,
} from "./backlex";
import { SetupCheck } from "./SetupCheck";

type User = { id: string; email: string; name?: string | null };

export function App() {
  // Gate the whole app behind a config check so a missing/wrong `.env` shows
  // actionable guidance instead of a blank screen.
  return (
    <SetupCheck>
      <AuthGate />
    </SetupCheck>
  );
}

function AuthGate() {
  const [user, setUser] = useState<User | null>(null);
  const [booting, setBooting] = useState(true);

  // Restore an existing session (token persisted in localStorage) on first load.
  useEffect(() => {
    backlex.auth
      .getSession()
      .then((s) => setUser(s.user ?? null))
      .catch(() => setUser(null))
      .finally(() => setBooting(false));
  }, []);

  if (booting) return <Centered>Loading…</Centered>;
  return user ? (
    <Store user={user} onSignOut={() => setUser(null)} />
  ) : (
    <AuthForm onAuthed={setUser} />
  );
}

// ── Auth ────────────────────────────────────────────────────────────────────
function AuthForm({ onAuthed }: { onAuthed: (u: User) => void }) {
  const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res =
        mode === "sign-up"
          ? await backlex.auth.signUp({ email, password, name })
          : await backlex.auth.signIn({ email, password });
      persistToken(); // stash the workspace session token
      onAuthed(res.user);
    } catch (err) {
      setError(err instanceof BacklexError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Centered>
      <form
        onSubmit={submit}
        className="w-full max-w-sm space-y-4 rounded-xl border border-neutral-200 bg-white p-6 shadow-sm"
      >
        <h1 className="text-lg font-semibold">
          {mode === "sign-up" ? "Create account" : "Sign in to the store"}
        </h1>
        {mode === "sign-up" && (
          <Field label="Name">
            <input
              className={inputCls}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ada Lovelace"
            />
          </Field>
        )}
        <Field label="Email">
          <input
            className={inputCls}
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
          />
        </Field>
        <Field label="Password">
          <input
            className={inputCls}
            type="password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
          />
        </Field>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button type="submit" disabled={busy} className={primaryBtnCls}>
          {busy ? "…" : mode === "sign-up" ? "Sign up" : "Sign in"}
        </button>
        <button
          type="button"
          className="w-full text-center text-sm text-neutral-500 hover:text-neutral-800"
          onClick={() => {
            setError(null);
            setMode(mode === "sign-up" ? "sign-in" : "sign-up");
          }}
        >
          {mode === "sign-up"
            ? "Already have an account? Sign in"
            : "Need an account? Sign up"}
        </button>
      </form>
    </Centered>
  );
}

// ── Store ─────────────────────────────────────────────────────────────────
// Sort modes map directly onto the query builder's `orderBy` argument.
type Sort = "newest" | "price-asc" | "price-desc";
type Stats = { count: number; avg: number };
// The cart is a plain `Map<productId, qty>` held in React state.
type Cart = Map<string, number>;

function Store({ user, onSignOut }: { user: User; onSignOut: () => void }) {
  const [items, setItems] = useState<Product[]>([]);
  const [category, setCategory] = useState<string | null>(null);
  const [sort, setSort] = useState<Sort>("newest");
  const [minPrice, setMinPrice] = useState(0); // dollars, in the input
  const [stats, setStats] = useState<Stats>({ count: 0, avg: 0 });
  const [cart, setCart] = useState<Cart>(new Map());
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The distinct category buttons are derived from whatever's loaded — no extra
  // round-trip needed for this small demo.
  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const p of items) if (p.category) set.add(p.category);
    return [...set].sort();
  }, [items]);

  // Aggregates: two single-function calls power the header. `count` counts every
  // readable product; `avg` over `price` is computed server-side (cents), so we
  // never pull the whole table down just to total it.
  const refreshStats = useCallback(async () => {
    try {
      const [countRes, avgRes] = await Promise.all([
        products.aggregate({ agg: "count" }),
        products.aggregate({ agg: "avg", field: "price" }),
      ]);
      const count = countRes.data[0]?.value ?? 0;
      const avg = avgRes.data[0]?.value ?? 0;
      setStats({ count, avg });
    } catch {
      // The collection may be empty on first run — non-fatal.
    }
  }, []);

  // List via the fluent query builder. `.where(...)` compiles the category +
  // min-price filters into the canonical JSON `Condition` the REST API speaks;
  // `.orderBy(...)` maps the sort toggle to `price` / `-price` / `-created_at`.
  const refresh = useCallback(async () => {
    try {
      const orderKey =
        sort === "price-asc" ? "price" : sort === "price-desc" ? "-price" : "-created_at";
      const minCents = Math.round(minPrice * 100);
      const res = await products
        .query()
        .where((f) => {
          // Build only the active sub-conditions, then AND them together.
          // `and()` of zero conds is a no-op match-all; of one, it's that cond.
          const conds = [
            ...(category ? [f.eq("category", category)] : []),
            ...(minCents > 0 ? [f.gte("price", minCents)] : []),
          ];
          return f.and(...conds);
        })
        .orderBy(orderKey)
        .limit(100)
        .withMeta("filter_count")
        .list();
      setItems(res.data);
      setError(null);
    } catch (err) {
      setError(err instanceof BacklexError ? err.message : String(err));
    }
  }, [category, sort, minPrice]);

  useEffect(() => {
    refresh();
    refreshStats();
  }, [refresh, refreshStats]);

  useEffect(() => {
    // Realtime: the SSE stream replays the same create/update/delete events the
    // server applies, so a freshly-added product shows up live (here and in a
    // second tab) without a manual reload.
    const off = backlex.subscribe<Product>("items:products", (e) => {
      setItems((cur) => {
        if (e.event === "deleted") return cur.filter((p) => p.id !== e.data.id);
        const rest = cur.filter((p) => p.id !== e.data.id);
        return [e.data, ...rest];
      });
      refreshStats();
    });
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

  const cartTotal = cartLines.reduce((sum, l) => sum + l.product.price * l.qty, 0);

  async function checkout() {
    if (cartLines.length === 0) return;
    setError(null);
    try {
      // 1. Create the order header. The total is summed from the cart in cents.
      const { data: order } = await orders.create({
        total: cartTotal,
        status: "paid",
      });
      // 2. Insert every line in a SINGLE batched write. `createMany` posts one
      //    `/batch` request with an op per row, so a 10-item cart is one round
      //    trip, not ten. We snapshot name + unit_price so later catalog edits
      //    don't rewrite this order's history.
      const rows: Partial<OrderItem>[] = cartLines.map((l) => ({
        order_id: order.id,
        product_id: l.product.id,
        name: l.product.name,
        unit_price: l.product.price,
        qty: l.qty,
      }));
      const res = await orderItems.createMany(rows);
      setCart(new Map());
      setConfirmation(
        `Order ${order.id.slice(0, 8)} placed — ${res.data.succeeded} item(s), ${formatPrice(
          order.total,
        )}.`,
      );
    } catch (err) {
      setError(err instanceof BacklexError ? err.message : String(err));
    }
  }

  async function signOut() {
    await backlex.auth.signOut().catch(() => {});
    persistToken();
    onSignOut();
  }

  return (
    <div className="mx-auto min-h-dvh max-w-5xl space-y-6 p-6 text-neutral-900">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Storefront</h1>
          <p className="text-sm text-neutral-500">
            {user.email} · {stats.count} products · avg {formatPrice(Math.round(stats.avg))}
          </p>
        </div>
        <button
          type="button"
          onClick={signOut}
          className="text-sm text-neutral-500 hover:text-neutral-800"
        >
          Sign out
        </button>
      </header>

      {/* Seller area — add a product (with a photo uploaded to backlex storage). */}
      <ProductComposer onCreated={refreshStats} onError={setError} />

      {/* Filter + sort controls feed the query builder above. */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex flex-wrap gap-1 rounded-lg bg-neutral-100 p-1">
          <CatButton active={category === null} onClick={() => setCategory(null)}>
            All
          </CatButton>
          {categories.map((c) => (
            <CatButton key={c} active={category === c} onClick={() => setCategory(c)}>
              {c}
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

      {error && <p className="text-sm text-red-600">{error}</p>}
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
            <ProductCard key={p.id} product={p} onAdd={() => addToCart(p.id)} />
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
  onCreated,
  onError,
}: {
  onCreated: () => void;
  onError: (m: string) => void;
}) {
  const [name, setName] = useState("");
  const [price, setPrice] = useState(""); // dollars in the input
  const [stock, setStock] = useState("");
  const [category, setCategory] = useState("");
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
      // 2. Create the product row, storing the object key (not the bytes) on the
      //    record. Price is converted dollars → integer cents.
      await products.create({
        name: n,
        price: Math.round(dollars * 100),
        stock: stock ? Math.max(0, Math.round(Number(stock))) : undefined,
        category: category.trim() || undefined,
        description: description.trim() || undefined,
        image_key: imageKey,
      });
      setName("");
      setPrice("");
      setStock("");
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
        <input
          className={inputCls}
          type="number"
          min={0}
          value={stock}
          onChange={(e) => setStock(e.target.value)}
          placeholder="Stock (optional)"
        />
        <input
          className={inputCls}
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          placeholder="Category (optional)"
        />
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
function ProductCard({ product, onAdd }: { product: Product; onAdd: () => void }) {
  const out = typeof product.stock === "number" && product.stock <= 0;
  return (
    <li className="flex flex-col overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm">
      <ProductImage imageKey={product.image_key} alt={product.name} />
      <div className="flex flex-1 flex-col gap-1 p-3">
        <div className="flex items-start justify-between gap-2">
          <h3 className="truncate text-sm font-medium">{product.name}</h3>
          <span className="shrink-0 text-sm font-semibold">{formatPrice(product.price)}</span>
        </div>
        {product.category && (
          <span className="w-fit rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-500">
            {product.category}
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

// ── Product image ──────────────────────────────────────────────────────────
// Resolves a storage object key to a viewable image. `storage.download(key)`
// returns a raw `Response` (works on every runtime); we turn the body into an
// object URL and revoke it on unmount so blobs don't leak. NOTE: with edge
// image transforms you'd instead point an <img> at a public/signed URL plus
// `?width=240&format=webp` — no blob fetch, server-side resize, browser-cached
// — but that needs a reachable URL; download()+objectURL is the portable path.
function ProductImage({ imageKey, alt }: { imageKey?: string; alt: string }) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    if (!imageKey) {
      setSrc(null);
      return;
    }
    let url: string | null = null;
    let cancelled = false;
    backlex.storage
      .download(imageKey)
      .then((res) => res.blob())
      .then((blob) => {
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setSrc(url);
      })
      .catch(() => {
        if (!cancelled) setSrc(null);
      });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [imageKey]);

  if (src) {
    return <img src={src} alt={alt} className="aspect-square w-full object-cover" />;
  }
  return (
    <div className="flex aspect-square w-full items-center justify-center bg-neutral-100 text-xs text-neutral-400">
      {imageKey ? "Loading…" : "No image"}
    </div>
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
                {formatPrice(product.price * qty)}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center justify-between border-t border-neutral-200 pt-3 text-sm font-medium">
        <span>Total</span>
        <span>{formatPrice(total)}</span>
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
/** Render an integer-cents amount as `$X.XX`. */
function formatPrice(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-neutral-50 p-6 text-neutral-900">
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-sm font-medium text-neutral-700">{label}</span>
      {children}
    </label>
  );
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
