/**
 * Postgres coverage for overwrite-mode restore.
 *
 * This is the one place in the wave where the two dialects can genuinely
 * disagree. `ON CONFLICT DO NOTHING` needs no conflict target, so the additive
 * path is dialect-neutral and the SQLite suite covers it. `ON CONFLICT (id) DO
 * UPDATE` does need one, and **Postgres requires the named column to be backed
 * by a real unique index** while SQLite is laxer about it. A restore that works
 * on D1 and throws on Postgres would only show up on a customer's database.
 *
 * Follows `cdc-pg.test.ts`: pglite's WASM bundle is environment-sensitive, so a
 * harness that fails to boot degrades to a logged skip rather than a red suite.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { makeHarnessPg, type PgTestHarness } from "./setup-pg";
import { PGLITE_BOOT_TIMEOUT_MS, PGLITE_TEST_TIMEOUT_MS } from "./setup";

let setupError: Error | undefined;
let harness: PgTestHarness | undefined;

const JSON_HEADERS = { "Content-Type": "application/json" };
const SLUG = "notes";

const post = (path: string, body?: unknown, method = "POST", headers = {}) =>
  harness!.fetch(path, {
    method,
    headers: { ...JSON_HEADERS, ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

interface RestoreData {
  tableCount: number;
  rowCount: number;
  skipped: number;
  overwritten: number;
  keptAdditive: string[];
}

const restore = async (id: string, query = ""): Promise<RestoreData> => {
  const res = await post(
    `/api/admin/db/backups/${id}/restore${query}`,
    undefined,
    "POST",
    { "x-backlex-confirm": "yes" },
  );
  if (!res.ok) throw new Error(`restore failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { data: RestoreData }).data;
};

const backupNow = async (label: string): Promise<string> => {
  const res = await post("/api/admin/db/backups/now", { label });
  if (!res.ok) throw new Error(`backup failed: ${res.status} ${await res.text()}`);
  const data = ((await res.json()) as { data: { id: string; status: string } }).data;
  expect(data.status).toBe("done");
  return data.id;
};

let itemId = "";

beforeAll(async () => {
  try {
    harness = await makeHarnessPg();
  } catch (err) {
    setupError = err instanceof Error ? err : new Error(String(err));
    console.warn("[backup-restore-pg] harness setup failed — skipping:", setupError.message);
    return;
  }
  const signUp = await post("/api/auth/sign-up/email", {
    email: `pg-backup-${Date.now()}@example.test`,
    password: "correct-horse-battery",
    name: "A",
  });
  if (!signUp.ok) throw new Error(`sign-up failed: ${signUp.status}`);

  const made = await post("/api/collections", {
    name: "Notes",
    slug: SLUG,
    fields: [{ name: "title", type: "text", required: true }],
  });
  if (!made.ok) throw new Error(`collection failed: ${made.status} ${await made.text()}`);

  const item = await post(`/api/items/${SLUG}`, { title: "Alpha" });
  if (!item.ok) throw new Error(`item failed: ${item.status} ${await item.text()}`);
  itemId = ((await item.json()) as { data: { id: string } }).data.id;
}, PGLITE_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await harness?.cleanup();
});

test(
  "ON CONFLICT (id) DO UPDATE resolves against a real Postgres unique index",
  async () => {
    if (!harness) return;

    const backupId = await backupNow("pg-overwrite");

    // Change the row without deleting it — the shape `DO NOTHING` skips.
    const patch = await post(`/api/items/${SLUG}/${itemId}`, { title: "Corrupted" }, "PATCH");
    expect(patch.status).toBe(200);

    const readTitle = async (): Promise<string> => {
      const res = await harness!.fetch(`/api/items/${SLUG}/${itemId}`);
      expect(res.status).toBe(200);
      return ((await res.json()) as { data: { title: string } }).data.title;
    };
    expect(await readTitle()).toBe("Corrupted");

    // Additive first: proves the restore reached this row (rowCount > 0) and
    // deliberately left it. Without this, the overwrite assertion below could
    // pass for a restore that simply never ran.
    const additive = await restore(backupId);
    expect(additive.rowCount).toBeGreaterThan(0);
    expect(additive.overwritten).toBe(0);
    expect(await readTitle()).toBe("Corrupted");

    // The actual dialect risk: Postgres rejects a conflict target it cannot
    // match to a unique index, so a wrong target throws here and nowhere else.
    const overwrite = await restore(backupId, "?mode=overwrite");
    expect(overwrite.overwritten).toBeGreaterThan(0);
    expect(await readTitle()).toBe("Alpha");
  },
  PGLITE_TEST_TIMEOUT_MS,
);

test(
  "a composite-key table is reported instead of throwing on a missing target",
  async () => {
    if (!harness) return;
    const backupId = await backupNow("pg-kept-additive");

    // `user_roles` is keyed (user_id, role_id) with no `id` column at all. On
    // Postgres an `ON CONFLICT (id)` against it is a hard error, so this is the
    // dialect where "detect it up front" and "let it throw" actually differ.
    const r = await restore(backupId, "?mode=overwrite");
    expect(r.keptAdditive).toContain("user_roles");
  },
  PGLITE_TEST_TIMEOUT_MS,
);
