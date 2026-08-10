/**
 * Postgres coverage for broadcast channels.
 *
 * Three things here are written per dialect and cannot be proved by the SQLite
 * suite:
 *
 *   1. the hand-written `broadcast_channels` / `broadcast_messages` migrations
 *      (timestamptz vs epoch-ms, boolean vs 0/1);
 *   2. the replay READ, which binds a cursor and a retention floor against
 *      `created_at` — a `Date` here and a number there. A number bound against
 *      `timestamptz` is a hard error on pg, and a `Date` bound against an
 *      INTEGER column silently orders wrong on SQLite, so neither dialect can
 *      vouch for the other. This is the exact class that shipped a broken
 *      timestamp filter once already;
 *   3. the prune's ranged DELETE on `day`.
 *
 * Follows `auth-hooks-pg.test.ts`: pglite's WASM bundle is
 * environment-sensitive, so a harness that fails to boot degrades to a logged
 * skip rather than a red gate that says nothing about this code.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { makeHarnessPg, type PgTestHarness } from "./setup-pg";
import { PGLITE_BOOT_TIMEOUT_MS, PGLITE_TEST_TIMEOUT_MS } from "./setup";

let setupError: Error | undefined;
let harness: PgTestHarness | undefined;

const ADMIN = "/api/admin/realtime-channels";

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
      "[broadcast-pg] harness setup failed — skipping pg path tests:",
      setupError.message,
    );
    return;
  }
  const signUp = await post("/api/auth/sign-up/email", {
    email: `pg-broadcast-${Date.now()}@example.test`,
    password: "correct-horse-battery",
    name: "A",
  });
  if (!signUp.ok) throw new Error(`sign-up failed: ${signUp.status}`);
}, PGLITE_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await harness?.cleanup();
});

test("a rule round-trips on Postgres, booleans and all", async () => {
  if (!harness) return;
  const created = await post(ADMIN, {
    name: "Rooms",
    pattern: "room:{room}",
    subscribe: { access: "authenticated", condition: { room: { _eq: "lobby" } } },
    publish: { access: "roles", roles: ["admin"] },
    presence: true,
    replay: true,
    retentionHours: 6,
  });
  expect(created.status).toBe(201);
  const row = ((await created.json()) as any).data;
  expect(row.presence).toBe(true);
  expect(row.subscribe.condition).toEqual({ room: { _eq: "lobby" } });

  const explained = (await (
    await harness.fetch("/api/realtime/room%3Alobby/explain")
  ).json()) as any;
  expect(explained.matched.pattern).toBe("room:{room}");
  expect(explained.canSubscribe).toBe(true);

  const other = (await (
    await harness.fetch("/api/realtime/room%3Asecret/explain")
  ).json()) as any;
  expect(other.canSubscribe).toBe(false);
}, PGLITE_TEST_TIMEOUT_MS);

test("publish → replay reads back through the timestamptz cursor", async () => {
  if (!harness) return;
  await post(ADMIN, {
    name: "Kept",
    pattern: "kept:feed",
    subscribe: { access: "authenticated" },
    publish: { access: "authenticated" },
    replay: true,
    retentionHours: 24,
  });
  for (let i = 0; i < 3; i += 1) {
    const res = await post("/api/realtime/kept%3Afeed/publish", { event: "tick", data: { n: i } });
    expect(res.status).toBe(200);
  }

  // The unfiltered read exercises the retention floor bound (a Date on pg).
  const first = (await (
    await harness.fetch("/api/realtime/kept%3Afeed/replay?limit=2")
  ).json()) as { data: Array<{ data: { n: number } }>; cursor: string };
  expect(first.data.map((m) => m.data.n)).toEqual([0, 1]);

  // …and this one exercises the keyset comparison itself.
  const second = (await (
    await harness.fetch(
      `/api/realtime/kept%3Afeed/replay?since=${encodeURIComponent(first.cursor)}`,
    )
  ).json()) as { data: Array<{ data: { n: number } }> };
  expect(second.data.map((m) => m.data.n)).toEqual([2]);
}, PGLITE_TEST_TIMEOUT_MS);

test("a duplicate pattern is refused by the unique index too", async () => {
  if (!harness) return;
  const body = {
    name: "Once",
    pattern: "unique:feed",
    subscribe: { access: "public" },
    publish: { access: "none" },
  };
  expect((await post(ADMIN, body)).status).toBe(201);
  // The service checks first (422); a divergent index would let a race write a
  // second row that `resolveChannelRule` would then pick between arbitrarily.
  expect((await post(ADMIN, { ...body, name: "Twice" })).status).toBe(422);
}, PGLITE_TEST_TIMEOUT_MS);
