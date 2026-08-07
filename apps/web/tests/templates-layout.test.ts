import { describe, expect, test } from "bun:test";
import { isPresentational } from "@backlex/db";
import { TEMPLATES } from "../src/server/templates/catalog";
import { makeHarness, seedAdmin } from "./setup";

/**
 * The catalog's form-layout contract. Every collection is laid out with the
 * field-organization primitives (`group`, `width`, `sectionCollapsible` /
 * `sectionCollapsed`, `sectionsAsTabs`, and the presentational `divider` /
 * `notice` types) rather than left as a flat column of inputs.
 *
 * These assertions encode the renderer's actual behaviour (see
 * `client/admin/collections/item-form.tsx`), so a layout that would silently render wrong —
 * a stray "General" tab, a fold flag the tabs branch ignores, an unlabeled
 * divider showing its raw column name — fails here instead of in production.
 */

type Field = { name: string; type: string; group?: string; width?: string } & Record<string, unknown>;

const collections = TEMPLATES.flatMap((t) =>
  t.collections.map((c) => ({ templateId: t.id, ...c })),
);
const asFields = (c: { fields: unknown[] }): Field[] => c.fields as unknown as Field[];
const groupsOf = (fields: Field[]): string[] => [
  ...new Set(fields.map((f) => f.group).filter((g): g is string => !!g)),
];

describe("template catalog — form layout", () => {
  test("tabbed collections group every field", () => {
    // The renderer buckets an ungrouped field under a `General` tab, which reads
    // as a bug next to the deliberate ones.
    for (const c of collections) {
      const fields = asFields(c);
      if (!fields.some((f) => f.sectionsAsTabs)) continue;
      const ungrouped = fields.filter((f) => !f.group).map((f) => f.name);
      expect(`${c.templateId}/${c.slug}: ${ungrouped.join(", ")}`).toBe(`${c.templateId}/${c.slug}: `);
    }
  });

  test("tabbed collections have more than one tab", () => {
    // With a single group the renderer falls back to stacked headings and the
    // flag is dead weight.
    for (const c of collections) {
      const fields = asFields(c);
      if (!fields.some((f) => f.sectionsAsTabs)) continue;
      expect(`${c.templateId}/${c.slug}`).toBeDefined();
      expect(groupsOf(fields).length).toBeGreaterThan(1);
    }
  });

  test("tabs and section folding are never combined", () => {
    // The tabs branch returns before the collapsible one, so a fold flag set
    // alongside `sectionsAsTabs` would never take effect.
    for (const c of collections) {
      const fields = asFields(c);
      if (!fields.some((f) => f.sectionsAsTabs)) continue;
      const folded = fields.filter((f) => f.sectionCollapsible || f.sectionCollapsed).map((f) => f.name);
      expect(`${c.templateId}/${c.slug}: ${folded.join(", ")}`).toBe(`${c.templateId}/${c.slug}: `);
    }
  });

  test("a collapsed section is also collapsible", () => {
    // `sectionCollapsed` alone still folds (the renderer ORs the two), but the
    // stored schema should say what it means.
    for (const c of collections) {
      for (const f of asFields(c)) {
        if (f.sectionCollapsed) {
          expect(`${c.templateId}/${c.slug}.${f.name}`).toBeDefined();
          expect(f.sectionCollapsible).toBe(true);
        }
      }
    }
  });

  test("presentational blocks carry their own text and no storage flags", () => {
    for (const c of collections) {
      for (const f of asFields(c)) {
        if (!isPresentational(f as never)) continue;
        const at = `${c.templateId}/${c.slug}.${f.name}`;
        // A divider with no label renders its raw field name as the rule text.
        if (f.type === "divider") expect(`${at}:${f.label ?? ""}`).not.toBe(`${at}:`);
        // A notice reads from `description` first, falling back to the label.
        if (f.type === "notice") expect(`${at}:${f.description ?? ""}`).not.toBe(`${at}:`);
        for (const flag of ["required", "unique", "indexed", "searchable", "vectorize", "to", "computed"]) {
          expect(`${at}.${flag}=${f[flag] ?? ""}`).toBe(`${at}.${flag}=`);
        }
      }
    }
  });

  test("presentational blocks never appear in sample rows", () => {
    // They own no column; a sample keyed by one would be silently dropped.
    for (const c of collections) {
      const layout = new Set(asFields(c).filter((f) => isPresentational(f as never)).map((f) => f.name));
      for (const row of c.samples ?? []) {
        for (const key of Object.keys(row)) {
          expect(`${c.templateId}/${c.slug}.${key}`).toBe(
            layout.has(key) ? "" : `${c.templateId}/${c.slug}.${key}`,
          );
        }
      }
    }
  });

  test("half-width fields pair up within their section", () => {
    // Two consecutive halves share a row; an odd one out renders full width,
    // which is a layout slip rather than an intent.
    for (const c of collections) {
      const fields = asFields(c);
      const bySection = new Map<string, Field[]>();
      for (const f of fields) {
        const key = f.group ?? "";
        bySection.set(key, [...(bySection.get(key) ?? []), f]);
      }
      for (const [section, list] of bySection) {
        let run = 0;
        for (const f of [...list, { name: "", type: "text" } as Field]) {
          const isHalf = f.width === "half" && !isPresentational(f as never);
          if (isHalf) {
            run += 1;
            continue;
          }
          expect(`${c.templateId}/${c.slug}[${section}] run=${run}`).toBe(
            `${c.templateId}/${c.slug}[${section}] run=${run % 2 === 0 ? run : "odd"}`,
          );
          run = 0;
        }
      }
    }
  });

  test("every collection uses the layout primitives at all", () => {
    // Nothing ships as a plain full-width column: at minimum a collection pairs
    // its scalars, and usually it sections them too.
    for (const c of collections) {
      const fields = asFields(c);
      if (fields.length < 3) continue;
      const laidOut = fields.some(
        (f) => f.group || f.width === "half" || isPresentational(f as never),
      );
      expect(`${c.templateId}/${c.slug} laidOut=${laidOut}`).toBe(
        `${c.templateId}/${c.slug} laidOut=true`,
      );
    }
  });

  test("records too long to scan get sections, and the longest get tabs", () => {
    // The house rule. Below 10 storage fields a record is a single conceptual
    // unit (a line item, a ledger row) and a lone section header is just noise;
    // past 14 it stops fitting on one screen and earns tabs.
    for (const c of collections) {
      const fields = asFields(c);
      const storage = fields.filter((f) => !isPresentational(f as never));
      const at = `${c.templateId}/${c.slug}(${storage.length})`;
      if (storage.length >= 10) {
        expect(`${at} groups=${groupsOf(fields).length}`).not.toBe(`${at} groups=0`);
      }
      if (storage.length >= 14) {
        expect(`${at} tabs=${fields.some((f) => f.sectionsAsTabs)}`).toBe(`${at} tabs=true`);
      }
    }
  });

  test("the layout primitives are actually exercised across the catalog", () => {
    const all = collections.flatMap(asFields);
    expect(all.filter((f) => f.width === "half").length).toBeGreaterThan(500);
    expect(all.filter((f) => f.sectionsAsTabs).length).toBeGreaterThan(20);
    expect(all.filter((f) => f.type === "notice").length).toBeGreaterThan(10);
    expect(all.filter((f) => f.type === "divider").length).toBeGreaterThan(0);
    expect(all.filter((f) => f.sectionCollapsed).length).toBeGreaterThan(0);
  });
});

describe("schema edits survive computed columns", () => {
  test("patching a collection that owns a computed column does not re-add it", async () => {
    // `PRAGMA table_info` omits generated columns, so the applier used to think
    // a computed column was missing and re-issue its ADD COLUMN on every edit —
    // a hard 500 on any schema/settings save. Regression guard for the
    // `table_xinfo` fix in schema-applier.
    const h = makeHarness();
    try {
      await seedAdmin(h);
      const apply = await h.fetch("/api/admin/templates/apply", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ templateId: "hr" }),
      });
      expect(apply.status).toBe(201);

      // employees owns `full_name` (computed from first_name || ' ' || last_name).
      const patch = await h.fetch("/api/collections/employees", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayTemplate: "{first_name} {last_name}" }),
      });
      expect(patch.status).toBe(200);

      // …and again, to prove it stays idempotent.
      const again = await h.fetch("/api/collections/employees", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ note: "People directory." }),
      });
      expect(again.status).toBe(200);
    } finally {
      h.cleanup();
    }
  });
});
