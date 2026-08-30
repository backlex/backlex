/**
 * Isolate the dotted/dotless I in full-text search.
 *
 * Turkish has four I's: i/İ (dotted) and ı/I (dotless). `String#toLowerCase()`
 * without a locale maps `İ` (U+0130) to `i` + COMBINING DOT ABOVE (U+0307) —
 * two code points — so the folded query no longer equals the folded document.
 */

import { api, must } from "./api";

const hits = async (q: string) => {
  const r = await api("POST", "/api/items/products/search", { q, mode: "fts", limit: 10 });
  return r.ok ? (r.json.data as any[]).map((p) => p.sku) : [`ERR ${r.status}`];
};

const cp = (s: string) => [...s].map((c) => `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`).join(" ");

// Ürünü kesin bir adla yerleştir, sonra o adın Türkçe büyük hâlini ara.
const sku = "TR-I-PROBE";
const existing = (await must("GET", `/api/items/products?filter=${encodeURIComponent(JSON.stringify({ sku }))}`)).data[0];
const id =
  existing?.id ??
  (
    await must("POST", "/api/items/products", {
      sku,
      name: "İstanbul Filtre Kahve",
      description: "İzmir ve İstanbul için ışıl ışıl bir kahve.",
      category: "gida",
      list_price: { amount: 1, currency: "TRY" },
      active: true,
    })
  ).data.id;

console.log('ürün adı: "İstanbul Filtre Kahve"\n');

const cases: [string, string][] = [
  ["istanbul", "küçük harf, ASCII i"],
  ["İstanbul", "yazıldığı hâli (dotted İ)"],
  ["İSTANBUL", "Türkçe büyük hâli (dotted İ)"],
  ["ISTANBUL", "ASCII büyük hâli (dotless I)"],
  ["filtre", "küçük"],
  ["FİLTRE", "Türkçe büyük (İ)"],
  ["FILTRE", "ASCII büyük (I)"],
  ["ışıl", "dotless ı"],
  ["IŞIL", "Türkçe büyük hâli (dotless ı → I)"],
];

for (const [q, note] of cases) {
  const h = await hits(q);
  const found = h.includes(sku);
  console.log(`  ${found ? "✓" : "✗"} "${q}"  (${note})  → ${h.length ? h.join(",") : "boş"}`);
}

console.log("\nJavaScript'in kendi katlaması:");
for (const s of ["İ", "I", "ı", "i"]) {
  console.log(
    `  "${s}" ${cp(s)}  toLowerCase()="${s.toLowerCase()}" ${cp(s.toLowerCase())}  ` +
      `toLocaleLowerCase("tr")="${s.toLocaleLowerCase("tr")}" ${cp(s.toLocaleLowerCase("tr"))}`,
  );
}

console.log(`\n"İSTANBUL".toLowerCase() === "istanbul" ? ${"İSTANBUL".toLowerCase() === "istanbul"}`);
console.log(`"İSTANBUL".toLocaleLowerCase("tr") === "istanbul" ? ${"İSTANBUL".toLocaleLowerCase("tr") === "istanbul"}`);

await api("DELETE", `/api/items/products/${id}`);
