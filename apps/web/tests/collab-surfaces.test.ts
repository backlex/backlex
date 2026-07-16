/**
 * Collaboration channels (`collab:item:<slug>:<id>`) — gate + protocol surface.
 *
 * Covers: transport capability endpoint, the auth/permission gate on subscribe,
 * channel shape validation, publish schema validation (including the strict
 * rejection of client-supplied identity), and server-side identity stamping on
 * the delivered message.
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

const firstMessage = async (gen: AsyncGenerator<SSEFrame>): Promise<SSEFrame> => {
  for await (const frame of gen) {
    if (frame.event === "message") return frame;
  }
  throw new Error("SSE stream ended before a message frame");
};

describe("collab channels", () => {
  let h: TestHarness;
  const slug = `collab_${Date.now()}`;
  let adminCookie = "";
  let adminId = "";

  const request = (path: string, init: RequestInit = {}, cookie?: string) => {
    const headers = new Headers(init.headers ?? {});
    headers.set("Origin", "http://localhost:5173");
    if (cookie) headers.set("Cookie", cookie);
    return h.app.fetch(new Request(`http://localhost:5173${path}`, { ...init, headers }));
  };

  const cookieHeader = () =>
    Object.entries(h.cookies())
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    adminCookie = cookieHeader();
    const session = await h.fetch("/api/auth/get-session");
    adminId = ((await session.json()) as { user?: { id?: string } }).user?.id ?? "";
    expect(adminId).not.toBe("");
    const r = await h.fetch("/api/collections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slug,
        fields: [{ name: "title", type: "text", required: true }],
      }),
    });
    expect(r.status).toBe(201);
  });
  afterAll(() => h.cleanup());

  test("collab-config reports the native transport on a long-lived process", async () => {
    const res = await h.fetch("/api/realtime/collab-config");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ transport: "native" });
  });

  test("subscribe requires a session", async () => {
    const res = await request(`/api/realtime/collab:item:${slug}:row1/subscribe`);
    expect(res.status).toBe(401);
  });

  test("subscribe requires read permission on the collection", async () => {
    // A fresh non-admin user has no permission rows → no read on the collection.
    const su = await request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: `viewer-${Date.now()}@example.test`,
        password: "correct-horse-battery",
        name: "Viewer",
      }),
    });
    expect(su.ok).toBe(true);
    const cookies = (su.headers.getSetCookie?.() ?? [])
      .map((sc) => sc.split(";")[0]!)
      .join("; ");
    const res = await request(`/api/realtime/collab:item:${slug}:row1/subscribe`, {}, cookies);
    expect(res.status).toBe(403);
  });

  test("malformed collab channels are rejected", async () => {
    for (const bad of ["collab:item:onlyslug", "collab:unknown:a:b", `collab:item::${slug}`]) {
      const res = await request(`/api/realtime/${encodeURIComponent(bad)}/subscribe`, {}, adminCookie);
      expect(res.status).toBe(422);
    }
  });

  test("publish validates the message shape and rejects client-supplied identity", async () => {
    const publish = (body: unknown) =>
      request(`/api/realtime/collab:item:${slug}:row1/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }, adminCookie);

    expect((await publish({ t: "nope" })).status).toBe(422);
    // `.strict()` — a crafted body carrying its own `user` must not pass.
    expect((await publish({ t: "focus", field: "title", user: { id: "evil" } })).status).toBe(422);
    expect((await publish({ t: "focus", field: "title" })).status).toBe(200);
  });

  test("delivered messages carry server-stamped identity", async () => {
    const ac = new AbortController();
    const res = await request(
      `/api/realtime/collab:item:${slug}:row2/subscribe`,
      { signal: ac.signal },
      adminCookie,
    );
    expect(res.status).toBe(200);
    const gen = readSSE(res);
    const deliveredP = firstMessage(gen);

    const pub = await request(`/api/realtime/collab:item:${slug}:row2/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ t: "focus", field: "title" }),
    }, adminCookie);
    expect(pub.status).toBe(200);

    const frame = await deliveredP;
    const msg = JSON.parse(frame.data) as {
      t: string;
      field?: string;
      user: { id: string; name: string | null };
      at: number;
    };
    expect(msg.t).toBe("focus");
    expect(msg.field).toBe("title");
    expect(msg.user.id).toBe(adminId);
    expect(typeof msg.at).toBe("number");
    ac.abort();
  });

  test("field is dropped from messages where it makes no sense", async () => {
    const ac = new AbortController();
    const res = await request(
      `/api/realtime/collab:item:${slug}:row3/subscribe`,
      { signal: ac.signal },
      adminCookie,
    );
    const gen = readSSE(res);
    const deliveredP = firstMessage(gen);
    await request(`/api/realtime/collab:item:${slug}:row3/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ t: "blur", field: "title" }),
    }, adminCookie);
    const msg = JSON.parse((await deliveredP).data) as { t: string; field?: string };
    expect(msg.t).toBe("blur");
    expect(msg.field).toBeUndefined();
    ac.abort();
  });
});
