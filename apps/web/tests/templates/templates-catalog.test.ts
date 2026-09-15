import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { TEMPLATES } from "../../src/server/templates/catalog";
import { makeHarness, seedAdmin, type TestHarness } from "../setup";

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

    describe(tpl.id, () => {
      // One workspace per template, shared by the two tests below: the apply is
      // the expensive part, and the second test is only meaningful against the
      // workspace the first one proved was installed in full.
      let h: TestHarness;
      let status = 0;
      let data: {
        created: string[];
        skipped: string[];
        seeded: number;
        roles: string[];
        dashboards: string[];
      };

      beforeAll(async () => {
        h = makeHarness();
        await seedAdmin(h);
        const res = await h.fetch("/api/admin/templates/apply", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ templateId: tpl.id }),
        });
        status = res.status;
        data = (await res.json()).data;
      });
      afterAll(() => h.cleanup());

      test("applies into a fresh workspace", () => {
        expect(status).toBe(201);
        expect(data.created.sort()).toEqual(tpl.collections.map((c) => c.slug).sort());
        expect(data.skipped).toHaveLength(0);
        const expectedSeeded = tpl.collections.reduce((n, c) => n + (c.samples?.length ?? 0), 0);
        expect(data.seeded).toBe(expectedSeeded);
        expect(data.roles.sort()).toEqual((tpl.roles ?? []).map((r) => r.name).sort());
        expect(data.dashboards.sort()).toEqual((tpl.dashboards ?? []).map((d) => d.name).sort());
      });

      const declared = tpl.dashboards ?? [];
      if (declared.length === 0) return;

      /**
       * Installed is not the same as working. A seeded dashboard is stored
       * verbatim and its panels only meet the aggregate engine when somebody
       * opens Insights — so a panel the engine refuses applies cleanly, lists
       * cleanly, and then renders its error message where the figure should be.
       *
       * That is exactly how fifteen tiles across ten verticals shipped: `sum`
       * over a `moneyIn()` amount with no `groupBy: "currency"`, which the
       * engine refuses because adding ₺ to $ is not an amount. The KPI
       * definitions were already run end to end (`template-kpis.test.ts`) and
       * were all correct; the dashboards beside them were never run at all.
       *
       * Run against the template's own sample rows through the dashboard run
       * route — the one a report, the SDK and the `dashboards.run` tool use; the
       * Insights grid runs each panel through `/api/admin/panels/:id/run`, which
       * hands the same config to the same engine — so a refusal arrives here
       * as the engine's own sentence.
       */
      test("every panel on its bundled dashboards renders without an error", async () => {
        const listed = (await (await h.fetch("/api/admin/dashboards")).json()).data as {
          id: string;
          name: string;
        }[];
        const failures: string[] = [];
        for (const dash of declared) {
          const row = listed.find((d) => d.name === dash.name);
          expect(row, `${tpl.id}: dashboard "${dash.name}" was not seeded`).toBeTruthy();
          if (!row) continue;
          const run = await h.fetch(`/api/admin/dashboards/${row.id}/run`, { method: "POST" });
          expect(run.status, `${tpl.id}: running "${dash.name}"`).toBe(200);
          const panels = (await run.json()).data as {
            name: string;
            error?: string;
            data: unknown;
          }[];
          // Counted so the check below cannot pass by running nothing: a
          // dashboard that came back with no panels has no errors either.
          expect(panels.length, `${tpl.id}: "${dash.name}" ran a different panel count`).toBe(
            dash.panels.length,
          );
          for (const p of panels) {
            if (p.error) failures.push(`${dash.name} / ${p.name}: ${p.error}`);
            else if (!Array.isArray(p.data)) failures.push(`${dash.name} / ${p.name}: no data array`);
          }
        }
        expect(failures).toEqual([]);
      });
    });
  }
});

/**
 * A panel that groups its rows is never drawn as a `counter`.
 *
 * `counter` prints ONE number: the first numeric column of the first row. The
 * admin grid, the public embed and the PDF report all read `rows[0]`, and the
 * Insights editor says as much ("counter shows only the first"). Over a
 * `groupBy` that is the largest group, shown with nothing to say the others
 * were dropped — so the obvious way to silence a refused money total, adding
 * `groupBy: "currency"` and keeping the tile, would print the biggest currency's
 * total as if it were the whole. The apply smoke above cannot see that: the
 * panel runs, and it is the RENDERING that lies.
 */
describe("templates — bundled dashboard panels", () => {
  test("a panel that groups its rows is never drawn as a counter", () => {
    const bad: string[] = [];
    let grouped = 0;
    for (const tpl of TEMPLATES) {
      for (const dash of tpl.dashboards ?? []) {
        for (const p of dash.panels) {
          const groupBy = (p.config as { groupBy?: unknown }).groupBy;
          if (!groupBy) continue;
          grouped++;
          if (p.viz === "counter") {
            bad.push(`${tpl.id}/${dash.name}/${p.name}: counter over groupBy "${String(groupBy)}"`);
          }
        }
      }
    }
    expect(bad).toEqual([]);
    // A catalog with no grouped panel would make the check above vacuous.
    expect(grouped, "no bundled panel groups its rows").toBeGreaterThan(0);
  });
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
  const DEFS = new URL("../../src/server/templates/defs/", import.meta.url).pathname;
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
