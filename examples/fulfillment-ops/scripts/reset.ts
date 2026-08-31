/**
 * Drop every collection this example provisioned, children first.
 *
 *   BACKLEX_API_KEY=pak_… bun examples/fulfillment-ops/scripts/reset.ts
 *
 * Destructive on purpose, and it says so: the drop endpoint demands a separate
 * `X-Backlex-Confirm` header carrying the slug, so a mis-aimed DELETE cannot
 * take a table with it.
 */

import { api } from "./api";
import { COLLECTIONS } from "./schema";

const order = [
  "shipment_events",
  "shipments",
  "carriers",
  "package_lines",
  "packages",
  "pick_tasks",
  "pick_waves",
  "campaign_redemptions",
  "campaign_products",
  "campaigns",
  "stock_movements",
  "stock_reservations",
  "stock_levels",
  "order_lines",
  "orders",
  "customer_addresses",
  "customers",
  "products",
  "bins",
  "zones",
  "warehouses",
];

const known = new Set(COLLECTIONS.map((c) => c.slug as string));
for (const s of order) if (!known.has(s)) throw new Error(`reset lists "${s}", schema.ts does not`);
for (const c of COLLECTIONS) if (!order.includes(c.slug as string)) throw new Error(`reset misses "${c.slug}"`);

const list = await api("GET", "/api/collections");
if (!list.ok) throw new Error(`GET /api/collections → ${list.status} ${JSON.stringify(list.json)}`);
const present = new Set<string>(list.json.data.map((c: { slug: string }) => c.slug));

for (const slug of order) {
  if (!present.has(slug)) continue;
  const r = await api("DELETE", `/api/collections/${slug}`, undefined, { "X-Backlex-Confirm": slug });
  console.log(`  ${r.ok ? "✓" : "✗"} ${slug}${r.ok ? "" : ` — ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`}`);
}
