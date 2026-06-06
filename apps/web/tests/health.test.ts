import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, type TestHarness } from "./setup";

describe("GET /health", () => {
  let h: TestHarness;

  beforeAll(() => {
    h = makeHarness();
  });

  afterAll(() => {
    h.cleanup();
  });

  test("returns ok + sqlite dialect", async () => {
    const res = await h.fetch("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      version: string;
      dialect: string;
      ts: number;
    };
    expect(body.ok).toBe(true);
    expect(body.dialect).toBe("sqlite");
    expect(typeof body.ts).toBe("number");
    // Baked in by vite `define` at template-build time; "dev" under bun test
    // (no define pass). Either way it must be a non-empty string.
    expect(typeof body.version).toBe("string");
    expect(body.version.length).toBeGreaterThan(0);
    // Server-Timing is secret-gated → NOT emitted without the debug header.
    expect(res.headers.get("Server-Timing")).toBeNull();
  });

  test("Server-Timing is emitted only with the matching debug secret header", async () => {
    const dbg = makeHarness({ DEBUG_TIMING_SECRET: "s3cr3t" });
    try {
      // No header → absent.
      expect((await dbg.fetch("/health")).headers.get("Server-Timing")).toBeNull();
      // Wrong header → absent.
      const wrong = await dbg.fetch("/health", { headers: { "x-backlex-timing": "nope" } });
      expect(wrong.headers.get("Server-Timing")).toBeNull();
      // Correct secret → emitted with the total phase.
      const ok = await dbg.fetch("/health", { headers: { "x-backlex-timing": "s3cr3t" } });
      expect(ok.headers.get("Server-Timing")).toContain("total;dur=");
    } finally {
      dbg.cleanup();
    }
  });
});
