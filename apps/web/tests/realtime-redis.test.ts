/**
 * Unit test for the Upstash Redis realtime transport wire logic
 * (`services/realtime-redis.ts`). Mocks `fetch` to assert the exact Redis
 * commands sent over the Upstash REST API and the parsing of their replies.
 *
 * The live SSE-on-Lambda behaviour (poll loop, reconnect) is integration-level
 * and needs a real Upstash + serverless deploy; this covers the deterministic
 * publish/read/encode surface.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Env } from "../src/server/env";
import {
  redisLatestId,
  redisPublish,
  redisRealtimeEnabled,
  redisReadSince,
} from "../src/server/services/realtime-redis";

const env = {
  UPSTASH_REDIS_REST_URL: "https://example.upstash.io",
  UPSTASH_REDIS_REST_TOKEN: "tok",
} as unknown as Env;

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Capture the command args of the next fetch and return a canned `result`. */
function mockRedis(result: unknown): { args: () => (string | number)[] } {
  let captured: (string | number)[] = [];
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    captured = JSON.parse(init.body);
    return new Response(JSON.stringify({ result }), { status: 200 });
  }) as unknown as typeof fetch;
  return { args: () => captured };
}

describe("redis realtime transport", () => {
  test("redisRealtimeEnabled reflects both env vars", () => {
    expect(redisRealtimeEnabled(env)).toBe(true);
    expect(redisRealtimeEnabled({} as Env)).toBe(false);
    expect(
      redisRealtimeEnabled({ UPSTASH_REDIS_REST_URL: "x" } as Env),
    ).toBe(false);
  });

  test("redisPublish XADDs to the channel stream and returns the id", async () => {
    const m = mockRedis("1700000000000-0");
    const id = await redisPublish(env, "items:posts", { event: "created", data: { id: "1" } });
    expect(id).toBe("1700000000000-0");
    const a = m.args();
    expect(a[0]).toBe("XADD");
    expect(a[1]).toBe("rt:items:posts");
    expect(a).toContain("MAXLEN");
    expect(a[a.length - 2]).toBe("d");
    expect(JSON.parse(String(a[a.length - 1]))).toEqual({
      event: "created",
      data: { id: "1" },
    });
  });

  test("redisReadSince uses an exclusive range and decodes payloads", async () => {
    const m = mockRedis([
      ["1700000000001-0", ["d", JSON.stringify({ event: "updated", data: { id: "2" } })]],
      ["1700000000002-0", ["d", JSON.stringify({ event: "deleted", data: { id: "3" } })]],
    ]);
    const out = await redisReadSince(env, "items:posts", "1700000000000-0");
    const a = m.args();
    expect(a[0]).toBe("XRANGE");
    expect(a[2]).toBe("(1700000000000-0"); // exclusive start
    expect(a[3]).toBe("+");
    expect(out).toEqual([
      { id: "1700000000001-0", payload: { event: "updated", data: { id: "2" } } },
      { id: "1700000000002-0", payload: { event: "deleted", data: { id: "3" } } },
    ]);
  });

  test("redisReadSince from cursor 0 reads from the start", async () => {
    const m = mockRedis([]);
    await redisReadSince(env, "c", "0");
    expect(m.args()[2]).toBe("-");
  });

  test("redisLatestId returns last id or 0 when empty", async () => {
    mockRedis([["1700000000009-0", ["d", "{}"]]]);
    expect(await redisLatestId(env, "c")).toBe("1700000000009-0");
    mockRedis(null);
    expect(await redisLatestId(env, "c")).toBe("0");
  });
});
