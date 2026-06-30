/**
 * Reactive invalidation Stage 2 over SSE: a `?filter=` subscription gets
 * server-computed membership TRANSITIONS. The decisive case is `leave` — an
 * update that pushes a row OUT of the result set is still delivered (so the
 * client drops it), even though the after-row fails the filter. Stage 1 alone
 * would have silently dropped it, leaving the client stale.
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

describe("reactive membership transitions over SSE (Stage 2)", () => {
  let h: TestHarness;
  const slug = `rtt_${Date.now()}`;
  let id = "";

  const subscribe = async (filter: object) => {
    const ac = new AbortController();
    const headers: Record<string, string> = { Origin: "http://localhost:5173" };
    const ck = Object.entries(h.cookies())
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
    if (ck) headers.Cookie = ck;
    const qs = `?filter=${encodeURIComponent(JSON.stringify(filter))}`;
    const res = await h.app.fetch(
      new Request(
        `http://localhost:5173/api/realtime/items:${slug}/subscribe${qs}`,
        { headers, signal: ac.signal },
      ),
    );
    return { res, abort: () => ac.abort() };
  };

  const patch = (body: object) =>
    h.fetch(`/api/items/${slug}/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    await h.fetch("/api/collections", {
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
    // Start OUT of the filtered window (done:true).
    const r = await h.fetch(`/api/items/${slug}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "task", done: true }),
    });
    id = ((await r.json()) as { data: { id: string } }).data.id;
  });
  afterAll(() => h.cleanup());

  test("enter then leave are both delivered with the right transition", async () => {
    const { res, abort } = await subscribe({ done: { _eq: false } });
    expect(res.status).toBe(200);
    const iter = readSSE(res);
    const ready = await iter.next();
    expect(ready.value?.event).toBe("ready");

    const frames: { transition?: string; event: string }[] = [];
    const collect = (async () => {
      for await (const f of iter) {
        if (f.event !== "message") continue;
        const p = JSON.parse(f.data) as { event: string; transition?: string };
        frames.push({ event: p.event, transition: p.transition });
        if (frames.length >= 2) break;
      }
    })();

    // ENTER: done true → false (was out, now in).
    expect((await patch({ done: false })).status).toBeLessThan(400);
    // LEAVE: done false → true (was in, now out) — the after-row FAILS the
    // filter, yet must still be delivered so the client drops it.
    expect((await patch({ done: true })).status).toBeLessThan(400);

    await Promise.race([collect, new Promise((r) => setTimeout(r, 1500))]);
    abort();

    expect(frames.length).toBe(2);
    expect(frames[0]?.transition).toBe("enter");
    expect(frames[1]?.transition).toBe("leave");
  });
});
