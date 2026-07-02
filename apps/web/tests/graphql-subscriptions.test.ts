/**
 * GraphQL subscriptions over SSE (`/api/graphql/stream`, graphql-sse
 * distinct-connections mode). The handler delegates to the realtime layer, so
 * these specs exercise the in-process transport end-to-end: REST writes must
 * surface as `event: next` frames carrying `{ data: { items: <event> } }`
 * envelopes, with the live-query filter + field selection applied.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const SLUG = "gql_sub_notes";
let h: TestHarness;

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface OpenStream {
  /** Frames received so far (split on the SSE frame boundary). */
  frames: () => string[];
  /** Wait until a frame matching `test` arrives (or time out). */
  waitFor: (test: (frame: string) => boolean, timeoutMs?: number) => Promise<string>;
  close: () => void;
}

const openStream = async (query: string, variables?: unknown): Promise<OpenStream> => {
  const ac = new AbortController();
  const res = await h.fetch("/api/graphql/stream", {
    ...json({ query, variables }),
    signal: ac.signal,
  });
  if (res.status !== 200 || !res.body) {
    ac.abort();
    throw new Error(`stream open failed: ${res.status} ${await res.text()}`);
  }
  const received: string[] = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  void (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx = buffer.indexOf("\n\n");
        while (idx >= 0) {
          received.push(buffer.slice(0, idx));
          buffer = buffer.slice(idx + 2);
          idx = buffer.indexOf("\n\n");
        }
      }
    } catch {
      // aborted
    }
  })();
  // Let the subscriber register on the channel before the caller writes.
  await sleep(50);
  return {
    frames: () => [...received],
    waitFor: async (match, timeoutMs = 3_000) => {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        const hit = received.find(match);
        if (hit) return hit;
        await sleep(25);
      }
      throw new Error(`no matching frame; got:\n${received.join("\n---\n")}`);
    },
    close: () => ac.abort(),
  };
};

const createItem = async (title: string): Promise<void> => {
  const res = await h.fetch(`/api/items/${SLUG}`, json({ title }));
  if (res.status !== 201) throw new Error(`item create failed: ${res.status}`);
};

beforeAll(async () => {
  h = makeHarness();
  await seedAdmin(h);
  const res = await h.fetch(
    "/api/collections",
    json({ slug: SLUG, fields: [{ name: "title", type: "text", required: true }] }),
  );
  if (res.status !== 201) throw new Error(`collection create failed: ${res.status}`);
});

afterAll(() => h.cleanup());

describe("graphql subscriptions over SSE", () => {
  test("created items arrive as graphql-sse `next` frames", async () => {
    const s = await openStream(
      `subscription { items(collection: "${SLUG}") { event data } }`,
    );
    try {
      await createItem("hello-subscription");
      const frame = await s.waitFor((f) => f.includes("event: next"));
      const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
      const envelope = JSON.parse(dataLine!.slice(5)) as {
        data: { items: { event: string; data: { title: string } } };
      };
      expect(envelope.data.items.event).toBe("created");
      expect(envelope.data.items.data.title).toBe("hello-subscription");
    } finally {
      s.close();
    }
  });

  test("field selection projects the payload", async () => {
    const s = await openStream(
      `subscription { items(collection: "${SLUG}") { event } }`,
    );
    try {
      await createItem("projected");
      const frame = await s.waitFor((f) => f.includes("event: next"));
      const envelope = JSON.parse(frame.split("\n").find((l) => l.startsWith("data:"))!.slice(5)) as {
        data: { items: Record<string, unknown> };
      };
      expect(envelope.data.items.event).toBe("created");
      expect(envelope.data.items.data).toBeUndefined();
    } finally {
      s.close();
    }
  });

  test("the filter argument narrows the stream server-side", async () => {
    const s = await openStream(
      `subscription($f: JSON) { items(collection: "${SLUG}", filter: $f) { event data } }`,
      { f: { title: { _eq: "wanted" } } },
    );
    try {
      await createItem("unwanted");
      await createItem("wanted");
      const frame = await s.waitFor((f) => f.includes("event: next"));
      const envelope = JSON.parse(frame.split("\n").find((l) => l.startsWith("data:"))!.slice(5)) as {
        data: { items: { data: { title: string } } };
      };
      // The first (and only) delivered event is the matching row.
      expect(envelope.data.items.data.title).toBe("wanted");
      expect(s.frames().filter((f) => f.includes("event: next"))).toHaveLength(1);
    } finally {
      s.close();
    }
  });

  test("aliases are honored in the envelope", async () => {
    const s = await openStream(
      `subscription { notes: items(collection: "${SLUG}") { event } }`,
    );
    try {
      await createItem("aliased");
      const frame = await s.waitFor((f) => f.includes("event: next"));
      expect(frame).toContain('"notes"');
    } finally {
      s.close();
    }
  });

  test("rejects non-subscription documents and missing collections", async () => {
    const q = await h.fetch(
      "/api/graphql/stream",
      json({ query: `query { items(collection: "${SLUG}") { event } }` }),
    );
    expect(q.status).toBe(422);

    const missing = await h.fetch(
      "/api/graphql/stream",
      json({ query: `subscription { items(collection: "does_not_exist") { event } }` }),
    );
    expect(missing.status).toBeGreaterThanOrEqual(400);
  });

  test("requires authentication", async () => {
    const anon = makeHarness({ SQLITE_PATH: h.env.SQLITE_PATH });
    const res = await anon.fetch(
      "/api/graphql/stream",
      json({ query: `subscription { items(collection: "${SLUG}") { event } }` }),
    );
    expect([401, 403]).toContain(res.status);
  });
});
