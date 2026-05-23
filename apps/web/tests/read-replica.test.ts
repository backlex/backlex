import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { makeHarness, type TestHarness } from "./setup";
import { buildContext } from "../src/server/context";

describe("ctx.dbRead", () => {
  let h: TestHarness;

  beforeAll(() => {
    h = makeHarness();
  });

  afterAll(() => {
    h.cleanup();
  });

  test("aliases ctx.db when no replica is configured", async () => {
    const ctx = await buildContext(h.env);
    expect(ctx.dbRead).toBe(ctx.db);
  });

  test("aliases ctx.db on sqlite even if DATABASE_REPLICA_URL is set", async () => {
    // SQLite/D1 deployments don't have a replica equivalent — the env value
    // should be silently ignored so dev SQLite setups don't blow up.
    const h2 = makeHarness({
      DATABASE_REPLICA_URL: "postgres://ignored:5432/db",
    });
    try {
      const ctx = await buildContext(h2.env);
      expect(ctx.dialect).toBe("sqlite");
      expect(ctx.dbRead).toBe(ctx.db);
    } finally {
      h2.cleanup();
    }
  });
});
