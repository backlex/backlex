/**
 * Multi-surface parity for `localized` (sidecar) collection fields. A localized
 * field must behave consistently across REST, GraphQL, and MCP — the same rule
 * the other `*-surfaces.test.ts` gates enforce for their features. Covers:
 *  - REST: `?locale=` single-locale write + read, `?locale=*` full map.
 *  - GraphQL: `localized` field typed as a JSON map on read; mutation accepts a
 *    `{locale: value}` map input and the sidecar round-trips.
 *  - MCP: `collections.insert` / `collections.read` honour `locale`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("localized fields — REST / GraphQL / MCP parity", () => {
  let h: TestHarness;
  const slug = "loc_surf"; // GraphQL: list `locSurf`, mutation `createLocSurf`
  let rpcId = 1;

  const gql = async (query: string, variables?: unknown) =>
    (await (await h.fetch("/api/graphql", json({ query, variables }))).json()) as {
      data?: Record<string, any>;
      errors?: { message: string }[];
    };
  const callTool = async (name: string, args: unknown) => {
    const res = await h.fetch(
      "/mcp",
      json({ jsonrpc: "2.0", id: rpcId++, method: "tools/call", params: { name, arguments: args } }),
    );
    return (await res.json()) as {
      result?: { content?: Array<{ type: string; text: string }>; isError?: boolean };
      error?: { message: string };
    };
  };
  const toolJson = (r: Awaited<ReturnType<typeof callTool>>): any =>
    JSON.parse(r.result?.content?.[0]?.text ?? "null");

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    await h.fetch(
      "/api/admin/settings",
      { ...json({ i18nLocales: ["en", "tr"], i18nDefaultLocale: "en" }), method: "PATCH" },
    );
    await h.fetch(
      "/api/collections",
      json({ slug, fields: [{ name: "title", type: "text", localized: true, required: true }] }),
    );
  });
  afterAll(() => h.cleanup());

  test("REST: single-locale write + read, and full map", async () => {
    const created = await h.fetch(`/api/items/${slug}?locale=en`, json({ title: "Hello" }));
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { data: { id: string } }).data.id;
    await h.fetch(`/api/items/${slug}/${id}?locale=tr`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Merhaba" }),
    });
    const en = await (await h.fetch(`/api/items/${slug}/${id}?locale=en`)).json();
    expect((en as any).data.title).toBe("Hello");
    const map = await (await h.fetch(`/api/items/${slug}/${id}?locale=*`)).json();
    expect((map as any).data.title).toEqual({ en: "Hello", tr: "Merhaba" });
  });

  test("GraphQL: mutation accepts a locale map, read returns the map", async () => {
    const create = await gql(
      `mutation($d: LocSurfInput!){ createLocSurf(data: $d){ id title } }`,
      { d: { title: { en: "Hi", tr: "Selam" } } },
    );
    expect(create.errors).toBeUndefined();
    expect(create.data?.createLocSurf.title).toEqual({ en: "Hi", tr: "Selam" });
    const gid = create.data?.createLocSurf.id as string;
    const read = await gql(`query($id: ID!){ locSurfOne(id: $id){ title } }`, { id: gid });
    expect(read.errors).toBeUndefined();
    expect(read.data?.locSurfOne.title).toEqual({ en: "Hi", tr: "Selam" });
  });

  test("MCP: insert with locale, read with locale", async () => {
    const ins = await callTool("collections.insert", {
      collection: slug,
      locale: "en",
      data: { title: "McpEn" },
    });
    expect(ins.result?.isError).toBeFalsy();
    const id = toolJson(ins).data.id as string;
    await callTool("collections.update", { collection: slug, id, locale: "tr", data: { title: "McpTr" } });
    const readStar = await callTool("collections.read", { collection: slug, id, locale: "*" });
    expect(toolJson(readStar).data.title).toEqual({ en: "McpEn", tr: "McpTr" });
    const readTr = await callTool("collections.read", { collection: slug, id, locale: "tr" });
    expect(toolJson(readTr).data.title).toBe("McpTr");
  });
});
