/**
 * Provision the fulfillment schema against a running backlex.
 *
 *   bun examples/fulfillment-ops/scripts/provision.ts \
 *     --url http://localhost:5173 --tenant sevkiyat --cookie <file>
 *
 * Two passes, because the model has genuine cycles: `order_lines` points at
 * `orders` with a relation, and `orders` points back at `order_lines` with a
 * rollup. Nothing can be created that names a collection that does not exist
 * yet, so pass 1 creates every collection with the forward-pointing fields
 * removed and pass 2 PATCHes them back in.
 */

import { COLLECTIONS } from "./schema";

type Json = Record<string, unknown>;

const arg = (flag: string, fallback?: string) => {
  const i = process.argv.indexOf(flag);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (v === undefined && fallback === undefined) throw new Error(`missing ${flag}`);
  return v ?? (fallback as string);
};

const url = arg("--url", "http://localhost:5173").replace(/\/$/, "");
const tenant = arg("--tenant", "sevkiyat");
const cookieFile = arg("--cookie", "");
const apiKey = process.env.BACKLEX_API_KEY ?? "";

let cookieHeader = "";
if (cookieFile) {
  const text = await Bun.file(cookieFile).text();
  // `#HttpOnly_` is a PREFIX on a real cookie line, not a comment — and the
  // session cookie is the one that carries it, so filtering every `#` line
  // silently yields an empty jar and every later call is a 401.
  cookieHeader = text
    .split("\n")
    .map((l) => (l.startsWith("#HttpOnly_") ? l.slice("#HttpOnly_".length) : l))
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => l.split("\t"))
    .filter((p) => p.length >= 7)
    .map((p) => `${p[5]}=${p[6]}`)
    .join("; ");
  if (!cookieHeader) throw new Error(`no cookies parsed out of ${cookieFile}`);
}

const headers: Record<string, string> = {
  "Content-Type": "application/json",
  Origin: url,
  "X-Backlex-Tenant": tenant,
};
if (cookieHeader) headers.Cookie = cookieHeader;
if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${url}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { ok: res.ok, status: res.status, json };
}

/**
 * Creation order. `schema.ts` is grouped by subject so it reads like the
 * domain; the database needs it ordered by dependency instead. With this
 * order every RELATION points at something already created, so the only
 * fields pass 1 has to hold back are rollups — and a rollup column is a
 * nullable integer, which is exactly what an additive ALTER can add later.
 */
const ORDER = [
  "warehouses",
  "zones",
  "bins",
  "products",
  "customers",
  "customer_addresses",
  "orders",
  "order_lines",
  "stock_levels",
  "stock_reservations",
  "stock_movements",
  "campaigns",
  "campaign_products",
  "campaign_redemptions",
  "pick_waves",
  "pick_tasks",
  "packages",
  "package_lines",
  "carriers",
  "shipments",
  "shipment_events",
];

const bySlug = new Map(COLLECTIONS.map((c) => [c.slug as string, c]));
const ordered = ORDER.map((s) => {
  const c = bySlug.get(s);
  if (!c) throw new Error(`ORDER names "${s}", which schema.ts does not define`);
  return c;
});
if (ordered.length !== COLLECTIONS.length) {
  const missing = COLLECTIONS.map((c) => c.slug as string).filter((s) => !ORDER.includes(s));
  throw new Error(`schema.ts defines collections ORDER does not place: ${missing.join(", ")}`);
}

const slugs = new Set(COLLECTIONS.map((c) => c.slug as string));

/** A field that names a collection later in the list — a relation to one, or a
 *  rollup reading from one. Stripped in pass 1, restored in pass 2. */
const namesLater = (f: Json, created: Set<string>) => {
  if (f.type === "relation" || f.type === "relation_many") {
    const to = f.to as string | undefined;
    if (to && slugs.has(to) && !created.has(to)) return true;
  }
  const rollup = f.rollup as { from?: string } | undefined;
  if (rollup?.from && !created.has(rollup.from)) return true;
  return false;
};

const existing = new Set<string>();
{
  const r = await api("GET", "/api/collections");
  // Checked rather than ignored: an unauthenticated read answers with no rows,
  // which is shaped exactly like an empty workspace — and then every create
  // below fails 401 one line at a time instead of once, up front.
  if (!r.ok) throw new Error(`GET /api/collections → ${r.status} ${JSON.stringify(r.json)}`);
  for (const c of (r.json as { data: { slug: string }[] }).data) existing.add(c.slug);
}

const created = new Set<string>(existing);
const deferred: { slug: string; full: Json }[] = [];
let failures = 0;

console.log(`→ ${url}  workspace=${tenant}  (${existing.size} collection(s) already there)`);

// ── pass 1 — create ────────────────────────────────────────────────────────
for (const def of ordered) {
  const slug = def.slug as string;
  const fields = def.fields as Json[];
  const keep = fields.filter((f) => !namesLater(f, created));
  const heldBack = fields.length - keep.length;

  if (existing.has(slug)) {
    console.log(`  · ${slug} — already exists, will patch`);
    deferred.push({ slug, full: def });
    continue;
  }

  const r = await api("POST", "/api/collections", { ...def, fields: keep });
  if (!r.ok) {
    failures++;
    console.log(`  ✗ ${slug} — ${r.status} ${JSON.stringify(r.json).slice(0, 400)}`);
    continue;
  }
  created.add(slug);
  console.log(`  ✓ ${slug}${heldBack ? `  (${heldBack} field(s) deferred)` : ""}`);
  if (heldBack) deferred.push({ slug, full: def });
}

// ── pass 2 — patch the deferred fields back in ─────────────────────────────
if (deferred.length) console.log(`\n→ pass 2: restoring deferred fields on ${deferred.length} collection(s)`);
for (const { slug, full } of deferred) {
  const r = await api("PATCH", `/api/collections/${slug}`, { fields: full.fields });
  if (!r.ok) {
    failures++;
    console.log(`  ✗ ${slug} — ${r.status} ${JSON.stringify(r.json).slice(0, 400)}`);
  } else {
    console.log(`  ✓ ${slug}`);
  }
}

console.log(failures ? `\n${failures} failure(s).` : "\nSchema provisioned.");
process.exit(failures ? 1 : 0);
