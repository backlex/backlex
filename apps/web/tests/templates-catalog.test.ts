import { describe, expect, test } from "bun:test";
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
