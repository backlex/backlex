/**
 * The client, and the row shapes this back-office reads.
 *
 * Two things differ from the storefront example next door, and both are what
 * makes this an ADMIN client rather than a shopper's:
 *
 * - **No `workspace` option.** That switches the SDK into app mode, where
 *   `auth.*` targets the workspace's own end-user pool. A merchant signs into
 *   the control plane (`/api/auth`), so the option is deliberately absent and
 *   the session is the cookie the proxy carries.
 * - **`tenant` instead.** Every request is scoped with `X-Backlex-Tenant`, so
 *   one admin account can hold several stores and this app names the one it
 *   edits.
 */
import { createClient } from "backlex";
import { API_URL, WORKSPACE } from "@backlex-examples/shared";

export const backlex = createClient({
  url: API_URL,
  tenant: WORKSPACE,
});

/** A backlex **money** field as every read returns it — never a bare number. */
export type Money = { amount: number; currency: string };

/** What a write may send for a money column: the pair, or a plain number when
 *  the collection carries a sibling `currency` column to read the unit from. */
export type MoneyIn = Money | number | null;

type Row = Record<string, unknown>;

export type Product = {
  id: string;
  name: string;
  slug?: string;
  description?: string;
  status?: "draft" | "active" | "archived";
  price: Money;
  compare_at_price?: Money | null;
  currency?: string;
  sku?: string | null;
  barcode?: string | null;
  /** Totalled from this product's inventory levels — read-only. */
  stock?: number;
  track_inventory?: boolean;
  featured?: boolean;
  condition?: "new" | "refurbished" | "used";
  brand?: string | null;
  category?: string | null;
  product_type?: string | null;
  tax_class?: string | null;
  tags?: string[] | null;
  featured_image?: string | null;
  rating?: number | null;
  review_count?: number | null;
  published_at?: number | null;
  min_purchase_qty?: number | null;
  max_purchase_qty?: number | null;
  created_at?: string;
} & Row;

export type Variant = {
  id: string;
  product?: string | null;
  title?: string | null;
  sku?: string | null;
  position?: number | null;
  price: Money;
  compare_at_price?: Money | null;
  cost?: Money | null;
  currency?: string;
  is_default?: boolean;
  /** Summed from this variant's inventory levels — read-only. */
  inventory_quantity?: number;
  inventory_policy?: "deny" | "continue";
  weight?: number | null;
  weight_unit?: string;
  requires_shipping?: boolean;
  listing_status?: "pending" | "accepted" | "rejected" | null;
} & Row;

export type ProductOption = { id: string; product?: string | null; name: string; position?: number | null } & Row;
export type OptionValue = {
  id: string;
  option?: string | null;
  value: string;
  swatch?: string | null;
  position?: number | null;
} & Row;
export type VariantOptionValue = {
  id: string;
  variant?: string | null;
  option?: string | null;
  value?: string | null;
} & Row;

export type Category = { id: string; name: string; slug?: string; position?: number | null } & Row;
export type Brand = { id: string; name: string; slug?: string } & Row;
export type ProductType = { id: string; name: string; slug?: string; is_digital?: boolean } & Row;
export type Channel = { id: string; name: string; slug?: string; currency?: string; active?: boolean } & Row;
export type Location = { id: string; name: string; code?: string; active?: boolean } & Row;

export type InventoryLevel = {
  id: string;
  /** The variant's product, carried here so a product can total its stock. */
  product?: string | null;
  variant?: string | null;
  location?: string | null;
  on_hand?: number;
  /** Summed from the reservations still held against this level — read-only. */
  committed?: number;
  /** Generated as `on_hand - committed` — the server owns it, never write it. */
  available?: number;
  incoming?: number;
  reorder_point?: number;
  safety_stock?: number;
} & Row;

export type StockMovement = {
  id: string;
  variant?: string | null;
  location?: string | null;
  movement_type?: "receipt" | "sale" | "return" | "adjustment" | "transfer" | "shrinkage";
  /** Signed — a negative quantity takes stock away. */
  qty?: number;
  reference?: string | null;
  note?: string | null;
  occurred_at?: number | null;
} & Row;

export type Customer = {
  id: string;
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  phone?: string | null;
  customer_group?: string | null;
  accepts_marketing?: boolean;
  total_spent?: Money | null;
  orders_count?: number | null;
  created_at?: string;
} & Row;

export type Order = {
  id: string;
  number?: string | null;
  placed_at?: number | null;
  state?: "draft" | "open" | "completed" | "cancelled";
  status?: "pending" | "authorized" | "partially_paid" | "paid" | "partially_refunded" | "refunded" | "voided";
  fulfillment_status?: "unfulfilled" | "partial" | "fulfilled" | "restocked";
  channel?: string | null;
  customer?: string | null;
  email?: string | null;
  subtotal?: Money | null;
  total_tax?: Money | null;
  total_shipping?: Money | null;
  total_discounts?: Money | null;
  total?: Money | null;
  currency?: string;
  cancel_reason?: string | null;
  cancelled_at?: number | null;
  note?: string | null;
  tags?: string[] | null;
} & Row;

export type OrderItem = {
  id: string;
  order?: string | null;
  product?: string | null;
  variant?: string | null;
  title?: string | null;
  sku?: string | null;
  qty?: number;
  unit_price?: Money | null;
  total_discount?: Money | null;
  tax_rate?: number | null;
  tax_amount?: Money | null;
  /** Generated as `qty * unit_price` — read-only. */
  line_total?: Money | number | null;
} & Row;

export type Fulfillment = {
  id: string;
  order?: string | null;
  location?: string | null;
  status?: string;
  carrier?: string | null;
  tracking_number?: string | null;
  shipped_at?: number | null;
} & Row;

export type FulfillmentItem = {
  id: string;
  fulfillment?: string | null;
  order_item?: string | null;
  qty?: number;
} & Row;

export type Refund = {
  id: string;
  order?: string | null;
  amount?: Money | null;
  reason?: string | null;
  processed_at?: number | null;
} & Row;

export type Discount = {
  id: string;
  name: string;
  code?: string | null;
  automatic?: boolean;
  status?: "draft" | "scheduled" | "active" | "expired";
  discount_type?: "standard" | "buy_get";
  value_type?: "percentage" | "fixed_amount" | "free_shipping";
  value?: number | null;
  target_type?: "items" | "shipping" | "order";
  allocation?: "across" | "each";
  target_selection?: "all" | "entitled";
  minimum_amount?: Money | null;
  usage_limit?: number | null;
  usage_count?: number | null;
  starts_at?: number | null;
  ends_at?: number | null;
} & Row;

export type PriceList = {
  id: string;
  name: string;
  code?: string | null;
  list_type?: "sale" | "override";
  status?: "draft" | "active" | "expired";
  customer_group?: string | null;
  channel?: string | null;
  priority?: number | null;
  active?: boolean;
} & Row;

export type Price = {
  id: string;
  variant?: string | null;
  price_list?: string | null;
  amount: Money;
  currency?: string;
  min_quantity?: number | null;
  max_quantity?: number | null;
} & Row;

// ── Handles ─────────────────────────────────────────────────────────────────
export const products = backlex.from<Product>("products");
export const variants = backlex.from<Variant>("product_variants");
export const productOptions = backlex.from<ProductOption>("product_options");
export const optionValues = backlex.from<OptionValue>("product_option_values");
export const variantOptionValues = backlex.from<VariantOptionValue>("variant_option_values");
export const categories = backlex.from<Category>("categories");
export const brands = backlex.from<Brand>("brands");
export const productTypes = backlex.from<ProductType>("product_types");
export const channels = backlex.from<Channel>("channels");
export const locations = backlex.from<Location>("locations");
export const inventoryLevels = backlex.from<InventoryLevel>("inventory_levels");
export const stockMovements = backlex.from<StockMovement>("stock_movements");
export const customers = backlex.from<Customer>("customers");
export const orders = backlex.from<Order>("orders");
export const orderItems = backlex.from<OrderItem>("order_items");
export const fulfillments = backlex.from<Fulfillment>("fulfillments");
export const fulfillmentItems = backlex.from<FulfillmentItem>("fulfillment_items");
export const refunds = backlex.from<Refund>("refunds");
export const discounts = backlex.from<Discount>("discounts");
export const priceLists = backlex.from<PriceList>("price_lists");
export const prices = backlex.from<Price>("prices");
