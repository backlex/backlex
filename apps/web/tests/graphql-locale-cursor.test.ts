/**
 * GraphQL parity with REST on two things it never had: projecting `localized`
 * fields to one locale, and keyset pagination.
 *
 * Both already existed on `/api/items` and both were absent from `/api/graphql`
 * — so the same workspace answered the same question two different ways
 * depending on which surface asked. These assertions are written against the
 * REST behaviour they mirror: the fallback chain (requested → workspace default
 * → null), and a cursor that is stable under a concurrent insert, which is the
 * whole reason to prefer it over `offset`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type TestHarness, makeHarness, seedAdmin } from "./setup";

const JSON_HEADERS = { "Content-Type": "application/json" };

describe("GraphQL locale projection + cursor pagination", () => {
  let h: TestHarness;
  const articles = "gqlarticles";
  const ids: string[] = [];

  const gql = async (query: string, variables?: Record<string, unknown>) =>
    (await (
      await h.fetch("/api/graphql", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ query, variables }),
      })
    ).json()) as { data?: Record<string, any>; errors?: { message: string }[] };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);

    // Workspace speaks en (default) + tr.
    await h.fetch("/api/admin/settings", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ i18nLocales: ["en", "tr"], i18nDefaultLocale: "en" }),
    });

    const create = await h.fetch("/api/collections", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        slug: articles,
        fields: [
          { name: "title", type: "text", localized: true },
          { name: "rank", type: "integer" },
        ],
      }),
    });
    expect(create.status).toBe(201);

    // Three rows; only the first has a Turkish title, so the fallback chain is
    // observable rather than assumed.
    const rows = [
      { title: { en: "First", tr: "Birinci" }, rank: 1 },
      { title: { en: "Second" }, rank: 2 },
      { title: { en: "Third" }, rank: 3 },
    ];
    for (const body of rows) {
      const r = await h.fetch(`/api/items/${articles}`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
      });
      expect(r.status).toBe(201);
      ids.push(((await r.json()) as { data: { id: string } }).data.id);
    }
  });

  afterAll(() => h.cleanup());

  describe("locale", () => {
    test("omitting locale still returns the full map — the old shape is unchanged", async () => {
      const res = await gql(`{ ${articles}(sort: "rank") { title } }`);
      expect(res.errors).toBeUndefined();
      expect(res.data?.[articles][0].title).toEqual({ en: "First", tr: "Birinci" });
    });

    test('locale: "*" is the full map too', async () => {
      const res = await gql(`{ ${articles}(sort: "rank", locale: "*") { title } }`);
      expect(res.data?.[articles][0].title).toEqual({ en: "First", tr: "Birinci" });
    });

    test("a locale projects to that locale's value, falling back to the workspace default", async () => {
      const res = await gql(`{ ${articles}(sort: "rank", locale: "tr") { title rank } }`);
      expect(res.errors).toBeUndefined();
      const rows = res.data?.[articles] as { title: unknown; rank: number }[];
      expect(rows[0]?.title).toBe("Birinci"); // has tr
      expect(rows[1]?.title).toBe("Second"); // no tr → default (en)
      expect(rows[2]?.title).toBe("Third");
    });

    test("a locale nobody has written falls all the way to the default", async () => {
      const res = await gql(`{ ${articles}(sort: "rank", locale: "de") { title } }`);
      expect(res.data?.[articles].map((r: { title: unknown }) => r.title)).toEqual([
        "First",
        "Second",
        "Third",
      ]);
    });

    test("the single-item query projects the same way", async () => {
      const q = `query ($id: ID!) { gqlarticle(id: $id, locale: "tr") { title } }`;
      const res = await gql(q, { id: ids[0] });
      expect(res.errors).toBeUndefined();
      expect(res.data?.gqlarticle.title).toBe("Birinci");
      const full = await gql(`query ($id: ID!) { gqlarticle(id: $id) { title } }`, { id: ids[0] });
      expect(full.data?.gqlarticle.title).toEqual({ en: "First", tr: "Birinci" });
    });

    test("GraphQL and REST agree on the projected value", async () => {
      const rest = (await (
        await h.fetch(`/api/items/${articles}?sort=rank&locale=tr`)
      ).json()) as { data: { title: unknown }[] };
      const graph = await gql(`{ ${articles}(sort: "rank", locale: "tr") { title } }`);
      expect(graph.data?.[articles].map((r: { title: unknown }) => r.title)).toEqual(
        rest.data.map((r) => r.title),
      );
    });
  });

  describe("cursor", () => {
    const page = async (cursor: string, extra = "") =>
      await gql(
        `query ($c: String) { ${articles}Page(sort: "rank", limit: 2, cursor: $c${extra}) { items { rank } nextCursor hasMore } }`,
        { c: cursor },
      );

    test('cursor: "" starts at the head and reports there is more', async () => {
      const res = await page("");
      expect(res.errors).toBeUndefined();
      const p = res.data?.[`${articles}Page`];
      expect(p.items.map((r: { rank: number }) => r.rank)).toEqual([1, 2]);
      expect(p.hasMore).toBe(true);
      expect(typeof p.nextCursor).toBe("string");
    });

    test("echoing nextCursor walks forward and the last page ends it", async () => {
      const first = (await page("")).data?.[`${articles}Page`];
      const second = (await page(first.nextCursor)).data?.[`${articles}Page`];
      expect(second.items.map((r: { rank: number }) => r.rank)).toEqual([3]);
      expect(second.hasMore).toBe(false);
      expect(second.nextCursor).toBeNull();
    });

    test("paging the whole collection yields every row exactly once", async () => {
      const seen: number[] = [];
      let cursor = "";
      for (let i = 0; i < 10; i++) {
        const p = (await page(cursor)).data?.[`${articles}Page`];
        seen.push(...p.items.map((r: { rank: number }) => r.rank));
        if (!p.hasMore) break;
        cursor = p.nextCursor;
      }
      expect(seen).toEqual([1, 2, 3]);
    });

    test("a row inserted at the head does not shift the second page — the offset bug cursors exist to fix", async () => {
      const first = (await page("")).data?.[`${articles}Page`];
      await h.fetch(`/api/items/${articles}`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ title: { en: "Zeroth" }, rank: 0 }),
      });
      const second = (await page(first.nextCursor)).data?.[`${articles}Page`];
      // Under offset:2 the insert would push rank 2 back into view. The seek
      // resumes strictly past rank 2 regardless.
      expect(second.items.map((r: { rank: number }) => r.rank)).toEqual([3]);
    });

    test("a cursor minted under a different sort is refused, not silently mispaged", async () => {
      const p = (await page("")).data?.[`${articles}Page`];
      const res = await gql(
        `query ($c: String) { ${articles}Page(sort: "rank,title", limit: 2, cursor: $c) { items { rank } } }`,
        { c: p.nextCursor },
      );
      expect(res.errors?.[0]?.message).toMatch(/[Cc]ursor/);
    });

    test("a malformed cursor is a validation error, not a 500", async () => {
      const res = await page("not-a-real-cursor");
      expect(res.errors?.[0]?.message).toMatch(/[Cc]ursor/);
    });

    test("the page field honours locale too", async () => {
      // Filtered to the one row that HAS a Turkish title — the preceding test
      // inserts a rank-0 row, so "the first row" is not a stable target.
      const res = await gql(
        `query ($f: JSON) { ${articles}Page(filter: $f, limit: 2, cursor: "", locale: "tr") { items { title } } }`,
        { f: { rank: { _eq: 1 } } },
      );
      expect(res.errors).toBeUndefined();
      expect(res.data?.[`${articles}Page`].items[0].title).toBe("Birinci");
    });

    test("a cursor is refused when the sort column is one the caller cannot read", async () => {
      // The cursor IS the sort tuple, handed to the caller base64url-encoded —
      // paginating by a private column would disclose one of its values per
      // page no matter what the field projection says.
      const secret = "gqlsecrets";
      const r = await h.fetch("/api/collections", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          slug: secret,
          fields: [
            { name: "label", type: "text" },
            { name: "salary", type: "integer", private: true },
          ],
        }),
      });
      expect(r.status).toBe(201);
      await h.fetch(`/api/items/${secret}`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ label: "a", salary: 100 }),
      });

      const denied = await gql(
        `{ ${secret}Page(sort: "salary", limit: 1, cursor: "") { items { label } nextCursor } }`,
      );
      expect(denied.errors?.[0]?.message).toMatch(/cannot read|Cannot paginate/i);

      // The same sort without a cursor is untouched — this closes the
      // disclosure, it does not restrict ordering.
      const allowed = await gql(`{ ${secret}(sort: "salary", limit: 1) { label } }`);
      expect(allowed.errors).toBeUndefined();
      expect(allowed.data?.[secret][0].label).toBe("a");
    });

    test("without a cursor the page field still works and reports hasMore", async () => {
      const res = await gql(
        `{ ${articles}Page(sort: "rank", limit: 2) { items { rank } nextCursor hasMore } }`,
      );
      const p = res.data?.[`${articles}Page`];
      expect(p.items.length).toBe(2);
      expect(p.hasMore).toBe(true);
      // Offset mode has no cursor to hand back.
      expect(p.nextCursor).toBeNull();
    });
  });
});
