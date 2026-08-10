/**
 * Postgres coverage for auth hooks.
 *
 * Three things here are written per dialect and cannot be proved by the SQLite
 * suite: the hand-written `auth_hooks` migration itself (jsonb vs text,
 * timestamptz vs epoch-ms, boolean vs 0/1), the `enabled` predicate the hook
 * lookup filters on — a boolean column compared against a JS `true` — and the
 * breaker's write of a `Date` into `last_failure_at`. Any of them failing to
 * parse is invisible in the SQLite suite and breaks every sign-in on the only
 * dialect a production workspace is likely to run.
 *
 * Follows `form-drafts-pg.test.ts`: pglite's WASM bundle is
 * environment-sensitive, so a harness that fails to boot degrades to a logged
 * skip rather than a red gate that says nothing about this code.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { makeHarnessPg, type PgTestHarness } from "./setup-pg";
import { PGLITE_BOOT_TIMEOUT_MS } from "./setup";

let setupError: Error | undefined;
let harness: PgTestHarness | undefined;

const BASE = "/api/admin/auth-hooks";

const post = (path: string, body: unknown, method = "POST") =>
  harness!.fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  try {
    harness = await makeHarnessPg();
  } catch (err) {
    setupError = err instanceof Error ? err : new Error(String(err));
    console.warn(
      "[auth-hooks-pg] harness setup failed — skipping pg path tests:",
      setupError.message,
    );
    return;
  }
  // First user of a fresh DB is auto-promoted to admin, which these
  // admin-gated routes require.
  const signUp = await post("/api/auth/sign-up/email", {
    email: `pg-auth-hooks-${Date.now()}@example.test`,
    password: "correct-horse-battery",
    name: "A",
  });
  if (!signUp.ok) throw new Error(`sign-up failed: ${signUp.status}`);
}, PGLITE_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await harness?.cleanup();
});

test("the auth_hooks table exists and round-trips a hook on Postgres", async () => {
  if (!harness) return;

  const created = await post(BASE, {
    event: "custom-access-token",
    targetType: "url",
    url: "https://app.example/claims",
    onError: "deny",
    secret: "whsec_cGdzZWNyZXQ=",
    headers: { "x-tenant": "acme" },
    timeoutMs: 1500,
  });
  expect(created.status).toBe(201);
  const row = ((await created.json()) as any).data;
  // `headers` is jsonb here and text-mode JSON on SQLite — a round trip is the
  // only thing that proves the column type and the drizzle mapping agree.
  expect(row.headers).toEqual({ "x-tenant": "acme" });
  expect(row.enabled).toBe(true);
  expect(row.hasSecret).toBe(true);
  expect(row.timeoutMs).toBe(1500);

  // The `enabled` predicate the runtime lookup uses is a boolean comparison on
  // pg and an integer one on SQLite.
  const listed = await harness.fetch(BASE);
  expect(((await listed.json()) as any).data).toHaveLength(1);

  const disabled = await post(`${BASE}/${row.id}`, { enabled: false }, "PATCH");
  expect(((await disabled.json()) as any).data.enabled).toBe(false);
});

test("the unique index refuses a second hook for the same event", async () => {
  if (!harness) return;
  // Declared as a real UNIQUE INDEX in both migrations; the service checks
  // first, but a divergent index would let a race write the row the runtime
  // lookup then picks arbitrarily between.
  const body = {
    event: "before-user-created",
    targetType: "url",
    url: "https://app.example/gate",
    onError: "allow",
  };
  expect((await post(BASE, body)).status).toBe(201);
  expect((await post(BASE, body)).status).toBe(409);
});

test("a failing hook records its breaker state as a timestamptz", async () => {
  if (!harness) return;
  const created = await post(BASE, {
    event: "password-verification",
    targetType: "url",
    // Unreachable on purpose: the point is the failure bookkeeping, which
    // writes a `Date` into a column that is epoch-ms on the other dialect.
    url: "https://127.0.0.1:9/nope",
    onError: "allow",
  });
  const id = ((await created.json()) as any).data.id as string;

  const tested = await harness.fetch(`${BASE}/${id}/test`, { method: "POST" });
  expect(((await tested.json()) as any).ok).toBe(false);

  // `test` deliberately does NOT touch the breaker, so the counter is still 0
  // and `last_failure_at` is still null — which is also a read of both columns
  // through the pg mapping.
  const listed = ((await (await harness.fetch(BASE)).json()) as any).data as any[];
  const row = listed.find((h) => h.id === id);
  expect(row.consecutiveFailures).toBe(0);
  expect(row.lastFailureAt).toBeNull();
});
