/**
 * Multi-surface parity for the sync engine (#21). The changefeed — including
 * shape-based partial replication — is reachable from REST, the SDK, GraphQL,
 * MCP and the CLI, and all of them go through the ONE `runChangefeed` service.
 * These tests pin them to the same answers, so a surface that grows its own
 * copy of the permission / tombstone / move-out logic fails here rather than in
 * someone's offline app.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createClient } from "../../../packages/client/src/index";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const JSON_HEADERS = { "Content-Type": "application/json" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: JSON_HEADERS,
  body: JSON.stringify(body),
});

interface Page {
  data: Record<string, unknown>[];
  cursor: string | null;
  hasMore: boolean;
  shape?: string;
}

describe("sync engine — surface parity", () => {
  let h: TestHarness;
  const slug = "syncparity";
  const SHAPE = { status: { _eq: "open" } };
  let openId = "";
  let doneId = "";

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const c = await h.fetch(
      "/api/collections",
      post({
        slug,
        softDelete: true,
        fields: [
          { name: "title", type: "text", required: true },
          { name: "status", type: "text" },
        ],
      }),
    );
    expect(c.status).toBe(201);
    const mk = async (title: string, status: string) => {
      const r = await h.fetch(`/api/items/${slug}`, post({ title, status }));
      expect(r.status).toBe(201);
      return ((await r.json()) as { data: { id: string } }).data.id;
    };
    openId = await mk("open one", "open");
    await sleep(3);
    doneId = await mk("done one", "done");
  });
  afterAll(() => h.cleanup());

  /** Reduce a page to a comparable summary, so surfaces are pinned on meaning
   *  rather than on incidental field ordering. */
  const summarize = (p: Page) => ({
    inShape: p.data.filter((r) => r._shape_exit !== true).map((r) => r.id).sort(),
    exits: p.data.filter((r) => r._shape_exit === true).map((r) => r.id).sort(),
    hasMore: p.hasMore,
    shape: p.shape,
    hasCursor: Boolean(p.cursor),
  });

  test("REST is the reference answer", async () => {
    const r = await h.fetch(
      `/api/items/${slug}/changes?shape=${encodeURIComponent(JSON.stringify(SHAPE))}`,
    );
    expect(r.status).toBe(200);
    const page = (await r.json()) as Page;
    expect(summarize(page)).toEqual({
      inShape: [openId],
      exits: [doneId],
      hasMore: false,
      shape: page.shape,
      hasCursor: true,
    });
    expect(page.shape).toBeTruthy();
  });

  test("SDK `from(slug).changes()` matches REST", async () => {
    const client = createClient({ url: "", fetch: h.fetch as unknown as typeof fetch });
    const sdk = await client.from(slug).changes({ shape: SHAPE });

    const rest = (await (
      await h.fetch(`/api/items/${slug}/changes?shape=${encodeURIComponent(JSON.stringify(SHAPE))}`)
    ).json()) as Page;
    expect(summarize(sdk as unknown as Page)).toEqual(summarize(rest));
  });

  test("GraphQL `<collection>Changes` matches REST", async () => {
    const res = (await (
      await h.fetch(
        "/api/graphql",
        post({
          query: `query($s: JSON){ syncparityChanges(shape: $s) }`,
          variables: { s: SHAPE },
        }),
      )
    ).json()) as { data?: Record<string, Page>; errors?: { message: string }[] };
    expect(res.errors).toBeUndefined();

    const rest = (await (
      await h.fetch(`/api/items/${slug}/changes?shape=${encodeURIComponent(JSON.stringify(SHAPE))}`)
    ).json()) as Page;
    expect(summarize(res.data!.syncparityChanges!)).toEqual(summarize(rest));
  });

  test("MCP `collections.changes` matches REST", async () => {
    const res = await h.fetch("/mcp", {
      method: "POST",
      headers: { ...JSON_HEADERS, accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "collections.changes", arguments: { collection: slug, shape: SHAPE } },
      }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    // The tool returns the changefeed page verbatim; pin on the markers that
    // make a shaped feed correct rather than on the transport envelope.
    expect(text).toContain("_shape_exit");
    expect(text).toContain(doneId);
    expect(text).toContain(openId);
  });

  test("every surface enforces the same shape restrictions", async () => {
    const bad = { "author.name": { _eq: "x" } };

    const rest = await h.fetch(
      `/api/items/${slug}/changes?shape=${encodeURIComponent(JSON.stringify(bad))}`,
    );
    expect(rest.status).toBe(422);

    const gql = (await (
      await h.fetch(
        "/api/graphql",
        post({ query: `query($s: JSON){ syncparityChanges(shape: $s) }`, variables: { s: bad } }),
      )
    ).json()) as { errors?: { extensions?: { code?: string } }[] };
    expect(gql.errors?.[0]?.extensions?.code).toBe("VALIDATION");

    const client = createClient({ url: "", fetch: h.fetch as unknown as typeof fetch });
    await expect(client.from(slug).changes({ shape: bad as never })).rejects.toThrow();
  });

  test("the changefeed is read-gated on every surface", async () => {
    const anon = await h.app.fetch(new Request(`${h.env.APP_URL}/api/items/${slug}/changes`));
    expect(anon.status).toBe(401);

    const anonGql = await h.app.fetch(
      new Request(`${h.env.APP_URL}/api/graphql`, post({ query: `query{ syncparityChanges }` })),
    );
    // Either the request is rejected outright or the resolver denies it — both
    // are acceptable, silently returning rows is not.
    if (anonGql.status === 200) {
      const body = (await anonGql.json()) as { data?: Record<string, unknown>; errors?: unknown[] };
      expect(body.errors ?? []).not.toHaveLength(0);
      expect(body.data?.syncparityChanges).toBeFalsy();
    } else {
      expect(anonGql.status).toBeGreaterThanOrEqual(400);
    }
  });

  test("batch per-op preconditions work through REST and GraphQL alike", async () => {
    const mk = async (title: string) => {
      const r = await h.fetch(`/api/items/${slug}`, post({ title, status: "open" }));
      return ((await r.json()) as { data: { id: string; updatedAt: string } }).data;
    };
    const a = await mk("rest-precondition");
    const b = await mk("gql-precondition");
    await sleep(3);
    // Both rows move underneath the caller.
    for (const row of [a, b]) {
      const r = await h.fetch(`/api/items/${slug}/${row.id}`, {
        method: "PATCH",
        headers: JSON_HEADERS,
        body: JSON.stringify({ title: "theirs" }),
      });
      expect(r.status).toBe(200);
    }

    const rest = (await (
      await h.fetch(
        `/api/items/${slug}/batch`,
        post({
          operations: [
            { op: "update", id: a.id, data: { title: "mine" }, ifUnmodifiedSince: a.updatedAt },
          ],
        }),
      )
    ).json()) as { data: { results: { ok: boolean; error?: { code: string } }[] } };
    expect(rest.data.results[0]?.ok).toBe(false);
    expect(rest.data.results[0]?.error?.code).toBe("CONFLICT");

    const gql = (await (
      await h.fetch(
        "/api/graphql",
        post({
          query: `mutation($ops: [JSON!]!){ batchSyncparity(operations: $ops) { results } }`,
          variables: {
            ops: [
              { op: "update", id: b.id, data: { title: "mine" }, ifUnmodifiedSince: b.updatedAt },
            ],
          },
        }),
      )
    ).json()) as {
      data?: { batchSyncparity?: { results: { ok: boolean; error?: { code: string } }[] } };
      errors?: unknown[];
    };
    expect(gql.errors).toBeUndefined();
    expect(gql.data?.batchSyncparity?.results[0]?.ok).toBe(false);
    expect(gql.data?.batchSyncparity?.results[0]?.error?.code).toBe("CONFLICT");
  });
});
