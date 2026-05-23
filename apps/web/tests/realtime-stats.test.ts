/**
 * Read-only diagnostic endpoint for the realtime layer. Verifies the response
 * shape, the admin gate, and that subscriber counts actually move when an
 * SSE client connects/disconnects (Bun in-process path — DO path is exercised
 * structurally by the same code paths in production).
 */
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const JSON_HEADERS = { "Content-Type": "application/json" };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("realtime stats — admin endpoint shape + auth", () => {
  let h: TestHarness;
  let slug: string;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    slug = `notes_stats_${Date.now()}`;
    const res = await h.fetch("/api/collections", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        slug,
        fields: [{ name: "title", type: "text" }],
      }),
    });
    expect(res.status).toBe(201);
  });

  afterAll(() => h.cleanup());

  test("GET /api/admin/realtime/channels lists collections + items:<slug>", async () => {
    const res = await h.fetch("/api/admin/realtime/channels");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ channel: string; stats: Record<string, number> }>;
    };
    const names = body.data.map((r) => r.channel);
    expect(names).toContain("collections");
    expect(names).toContain(`items:${slug}`);
    // Every row must carry the four-field shape; zero values are expected
    // on a freshly created collection nobody subscribed to yet.
    for (const row of body.data) {
      expect(row.stats).toEqual({
        connectedSockets: 0,
        presenceMembers: 0,
        currentSeq: 0,
        logSize: 0,
      });
    }
  });

  test("GET /channels/:channel/stats works for arbitrary channel names", async () => {
    // Free-form channel that wasn't enumerated — single-channel lookup still
    // returns a zero-stats row instead of 404.
    const res = await h.fetch(
      `/api/admin/realtime/channels/${encodeURIComponent("presence:room-42")}/stats`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { channel: string; stats: Record<string, number> };
    };
    expect(body.data.channel).toBe("presence:room-42");
    expect(body.data.stats.connectedSockets).toBe(0);
  });
});

describe("realtime stats — admin-only", () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    // Second sign-up lands as `authenticated`, not admin.
    await h.fetch("/api/auth/sign-out", { method: "POST" });
    const res = await h.fetch("/api/auth/sign-up/email", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        email: `noadmin-${Date.now()}@example.test`,
        password: "correct-horse-battery",
        name: "Plain",
      }),
    });
    expect(res.status).toBe(200);
  });

  afterAll(() => h.cleanup());

  test("non-admin → 403", async () => {
    const res = await h.fetch("/api/admin/realtime/channels");
    expect(res.status).toBe(403);
  });
});

describe("realtime stats — subscriber count tracks SSE clients (Bun)", () => {
  let h: TestHarness;
  let slug: string;
  const channel = (s: string) => `items:${s}`;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    slug = `live_${Date.now()}`;
    const create = await h.fetch("/api/collections", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        slug,
        fields: [{ name: "body", type: "text" }],
      }),
    });
    expect(create.status).toBe(201);
  });

  afterAll(() => h.cleanup());

  test("connecting one SSE subscriber bumps connectedSockets to 1", async () => {
    // Open the SSE stream but don't iterate — we just need the connection
    // registered. The Bun in-process path adds the subscriber synchronously
    // on the SSE handler entry, so a short delay is enough.
    const ac = new AbortController();
    const ssePromise = h.fetch(
      `/api/realtime/${encodeURIComponent(channel(slug))}/subscribe`,
      { signal: ac.signal },
    );
    // Let the SSE handler set up its subscriber. 50ms is plenty in-process.
    await sleep(50);

    try {
      const res = await h.fetch(
        `/api/admin/realtime/channels/${encodeURIComponent(channel(slug))}/stats`,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: { stats: { connectedSockets: number } };
      };
      expect(body.data.stats.connectedSockets).toBe(1);
    } finally {
      ac.abort();
      // Swallow the aborted fetch promise so it doesn't surface as an
      // unhandled rejection.
      ssePromise.catch(() => {});
    }
  });
});
