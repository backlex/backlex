/**
 * Adopting a table with no `tenant_id` into a tenant-scoped collection.
 *
 * #339 filed this with the mechanism unexplained: the adoption "succeeds", the
 * wizard warns nothing, and every read answers `{"data":[]}` with HTTP 200 over
 * a table the operator knows has rows. The obvious explanation was ruled out —
 * `tenantFilter` DOES emit the clause, and a direct
 * `SELECT … WHERE tenant_id = 'x'` on that table raises `no such column`.
 *
 * The first test is the missing measurement, and it is the whole answer:
 * `tenantFilter` builds the clause with `sql.identifier("tenant_id")`, which
 * emits `"tenant_id"` — DOUBLE-QUOTED. SQLite's legacy double-quoted-string
 * misfeature says an identifier in double quotes that resolves to no column is
 * re-read as a STRING LITERAL. So the predicate becomes `'tenant_id' = '<uuid>'`
 * — false for every row, no error, 200 with nothing in it.
 *
 * Neither branch the issue was left choosing between. The clause is not
 * dropped, and no error is swallowed: the comparison is simply between two
 * strings that are never equal.
 *
 * This repo already had the fact written down — `foldablePredicate` carries the
 * same warning for the `__fold` companions, measured — and nobody connected it
 * to the tenant filter. See "an unresolvable double-quoted identifier is read
 * as a string literal".
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "../setup";

const json = { "Content-Type": "application/json" };

describe("a table with no tenant_id", () => {
  let h: TestHarness;

  const post = (path: string, body: unknown) =>
    h.fetch(path, { method: "POST", headers: json, body: JSON.stringify(body) });

  const runSql = async (statement: string, writes = false) => {
    const res = await h.fetch(`/api/admin/db/sql/run${writes ? "?writes=1" : ""}`, {
      method: "POST",
      headers: writes ? { ...json, "x-backlex-confirm": "yes" } : json,
      body: JSON.stringify({ sql: statement }),
    });
    return res;
  };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const made = await runSql(
      `CREATE TABLE legacy_customers (
         id INTEGER PRIMARY KEY,
         name TEXT NOT NULL,
         email TEXT,
         created_at INTEGER
       )`,
      true,
    );
    expect([200, 201]).toContain(made.status);
    const row = await runSql(
      `INSERT INTO legacy_customers (id, name, email, created_at) VALUES (1, 'Ada', 'ada@example.test', 0)`,
      true,
    );
    expect([200, 201]).toContain(row.status);
  });
  afterAll(() => h.cleanup());

  test("SQLite reads an unresolvable DOUBLE-QUOTED identifier as a string literal", async () => {
    // The measurement #339 was missing, and it is what distinguishes the two
    // branches the issue was left choosing between.

    // Bare: raises, exactly as the issue reports.
    const bare = await runSql(`SELECT * FROM legacy_customers WHERE tenant_id = 'x'`);
    expect(bare.status).toBe(422);
    expect(await bare.text()).toContain("no such column");

    // Double-quoted — which is what `sql.identifier()` emits: NO error, and
    // zero rows, because the predicate degraded to `'tenant_id' = 'x'`.
    const quoted = await runSql(`SELECT * FROM legacy_customers WHERE "tenant_id" = 'x'`);
    expect(quoted.status).toBe(200);
    const body = (await quoted.json()) as { data: { rows: unknown[] }[] };
    expect(body.data[0]!.rows).toEqual([]);

    // And the table really does hold the row, so "zero rows" above is the
    // predicate's doing rather than an empty fixture.
    const all = await runSql(`SELECT * FROM legacy_customers`);
    expect(((await all.json()) as { data: { rows: unknown[] }[] }).data[0]!.rows).toHaveLength(1);
  });

  test("the adopt wizard warns that a tenant-scoped collection cannot match a row", async () => {
    const res = await post("/api/admin/adopt/inspect", { table: "legacy_customers" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { warnings?: string[]; systemColumnsPresent?: Record<string, boolean> };
    };
    // It already reports `systemColumnsPresent` and emits `warnings`; this
    // belongs in that array. Before #339 it was `warnings: []`.
    expect(body.data.systemColumnsPresent?.tenantId).toBe(false);
    expect((body.data.warnings ?? []).join(" ")).toMatch(/tenant/i);
  });

  test("adopting it as tenant-scoped is refused, rather than succeeding into an empty read", async () => {
    // The configuration cannot work: every read is `'tenant_id' = '<uuid>'`.
    // Refusing at the door beats an operator staring at a table they know has
    // rows reporting zero.
    const res = await post("/api/collections", {
      slug: "legacy_customers",
      adopted: true,
      physicalTable: "legacy_customers",
      fields: [{ name: "name", type: "text" }],
    });
    expect(res.status).toBe(422);
    expect(await res.text()).toMatch(/tenant_id/);
  });

  test("adopting it as NOT tenant-scoped works and the row reads back", async () => {
    // The vacuous-pass guard: a refusal that refused everything would pass the
    // test above while breaking the feature.
    const res = await post("/api/collections", {
      slug: "legacy_customers",
      adopted: true,
      physicalTable: "legacy_customers",
      tenantScoped: false,
      fields: [{ name: "name", type: "text" }],
    });
    expect(res.status).toBe(201);

    const read = await h.fetch("/api/items/legacy_customers");
    expect(read.status).toBe(200);
    const rows = ((await read.json()) as { data: { name: string }[] }).data;
    expect(rows.map((r) => r.name)).toEqual(["Ada"]);
  });
});
