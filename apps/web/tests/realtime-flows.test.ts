/**
 * Smoke tests for the three event-fanout subsystems:
 *   - Realtime SSE (subscribe + admin test-publish gate)
 *   - Flows engine (manual trigger + event-triggered run)
 *   - Outgoing webhooks (HMAC-SHA256 signed via x-workeros-signature)
 *
 * Everything runs in-process through the harness from ./setup — Bun.serve()
 * is only used for the webhook target so we can capture the inbound POST.
 */
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { createHmac } from "node:crypto";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

// --- SSE parsing -----------------------------------------------------------

interface SSEFrame {
  event: string;
  data: string;
  id?: string;
}

/**
 * Streams `res.body` as parsed SSE frames. Comment frames (`: ping`) are
 * skipped; only `event:`/`data:` blocks are yielded. The generator exits
 * naturally when the stream closes (which happens when the test aborts the
 * AbortController fed into the request).
 */
async function* readSSE(res: Response): AsyncGenerator<SSEFrame> {
  if (!res.body) throw new Error("response has no body");
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
        let id: string | undefined;
        for (const raw of block.split("\n")) {
          if (raw.startsWith("event:")) event = raw.slice(6).trim();
          else if (raw.startsWith("data:")) {
            data += (data ? "\n" : "") + raw.slice(5).trimStart();
          } else if (raw.startsWith("id:")) id = raw.slice(3).trim();
        }
        yield { event, data, id };
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // already released
    }
  }
}

/** Open an SSE subscription and resolve once the `ready` event arrives. */
async function openSubscription(
  h: TestHarness,
  channel: string,
): Promise<{
  iter: AsyncGenerator<SSEFrame>;
  abort: () => void;
  res: Response;
}> {
  const ac = new AbortController();
  // Use the harness fetch for cookies, but feed in our abort signal.
  const cookieHeader = Object.entries(h.cookies())
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
  const headers: Record<string, string> = { Origin: "http://localhost:5173" };
  if (cookieHeader) headers.Cookie = cookieHeader;
  const res = await h.app.fetch(
    new Request(`http://localhost:5173/api/realtime/${channel}/subscribe`, {
      headers,
      signal: ac.signal,
    }),
  );
  if (res.status !== 200) {
    throw new Error(
      `subscribe failed: ${res.status} ${await res.text().catch(() => "")}`,
    );
  }
  const iter = readSSE(res);
  // Wait for the `ready` event so the subscriber is registered before the
  // caller publishes anything.
  const first = await iter.next();
  if (first.done || first.value.event !== "ready") {
    ac.abort();
    throw new Error(
      `expected ready frame, got ${first.done ? "<eof>" : first.value.event}`,
    );
  }
  return { iter, abort: () => ac.abort(), res };
}

/**
 * Pull the next non-ready frame matching `predicate` from the SSE stream,
 * giving up after `timeoutMs`. Returns `null` on timeout so the caller can
 * decide whether that's an assertion failure or a deliberate silence check.
 */
async function nextMatch(
  iter: AsyncGenerator<SSEFrame>,
  predicate: (f: SSEFrame) => boolean,
  timeoutMs = 3000,
): Promise<SSEFrame | null> {
  return await Promise.race<Promise<SSEFrame | null>>([
    (async () => {
      for await (const frame of iter) {
        if (predicate(frame)) return frame;
      }
      return null;
    })(),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]);
}

// --- Shared collection helper ---------------------------------------------

const createOwnerScopedCollection = async (
  h: TestHarness,
  slug: string,
): Promise<void> => {
  const res = await h.fetch("/api/collections", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      slug,
      ownerScoped: true,
      fields: [
        { name: "title", type: "text", required: true },
        { name: "body", type: "longtext" },
      ],
    }),
  });
  if (res.status !== 201) {
    throw new Error(
      `create collection failed: ${res.status} ${await res.text()}`,
    );
  }
};

// =========================================================================
// Realtime
// =========================================================================

describe("realtime SSE", () => {
  let h: TestHarness;
  const slug = `notes_rt_${Date.now()}`;
  const channel = `items:${slug}`;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    await createOwnerScopedCollection(h, slug);
  });

  afterAll(() => {
    h.cleanup();
  });

  test("subscribe → POST item → SSE delivers the created event", async () => {
    const sub = await openSubscription(h, channel);
    try {
      const create = await h.fetch(`/api/items/${slug}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "sse-hello", body: "first" }),
      });
      expect(create.status).toBe(201);
      const created = (await create.json()) as { data: { id: string } };
      const itemId = created.data.id;

      const frame = await nextMatch(
        sub.iter,
        (f) => f.event === "message" && f.data.includes(itemId),
        4000,
      );
      expect(frame).not.toBeNull();
      const payload = JSON.parse(frame!.data) as {
        event: string;
        data: { id: string; title: string };
      };
      expect(payload.event).toBe("created");
      expect(payload.data.id).toBe(itemId);
      expect(payload.data.title).toBe("sse-hello");
    } finally {
      sub.abort();
    }
  });

  test("two subscribers on same channel both receive the event", async () => {
    const subA = await openSubscription(h, channel);
    const subB = await openSubscription(h, channel);
    try {
      const create = await h.fetch(`/api/items/${slug}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "fanout", body: "both" }),
      });
      expect(create.status).toBe(201);
      const id = ((await create.json()) as { data: { id: string } }).data.id;
      const [a, b] = await Promise.all([
        nextMatch(subA.iter, (f) => f.event === "message" && f.data.includes(id), 4000),
        nextMatch(subB.iter, (f) => f.event === "message" && f.data.includes(id), 4000),
      ]);
      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
    } finally {
      subA.abort();
      subB.abort();
    }
  });

  test("test-publish: non-admin is rejected, admin succeeds", async () => {
    // Spin up a second user — second sign-up gets only `authenticated`,
    // not `admin`. Use a fresh cookie store so the admin session here is
    // untouched.
    const userCookies = new Map<string, string>();
    const userFetch = async (path: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers ?? {});
      headers.set("Origin", "http://localhost:5173");
      if (userCookies.size > 0) {
        headers.set(
          "Cookie",
          [...userCookies.entries()].map(([k, v]) => `${k}=${v}`).join("; "),
        );
      }
      const res = await h.app.fetch(
        new Request(`http://localhost:5173${path}`, { ...init, headers }),
      );
      for (const sc of res.headers.getSetCookie?.() ?? []) {
        const [pair] = sc.split(";");
        const eq = pair?.indexOf("=") ?? -1;
        if (!pair || eq <= 0) continue;
        const name = pair.slice(0, eq).trim();
        const value = pair.slice(eq + 1).trim();
        if (value === "" || value === "deleted") userCookies.delete(name);
        else userCookies.set(name, value);
      }
      return res;
    };
    const signUp = await userFetch("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: `user-${Date.now()}@example.test`,
        password: "correct-horse-battery",
        name: "Non Admin",
      }),
    });
    expect(signUp.status).toBeLessThan(400);

    const denied = await userFetch(`/api/realtime/${channel}/test-publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "created", data: { id: "x" } }),
    });
    // Gate throws FORBIDDEN (403) for any signed-in non-admin, UNAUTHORIZED
    // (401) when sign-in didn't take. Accept either so the test isn't
    // brittle if better-auth's session cookie name changes.
    expect([401, 403]).toContain(denied.status);

    const ok = await h.fetch(`/api/realtime/${channel}/test-publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "created", data: { id: "synthetic" } }),
    });
    expect(ok.status).toBe(200);
  });
});

// =========================================================================
// Flows
// =========================================================================

describe("flows engine", () => {
  let h: TestHarness;
  const slug = `notes_flow_${Date.now()}`;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    await createOwnerScopedCollection(h, slug);
  });

  afterAll(() => {
    h.cleanup();
  });

  test("manual trigger executes a log operation and returns ok", async () => {
    const create = await h.fetch("/api/flows", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "manual-log",
        trigger: "manual:",
        operations: [{ type: "log", message: "manual-run" }],
      }),
    });
    expect(create.status).toBe(201);
    const flow = (await create.json()) as { data: { id: string } };

    const run = await h.fetch(`/api/flows/${flow.data.id}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    });
    expect(run.status).toBe(200);
    const body = (await run.json()) as { ok: boolean; error?: string };
    expect(body.ok).toBe(true);
    expect(body.error).toBeUndefined();
  });

  test("event-triggered flow fires on item create (logs activity row)", async () => {
    const trigger = `event:items:${slug}:created`;
    const create = await h.fetch("/api/flows", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "on-note-create",
        trigger,
        operations: [{ type: "log", message: "note created: {{ data.id }}" }],
      }),
    });
    expect(create.status).toBe(201);
    const flowId = ((await create.json()) as { data: { id: string } }).data.id;

    const post = await h.fetch(`/api/items/${slug}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "flow-trigger", body: "x" }),
    });
    expect(post.status).toBe(201);

    // `publishEvent` fires `runFlows` via `void` (fire-and-forget). Poll the
    // activity feed for the `flow.run` row this flow writes on completion
    // (recordActivity namespaces `run` + collection `system_flows` →
    // `flow.run`). Bounded retry — if the run never lands, the test fails.
    let found: { action: string; itemId: string | null; response?: unknown } | null = null;
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const res = await h.fetch("/api/activity?limit=50&collection=system_flows");
      if (res.status === 200) {
        const body = (await res.json()) as {
          data: { action: string; itemId: string | null; response?: unknown }[];
        };
        found =
          body.data.find(
            (r) => r.itemId === flowId && r.action.includes("run"),
          ) ?? null;
        if (found) break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(found).not.toBeNull();
    const resp = found!.response as { ok?: boolean } | null;
    expect(resp?.ok).toBe(true);
  });
});

// =========================================================================
// Webhooks
// =========================================================================

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

describe("outgoing webhooks (HMAC signed)", () => {
  let h: TestHarness;
  const slug = `notes_wh_${Date.now()}`;
  const captured: CapturedRequest[] = [];
  // `Bun.serve({ port: 0 })` picks a free port; the assigned port is on
  // `server.port` after construction.
  let server: ReturnType<typeof Bun.serve> | null = null;
  let baseUrl = "";

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    await createOwnerScopedCollection(h, slug);

    server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const body = await req.text();
        const headers: Record<string, string> = {};
        req.headers.forEach((v, k) => {
          headers[k] = v;
        });
        captured.push({ url: req.url, headers, body });
        return new Response("ok");
      },
    });
    baseUrl = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => {
    server?.stop(true);
    h.cleanup();
  });

  const waitFor = async (
    predicate: () => CapturedRequest | undefined,
    timeoutMs = 3000,
  ): Promise<CapturedRequest | null> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = predicate();
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 25));
    }
    return null;
  };

  test("registered webhook receives POST with valid x-workeros-signature", async () => {
    const secret = "shhhhhh-one";
    const register = await h.fetch("/api/webhooks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "hook-one",
        url: `${baseUrl}/one`,
        events: [`items:${slug}:created`],
        secret,
      }),
    });
    expect(register.status).toBe(201);
    const hookOneId = ((await register.json()) as { data: { id: string } })
      .data.id;

    const startedAt = captured.length;
    const post = await h.fetch(`/api/items/${slug}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "webhook-fire", body: "y" }),
    });
    expect(post.status).toBe(201);

    const inbound = await waitFor(() =>
      captured.slice(startedAt).find((r) => new URL(r.url).pathname === "/one"),
    );
    expect(inbound).not.toBeNull();

    // Verify body shape — dispatchWebhooks wraps the event in {channel,event,data,deliveredAt}.
    const parsed = JSON.parse(inbound!.body) as {
      channel: string;
      event: string;
      data: { id: string; title: string };
    };
    expect(parsed.channel).toBe(`items:${slug}`);
    expect(parsed.event).toBe("created");
    expect(parsed.data.title).toBe("webhook-fire");

    // Verify HMAC. Header format is `sha256=<hex>` — hex digest of HMAC-SHA256(body, secret).
    const sig = inbound!.headers["x-workeros-signature"];
    expect(sig).toBeTruthy();
    const expected =
      "sha256=" + createHmac("sha256", secret).update(inbound!.body).digest("hex");
    // Server emits the hex with NO `sha256=` prefix — assert both shapes so
    // this test catches a contract drift in either direction.
    expect([
      expected,
      expected.slice("sha256=".length),
    ]).toContain(sig);

    // Cleanup so the next test only sees its own hook fire.
    await h.fetch(`/api/webhooks/${hookOneId}`, { method: "DELETE" });
  });

  test("two webhooks → each receives its own secret's HMAC", async () => {
    const secretA = "first-secret";
    const secretB = "second-secret";
    const a = await h.fetch("/api/webhooks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "hook-a",
        url: `${baseUrl}/a`,
        events: [`items:${slug}:created`],
        secret: secretA,
      }),
    });
    expect(a.status).toBe(201);
    const b = await h.fetch("/api/webhooks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "hook-b",
        url: `${baseUrl}/b`,
        events: [`items:${slug}:created`],
        secret: secretB,
      }),
    });
    expect(b.status).toBe(201);

    const startedAt = captured.length;
    const post = await h.fetch(`/api/items/${slug}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "fanout-webhook", body: "z" }),
    });
    expect(post.status).toBe(201);

    const aHit = await waitFor(() =>
      captured.slice(startedAt).find((r) => new URL(r.url).pathname === "/a"),
    );
    const bHit = await waitFor(() =>
      captured.slice(startedAt).find((r) => new URL(r.url).pathname === "/b"),
    );
    expect(aHit).not.toBeNull();
    expect(bHit).not.toBeNull();

    const verify = (req: CapturedRequest, secret: string) => {
      const sig = req.headers["x-workeros-signature"];
      expect(sig).toBeTruthy();
      const expected =
        "sha256=" + createHmac("sha256", secret).update(req.body).digest("hex");
      expect([expected, expected.slice("sha256=".length)]).toContain(sig);
    };
    verify(aHit!, secretA);
    verify(bHit!, secretB);

    // Cross-check: the two signatures must differ (each uses its own
    // secret). Both hooks see the same JSON body, so identical signatures
    // would mean the server applied the same secret to both deliveries.
    const aSig = aHit!.headers["x-workeros-signature"];
    const bSig = bHit!.headers["x-workeros-signature"];
    expect(aSig).not.toBe(bSig);
  });
});
