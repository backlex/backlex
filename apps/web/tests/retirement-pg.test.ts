/**
 * Postgres coverage for row retirement.
 *
 * The narrowing predicate is the only part of the feature that depends on the
 * dialect, and it depends on it twice:
 *
 *  - **The operand.** A boolean column is a native boolean on Postgres and an
 *    INTEGER 0/1 on SQLite, so `retiredFilter` encodes it through the same
 *    `serialize` the write path uses. A bare bound `false` would compare
 *    against nothing on one of the two engines — and the SQLite suite could
 *    never see it. This is the exact class that inverted every ISO-string
 *    timestamp filter on SQLite while Postgres stayed correct (#46).
 *  - **The NULL arm.** `col IS NULL OR col <> value` was chosen over
 *    `IS DISTINCT FROM` because SQLite only learned the latter in 3.39. This
 *    spec is what proves the portable spelling means the same thing on pg.
 *
 * Follows `pg-smoke.test.ts`: pglite's WASM bundle is environment-sensitive, so
 * a harness that fails to boot degrades to a logged skip rather than failing
 * the whole suite.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { makeHarnessPgOrFail, type PgTestHarness } from "./setup-pg";
import { PGLITE_BOOT_TIMEOUT_MS, PGLITE_TEST_TIMEOUT_MS } from "./setup";

let harness: PgTestHarness | undefined;

const slug = "retpg_parts";
const child = "retpg_builds";
const ids: Record<string, string> = {};

const json = (body: unknown, method = "POST"): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

beforeAll(async () => {
  harness = (await makeHarnessPgOrFail("retirement-pg")) ?? undefined;
  if (!harness) return;
  const email = `pg-retire-${Date.now()}@example.test`;
  const signUp = await harness.fetch("/api/auth/sign-up/email", json({
    email,
    password: "correct-horse-battery",
    name: "A",
  }));
  if (!signUp.ok) throw new Error(`sign-up failed: ${signUp.status}`);

  const col = await harness.fetch("/api/collections", json({
    slug,
    fields: [
      { name: "name", type: "text" },
      { name: "active", type: "boolean", default: true, retire: {} },
    ],
  }));
  if (col.status !== 201) throw new Error(`collection failed: ${col.status}`);
  const kid = await harness.fetch("/api/collections", json({
    slug: child,
    fields: [
      { name: "name", type: "text" },
      { name: "part", type: "relation", to: slug },
    ],
  }));
  if (kid.status !== 201) throw new Error(`collection failed: ${kid.status}`);

  for (const [name, active] of [
    ["live", true],
    ["gone", false],
    // The row nobody has answered for — a NULL flag, which is the arm the
    // portable predicate exists for.
    ["unanswered", null],
  ] as const) {
    const r = await harness.fetch(`/api/items/${slug}`, json({ name, active }));
    ids[name] = ((await r.json()) as any).data.id;
  }
}, PGLITE_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await harness?.cleanup();
}, PGLITE_BOOT_TIMEOUT_MS);

/** Only reachable under `BACKLEX_PG_TESTS=optional` — otherwise a harness that
 *  cannot boot has already failed the run in `beforeAll`. */
const skipped = (): boolean => !harness;

const names = async (qs: string): Promise<string[]> => {
  const r = await harness!.fetch(`/api/items/${slug}?sort=name&limit=50${qs}`);
  expect(r.status).toBe(200);
  return ((await r.json()) as any).data.map((x: any) => x.name);
};

test("pg: the default is every row — retirement hides nothing from a read", async () => {
  if (skipped()) return;
  expect(await names("")).toEqual(["gone", "live", "unanswered"]);
}, PGLITE_TEST_TIMEOUT_MS);

test("pg: exclude keeps the NULL flag, and the boolean operand binds", async () => {
  if (skipped()) return;
  // Both halves matter. If the operand were bound as SQLite's 0/1 the query
  // would error or match nothing on pg; if the NULL arm were missing,
  // `unanswered` would silently vanish.
  expect(await names("&retired=exclude")).toEqual(["live", "unanswered"]);
}, PGLITE_TEST_TIMEOUT_MS);

test("pg: only returns just the retired ones — and NOT the NULL one", async () => {
  if (skipped()) return;
  // `exclude` and `only` must partition the table. A row nobody answered for
  // belongs with the live ones, so it appears in neither `only` nor nowhere.
  expect(await names("&retired=only")).toEqual(["gone"]);
}, PGLITE_TEST_TIMEOUT_MS);

test("pg: the retire verb writes a native boolean, and restores it", async () => {
  if (skipped()) return;
  const off = await harness!.fetch(`/api/items/${slug}/${ids.live}/retire`, json({}));
  expect(off.status).toBe(200);
  expect(((await off.json()) as any).data.active).toBe(false);
  expect(await names("&retired=exclude")).toEqual(["unanswered"]);

  const on = await harness!.fetch(`/api/items/${slug}/${ids.live}/retire?restore=1`, json({}));
  expect(on.status).toBe(200);
  expect(((await on.json()) as any).data.active).toBe(true);
  expect(await names("&retired=exclude")).toEqual(["live", "unanswered"]);
}, PGLITE_TEST_TIMEOUT_MS);

test("pg: a new reference to a retired row is refused", async () => {
  if (skipped()) return;
  // The check rides on the existence SELECT, which projects the flag column —
  // a place the two dialects could disagree about what comes back.
  const r = await harness!.fetch(`/api/items/${child}`, json({ name: "b", part: ids.gone }));
  expect(r.status).toBe(422);
  expect(JSON.stringify(await r.json())).toContain("retired");

  const ok = await harness!.fetch(`/api/items/${child}`, json({ name: "b2", part: ids.unanswered }));
  expect(ok.status).toBe(201);
}, PGLITE_TEST_TIMEOUT_MS);
