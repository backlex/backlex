/**
 * Turkish-locale probes.
 *
 * A Turkish deployment breaks in places an English one never touches: dotted /
 * dotless I, the five other diacritics, and alphabetical order that puts ç
 * after c rather than after z. Each of these fails SILENTLY — a search returns
 * nothing and looks like "no such product", a list looks sorted until you read
 * it.
 */

import { api, must } from "./api";

const out: string[] = [];
const search = async (q: string, mode = "fts") => {
  const r = await api("POST", "/api/items/products/search", { q, mode, limit: 10 });
  return r.ok ? (r.json.data as any[]).length : -1;
};

console.log("\nTR-1  büyük/küçük harf katlaması (arama)");
for (const [a, b] of [
  ["çay", "ÇAY"],
  ["poşet", "POŞET"],
  ["kesme", "KESME"],
  ["kahve", "KAHVE"],
  ["taşınabilir", "TAŞINABILIR"],
  ["güneş", "GÜNEŞ"],
]) {
  const na = await search(a);
  const nb = await search(b);
  const same = na === nb;
  console.log(`  ${same ? "✓" : "⚠"} "${a}"=${na}  "${b}"=${nb}${same ? "" : "  ← eşleşmiyor"}`);
  if (!same) out.push(`TR-1: "${a}" ${na} sonuç verirken "${b}" ${nb} verdi`);
}

console.log("\nTR-2  noktalı/noktasız I");
{
  // "Filtre" içindeki i; Türkçe'de "FİLTRE" büyük hâli, "FILTRE" değil.
  const lower = await search("filtre");
  const trUpper = await search("FİLTRE");
  const asciiUpper = await search("FILTRE");
  console.log(`  filtre=${lower}  FİLTRE=${trUpper}  FILTRE=${asciiUpper}`);
  if (lower !== trUpper) out.push(`TR-2: "filtre" ${lower} sonuç, Türkçe büyük hâli "FİLTRE" ${trUpper} sonuç`);
}

console.log("\nTR-3  aksansız arama (kullanıcı 'cay' yazar, ürün 'çay')");
{
  const withDia = await search("çay");
  const without = await search("cay");
  console.log(`  çay=${withDia}  cay=${without}`);
  if (without === 0 && withDia > 0)
    out.push(`TR-3: aksanı düşürülmüş arama eşleşmiyor — "cay" 0, "çay" ${withDia}`);
}

console.log("\nTR-4  alfabetik sıralama");
{
  const names = ["Çınar Lojistik", "Zeytin Dağıtım", "Işık Ticaret", "Adalar Gıda", "Öztürk A.Ş.", "Sarı Market", "Şahin Ltd."];
  const made: string[] = [];
  for (const name of names) {
    const r = await api("POST", "/api/items/customers", { name, kind: "bireysel" });
    if (r.ok) made.push(r.json.data.id);
  }
  const rows = (await must("GET", "/api/items/customers?sort=name&limit=100")).data as any[];
  const got = rows.map((c) => c.name).filter((n: string) => names.includes(n));
  const expected = [...names].sort((a, b) => a.localeCompare(b, "tr"));
  console.log(`  veritabanı: ${got.join(" < ")}`);
  console.log(`  tr-TR      : ${expected.join(" < ")}`);
  if (JSON.stringify(got) !== JSON.stringify(expected))
    out.push(`TR-4: sıralama Türkçe alfabeye uymuyor — Ç/Ğ/I/İ/Ö/Ş/Ü yanlış yerde`);
  for (const id of made) await api("DELETE", `/api/items/customers/${id}`);
}

console.log("\nTR-5  telefon: yerel biçimlerin hepsi kanonikleşiyor mu");
{
  const forms = ["0532 411 22 33", "+90 532 411 22 33", "(0532) 411-2233", "05324112233", "532 411 22 33", "90 532 411 22 33"];
  const seen: Record<string, string> = {};
  for (const f of forms) {
    const r = await api("POST", "/api/items/customers", { name: `Tel ${f}`, kind: "bireysel", phone: f });
    seen[f] = r.ok ? r.json.data.phone : `HATA ${r.status} ${JSON.stringify(r.json?.error?.message)}`;
    if (r.ok) await api("DELETE", `/api/items/customers/${r.json.data.id}`);
  }
  const values = Object.values(seen);
  const canonical = values.filter((v) => v === "+905324112233").length;
  for (const [f, v] of Object.entries(seen)) console.log(`  ${canonical === values.length ? "✓" : " "} "${f}" → ${v}`);
  if (canonical !== values.length)
    out.push(`TR-5: ${values.length - canonical}/${values.length} yerel telefon biçimi +905324112233'e katlanmadı`);
}

console.log("\nTR-6  para biçimi (kuruş yuvarlaması)");
{
  const p = (await must("GET", "/api/items/products?limit=1")).data[0];
  const r = await api("PATCH", `/api/items/products/${p.id}`, { list_price: { amount: 19.999, currency: "TRY" } });
  const back = r.ok ? (await must("GET", `/api/items/products/${p.id}`)).data.list_price : null;
  console.log(`  19.999 TRY yazıldı → ${JSON.stringify(back)}  (${r.status})`);
  if (r.ok && back?.amount === 19.99) out.push(`TR-6: 19.999 sessizce 19.99'a kırpıldı — kuruş altı bilgi kaybı bildirilmiyor`);
  await api("PATCH", `/api/items/products/${p.id}`, { list_price: p.list_price });
}

console.log(`\n${out.length} bulgu`);
for (const o of out) console.log(`  ⚠ ${o}`);
