/**
 * Regression: concurrent PATCH /api/admin/settings for a not-yet-existing
 * tenant-scoped key must not 500. The old select-then-insert/update was a
 * check-then-act race — two concurrent writers both saw "no row", both
 * INSERTed, and the loser hit `UNIQUE constraint failed: app_settings.
 * tenant_id, app_settings.key` (a 500, reproduced live via a concurrent-write
 * load test). The atomic `onConflictDoUpdate` collapses that to one write.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

describe("settings upsert — concurrent PATCH", () => {
  let h: TestHarness;
  afterEach(() => h?.cleanup());

  const patch = (body: unknown): RequestInit => ({
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  test("many concurrent PATCHes to a fresh key all succeed (no UNIQUE 500)", async () => {
    h = makeHarness();
    await seedAdmin(h);

    // Fire a burst at the same fresh, tenant-scoped key. Before the fix this
    // intermittently 500'd on the losing INSERT.
    const N = 16;
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        h.fetch("/api/admin/settings", patch({ schemaSnapshotSchedule: "daily" })),
      ),
    );
    const statuses = results.map((r) => r.status);
    expect(statuses.every((s) => s === 200)).toBe(true);
    expect(statuses.filter((s) => s >= 500)).toHaveLength(0);

    // The value persisted exactly once — a later GET reflects it (and the
    // unique index guarantees a single row).
    const get = await h.fetch("/api/admin/settings");
    const cfg = ((await get.json()) as { data: Record<string, unknown> }).data;
    expect(cfg.schemaSnapshotSchedule).toBe("daily");
  });

  test("insert-then-update path still updates in place", async () => {
    h = makeHarness();
    await seedAdmin(h);
    expect((await h.fetch("/api/admin/settings", patch({ schemaSnapshotSchedule: "daily" }))).status).toBe(200);
    expect((await h.fetch("/api/admin/settings", patch({ schemaSnapshotSchedule: "weekly" }))).status).toBe(200);
    const cfg = ((await (await h.fetch("/api/admin/settings")).json()) as { data: Record<string, unknown> }).data;
    expect(cfg.schemaSnapshotSchedule).toBe("weekly");
  });
});
