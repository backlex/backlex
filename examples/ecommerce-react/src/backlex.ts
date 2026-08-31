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
 *  catalog edits don't rewrite history. `order` / `product` are relation ids. */
export type OrderItem = {
  id: string;
  /** Relation: parent `orders` row id. */
  order: string;
  /** Relation: `products` row id. */
  product: string;
  /** Relation: the stocked unit — `product_variants` row id. A line carries
   *  BOTH this and its configuration: the variant says which unit leaves the
   *  shelf, the option rows say what was decided about it. */
  variant?: string;
  /** Snapshot of the product name at purchase time. */
  title: string;
  sku?: string;
  /**
   * The base price captured at checkout — a **money** field, like every other
   * amount in the template.
   *
   * It used to be a bare number, on the reasoning that a line has no currency
   * of its own. It does: `order_items.currency` sits beside this column, and
   * without it `sum()` over a mixed-currency column adds €85 to $100 and
   * answers 185.5 of nothing. A READ hands back `{ amount, currency }`; a WRITE
   * may still send a plain number, which the sibling `currency` qualifies.
   */
  unit_price: Money;
  /** What the configuration added, kept apart from the base so the line can
   *  always show the breakdown back. Zero on an unconfigured line. */
  options_total?: Money | null;
  /** The compact build string — `RAM32GB/SSD1TB/FINBLK`. A summary of the
   *  `order_item_options` rows, never the source. */
  config_code?: string | null;
  qty: number;
  /**
   * Computed server-side as `qty * (unit_price + COALESCE(options_total, 0))`
   * — never written by the client. The COALESCE is what keeps an unconfigured
   * line's total from being NULL.
   */
  line_total?: Money | null;
} & Record<string, unknown>;

/** One configured slot on an order line — what was actually chosen.
 *
 *  The label and the adjustment are SNAPSHOTS. Re-reading them off the catalog
 *  at render time would show today's price for yesterday's purchase, which is
 *  the whole reason this table exists rather than a list of ids. */
export type OrderItemOption = {
  id: string;
  /** Relation: parent `order_items` row id. */
  line: string;
  /** Relation: the slot — a `product_modifiers` row id. */
  modifier: string;
  /** Relation: the chosen `modifier_values` row. Empty for a typed answer. */
  value?: string | null;
  label?: string | null;
  /** The answer for a text/number slot, where there is no choice list. */
  value_text?: string | null;
  qty?: number;
  price_adjustment?: Money | null;
  /** The stocked unit this choice consumed, copied across at checkout so the
   *  picker is told what to fit. */
  component_variant?: string | null;
  position?: number;
} & Record<string, unknown>;

/** A configurable axis, defined once and shared by every product that has it. */
export type ModifierSet = {
  id: string;
  name: string;
  code?: string | null;
  input_type?: "choice" | "multi_choice" | "checkbox" | "text" | "multiline_text" | "number" | "date" | "file";
  min_select?: number;
  max_select?: number;
  help_text?: string | null;
  active?: boolean;
} & Record<string, unknown>;

/** One choice on a set, with what picking it does to the price — and, for a
 *  choice that ships a part, the stocked unit it consumes. */
export type ModifierValue = {
  id: string;
  /** Relation: `modifier_sets` row id. */
  modifier_set: string;
  label: string;
  code?: string | null;
  adjustment_type?: "fixed_amount" | "percent" | "fixed_price";
  price_adjustment?: Money | null;
  adjustment_percent?: number | null;
  is_default?: boolean;
  active?: boolean;
  /** Relation: the `product_variants` row this choice takes off the shelf. */
  component_variant?: string | null;
  consumes_qty?: number;
  position?: number;
} & Record<string, unknown>;

/** A **slot**: this product carries that set, here, with this label.
 *
 *  Deliberately repeatable — a machine with four drive bays is four rows over
 *  ONE shared set, which is exactly what a per-product option list cannot say. */
export type ProductModifier = {
  id: string;
  /** Relation: `products` row id. */
  product: string;
  /** Relation: `modifier_sets` row id. */
  modifier_set: string;
  /** Overrides the set's name here — "Drive bay 2". */
  label?: string | null;
  is_required?: boolean;
  /** Relation: the pre-selected `modifier_values` row. */
  default_value?: string | null;
  help_text?: string | null;
  position?: number;
} & Record<string, unknown>;

/** Which combinations are legal. Data, not branches in this file — a rule
 *  spelled in a storefront is re-implemented by every other channel. */
export type ModifierRule = {
  id: string;
  rule_type: "requires" | "excludes" | "hides" | "sets_default" | "validation";
  /** Relation: the `product_modifiers` slot the rule watches. */
  when_modifier: string;
  when_value?: string | null;
  then_modifier?: string | null;
  then_value?: string | null;
  message?: string | null;
  active?: boolean;
} & Record<string, unknown>;

/** The typed CRUD handle for the `products` collection. */
export const products = backlex.from<Product>("products");

/** The typed CRUD handle for the `categories` collection. */
export const categories = backlex.from<Category>("categories");

/** The typed CRUD handle for the `orders` collection (order headers). */
export const orders = backlex.from<Order>("orders");

/** The typed CRUD handle for the `order_items` collection (order lines). */
export const orderItems = backlex.from<OrderItem>("order_items");

/** The configured slots of an order line — the itemisation `config_code`
 *  summarises, and the only place the build is recorded row by row. */
export const orderItemOptions = backlex.from<OrderItemOption>("order_item_options");

/** The shared configurable axes (`modifier_sets`). */
export const modifierSets = backlex.from<ModifierSet>("modifier_sets");

/** The choices on those axes (`modifier_values`). */
export const modifierValues = backlex.from<ModifierValue>("modifier_values");

/** Which sets a product carries, and in how many slots (`product_modifiers`). */
export const productModifiers = backlex.from<ProductModifier>("product_modifiers");

/** The compatibility rules (`modifier_rules`). */
export const modifierRules = backlex.from<ModifierRule>("modifier_rules");
