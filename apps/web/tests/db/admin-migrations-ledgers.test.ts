/**
 * The admin Migrations page reads BOTH ledgers.
 *
 * This repo has two: the CLI writes `__drizzle_migrations`, and the boot runner
 * `ensureMigrations` writes `__backlex_migrations`. On a Vercel or Netlify
 * deploy **no CLI ever runs** — the boot runner did all the work — so the CLI's
 * table does not exist, and the page reported "Drizzle migrations table not
 * present yet" while the schema was fully current. Blind exactly on the deploy
 * targets where an operator is least able to check by hand. See #326.
 *
 * The CLI table is DROPPED here rather than mocked: that is what a
 * boot-runner-only deployment actually looks like from the query's point of
 * view, and it is the only version of this fixture that can go red for the real
 * reason.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "../setup";

const json = { "Content-Type": "application/json" };

interface MigRow {
  id: string | number;
  hash: string;
  created_at: string | number;
  tag: string | null;
  applied: boolean;
  source: string | null;
}

describe("the admin migrations listing", () => {
  let h: TestHarness;

  const runSql = async (statement: string, writes = false) => {
    const res = await h.fetch(`/api/admin/db/sql/run${writes ? "?writes=1" : ""}`, {
      method: "POST",
      headers: writes ? { ...json, "x-backlex-confirm": "yes" } : json,
      body: JSON.stringify({ sql: statement }),
    });
    expect([200, 201]).toContain(res.status);
    const body = (await res.json()) as { data: { rows: Record<string, unknown>[] }[] };
    return body.data[0]?.rows ?? [];
  };

  const listing = async (): Promise<{ data: MigRow[]; note?: string }> => {
    const res = await h.fetch("/api/admin/db/migrations");
    expect(res.status).toBe(200);
    return (await res.json()) as { data: MigRow[]; note?: string };
  };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  test("both ledgers exist in this harness (the fixture is the fixture)", async () => {
    // The harness migrates with drizzle's own migrator AND boots the runner,
    // so both tables are present. If that ever stops being true the tests below
    // would pass or fail for reasons that have nothing to do with the union.
    const names = (
      await runSql(
        `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('__drizzle_migrations','__backlex_migrations')`,
      )
    ).map((r) => r.name);
    expect(names).toContain("__drizzle_migrations");
    expect(names).toContain("__backlex_migrations");
  });

  test("a migration recorded in both ledgers is listed once, naming both", async () => {
    const { data } = await listing();
    expect(data.length).toBeGreaterThan(0);

    const tags = data.filter((r) => r.tag).map((r) => r.tag);
    expect(new Set(tags).size).toBe(tags.length);

    // The harness adopts the CLI ledger into the runtime one at boot, so the
    // overwhelming majority are in both — and that is exactly the row that a
    // naive concatenation would duplicate.
    expect(data.some((r) => r.source === "cli+runtime")).toBe(true);
  });

  test("with the CLI ledger absent, the page still reports the schema as migrated", async () => {
    // The Vercel/Netlify Postgres shape: `ensureMigrations` did everything and
    // no CLI ever ran.
    const before = await listing();
    const appliedBefore = before.data.filter((r) => r.applied).length;
    expect(appliedBefore).toBeGreaterThan(0);

    await runSql(`DROP TABLE __drizzle_migrations`, true);

    const after = await listing();
    // The old behaviour: `{ data: [], note: "Drizzle migrations table not
    // present yet." }` — an empty page over a fully current schema.
    expect(after.data.filter((r) => r.applied).length).toBe(appliedBefore);
    expect(after.data.every((r) => !r.applied || r.source === "runtime")).toBe(true);
    // A ledger that simply is not in use on this deploy target earns NO note.
    // Found on the real dev server: with the boot ledger absent on D1, the
    // first version of this printed the raw failed SQL onto the admin page for
    // a completely ordinary state.
    expect(after.note ?? null).toBeNull();
  });

  test("a migration in neither ledger is listed as NOT applied", async () => {
    // `applied` used to be hardcoded true on every row, so the page could not
    // represent a migration it knows about but has not applied — which is the
    // one question an operator opens this page to ask.
    const { data } = await listing();
    const victim = data.find((r) => r.applied && r.tag);
    expect(victim).toBeDefined();

    await runSql(
      `DELETE FROM __backlex_migrations WHERE name = '${victim!.tag}'`,
      true,
    );

    const after = await listing();
    const row = after.data.find((r) => r.tag === victim!.tag);
    expect(row).toBeDefined();
    expect(row!.applied).toBe(false);
    expect(row!.source).toBeNull();
  });

  // LAST on purpose: it destroys both ledgers, so anything after it would be
  // asserting against a database no test set up.
  test("neither ledger present is stated, rather than rendered as an empty page", async () => {
    await runSql(`DROP TABLE IF EXISTS __drizzle_migrations`, true);
    await runSql(`DROP TABLE IF EXISTS __backlex_migrations`, true);

    const { data, note } = await listing();
    // The manifest still seeds the list, so the page says WHAT it expected to
    // find instead of going blank — which is the state an operator most needs
    // named rather than guessed at.
    expect(data.length).toBeGreaterThan(0);
    expect(data.every((r) => !r.applied)).toBe(true);
    expect(note ?? "").toContain("Neither migration ledger");
  });
});
