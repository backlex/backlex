# Depo & Sevkiyat — a warehouse / fulfillment console on backlex

A working operation, not a demo: customers, multi-bin stock with reservations,
campaigns, order preparation (pick waves → tasks → packing), shipments and
carrier tracking. Twenty-one collections, provisioned over the public API
exactly the way an integrator would.

It exists to be **driven**. Everything a warehouse actually does on a bad day —
overselling, a short pick, a cancelled order, a bin in the wrong warehouse — has
a probe in `scripts/`, and each probe says out loud whether the answer it got is
the answer the model promises.

## Run it

```bash
# 1. Backend (repo root)
bun run dev                     # http://localhost:5173

# 2. A workspace and a key for it
curl -s -c /tmp/c.txt -H 'Origin: http://localhost:5173' -H 'Content-Type: application/json' \
  -d '{"email":"admin@example.com","password":"correct-horse-battery","name":"Admin"}' \
  http://localhost:5173/api/auth/sign-up/email
curl -s -b /tmp/c.txt -H 'Origin: http://localhost:5173' -H 'Content-Type: application/json' \
  -d '{"name":"Sevkiyat"}' http://localhost:5173/api/tenants
curl -s -b /tmp/c.txt -H 'Origin: http://localhost:5173' -H 'Content-Type: application/json' \
  -H 'X-Backlex-Tenant: sevkiyat' -d '{"name":"provisioner"}' http://localhost:5173/api/api-keys
# → copy `secret`

# 3. Schema + fixtures
export BACKLEX_API_KEY=pak_…
bun run --cwd examples/fulfillment-ops provision
bun run --cwd examples/fulfillment-ops seed

# 4. The console
cp examples/fulfillment-ops/.env.example examples/fulfillment-ops/.env
bun run --cwd examples/fulfillment-ops dev    # http://localhost:5181
```

Sign in with the same `admin@example.com` / `correct-horse-battery`.

## Scripts

| Script | What it does |
|---|---|
| `provision` | Creates the 21 collections. Two passes, because `orders` ⇄ `order_lines` is a real cycle: pass 1 creates everything with the forward-pointing fields removed, pass 2 PATCHes them back. |
| `seed` | Warehouses, racking, catalogue, customers, carriers, campaigns and opening stock. Reference data only. |
| `inbound [n]` | Simulates the webshop dropping `n` new orders in — the one thing this console does not do, because orders arrive from a storefront. |
| `operate` | Drives one day end to end (reserve → wave → pick → pack → ship → track → deliver) and **asserts the invariants as it goes**. |
| `probe` | Edge probes: oversell, negative stock, forbidden transitions, conditional requirements, retirement, query surface. |
| `probe-tr` | Turkish-locale probes: case folding, dotted/dotless I, collation, phone canonicalization, kuruş rounding. |
| `reset` | Drops every collection, children first. |

## What the model is careful about

**Money is denominated and fixed.** The operation is domestic, so every money
column is pinned to `TRY` rather than reading a sibling `currency` column. That
is deliberate: a money *rollup* is refused when either side uses
`money.currencyField` (summing it would add denominations together), and order
totals maintained from their lines are exactly what a rollup is for.

**`committed` is a rollup, not a column an operator can type into.** It sums the
reservations still `held` against a level. `stock_reservations` therefore carries
a **required** `level` relation — a reservation that names only (product,
location) can never be joined back to the level it consumes, and then "how many
are actually free" has no answer. `available = on_hand − committed` is computed
in one place (`lib/backlex.ts`) because the server does not maintain the
difference.

**A stock transfer is two rows, not one.** Both sign the same `reference`. Every
stock report asks `SUM(qty) WHERE bin = X`, and a single two-ended row would have
to be special-cased out of every one of them.

**Bins carry a walk order.** `bins.pick_sequence` is an `order` field scoped by
warehouse, and wave building sorts tasks by it, so the picker walks the aisle
once instead of criss-crossing it.

**Status buttons come from the server.** Both the order screen and the campaign
screen ask `transitions(id)` and render what comes back. A client that draws its
own graph offers a move the server will refuse, and then the refusal looks like
a bug in the app.

## Two traps this example exists to remember

**`limit` tops out at 200 and the server answers `422` rather than clamping.**
Ask for 500 and the screen never loads — the only evidence is whatever your
`catch` happens to print. Every "all of them" read here goes through
`listAll()`, which pages. This example was written with five over-limit calls in
it before that helper existed.

**A wave is a batch, not a loop.** Building one used to be one `create` per task
plus one `update` per order — for a hundred-line wave, a hundred sequential
round trips and a minute of spinner. It is now two `batch` calls.
