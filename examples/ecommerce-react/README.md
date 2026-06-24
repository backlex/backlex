# E-commerce · React + `backlex`

A small storefront that shows the catalog + commerce side of backlex:

1. **Auth** — workspace end-users sign up / sign in against `/api/t/<slug>/auth/*`
   (the app-plane pool, separate from the admin dashboard). The session token is
   persisted to `localStorage` and replayed as a bearer.
2. **Storage uploads** — a seller adds products with a photo; the file is
   uploaded with `backlex.storage.put(key, file, type)` and the returned object
   key is stored on the product's `image_key`. Images render via
   `backlex.storage.download(key)` → an object URL.
3. **Fluent query builder** — the grid loads with
   `products.query().where(...).orderBy(...).limit().withMeta().list()`, with a
   category filter (`f.eq`), a min-price filter (`f.gte`), and a price sort
   toggle (`orderBy("price")` / `"-price"`).
4. **Aggregates** — `products.aggregate({ agg: "count" })` and
   `aggregate({ agg: "avg", field: "price" })` power the header stats (server
   computes them; the client never totals the table).
5. **Batch writes** — checkout creates an `orders` row, then inserts every cart
   line in a single `orderItems.createMany([...])` call (one `/batch` request).
6. **Realtime** — `client.subscribe("items:products", …)` keeps the grid live as
   new products are added.

Dependency-light: React 19 + Vite + Tailwind, and `backlex`. In dev the app
talks to the API **same-origin** through a Vite proxy (`vite.config.ts`) — no
CORS to configure locally.

## 1. Run the backend

From the **repo root**:

```bash
bun install
bun run dev          # API + admin SPA on http://localhost:5173
```

First run? Create the admin account and sign in — see the repo `CLAUDE.md`
("Local test admin") or `docs/getting-started.md`. File storage works out of the
box in local dev (the default storage adapter), so uploads need no extra setup.

## 2. Create a workspace + the collections

In the admin UI (`http://localhost:5173`):

1. **Workspaces → New** — give it a slug, e.g. `demo`. That slug goes in your
   `.env` below. (Background: [`docs/auth-planes.md`](../../docs/auth-planes.md).)
2. **Enable open signup** for the workspace so the app can self-register users
   (Workspace → Auth → policy), or pre-create an app-user.
3. **Collections → New collection** named `products`:
   - **Owner-scoped: on** — auto-adds `owner_id` and seeds owner-scoped
     read/create/update/delete for the `authenticated` role, so each seller only
     manages their own catalog. (See [`docs/permissions.md`](../../docs/permissions.md).)
   - Fields: `name` (**text**, required), `price` (**number / integer**,
     required — stored in **cents**), `stock` (**number**), `category` (**text**),
     `description` (**text**, long), `image_key` (**text** — the storage object
     key of the photo). (`created_at` is added automatically.)
4. **Collections → New collection** named `orders` (order headers):
   - **Owner-scoped: on**.
   - Fields: `total` (**number / integer**, in cents), `status` (**text**).
5. **Collections → New collection** named `order_items` (order lines):
   - **Owner-scoped: on**.
   - Fields: `order_id` (**text**), `product_id` (**text**), `name` (**text**),
     `unit_price` (**number / integer**, in cents), `qty` (**number**).

Storage needs no collection — it's a first-class capability. See
[`docs/storage.md`](../../docs/storage.md).

## 3. Configure and run the example

```bash
cd examples/ecommerce-react
cp .env.example .env        # then set VITE_BACKLEX_WORKSPACE to your slug
bun install                 # already done if you ran it at the repo root
bun run dev                 # http://localhost:5176
```

If anything's missing, the app shows a **setup screen** instead of a blank page:
it validates the env vars and pings the backend to confirm your workspace is
reachable. Once it's green, sign up, add a product with a photo, filter and sort
the grid, add items to the cart, check out, and open a second tab to watch
realtime propagate new products.

## How it maps to the SDK

| File | What it shows |
|---|---|
| `src/env.ts` + `src/SetupCheck.tsx` | declarative env spec + a gate that validates it and pings the backend before the app renders |
| `src/backlex.ts` | `createClient({ url, workspace, token })` + token persistence + the `products` / `orders` / `order_items` collection handles |
| `src/App.tsx` (`AuthForm`) | `auth.signUp` / `auth.signIn` / `auth.getSession` / `auth.signOut` |
| `src/App.tsx` (`Store`) | `query().where().orderBy().withMeta().list()`, `aggregate({ agg })`, `subscribe("items:products")` |
| `src/App.tsx` (`ProductComposer`) | `storage.put(key, file, type)` then `products.create({ image_key })` |
| `src/App.tsx` (`ProductImage`) | `storage.download(key)` → `URL.createObjectURL` |
| `src/App.tsx` (`Store.checkout`) | `orders.create(...)` then `orderItems.createMany([...])` (batch write) |

For the full list of backlex capabilities and which example demonstrates each,
see [`../CAPABILITIES.md`](../CAPABILITIES.md).

## Notes

- **Money is cents.** Prices are stored as integers (cents) so arithmetic stays
  exact; the UI converts to/from dollars at the edges via `formatPrice`.
- **Image transforms.** `download()` + an object URL works on every runtime and
  needs no public URL. In production you'd instead point an `<img>` at a
  signed/public storage URL plus `?width=240&format=webp` to get a server-side
  resize that the browser caches — see [`docs/storage.md`](../../docs/storage.md).
- **Same-origin via the dev proxy** and **realtime over SSE** work exactly as in
  the `todo-react` example — see that folder's README for the deeper notes.
- **Typed collections** — in a real project, run `bun backlex gen-types --sdk`
  to generate row types instead of the hand-written ones in `src/backlex.ts`.
