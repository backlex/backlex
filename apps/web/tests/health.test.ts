import { describe, expect, test, afterAll, beforeAll } from "bun:test";
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
    const body = (await res.json()) as { ok: boolean; dialect: string; ts: number };
    expect(body.ok).toBe(true);
    expect(body.dialect).toBe("sqlite");
    expect(typeof body.ts).toBe("number");
  });
});
