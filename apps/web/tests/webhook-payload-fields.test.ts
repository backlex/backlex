/**
 * `payloadFields` — which keys of a row a webhook is allowed to carry.
 *
 * Every delivery used to ship the whole row, so a hook that only needed an id
 * and a status was also handed the customer's address and whatever column got
 * added last week, to a third-party endpoint, forever. The interesting cases
 * are the ones where narrowing could go wrong: the default must stay "the whole
 * row" so no existing hook changes shape on deploy, an empty list must mean
 * "everything" rather than "nothing", two hooks on one event must be able to
 * receive different bodies, and the signature must be over the body actually
 * sent.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { dispatchWebhooks, projectPayload } from "../src/server/services/webhooks";
import { buildContext } from "../src/server/context";
import { verifyWebhook } from "../../../packages/client/src/webhook";
import { type TestHarness, makeHarness, seedAdmin } from "./setup";

const JSON_HEADERS = { "Content-Type": "application/json" };

describe("projectPayload", () => {
  const row = { id: "1", status: "paid", address: "10 Downing St", note: "internal" };

  test("no list means the whole row — the default cannot narrow anything", () => {
    expect(projectPayload(row, null)).toEqual(row);
    expect(projectPayload(row, undefined)).toEqual(row);
  });

  test("an EMPTY list means the whole row, not an empty body", () => {
    // The opposite reading would silently blank every delivery for a hook whose
    // list was cleared — the failure would look like the receiver's bug.
    expect(projectPayload(row, [])).toEqual(row);
  });

  test("a list keeps exactly those keys and drops the rest", () => {
    expect(projectPayload(row, ["id", "status"])).toEqual({ id: "1", status: "paid" });
  });

  test("a listed key the row does not have is absent, not null", () => {
    // An explicit `null` reads as "this field was cleared" to a receiver.
    const out = projectPayload(row, ["id", "nope"]) as Record<string, unknown>;
    expect(out).toEqual({ id: "1" });
    expect("nope" in out).toBe(false);
  });

  test("a falsy value survives — dropping it would be a different bug", () => {
    const r = { id: "1", count: 0, ok: false, empty: "" };
    expect(projectPayload(r, ["count", "ok", "empty"])).toEqual({ count: 0, ok: false, empty: "" });
  });

  test("non-object payloads pass through — there are no keys to choose from", () => {
    expect(projectPayload([1, 2], ["id"])).toEqual([1, 2]);
    expect(projectPayload("done", ["id"])).toBe("done");
    expect(projectPayload(null, ["id"])).toBeNull();
  });

  test("only the top level is projected", () => {
    const nested = { id: "1", customer: { name: "Ada", ssn: "secret" } };
    expect(projectPayload(nested, ["customer"])).toEqual({ customer: { name: "Ada", ssn: "secret" } });
  });

  test("inherited keys are not harvested", () => {
    const proto = { leaked: "no" };
    const obj = Object.create(proto) as Record<string, unknown>;
    obj.id = "1";
    expect(projectPayload(obj, ["id", "leaked"])).toEqual({ id: "1" });
  });
});

describe("over the wire", () => {
  let h: TestHarness;
  const posts = "whposts";

  const createHook = async (body: Record<string, unknown>) => {
    const r = await h.fetch("/api/webhooks", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        name: "hook",
        url: "https://example.test/hook",
        events: [`items.${posts}.created`],
        ...body,
      }),
    });
    return r;
  };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const r = await h.fetch("/api/collections", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        slug: posts,
        fields: [
          { name: "title", type: "text" },
          { name: "secret_note", type: "text" },
        ],
      }),
    });
    expect(r.status).toBe(201);
  });

  afterAll(() => h.cleanup());

  test("payloadFields round-trips through create and list", async () => {
    const created = await createHook({ payloadFields: ["id", "title"] });
    expect(created.status).toBe(201);
    const list = (await (await h.fetch("/api/webhooks")).json()) as {
      data: Array<{ id: string; payloadFields: string[] | null }>;
    };
    const row = list.data.find((w) => w.payloadFields?.includes("title"));
    expect(row?.payloadFields).toEqual(["id", "title"]);
  });

  test("a hook created without the field stores null — the whole row", async () => {
    const created = await createHook({ name: "wide" });
    expect(created.status).toBe(201);
    const list = (await (await h.fetch("/api/webhooks")).json()) as {
      data: Array<{ name: string; payloadFields: string[] | null }>;
    };
    expect(list.data.find((w) => w.name === "wide")?.payloadFields ?? null).toBeNull();
  });

  test("the list can be cleared back to the whole row", async () => {
    const created = await createHook({ name: "narrow", payloadFields: ["id"] });
    const id = ((await created.json()) as { data: { id: string } }).data.id;
    const patched = await h.fetch(`/api/webhooks/${id}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ payloadFields: null }),
    });
    expect(patched.status).toBe(200);
    const list = (await (await h.fetch("/api/webhooks")).json()) as {
      data: Array<{ id: string; payloadFields: string[] | null }>;
    };
    expect(list.data.find((w) => w.id === id)?.payloadFields ?? null).toBeNull();
  });

  test("a non-string entry is refused rather than stored", async () => {
    const bad = await createHook({ name: "bad", payloadFields: [""] });
    expect(bad.status).toBe(422);
  });

  test("GraphQL exposes and validates the same field", async () => {
    const gql = async (query: string, variables?: Record<string, unknown>) =>
      (await (
        await h.fetch("/api/graphql", {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ query, variables }),
        })
      ).json()) as { data?: Record<string, any>; errors?: { message: string }[] };

    const ok = await gql(
      `mutation ($d: WebhookInput!) { createWebhook(data: $d) { id payloadFields } }`,
      {
        d: {
          name: "gql",
          url: "https://example.test/gql",
          events: [`items.${posts}.created`],
          payloadFields: ["id", "title"],
        },
      },
    );
    expect(ok.errors).toBeUndefined();
    expect(ok.data?.createWebhook.payloadFields).toEqual(["id", "title"]);

    const bad = await gql(
      `mutation ($d: WebhookInput!) { createWebhook(data: $d) { id } }`,
      {
        d: {
          name: "gql-bad",
          url: "https://example.test/gql",
          events: [`items.${posts}.created`],
          payloadFields: [""],
        },
      },
    );
    expect(bad.errors?.[0]?.message).toMatch(/payloadFields/);
  });
});

/**
 * The part that actually matters: a delivery carries the narrowed body, two
 * hooks on one event get DIFFERENT bodies, and the signature covers the body
 * that was sent (projecting after signing would break every receiver).
 */
describe("delivery", () => {
  let h: TestHarness;
  const realFetch = globalThis.fetch;
  const sent: Array<{ url: string; body: string; headers: Record<string, string> }> = [];

  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  afterAll(() => h.cleanup());

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });

  const stub = () => {
    sent.length = 0;
    globalThis.fetch = (async (url: unknown, init: any) => {
      sent.push({ url: String(url), body: init?.body ?? "", headers: init?.headers ?? {} });
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
  };

  const mkHook = async (body: Record<string, unknown>) => {
    const r = await h.fetch("/api/webhooks", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ events: ["items:created"], ...body }),
    });
    expect(r.status).toBe(201);
  };

  test("two hooks on one event receive the bodies each asked for", async () => {
    await mkHook({
      name: "narrow",
      url: "https://example.test/narrow",
      payloadFields: ["id", "status"],
      secret: "whsec_narrow_secret",
    });
    await mkHook({ name: "wide", url: "https://example.test/wide" });

    stub();
    const ctx = await buildContext(h.env);
    const tenants = (await (await h.fetch("/api/tenants")).json()) as {
      data: Array<{ id: string }>;
    };
    const tenantId = tenants.data[0]!.id;
    await dispatchWebhooks({ db: ctx.db, dialect: ctx.dialect } as never, tenantId, "items", {
      event: "created",
      data: { id: "row-1", status: "paid", address: "10 Downing St", note: "internal" },
    });

    const narrow = sent.find((s) => s.url.endsWith("/narrow"));
    const wide = sent.find((s) => s.url.endsWith("/wide"));
    expect(narrow).toBeDefined();
    expect(wide).toBeDefined();

    const narrowData = (JSON.parse(narrow!.body) as { data: Record<string, unknown> }).data;
    expect(narrowData).toEqual({ id: "row-1", status: "paid" });
    // The assertion that would have caught a body built once for the whole set.
    expect(narrowData.address).toBeUndefined();
    expect(narrowData.note).toBeUndefined();

    const wideData = (JSON.parse(wide!.body) as { data: Record<string, unknown> }).data;
    expect(wideData.address).toBe("10 Downing St");

    // …and the signature is over the body that was actually sent.
    const ok = await verifyWebhook({
      secret: "whsec_narrow_secret",
      body: narrow!.body,
      signature: narrow!.headers["x-backlex-signature-v2"]!,
      timestamp: narrow!.headers["x-backlex-timestamp"]!,
    });
    expect(ok).toBe(true);
  });
});
