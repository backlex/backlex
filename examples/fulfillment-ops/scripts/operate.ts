/**
 * Drive one day of fulfillment end to end, asserting the invariants as it goes.
 *
 *   BACKLEX_API_KEY=pak_… bun examples/fulfillment-ops/scripts/operate.ts
 *
 * The assertions are the point. A 2xx that did nothing is the failure mode this
 * platform actually has, so every step that is supposed to change a number reads
 * the number back and says so out loud when it did not move.
 */

import { api, must } from "./api";

let checks = 0;
const problems: string[] = [];

function check(label: string, actual: unknown, expected: unknown) {
  checks++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    problems.push(`${label}: beklenen ${e}, gelen ${a}`);
    console.log(`  ✗ ${label} — beklenen ${e}, gelen ${a}`);
  } else {
    console.log(`  ✓ ${label} = ${a}`);
  }
}

const one = async (slug: string, id: string) => (await must("GET", `/api/items/${slug}/${id}`)).data;
const list = async (slug: string, qs = "") => (await must("GET", `/api/items/${slug}${qs}`)).data;
const amount = (m: unknown) => (m && typeof m === "object" ? (m as { amount: number }).amount : m);

const bySku = new Map<string, any>();
for (const p of await list("products", "?limit=50")) bySku.set(p.sku, p);
const byCustomer = new Map<string, any>();
for (const c of await list("customers", "?limit=50")) byCustomer.set(c.name, c);
const addressOf = new Map<string, string>();
for (const a of await list("customer_addresses", "?limit=50")) addressOf.set(a.customer, a.id);
const warehouses = await list("warehouses", "?limit=10");
const whIst = warehouses.find((w: any) => w.code === "IST-1");
const carriers = await list("carriers", "?limit=10");
const campaigns = await list("campaigns", "?limit=10");
const bins = await list("bins", "?limit=50");
const levels = await list("stock_levels", "?limit=100");
const levelFor = (productId: string, binId: string) =>
  levels.find((l: any) => l.product === productId && l.bin === binId);

// ── 1. sipariş girişi ───────────────────────────────────────────────────────
console.log("\n1. sipariş girişi");
type LineSpec = { sku: string; qty: number };
const orderPlan: { who: string; channel: string; priority: string; lines: LineSpec[]; campaign?: string }[] = [
  {
    who: "Ayşe Yıldırım",
    channel: "web",
    priority: "hizli",
    lines: [
      { sku: "KHV-0001", qty: 2 },
      { sku: "EVY-0001", qty: 4 },
    ],
    campaign: "BAHAR15",
  },
  {
    who: "Kuzey Gıda Ltd. Şti.",
    channel: "telefon",
    priority: "standart",
    lines: [
      { sku: "KHV-0002", qty: 12 },
      { sku: "CAY-0001", qty: 24 },
    ],
    campaign: "KAHVE100",
  },
  {
    who: "Mehmet Demir",
    channel: "web",
    priority: "standart",
    lines: [{ sku: "ELK-0002", qty: 1 }],
  },
  {
    who: "Zeynep Kaya",
    channel: "marketplace",
    priority: "ayni_gun",
    lines: [
      { sku: "KZM-0001", qty: 1 },
      { sku: "KZM-0002", qty: 2 },
      { sku: "TKS-0001", qty: 3 },
    ],
  },
  {
    who: "Ege Market A.Ş.",
    channel: "telefon",
    priority: "standart",
    lines: [
      { sku: "EVY-0002", qty: 10 },
      { sku: "ELK-0001", qty: 2 },
    ],
  },
];

const orders: any[] = [];
for (const spec of orderPlan) {
  const customer = byCustomer.get(spec.who);
  const order = (
    await must("POST", "/api/items/orders", {
      customer: customer.id,
      shipping_address: addressOf.get(customer.id),
      warehouse: whIst.id,
      channel: spec.channel,
      priority: spec.priority,
      status: "new",
      shipping_fee: { amount: 89.9, currency: "TRY" },
    })
  ).data;

  let subtotal = 0;
  for (const l of spec.lines) {
    const p = bySku.get(l.sku);
    const unit = p.list_price.amount as number;
    const lineTotal = Math.round(unit * l.qty * 100) / 100;
    subtotal += lineTotal;
    await must("POST", "/api/items/order_lines", {
      order: order.id,
      product: p.id,
      qty: l.qty,
      unit_price: { amount: unit, currency: "TRY" },
      line_total: { amount: lineTotal, currency: "TRY" },
    });
  }

  let discount = 0;
  if (spec.campaign) {
    const c = campaigns.find((x: any) => x.code === spec.campaign);
    discount =
      c.kind === "percent"
        ? Math.round(subtotal * (c.percent_off / 100) * 100) / 100
        : (c.amount_off?.amount ?? 0);
    await must("POST", "/api/items/campaign_redemptions", {
      campaign: c.id,
      order: order.id,
      customer: customer.id,
      discount_amount: { amount: discount, currency: "TRY" },
    });
  }

  const grand = Math.round((subtotal - discount + 89.9) * 100) / 100;
  await must("PATCH", `/api/items/orders/${order.id}`, {
    discount_total: { amount: discount, currency: "TRY" },
    grand_total: { amount: grand, currency: "TRY" },
  });

  const back = await one("orders", order.id);
  orders.push({ ...back, _expectedSubtotal: Math.round(subtotal * 100) / 100, _lines: spec.lines });
  console.log(
    `  ${back.order_no}  ${spec.who}  ${spec.lines.length} satır  ara=${amount(back.items_total)}  toplam=${amount(back.grand_total)}`,
  );
}

console.log("\n   sipariş toplamları satırlardan geliyor mu");
for (const o of orders) check(`${o.order_no} items_total`, amount(o.items_total), o._expectedSubtotal);
for (const o of orders) check(`${o.order_no} line_count`, o.line_count, o._lines.length);

console.log("\n   müşteri sipariş sayacı");
const ayse = await one("customers", byCustomer.get("Ayşe Yıldırım").id);
check("Ayşe orders_count", ayse.orders_count, 1);

console.log("\n   kampanya sayaçları");
for (const code of ["BAHAR15", "KAHVE100"]) {
  const c = campaigns.find((x: any) => x.code === code);
  const fresh = await one("campaigns", c.id);
  check(`${code} redemption_count`, fresh.redemption_count, 1);
  if (amount(fresh.spent) === 0 || fresh.spent === null) {
    problems.push(`${code}: spent rollup indirimi toplamadı (${JSON.stringify(fresh.spent)})`);
    console.log(`  ✗ ${code} spent = ${JSON.stringify(fresh.spent)}`);
  } else {
    console.log(`  ✓ ${code} spent = ${amount(fresh.spent)}`);
  }
}

// ── 2. onay + stok rezervasyonu ─────────────────────────────────────────────
console.log("\n2. onay ve stok rezervasyonu");
for (const o of orders) await must("PATCH", `/api/items/orders/${o.id}`, { status: "confirmed" });

const reservations: any[] = [];
for (const o of orders) {
  const lines = await list("order_lines", `?filter=${encodeURIComponent(JSON.stringify({ order: o.id }))}&limit=50`);
  for (const line of lines) {
    const lvl = levels.find((l: any) => l.product === line.product && bins.some((b: any) => b.id === l.bin && b.warehouse === whIst.id));
    if (!lvl) {
      problems.push(`${o.order_no}: ${line.product} için İstanbul deposunda stok seviyesi yok`);
      continue;
    }
    reservations.push(
      (
        await must("POST", "/api/items/stock_reservations", {
          level: lvl.id,
          order_line: line.id,
          qty: line.qty,
          status: "held",
        })
      ).data,
    );
  }
}
console.log(`  ${reservations.length} rezervasyon`);

console.log("\n   rezerve edilen miktar stok seviyesine yansıdı mı");
const heldByLevel = new Map<string, number>();
for (const r of reservations) heldByLevel.set(r.level, (heldByLevel.get(r.level) ?? 0) + r.qty);
for (const [levelId, held] of heldByLevel) {
  const fresh = await one("stock_levels", levelId);
  check(`stok ${levelId.slice(0, 8)} committed`, fresh.committed, held);
}

// ── 3. toplama dalgası ──────────────────────────────────────────────────────
console.log("\n3. toplama dalgası");
const wave = (
  await must("POST", "/api/items/pick_waves", {
    warehouse: whIst.id,
    status: "planned",
    assigned_to: "Hakan T.",
  })
).data;
console.log(`  dalga ${wave.wave_no}`);

let seq = 0;
const tasks: any[] = [];
for (const o of orders) {
  await must("PATCH", `/api/items/orders/${o.id}`, { status: "picking" });
  const lines = await list("order_lines", `?filter=${encodeURIComponent(JSON.stringify({ order: o.id }))}&limit=50`);
  for (const line of lines) {
    const lvl = levels.find((l: any) => l.product === line.product && bins.some((b: any) => b.id === l.bin && b.warehouse === whIst.id));
    if (!lvl) continue;
    tasks.push(
      (
        await must("POST", "/api/items/pick_tasks", {
          wave: wave.id,
          order: o.id,
          order_line: line.id,
          product: line.product,
          bin: lvl.bin,
          qty_required: line.qty,
          status: "pending",
          picker: "Hakan T.",
          sequence: ++seq,
        })
      ).data,
    );
  }
}
console.log(`  ${tasks.length} görev`);

await must("PATCH", `/api/items/pick_waves/${wave.id}`, { status: "released", released_at: Date.now() });
await must("PATCH", `/api/items/pick_waves/${wave.id}`, { status: "in_progress" });

console.log("\n   dalga sayaçları");
check("task_count", (await one("pick_waves", wave.id)).task_count, tasks.length);

// ── 4. toplama ──────────────────────────────────────────────────────────────
console.log("\n4. toplama");
const short = 0;
for (const t of tasks) {
  await must("PATCH", `/api/items/pick_tasks/${t.id}`, { status: "picking" });
  const picked = t.qty_required;
  await must("PATCH", `/api/items/pick_tasks/${t.id}`, {
    status: "picked",
    qty_picked: picked,
    picked_at: Date.now(),
  });
  // stok defterine düş, ve seviyeyi azalt
  await must("POST", "/api/items/stock_movements", {
    product: t.product,
    bin: t.bin,
    qty: -picked,
    reason: "pick",
    reference: (await one("pick_tasks", t.id)).order,
  });
  const lvl = levelFor(t.product, t.bin);
  if (lvl) {
    const fresh = await one("stock_levels", lvl.id);
    await must("PATCH", `/api/items/stock_levels/${lvl.id}`, { on_hand: fresh.on_hand - picked });
  }
  await must("PATCH", `/api/items/order_lines/${t.order_line}`, { qty_picked: picked });
}
console.log(`  ${tasks.length} görev toplandı (${short} eksik)`);

console.log("\n   toplanan adet dalgaya yansıdı mı");
const wave2 = await one("pick_waves", wave.id);
check("units_picked", wave2.units_picked, tasks.reduce((n, t) => n + t.qty_required, 0));

console.log("\n   rezervasyonlar tüketildi mi");
for (const r of reservations) await must("PATCH", `/api/items/stock_reservations/${r.id}`, { status: "consumed" });
for (const [levelId] of heldByLevel) {
  const fresh = await one("stock_levels", levelId);
  check(`stok ${levelId.slice(0, 8)} committed serbest`, fresh.committed, 0);
}

await must("PATCH", `/api/items/pick_waves/${wave.id}`, { status: "completed" });

// ── 5. paketleme ────────────────────────────────────────────────────────────
console.log("\n5. paketleme");
const packages: any[] = [];
for (const o of orders) {
  await must("PATCH", `/api/items/orders/${o.id}`, { status: "packed" });
  const lines = await list("order_lines", `?filter=${encodeURIComponent(JSON.stringify({ order: o.id }))}&limit=50`);
  let grams = 0;
  const pkg = (await must("POST", "/api/items/packages", { order: o.id, status: "open", packed_by: "Selin A." })).data;
  for (const line of lines) {
    const p = [...bySku.values()].find((x) => x.id === line.product);
    grams += (p?.weight_g ?? 0) * line.qty;
    await must("POST", "/api/items/package_lines", { package: pkg.id, product: line.product, qty: line.qty });
  }
  await must("PATCH", `/api/items/packages/${pkg.id}`, {
    weight_g: grams,
    length_cm: 40,
    width_cm: 30,
    height_cm: 25,
    packed_at: Date.now(),
  });
  await must("PATCH", `/api/items/packages/${pkg.id}`, { status: "sealed" });
  packages.push({ ...(await one("packages", pkg.id)), _order: o, _units: lines.reduce((n: number, l: any) => n + l.qty, 0) });
}
console.log(`  ${packages.length} koli`);

console.log("\n   koli içerik sayacı");
for (const p of packages) check(`${p.package_no} unit_count`, p.unit_count, p._units);

// ── 6. sevkiyat ─────────────────────────────────────────────────────────────
console.log("\n6. sevkiyat");
const shipments: any[] = [];
for (const [i, p] of packages.entries()) {
  const carrier = carriers[i % carriers.length];
  const o = p._order;
  const addr = await one("customer_addresses", o.shipping_address);
  const sh = (
    await must("POST", "/api/items/shipments", {
      order: o.id,
      package: p.id,
      carrier: carrier.id,
      service: o.priority === "ayni_gun" ? "ayni_gun" : o.priority === "hizli" ? "ekspres" : "standart",
      status: "created",
      recipient_name: addr.contact_name,
      recipient_phone: addr.phone ?? "0532 000 00 00",
      destination_city: addr.city,
      weight_g: p.weight_g,
      cost: { amount: 89.9, currency: "TRY" },
    })
  ).data;
  await must("PATCH", `/api/items/shipments/${sh.id}`, {
    tracking_no: `${carrier.code}${String(1_000_000 + i * 7717).padStart(9, "0")}`,
    status: "handed_over",
    dispatched_at: Date.now(),
  });
  await must("PATCH", `/api/items/packages/${p.id}`, { status: "handed_over" });
  await must("PATCH", `/api/items/orders/${o.id}`, { status: "shipped" });
  shipments.push(await one("shipments", sh.id));
}
console.log(`  ${shipments.length} sevkiyat`);

// ── 7. kargo hareketleri ────────────────────────────────────────────────────
console.log("\n7. kargo takibi");
const track: [string, string, string][] = [
  ["handed_over", "İstanbul Aktarma", "Gönderi kargo şubesine teslim edildi"],
  ["in_transit", "Gebze Transfer Merkezi", "Transfer merkezine ulaştı"],
  ["out_for_delivery", "Hedef şube", "Dağıtıma çıktı"],
];
for (const [i, sh] of shipments.entries()) {
  for (const [status, location, description] of track) {
    await must("POST", "/api/items/shipment_events", { shipment: sh.id, status, location, description });
    if (status !== "handed_over") await must("PATCH", `/api/items/shipments/${sh.id}`, { status });
  }
  // son ikisi hariç hepsi teslim edildi
  if (i < shipments.length - 2) {
    await must("POST", "/api/items/shipment_events", {
      shipment: sh.id,
      status: "delivered",
      location: "Alıcı adresi",
      description: "Alıcıya teslim edildi",
    });
    await must("PATCH", `/api/items/shipments/${sh.id}`, { status: "delivered", delivered_at: Date.now() });
    const o = packages[i]._order;
    await must("PATCH", `/api/items/orders/${o.id}`, { status: "delivered" });
  }
}

console.log("\n   hareket sayacı");
for (const sh of shipments) {
  const fresh = await one("shipments", sh.id);
  const events = await list("shipment_events", `?filter=${encodeURIComponent(JSON.stringify({ shipment: sh.id }))}&limit=50`);
  check(`${fresh.shipment_no} event_count`, fresh.event_count, events.length);
}

// ── 8. durum kuralları gerçekten uygulanıyor mu ─────────────────────────────
console.log("\n8. yasak geçişler reddediliyor mu");
const delivered = shipments.find((s) => s.status === "delivered") ?? shipments[0];
{
  const r = await api("PATCH", `/api/items/shipments/${delivered.id}`, { status: "created" });
  check("teslim → oluşturuldu reddedildi", r.status, 422);
}
{
  const o = orders[0];
  const r = await api("PATCH", `/api/items/orders/${o.id}`, { status: "new" });
  check("teslim → yeni reddedildi", r.status, 422);
}
{
  const p = bySku.get("KHV-0001");
  const b = bins.find((x: any) => x.code === "A-01-01" && x.warehouse === whIst.id);
  const r = await api("POST", "/api/items/stock_levels", { product: p.id, bin: b.id, on_hand: 5 });
  check("aynı ürün+raf için ikinci seviye reddedildi", r.status, 409);
}

// ── özet ────────────────────────────────────────────────────────────────────
console.log(`\n${checks - problems.length}/${checks} kontrol geçti`);
if (problems.length) {
  console.log("\nSORUNLAR:");
  for (const p of problems) console.log(`  • ${p}`);
}
