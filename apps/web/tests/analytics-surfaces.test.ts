/**
 * Product analytics + crash reporting — the cross-surface gate for #22.
 *
 * Covers the ingest endpoints and their auth (publishable key, session, and
 * the anonymous rejection), the analysis reads (overview / funnel / retention),
 * error-group triage semantics, and the parity mirrors (SDK, GraphQL, MCP,
 * CLI). If any surface drifts away from the shared service this suite fails.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import { createClient } from "../../../packages/client/src/index";
import {
  fingerprintError,
  normalizeMessage,
  stackFrames,
} from "../src/server/services/analytics";

const DAY = 86_400_000;
const STACK =
  "TypeError: boom\n  at doThing (/app/src/x.ts:12:9)\n  at main (/app/src/y.ts:3:1)";

let h: TestHarness;

beforeAll(async () => {
  h = makeHarness();
  await seedAdmin(h);
});

afterAll(() => h.cleanup());

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  h.fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

describe("fingerprinting", () => {
  test("normalizes the per-occurrence noise out of a message", () => {
    expect(normalizeMessage("Cannot read x of user 4821")).toBe(
      "Cannot read x of user <n>",
    );
    expect(
      normalizeMessage("failed for 3f2504e0-4f89-11d3-9a0c-0305e82c3301"),
    ).toBe("failed for <uuid>");
    expect(normalizeMessage("fetch https://api.example.com/v1/x?y=1 failed")).toBe(
      "fetch <url> failed",
    );
  });

  test("strips line/column numbers but keeps the frame readable", () => {
    expect(stackFrames(STACK)).toEqual([
      "doThing (/app/src/x.ts)",
      "main (/app/src/y.ts)",
    ]);
    expect(stackFrames(null)).toEqual([]);
  });

  test("same bug for different users shares a fingerprint; a different bug doesn't", async () => {
    const a = await fingerprintError({
      type: "TypeError",
      message: "Cannot read x of user 4821",
      stack: STACK,
    });
    const b = await fingerprintError({
      type: "TypeError",
      message: "Cannot read x of user 913",
      stack: STACK,
    });
    const c = await fingerprintError({
      type: "RangeError",
      message: "Cannot read x of user 913",
      stack: STACK,
    });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("ingest auth", () => {
  test("rejects anonymous ingest", async () => {
    const anon = makeHarness();
    try {
      const res = await anon.fetch("/api/analytics/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ events: [{ name: "x", distinctId: "d1" }] }),
      });
      expect(res.status).toBe(401);
    } finally {
      anon.cleanup();
    }
  });

  test("rejects an unknown ingest key", async () => {
    const res = await post(
      "/api/analytics/events",
      { events: [{ name: "x", distinctId: "d1" }] },
      { "X-Backlex-Ingest-Key": "alk_deadbeef" },
    );
    expect(res.status).toBe(401);
  });

  test("accepts an admin session, and a minted publishable key", async () => {
    const session = await post("/api/analytics/events", {
      events: [{ name: "session_ping", distinctId: "d-session" }],
    });
    expect(session.status).toBe(202);

    const mint = await h.fetch("/api/admin/analytics/ingest-key", { method: "POST" });
    expect(mint.status).toBe(201);
    const { data } = (await mint.json()) as { data: { key: string } };
    expect(data.key).toStartWith("alk_");

    const withKey = await post(
      "/api/analytics/events",
      { events: [{ name: "key_ping", distinctId: "d-key" }] },
      { "X-Backlex-Ingest-Key": data.key },
    );
    expect(withKey.status).toBe(202);
  });

  test("rotating invalidates the previous key, revoking kills the current one", async () => {
    const first = (await (
      await h.fetch("/api/admin/analytics/ingest-key", { method: "POST" })
    ).json()) as { data: { key: string } };
    const second = (await (
      await h.fetch("/api/admin/analytics/ingest-key", { method: "POST" })
    ).json()) as { data: { key: string } };
    expect(first.data.key).not.toBe(second.data.key);

    const stale = await post(
      "/api/analytics/events",
      { events: [{ name: "x", distinctId: "d" }] },
      { "X-Backlex-Ingest-Key": first.data.key },
    );
    expect(stale.status).toBe(401);

    const exists = await h.fetch("/api/admin/analytics/ingest-key");
    expect(((await exists.json()) as any).data.exists).toBe(true);

    await h.fetch("/api/admin/analytics/ingest-key", { method: "DELETE" });
    const dead = await post(
      "/api/analytics/events",
      { events: [{ name: "x", distinctId: "d" }] },
      { "X-Backlex-Ingest-Key": second.data.key },
    );
    expect(dead.status).toBe(401);
    const gone = await h.fetch("/api/admin/analytics/ingest-key");
    expect(((await gone.json()) as any).data.exists).toBe(false);
  });

  test("a max-size batch lands in full", async () => {
    // Regression guard for the D1 bound-parameter cap: a single INSERT of 500
    // 15-column rows is 7,500 params and fails with `too many SQL variables`
    // on the Worker runtime, so ingest chunks the statement. A local smoke
    // test caught this; the chunk loop is pinned here.
    const events = Array.from({ length: 500 }, (_, i) => ({
      name: "bulk_event",
      distinctId: `bulk-${i}`,
      path: `/p/${i}`,
    }));
    const res = await post("/api/analytics/events", { events });
    expect(res.status).toBe(202);
    expect(((await res.json()) as any).accepted).toBe(500);

    const stream = await h.fetch("/api/admin/analytics/events?name=bulk_event&limit=500");
    expect(((await stream.json()) as any).data.length).toBe(500);
  });

  test("a malformed row is dropped without failing the batch", async () => {
    // `name` is schema-required, so an empty one is a 422 at the edge; the
    // service-level drop is what protects a batch that passes validation but
    // carries a blank-after-trim value.
    const res = await post("/api/analytics/events", {
      events: [
        { name: "good", distinctId: "d1" },
        { name: "   ", distinctId: "d2" },
      ],
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { accepted: number; rejected: number };
    expect(body.accepted).toBe(1);
    expect(body.rejected).toBe(1);
  });
});

describe("analysis reads", () => {
  const now = Date.now();

  beforeAll(async () => {
    // Three visitors enter, all sign up, two purchase. One returns 2 days on.
    const events: unknown[] = [];
    for (const [i, u] of ["f1", "f2", "f3"].entries()) {
      events.push({
        name: "page_view",
        distinctId: u,
        sessionId: `sess-${i}`,
        path: "/pricing",
        referrer: "https://news.example.com",
        source: "web",
        ts: now - 5 * DAY,
      });
      events.push({ name: "signup", distinctId: u, ts: now - 5 * DAY + 1000 });
    }
    events.push({ name: "purchase", distinctId: "f1", ts: now - 4 * DAY });
    events.push({ name: "purchase", distinctId: "f2", ts: now - 4 * DAY });
    events.push({ name: "page_view", distinctId: "f3", ts: now - 3 * DAY });
    const res = await post("/api/analytics/events", { events });
    expect(res.status).toBe(202);
  });

  test("overview counts visitors by distinctId and zero-fills the series", async () => {
    const res = await h.fetch(
      `/api/admin/analytics/overview?from=${now - 7 * DAY}&to=${now}`,
    );
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as any;
    expect(data.totals.users).toBeGreaterThanOrEqual(3);
    expect(data.totals.sessions).toBeGreaterThanOrEqual(3);
    // 7-day span → 8 inclusive daily points, none missing.
    expect(data.series.length).toBe(8);
    expect(data.series.every((p: any) => typeof p.events === "number")).toBe(true);
    const names = data.topEvents.map((e: any) => e.name);
    expect(names).toContain("page_view");
    expect(names).toContain("signup");
    expect(data.topPaths.some((p: any) => p.path === "/pricing")).toBe(true);
    expect(data.sources.some((s: any) => s.source === "web")).toBe(true);
  });

  test("event names are listed for the funnel builder", async () => {
    const res = await h.fetch("/api/admin/analytics/event-names");
    const { data } = (await res.json()) as { data: string[] };
    expect(data).toContain("page_view");
    expect(data).toContain("purchase");
  });

  test("funnel counts ordered completions and reports drop-off", async () => {
    const res = await post("/api/admin/analytics/funnel", {
      steps: ["page_view", "signup", "purchase"],
      windowDays: 7,
      from: now - 7 * DAY,
      to: now,
    });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as any;
    expect(data.steps.map((s: any) => s.count)).toEqual([3, 3, 2]);
    expect(data.steps[0].conversion).toBe(1);
    expect(data.steps[2].conversion).toBeCloseTo(2 / 3, 5);
    expect(data.steps[2].dropOff).toBeCloseTo(1 / 3, 5);
  });

  test("funnel respects step order — a reversed funnel converts nobody", async () => {
    const res = await post("/api/admin/analytics/funnel", {
      steps: ["purchase", "page_view", "signup"],
      windowDays: 7,
      from: now - 7 * DAY,
      to: now,
    });
    const { data } = (await res.json()) as any;
    // f3 never purchased; f1/f2 purchased AFTER their page_view+signup, so
    // nothing follows a purchase inside the window.
    expect(data.steps[0].count).toBe(2);
    expect(data.steps[2].count).toBe(0);
  });

  test("the conversion window is measured from the visitor's own entry", async () => {
    // f3 returns 2 days after signing up, so a 1-day window must exclude it and
    // a 7-day window must include it. Pinned on both dialects — the Postgres
    // twin of this assertion lives in analytics-pg.test.ts.
    const windowed = async (windowDays: number) => {
      const res = await post("/api/admin/analytics/funnel", {
        steps: ["signup", "page_view"],
        windowDays,
        from: now - 7 * DAY,
        to: now,
      });
      return ((await res.json()) as any).data.steps[1].count;
    };
    expect(await windowed(1)).toBe(0);
    expect(await windowed(7)).toBe(1);
  });

  test("funnel rejects a single step", async () => {
    const res = await post("/api/admin/analytics/funnel", {
      steps: ["page_view"],
      from: now - 7 * DAY,
      to: now,
    });
    expect(res.status).toBe(422);
  });

  test("retention groups by first-ever day and counts later activity", async () => {
    const res = await post("/api/admin/analytics/retention", {
      from: now - 7 * DAY,
      to: now,
    });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as any;
    const cohort = data.cohorts.find((c: any) => c.size >= 3);
    expect(cohort).toBeDefined();
    expect(cohort.values[0]).toBe(cohort.size);
    // two purchased the next day, one returned the day after that
    expect(cohort.values[1]).toBeGreaterThanOrEqual(2);
    expect(cohort.values[2]).toBeGreaterThanOrEqual(1);
  });

  test("the raw stream is filterable and admin-gated", async () => {
    const res = await h.fetch("/api/admin/analytics/events?name=purchase&limit=10");
    const { data } = (await res.json()) as any;
    expect(data.length).toBe(2);
    expect(data.every((e: any) => e.name === "purchase")).toBe(true);
  });

  test("a range wider than the cap is rejected", async () => {
    const res = await h.fetch(
      `/api/admin/analytics/overview?from=${now - 400 * DAY}&to=${now}`,
    );
    expect(res.status).toBe(422);
  });
});

describe("error groups", () => {
  let groupId: string;

  beforeAll(async () => {
    const res = await post("/api/analytics/errors", {
      errors: [
        {
          message: "Cannot read x of user 4821",
          type: "TypeError",
          stack: STACK,
          distinctId: "e1",
        },
        {
          message: "Cannot read x of user 913",
          type: "TypeError",
          stack: STACK,
          distinctId: "e2",
        },
        { message: "totally different", type: "RangeError", stack: STACK },
      ],
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { accepted: number; groups: string[] };
    expect(body.accepted).toBe(3);
    // Two distinct bugs, not three occurrences.
    expect(body.groups.length).toBe(2);
  });

  test("occurrences fold into one group with a lifetime counter", async () => {
    const res = await h.fetch("/api/admin/analytics/errors");
    const { data } = (await res.json()) as any;
    const typeErr = data.find((g: any) => g.type === "TypeError");
    expect(typeErr.events).toBe(2);
    expect(typeErr.culprit).toBe("doThing (/app/src/x.ts)");
    expect(typeErr.status).toBe("open");
    groupId = typeErr.id;
  });

  test("detail carries stacks, a daily series and the affected-visitor count", async () => {
    const res = await h.fetch(`/api/admin/analytics/errors/${groupId}`);
    const { data } = (await res.json()) as any;
    expect(data.occurrences.length).toBe(2);
    expect(data.occurrences[0].stack).toContain("doThing");
    expect(data.users).toBe(2);
    expect(data.series.length).toBeGreaterThanOrEqual(1);
  });

  test("resolving stamps the actor; a new occurrence reopens it", async () => {
    const patch = await h.fetch(`/api/admin/analytics/errors/${groupId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "resolved" }),
    });
    expect(patch.status).toBe(200);
    const resolved = ((await patch.json()) as any).data;
    expect(resolved.status).toBe("resolved");
    expect(resolved.resolvedBy).toBeTruthy();

    await post("/api/analytics/errors", {
      errors: [{ message: "Cannot read x of user 77", type: "TypeError", stack: STACK }],
    });
    const after = await h.fetch(`/api/admin/analytics/errors/${groupId}`);
    expect(((await after.json()) as any).data.group.status).toBe("open");
  });

  test("ignoring is sticky — a new occurrence counts but doesn't reopen", async () => {
    await h.fetch(`/api/admin/analytics/errors/${groupId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "ignored" }),
    });
    await post("/api/analytics/errors", {
      errors: [{ message: "Cannot read x of user 5", type: "TypeError", stack: STACK }],
    });
    const after = await h.fetch(`/api/admin/analytics/errors/${groupId}`);
    const { data } = (await after.json()) as any;
    expect(data.group.status).toBe("ignored");
    expect(data.group.events).toBe(4);
  });

  test("status filter and an invalid status", async () => {
    const ignored = await h.fetch("/api/admin/analytics/errors?status=ignored");
    expect(((await ignored.json()) as any).data.length).toBe(1);

    const bad = await h.fetch(`/api/admin/analytics/errors/${groupId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "wontfix" }),
    });
    expect(bad.status).toBe(422);
  });

  test("delete removes the group and its occurrences", async () => {
    const del = await h.fetch(`/api/admin/analytics/errors/${groupId}`, {
      method: "DELETE",
    });
    expect(del.status).toBe(200);
    const gone = await h.fetch(`/api/admin/analytics/errors/${groupId}`);
    expect(gone.status).toBe(404);
  });
});

/* ── Parity mirrors ───────────────────────────────────────────────────── */

describe("SDK surface", () => {
  let sdk: TestHarness;
  let client: ReturnType<typeof createClient>;

  beforeAll(async () => {
    sdk = makeHarness();
    await seedAdmin(sdk);
    client = createClient({ url: "", fetch: sdk.fetch as unknown as typeof fetch });
  });
  afterAll(() => sdk.cleanup());

  test("track/identify stamp a stable visitor id, and reporting round-trips", async () => {
    const generated = client.analytics.distinctId();
    expect(generated).toBeTruthy();
    // The same client keeps the same id — that's what makes retention work.
    expect(client.analytics.distinctId()).toBe(generated);

    const first = await client.analytics.track("sdk_view", { plan: "pro" });
    expect(first.accepted).toBe(1);

    client.analytics.identify("sdk-user-1", { userId: "u-1" });
    await client.analytics.track("sdk_signup");

    const rows = await client.analytics.events({ name: "sdk_signup" });
    expect(rows.data[0]?.distinctId).toBe("sdk-user-1");
    expect(rows.data[0]?.userId).toBe("u-1");

    const overview = await client.analytics.overview();
    expect(overview.data.totals.events).toBeGreaterThanOrEqual(2);
    expect((await client.analytics.eventNames()).data).toContain("sdk_view");
  });

  test("trackError accepts a real Error and folds it into a group", async () => {
    const err = new TypeError("sdk exploded at 42");
    err.stack = STACK;
    const res = await client.analytics.trackError(err, { release: "1.2.3" });
    expect(res.accepted).toBe(1);
    expect(res.groups.length).toBe(1);

    const groups = await client.analytics.errors.list();
    const g = groups.data.find((x) => x.id === res.groups[0]);
    expect(g?.type).toBe("TypeError");
    expect(g?.release).toBe("1.2.3");

    const detail = await client.analytics.errors.get(g!.id);
    expect(detail.data.occurrences[0]?.stack).toContain("doThing");

    expect((await client.analytics.errors.update(g!.id, { status: "resolved" })).data.status)
      .toBe("resolved");
    expect((await client.analytics.errors.delete(g!.id)).ok).toBe(true);
  });

  test("funnel + retention mirror the REST results", async () => {
    const funnel = await client.analytics.funnel({
      steps: ["sdk_view", "sdk_signup"],
      windowDays: 7,
    });
    expect(funnel.data.steps.length).toBe(2);
    expect(funnel.data.windowDays).toBe(7);
    const retention = await client.analytics.retention();
    expect(Array.isArray(retention.data.cohorts)).toBe(true);
  });

  test("ingest-key round-trips and authenticates a keyed client", async () => {
    expect((await client.analytics.ingestKey.status()).data.exists).toBe(false);
    const { data } = await client.analytics.ingestKey.mint();
    expect((await client.analytics.ingestKey.status()).data.exists).toBe(true);

    // A browser-shaped client: publishable key only, no session.
    const keyed = createClient({
      url: "",
      ingestKey: data.key,
      fetch: sdk.fetch as unknown as typeof fetch,
    });
    expect((await keyed.analytics.track("from_browser")).accepted).toBe(1);

    expect((await client.analytics.ingestKey.revoke()).ok).toBe(true);
  });

  test("captureErrors is a no-op outside a browser and returns an unsubscribe", () => {
    const off = client.analytics.captureErrors();
    expect(typeof off).toBe("function");
    off();
  });
});

describe("GraphQL surface", () => {
  let g: TestHarness;

  const gql = async (query: string, variables?: unknown) =>
    (await (
      await g.fetch("/api/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query, variables }),
      })
    ).json()) as {
      data?: Record<string, any>;
      errors?: { message: string; extensions?: { code?: string } }[];
    };

  beforeAll(async () => {
    g = makeHarness();
    await seedAdmin(g);
    const seeded = await gql(
      `mutation ($events: [TrackEventInput!]!) { trackEvents(events: $events) { accepted rejected } }`,
      {
        events: [
          { name: "gql_view", distinctId: "g1", ts: Date.now() - 60_000 },
          { name: "gql_signup", distinctId: "g1", ts: Date.now() },
          { name: "gql_view", distinctId: "g2", ts: Date.now() - 60_000 },
        ],
      },
    );
    expect(seeded.data?.trackEvents.accepted).toBe(3);
  });
  afterAll(() => g.cleanup());

  test("overview / eventNames / events read back", async () => {
    const r = await gql(`{
      analyticsOverview { totals { events users } topEvents { name count } topPaths { value count } }
      analyticsEventNames
      analyticsEvents(name: "gql_signup") { name distinctId }
    }`);
    expect(r.errors).toBeUndefined();
    expect(r.data?.analyticsOverview.totals.events).toBe(3);
    expect(r.data?.analyticsOverview.totals.users).toBe(2);
    expect(r.data?.analyticsEventNames).toContain("gql_view");
    expect(r.data?.analyticsEvents[0].distinctId).toBe("g1");
  });

  test("funnel + retention resolve", async () => {
    const r = await gql(`{
      analyticsFunnel(steps: ["gql_view", "gql_signup"], windowDays: 7) {
        windowDays steps { name count conversion }
      }
      analyticsRetention { maxOffset cohorts { day size values } }
    }`);
    expect(r.errors).toBeUndefined();
    expect(r.data?.analyticsFunnel.steps.map((s: any) => s.count)).toEqual([2, 1]);
    expect(r.data?.analyticsRetention.cohorts[0].size).toBe(2);
  });

  test("trackErrors → errorGroups → updateErrorGroup → deleteErrorGroup", async () => {
    const tracked = await gql(
      `mutation ($errors: [TrackErrorInput!]!) { trackErrors(errors: $errors) { accepted groups } }`,
      { errors: [{ message: "gql boom 12", type: "TypeError", stack: STACK }] },
    );
    const id = tracked.data?.trackErrors.groups[0] as string;
    expect(id).toBeTruthy();

    const listed = await gql(`{ errorGroups { id type message events status } }`);
    expect(listed.data?.errorGroups.some((x: any) => x.id === id)).toBe(true);

    const detail = await gql(`query ($id: ID!) { errorGroup(id: $id) { users occurrences { stack } } }`, { id });
    expect(detail.data?.errorGroup.occurrences[0].stack).toContain("doThing");

    const updated = await gql(
      `mutation ($id: ID!) { updateErrorGroup(id: $id, status: "ignored") { status } }`,
      { id },
    );
    expect(updated.data?.updateErrorGroup.status).toBe("ignored");

    const deleted = await gql(`mutation ($id: ID!) { deleteErrorGroup(id: $id) }`, { id });
    expect(deleted.data?.deleteErrorGroup).toBe(true);
  });

  test("a non-admin is refused", async () => {
    const anon = makeHarness();
    try {
      const res = await anon.fetch("/api/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: `{ analyticsEventNames }` }),
      });
      const body = (await res.json()) as any;
      expect(body.data?.analyticsEventNames ?? null).toBeNull();
    } finally {
      anon.cleanup();
    }
  });
});

describe("MCP surface", () => {
  let m: TestHarness;

  const callTool = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await m.fetch("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    const body = (await res.json()) as any;
    if (body.error) throw new Error(`${name}: ${body.error.message}`);
    return body.result;
  };

  beforeAll(async () => {
    m = makeHarness();
    await seedAdmin(m);
    await m.fetch("/api/analytics/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        // Ordering is strict (`>`), so the two steps need distinct times —
        // separate `track()` calls get that for free, a single batch does not.
        events: [
          { name: "mcp_view", distinctId: "m1", ts: Date.now() - 60_000 },
          { name: "mcp_signup", distinctId: "m1", ts: Date.now() },
        ],
      }),
    });
    await m.fetch("/api/analytics/errors", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        errors: [{ message: "mcp boom 9", type: "TypeError", stack: STACK }],
      }),
    });
  });
  afterAll(() => m.cleanup());

  test("every analytics tool is advertised, with reads classified as reads", async () => {
    const res = await m.fetch("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    const tools = ((await res.json()) as any).result.tools as {
      name: string;
      annotations?: { readOnlyHint?: boolean };
    }[];
    const byName = new Map(tools.map((t) => [t.name, t]));
    // The MCP transport exposes dotted tool names with dashes.
    for (const n of [
      "analytics-overview",
      "analytics-event_names",
      "analytics-funnel",
      "analytics-retention",
      "analytics-events",
      "analytics-realtime",
      "analytics-sessions",
      "analytics-channels",
      "analytics-revenue",
      "analytics-segments",
      "analytics-segment_save",
      "analytics-segment_delete",
      "analytics-sites",
      "analytics-site_create",
      "analytics-site_update",
      "analytics-site_delete",
      "errors-list",
      "errors-get",
      "errors-update",
      "errors-delete",
    ]) {
      expect(byName.has(n)).toBe(true);
    }
    // The name heuristic defaults unknown verbs to `write`; these carry an
    // explicit read kind so read-only keys aren't wrongly blocked.
    expect(byName.get("analytics-overview")?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get("analytics-funnel")?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get("analytics-retention")?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get("analytics-events")?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get("analytics-sites")?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get("analytics-realtime")?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get("analytics-sessions")?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get("analytics-channels")?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get("analytics-revenue")?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get("analytics-segments")?.annotations?.readOnlyHint).toBe(true);
    // Saving a segment changes what every report returns, so it must never be
    // reachable by a read-only key.
    expect(byName.get("analytics-segment_save")?.annotations?.readOnlyHint).toBe(false);
    expect(byName.get("analytics-segment_delete")?.annotations?.readOnlyHint).toBe(false);
    expect(byName.get("errors-update")?.annotations?.readOnlyHint).toBe(false);
    // Site mutations must NOT read as read-only: a read-only key that could
    // repoint a site's domain would be read-only in name only.
    expect(byName.get("analytics-site_create")?.annotations?.readOnlyHint).toBe(false);
    expect(byName.get("analytics-site_delete")?.annotations?.readOnlyHint).toBe(false);
  });

  test("overview / funnel / errors dispatch through to the service", async () => {
    const overview = await callTool("analytics-overview");
    expect(overview.structuredContent.data.totals.events).toBe(2);

    const funnel = await callTool("analytics-funnel", {
      steps: ["mcp_view", "mcp_signup"],
    });
    expect(funnel.structuredContent.data.steps.map((s: any) => s.count)).toEqual([1, 1]);

    const names = await callTool("analytics-event_names");
    expect(names.structuredContent.data).toContain("mcp_view");

    const groups = await callTool("errors-list");
    const id = groups.structuredContent.data[0].id as string;
    const detail = await callTool("errors-get", { id });
    expect(detail.structuredContent.data.group.type).toBe("TypeError");

    const updated = await callTool("errors-update", { id, status: "resolved" });
    expect(updated.structuredContent.data.status).toBe("resolved");
    await callTool("errors-delete", { id });
    expect((await callTool("errors-list")).structuredContent.data.length).toBe(0);
  });
});

describe("CLI surface", () => {
  test("every documented subcommand is dispatched", async () => {
    const src = await Bun.file(
      new URL("../../../packages/cli/src/analytics.ts", import.meta.url),
    ).text();
    for (const sub of [
      "overview",
      "events",
      "event-names",
      "funnel",
      "retention",
      "errors",
      "error",
      "resolve",
      "ignore",
      "reopen",
      "delete-error",
      "track",
      "report-error",
      "ingest-key",
      "sites",
      "realtime",
      "sessions",
      "channels",
      "revenue",
      "segments",
    ]) {
      expect(src).toContain(`case "${sub}"`);
    }
    const bin = await Bun.file(
      new URL("../../../packages/cli/bin/backlex.ts", import.meta.url),
    ).text();
    expect(bin).toContain('case "analytics"');
    expect(bin).toContain("runAnalytics");
  });
});

describe("analytics panels", () => {
  let p: TestHarness;

  beforeAll(async () => {
    p = makeHarness();
    await seedAdmin(p);
    await p.fetch("/api/analytics/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        events: [
          { name: "panel_view", distinctId: "p1", path: "/x", ts: Date.now() - 60_000 },
          { name: "panel_buy", distinctId: "p1", ts: Date.now() },
          { name: "panel_view", distinctId: "p2", path: "/x", ts: Date.now() - 60_000 },
        ],
      }),
    });
  });
  afterAll(() => p.cleanup());

  const preview = async (config: unknown) => {
    const res = await p.fetch("/api/admin/panels/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "analytics", config }),
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as any).data as Record<string, unknown>[];
  };

  test("each metric flattens into renderable rows", async () => {
    expect((await preview({ metric: "totals" }))[0]).toMatchObject({ events: 3, users: 2 });
    expect((await preview({ metric: "top-events" }))[0]).toMatchObject({
      name: "panel_view",
      count: 2,
    });
    expect((await preview({ metric: "top-paths" }))[0]).toMatchObject({ path: "/x" });
    const series = await preview({ metric: "series", rangeDays: 7 });
    expect(series.length).toBe(8);
    const funnel = await preview({
      metric: "funnel",
      steps: ["panel_view", "panel_buy"],
    });
    expect(funnel).toEqual([
      { step: "panel_view", users: 2 },
      { step: "panel_buy", users: 1 },
    ]);
    const retention = await preview({ metric: "retention" });
    expect(retention[0]).toMatchObject({ day: "Day 0", users: 2 });
  });

  test("a saved analytics panel runs and rides a dashboard", async () => {
    const created = await p.fetch("/api/admin/panels", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Daily events",
        kind: "analytics",
        viz: "line",
        config: { metric: "series", rangeDays: 7 },
      }),
    });
    expect(created.status).toBe(201);
    const panelId = ((await created.json()) as any).data.id as string;

    const run = await p.fetch(`/api/admin/panels/${panelId}/run`, { method: "POST" });
    expect(run.status).toBe(200);
    expect(((await run.json()) as any).data.length).toBe(8);

    const dash = await p.fetch("/api/admin/dashboards", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Product" }),
    });
    const dashId = ((await dash.json()) as any).data.id as string;
    await p.fetch(`/api/admin/panels/${panelId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dashboardId: dashId }),
    });

    const ran = await p.fetch(`/api/admin/dashboards/${dashId}/run`, { method: "POST" });
    const results = ((await ran.json()) as any).data as any[];
    expect(results[0].kind).toBe("analytics");
    expect(results[0].data.length).toBe(8);
    expect(results[0].error).toBeUndefined();
  });
});

describe("admin surface is admin-gated", () => {
  test("a non-admin session can't read analytics", async () => {
    const other = makeHarness();
    try {
      await seedAdmin(other);
      // Second user signs up into the same workspace without the admin role.
      const email = `viewer-${Date.now()}@example.test`;
      const signUp = await other.fetch("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password: "correct-horse-battery", name: "V" }),
      });
      expect(signUp.ok).toBe(true);
      const res = await other.fetch("/api/admin/analytics/overview");
      expect(res.status).toBe(403);
    } finally {
      other.cleanup();
    }
  });
});
