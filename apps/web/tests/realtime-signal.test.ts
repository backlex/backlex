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

  /** The workspace-scoped Ably room a channel is minted for.
   *
   *  Read from `items-config` rather than rebuilt here, because the client
   *  learns it the same way — a test that computed the prefix independently
   *  would keep passing if the endpoint stopped handing one out, and the
   *  client would then attach to a room nothing publishes into. */
  const room = async (channel: string) => {
    const cfg = (await (await h.fetch("/api/realtime/items-config")).json()) as {
      ablyPrefix: string;
    };
    expect(cfg.ablyPrefix, "the config endpoint must hand the client its room prefix").toMatch(
      /^t\.[0-9a-f-]{36}:$/,
    );
    return `${cfg.ablyPrefix}${channel}`;
  };

  test("signal channels are subscribe-ONLY", async () => {
    const res = await mint([signalChannel(slug)]);
    expect(res.status).toBe(200);
    const { tokenRequest } = (await res.json()) as {
      tokenRequest: { clientId: string; capability: string };
    };
    expect(tokenRequest.clientId).toBe(adminId);
    // A client that could publish signals could make every other reader
    // refetch rows that never changed — or miss ones that did.
    //
    // The capability names the WORKSPACE'S room, not the bare channel. Ably is
    // the one plane where the client connects to the broker directly, so this
    // capability is the entire tenant boundary on it: without the prefix, two
    // workspaces owning a collection of the same name are minted tokens for one
    // room and each sees the other's change ids and timing.
    expect(JSON.parse(tokenRequest.capability)).toEqual({
      [await room(signalChannel(slug))]: ["subscribe"],
    });
  });

  test("one token can carry both planes, each with its own ops", async () => {
    const res = await mint([signalChannel(slug), `collab:list:${slug}`]);
    expect(res.status).toBe(200);
    const { tokenRequest } = (await res.json()) as { tokenRequest: { capability: string } };
    expect(JSON.parse(tokenRequest.capability)).toEqual({
      [await room(signalChannel(slug))]: ["subscribe"],
      [await room(`collab:list:${slug}`)]: ["publish", "subscribe"],
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
    expect(JSON.parse(tokenRequest.capability)).toEqual({
      [await room("anything")]: ["subscribe"],
    });
  });

  test("an ALREADY-prefixed signal channel is refused, so a client cannot double-prefix", async () => {
    // The contract is "ask for the bare channel, attach to the prefixed room".
    // A client that sends the room name instead does not get a wider token — it
    // gets a 403, because `t.<id>:signal:items:x` no longer matches the
    // `signal:` gate and falls through to the broadcast branch, which is
    // default-deny. Pinned because the published SDK got this backwards once:
    // its hub mints the token from the same set it attaches with, so prefixing
    // at the attach site silently sent the prefixed name to this endpoint and
    // killed signal-plane realtime for every SDK consumer.
    const prefixed = await room(signalChannel(slug));
    const res = await mint([prefixed]);
    expect(res.status).toBe(403);
    // The bare name is what works — without this the block would pass on an
    // endpoint that refused everything.
    expect((await mint([signalChannel(slug)])).status).toBe(200);
  });

  test("a caller naming ANOTHER workspace's room is scoped inside their own", async () => {
    // The prefix is derived from `auth.tenantId`, never taken from the channel
    // the caller sent — so naming `t.<someone-else>:signal:items:x` mints a
    // capability for `t.<mine>:t.<someone-else>:signal:items:x`, a room nothing
    // publishes into. There is no spelling that reaches another workspace.
    const foreign = "t.00000000-0000-4000-8000-000000000000:signal:items:secrets";
    const made = await h.fetch("/api/admin/realtime-channels", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        name: "Foreign lookalike",
        pattern: foreign,
        subscribe: { access: "authenticated" },
        publish: { access: "none" },
      }),
    });
    expect(made.status).toBe(201);

    const res = await mint([foreign]);
    expect(res.status).toBe(200);
    const { tokenRequest } = (await res.json()) as { tokenRequest: { capability: string } };
    const capability = JSON.parse(tokenRequest.capability) as Record<string, string[]>;
    expect(capability).toEqual({ [await room(foreign)]: ["subscribe"] });
    expect(Object.keys(capability)).not.toContain(foreign);
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
    // `ablyPrefix` rides along on every transport, not just `ably-signal`.
    // The endpoint answers before the client knows which plane it is on, and
    // sending it conditionally would mean the one client that needs it is the
    // one that has to ask twice.
    expect(await res.json()).toEqual({
      transport: "sse",
      ablyPrefix: expect.stringMatching(/^t\.[0-9a-f-]{36}:$/),
    });
  });

  test("a signed-out caller is told the transport but not the workspace id", async () => {
    // Both config endpoints are open — they answer a capability question a
    // client asks before doing anything — and `auth.tenantId` resolves for an
    // anonymous caller too, so an unconditional prefix would turn a workspace
    // SLUG into its UUID for anyone. Nothing anonymous can use it: a `signal:`
    // or `collab:` subscribe without a session is refused, so no token is ever
    // minted.
    for (const path of ["/api/realtime/items-config", "/api/realtime/collab-config"]) {
      const res = await h.app.request(path);
      expect(res.status, path).toBe(200);
      const body = (await res.json()) as { transport: string; ablyPrefix: string };
      expect(body.transport, path).toBeTruthy();
      expect(body.ablyPrefix, path).toBe("");
    }
    // The signed-in neighbour still gets one, or the assertion above would hold
    // on an endpoint that had simply stopped sending the field.
    const signedIn = (await (await h.fetch("/api/realtime/items-config")).json()) as {
      ablyPrefix: string;
    };
    expect(signedIn.ablyPrefix).toMatch(/^t\.[0-9a-f-]{36}:$/);
  });

  test("the prefix follows the ACTIVE workspace, so two of them never share a room", async () => {
    const prefixIn = async (tenant?: string) => {
      const res = await h.fetch(
        "/api/realtime/items-config",
        tenant ? { headers: { "X-Backlex-Tenant": tenant } } : undefined,
      );
      expect(res.status).toBe(200);
      return ((await res.json()) as { ablyPrefix: string }).ablyPrefix;
    };

    const made = await h.fetch("/api/tenants", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: `Signal room split ${Date.now()}` }),
    });
    expect(made.status).toBe(201);
    const other = ((await made.json()) as { data: { slug: string } }).data.slug;

    // Same caller, same collection slug, two workspaces — two rooms. This is
    // the property the whole namespacing exists for; asserting only that a
    // prefix EXISTS would pass on a constant one.
    expect(await prefixIn("default")).not.toBe(await prefixIn(other));
  });
});
