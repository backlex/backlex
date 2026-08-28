import { createClient } from "backlex";
import { API_URL, WORKSPACE } from "@backlex-examples/shared";

// ── Config (from .env — see .env.example, validated by SetupCheck.tsx) ───────
// Empty `url` = same-origin: the SDK issues relative `/api/...` requests that
// the Vite dev proxy (vite.config.ts) forwards to the backend. Set
// VITE_BACKLEX_URL to your deployed API origin for a cross-origin production
// build. A missing workspace is surfaced by the in-app setup check rather than
// crashing here, so the user sees what to fix.
const url = API_URL;
const workspace = WORKSPACE;

// `persist: true` is the whole session story: the SDK writes the captured
// token through on the ONE path every capture goes through, so a reload stays
// signed in and signing out clears it — with no token helper for each screen
// to remember to call.
export const backlex = createClient({
  url,
  workspace,
  persist: true,
});

// ── Collection row types ────────────────────────────────────────────────────
// These mirror a subset of the built-in **E-commerce template** (Overview →
// Templates → E-commerce, or seeded automatically on a fresh workspace). No
// manual collection creation needed — apply the template and run.
//
// Money — `price`, `unit_price`, `subtotal`, `total` — is the template's
// **money** type: read back as `{ amount, currency }` and rendered through
// `formatMoney`, which hands the pair to `Intl.NumberFormat` rather than
// gluing a `$` onto a number. The `& Record<string, unknown>` satisfies the
// SDK's row-type constraint; `backlex gen-types --sdk` can generate these
// for you.

/** A product in the catalog. `featured_image` is the backlex storage object key
 *  of the uploaded photo — we resolve it to an object URL at render time.
 *  `category` is a **relation** — it stores the id of a `categories` row. */
/**
 * A backlex **money** field, as every read surface returns it.
 *
 * The column stores minor units; the API canonicalizes to `{ amount, currency }`
 * so an amount is never a number whose currency you have to remember separately.
 * Writes are more forgiving — a plain number is accepted when the collection has
 * a sibling `currency` column, which the e-commerce template's `products` does —
 * but a READ always hands back this shape, so that is what the row type says.
 */
export type Money = { amount: number; currency: string };

export type Product = {
  id: string;
  name: string;
  slug?: string;
  description?: string;
  /** Base price. A money field — `{ amount, currency }`, never a bare number. */
  price: Money;
  /** Optional "was" price, struck through in the UI when higher than `price`. */
  compare_at_price?: Money | null;
  status?: "draft" | "active" | "archived";
  /** Server-derived: the total on hand across this product's inventory levels.
   *  Read-only — the template refuses a write to it. */
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
 *  (`status`) from shipping state (`fulfillment_status`). Money fields read back
 *  as `{ amount, currency }`; a write may send a plain number, which the sibling
 *  `currency` column then qualifies. */
export type Order = {
  id: string;
  number?: string;
  subtotal?: Money;
  /** Order total. */
  total: Money;
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
  /**
   * Unit price captured at checkout — a plain number, NOT a money field.
   *
   * This is deliberate in the template and worth understanding: a money field
   * is denominated by a `currency` column on its OWN row, and a line item has
   * none — its currency belongs to the parent order. So the line stores a bare
   * amount and the order beside it says what currency the whole thing is in.
   */
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
