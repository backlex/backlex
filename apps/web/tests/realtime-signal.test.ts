/**
 * Signal-only data plane (`signal:items:<slug>`) — the Ably realtime path for
 * stateless serverless deployments.
 *
 * The thing worth testing hardest here is the LEAK BOUNDARY. The plane trades
 * per-subscriber row filtering (impossible inside a hosted pub/sub) for an
 * id-only signal plus a permission-filtered read-back. Row data therefore can't
 * leak — but the id and the timing of a change can, so a subscriber whose read
 * permission carries row conditions must be refused unless the deployment opts
 * in. These tests pin that boundary, the transport selection (which must never
 * downgrade a runtime that already has full-fidelity SSE), the channel gate
 * (an unrecognised `signal:*` shape must not fall through to the free-form,
 * unauthenticated branch), and the signal payload shape itself.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type TestHarness, makeHarness, seedAdmin } from "./setup";
import {
  itemSignalFor,
  itemsTransportKind,
  parseSignalChannel,
  signalChannel,
  signalScopeAllowsConditional,
} from "../src/server/services/realtime-signal";
import type { Env } from "../src/server/env";

const JSON_HEADERS = { "Content-Type": "application/json" };

describe("items transport selection", () => {
  const base = { APP_URL: "x", AUTH_SECRET: "x" } as unknown as Env;

  test("a long-lived process keeps SSE regardless of keys", () => {
    expect(itemsTransportKind(base)).toBe("sse");
    expect(itemsTransportKind({ ...base, ABLY_API_KEY: "k:s" })).toBe("sse");
  });

  test("a Durable Object binding always wins", () => {
    expect(itemsTransportKind({ ...base, REALTIME: {} as never, ABLY_API_KEY: "k:s" })).toBe(
      "sse",
    );
  });

  test("stateless serverless: signals only fill what was previously `off`", () => {
    process.env.VERCEL = "1";
    try {
      // Nothing configured — unchanged, still no transport.
      expect(itemsTransportKind(base)).toBe("off");
      // Ably alone → the new plane.
      expect(itemsTransportKind({ ...base, ABLY_API_KEY: "k:s" })).toBe("ably-signal");
      // Upstash configured → keep full-fidelity SSE. A deployment that already
      // pays for the long-poll must NOT be silently downgraded to id-only
      // signals; that would be a regression, not an upgrade.
      const withRedis = {
        ...base,
        UPSTASH_REDIS_REST_URL: "https://r",
        UPSTASH_REDIS_REST_TOKEN: "t",
      };
      expect(itemsTransportKind(withRedis)).toBe("sse");
      expect(itemsTransportKind({ ...withRedis, ABLY_API_KEY: "k:s" })).toBe("sse");
    } finally {
      delete process.env.VERCEL;
    }
  });

  test("the conditional-subscriber escape hatch is off by default", () => {
    expect(signalScopeAllowsConditional(base)).toBe(false);
    expect(signalScopeAllowsConditional({ ...base, REALTIME_SIGNAL_SCOPE: "unconditional" })).toBe(
      false,
    );
    expect(signalScopeAllowsConditional({ ...base, REALTIME_SIGNAL_SCOPE: "all" })).toBe(true);
  });
});

describe("signal channel + payload derivation", () => {
  test("channel names round-trip; malformed shapes are rejected", () => {
    expect(signalChannel("posts")).toBe("signal:items:posts");
    expect(parseSignalChannel("signal:items:posts")).toBe("posts");
    for (const bad of ["signal:items:", "signal:items:a:b", "signal:other:posts", "items:posts"]) {
      expect(parseSignalChannel(bad)).toBeNull();
    }
  });

  test("a signal carries the id and NOTHING from the row", () => {
    const signal = itemSignalFor("items:posts", {
      event: "updated",
      data: { id: "row-1", title: "secret", salary: 999 },
      before: { id: "row-1", title: "old", salary: 1 },
    });
    expect(signal).not.toBeNull();
    // Exact key set — the whole security story of this plane is that no field
    // value ever rides it, so a new key slipping in must fail loudly.
    expect(Object.keys(signal!).sort()).toEqual(["at", "collection", "event", "id"]);
    expect(signal!).toMatchObject({ event: "updated", collection: "posts", id: "row-1" });
    expect(typeof signal!.at).toBe("number");
  });

  test("numeric primary keys are carried as strings", () => {
    expect(itemSignalFor("items:posts", { event: "created", data: { id: 42 } })?.id).toBe("42");
  });

  test("payloads with nothing to refetch produce no signal", () => {
    // Not an items channel.
    expect(itemSignalFor("collections", { event: "created", data: { id: "x" } })).toBeNull();
    // Not a row event.
    expect(itemSignalFor("items:posts", { event: "presence", data: { id: "x" } })).toBeNull();
    // No id → the client would have nothing to read back.
    expect(itemSignalFor("items:posts", { event: "created", data: { title: "x" } })).toBeNull();
    expect(itemSignalFor("items:posts", null)).toBeNull();
  });
});

describe("signal channel gate", () => {
  let h: TestHarness;
  const open = `sig_open_${Date.now()}`;
  const owned = `sig_owned_${Date.now()}`;
  let adminCookie = "";

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

  /** Sign a fresh non-admin user up and return its cookie header. The harness
   *  tracks the admin's cookies, so this goes through the raw app fetch. */
  const signUpMember = async (label: string): Promise<string> => {
    const su = await request("/api/auth/sign-up/email", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        email: `${label}-${Date.now()}@example.test`,
        password: "correct-horse-battery",
        name: label,
      }),
    });
    expect(su.ok).toBe(true);
    return (su.headers.getSetCookie?.() ?? []).map((sc) => sc.split(";")[0]!).join("; ");
  };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    adminCookie = cookieHeader();
    for (const [slug, ownerScoped] of [
      [open, false],
      [owned, true],
    ] as const) {
      const r = await h.fetch("/api/collections", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          slug,
          ownerScoped,
          fields: [{ name: "title", type: "text" }],
        }),
      });
      expect(r.status).toBe(201);
    }
  });
  afterAll(() => h.cleanup());

  test("an unrecognised signal:* shape is rejected, not treated as free-form", async () => {
    // This is the important one: free-form channels take no auth at all, so a
    // shape that slipped past the parser would be an open, unauthenticated
    // channel named `signal:…`.
    for (const bad of ["signal:items:", "signal:items:a:b", "signal:whatever"]) {
      const res = await request(`/api/realtime/${encodeURIComponent(bad)}/subscribe`);
      expect(res.status).toBe(422);
    }
  });

  test("subscribe requires a session", async () => {
    const res = await request(`/api/realtime/${signalChannel(open)}/subscribe`);
    expect(res.status).toBe(401);
  });

  test("subscribe requires read permission on the collection", async () => {
    const cookie = await signUpMember("outsider");
    // A fresh signup lands in its own workspace, so it has no grant on `open`.
    const res = await request(`/api/realtime/${signalChannel(open)}/subscribe`, {}, cookie);
    expect([401, 403]).toContain(res.status);
  });

  test("client publish to a signal channel is refused", async () => {
    const res = await request(
      `/api/realtime/${signalChannel(open)}/publish`,
      { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ event: "created" }) },
      adminCookie,
    );
    expect(res.status).toBe(403);
  });

  test("an admin (unconditional read) passes the gate", async () => {
    const ac = new AbortController();
    const res = await request(
      `/api/realtime/${signalChannel(open)}/subscribe`,
      { signal: ac.signal },
      adminCookie,
    );
    expect(res.status).toBe(200);
    ac.abort();
  });
});

/**
 * The leak boundary itself.
 *
 * Fixture: an owner-scoped collection auto-seeds the `authenticated` role a
 * read permission conditioned on `owner_id = $user.id`. Such a reader may see
 * only its own rows over REST — so hearing an id-level signal for EVERY row in
 * the collection would tell it things HTTP never would. It must be refused,
 * unless the deployment explicitly waives the check.
 */
describe("signal gate — row-level read conditions", () => {
  const harnesses: TestHarness[] = [];
  afterAll(() => {
    for (const h of harnesses) h.cleanup();
  });

  const signUp = (h: TestHarness, email: string) =>
    h.fetch("/api/auth/sign-up/email", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ email, password: "correct-horse-battery", name: email }),
    });

  /** Build a harness whose CURRENT session is a non-admin `authenticated` user
   *  holding a condition-filtered read grant on `slug`, plus an unconditional
   *  one on `openSlug`. Returns both slugs. */
  const conditionedReader = async (
    env: Partial<Env>,
  ): Promise<{ h: TestHarness; owned: string; open: string }> => {
    const h = makeHarness(env);
    harnesses.push(h);
    await seedAdmin(h);
    const owned = `sig_cond_${harnesses.length}_${Date.now()}`;
    const open = `sig_uncond_${harnesses.length}_${Date.now()}`;
    for (const [slug, ownerScoped] of [
      [owned, true],
      [open, false],
    ] as const) {
      const r = await h.fetch("/api/collections", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ slug, ownerScoped, fields: [{ name: "title", type: "text" }] }),
      });
      expect(r.status).toBe(201);
    }
    // Give `authenticated` an explicitly UNCONDITIONAL read on `open`, so the
    // same user holds one grant of each kind and the two outcomes below differ
    // only by the presence of a row condition.
    const roles = (await (await h.fetch("/api/roles")).json()) as {
      data: { id: string; name: string }[];
    };
    const authenticated = roles.data.find((r) => r.name === "authenticated");
    expect(authenticated).toBeDefined();
    const grant = await h.fetch(`/api/roles/${authenticated!.id}/permissions`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ collection: open, action: "read" }),
    });
    expect(grant.status).toBe(201);
    // Same workspace, non-admin → lands as `authenticated`.
    await h.fetch("/api/auth/sign-out", { method: "POST" });
    expect((await signUp(h, `member-${Date.now()}@example.test`)).status).toBe(200);
    return { h, owned, open };
  };

  test("the fixture really is a conditioned reader (not just an unauthorized one)", async () => {
    const { h, owned, open } = await conditionedReader({});
    // It CAN read the owner-scoped collection over REST — the grant exists, it's
    // just row-filtered. Without this the refusal below would prove nothing.
    expect((await h.fetch(`/api/items/${owned}`)).status).toBe(200);
    expect((await h.fetch(`/api/items/${open}`)).status).toBe(200);
  });

  test("refused on the conditioned collection, allowed on the unconditional one", async () => {
    const { h, owned, open } = await conditionedReader({});

    const denied = await h.fetch(`/api/realtime/${signalChannel(owned)}/subscribe`);
    expect(denied.status).toBe(403);
    expect(JSON.stringify(await denied.json())).toContain("Row-level read conditions");

    // The same reader has an unconditional grant here, so the signal tells it
    // nothing it couldn't already enumerate over REST.
    const ac = new AbortController();
    const allowed = await h.fetch(`/api/realtime/${signalChannel(open)}/subscribe`, {
      signal: ac.signal,
    });
    expect(allowed.status).toBe(200);
    ac.abort();
  });

  test("REALTIME_SIGNAL_SCOPE=all waives the check", async () => {
    const { h, owned } = await conditionedReader({ REALTIME_SIGNAL_SCOPE: "all" });
    const ac = new AbortController();
    const res = await h.fetch(`/api/realtime/${signalChannel(owned)}/subscribe`, {
      signal: ac.signal,
    });
    expect(res.status).toBe(200);
    ac.abort();
  });
});

describe("ably-token endpoint", () => {
  let h: TestHarness;
  const slug = `sigtk_${Date.now()}`;
  let adminId = "";

  beforeAll(async () => {
    h = makeHarness({ ABLY_API_KEY: "appId.keyId:topsecret" });
    await seedAdmin(h);
    adminId =
      ((await (await h.fetch("/api/auth/get-session")).json()) as { user?: { id?: string } })
        .user?.id ?? "";
    const r = await h.fetch("/api/collections", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ slug, fields: [{ name: "title", type: "text" }] }),
    });
    expect(r.status).toBe(201);
  });
  afterAll(() => h.cleanup());

  const mint = (channels: string[]) =>
    h.fetch("/api/realtime/ably-token", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ channels }),
    });

  test("signal channels are subscribe-ONLY", async () => {
    const res = await mint([signalChannel(slug)]);
    expect(res.status).toBe(200);
    const { tokenRequest } = (await res.json()) as {
      tokenRequest: { clientId: string; capability: string };
    };
    expect(tokenRequest.clientId).toBe(adminId);
    // A client that could publish signals could make every other reader
    // refetch rows that never changed — or miss ones that did.
    expect(JSON.parse(tokenRequest.capability)).toEqual({
      [signalChannel(slug)]: ["subscribe"],
    });
  });

  test("one token can carry both planes, each with its own ops", async () => {
    const res = await mint([signalChannel(slug), `collab:list:${slug}`]);
    expect(res.status).toBe(200);
    const { tokenRequest } = (await res.json()) as { tokenRequest: { capability: string } };
    expect(JSON.parse(tokenRequest.capability)).toEqual({
      [signalChannel(slug)]: ["subscribe"],
      [`collab:list:${slug}`]: ["publish", "subscribe"],
    });
  });

  test("a managed channel is rejected — its rows are filtered per subscriber over SSE", async () => {
    expect((await mint([`items:${slug}`])).status).toBe(422);
  });

  test("an application-owned channel needs a rule, and the token mirrors it", async () => {
    // Before broadcast channels this was a flat 422 ("outside the two
    // planes"). It is now a third plane, but a closed one: without a rule the
    // name is refused, and WITH one the capability is whatever the rule says
    // — a caller who may only listen must not get a publishing token.
    expect((await mint(["anything"])).status).toBe(403);

    const made = await h.fetch("/api/admin/realtime-channels", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        name: "Listen only",
        pattern: "anything",
        subscribe: { access: "authenticated" },
        publish: { access: "none" },
      }),
    });
    expect(made.status).toBe(201);

    const res = await mint(["anything"]);
    expect(res.status).toBe(200);
    const { tokenRequest } = (await res.json()) as { tokenRequest: { capability: string } };
    expect(JSON.parse(tokenRequest.capability)).toEqual({ anything: ["subscribe"] });
  });

  test("the legacy collab-token endpoint still refuses signal channels", async () => {
    const res = await h.fetch("/api/realtime/collab-token", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ channels: [signalChannel(slug)] }),
    });
    expect(res.status).toBe(422);
  });
});

describe("items-config endpoint", () => {
  let h: TestHarness;
  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  test("reports the SSE transport on a long-lived process", async () => {
    const res = await h.fetch("/api/realtime/items-config");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ transport: "sse" });
  });
});
