/**
 * Seed the fulfillment workspace with a plausible day of operation.
 *
 *   BACKLEX_API_KEY=pak_… bun examples/fulfillment-ops/scripts/seed.ts
 *
 * Reference data only — warehouses, racking, catalogue, customers, carriers,
 * campaigns and opening stock. The ORDER lifecycle (reserve → pick → pack →
 * ship) is driven by `operate.ts`, so a failure there is a failure of the
 * process and not of the fixtures.
 */

import { must } from "./api";

const log = (s: string) => console.log(s);
const id = (r: any) => r.data.id as string;

const DAY = 86_400_000;
const now = Date.now();

// ── depo ────────────────────────────────────────────────────────────────────
log("depo");
const whIst = id(
  await must("POST", "/api/items/warehouses", {
    code: "IST-1",
    name: "İstanbul Ana Depo",
    city: "İstanbul",
    address: "Orhanlı Mah. Gebze Yolu No:12, Tuzla",
    cutoff_time: "17:00",
    active: true,
  }),
);
const whIzm = id(
  await must("POST", "/api/items/warehouses", {
    code: "IZM-1",
    name: "İzmir Bölge Depo",
    city: "İzmir",
    address: "Atatürk Organize Sanayi Bölgesi, Çiğli",
    cutoff_time: "16:00",
    active: true,
  }),
);

const zones: Record<string, string> = {};
for (const [wh, code, name, kind] of [
  [whIst, "A", "Hızlı devir", "picking"],
  [whIst, "B", "Toplu stok", "bulk"],
  [whIst, "S", "Sevk alanı", "shipping"],
  [whIzm, "A", "Hızlı devir", "picking"],
] as const) {
  zones[`${wh}:${code}`] = id(
    await must("POST", "/api/items/zones", { warehouse: wh, code, name, kind }),
  );
}

const bins: Record<string, string> = {};
const binPlan: [string, string, string, number][] = [
  [whIst, "A", "A-01-01", 240],
  [whIst, "A", "A-01-02", 240],
  [whIst, "A", "A-02-01", 240],
  [whIst, "A", "A-02-02", 240],
  [whIst, "B", "B-01-01", 1200],
  [whIst, "S", "S-01", 0],
  [whIzm, "A", "A-01-01", 180],
  [whIzm, "A", "A-01-02", 180],
];
for (const [wh, zone, code, cap] of binPlan) {
  bins[code + (wh === whIzm ? "@izm" : "")] = id(
    await must("POST", "/api/items/bins", {
      warehouse: wh,
      zone: zones[`${wh}:${zone}`],
      code,
      capacity_units: cap,
      active: true,
    }),
  );
}
log(`  ${Object.keys(bins).length} raf`);

// ── katalog ─────────────────────────────────────────────────────────────────
log("katalog");
const productPlan: [string, string, string, string, number, number, number][] = [
  ["KHV-0001", "8680001000017", "Filtre Kahve 250g", "gida", 189.9, 250, 900],
  ["KHV-0002", "8680001000024", "Espresso Çekirdek 1kg", "gida", 649.0, 1000, 2400],
  ["CAY-0001", "8680001000031", "Earl Grey Poşet Çay 100'lü", "gida", 129.5, 200, 1100],
  ["KZM-0001", "8680002000016", "Nemlendirici Krem 50ml", "kozmetik", 349.0, 120, 300],
  ["KZM-0002", "8680002000023", "Güneş Koruyucu SPF50 100ml", "kozmetik", 529.0, 150, 380],
  ["ELK-0001", "8680003000015", "Kablosuz Kulaklık", "elektronik", 2_499.0, 220, 900],
  ["ELK-0002", "8680003000022", "Taşınabilir Şarj 20000mAh", "elektronik", 1_199.0, 420, 700],
  ["TKS-0001", "8680004000014", "Pamuklu T-Shirt L", "tekstil", 399.0, 180, 1600],
  ["EVY-0001", "8680005000013", "Seramik Kupa 350ml", "ev", 189.0, 380, 1400],
  ["EVY-0002", "8680005000020", "Bambu Kesme Tahtası", "ev", 449.0, 900, 3200],
];
const products: Record<string, string> = {};
for (const [sku, barcode, name, category, price, weight, volume] of productPlan) {
  products[sku] = id(
    await must("POST", "/api/items/products", {
      sku,
      barcode,
      name,
      category,
      list_price: { amount: price, currency: "TRY" },
      weight_g: weight,
      volume_cm3: volume,
      description: `${name} — ${category} kategorisi.`,
      active: true,
    }),
  );
}
log(`  ${Object.keys(products).length} ürün`);

// ── açılış stoğu ────────────────────────────────────────────────────────────
log("açılış stoğu");
const levels: Record<string, string> = {};
const stockPlan: [string, string, number, number][] = [
  ["KHV-0001", "A-01-01", 180, 40],
  ["KHV-0002", "A-01-02", 90, 20],
  ["CAY-0001", "A-02-01", 240, 60],
  ["KZM-0001", "A-02-02", 120, 30],
  ["KZM-0002", "A-02-02", 75, 25],
  ["ELK-0001", "B-01-01", 48, 12],
  ["ELK-0002", "B-01-01", 96, 24],
  ["TKS-0001", "A-01-01", 160, 40],
  ["EVY-0001", "A-02-01", 300, 60],
  ["EVY-0002", "B-01-01", 140, 30],
  ["KHV-0001", "A-01-01@izm", 60, 20],
  ["ELK-0001", "A-01-02@izm", 24, 6],
];
for (const [sku, bin, qty, min] of stockPlan) {
  const key = `${sku}@${bin}`;
  levels[key] = id(
    await must("POST", "/api/items/stock_levels", {
      product: products[sku],
      bin: bins[bin],
      on_hand: qty,
      min_qty: min,
      reorder_point: min * 2,
      counted_at: now - 3 * DAY,
    }),
  );
  await must("POST", "/api/items/stock_movements", {
    product: products[sku],
    bin: bins[bin],
    qty,
    reason: "receipt",
    reference: "ACILIŞ-2026",
  });
}
log(`  ${Object.keys(levels).length} stok seviyesi`);

// ── müşteriler ──────────────────────────────────────────────────────────────
log("müşteriler");
const customerPlan: [string, string, string, string, string, string, string][] = [
  ["Ayşe Yıldırım", "bireysel", "altin", "ayse.yildirim@example.com", "0532 411 22 33", "", ""],
  ["Mehmet Demir", "bireysel", "standart", "mehmet.demir@example.com", "0505 118 47 90", "", ""],
  ["Kuzey Gıda Ltd. Şti.", "kurumsal", "platin", "satinalma@kuzeygida.example", "0212 555 84 20", "Şişli", "1234567890"],
  ["Ege Market A.Ş.", "kurumsal", "gumus", "tedarik@egemarket.example", "0232 447 19 05", "Bornova", "9876543210"],
  ["Zeynep Kaya", "bireysel", "standart", "zeynep.kaya@example.com", "0555 903 66 12", "", ""],
];
const customers: Record<string, string> = {};
const addresses: Record<string, string> = {};
for (const [name, kind, segment, email, phone, taxOffice, taxNo] of customerPlan) {
  const body: Record<string, unknown> = {
    name,
    kind,
    segment,
    email,
    phone,
    active: true,
    credit_limit: { amount: kind === "kurumsal" ? 250_000 : 10_000, currency: "TRY" },
  };
  if (kind === "kurumsal") {
    body.tax_office = taxOffice;
    body.tax_no = taxNo;
  }
  customers[name] = id(await must("POST", "/api/items/customers", body));
}

const addressPlan: [string, string, string, string, string, string][] = [
  ["Ayşe Yıldırım", "Ev", "Bağdat Cad. No:214 D:5", "Kadıköy", "İstanbul", "34728"],
  ["Mehmet Demir", "Ev", "Cumhuriyet Mah. 1421 Sk. No:8", "Karşıyaka", "İzmir", "35530"],
  ["Kuzey Gıda Ltd. Şti.", "Merkez depo", "Halaskargazi Cad. No:112 Kat:3", "Şişli", "İstanbul", "34371"],
  ["Ege Market A.Ş.", "Mağaza", "Kazımdirik Mah. Ankara Cad. No:44", "Bornova", "İzmir", "35100"],
  ["Zeynep Kaya", "İş", "Kızılırmak Mah. Dumlupınar Blv. No:9", "Çankaya", "Ankara", "06510"],
];
for (const [who, label, line1, district, city, postcode] of addressPlan) {
  addresses[who] = id(
    await must("POST", "/api/items/customer_addresses", {
      customer: customers[who],
      label,
      contact_name: who,
      line1,
      district,
      city,
      postcode,
      country: "TR",
      is_default: true,
    }),
  );
}
log(`  ${Object.keys(customers).length} müşteri`);

// ── kargo firmaları ─────────────────────────────────────────────────────────
log("kargo");
const carriers: Record<string, string> = {};
for (const [code, name, url, phone, cutoff] of [
  ["YRT", "Yurtiçi Kargo", "https://kargotakip.example/yurtici/{{tracking_no}}", "0850 755 05 05", "18:00"],
  ["ARS", "Aras Kargo", "https://kargotakip.example/aras/{{tracking_no}}", "0850 810 22 55", "17:30"],
  ["MNG", "MNG Kargo", "https://kargotakip.example/mng/{{tracking_no}}", "0850 222 06 06", "17:00"],
] as const) {
  carriers[code] = id(
    await must("POST", "/api/items/carriers", {
      code,
      name,
      tracking_url_template: url,
      support_phone: phone,
      cutoff_time: cutoff,
      active: true,
    }),
  );
}

// ── kampanyalar ─────────────────────────────────────────────────────────────
log("kampanyalar");
const campaigns: Record<string, string> = {};
campaigns.bahar = id(
  await must("POST", "/api/items/campaigns", {
    name: "Bahar İndirimi",
    code: "BAHAR15",
    kind: "percent",
    percent_off: 15,
    min_basket: { amount: 500, currency: "TRY" },
    starts_at: now - 5 * DAY,
    ends_at: now + 25 * DAY,
    budget: { amount: 50_000, currency: "TRY" },
    usage_limit: 500,
    channel: "web",
    status: "draft",
  }),
);
campaigns.kargo = id(
  await must("POST", "/api/items/campaigns", {
    name: "500 TL Üzeri Kargo Bedava",
    code: "KARGOBEDAVA",
    kind: "free_shipping",
    min_basket: { amount: 500, currency: "TRY" },
    starts_at: now - 20 * DAY,
    ends_at: now + 40 * DAY,
    budget: { amount: 25_000, currency: "TRY" },
    channel: "hepsi",
    status: "draft",
  }),
);
campaigns.kahve = id(
  await must("POST", "/api/items/campaigns", {
    name: "Kahve Günleri — 100 TL",
    code: "KAHVE100",
    kind: "amount",
    amount_off: { amount: 100, currency: "TRY" },
    min_basket: { amount: 600, currency: "TRY" },
    starts_at: now - 2 * DAY,
    ends_at: now + 12 * DAY,
    budget: { amount: 20_000, currency: "TRY" },
    usage_limit: 200,
    channel: "web",
    status: "draft",
  }),
);
for (const sku of ["KHV-0001", "KHV-0002"]) {
  await must("POST", "/api/items/campaign_products", {
    campaign: campaigns.kahve,
    product: products[sku],
  });
}

// draft → scheduled → active, one legal edge at a time.
for (const c of Object.values(campaigns)) {
  await must("PATCH", `/api/items/campaigns/${c}`, { status: "scheduled" });
  await must("PATCH", `/api/items/campaigns/${c}`, { status: "active" });
}
log(`  ${Object.keys(campaigns).length} kampanya yayında`);

console.log(
  JSON.stringify(
    { warehouses: { whIst, whIzm }, zones, bins, products, levels, customers, addresses, carriers, campaigns },
    null,
    0,
  ),
);
