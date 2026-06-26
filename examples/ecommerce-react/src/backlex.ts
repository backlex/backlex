import { createClient } from "backlex";
import { API_URL, WORKSPACE } from "./env";

// ── Config (from .env — see .env.example, validated by SetupCheck.tsx) ───────
// Empty `url` = same-origin: the SDK issues relative `/api/...` requests that
// the Vite dev proxy (vite.config.ts) forwards to the backend. Set
// VITE_BACKLEX_URL to your deployed API origin for a cross-origin production
// build. A missing workspace is surfaced by the in-app setup check rather than
// crashing here, so the user sees what to fix.
const url = API_URL;
const workspace = WORKSPACE;

// ── Session-token persistence ───────────────────────────────────────────────
// In "app mode" (a `workspace` is set) the SDK captures the workspace session
// token returned by signIn/signUp and replays it as a bearer on every request.
// We stash it in localStorage so a page reload stays signed in, and hand it
// back to `createClient({ token })` on boot.
const TOKEN_KEY = `backlex.token.${workspace}`;

export const backlex = createClient({
  url,
  workspace,
  token: localStorage.getItem(TOKEN_KEY) ?? undefined,
});

/** Mirror the SDK's current token into localStorage (call after sign-in/out). */
export function persistToken(): void {
  const token = backlex.auth.getToken();
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

// ── Collection row types ────────────────────────────────────────────────────
// These mirror a subset of the built-in **E-commerce template** (Overview →
// Templates → E-commerce, or seeded automatically on a fresh workspace). No
// manual collection creation needed — apply the template and run.
//
// Money is the template's `price` field: a **decimal number of dollars**
// (interface `decimal`, validated `min: 0`). We format it as $X.XX via
// `formatPrice`. The `& Record<string, unknown>` satisfies the SDK's row-type
// constraint; `backlex gen-types --sdk` can generate these for you.

/** A product in the catalog. `featured_image` is the backlex storage object key
 *  of the uploaded photo — we resolve it to an object URL at render time.
 *  `category` is a **relation** — it stores the id of a `categories` row. */
export type Product = {
  id: string;
  name: string;
  slug?: string;
  description?: string;
  /** Price in dollars (decimal). */
  price: number;
  /** Optional "was" price, struck through in the UI when higher than `price`. */
  compare_at_price?: number;
  status?: "draft" | "active" | "archived";
  stock?: number;
  sku?: string;
  /** Relation: the id of a `categories` row (resolve via the `categories` map). */
  category?: string;
  /** backlex storage key of the product photo (e.g. `products/<uuid>-shoe.png`). */
  featured_image?: string;
  created_at?: string;
} & Record<string, unknown>;

/** A product category (template `categories` collection). */
export type Category = {
  id: string;
  name: string;
  slug?: string;
} & Record<string, unknown>;

/** An order header. The line items live in the child `order_items` collection,
 *  written in one batch at checkout. The template splits payment state
 *  (`status`) from shipping state (`fulfillment_status`); `total` is in dollars. */
export type Order = {
  id: string;
  number?: string;
  subtotal?: number;
  /** Order total in dollars. */
  total: number;
  /** Payment status — template financial_status (`pending` … `paid` … `refunded`). */
  status?: string;
  created_at?: string;
} & Record<string, unknown>;

/** One line of an order — a snapshot of the product at purchase time so later
 *  catalog edits don't rewrite history. `order` / `product` are relation ids.
 *  `line_total` is a **computed** column (`qty * unit_price`) — read-only. */
export type OrderItem = {
  id: string;
  /** Relation: parent `orders` row id. */
  order: string;
  /** Relation: `products` row id. */
  product: string;
  /** Snapshot of the product name at purchase time. */
  title: string;
  sku?: string;
  /** Unit price in dollars, captured at checkout. */
  unit_price: number;
  qty: number;
  /** Computed server-side as `qty * unit_price` — never written by the client. */
  line_total?: number;
} & Record<string, unknown>;

/** The typed CRUD handle for the `products` collection. */
export const products = backlex.from<Product>("products");

/** The typed CRUD handle for the `categories` collection. */
export const categories = backlex.from<Category>("categories");

/** The typed CRUD handle for the `orders` collection (order headers). */
export const orders = backlex.from<Order>("orders");

/** The typed CRUD handle for the `order_items` collection (order lines). */
export const orderItems = backlex.from<OrderItem>("order_items");
