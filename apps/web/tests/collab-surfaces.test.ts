/**
 * Collaboration channels (`collab:item:<slug>:<id>`) — gate + protocol surface.
 *
 * Covers: transport capability endpoint, the auth/permission gate on subscribe,
 * channel shape validation, publish schema validation (including the strict
 * rejection of client-supplied identity), and server-side identity stamping on
 * the delivered message.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { type TestHarness, makeHarness, seedAdmin } from "./setup";
import { collabTransportKind, mintAblyTokenRequest } from "../src/server/services/collab";
import type { Env } from "../src/server/env";

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

  test("list channel: same gate — session + read permission", async () => {
    // Unauthenticated → 401.
    expect((await request(`/api/realtime/collab:list:${slug}/subscribe`)).status).toBe(401);
    // Signed-in without read permission → 403.
    const su = await request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: `list-viewer-${Date.now()}@example.test`,
        password: "correct-horse-battery",
        name: "Viewer",
      }),
    });
    expect(su.ok).toBe(true);
    const cookies = (su.headers.getSetCookie?.() ?? [])
      .map((sc) => sc.split(";")[0]!)
      .join("; ");
    expect(
      (await request(`/api/realtime/collab:list:${slug}/subscribe`, {}, cookies)).status,
    ).toBe(403);
  });

  test("malformed list channels are rejected", async () => {
    for (const bad of ["collab:list:", "collab:list:a:b"]) {
      const res = await request(`/api/realtime/${encodeURIComponent(bad)}/subscribe`, {}, adminCookie);
      expect(res.status).toBe(422);
    }
  });

  test("list channel: editor messages carry their record id; observer hello has none", async () => {
    const ac = new AbortController();
    const res = await request(
      `/api/realtime/collab:list:${slug}/subscribe`,
      { signal: ac.signal },
      adminCookie,
    );
    expect(res.status).toBe(200);
    const gen = readSSE(res);
    // Collect both frames in ONE pass — `return` inside a for-await closes the
    // generator (and the reader lock with it), so firstMessage can't be
    // called twice on the same stream.
    const messagesP = (async () => {
      const out: SSEFrame[] = [];
      for await (const frame of gen) {
        if (frame.event !== "message") continue;
        out.push(frame);
        if (out.length === 2) break;
      }
      return out;
    })();

    // Editor ping: item + field pass through, identity is server-stamped.
    const pub = await request(`/api/realtime/collab:list:${slug}/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ t: "ping", item: "row9", field: "title" }),
    }, adminCookie);
    expect(pub.status).toBe(200);
    // Observer hello (a list view announcing itself): no item, still valid.
    const hello = await request(`/api/realtime/collab:list:${slug}/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ t: "hello" }),
    }, adminCookie);
    expect(hello.status).toBe(200);

    const [first, second] = await messagesP;
    const editorMsg = JSON.parse(first!.data) as {
      t: string; item?: string; field?: string; user: { id: string };
    };
    expect(editorMsg.t).toBe("ping");
    expect(editorMsg.item).toBe("row9");
    expect(editorMsg.field).toBe("title");
    expect(editorMsg.user.id).toBe(adminId);
    const helloMsg = JSON.parse(second!.data) as { t: string; item?: string };
    expect(helloMsg.t).toBe("hello");
    expect(helloMsg.item).toBeUndefined();
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

describe("collab transport selection", () => {
  const base = { APP_URL: "x", AUTH_SECRET: "x" } as unknown as Env;

  test("long-lived process is native regardless of keys", () => {
    expect(collabTransportKind(base)).toBe("native");
    expect(collabTransportKind({ ...base, ABLY_API_KEY: "k:s" })).toBe("native");
  });

  test("stateless serverless: ably beats the redis fallback, off without either", () => {
    process.env.VERCEL = "1";
    try {
      expect(collabTransportKind(base)).toBe("off");
      expect(collabTransportKind({ ...base, ABLY_API_KEY: "k:s" })).toBe("ably");
      expect(
        collabTransportKind({
          ...base,
          UPSTASH_REDIS_REST_URL: "https://r",
          UPSTASH_REDIS_REST_TOKEN: "t",
        }),
      ).toBe("native");
      expect(
        collabTransportKind({
          ...base,
          ABLY_API_KEY: "k:s",
          UPSTASH_REDIS_REST_URL: "https://r",
          UPSTASH_REDIS_REST_TOKEN: "t",
        }),
      ).toBe("ably");
    } finally {
      delete process.env.VERCEL;
    }
  });

  test("a Durable Object binding always wins", () => {
    expect(
      collabTransportKind({ ...base, REALTIME: {} as never, ABLY_API_KEY: "k:s" }),
    ).toBe("native");
  });
});

describe("ably token minting", () => {
  test("token request is signed per the Ably REST token spec", async () => {
    const tr = await mintAblyTokenRequest("appId.keyId:topsecret", "user-1", {
      "collab:item:articles:row1": ["publish", "subscribe"],
    });
    expect(tr.keyName).toBe("appId.keyId");
    expect(tr.clientId).toBe("user-1");
    expect(tr.ttl).toBe(3_600_000);
    expect(tr.nonce.length).toBeGreaterThanOrEqual(16);
    expect(JSON.parse(tr.capability)).toEqual({
      "collab:item:articles:row1": ["publish", "subscribe"],
    });
    // Recompute the mac independently — same sign text, same secret.
    const signText = `${tr.keyName}\n${tr.ttl}\n${tr.capability}\n${tr.clientId}\n${tr.timestamp}\n${tr.nonce}\n`;
    const expected = createHmac("sha256", "topsecret").update(signText).digest("base64");
    expect(tr.mac).toBe(expected);
  });

  test("a key without the keyName:keySecret shape is rejected", async () => {
    await expect(
      mintAblyTokenRequest("garbage", "u", { "collab:item:a:b": ["subscribe"] }),
    ).rejects.toThrow();
  });
});

describe("collab-token endpoint", () => {
  let h: TestHarness;
  const slug = `collabtk_${Date.now()}`;
  let adminId = "";

  beforeAll(async () => {
    h = makeHarness({ ABLY_API_KEY: "appId.keyId:topsecret" });
    await seedAdmin(h);
    const session = await h.fetch("/api/auth/get-session");
    adminId = ((await session.json()) as { user?: { id?: string } }).user?.id ?? "";
    const r = await h.fetch("/api/collections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug, fields: [{ name: "title", type: "text" }] }),
    });
    expect(r.status).toBe(201);
  });
  afterAll(() => h.cleanup());

  test("mints a channel-scoped token request pinned to the session user", async () => {
    const res = await h.fetch("/api/realtime/collab-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channels: [`collab:item:${slug}:row1`] }),
    });
    expect(res.status).toBe(200);
    const { tokenRequest } = (await res.json()) as {
      tokenRequest: { clientId: string; capability: string; mac: string };
    };
    expect(tokenRequest.clientId).toBe(adminId);
    expect(JSON.parse(tokenRequest.capability)).toEqual({
      [`collab:item:${slug}:row1`]: ["publish", "subscribe"],
    });
    expect(tokenRequest.mac.length).toBeGreaterThan(0);
  });

  test("rejects non-collab channels and unauthenticated callers", async () => {
    const bad = await h.fetch("/api/realtime/collab-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channels: [`items:${slug}`] }),
    });
    expect(bad.status).toBe(422);

    const anon = await h.app.fetch(
      new Request("http://localhost:5173/api/realtime/collab-token", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "http://localhost:5173" },
        body: JSON.stringify({ channels: [`collab:item:${slug}:row1`] }),
      }),
    );
    expect(anon.status).toBe(401);
  });

  test("returns UNAVAILABLE when Ably is not configured", async () => {
    const h2 = makeHarness();
    try {
      await seedAdmin(h2);
      const res = await h2.fetch("/api/realtime/collab-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channels: [`collab:item:${slug}:row1`] }),
      });
      expect(res.status).toBe(503);
    } finally {
      h2.cleanup();
    }
  });
});
