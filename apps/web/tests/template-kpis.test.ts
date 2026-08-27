/**
 * Bundled template KPIs — the definitions a vertical arrives with.
 *
 * These are data, not code, so nothing about them is a compile error. A KPI
 * naming a column its collection does not have still typechecks, still ships,
 * and only fails when somebody opens the KPIs page of a workspace that applied
 * that template — as a VALIDATION message on a tile. So every reference is
 * walked here against the template's own field list, plus the semantic rules
 * that would otherwise produce a confidently wrong number: money formatting on
 * a non-money column, a period window on a column that does not date the
 * event, and a rising-is-bad figure painted green.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import { TEMPLATES } from "../src/server/templates/catalog";
import { TEMPLATE_KPIS } from "../src/server/templates/kpis";

const NUMERIC = new Set(["integer", "number", "money"]);
/** System columns every collection has, so a KPI may window on them. */
const SYSTEM_TIMESTAMPS = new Set(["created_at", "updated_at"]);

interface Field {
  name: string;
  type: string;
}

const templateById = new Map(TEMPLATES.map((t) => [t.id, t]));

const fieldsOf = (templateId: string, collection: string): Field[] | null => {
  const t = templateById.get(templateId);
  const c = t?.collections.find((col) => col.slug === collection);
  return c ? ((c.fields ?? []) as Field[]) : null;
};

describe("template KPIs: every reference resolves", () => {
  test("each bundled KPI set belongs to a real template", () => {
    for (const id of Object.keys(TEMPLATE_KPIS)) {
      expect(templateById.has(id)).toBe(true);
    }
  });

  test("every KPI names a collection the template actually creates", () => {
    const bad: string[] = [];
    for (const [templateId, kpis] of Object.entries(TEMPLATE_KPIS)) {
      for (const k of kpis) {
        if (!fieldsOf(templateId, k.collection)) bad.push(`${templateId}/${k.slug} → ${k.collection}`);
      }
    }
    expect(bad).toEqual([]);
  });

  test("every aggregate target is a numeric column of that collection", () => {
    const bad: string[] = [];
    for (const [templateId, kpis] of Object.entries(TEMPLATE_KPIS)) {
      for (const k of kpis) {
        if (k.agg === "count") {
          // `count` takes no field — carrying one would be a definition that
          // says something it does not do.
          if (k.field) bad.push(`${templateId}/${k.slug}: count with field "${k.field}"`);
          continue;
        }
        if (!k.field) {
          bad.push(`${templateId}/${k.slug}: ${k.agg} with no field`);
          continue;
        }
        const f = fieldsOf(templateId, k.collection)?.find((x) => x.name === k.field);
        if (!f) bad.push(`${templateId}/${k.slug}: no column "${k.field}" on ${k.collection}`);
        else if (!NUMERIC.has(f.type))
          bad.push(`${templateId}/${k.slug}: "${k.field}" is ${f.type}, not numeric`);
      }
    }
    expect(bad).toEqual([]);
  });

  test("every dateField is a timestamp column (or a system timestamp)", () => {
    const bad: string[] = [];
    for (const [templateId, kpis] of Object.entries(TEMPLATE_KPIS)) {
      for (const k of kpis) {
        if (!k.dateField) continue;
        if (SYSTEM_TIMESTAMPS.has(k.dateField)) continue;
        const f = fieldsOf(templateId, k.collection)?.find((x) => x.name === k.dateField);
        if (!f) bad.push(`${templateId}/${k.slug}: no column "${k.dateField}" on ${k.collection}`);
        else if (f.type !== "timestamp")
          bad.push(`${templateId}/${k.slug}: dateField "${k.dateField}" is ${f.type}`);
      }
    }
    expect(bad).toEqual([]);
  });

  test("every groupBy is a real column of that collection", () => {
    const bad: string[] = [];
    for (const [templateId, kpis] of Object.entries(TEMPLATE_KPIS)) {
      for (const k of kpis) {
        if (!k.groupBy) continue;
        const f = fieldsOf(templateId, k.collection)?.find((x) => x.name === k.groupBy);
        if (!f) bad.push(`${templateId}/${k.slug}: no column "${k.groupBy}" on ${k.collection}`);
      }
    }
    expect(bad).toEqual([]);
  });

  test("every filter key is a real column of that collection", () => {
    const bad: string[] = [];
    for (const [templateId, kpis] of Object.entries(TEMPLATE_KPIS)) {
      for (const k of kpis) {
        if (!k.filter) continue;
        for (const key of Object.keys(k.filter)) {
          if (key.startsWith("$") || key.startsWith("_")) continue; // combinator
          const f = fieldsOf(templateId, k.collection)?.find((x) => x.name === key);
          if (!f) bad.push(`${templateId}/${k.slug}: filter on missing column "${key}"`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  test("every filter VALUE on a dropdown column is a declared choice", () => {
    // The column existing is not enough, and the gap between those two checks
    // is where the worst kind of KPI bug lives. `ecommerce` filtered its
    // revenue figures on `status != "cancelled"` while the orders dropdown
    // offered `voided` and no `cancelled` at all: the column was real, the test
    // above passed, and the filter excluded nothing — so every cancelled order
    // was counted into net revenue, and the `cancelled-orders` tile read 0
    // for ever. Nothing failed, which is why it survived.
    //
    // `_neq` / `_nin` are checked as hard as `_eq` / `_in`. An exclusion naming
    // a value that cannot occur is exactly the silent no-op above; an inclusion
    // naming one merely returns nothing, which somebody notices.
    const OPS = new Set(["_eq", "_neq", "_in", "_nin"]);
    const bad: string[] = [];
    for (const [templateId, kpis] of Object.entries(TEMPLATE_KPIS)) {
      for (const k of kpis) {
        if (!k.filter) continue;
        for (const [key, cond] of Object.entries(k.filter)) {
          if (key.startsWith("$") || key.startsWith("_")) continue; // combinator
          const f = fieldsOf(templateId, k.collection)?.find((x) => x.name === key) as
            | (Field & { options?: { choices?: { value: string }[] } })
            | undefined;
          const choices = f?.options?.choices?.map((c) => c.value);
          if (!choices?.length) continue; // not a closed set — nothing to check
          if (!cond || typeof cond !== "object") continue;
          for (const [op, raw] of Object.entries(cond as Record<string, unknown>)) {
            if (!OPS.has(op)) continue;
            for (const v of Array.isArray(raw) ? raw : [raw]) {
              if (typeof v !== "string" || v.startsWith("$")) continue; // variable
              if (!choices.includes(v)) {
                bad.push(
                  `${templateId}/${k.slug}: ${key} ${op} "${v}" — not a choice (have: ${choices.join(", ")})`,
                );
              }
            }
          }
        }
      }
    }
    expect(bad).toEqual([]);
  });

  test("`money` format is only used on money columns", () => {
    // A `number` column formatted as money prints a plain float with a
    // currency symbol glued on; only `money` carries a currency the aggregate
    // engine can report.
    const bad: string[] = [];
    for (const [templateId, kpis] of Object.entries(TEMPLATE_KPIS)) {
      for (const k of kpis) {
        if (k.format !== "money" || !k.field) continue;
        const f = fieldsOf(templateId, k.collection)?.find((x) => x.name === k.field);
        if (f?.type !== "money")
          bad.push(`${templateId}/${k.slug}: format money on ${f?.type ?? "?"} column`);
      }
    }
    expect(bad).toEqual([]);
  });

  test("a per-row-currency money column is only totalled per currency", () => {
    // Every `money` column in the catalog is declared with
    // `money: { currencyField: "currency" }`, and the aggregate engine refuses
    // to sum one without grouping by that column — a total of mixed
    // denominations is not a smaller number, it is not a number. Caught here
    // because otherwise the definition looks fine until a workspace applies
    // the template and the tile renders a VALIDATION message.
    const bad: string[] = [];
    for (const [templateId, kpis] of Object.entries(TEMPLATE_KPIS)) {
      for (const k of kpis) {
        if (k.agg === "count" || !k.field) continue;
        const f = fieldsOf(templateId, k.collection)?.find((x) => x.name === k.field) as
          | (Field & { money?: { currencyField?: string } })
          | undefined;
        const per = f?.type === "money" ? f.money?.currencyField : undefined;
        if (!per) continue;
        if (k.groupBy !== per) {
          bad.push(
            `${templateId}/${k.slug}: ${k.agg}(${k.field}) needs groupBy "${per}", has "${k.groupBy ?? "none"}"`,
          );
        }
      }
    }
    expect(bad).toEqual([]);
  });


  test("every money column's currencyField names a text column on the same collection", () => {
    // `moneyIn(...)` hard-codes `currencyField: "currency"`, so a collection
    // that gains a money amount must gain the `currency` column beside it. Miss
    // that and the template still LOOKS right — the failure only surfaces when
    // a workspace applies it and the field validator refuses the collection.
    // The catalog apply smoke does catch it, several seconds later and with a
    // message about a collection rather than about the column that is missing.
    const bad: string[] = [];
    // Every template, not just the ones with KPIs — the invariant is about the
    // collection, and a money column can exist without anything measuring it.
    for (const t of TEMPLATES) {
      for (const c of t.collections) {
        const fields = (c.fields ?? []) as Field[];
        const names = new Map(fields.map((f) => [f.name, f]));
        for (const f of fields) {
          const ref = (f as Field & { money?: { currencyField?: string } }).money?.currencyField;
          if (f.type !== "money" || !ref) continue;
          const target = names.get(ref);
          if (!target) bad.push(`${t.id}/${c.slug}.${f.name}: currencyField "${ref}" has no column`);
          else if (target.type !== "text")
            bad.push(`${t.id}/${c.slug}.${f.name}: currencyField "${ref}" is ${target.type}, must be text`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  test("slugs are unique within a template and URL-safe", () => {
    const bad: string[] = [];
    for (const [templateId, kpis] of Object.entries(TEMPLATE_KPIS)) {
      const seen = new Set<string>();
      for (const k of kpis) {
        if (seen.has(k.slug)) bad.push(`${templateId}: duplicate slug "${k.slug}"`);
        seen.add(k.slug);
        if (!/^[a-z0-9][a-z0-9_-]*$/.test(k.slug))
          bad.push(`${templateId}: slug "${k.slug}" is not lowercase-kebab`);
      }
    }
    expect(bad).toEqual([]);
  });

  test("a figure whose rise is bad news is marked `down`", () => {
    // Without `direction`, the delta badge colours by sign alone, so a
    // worsening refund total renders green.
    const bad: string[] = [];
    const BAD_WHEN_RISING = /refund|cancel|scrap|waste|downtime|late.fee|damage|dispute|outstanding|backlog|incident|fine|leaver/i;
    for (const [templateId, kpis] of Object.entries(TEMPLATE_KPIS)) {
      for (const k of kpis) {
        if (!BAD_WHEN_RISING.test(k.slug)) continue;
        if (k.groupBy) continue; // a ranking has no single delta to colour
        if (k.direction !== "down") bad.push(`${templateId}/${k.slug}: direction=${k.direction ?? "unset"}`);
      }
    }
    expect(bad).toEqual([]);
  });

  test("the flagship verticals all ship KPIs", () => {
    // The point of the feature is that applying a vertical answers "how is it
    // going?" straight away; a template with collections but no definitions
    // silently reverts to the old "here are the tools" experience.
    for (const id of ["ecommerce", "saas", "crm", "support", "invoicing"]) {
      expect(TEMPLATE_KPIS[id]?.length ?? 0).toBeGreaterThan(0);
    }
  });
});

/**
 * The real proof: apply a template end to end and evaluate every KPI it
 * seeded. A definition that references a column the collection engine renamed
 * (or that the aggregate engine refuses, like summing a per-row-currency money
 * column without grouping) fails HERE rather than on a customer's dashboard.
 */
describe("template KPIs: seeded definitions actually evaluate", () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  // One workspace per template — applying two into the same one would let the
  // first template's `orders`/`invoices` win the name and leave the second's
  // KPIs pointing at a schema they were not written for, which is a mess to
  // read but not a real failure.
  test("every template's KPIs run against its own freshly-applied schema", async () => {
    const failures: string[] = [];
    for (const templateId of Object.keys(TEMPLATE_KPIS)) {
      const w = makeHarness();
      try {
        await seedAdmin(w);
        const applied = await w.fetch("/api/admin/templates/apply", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ templateId }),
        });
        if (applied.status !== 201) {
          failures.push(`${templateId}: apply → ${applied.status}`);
          continue;
        }
        const body = (await applied.json()) as { data: { kpis: string[] } };
        if (body.data.kpis.length === 0) {
          failures.push(`${templateId}: seeded no KPIs`);
          continue;
        }
        for (const slug of body.data.kpis) {
          const res = await w.fetch(`/api/admin/kpis/${slug}/run?rangeDays=3650`);
          if (res.status !== 200) {
            failures.push(`${templateId}/${slug} → ${res.status} ${(await res.text()).slice(0, 200)}`);
          }
        }
      } finally {
        w.cleanup();
      }
    }
    expect(failures).toEqual([]);
  }, 180_000);

  test("applying `ecommerce` seeds its KPIs and every one of them runs", async () => {
    const applied = await h.fetch("/api/admin/templates/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ templateId: "ecommerce" }),
    });
    expect(applied.status).toBe(201);
    const body = (await applied.json()) as { data: { kpis: string[] } };
    expect(body.data.kpis.length).toBeGreaterThan(0);
    expect(body.data.kpis).toContain("net-revenue");

    const failures: string[] = [];
    for (const slug of body.data.kpis) {
      const res = await h.fetch(`/api/admin/kpis/${slug}/run?rangeDays=3650`);
      if (res.status !== 200) {
        failures.push(`${slug} → ${res.status} ${(await res.text()).slice(0, 160)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  test("re-applying does not duplicate or overwrite a tuned definition", async () => {
    // Tune one, then re-apply: the admin's version must survive.
    const before = (await (await h.fetch("/api/admin/kpis/net-revenue")).json()) as {
      data: { id: string };
    };
    await h.fetch(`/api/admin/kpis/${before.data.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Revenue (tuned)" }),
    });

    const again = await h.fetch("/api/admin/templates/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ templateId: "ecommerce" }),
    });
    expect(again.status).toBe(201);
    const body = (await again.json()) as { data: { kpis: string[] } };
    expect(body.data.kpis).toEqual([]);

    const after = (await (await h.fetch("/api/admin/kpis/net-revenue")).json()) as {
      data: { name: string };
    };
    expect(after.data.name).toBe("Revenue (tuned)");

    const all = (await (await h.fetch("/api/admin/kpis")).json()) as {
      data: Array<{ slug: string }>;
    };
    const revenues = all.data.filter((k) => k.slug === "net-revenue");
    expect(revenues.length).toBe(1);
  });
});
