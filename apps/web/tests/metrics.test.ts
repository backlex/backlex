/**
 * Metrics overview endpoint (`GET /api/admin/metrics/overview`).
 *
 * Regression test: `recentErrors` used to iterate the full 5000-row activity
 * fetch without applying the `range` window, so the panel would list errors
 * from days ago even when the header said "last 1h · 0 events". The fix added
 * the same `ts < start` filter the totals/series loops use — this suite
 * pins it down by seeding errors both inside and outside the window.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const JSON_HEADERS = { "Content-Type": "application/json" };
const HOUR = 60 * 60 * 1000;

const sqlEscape = (s: string) => s.replace(/'/g, "''");

const insertErrorRow = (
  h: TestHarness,
  row: { id: string; action: string; collection: string; createdAt: number; code: string },
) =>
  h.fetch("/api/admin/db/sql/run?writes=1", {
    method: "POST",
    headers: { ...JSON_HEADERS, "x-backlex-confirm": "yes" },
    body: JSON.stringify({
      sql:
        "INSERT INTO activity (id, action, collection, payload, created_at) VALUES (" +
        `'${sqlEscape(row.id)}', ` +
        `'${sqlEscape(row.action)}', ` +
        `'${sqlEscape(row.collection)}', ` +
        `'${sqlEscape(JSON.stringify({ code: row.code, error: `${row.action} failed`, message: `${row.action} failed` }))}', ` +
        `${row.createdAt})`,
    }),
  });

interface OverviewResponse {
  data: {
    range: string;
    totals: { errors: number; requests: number };
    recentErrors: { code: string; resource: string; count: number; last: number }[];
  };
}

describe("metrics overview: recentErrors respects the range window", () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);

    const now = Date.now();
    // Inside the 1h window (~30 minutes ago) — should show up.
    for (let i = 0; i < 3; i++) {
      const r = await insertErrorRow(h, {
        id: `recent-${i}`,
        action: "function.invoke",
        collection: "system_functions",
        createdAt: now - 30 * 60 * 1000,
        code: "RECENT_ERR",
      });
      expect(r.status).toBe(200);
    }
    // Outside the 1h window (~5 hours ago) — must NOT show up at range=1h.
    for (let i = 0; i < 4; i++) {
      const r = await insertErrorRow(h, {
        id: `old-${i}`,
        action: "flow.run",
        collection: "system_flows",
        createdAt: now - 5 * HOUR,
        code: "OLD_ERR",
      });
      expect(r.status).toBe(200);
    }
  });

  afterAll(() => h.cleanup());

  test("range=1h excludes errors older than the window", async () => {
    const res = await h.fetch("/api/admin/metrics/overview?range=1h");
    expect(res.status).toBe(200);
    const body = (await res.json()) as OverviewResponse;

    const codes = body.data.recentErrors.map((e) => e.code);
    expect(codes).toContain("RECENT_ERR");
    expect(codes).not.toContain("OLD_ERR");

    // Counts in the panel should also match the window — the recent bucket
    // had 3 rows; the old bucket's 4 rows must not bleed into it.
    const recent = body.data.recentErrors.find((e) => e.code === "RECENT_ERR");
    expect(recent?.count).toBe(3);

    // And the header total stays consistent with the panel.
    expect(body.data.totals.errors).toBe(3);
  });

  test("range=24h includes the older errors", async () => {
    const res = await h.fetch("/api/admin/metrics/overview?range=24h");
    expect(res.status).toBe(200);
    const body = (await res.json()) as OverviewResponse;

    const codes = body.data.recentErrors.map((e) => e.code);
    expect(codes).toContain("RECENT_ERR");
    expect(codes).toContain("OLD_ERR");
    expect(body.data.totals.errors).toBe(7);
  });
});
