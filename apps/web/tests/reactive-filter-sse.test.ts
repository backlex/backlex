/**
 * Reactive invalidation Stage 1, end-to-end over SSE: a `?filter=` subscription
 * receives ONLY the events whose row matches the filter (server-side narrowing),
 * and a filter that references an unknown / unreadable / nested field is rejected
 * at subscribe time (so a subscriber can't probe columns it can't read).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type TestHarness, makeHarness, seedAdmin } from "./setup";

interface SSEFrame {
  event: string;
  data: string;
}

async function* readSSE(res: Response): AsyncGenerator<SSEFrame> {
  if (!res.body) throw new Error("no body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        if (!block || block.startsWith(":")) continue;
        let event = "message";
        let data = "";
        for (const raw of block.split("\n")) {
          if (raw.startsWith("event:")) event = raw.slice(6).trim();
          else if (raw.startsWith("data:")) data += raw.slice(5).trimStart();
        }
        yield { event, data };
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* released */
    }
  }
}

describe("reactive filter over SSE (Stage 1)", () => {
  let h: TestHarness;
  const slug = `rtf_${Date.now()}`;

  const cookieHeader = () =>
    Object.entries(h.cookies())
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");

  const subscribe = async (filter?: object) => {
    const ac = new AbortController();
    const headers: Record<string, string> = { Origin: "http://localhost:5173" };
    const ck = cookieHeader();
    if (ck) headers.Cookie = ck;
    const qs = filter ? `?filter=${encodeURIComponent(JSON.stringify(filter))}` : "";
    const res = await h.app.fetch(
      new Request(
        `http://localhost:5173/api/realtime/items:${slug}/subscribe${qs}`,
        { headers, signal: ac.signal },
      ),
    );
    return { res, abort: () => ac.abort() };
  };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const r = await h.fetch("/api/collections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slug,
        fields: [
          { name: "title", type: "text", required: true },
          { name: "done", type: "boolean" },
        ],
      }),
    });
    expect(r.status).toBe(201);
  });
  afterAll(() => h.cleanup());

  test("only filter-matching events are delivered", async () => {
    const { res, abort } = await subscribe({ done: { _eq: false } });
    expect(res.status).toBe(200);
    const iter = readSSE(res);
    // Wait for ready so the subscriber is registered before we publish.
    const ready = await iter.next();
    expect(ready.value?.event).toBe("ready");

    // One matching (done:false) + one non-matching (done:true) write.
    await h.fetch(`/api/items/${slug}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "keep", done: false }),
    });
    await h.fetch(`/api/items/${slug}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "drop", done: true }),
    });

    // Collect messages for a short window.
    const seen: string[] = [];
    const collect = (async () => {
      for await (const f of iter) {
        if (f.event === "message") {
          const p = JSON.parse(f.data) as { data: { title: string } };
          seen.push(p.data.title);
        }
      }
    })();
    await Promise.race([collect, new Promise((r) => setTimeout(r, 800))]);
    abort();

    expect(seen).toContain("keep");
    expect(seen).not.toContain("drop"); // filtered server-side
  });

  test("filter on an unknown field is rejected at subscribe", async () => {
    const { res, abort } = await subscribe({ nope: { _eq: 1 } });
    expect(res.status).toBe(422);
    abort();
  });

  test("filter on a nested relation path is rejected", async () => {
    const { res, abort } = await subscribe({ "title.x": { _eq: 1 } });
    expect(res.status).toBe(422);
    abort();
  });
});
