/**
 * An owner-scoped subscriber receives its own rows over SSE.
 *
 * `ownerScoped` collections are seeded with the grant
 * `read: {owner_id: {_eq: "$user.id"}}` for the `authenticated` role, which
 * makes it the most common row condition a realtime subscriber holds. The
 * realtime predicate judges each frame's row with `absentIsUnknown` — a field
 * the frame does not carry is UNKNOWN — and a frame is an API row: it carries
 * the owner as `ownerId`, never as the column name `owner_id` the condition
 * uses. Testing the literal key made `owner_id` absent from every frame, so
 * the condition matched nothing and these subscribers received none of their
 * own rows while REST returned all of them.
 *
 * Driven through the public API end to end, because the claim is about the
 * shape of a REAL frame: an end-user subscribes with their bearer, writes a row
 * of their own, and must see it; a row that is not theirs must stay off the
 * stream, so the spec cannot pass by opening the gate.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "../setup";

const JSON_HEADERS = { "content-type": "application/json" };
const OBSERVE_MS = 1_500;

interface Frame {
  event: string;
  data: string;
}

/** Open an SSE subscription as `token` and pump every frame into a buffer. */
const openStream = async (h: TestHarness, channel: string, token: string) => {
  const ac = new AbortController();
  const res = await h.app.fetch(
    new Request(`http://localhost:5173/api/realtime/${channel}/subscribe`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: ac.signal,
    }),
  );
  // Read the body only on failure: a 200 is a stream that never ends.
  if (res.status !== 200) throw new Error(`subscribe failed: ${res.status} ${await res.text()}`);
  const frames: Frame[] = [];
  void (async () => {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
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
          for (const line of block.split("\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) data += line.slice(5).trimStart();
          }
          frames.push({ event, data });
        }
      }
    } catch {
      // aborted
    }
  })();
  const waitFor = async (pred: (f: Frame) => boolean, ms = OBSERVE_MS) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const hit = frames.find(pred);
      if (hit) return hit;
      if (Date.now() >= deadline) return null;
      await new Promise((r) => setTimeout(r, 15));
    }
  };
  expect(await waitFor((f) => f.event === "ready"), "ready frame").not.toBeNull();
  return { frames, waitFor, abort: () => ac.abort() };
};

const makeEndUser = async (h: TestHarness, email: string): Promise<{ id: string; token: string }> => {
  const invited = await h.fetch("/api/app-users/invite", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ email }),
  });
  expect(invited.status, `invite ${email}`).toBe(201);
  const { data } = (await invited.json()) as { data: { id: string; token: string } };
  const accepted = await h.app.request("/api/t/default/auth/invite/accept", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ token: data.token, password: "owner-scoped-pass-1234" }),
  });
  expect(accepted.status, `accept ${email}`).toBe(200);
  return { id: data.id, token: ((await accepted.json()) as { token: string }).token };
};

describe("realtime — an owner-scoped subscriber sees its own rows", () => {
  let h: TestHarness;
  let alice: { id: string; token: string };
  let bob: { id: string; token: string };
  const slug = "own_notes";

  const writeAs = async (token: string, title: string): Promise<string> => {
    const res = await h.app.request(`/api/items/${slug}`, {
      method: "POST",
      headers: { ...JSON_HEADERS, Authorization: `Bearer ${token}` },
      body: JSON.stringify({ title }),
    });
    expect(res.status, `create "${title}": ${await res.clone().text()}`).toBe(201);
    return String(((await res.json()) as { data: { id: unknown } }).data.id);
  };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const created = await h.fetch("/api/collections", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ slug, ownerScoped: true, fields: [{ name: "title", type: "text" }] }),
    });
    expect(created.status).toBe(201);
    alice = await makeEndUser(h, "alice@owner-scoped.test");
    bob = await makeEndUser(h, "bob@owner-scoped.test");
  });
  afterAll(() => h.cleanup());

  test("a row the subscriber owns arrives; a row it does not own does not", async () => {
    const stream = await openStream(h, `items:${slug}`, alice.token);
    try {
      const mine = await writeAs(alice.token, "alice's note");
      const theirs = await writeAs(bob.token, "bob's note");

      const frame = await stream.waitFor((f) => f.event === "message" && f.data.includes(mine));
      expect(frame, "alice must receive the row she owns").not.toBeNull();
      const payload = JSON.parse(frame!.data) as { event: string; data: Record<string, unknown> };
      expect(payload.event).toBe("created");
      // The frame names the owner the way the API does — which is the whole case.
      expect(payload.data.ownerId).toBe(alice.id);
      expect(Object.hasOwn(payload.data, "owner_id")).toBe(false);

      // Give bob's frame every chance to arrive before asserting it did not.
      await new Promise((r) => setTimeout(r, 300));
      expect(stream.frames.filter((f) => f.data.includes(theirs))).toEqual([]);
    } finally {
      stream.abort();
    }
  });
});
