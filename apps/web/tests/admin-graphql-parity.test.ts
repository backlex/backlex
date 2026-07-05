import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

/**
 * GraphQL twins for the admin surfaces that were REST-only until 2026-07:
 * outbound webhooks, i18n strings, and the file-storage metadata plane.
 * Each mirrors its REST route through the same service helpers
 * (services/webhooks.ts, services/i18n.ts, services/storage/files.ts), so
 * these specs pin scoping + validation parity rather than re-testing the
 * underlying behavior (covered by the REST specs).
 */
const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const gqlFetch =
  (h: TestHarness) => async (query: string, variables?: unknown) =>
    (await (await h.fetch("/api/graphql", json({ query, variables }))).json()) as {
      data?: Record<string, any>;
      errors?: { message: string; extensions?: { code?: string } }[];
    };

describe("webhooks — GraphQL surface", () => {
  let h: TestHarness;
  let gql: ReturnType<typeof gqlFetch>;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    gql = gqlFetch(h);
  });
  afterAll(() => h.cleanup());

  test("createWebhook → webhooks → updateWebhook → deleteWebhook round-trips", async () => {
    const created = await gql(
      `mutation($d:WebhookInput!){ createWebhook(data:$d){ id name url events active } }`,
      { d: { name: "gql-hook", url: "https://example.com/hook", events: ["items.*"] } },
    );
    expect(created.errors).toBeUndefined();
    const hook = created.data?.createWebhook;
    expect(hook.id).toBeTruthy();
    expect(hook.active).toBe(true);
    expect(hook.events).toEqual(["items.*"]);

    const list = await gql(`{ webhooks { id name active } }`);
    expect(list.data?.webhooks.some((w: any) => w.id === hook.id)).toBe(true);

    const upd = await gql(
      `mutation($id:ID!,$d:WebhookInput!){ updateWebhook(id:$id, data:$d) }`,
      { id: hook.id, d: { name: "gql-hook-2", active: false } },
    );
    expect(upd.data?.updateWebhook).toBe(true);
    const after = await gql(`{ webhooks { id name active } }`);
    const row = after.data?.webhooks.find((w: any) => w.id === hook.id);
    expect(row.name).toBe("gql-hook-2");
    expect(row.active).toBe(false);

    const deliveries = await gql(
      `query($id:String){ webhookDeliveries(webhookId:$id){ id event } }`,
      { id: hook.id },
    );
    expect(deliveries.errors).toBeUndefined();
    expect(deliveries.data?.webhookDeliveries).toEqual([]);

    const del = await gql(`mutation($id:ID!){ deleteWebhook(id:$id) }`, { id: hook.id });
    expect(del.data?.deleteWebhook).toBe(true);
    const gone = await gql(`{ webhooks { id } }`);
    expect(gone.data?.webhooks.some((w: any) => w.id === hook.id)).toBe(false);
  });

  test("createWebhook validates like the REST zod contract", async () => {
    const noUrl = await gql(
      `mutation($d:WebhookInput!){ createWebhook(data:$d){ id } }`,
      { d: { name: "x", url: "not-a-url", events: ["a"] } },
    );
    expect(noUrl.errors?.[0]?.extensions?.code).toBe("VALIDATION");

    const noEvents = await gql(
      `mutation($d:WebhookInput!){ createWebhook(data:$d){ id } }`,
      { d: { name: "x", url: "https://example.com", events: [] } },
    );
    expect(noEvents.errors?.[0]?.extensions?.code).toBe("VALIDATION");
  });

  test("testWebhook on an unknown id surfaces NOT_FOUND", async () => {
    const res = await gql(`mutation{ testWebhook(id:"nope") }`);
    expect(res.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");
  });
});

describe("i18n — GraphQL surface", () => {
  let h: TestHarness;
  let gql: ReturnType<typeof gqlFetch>;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    gql = gqlFetch(h);
  });
  afterAll(() => h.cleanup());

  test("setI18nString upserts, lists, pivots, and deletes", async () => {
    const set = await gql(
      `mutation($d:I18nStringInput!){ setI18nString(data:$d){ id key locale value } }`,
      { d: { key: "greeting", locale: "tr", value: "Merhaba" } },
    );
    expect(set.errors).toBeUndefined();
    const id = set.data?.setI18nString.id as string;
    expect(id).toBeTruthy();

    // Same (key, locale) updates in place instead of inserting a twin.
    const again = await gql(
      `mutation($d:I18nStringInput!){ setI18nString(data:$d){ id value } }`,
      { d: { key: "greeting", locale: "tr", value: "Selam" } },
    );
    expect(again.data?.setI18nString.id).toBe(id);
    expect(again.data?.setI18nString.value).toBe("Selam");

    const bulk = await gql(
      `mutation($d:[I18nStringInput!]!){ setI18nStrings(data:$d) }`,
      {
        d: [
          { key: "bye", locale: "tr", value: "Hoşça kal" },
          { key: "bye", locale: "en", value: "Bye" },
        ],
      },
    );
    expect(bulk.data?.setI18nStrings).toEqual({ ok: true, upserts: 2 });

    const list = await gql(`{ i18nStrings { id key locale value } }`);
    expect(list.data?.i18nStrings.length).toBeGreaterThanOrEqual(3);

    const matrix = await gql(`{ i18nMatrix }`);
    expect(matrix.errors).toBeUndefined();
    expect(matrix.data?.i18nMatrix.data.greeting.tr).toBe("Selam");

    const del = await gql(`mutation($id:ID!){ deleteI18nString(id:$id) }`, { id });
    expect(del.data?.deleteI18nString).toBe(true);
    const after = await gql(`{ i18nStrings { id } }`);
    expect(after.data?.i18nStrings.some((r: any) => r.id === id)).toBe(false);
  });

  test("setI18nString validates key/locale lengths", async () => {
    const badLocale = await gql(
      `mutation($d:I18nStringInput!){ setI18nString(data:$d){ id } }`,
      { d: { key: "k", locale: "x", value: "v" } },
    );
    expect(badLocale.errors?.[0]?.extensions?.code).toBe("VALIDATION");
  });
});

describe("storage — GraphQL surface", () => {
  let h: TestHarness;
  let gql: ReturnType<typeof gqlFetch>;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    gql = gqlFetch(h);
    // Seed one object through the REST byte plane (uploads stay REST-only).
    const up = await h.fetch("/api/storage/docs/hello.txt", {
      method: "PUT",
      headers: { "content-type": "text/plain" },
      body: "hello world",
    });
    expect(up.status).toBe(201);
  });
  afterAll(() => h.cleanup());

  test("files → updateFile → deleteFile round-trips with the REST-uploaded object", async () => {
    const list = await gql(
      `query($s:String){ files(search:$s){ data { key size acl metadata } meta } }`,
      { s: "hello" },
    );
    expect(list.errors).toBeUndefined();
    const file = list.data?.files.data.find((f: any) => f.key === "docs/hello.txt");
    expect(file).toBeDefined();
    expect(file.size).toBe(11);
    expect(list.data?.files.meta.total).toBeGreaterThanOrEqual(1);

    const upd = await gql(
      `mutation($k:String!,$d:StorageFilePatchInput!){ updateFile(key:$k, data:$d) }`,
      { k: "docs/hello.txt", d: { metadata: { title: "Hello" }, acl: "public" } },
    );
    expect(upd.errors).toBeUndefined();
    expect(upd.data?.updateFile.metadata).toEqual({ title: "Hello" });

    const after = await gql(`{ files { data { key acl metadata } } }`);
    const row = after.data?.files.data.find((f: any) => f.key === "docs/hello.txt");
    expect(row.acl).toBe("public");
    expect(row.metadata).toEqual({ title: "Hello" });

    const badAcl = await gql(
      `mutation($k:String!,$d:StorageFilePatchInput!){ updateFile(key:$k, data:$d) }`,
      { k: "docs/hello.txt", d: { acl: "everyone" } },
    );
    expect(badAcl.errors?.[0]?.extensions?.code).toBe("VALIDATION");

    const del = await gql(`mutation($k:String!){ deleteFile(key:$k) }`, {
      k: "docs/hello.txt",
    });
    expect(del.data?.deleteFile).toBe(true);

    const gone = await gql(`{ files { data { key } } }`);
    expect(gone.data?.files.data.some((f: any) => f.key === "docs/hello.txt")).toBe(false);

    const missing = await gql(`mutation($k:String!){ deleteFile(key:$k) }`, {
      k: "docs/hello.txt",
    });
    expect(missing.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");
  });

  test("reserved tenant-prefix keys are rejected", async () => {
    const res = await gql(`mutation($k:String!){ deleteFile(key:$k) }`, {
      k: "tenants/whatever/x.txt",
    });
    expect(res.errors?.[0]?.extensions?.code).toBe("VALIDATION");
  });
});
