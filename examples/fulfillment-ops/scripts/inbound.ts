/**
 * Simulate the webshop dropping new orders in — the one thing this console
 * does NOT do, because orders arrive from a storefront rather than from a
 * warehouse operator.
 *
 *   BACKLEX_API_KEY=pak_… bun examples/fulfillment-ops/scripts/inbound.ts [count]
 */

import { must } from "./api";

const count = Number(process.argv[2] ?? 3);
const pick = <T,>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)]!;

const list = async (slug: string, qs = "") => (await must("GET", `/api/items/${slug}${qs}`)).data;

const customers = await list("customers", "?limit=50&filter=" + encodeURIComponent(JSON.stringify({ active: { _eq: true } })));
const addresses = await list("customer_addresses", "?limit=100");
const products = await list("products", "?limit=50&filter=" + encodeURIComponent(JSON.stringify({ active: { _eq: true } })));
const warehouses = await list("warehouses", "?limit=10");
const wh = warehouses.find((w: any) => w.code === "IST-1") ?? warehouses[0];

for (let i = 0; i < count; i++) {
  const candidates = customers.filter((c: any) => addresses.some((a: any) => a.customer === c.id));
  const customer = pick(candidates);
  const address = addresses.find((a: any) => a.customer === customer.id);

  const order = (
    await must("POST", "/api/items/orders", {
      customer: customer.id,
      shipping_address: address.id,
      warehouse: wh.id,
      channel: pick(["web", "marketplace", "telefon"]),
      priority: pick(["standart", "standart", "hizli", "ayni_gun"]),
      status: "new",
      shipping_fee: { amount: 89.9, currency: "TRY" },
    })
  ).data;

  const chosen = [...products].sort(() => Math.random() - 0.5).slice(0, 1 + Math.floor(Math.random() * 3));
  let subtotal = 0;
  for (const p of chosen) {
    const qty = 1 + Math.floor(Math.random() * 4);
    const lineTotal = Math.round(p.list_price.amount * qty * 100) / 100;
    subtotal += lineTotal;
    await must("POST", "/api/items/order_lines", {
      order: order.id,
      product: p.id,
      qty,
      unit_price: { amount: p.list_price.amount, currency: "TRY" },
      line_total: { amount: lineTotal, currency: "TRY" },
    });
  }
  await must("PATCH", `/api/items/orders/${order.id}`, {
    grand_total: { amount: Math.round((subtotal + 89.9) * 100) / 100, currency: "TRY" },
  });
  await must("PATCH", `/api/items/orders/${order.id}`, { status: "confirmed" });

  const back = await must("GET", `/api/items/orders/${order.id}`);
  console.log(`  ${back.data.order_no}  ${customer.name}  ${chosen.length} satır  ${back.data.grand_total.amount} TRY`);
}
