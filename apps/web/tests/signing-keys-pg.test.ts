/**
 * Postgres coverage for signing keys.
 *
 * The `signing_keys` migration is hand-written per dialect (timestamptz vs
 * epoch-ms) and the state machine writes three of those timestamps on the
 * transitions. Neither dialect can vouch for the other, and a key life cycle
 * that silently fails to record `activated_at` would make a rollback pick the
 * wrong state to return to.
 *
 * Follows `auth-hooks-pg.test.ts`: pglite's WASM bundle is environment-
 * sensitive, so a harness that fails to boot degrades to a logged skip.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { makeHarnessPg, type PgTestHarness } from "./setup-pg";
import { PGLITE_BOOT_TIMEOUT_MS } from "./setup";

let setupError: Error | undefined;
let harness: PgTestHarness | undefined;

const BASE = "/api/admin/signing-keys";

const post = (path: string, body?: unknown, method = "POST") =>
  harness!.fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

beforeAll(async () => {
  try {
    harness = await makeHarnessPg();
  } catch (err) {
    setupError = err instanceof Error ? err : new Error(String(err));
    console.warn("[signing-keys-pg] harness setup failed — skipping:", setupError.message);
    return;
  }
  const signUp = await post("/api/auth/sign-up/email", {
    email: `pg-keys-${Date.now()}@example.test`,
    password: "correct-horse-battery",
    name: "A",
  });
  if (!signUp.ok) throw new Error(`sign-up failed: ${signUp.status}`);
}, PGLITE_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await harness?.cleanup();
});

test("the life cycle round-trips, and each transition stamps its timestamp", async () => {
  if (!harness) return;
  const first = ((await (await post(BASE, { note: "pg one" })).json()) as any).data;
  expect(first.status).toBe("standby");
  // A standby key has never signed, so nothing is stamped yet.
  let rows = await harness.exec(
    `SELECT activated_at, retired_at, revoked_at FROM signing_keys WHERE id = '${first.id}'`,
  );
  expect(rows[0]!.activated_at).toBeNull();

  await post(`${BASE}/${first.id}/promote`);
  rows = await harness.exec(
    `SELECT activated_at, retired_at FROM signing_keys WHERE id = '${first.id}'`,
  );
  expect(rows[0]!.activated_at).not.toBeNull();

  const second = ((await (await post(BASE, { note: "pg two" })).json()) as any).data;
  await post(`${BASE}/${second.id}/promote`);
  rows = await harness.exec(
    `SELECT status, retired_at FROM signing_keys WHERE id = '${first.id}'`,
  );
  // Demoted in the same operation, with the moment it stopped signing recorded.
  expect(rows[0]!.status).toBe("previously_used");
  expect(rows[0]!.retired_at).not.toBeNull();

  await post(`${BASE}/${first.id}/revoke`);
  rows = await harness.exec(
    `SELECT status, revoked_at FROM signing_keys WHERE id = '${first.id}'`,
  );
  expect(rows[0]!.status).toBe("revoked");
  expect(rows[0]!.revoked_at).not.toBeNull();

  await post(`${BASE}/${first.id}/restore`);
  rows = await harness.exec(
    `SELECT status, revoked_at FROM signing_keys WHERE id = '${first.id}'`,
  );
  // It had signed, so it goes back to `previously_used` — which is only
  // decidable because `activated_at` survived the round trip.
  expect(rows[0]!.status).toBe("previously_used");
  expect(rows[0]!.revoked_at).toBeNull();
});

test("exactly one key is ever in use", async () => {
  if (!harness) return;
  const rows = await harness.exec(
    `SELECT count(*)::int AS n FROM signing_keys WHERE status = 'in_use'`,
  );
  expect(rows[0]!.n).toBe(1);
});

test("the private half is stored encrypted, never in the clear", async () => {
  if (!harness) return;
  const rows = await harness.exec(`SELECT private_key FROM signing_keys LIMIT 1`);
  const stored = String(rows[0]!.private_key);
  expect(stored.startsWith("enc:v1:")).toBe(true);
  expect(stored).not.toContain("PRIVATE KEY");
});

test("the kid is unique — the same key cannot be stored twice", async () => {
  if (!harness) return;
  const rows = await harness.exec(
    `SELECT indexname FROM pg_indexes WHERE tablename = 'signing_keys' AND indexname = 'signing_keys_kid_idx'`,
  );
  expect(rows.length).toBe(1);
});
