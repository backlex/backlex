/**
 * The client, and the row shapes this warehouse console reads.
 *
 * Admin-plane, like the merchant back-office next door: no `workspace` option
 * (that would switch the SDK to the tenant's own end-user pool), and
 * `X-Backlex-Tenant` naming the workspace this console is looking at.
 */
import { createClient } from "backlex";
import { API_URL, WORKSPACE } from "@backlex-examples/shared";

export const backlex = createClient({ url: API_URL, tenant: WORKSPACE });

/** A backlex **money** field as every read returns it — never a bare number. */
export type Money = { amount: number; currency: string };

type Row = Record<string, unknown>;

export type Warehouse = {
  id: string;
  code: string;
  name: string;
  city?: string | null;
  address?: string | null;
  cutoff_time?: string | null;
  active?: boolean;
} & Row;

export type Zone = { id: string; warehouse?: string | null; code: string; name?: string | null; kind?: string } & Row;

export type Bin = {
  id: string;
  warehouse?: string | null;
  zone?: string | null;
  code: string;
  capacity_units?: number | null;
  pick_sequence?: number | null;
  active?: boolean;
} & Row;

export type Product = {
  id: string;
  sku: string;
  barcode?: string | null;
  name: string;
  description?: string | null;
  category?: string | null;
  list_price: Money;
  weight_g?: number | null;
  volume_cm3?: number | null;
  shelf_life_days?: number | null;
  /** Summed from this product's stock levels — read-only. */
  on_hand_total?: number | null;
  active?: boolean;
} & Row;

export type StockLevel = {
  id: string;
  product?: string | null;
  bin?: string | null;
  on_hand: number;
  /** Summed from the reservations still held against this level — read-only. */
  committed?: number | null;
  min_qty?: number | null;
  reorder_point?: number | null;
  counted_at?: number | null;
} & Row;

export type StockMovement = {
  id: string;
  product?: string | null;
  bin?: string | null;
  /** Signed — a negative quantity takes stock away. */
  qty: number;
  reason?: "receipt" | "pick" | "adjustment" | "transfer" | "return" | "damage";
  reference?: string | null;
  occurred_at?: number | null;
  actor?: string | null;
} & Row;

export type Reservation = {
  id: string;
  level?: string | null;
  order_line?: string | null;
  qty: number;
  status?: "held" | "consumed" | "released";
} & Row;

export type Customer = {
  id: string;
  code?: string | null;
  name: string;
  kind?: "bireysel" | "kurumsal";
  segment?: "standart" | "gumus" | "altin" | "platin";
  email?: string | null;
  phone?: string | null;
  tax_office?: string | null;
  tax_no?: string | null;
  credit_limit?: Money | null;
  /** Counted from this customer's orders, cancelled excluded — read-only. */
  orders_count?: number | null;
  active?: boolean;
} & Row;

export type Address = {
  id: string;
  customer?: string | null;
  label: string;
  contact_name?: string | null;
  phone?: string | null;
  line1: string;
  district?: string | null;
  city: string;
  postcode?: string | null;
  country?: string | null;
  is_default?: boolean;
} & Row;

export type OrderStatus = "new" | "confirmed" | "picking" | "packed" | "shipped" | "delivered" | "cancelled";

export type Order = {
  id: string;
  order_no?: string | null;
  customer?: string | null;
  shipping_address?: string | null;
  warehouse?: string | null;
  channel?: "web" | "marketplace" | "telefon" | "magaza";
  priority?: "standart" | "hizli" | "ayni_gun";
  status: OrderStatus;
  placed_at?: number | null;
  promised_at?: number | null;
  /** Counted / summed from this order's lines — read-only. */
  line_count?: number | null;
  items_total?: Money | null;
  discount_total?: Money | null;
  shipping_fee?: Money | null;
  grand_total?: Money | null;
  notes?: string | null;
} & Row;

export type OrderLine = {
  id: string;
  order?: string | null;
  product?: string | null;
  qty: number;
  qty_picked?: number | null;
  unit_price: Money;
  line_total: Money;
} & Row;

export type WaveStatus = "planned" | "released" | "in_progress" | "completed" | "cancelled";

export type PickWave = {
  id: string;
  wave_no?: string | null;
  warehouse?: string | null;
  status: WaveStatus;
  assigned_to?: string | null;
  planned_at?: number | null;
  released_at?: number | null;
  task_count?: number | null;
  units_picked?: number | null;
} & Row;

export type TaskStatus = "pending" | "picking" | "picked" | "short";

export type PickTask = {
  id: string;
  wave?: string | null;
  order?: string | null;
  order_line?: string | null;
  product?: string | null;
  bin?: string | null;
  qty_required: number;
  qty_picked?: number | null;
  sequence?: number | null;
  picker?: string | null;
  status: TaskStatus;
  picked_at?: number | null;
} & Row;

export type Package = {
  id: string;
  package_no?: string | null;
  order?: string | null;
  weight_g?: number | null;
  length_cm?: number | null;
  width_cm?: number | null;
  height_cm?: number | null;
  unit_count?: number | null;
  packed_by?: string | null;
  packed_at?: number | null;
  status?: "open" | "sealed" | "handed_over";
} & Row;

export type PackageLine = { id: string; package?: string | null; product?: string | null; qty: number } & Row;

export type Carrier = {
  id: string;
  code: string;
  name: string;
  tracking_url_template?: string | null;
  support_phone?: string | null;
  cutoff_time?: string | null;
  active?: boolean;
} & Row;

export type ShipmentStatus =
  | "created"
  | "handed_over"
  | "in_transit"
  | "out_for_delivery"
  | "delivered"
  | "returned"
  | "lost";

export type Shipment = {
  id: string;
  shipment_no?: string | null;
  order?: string | null;
  package?: string | null;
  carrier?: string | null;
  tracking_no?: string | null;
  service?: "standart" | "ekspres" | "ayni_gun";
  status: ShipmentStatus;
  recipient_name?: string | null;
  recipient_phone?: string | null;
  destination_city?: string | null;
  weight_g?: number | null;
  cost?: Money | null;
  /** Counted from this shipment's events — read-only. */
  event_count?: number | null;
  created_at?: string;
  dispatched_at?: number | null;
  delivered_at?: number | null;
} & Row;

export type ShipmentEvent = {
  id: string;
  shipment?: string | null;
  status?: string;
  location?: string | null;
  occurred_at?: number | null;
  description?: string | null;
} & Row;

export type CampaignStatus = "draft" | "scheduled" | "active" | "paused" | "ended";

export type Campaign = {
  id: string;
  name: string;
  code?: string | null;
  kind?: "percent" | "amount" | "free_shipping";
  percent_off?: number | null;
  amount_off?: Money | null;
  min_basket?: Money | null;
  starts_at?: number | null;
  ends_at?: number | null;
  budget?: Money | null;
  /** Summed from this campaign's redemptions — read-only. */
  spent?: Money | null;
  usage_limit?: number | null;
  /** Counted from this campaign's redemptions — read-only. */
  redemption_count?: number | null;
  channel?: string | null;
  status: CampaignStatus;
} & Row;

export type Redemption = {
  id: string;
  campaign?: string | null;
  order?: string | null;
  customer?: string | null;
  discount_amount: Money;
  redeemed_at?: number | null;
} & Row;

// ── Handles ─────────────────────────────────────────────────────────────────
export const warehouses = backlex.from<Warehouse>("warehouses");
export const zones = backlex.from<Zone>("zones");
export const bins = backlex.from<Bin>("bins");
export const products = backlex.from<Product>("products");
export const stockLevels = backlex.from<StockLevel>("stock_levels");
export const stockMovements = backlex.from<StockMovement>("stock_movements");
export const reservations = backlex.from<Reservation>("stock_reservations");
export const customers = backlex.from<Customer>("customers");
export const addresses = backlex.from<Address>("customer_addresses");
export const orders = backlex.from<Order>("orders");
export const orderLines = backlex.from<OrderLine>("order_lines");
export const pickWaves = backlex.from<PickWave>("pick_waves");
export const pickTasks = backlex.from<PickTask>("pick_tasks");
export const packages = backlex.from<Package>("packages");
export const packageLines = backlex.from<PackageLine>("package_lines");
export const carriers = backlex.from<Carrier>("carriers");
export const shipments = backlex.from<Shipment>("shipments");
export const shipmentEvents = backlex.from<ShipmentEvent>("shipment_events");
export const campaigns = backlex.from<Campaign>("campaigns");
export const redemptions = backlex.from<Redemption>("campaign_redemptions");

/** `available = on_hand − committed`. The server maintains `committed` as a
 *  rollup over held reservations; it does NOT maintain this difference, so the
 *  subtraction is the client's and is done in exactly one place. */
export const available = (l: Pick<StockLevel, "on_hand" | "committed">): number =>
  (l.on_hand ?? 0) - (l.committed ?? 0);

/**
 * Every row of a collection, one legal page at a time.
 *
 * `limit` tops out at **200** and the server answers `422` rather than clamping
 * — so `limit: 500` is not a slow query, it is a screen that never loads, and
 * the only evidence is whatever the caller's `catch` happens to print. A
 * warehouse outgrows 200 stock levels on its first real day, so anything that
 * needs "all of them" comes through here instead of guessing a bigger number.
 */
export async function listAll<T extends { id: string }>(
  handle: { list: (q: { limit: number; offset: number; sort?: string }) => Promise<{ data: T[] }> },
  opts: { sort?: string; max?: number } = {},
): Promise<T[]> {
  const page = 200;
  const max = opts.max ?? 5_000;
  const out: T[] = [];
  for (let offset = 0; offset < max; offset += page) {
    const r = await handle.list({ limit: page, offset, ...(opts.sort ? { sort: opts.sort } : {}) });
    out.push(...r.data);
    if (r.data.length < page) break;
  }
  return out;
}
