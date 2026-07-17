/**
 * Regression for the `ensureDefaultTenant` check-then-insert race.
 *
 * Concurrent cold requests with no tenant context all pass the empty
 * `slug = 'default'` select, then all try to INSERT the default tenant — the
 * UNIQUE(slug) constraint made every loser bubble a 500 (seen as a
 * first-probe /health 500 in the cloudflare runtime smoke). Same bug class as
 * the app_settings upsert race (settings-upsert-race.test.ts): fixed with
 * `onConflictDoNothing` + reading the winner's row back.
 *
 * The race is pinned at the service level (direct concurrent calls) because
 * in-process HTTP requests interleave too coarsely to hit the window
 * reliably; an HTTP-level sweep is kept as a smoke check on top.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { makeHarness, type TestHarness } from "./setup";
import {
  ensureDefaultTenant,
  DEFAULT_TENANT_SLUG,
  type DbCtx,
} from "../src/server/services/seed";
import { invalidateAllPermissions } from "../src/server/services/permissions-cache";
import { drizzle } from "drizzle-orm/bun-sqlite";

describe("default-tenant creation race", () => {
  let h: TestHarness;
  beforeAll(() => {
    // No seedAdmin: the default tenant must not exist yet — the race only
    // happens on the very first cold calls.
    h = makeHarness();
  });
  afterAll(() => h.cleanup());

  test("concurrent ensureDefaultTenant calls agree on one id and never throw", async () => {
    // The module-global tenant-resolve cache would short-circuit the race —
    // clear it so every call takes the cold select-then-insert path.
    invalidateAllPermissions();
    const client = new Database(h.env.SQLITE_PATH as string);
    try {
      const ctx = { db: drizzle({ client }), dialect: "sqlite" } as unknown as DbCtx;
      const ids = await Promise.all(
        Array.from({ length: 8 }, () => {
          invalidateAllPermissions();
          return ensureDefaultTenant(ctx);
        }),
      );
      // Every racer resolves the SAME winning id — no UNIQUE-constraint throw,
      // no loser returning a phantom id that isn't in the table.
      expect(new Set(ids).size).toBe(1);

      const row = client
        .query("SELECT COUNT(*) AS n, MIN(id) AS id FROM tenants WHERE slug = ?")
        .get(DEFAULT_TENANT_SLUG) as { n: number; id: string };
      expect(row.n).toBe(1);
      expect(ids[0]).toBe(row.id);
    } finally {
      client.close();
    }
  });

  test("HTTP smoke: concurrent cold public requests all succeed", async () => {
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => h.fetch("/api/i18n")),
    );
    for (const res of responses) {
      expect(res.status).toBe(200);
    }
  });
});
