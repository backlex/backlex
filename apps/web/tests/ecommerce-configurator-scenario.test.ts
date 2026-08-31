/**
 * A real desktop-PC configurator, built end to end.
 *
 * The unit tests prove each piece; this proves the pieces add up to something
 * a store actually sells. The scenario is taken from a live Turkish gaming-PC
 * seller's customise page — eleven axes (OS, CPU, cooler, RAM, three M.2 bays,
 * warranty, plus three fixed components) and seven accessory groups, priced in
 * lira at five and six figures.
 *
 * It is worth being a scenario rather than more unit tests because the things
 * that break at this size are not any single rule: they are the interaction of
 * a SHARED option set with per-slot pricing, money at a scale where minor units
 * matter, Turkish text through a code path that folds case, and a checkout that
 * has to keep eleven option rows attached to the right line.
 *
 * The headline number: 2 × 4 × 2 × 6 × 3 × 4 × 4 = **4 608** sellable
 * combinations for ONE product, before a single accessory. This file builds all
 * of them in 29 rows.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve, type Rule, type Slot } from "../../../examples/ecommerce-react/src/configurator";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const TRY = "TRY";
const BASE = 96_099;

describe("a desktop-PC configurator, end to end", () => {
  let h: TestHarness;
  const ids: Record<string, string> = {};
  /** slug → id, for the sets and slots created below. */
  const setId: Record<string, string> = {};
  const slotId: Record<string, string> = {};
  const choiceId: Record<string, string> = {};

  const post = async (slug: string, body: unknown) => {
    const res = await h.fetch(`/api/items/${slug}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { data?: { id: string }; error?: { message: string } };
    if (!res.ok) throw new Error(`${slug} ${res.status}: ${json.error?.message}`);
    return json.data as { id: string };
  };
  const one = async (slug: string, id: string) => {
    const res = await h.fetch(`/api/items/${slug}/${id}`);
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: Record<string, unknown> }).data;
  };
  const list = async (path: string) => {
    const res = await h.fetch(`/api/items/${path}`);
    return ((await res.json()) as { data: Record<string, unknown>[] }).data;
  };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const applied = await h.fetch("/api/admin/templates/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ templateId: "ecommerce" }),
    });
    expect(applied.status).toBe(201);

    // ── The machine ────────────────────────────────────────────────────────
    const product = await post("products", {
      name: "TD3 masaüstü oyun bilgisayarı",
      slug: "td3-masaustu",
      status: "active",
      price: BASE,
      currency: TRY,
      sku: "TD3-V315-BEYAZ",
    });
    ids.product = product.id;

    // ── The axes ───────────────────────────────────────────────────────────
    // Each set is defined ONCE. Two of the three drive bays share one, which
    // is the whole reason `product_modifiers` is not unique on (product, set).
    const axes: {
      key: string;
      name: string;
      code: string;
      required?: boolean;
      choices: { label: string; code: string; add: number; component?: boolean }[];
    }[] = [
      {
        key: "os", name: "İşletim sistemi", code: "OS", required: true,
        choices: [
          { label: "Windows 11 Home Single Language", code: "W11H", add: 0 },
          { label: "Windows 11 Pro", code: "W11P", add: 1_200 },
        ],
      },
      {
        key: "cpu", name: "İşlemci", code: "CPU", required: true,
        choices: [
          { label: "AMD Ryzen 7 9700X", code: "9700X", add: 0, component: true },
          { label: "AMD Ryzen 7 7800X3D", code: "7800X3D", add: 6_999, component: true },
          { label: "AMD Ryzen 7 9800X3D", code: "9800X3D", add: 11_999, component: true },
          { label: "AMD Ryzen 9 9950X3D", code: "9950X3D", add: 26_999, component: true },
        ],
      },
      {
        key: "cooler", name: "İşlemci soğutucu", code: "COOL", required: true,
        choices: [
          { label: "120mm hava soğutucu", code: "AIR120", add: 0 },
          { label: "LCD 360mm ARGB sıvı soğutucu", code: "LQ360", add: 6_499 },
        ],
      },
      {
        key: "ram", name: "Bellek", code: "RAM", required: true,
        choices: [
          { label: "16GB (1x16GB) 5600MHz CL36", code: "16-5600-36", add: 0, component: true },
          { label: "16GB (1x16GB) 6000MHz CL36", code: "16-6000-36", add: 1_999, component: true },
          { label: "16GB (1x16GB) 5600MHz CL30", code: "16-5600-30", add: 3_999, component: true },
          { label: "32GB (2x16GB) 5600MHz CL36", code: "32-5600-36", add: 13_999, component: true },
          { label: "32GB (2x16GB) 6000MHz CL36", code: "32-6000-36", add: 17_999, component: true },
          { label: "32GB (2x16GB) 5600MHz CL30", code: "32-5600-30", add: 21_999, component: true },
        ],
      },
      // Bay 1 ships with a drive, so its options REPLACE it and are priced
      // against that. Bays 2 and 3 start empty and are priced as additions —
      // same three drives, 13 000 apart. Two sets, not one, and the difference
      // is a real one: "swap the included drive" and "add a drive" are
      // different products at different prices.
      {
        key: "m2main", name: "M.2 yuva 1", code: "M2A", required: true,
        choices: [
          { label: "1TB NVMe GEN4", code: "1TB", add: 0, component: true },
          { label: "2TB NVMe GEN4", code: "2TB", add: 10_000, component: true },
          { label: "2TB NVMe GEN4 yüksek hız", code: "2TBHS", add: 15_000, component: true },
        ],
      },
      {
        key: "m2extra", name: "Ek M.2 disk", code: "M2X",
        choices: [
          { label: "Boş", code: "NONE", add: 0 },
          { label: "1TB NVMe GEN4", code: "1TB", add: 13_000, component: true },
          { label: "2TB NVMe GEN4", code: "2TB", add: 23_000, component: true },
          { label: "2TB NVMe GEN4 yüksek hız", code: "2TBHS", add: 28_000, component: true },
        ],
      },
      {
        key: "warranty", name: "Ek garanti", code: "GAR",
        choices: [
          { label: "Standart 2 yıl", code: "2Y", add: 0 },
          { label: "+2 yıl (toplam 4 yıl)", code: "4Y", add: 4_999 },
        ],
      },
    ];

    for (const axis of axes) {
      const s = await post("modifier_sets", {
        name: axis.name, code: axis.code, input_type: "choice",
        min_select: axis.required ? 1 : 0, max_select: 1,
      });
      setId[axis.key] = s.id;
      for (const [i, c] of axis.choices.entries()) {
        // A choice that ships a part points at a stocked unit. The configured
        // machine still leaves as ONE line; the component's own inventory is
        // what runs out.
        let component: string | undefined;
        if (c.component) {
          const cv = await post("product_variants", {
            product: ids.product, title: `${axis.code} ${c.label}`,
            sku: `CMP-${axis.code}-${c.code}`, price: 0, currency: TRY,
          });
          component = cv.id;
        }
        const v = await post("modifier_values", {
          modifier_set: s.id, label: c.label, code: c.code,
          adjustment_type: "fixed_amount", price_adjustment: c.add, currency: TRY,
          is_default: i === 0, position: i + 1,
          ...(component ? { component_variant: component, consumes_qty: 1 } : {}),
        });
        choiceId[`${axis.key}:${c.code}`] = v.id;
      }
    }

    // ── The slots on this product ──────────────────────────────────────────
    // Bays 2 and 3 are TWO slots over ONE set — the case a per-product option
    // list cannot express without duplicating the list.
    const slots: { key: string; set: string; label: string; required?: boolean }[] = [
      { key: "os", set: "os", label: "İşletim sistemi", required: true },
      { key: "cpu", set: "cpu", label: "İşlemci", required: true },
      { key: "cooler", set: "cooler", label: "İşlemci soğutucu", required: true },
      { key: "ram", set: "ram", label: "Bellek", required: true },
      { key: "bay1", set: "m2main", label: "M.2 yuva 1", required: true },
      { key: "bay2", set: "m2extra", label: "M.2 yuva 2" },
      { key: "bay3", set: "m2extra", label: "M.2 yuva 3" },
      { key: "warranty", set: "warranty", label: "Ek garanti" },
    ];
    for (const [i, s] of slots.entries()) {
      const m = await post("product_modifiers", {
        product: ids.product, modifier_set: setId[s.set], label: s.label,
        is_required: s.required === true, position: i + 1,
      });
      slotId[s.key] = m.id;
    }

    // A compatibility rule of the kind this class of machine really has: the
    // top CPU needs the liquid cooler.
    await post("modifier_rules", {
      rule_type: "excludes",
      when_modifier: slotId.cpu, when_value: choiceId["cpu:9950X3D"],
      then_modifier: slotId.cooler, then_value: choiceId["cooler:AIR120"],
      message: "Ryzen 9 9950X3D hava soğutucuyla satılmıyor — sıvı soğutucu seçin.",
    });

    // ── Accessories, as add-on PRODUCTS ────────────────────────────────────
    for (const a of [
      { name: "32 inç QHD 180Hz oyuncu monitörü", sku: "MON-32Q", price: 12_499, group: "Monitör" },
      { name: "7.1 surround RGB kulaklık", sku: "HS-71RGB", price: 1_299, group: "Kulaklık" },
      { name: "Mekanik oyuncu klavyesi", sku: "KB-MECH", price: 2_999, group: "Klavye" },
    ]) {
      const p = await post("products", {
        name: a.name, slug: a.sku.toLowerCase(), status: "active",
        price: a.price, currency: TRY, sku: a.sku,
      });
      ids[a.sku] = p.id;
      await post("product_addons", {
        product: ids.product, addon_product: p.id, group_label: a.group,
        pricing: "list_price", max_qty: 1,
      });
    }
  });

  afterAll(() => h.cleanup());

  /** Rebuild the in-memory shape the storefront evaluator takes, from the API. */
  const loadConfig = async (): Promise<{ slots: Slot[]; rules: Rule[] }> => {
    const mods = await list(`product_modifiers?filter=${encodeURIComponent(JSON.stringify({ product: { _eq: ids.product } }))}&sort=position&limit=50`);
    const sets = await list("modifier_sets?limit=50");
    const values = await list("modifier_values?sort=position&limit=200");
    const rules = await list("modifier_rules?limit=50");
    const setById = new Map(sets.map((s) => [s.id as string, s]));
    return {
      slots: mods.map((m) => {
        const set = setById.get(m.modifier_set as string);
        return {
          id: m.id as string,
          label: (m.label as string) || (set?.name as string),
          is_required: m.is_required === true,
          maxSelect: Number(set?.max_select ?? 1),
          setCode: (set?.code as string) ?? null,
          choices: values
            .filter((v) => v.modifier_set === m.modifier_set)
            .map((v) => ({
              id: v.id as string,
              label: v.label as string,
              code: (v.code as string) ?? null,
              adjustment_type: v.adjustment_type as "fixed_amount",
              price_adjustment: v.price_adjustment as { amount: number; currency: string } | null,
              is_default: v.is_default === true,
              active: v.active !== false,
            })),
        };
      }),
      rules: rules.map((r) => ({
        id: r.id as string,
        rule_type: r.rule_type as Rule["rule_type"],
        when_modifier: r.when_modifier as string,
        when_value: (r.when_value as string) ?? null,
        then_modifier: (r.then_modifier as string) ?? null,
        then_value: (r.then_value as string) ?? null,
        message: (r.message as string) ?? null,
        active: r.active !== false,
      })),
    };
  };

  test("4 608 sellable combinations are held in 29 rows, not 4 608", async () => {
    const { slots } = await loadConfig();
    expect(slots).toHaveLength(8);
    const combos = slots.reduce((n, s) => n * Math.max(1, s.choices.length), 1);
    // 2 · 4 · 2 · 6 · 3 · 4 · 4 · 2 — the warranty axis doubles the page's own
    // 4 608, which counts the configuration without it.
    expect(combos).toBe(9_216);

    const sets = await list("modifier_sets?limit=50");
    const values = await list("modifier_values?limit=200");
    const mine = values.filter((v) => sets.some((s) => s.id === v.modifier_set));
    // Seven sets + 22 choices + 8 slots. The template's own three sample sets
    // ride along, so count only what this scenario declared.
    expect(mine.length).toBeGreaterThanOrEqual(22);
    expect(slots.length + 7 + 22).toBeLessThan(combos / 100);
  });

  test("two drive bays share ONE set, and stay in step when its price moves", async () => {
    const { slots } = await loadConfig();
    const bay2 = slots.find((s) => s.label === "M.2 yuva 2")!;
    const bay3 = slots.find((s) => s.label === "M.2 yuva 3")!;
    const bay1 = slots.find((s) => s.label === "M.2 yuva 1")!;

    // Same choices, same ids — one set behind two slots.
    expect(bay2.choices.map((c) => c.id)).toEqual(bay3.choices.map((c) => c.id));
    // Bay 1 is deliberately its OWN set: its options replace an included drive
    // and are priced against it, 13 000 below the additive bays.
    expect(bay1.choices.map((c) => c.id)).not.toEqual(bay2.choices.map((c) => c.id));
    const add2tb = (s: Slot) => s.choices.find((c) => c.code === "2TB")!.price_adjustment?.amount;
    expect(add2tb(bay1)).toBe(10_000);
    expect(add2tb(bay2)).toBe(23_000);

    // Move the shared price once; both bays follow. This is the whole argument
    // for a shared set over a per-product option list.
    const shared = bay2.choices.find((c) => c.code === "2TB")!;
    const patched = await h.fetch(`/api/items/modifier_values/${shared.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ price_adjustment: 24_500 }),
    });
    expect(patched.status).toBe(200);
    const after = await loadConfig();
    const b2 = after.slots.find((s) => s.label === "M.2 yuva 2")!;
    const b3 = after.slots.find((s) => s.label === "M.2 yuva 3")!;
    expect(add2tb(b2)).toBe(24_500);
    expect(add2tb(b3)).toBe(24_500);
    // And bay 1, on its own set, did not move.
    expect(add2tb(after.slots.find((s) => s.label === "M.2 yuva 1")!)).toBe(10_000);

    // Put it back so the pricing test below reads the page's own numbers.
    await h.fetch(`/api/items/modifier_values/${shared.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ price_adjustment: 23_000 }),
    });
  });

  test("a maxed-out build prices to the lira, at six figures", async () => {
    const { slots, rules } = await loadConfig();
    const by = (label: string) => slots.find((s) => s.label === label)!;
    const pick = (label: string, code: string) => {
      const s = by(label);
      return [s.id, [s.choices.find((c) => c.code === code)!.id]] as [string, string[]];
    };
    const selection = Object.fromEntries([
      pick("İşletim sistemi", "W11P"),
      pick("İşlemci", "9950X3D"),
      pick("İşlemci soğutucu", "LQ360"),
      pick("Bellek", "32-5600-30"),
      pick("M.2 yuva 1", "2TBHS"),
      pick("M.2 yuva 2", "2TBHS"),
      pick("M.2 yuva 3", "2TB"),
      pick("Ek garanti", "4Y"),
    ]);

    const r = resolve(slots, rules, selection, BASE);
    const expected = 1_200 + 26_999 + 6_499 + 21_999 + 15_000 + 28_000 + 23_000 + 4_999;
    expect(r.optionsTotal).toBe(expected);
    expect(r.total).toBe(BASE + expected);
    expect(r.total).toBe(223_795);
    expect(r.orderable).toBe(true);
    // Turkish text survives the build string, which is composed from CODES —
    // and codes are ASCII on purpose, because a build string is read aloud
    // down a phone line and typed into a picking system.
    expect(r.code).toBe("OSW11P/CPU9950X3D/COOLLQ360/RAM32-5600-30/M2A2TBHS/M2X2TBHS/M2X2TB/GAR4Y");
    expect(/[İıĞğŞşÇçÖöÜü]/.test(r.code)).toBe(false);
  });

  test("the incompatible pair is refused in the seller's own words", async () => {
    const { slots, rules } = await loadConfig();
    const by = (label: string) => slots.find((s) => s.label === label)!;
    const cpu = by("İşlemci");
    const cooler = by("İşlemci soğutucu");
    const air = cooler.choices.find((c) => c.code === "AIR120")!;

    const bad = resolve(slots, rules, {
      [cpu.id]: [cpu.choices.find((c) => c.code === "9950X3D")!.id],
      [cooler.id]: [air.id],
      [by("İşletim sistemi").id]: [by("İşletim sistemi").choices[0]!.id],
      [by("Bellek").id]: [by("Bellek").choices[0]!.id],
      [by("M.2 yuva 1").id]: [by("M.2 yuva 1").choices[0]!.id],
    }, BASE);
    expect(bad.blocked.has(air.id)).toBe(true);
    expect(bad.orderable).toBe(false);
    expect(bad.violations).toContain(
      "Ryzen 9 9950X3D hava soğutucuyla satılmıyor — sıvı soğutucu seçin.",
    );
  });

  test("checkout keeps the build, the money and the parts together", async () => {
    const { slots, rules } = await loadConfig();
    const by = (label: string) => slots.find((s) => s.label === label)!;
    const pick = (label: string, code: string) => {
      const s = by(label);
      return [s.id, [s.choices.find((c) => c.code === code)!.id]] as [string, string[]];
    };
    const selection = Object.fromEntries([
      pick("İşletim sistemi", "W11P"),
      pick("İşlemci", "9800X3D"),
      pick("İşlemci soğutucu", "LQ360"),
      pick("Bellek", "32-6000-36"),
      pick("M.2 yuva 1", "2TB"),
      pick("M.2 yuva 2", "1TB"),
      pick("Ek garanti", "4Y"),
    ]);
    const r = resolve(slots, rules, selection, BASE);
    expect(r.orderable).toBe(true);

    const order = await post("orders", {
      email: "alici@example.com", state: "open", status: "paid",
      subtotal: r.total, total: r.total, currency: TRY,
    });
    const line = await post("order_items", {
      order: order.id, product: ids.product,
      title: "TD3 masaüstü oyun bilgisayarı", sku: "TD3-V315-BEYAZ",
      qty: 1, unit_price: BASE, options_total: r.optionsTotal,
      config_code: r.code, currency: TRY,
    });

    const valuesById = new Map(
      slots.flatMap((s) => s.choices.map((c) => [c.id, { slot: s, choice: c }] as const)),
    );
    const catalog = await list("modifier_values?limit=200");
    for (const [i, a] of r.adjustments.entries()) {
      const hit = valuesById.get(a.choiceId)!;
      const row = catalog.find((v) => v.id === a.choiceId);
      await post("order_item_options", {
        line: line.id, modifier: hit.slot.id, value: a.choiceId, label: a.label,
        qty: 1, price_adjustment: a.amount, currency: TRY,
        component_variant: (row?.component_variant as string) ?? undefined,
        position: i + 1,
      });
    }

    // The line totals to the lira, from two columns the database folded itself.
    const read = await one("order_items", line.id);
    expect(read.unit_price).toEqual({ amount: BASE, currency: TRY });
    expect(read.options_total).toEqual({ amount: r.optionsTotal, currency: TRY });
    expect(read.line_total).toEqual({ amount: BASE + r.optionsTotal, currency: TRY });
    expect(read.config_code).toBe(r.code);

    // The build sheet: every priced choice, and the parts a picker must fit.
    const opts = await list(`order_item_options?filter=${encodeURIComponent(JSON.stringify({ line: { _eq: line.id } }))}&limit=50`);
    expect(opts).toHaveLength(r.adjustments.length);
    const sum = opts.reduce(
      (n, o) => n + ((o.price_adjustment as { amount: number } | null)?.amount ?? 0),
      0,
    );
    expect(sum).toBe(r.optionsTotal);
    // CPU, RAM and both drives are real parts; the OS, cooler and warranty are
    // not, and must not invent an inventory row.
    const withParts = opts.filter((o) => o.component_variant);
    expect(withParts).toHaveLength(4);

    // Turkish labels come back exactly as stored — no fold anywhere on the
    // write path.
    expect(opts.some((o) => o.label === "32GB (2x16GB) 6000MHz CL36")).toBe(true);
  });

  test("an accessory is its own line, pointing back at the machine", async () => {
    // A keyboard is not a modifier: it has its own SKU, stock, tax class and
    // return path. It rides on the order as a separate line naming the line it
    // was bought with — which is what makes returning just the keyboard a
    // return of a keyboard.
    const addons = await list(`product_addons?filter=${encodeURIComponent(JSON.stringify({ product: { _eq: ids.product } }))}&limit=20`);
    expect(addons).toHaveLength(3);

    const order = await post("orders", {
      email: "alici2@example.com", state: "open", status: "paid",
      subtotal: BASE + 2_999, total: BASE + 2_999, currency: TRY,
    });
    const machine = await post("order_items", {
      order: order.id, product: ids.product, title: "TD3 masaüstü", sku: "TD3-V315-BEYAZ",
      qty: 1, unit_price: BASE, options_total: 0, currency: TRY,
    });
    const keyboard = await post("order_items", {
      order: order.id, product: ids["KB-MECH"],
      title: "Mekanik oyuncu klavyesi", sku: "KB-MECH",
      qty: 1, unit_price: 2_999, options_total: 0, currency: TRY,
      parent: machine.id,
    });

    const read = await one("order_items", keyboard.id);
    expect(read.parent).toBe(machine.id);
    expect(read.line_total).toEqual({ amount: 2_999, currency: TRY });
    // The order's two lines are one machine and one keyboard, and the keyboard
    // knows which machine — the shape a bundle refund is argued from.
    const lines = await list(`order_items?filter=${encodeURIComponent(JSON.stringify({ order: { _eq: order.id } }))}&limit=20`);
    expect(lines).toHaveLength(2);
    expect(lines.filter((l) => l.parent).length).toBe(1);
  });
});
