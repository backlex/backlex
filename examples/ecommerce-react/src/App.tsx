import { BacklexError } from "backlex";
import { useLiveQuery, useSession } from "backlex/react";
import { AuthForm, Centered, SetupCheck, type ExampleUser } from "@backlex-examples/shared";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  backlex,
  type Category,
  categories,
  type Money,
  type ModifierRule,
  modifierRules,
  type ModifierSet,
  modifierSets,
  type ModifierValue,
  modifierValues,
  type OrderItem,
  type OrderItemOption,
  orderItemOptions,
  orderItems,
  orders,
  type Product,
  type ProductModifier,
  productModifiers,
  products,
} from "./backlex";
import {
  defaultSelection,
  resolve,
  type Resolved,
  type Rule,
  type Selection,
  type Slot,
} from "./configurator";

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

/**
 * One basket line.
 *
 * The cart is keyed by line, NOT by product, and that is forced by the model
 * rather than a preference: two different configurations of the same machine
 * are two different things to build, two different prices and two different
 * pick lists. Keying by product id would silently merge them and charge one
 * price for both.
 *
 * `unitPrice` and `optionsTotal` stay apart all the way to `order_items`,
 * because a line that folded them together can no longer say what the upgrades
 * cost — which is the first question anybody asks about a configured order.
 */
type CartLine = {
  key: string;
  productId: string;
  qty: number;
  unitPrice: number;
  optionsTotal: number;
  configCode: string;
  /** Slot id → chosen `modifier_values` ids. Written out as option rows at
   *  checkout, with the labels and amounts snapshotted. */
  selection: Selection;
  /** Snapshot of what each choice added, for the cart summary and the rows. */
  chosen: { slotId: string; choiceId: string; label: string; amount: number }[];
};
type Cart = Map<string, CartLine>;

/** The configurator's data for one product, loaded on demand. */
type Config = { slots: Slot[]; rules: Rule[] };

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
  // Which products have configurable slots at all — one query, so a card can
  // say "Configure" instead of "Add" without loading every product's options.
  const [configurable, setConfigurable] = useState<Set<string>>(new Set());
  const [configuring, setConfiguring] = useState<Product | null>(null);

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

  // Which products carry slots. `product_modifiers` is small (a handful of rows
  // per configurable product), so one unfiltered read is cheaper than asking
  // per card — and it is only used to pick the button's label.
  useEffect(() => {
    let live = true;
    productModifiers
      .list({ limit: 200, fields: ["product"] })
      .then((r) => {
        if (live) setConfigurable(new Set(r.data.map((m) => m.product)));
      })
      .catch(() => {
        // A workspace seeded before the configurator shipped has no such
        // collection. That is not an error worth a banner — every product just
        // stays a plain "Add".
      });
    return () => {
      live = false;
    };
  }, []);

  // ── Cart actions ──────────────────────────────────────────────────────────
  /** Add an unconfigured product — one line, no options. */
  function addToCart(product: Product) {
    setCart((cur) => {
      const next = new Map(cur);
      const existing = next.get(product.id);
      next.set(product.id, {
        key: product.id,
        productId: product.id,
        qty: (existing?.qty ?? 0) + 1,
        unitPrice: amountOf(product.price),
        optionsTotal: 0,
        configCode: "",
        selection: {},
        chosen: [],
      });
      return next;
    });
    setConfirmation(null);
  }

  /** Add a configured build. Two builds of one machine are two lines, so the
   *  key carries the configuration and not just the product. */
  function addConfigured(product: Product, selection: Selection, r: Resolved) {
    const key = `${product.id}|${r.code}`;
    setCart((cur) => {
      const next = new Map(cur);
      const existing = next.get(key);
      next.set(key, {
        key,
        productId: product.id,
        qty: (existing?.qty ?? 0) + 1,
        unitPrice: amountOf(product.price),
        optionsTotal: r.optionsTotal,
        configCode: r.code,
        selection,
        chosen: r.adjustments.map((a) => ({
          slotId: a.slotId,
          choiceId: a.choiceId,
          label: a.label,
          amount: a.amount,
        })),
      });
      return next;
    });
    setConfiguring(null);
    setConfirmation(null);
  }

  function setQty(key: string, qty: number) {
    setCart((cur) => {
      const next = new Map(cur);
      const line = next.get(key);
      if (!line) return cur;
      if (qty <= 0) next.delete(key);
      else next.set(key, { ...line, qty });
      return next;
    });
  }

  // The cart lines, resolved against the loaded products (so we can show name +
  // price). A product can leave the catalog between add + checkout — filter
  // those out defensively (`noUncheckedIndexedAccess` makes the lookup `| undefined`).
  const cartLines = useMemo(() => {
    const lines: { product: Product; line: CartLine }[] = [];
    for (const line of cart.values()) {
      const product = items.find((p) => p.id === line.productId);
      if (product) lines.push({ product, line });
    }
    return lines;
  }, [cart, items]);

  const cartTotal = cartLines.reduce(
    (sum, l) => sum + (l.line.unitPrice + l.line.optionsTotal) * l.line.qty,
    0,
  );

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
      //
      //    `unit_price` is a money field with a sibling `currency` column, so a
      //    plain number is accepted on WRITE and qualified by `currency`. The
      //    base and the configured half stay in separate columns; the database
      //    folds them into `line_total`.
      const rows: Partial<OrderItem>[] = cartLines.map(({ product, line }) => ({
        order: order.id,
        product: product.id,
        title: line.configCode ? `${product.name} — ${line.configCode}` : product.name,
        sku: product.sku,
        unit_price: line.unitPrice as unknown as Money,
        options_total: line.optionsTotal as unknown as Money,
        config_code: line.configCode || undefined,
        qty: line.qty,
        currency: STORE_CURRENCY,
      }));
      const res = await orderItems.createMany(rows);

      // 3. The configuration itself, one row per chosen slot, with the label
      //    and the amount SNAPSHOTTED. `config_code` on the line is a summary;
      //    this is the record a picker builds from and a refund is argued over.
      //
      //    Each batch result carries the `index` of the row that produced it,
      //    so a line's options attach by index rather than by re-querying —
      //    which would have to guess which of two identically-priced lines of
      //    the same product it had found. A row that FAILED still occupies its
      //    index with `ok: false` and no id, and its options are dropped with
      //    it rather than being orphaned onto the wrong line.
      const idByIndex = new Map<number, string>();
      for (const r of res.data.results) {
        if (r.ok && r.id) idByIndex.set(r.index, r.id);
      }
      const optionRows: Partial<OrderItemOption>[] = [];
      cartLines.forEach(({ line }, i) => {
        const lineId = idByIndex.get(i);
        if (!lineId) return;
        line.chosen.forEach((c, position) => {
          optionRows.push({
            line: lineId,
            modifier: c.slotId,
            value: c.choiceId,
            label: c.label,
            qty: 1,
            price_adjustment: c.amount as unknown as Money,
            currency: STORE_CURRENCY,
            position: position + 1,
          });
        });
      });
      if (optionRows.length > 0) await orderItemOptions.createMany(optionRows);

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
              configurable={configurable.has(p.id)}
              onAdd={() => (configurable.has(p.id) ? setConfiguring(p) : addToCart(p))}
            />
          ))}
        </ul>

        {/* Cart sidebar. */}
        <CartPanel lines={cartLines} total={cartTotal} onSetQty={setQty} onCheckout={checkout} />
      </div>

      {configuring && (
        <ConfiguratorDialog
          product={configuring}
          onClose={() => setConfiguring(null)}
          onAdd={addConfigured}
          onError={setError}
        />
      )}
    </div>
  );
}

// ── Configurator ────────────────────────────────────────────────────────────
/**
 * The screen a configure-to-order product is bought through.
 *
 * All it does is render what `resolve()` answers: which choices are blocked,
 * which slots are hidden, what is still missing, and what the build costs. The
 * rules are never spelled out here as conditions — they live in
 * `modifier_rules` as data, so the admin, a second storefront and a
 * server-side check all read the same ones. A rule written into a form is a
 * rule the next channel silently does not have.
 */
function ConfiguratorDialog({
  product,
  onClose,
  onAdd,
  onError,
}: {
  product: Product;
  onClose: () => void;
  onAdd: (product: Product, selection: Selection, resolved: Resolved) => void;
  onError: (message: string) => void;
}) {
  const [config, setConfig] = useState<Config | null>(null);
  const [selection, setSelection] = useState<Selection>({});

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        // Four reads, not one per slot: the slots for this product, then the
        // sets and choices they name. A configurator that fetched per slot
        // would issue a request per drive bay.
        const slotRows = await productModifiers.list({
          filter: { product: { _eq: product.id } },
          sort: "position",
          limit: 100,
        });
        const setIds = [...new Set(slotRows.data.map((s) => s.modifier_set))];
        if (setIds.length === 0) {
          if (live) setConfig({ slots: [], rules: [] });
          return;
        }
        const [setRows, valueRows, ruleRows] = await Promise.all([
          modifierSets.list({ filter: { id: { _in: setIds } }, limit: 100 }),
          modifierValues.list({
            filter: { modifier_set: { _in: setIds }, active: { _eq: true } },
            sort: "position",
            limit: 200,
          }),
          modifierRules.list({
            filter: { when_modifier: { _in: slotRows.data.map((s) => s.id) } },
            limit: 200,
          }),
        ]);

        const setById = new Map<string, ModifierSet>(setRows.data.map((s) => [s.id, s]));
        const choicesBySet = new Map<string, ModifierValue[]>();
        for (const v of valueRows.data) {
          const list = choicesBySet.get(v.modifier_set) ?? [];
          list.push(v);
          choicesBySet.set(v.modifier_set, list);
        }

        const slots: Slot[] = slotRows.data.map((s: ProductModifier) => {
          const set = setById.get(s.modifier_set);
          return {
            id: s.id,
            // The slot's own label wins — that is what makes four bays over one
            // set readable as "Drive bay 1…4" rather than "M.2 SSD" four times.
            label: s.label || set?.name || "Option",
            is_required: s.is_required === true,
            maxSelect: set?.max_select ?? 1,
            setCode: set?.code ?? null,
            position: s.position ?? null,
            choices: (choicesBySet.get(s.modifier_set) ?? []).map((v) => ({
              id: v.id,
              label: v.label,
              code: v.code ?? null,
              adjustment_type: v.adjustment_type ?? "fixed_amount",
              price_adjustment: v.price_adjustment ?? null,
              adjustment_percent: v.adjustment_percent ?? null,
              is_default: v.is_default ?? false,
              active: v.active ?? true,
              position: v.position ?? null,
            })),
          };
        });
        const rules: Rule[] = ruleRows.data.map((r: ModifierRule) => ({
          id: r.id,
          rule_type: r.rule_type,
          when_modifier: r.when_modifier,
          when_value: r.when_value ?? null,
          then_modifier: r.then_modifier ?? null,
          then_value: r.then_value ?? null,
          message: r.message ?? null,
          active: r.active ?? true,
        }));

        if (!live) return;
        setConfig({ slots, rules });
        setSelection(defaultSelection(slots));
      } catch (err) {
        if (live) onError(err instanceof BacklexError ? err.message : String(err));
      }
    })();
    return () => {
      live = false;
    };
  }, [product.id, onError]);

  const base = amountOf(product.price);
  const resolved = useMemo(
    () => (config ? resolve(config.slots, config.rules, selection, base) : null),
    [config, selection, base],
  );

  function pick(slot: Slot, choiceId: string) {
    setSelection((cur) => {
      const on = cur[slot.id] ?? [];
      if (slot.maxSelect <= 1) {
        // Single-choice: clicking the current pick clears it, so a slot that is
        // not required can be un-answered without a "none" option nobody added.
        return { ...cur, [slot.id]: on[0] === choiceId ? [] : [choiceId] };
      }
      const next = on.includes(choiceId) ? on.filter((c) => c !== choiceId) : [...on, choiceId];
      return { ...cur, [slot.id]: next };
    });
  }

  return (
    // A plain fixed overlay — the example deliberately has no component kit, so
    // what is worth copying here is the data flow, not the dialog.
    <div className="fixed inset-0 z-10 flex items-end justify-center bg-neutral-900/40 p-0 sm:items-center sm:p-6">
      <div className="flex max-h-[90dvh] w-full max-w-lg flex-col overflow-hidden rounded-t-xl bg-white shadow-xl sm:rounded-xl">
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-neutral-200 p-4">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold">{product.name}</h2>
            <p className="text-xs text-neutral-500">
              {formatMoney(product.price)} base · configure below
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-lg border border-neutral-300 px-2 py-1 text-xs"
          >
            Close
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          {!config && <p className="text-sm text-neutral-400">Loading options…</p>}
          {config?.slots.length === 0 && (
            <p className="text-sm text-neutral-400">This product has no configurable options.</p>
          )}
          {config?.slots.map((slot) => {
            if (resolved?.hidden.has(slot.id)) return null;
            const on = selection[slot.id] ?? [];
            return (
              <fieldset key={slot.id} className="space-y-2">
                <legend className="text-xs font-medium text-neutral-700">
                  {slot.label}
                  {(slot.is_required || resolved?.required.has(slot.id)) && (
                    <span className="ml-1 text-red-500">*</span>
                  )}
                  {slot.maxSelect > 1 && (
                    <span className="ml-1 font-normal text-neutral-400">
                      (up to {slot.maxSelect})
                    </span>
                  )}
                </legend>
                <div className="flex flex-wrap gap-2">
                  {slot.choices.map((choice) => {
                    const blocked = resolved?.blocked.has(choice.id) ?? false;
                    const picked = on.includes(choice.id);
                    const delta =
                      choice.adjustment_type === "percent"
                        ? (base * (choice.adjustment_percent ?? 0)) / 100
                        : (choice.price_adjustment?.amount ?? 0);
                    return (
                      <button
                        key={choice.id}
                        type="button"
                        // A blocked choice stays VISIBLE and disabled rather
                        // than disappearing: a shopper who cannot see the
                        // option they wanted cannot work out what to change.
                        disabled={blocked}
                        onClick={() => pick(slot, choice.id)}
                        title={blocked ? "Not available with the rest of this build" : undefined}
                        className={`rounded-lg border px-3 py-1.5 text-xs ${
                          blocked
                            ? "cursor-not-allowed border-neutral-200 text-neutral-300 line-through"
                            : picked
                              ? "border-neutral-900 bg-neutral-900 text-white"
                              : "border-neutral-300 text-neutral-700 hover:border-neutral-400"
                        }`}
                      >
                        {choice.label}
                        {choice.adjustment_type === "fixed_price" ? (
                          <span className="ml-1 opacity-70">
                            = {formatAmount(choice.price_adjustment?.amount ?? 0)}
                          </span>
                        ) : delta !== 0 ? (
                          <span className="ml-1 opacity-70">
                            {delta > 0 ? "+" : ""}
                            {formatAmount(delta)}
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              </fieldset>
            );
          })}
        </div>

        <footer className="shrink-0 space-y-2 border-t border-neutral-200 p-4">
          {resolved && resolved.adjustments.length > 0 && (
            <ul className="space-y-1 text-xs text-neutral-500">
              {resolved.adjustments.map((a) => (
                <li key={a.choiceId} className="flex justify-between gap-2">
                  <span className="truncate">{a.label}</span>
                  <span>
                    {a.amount > 0 ? "+" : ""}
                    {formatAmount(a.amount)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {/* Every unmet rule, named. A configurator that only disables its
              button leaves the shopper hunting for what is wrong. */}
          {resolved?.violations.map((v) => (
            <p key={v} className="text-xs text-amber-700">
              {v}
            </p>
          ))}
          <div className="flex items-center justify-between text-sm font-medium">
            <span>Total</span>
            <span>{formatAmount(resolved?.total ?? base)}</span>
          </div>
          {resolved?.code && (
            <p className="truncate font-mono text-[11px] text-neutral-400">{resolved.code}</p>
          )}
          <button
            type="button"
            disabled={!resolved?.orderable}
            onClick={() => resolved && onAdd(product, selection, resolved)}
            className={primaryBtnCls}
          >
            Add to cart
          </button>
        </footer>
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
  configurable,
  onAdd,
}: {
  product: Product;
  categoryName?: string;
  /** Has configurable slots — the button opens the configurator instead of
   *  dropping a fixed line into the cart. */
  configurable?: boolean;
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
          {out ? "Out of stock" : configurable ? "Configure" : "Add to cart"}
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
  lines: { product: Product; line: CartLine }[];
  total: number;
  onSetQty: (key: string, qty: number) => void;
  onCheckout: () => void;
}) {
  return (
    <aside className="h-fit space-y-3 rounded-xl border border-neutral-200 bg-white p-4 shadow-sm">
      <h2 className="text-sm font-medium text-neutral-700">Cart</h2>
      {lines.length === 0 ? (
        <p className="text-sm text-neutral-400">Empty — add a product.</p>
      ) : (
        <ul className="space-y-2">
          {lines.map(({ product, line }) => (
            <li key={line.key} className="space-y-1 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 flex-1 truncate">{product.name}</span>
                <input
                  className="w-14 rounded border border-neutral-300 px-1 py-0.5 text-right text-xs"
                  type="number"
                  min={0}
                  value={line.qty}
                  onChange={(e) => onSetQty(line.key, Number(e.target.value) || 0)}
                />
                <span className="w-16 text-right text-neutral-500">
                  {formatAmount(
                    (line.unitPrice + line.optionsTotal) * line.qty,
                    product.price.currency,
                  )}
                </span>
              </div>
              {/* The configuration, shown back. A basket that says only "Laptop
                  ×1" cannot be checked by the person buying it. */}
              {line.chosen.length > 0 && (
                <ul className="pl-2 text-xs text-neutral-400">
                  {line.chosen.map((c) => (
                    <li key={c.choiceId} className="truncate">
                      {c.label}
                      {c.amount !== 0 && (
                        <span className="ml-1">
                          {c.amount > 0 ? "+" : ""}
                          {formatAmount(c.amount, product.price.currency)}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
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
