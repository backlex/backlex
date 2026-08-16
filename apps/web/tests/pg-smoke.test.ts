/**
 * Smoke test for the Postgres path. Mirrors a tiny slice of the SQLite-only
 * test surface to make sure the pg migrations apply cleanly under pglite
 * and that the request pipeline (auth + collections list) works on the
 * postgres dialect. Acts as a regression guard for pg-only code paths
 * (jsonb columns, pgvector tables) that the SQLite suite never exercises.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { makeHarnessPgOrFail, type PgTestHarness } from "./setup-pg";
import { PGLITE_BOOT_TIMEOUT_MS, PGLITE_TEST_TIMEOUT_MS } from "./setup";

let harness: PgTestHarness | undefined;

// pglite unpacks a WASM postgres + pgvector tarball at boot; on a cold CI
// runner that can easily exceed bun-test's default 5s beforeAll timeout, so
// bump generously.
//
// A boot failure now FAILS rather than skipping — see `makeHarnessPgOrFail`.
// The comment that used to sit here said pgvector's load is
// "environment-sensitive" and that a real CI runner "can flip these tests
// on". Both halves were wrong, and together they are how this spec spent a
// stretch silently asserting nothing: pglite ships the server and the
// extension inside the dependency tree, there is nothing for a runner to
// provide, and the real cause was a positional `drizzle(pg)` call that
// handed every query an empty database.
beforeAll(async () => {
  harness = (await makeHarnessPgOrFail("pg-smoke")) ?? undefined;
}, PGLITE_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await harness?.cleanup();
}, PGLITE_BOOT_TIMEOUT_MS);

test("pg: sign-up + list collections", async () => {
  // Only reachable under `BACKLEX_PG_TESTS=optional`; otherwise `beforeAll`
  // has already failed the run. (The old comment here claimed bun exits 100
  // for a test with zero `expect()` calls, which motivated a sentinel
  // assertion — measured on bun 1.4 and it does not. The real exit-100 hazard
  // is an unclosed PGlite handle, which `makeHarnessPg` already guards.)
  if (!harness) return;
  const email = `pg-admin-${Date.now()}@example.test`;
  const password = "correct-horse-battery";

  const signUp = await harness.fetch("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, name: "PG Admin" }),
  });
  expect(signUp.ok).toBe(true);

  const collections = await harness.fetch("/api/collections");
  expect(collections.ok).toBe(true);
  const body = (await collections.json()) as { data: unknown[] };
  expect(Array.isArray(body.data)).toBe(true);
}, PGLITE_TEST_TIMEOUT_MS);
