/**
 * Edge probes — the things a warehouse app actually hits on a bad day.
 *
 *   BACKLEX_API_KEY=pak_… bun examples/fulfillment-ops/scripts/probe.ts
 *
 * Each probe prints what it sent, what came back, and whether that is the
 * answer the model promises. Nothing is asserted by eye: a probe that expects a
 * refusal fails loudly when it gets a 200.
 */

import { api, must } from "./api";

const results: { id: string; verdict: "ok" | "SUSPECT"; note: string }[] = [];
const say = (id: string, verdict: "ok" | "SUSPECT", note: string) => {
  results.push({ id, verdict, note });
  console.log(`${verdict === "ok" ? "  ✓" : "  ⚠"} ${id} — ${note}`);
};

const list = async (slug: string, qs = "") => (await must("GET", `/api/items/${slug}${qs}`)).data;
const one = async (slug: string, id: string) => (await must("GET", `/api/items/${slug}/${id}`)).data;
const filt = (o: unknown) => `filter=${encodeURIComponent(JSON.stringify(o))}`;
const short = (r: { status: number; json: any }) =>
  `${r.status} ${JSON.stringify(r.json?.error?.message ?? r.json).slice(0, 160)}`;

const products = await list("products", "?limit=50");
const levels = await list("stock_levels", "?limit=50");
const orders = await list("orders", "?limit=50");
const carriers = await list("carriers", "?limit=10");
const campaigns = await list("campaigns", "?limit=10");
const warehouses = await list("warehouses", "?limit=10");
const customers = await list("customers", "?limit=50");

// ─────────────────────────────────────────────────────────────────────────────
console.log("\nA. stok bütünlüğü");

// A1 — eldekinden fazlasını rezerve etmek
{
  const lvl = levels.reduce((a: any, b: any) => (a.on_hand < b.on_hand ? a : b));
  const line = (await list("order_lines", "?limit=1"))[0];
  const r = await api("POST", "/api/items/stock_reservations", {
    level: lvl.id,
    order_line: line.id,
    qty: lvl.on_hand + 10_000,
    status: "held",
  });
  if (r.ok) {
    const after = await one("stock_levels", lvl.id);
    say(
      "A1",
      "SUSPECT",
      `eldeki ${lvl.on_hand} iken ${lvl.on_hand + 10_000} rezerve edildi (201). committed=${after.committed} → available=${after.on_hand - after.committed}`,
    );
    await api("DELETE", `/api/items/stock_reservations/${r.json.data.id}`);
  } else say("A1", "ok", `aşırı rezervasyon reddedildi: ${short(r)}`);
}

// A2 — eldeki stoğu eksiye çekmek
{
  const lvl = levels[0];
  const r = await api("PATCH", `/api/items/stock_levels/${lvl.id}`, { on_hand: -5 });
  if (r.ok) say("A2", "SUSPECT", `on_hand -5 kabul edildi`);
  else say("A2", "ok", `negatif eldeki reddedildi: ${short(r)}`);
}

// A3 — bir raf başka bir deponun bölgesine bağlanabiliyor mu
{
  const izm = warehouses.find((w: any) => w.code === "IZM-1");
  const istZone = (await list("zones", `?${filt({ warehouse: warehouses.find((w: any) => w.code === "IST-1").id })}&limit=5`))[0];
  const r = await api("POST", "/api/items/bins", {
    warehouse: izm.id,
    zone: istZone.id,
    code: "X-CROSS-01",
    active: true,
  });
  if (r.ok) {
    say("A3", "SUSPECT", `İzmir deposundaki raf İstanbul bölgesine bağlandı (201) — depo/bölge çapraz bağı engellenmiyor`);
    await api("DELETE", `/api/items/bins/${r.json.data.id}`);
  } else say("A3", "ok", `çapraz depo/bölge reddedildi: ${short(r)}`);
}

// A4 — stok seviyesi, ürünün olmadığı bir depoya
{
  const lvl = levels[0];
  const r = await api("POST", "/api/items/stock_levels", { product: lvl.product, bin: lvl.bin, on_hand: 1 });
  say(r.ok ? "A4" : "A4", r.ok ? "SUSPECT" : "ok", r.ok ? "aynı ürün+raf ikinci kez kabul edildi" : `tekrar reddedildi: ${short(r)}`);
  if (r.ok) await api("DELETE", `/api/items/stock_levels/${r.json.data.id}`);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\nB. durum yaşam döngüsü");

// B1 — `requires` gerçekten zorunlu mu (tracking_no olmadan kargoya verme)
{
  const sh = (
    await must("POST", "/api/items/shipments", {
      order: orders[0].id,
      carrier: carriers[0].id,
      service: "standart",
      status: "created",
      destination_city: "Test",
    })
  ).data;
  const r = await api("PATCH", `/api/items/shipments/${sh.id}`, { status: "handed_over" });
  if (r.ok) say("B1", "SUSPECT", `takip no olmadan kargoya verildi (200) — requires:["tracking_no"] uygulanmadı`);
  else say("B1", "ok", `takip no olmadan geçiş reddedildi: ${short(r)}`);
  await api("DELETE", `/api/items/shipments/${sh.id}`, undefined);
}

// B2 — yeni satır izinsiz bir başlangıç durumuyla oluşturulabiliyor mu
{
  const r = await api("POST", "/api/items/shipments", {
    order: orders[0].id,
    carrier: carriers[0].id,
    service: "standart",
    status: "delivered",
    destination_city: "Test",
  });
  if (r.ok) {
    say("B2", "SUSPECT", `yeni sevkiyat doğrudan "delivered" olarak açıldı — initial:["created"] uygulanmadı`);
    await api("DELETE", `/api/items/shipments/${r.json.data.id}`);
  } else say("B2", "ok", `izinsiz başlangıç durumu reddedildi: ${short(r)}`);
}

// B3 — iptal edilen sipariş yine de toplanabiliyor mu
{
  const o = (
    await must("POST", "/api/items/orders", {
      customer: customers[0].id,
      shipping_address: (await list("customer_addresses", `?${filt({ customer: customers[0].id })}&limit=1`))[0].id,
      warehouse: warehouses[0].id,
      channel: "web",
      priority: "standart",
      status: "new",
    })
  ).data;
  await must("PATCH", `/api/items/orders/${o.id}`, { status: "cancelled" });
  const r = await api("PATCH", `/api/items/orders/${o.id}`, { status: "picking" });
  if (r.ok) say("B3", "SUSPECT", `iptal edilmiş sipariş toplamaya alındı`);
  else say("B3", "ok", `iptalden çıkış reddedildi: ${short(r)}`);
  await api("DELETE", `/api/items/orders/${o.id}`);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\nC. kampanya kuralları");

// C1 — bitiş tarihi başlangıçtan önce
{
  const r = await api("POST", "/api/items/campaigns", {
    name: "Ters tarihli",
    kind: "percent",
    percent_off: 10,
    starts_at: Date.now(),
    ends_at: Date.now() - 86_400_000,
    status: "draft",
  });
  if (r.ok) {
    say("C1", "SUSPECT", `bitişi başlangıcından ÖNCE olan kampanya kabul edildi — range.ordered uygulanmadı`);
    await api("DELETE", `/api/items/campaigns/${r.json.data.id}`);
  } else say("C1", "ok", `ters tarih aralığı reddedildi: ${short(r)}`);
}

// C2 — yüzde indirim 100'ün üstünde
{
  const r = await api("POST", "/api/items/campaigns", {
    name: "Aşırı indirim",
    kind: "percent",
    percent_off: 250,
    starts_at: Date.now(),
    ends_at: Date.now() + 86_400_000,
    status: "draft",
  });
  if (r.ok) {
    say("C2", "SUSPECT", `%250 indirim kabul edildi`);
    await api("DELETE", `/api/items/campaigns/${r.json.data.id}`);
  } else say("C2", "ok", `%250 reddedildi: ${short(r)}`);
}

// C3 — `kind: percent` ama percent_off boş (conditions.required)
{
  const r = await api("POST", "/api/items/campaigns", {
    name: "Oransız yüzde",
    kind: "percent",
    starts_at: Date.now(),
    ends_at: Date.now() + 86_400_000,
    status: "draft",
  });
  if (r.ok) {
    say("C3", "SUSPECT", `kind=percent iken percent_off boş bırakılabildi — koşullu zorunluluk uygulanmadı`);
    await api("DELETE", `/api/items/campaigns/${r.json.data.id}`);
  } else say("C3", "ok", `koşullu zorunlu alan uygulandı: ${short(r)}`);
}

// C4 — bütçesi aşan kullanım
{
  const c = campaigns.find((x: any) => x.code === "KAHVE100");
  const fresh = await one("campaigns", c.id);
  say(
    "C4",
    "ok",
    `bütçe ${fresh.budget?.amount} / harcanan ${fresh.spent?.amount ?? 0} — aşım kontrolü uygulama katmanında (şema kuralı yok, beklenen)`,
  );
}

// C5 — kurumsal müşteride vergi no zorunlu mu
{
  const r = await api("POST", "/api/items/customers", { name: "Vergisiz Kurumsal", kind: "kurumsal" });
  if (r.ok) {
    say("C5", "SUSPECT", `kurumsal müşteri vergi no/dairesi olmadan kaydedildi — conditions.required uygulanmadı`);
    await api("DELETE", `/api/items/customers/${r.json.data.id}`);
  } else say("C5", "ok", `koşullu zorunluluk uygulandı: ${short(r)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\nD. emeklilik ve referanslar");

// D1 — üzerinde raf olan bir depo pasife çekilebiliyor mu
{
  const wh = warehouses.find((w: any) => w.code === "IST-1");
  const r = await api("PATCH", `/api/items/warehouses/${wh.id}`, { active: false });
  if (r.ok) {
    const stillRefd = (await list("bins", `?${filt({ warehouse: wh.id })}&limit=1`)).length;
    say("D1", "SUSPECT", `${stillRefd}+ raf bağlıyken depo pasife çekildi — retire.references:"block" uygulanmadı`);
    await must("PATCH", `/api/items/warehouses/${wh.id}`, { active: true });
  } else say("D1", "ok", `referanslı depo emekliye ayrılamadı: ${short(r)}`);
}

// D2 — pasif ürün yeni bir siparişe eklenebiliyor mu
{
  const p = products[0];
  await must("PATCH", `/api/items/products/${p.id}`, { active: false });
  const r = await api("POST", "/api/items/order_lines", {
    order: orders[0].id,
    product: p.id,
    qty: 1,
    unit_price: { amount: 1, currency: "TRY" },
    line_total: { amount: 1, currency: "TRY" },
  });
  if (r.ok) {
    say("D2", "SUSPECT", `satıştan kaldırılmış ürün yeni sipariş satırına eklendi`);
    await api("DELETE", `/api/items/order_lines/${r.json.data.id}`);
  } else say("D2", "ok", `pasif ürün referansı reddedildi: ${short(r)}`);
  await must("PATCH", `/api/items/products/${p.id}`, { active: true });
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\nE. sorgu yüzeyi");

// E1 — para toplamı
{
  const r = await api("GET", `/api/items/orders/aggregate?${new URLSearchParams({ aggregate: JSON.stringify({ sum: ["grand_total"], count: ["id"] }) })}`);
  say(r.ok ? "E1" : "E1", r.ok ? "ok" : "SUSPECT", `sipariş toplamı: ${JSON.stringify(r.json).slice(0, 200)}`);
}

// E2 — tam metin arama
{
  const r = await api("GET", "/api/items/products/search?q=kahve&limit=5");
  const n = r.ok ? r.json.data?.length : -1;
  say(r.ok && n > 0 ? "E2" : "E2", r.ok && n > 0 ? "ok" : "SUSPECT", `"kahve" araması ${n} sonuç: ${JSON.stringify(r.json).slice(0, 200)}`);
}

// E3 — ilişki üzerinden filtre (tek atlama)
{
  const r = await api("GET", `/api/items/order_lines?${filt({ "order.status": { _eq: "delivered" } })}&limit=5`);
  say(r.ok ? "E3" : "E3", r.ok ? "ok" : "SUSPECT", `ilişki filtresi: ${r.ok ? `${r.json.data.length} satır` : short(r)}`);
}

// E4 — bilinmeyen sıralama alanı reddediliyor mu
{
  const r = await api("GET", "/api/items/orders?sort=-yok_boyle_alan&limit=1");
  say(r.ok ? "E4" : "E4", r.ok ? "SUSPECT" : "ok", r.ok ? `bilinmeyen sıralama alanı sessizce yok sayıldı` : `reddedildi: ${short(r)}`);
}

// E5 — bilinmeyen filtre alanı
{
  const r = await api("GET", `/api/items/orders?${filt({ yok_boyle_alan: "x" })}&limit=1`);
  say(r.ok ? "E5" : "E5", r.ok ? "SUSPECT" : "ok", r.ok ? `bilinmeyen filtre alanı sessizce yok sayıldı (${r.json.data.length} satır döndü)` : `reddedildi: ${short(r)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${results.filter((r) => r.verdict === "SUSPECT").length} şüpheli / ${results.length} problem`);
for (const r of results.filter((x) => x.verdict === "SUSPECT")) console.log(`  ⚠ ${r.id}: ${r.note}`);
