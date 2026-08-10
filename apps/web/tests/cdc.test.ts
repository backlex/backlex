/**
 * CDC sinks.
 *
 * Four properties carry the feature, and each is asserted against what the
 * DESTINATION received rather than what the row says:
 *
 *  1. a delete arrives as a delete — the tombstone is the whole reason the
 *     changefeed exists, and a sink that lost it would make a warehouse quietly
 *     wrong rather than obviously broken;
 *  2. the cursor advances only after an acknowledgement, so a failed delivery
 *     is RETRIED with the same batch instead of skipped;
 *  3. a retry re-sends the same record `key`, which is what makes
 *     at-least-once usable by a destination;
 *  4. the sink reads unconditionally — its contents are a property of the
 *     sink, not of whoever created it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

let h: TestHarness;
let client: Database;

const JSON_HEADERS = { "content-type": "application/json" };
const BASE = "/api/admin/cdc-sinks";
const realFetch = globalThis.fetch;

interface Delivery {
  body: { sink: string; collection: string; records: Array<{ key: string; op: string; data: any }> };
  headers: Record<string, string>;
}
let deliveries: Delivery[] = [];
// "fail" is a destination that answers badly; "unreachable" is one that cannot
// be reached at all. They take different branches and produce different
// messages, and the second is the one an operator actually hits first.
let destinationMode: "ok" | "fail" | "unreachable" = "ok";

const stubDestination = () => {
  globalThis.fetch = (async (url: any, init: any) => {
    const u = String(url);
    if (!u.startsWith("https://sink.test/")) return realFetch(url, init);
    deliveries.push({
      body: JSON.parse(String(init?.body ?? "{}")),
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>),
      ),
    });
    if (destinationMode === "unreachable") {
      // What workerd throws for a host that does not resolve. Deliberately the
      // real string: it names no host, no operation and no cause, which is
      // exactly why the delivery path has to add them.
      throw new Error("internal error; reference = bi75mfrpaqrb6ae9bc6f248m");
    }
    return destinationMode === "ok"
      ? new Response("ok")
      : new Response("nope", { status: 500 });
  }) as typeof fetch;
};

const createCollection = () =>
  h.fetch("/api/collections", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      name: "Orders",
      slug: "orders",
      softDelete: true,
      fields: [
        { name: "title", type: "text" },
        { name: "region", type: "text" },
      ],
    }),
  });

const createSink = (over: Record<string, unknown> = {}) =>
  h.fetch(BASE, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      name: "warehouse",
      collection: "orders",
      destination: "webhook",
      config: { url: "https://sink.test/ingest", secret: "whsec_dGVzdA==" },
      ...over,
    }),
  });

const run = (id: string) => h.fetch(`${BASE}/${id}/run`, { method: "POST" });

const addOrder = (title: string, region = "eu") =>
  h.fetch("/api/items/orders", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ title, region }),
  });

beforeEach(async () => {
  deliveries = [];
  destinationMode = "ok";
  h = makeHarness();
  await seedAdmin(h);
  client = new Database(h.env.SQLITE_PATH as string);
  stubDestination();
  expect((await createCollection()).status).toBe(201);
});
afterEach(() => {
  globalThis.fetch = realFetch;
  h.cleanup();
});

describe("delivery", () => {
  test("a batch reaches the destination, signed, with a stable key per record", async () => {
    await addOrder("first");
    const sink = ((await (await createSink()).json()) as { data: { id: string } }).data;
    const res = await run(sink.id);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { delivered: number }).delivered).toBe(1);

    expect(deliveries.length).toBe(1);
    expect(deliveries[0]!.body.collection).toBe("orders");
    expect(deliveries[0]!.body.records[0]!.op).toBe("upsert");
    expect(deliveries[0]!.body.records[0]!.key).toContain("orders:");
    // Standard Webhooks, the same scheme the auth hooks sign with — an app that
    // already verifies one of ours needs no second implementation.
    expect(deliveries[0]!.headers["webhook-signature"]).toBeTruthy();
    expect(deliveries[0]!.headers["webhook-timestamp"]).toBeTruthy();
  });

  test("a DELETE arrives as a delete, not as an absence", async () => {
    const created = (await (await addOrder("doomed")).json()) as { data: { id: string } };
    const sink = ((await (await createSink()).json()) as { data: { id: string } }).data;
    await run(sink.id);
    deliveries = [];

    await h.fetch(`/api/items/orders/${created.data.id}`, { method: "DELETE" });
    await run(sink.id);

    // The tombstone is the whole reason the changefeed exists: a sink that
    // selected rows by `updated_at` would replicate every insert and update and
    // silently never replicate a delete.
    expect(deliveries.length).toBe(1);
    expect(deliveries[0]!.body.records[0]!.op).toBe("delete");
    expect(deliveries[0]!.body.records[0]!.data.id).toBe(created.data.id);
  });

  test("nothing to send means no delivery at all", async () => {
    const sink = ((await (await createSink()).json()) as { data: { id: string } }).data;
    await run(sink.id);
    deliveries = [];
    const res = await run(sink.id);
    expect(((await res.json()) as { delivered: number }).delivered).toBe(0);
    expect(deliveries.length).toBe(0);
  });
});

describe("the cursor is the acknowledgement", () => {
  test("a failed delivery does not advance it, and the SAME batch is retried", async () => {
    await addOrder("retried");
    const sink = ((await (await createSink()).json()) as { data: { id: string } }).data;

    destinationMode = "fail";
    const failed = (await (await run(sink.id)).json()) as { delivered: number; error?: string };
    expect(failed.delivered).toBe(0);
    expect(failed.error).toBeTruthy();
    const firstKey = deliveries[0]!.body.records[0]!.key;

    const row = client
      .query("select cursor, consecutive_failures from cdc_sinks where id = ?")
      .get(sink.id) as { cursor: string | null; consecutive_failures: number };
    // Advancing here would lose the row, and nobody could say which one.
    expect(row.cursor).toBeNull();
    expect(row.consecutive_failures).toBe(1);

    destinationMode = "ok";
    await run(sink.id);
    // Re-sent with an IDENTICAL key — which is what makes at-least-once usable:
    // a destination keyed on it converges instead of accumulating duplicates.
    expect(deliveries[1]!.body.records[0]!.key).toBe(firstKey);
    const after = client
      .query("select cursor, consecutive_failures from cdc_sinks where id = ?")
      .get(sink.id) as { cursor: string | null; consecutive_failures: number };
    expect(after.cursor).not.toBeNull();
    expect(after.consecutive_failures).toBe(0);
  });

  test("an unreachable destination says so, and does not leak the URL's secret", async () => {
    await addOrder("undeliverable");
    // The token in the path is the point: `lastError` is returned by the list
    // endpoint and rendered in the admin, so a message built from the URL would
    // publish it to anyone who can read the sink list.
    const created = await createSink({
      config: { url: "https://sink.test/ingest/tok_SUPERSECRET" },
    });
    const sink = ((await created.json()) as { data: { id: string } }).data;

    destinationMode = "unreachable";
    const res = (await (await run(sink.id)).json()) as { error?: string };
    // The runtime's own words are kept — they are all the detail there is —
    // but they are no longer the WHOLE message.
    expect(res.error).toContain("internal error; reference =");
    expect(res.error).toContain("POST to sink.test:");
    expect(res.error).not.toContain("tok_SUPERSECRET");

    const stored = (await (await h.fetch(BASE)).json()) as {
      data: Array<{ lastError: string | null }>;
    };
    const errors = stored.data.map((s) => s.lastError).join(" ");
    expect(errors).toContain("POST to sink.test:");
    expect(errors).not.toContain("tok_SUPERSECRET");
  });

  test("resetting the cursor replays from the beginning", async () => {
    await addOrder("replayed");
    const sink = ((await (await createSink()).json()) as { data: { id: string } }).data;
    await run(sink.id);
    deliveries = [];

    await h.fetch(`${BASE}/${sink.id}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ resetCursor: true }),
    });
    await run(sink.id);
    expect(deliveries[0]!.body.records.length).toBe(1);
  });
});

describe("what a sink replicates is a property of the sink", () => {
  test("a shape narrows it, and a row that leaves the shape is marked", async () => {
    const inEu = (await (await addOrder("eu order", "eu")).json()) as { data: { id: string } };
    await addOrder("us order", "us");
    const sink = ((await (
      await createSink({ shape: JSON.stringify({ region: { _eq: "eu" } }) })
    ).json()) as { data: { id: string } }).data;

    await run(sink.id);
    const ops = deliveries[0]!.body.records;
    // The out-of-shape row comes back as an `exit` rather than not at all —
    // a destination has to be told to drop it.
    const upserts = ops.filter((r) => r.op === "upsert");
    expect(upserts.length).toBe(1);
    expect(upserts[0]!.data.title).toBe("eu order");

    deliveries = [];
    await h.fetch(`/api/items/orders/${inEu.data.id}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ region: "us" }),
    });
    await run(sink.id);
    expect(deliveries[0]!.body.records[0]!.op).toBe("exit");
  });

  test("the sink reads unconditionally — not through its creator's permissions", async () => {
    // The admin who created this sink is an admin, so a permission-scoped read
    // would look identical. Assert the SHAPE of the call instead: the sink
    // delivers every row of the collection with no filter of its own.
    await addOrder("one");
    await addOrder("two");
    const sink = ((await (await createSink()).json()) as { data: { id: string } }).data;
    await run(sink.id);
    expect(deliveries[0]!.body.records.length).toBe(2);
  });
});

describe("configuration", () => {
  test("a webhook sink needs a URL", async () => {
    const res = await createSink({ config: {} });
    expect(res.status).toBe(422);
  });

  test("a sink for a collection that does not exist is refused at create time", async () => {
    // Otherwise it is a job that fails forever and an operator finds out from
    // the failure counter.
    const res = await createSink({ collection: "nope" });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  test("a storage prefix that could climb out of itself is refused", async () => {
    // Every one of these escapes `tenants/<id>/` if it reaches a key, which on
    // a shared deployment is a write into somebody else's namespace. The
    // percent-encoded pair is the one a hand-written `includes("..")` misses:
    // the S3 adapter's `encodeURI` leaves it intact and URL parsing folds it
    // back. `tenants/` is refused for its own reason — it is the prefix the
    // isolation is built out of.
    for (const prefix of [
      "../elsewhere",
      "/absolute",
      "a/../../b",
      "%2e%2e/%2e%2e/elsewhere",
      "back\\slash",
      "query?x=1",
      "tenants/someone-else",
    ]) {
      const res = await createSink({ destination: "storage", config: { prefix } });
      expect(res.status, `prefix ${JSON.stringify(prefix)} was accepted`).toBe(422);
    }
  });

  test("a plain prefix still works, so the guard is not refusing everything", async () => {
    const res = await createSink({ destination: "storage", config: { prefix: "warehouse/daily" } });
    expect(res.status).toBe(201);
  });

  test("the signing secret never comes back", async () => {
    await createSink();
    const listed = await (await h.fetch(BASE)).text();
    expect(listed).not.toContain("whsec_dGVzdA==");
    expect(listed).toContain("hasSecret");
  });

  test("a patch that omits the secret keeps the stored one", async () => {
    const sink = ((await (await createSink()).json()) as { data: { id: string } }).data;
    await h.fetch(`${BASE}/${sink.id}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ config: { url: "https://sink.test/other" } }),
    });
    await addOrder("signed");
    await run(sink.id);
    expect(deliveries[0]!.headers["webhook-signature"]).toBeTruthy();
  });

  test("the routes are admin-only", async () => {
    const anon = await h.app.request(
      BASE,
      { headers: { origin: "http://localhost:5173" } } as RequestInit,
      h.env,
    );
    expect(anon.status).toBeGreaterThanOrEqual(400);
  });
});

describe("a storage sink writes where the S3 endpoint can read it", () => {
  test("the batch lands as NDJSON in the workspace's own bucket", async () => {
    await addOrder("archived");
    const sink = ((await (
      await createSink({ destination: "storage", config: { prefix: "cdc" } })
    ).json()) as { data: { id: string } }).data;
    expect(((await (await run(sink.id)).json()) as { delivered: number }).delivered).toBe(1);

    // Same storage adapter the REST API and the S3 endpoint use — the point of
    // the destination is that `rclone` can pick it up from there.
    const listed = (await (await h.fetch("/api/storage?limit=100")).json()) as {
      data: Array<{ key: string }>;
    };
    const object = listed.data.find((f) => f.key.startsWith("cdc/orders/"));
    expect(object).toBeTruthy();
    const body = await (await h.fetch(`/api/storage/${object!.key}`)).text();
    const first = JSON.parse(body.trim().split("\n")[0]!) as { op: string; data: any };
    expect(first.op).toBe("upsert");
    expect(first.data.title).toBe("archived");
  });
});
