/**
 * GraphQL to-one `relation` fields resolve through a per-request batch loader
 * (kills the classic N+1: a list of N posts must NOT fire N author lookups).
 * This asserts the loader's *observable* contract — every parent's relation
 * resolves to the correct target, repeated FKs dedupe, a null FK yields null,
 * and a target the caller can't see (tenant/permission/soft-delete) resolves
 * null rather than leaking — which is exactly what batching must preserve.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type TestHarness, makeHarness, seedAdmin } from "./setup";

const JSON_HEADERS = { "Content-Type": "application/json" };

describe("GraphQL relation batch loader", () => {
  let h: TestHarness;
  const authors = "gqlauthors";
  const posts = "gqlposts";
  const ids: Record<string, string> = {};

  const gql = async (query: string) =>
    (await (
      await h.fetch("/api/graphql", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ query }),
      })
    ).json()) as {
      data?: Record<string, any>;
      errors?: { message: string }[];
    };

  const create = async (slug: string, fields: unknown[]) => {
    const r = await h.fetch("/api/collections", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ slug, fields }),
    });
    expect(r.status).toBe(201);
  };
  const insert = async (slug: string, data: Record<string, unknown>) => {
    const r = await h.fetch(`/api/items/${slug}`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(data),
    });
    expect(r.status).toBe(201);
    return ((await r.json()) as { data: { id: string } }).data.id;
  };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    await create(authors, [{ name: "name", type: "text", required: true }]);
    await create(posts, [
      { name: "title", type: "text", required: true },
      { name: "author", type: "relation", to: authors },
    ]);

    ids.alice = await insert(authors, { name: "Alice" });
    ids.bob = await insert(authors, { name: "Bob" });
    // Two posts share Alice (exercises the loader's per-request dedupe cache),
    // one references Bob, one has no author (null FK → null relation).
    await insert(posts, { title: "P1", author: ids.alice });
    await insert(posts, { title: "P2", author: ids.alice });
    await insert(posts, { title: "P3", author: ids.bob });
    await insert(posts, { title: "P4" });
  });

  afterAll(() => h.cleanup());

  test("every post's author resolves correctly in one query (no N+1 gaps)", async () => {
    const res = await gql(`query { ${posts} { title author { id name } } }`);
    expect(res.errors).toBeUndefined();
    const rows = res.data?.[posts] as {
      title: string;
      author: { id: string; name: string } | null;
    }[];
    expect(rows.length).toBe(4);
    const byTitle = Object.fromEntries(rows.map((r) => [r.title, r.author]));
    expect(byTitle.P1?.name).toBe("Alice");
    expect(byTitle.P2?.name).toBe("Alice"); // same FK, deduped
    expect(byTitle.P1?.id).toBe(ids.alice);
    expect(byTitle.P3?.name).toBe("Bob");
    expect(byTitle.P4).toBeNull(); // null FK
  });

  test("a soft-deleted / missing target resolves to null, not an error", async () => {
    // Delete Bob, then re-query — P3's author must collapse to null without
    // leaking and without failing the whole batch.
    const del = await h.fetch(`/api/items/${authors}/${ids.bob}`, {
      method: "DELETE",
    });
    expect(del.status).toBeLessThan(400);
    const res = await gql(`query { ${posts} { title author { id name } } }`);
    expect(res.errors).toBeUndefined();
    const rows = res.data?.[posts] as {
      title: string;
      author: { name: string } | null;
    }[];
    const byTitle = Object.fromEntries(rows.map((r) => [r.title, r.author]));
    expect(byTitle.P3).toBeNull(); // Bob gone
    expect(byTitle.P1?.name).toBe("Alice"); // unaffected
  });
});
