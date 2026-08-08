import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { TEMPLATES } from "../src/server/templates/catalog";
import { makeHarness, seedAdmin } from "./setup";

/**
 * Catalog-wide apply smoke: every template in the catalog must materialize
 * cleanly into a fresh workspace — all collections created, samples seeded,
 * bundled roles/dashboards installed. Catches authoring mistakes (bad relation
 * targets, out-of-order collections, dangling SampleRefs, invalid computed
 * formulas) that the per-surface tests — which only apply blog/ecommerce/crm —
 * would miss.
 */
describe("templates — full catalog applies cleanly", () => {
  for (const tpl of TEMPLATES) {
    if (tpl.id === "blank") continue;

    test(`${tpl.id} applies into a fresh workspace`, async () => {
      const h = makeHarness();
      try {
        await seedAdmin(h);
        const res = await h.fetch("/api/admin/templates/apply", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ templateId: tpl.id }),
        });
        expect(res.status).toBe(201);
        const { data } = (await res.json()) as {
          data: { created: string[]; skipped: string[]; seeded: number; roles: string[]; dashboards: string[] };
        };
        expect(data.created.sort()).toEqual(tpl.collections.map((c) => c.slug).sort());
        expect(data.skipped).toHaveLength(0);
        const expectedSeeded = tpl.collections.reduce((n, c) => n + (c.samples?.length ?? 0), 0);
        expect(data.seeded).toBe(expectedSeeded);
        expect(data.roles.sort()).toEqual((tpl.roles ?? []).map((r) => r.name).sort());
        expect(data.dashboards.sort()).toEqual((tpl.dashboards ?? []).map((d) => d.name).sort());
      } finally {
        h.cleanup();
      }
    });
  }
});

/**
 * The catalog is one file per vertical, and stays that way.
 *
 * `catalog.ts` was 8653 lines — 26 template definitions inlined in one array,
 * with the shared authoring DSL on top of them. Nothing was wrong with the
 * definitions; the problem was that every one of them was only reachable by
 * scrolling past the other twenty-five, so a change to `crm` and a change to
 * `hr` were edits to the same file and read as one diff.
 *
 * This gate is what keeps it split: a definition lives in `defs/<id>.ts`, the
 * file is named for the id it is the contract for, and `defs/index.ts` is the
 * only place the order is decided. A twenty-seventh template inlined back into
 * the array — or a file left behind after its template was renamed — fails
 * here rather than being noticed the next time someone opens the file.
 */
describe("templates — one file per vertical", () => {
  const DEFS = new URL("../src/server/templates/defs/", import.meta.url).pathname;
  const files = readdirSync(DEFS)
    .filter((f) => f.endsWith(".ts") && f !== "index.ts")
    .map((f) => f.slice(0, -3));

  test("every template except `blank` has its own def file", () => {
    const authored = TEMPLATES.map((t) => t.id).filter((id) => id !== "blank");
    // Both directions: a definition with no file means it was inlined back into
    // the index; a file with no definition is an orphan the index forgot.
    expect(files.slice().sort()).toEqual(authored.slice().sort());
  });

  for (const file of files) {
    test(`defs/${file}.ts declares exactly one template, and it is \`${file}\``, () => {
      const src = readFileSync(`${DEFS}${file}.ts`, "utf8");
      const declared = [...src.matchAll(/^export const (\w+): SchemaTemplate\b/gm)];
      expect(declared).toHaveLength(1);
      expect([...src.matchAll(/^\s{2}id: "([^"]+)",$/gm)].map((m) => m[1])).toEqual([file]);
    });
  }
});
