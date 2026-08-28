# E-commerce admin — React + Vite

A merchant back-office built on the backlex **E-commerce template**: catalog with
options and variants, multi-location inventory, price lists, orders with
fulfillment and refunds, discounts with rules, and a dashboard fed by named KPIs.

The storefront example next door (`examples/ecommerce-react`) is the shopper's
half of the same workspace. This is the half the shop's staff use.

## Run it

```bash
# 1. Backend — from the repo root
bun run dev                       # http://localhost:5173

# 2. A workspace holding the E-commerce template
#    Overview → Templates → E-commerce in the admin SPA, or:
#      POST /api/tenants                 { "name": "Storefront" }
#      POST /api/admin/templates/apply   { "templateId": "ecommerce" }
#    The slug is folded from the name — "Storefront" becomes `storefront`.

# 3. This app
cp examples/ecommerce-admin-react/.env.example examples/ecommerce-admin-react/.env
#    set VITE_BACKLEX_WORKSPACE to the workspace slug from step 2
bun run --cwd examples/ecommerce-admin-react dev    # http://localhost:5179
```

Sign in with your backlex admin account — the local dev one is in `CLAUDE.md`.

## What it shows

| Screen | Exercises |
|---|---|
| **Dashboard** | Named KPIs (`backlex.kpis.run`) over a selectable window, so this screen and the backlex admin's own cannot disagree about what "net revenue" means. Grouped KPIs print one figure per currency rather than summing across them. |
| **Products** | Server-side search (`q`), filter, sort and paging. `status: "all"` because the collection is versioned — without it a draft is invisible to the person who just created it. |
| **Options & variants** | The link table that makes a variant resolvable: `product_options` → `product_option_values` → `product_variants` → `variant_option_values`. "Generate missing variants" walks the cartesian product and writes one variant plus one link row per axis, in two `batch` calls. |
| **Inventory** | Per (variant × location) levels. `available` is a generated column — the server owns it, and writing it is a 422. |
| **Orders** | The three axes the model separates: `state` (the order's own life), `status` (payment), `fulfillment_status` (delivery). Cancellation lives on `state` and nowhere else. |
| **Order detail** | Actions write the row the model expects rather than flipping a status: a payment is a `transactions` row, a shipment a `fulfillments` + `fulfillment_items` pair, a refund a `refunds` row. The status column is a summary of the ledger, not the ledger. |
| **Pricing** | Price lists and the prices on them — wholesale, a sale, and a quantity break are the same row shape with a different range. |
| **Discounts** | Coded and automatic promotions plus `discount_rules`, and a warning when `target_selection: "entitled"` has no target rule to point at. |
| **Customers** | Stored `total_spent` shown beside the figure their orders actually add up to, so the two can be seen to disagree. |

## Two things worth copying

**This is an ADMIN client, not an app client.** `createClient` gets `tenant`, not
`workspace`. `workspace` switches the SDK into app mode, where `auth.*` targets
that workspace's own end-user pool; a merchant signs into the control plane. See
`src/lib/backlex.ts`.

**`limit` tops out at 200 and a larger value is refused, not clamped.** Sets that
are unbounded in principle — an option's values, a product's variant links, a
price list's rows — page through `listAll()` in `src/pages/ProductDetail.tsx`.

## Notes

- Money reads back as `{ amount, currency }` everywhere, including the computed
  `order_items.line_total`. `fmtMoney` hands the pair to `Intl.NumberFormat`
  rather than gluing a `$` onto a number.
- Timestamps from `ts()` columns are epoch milliseconds; the system `created_at`
  is an ISO string. `src/lib/money.ts` takes either.
- Loading states are skeletons, never a "Loading…" string. A failed request
  renders its message rather than leaving the skeleton up forever.
- Verified at 390×740 and at desktop width: the page never scrolls sideways,
  wide tables scroll inside their own container, and a dialog's footer stays
  on-screen while its body scrolls.

```bash
bun run --cwd examples/ecommerce-admin-react typecheck
```
