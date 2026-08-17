/**
 * Relation depth — the third hop, and the guard that had to come first.
 *
 * `docs/querying.md` said the 2-hop ceiling existed "to keep alias lengths
 * well under PG's 63-char identifier limit". It did not do that. Field names
 * carry no length limit of their own (`USER_FIELD_NAME` is
 * `/^[a-z][a-z0-9_]*$/`), so `rel_` plus two thirty-character names is already
 * 66 characters — over the limit at TWO hops, in shipped code. Postgres
 * truncates a long identifier silently, with only a NOTICE, so two chains
 * whose aliases agree for 63 characters collapse into one and the JOIN ladder
 * reads columns off whichever table won: wrong rows, no error.
 *
 * So the ceiling was never the guard. `relationAlias` is, and it measures the
 * alias it is about to emit. With that in place the depth cap is only about
 * how legible a JOIN ladder stays, and 3 hops is affordable — the chain walker
 * in `routes/items/list.ts` was always generic over chain length.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AppError } from "@backlex/core";
import { MAX_ALIAS_CHARS, relationAlias } from "../src/server/services/items/expand";
import { MAX_NESTED_DOTS } from "../src/server/lib/query";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

describe("relationAlias", () => {
  test("builds the alias the JOIN ladder uses", () => {
    expect(relationAlias(["a"], "pg")).toBe("rel_a");
    expect(relationAlias(["a", "b", "c"], "pg")).toBe("rel_a__b__c");
  });

  test("a two-hop chain of long names is refused — the case that shipped broken", () => {
    // 30 + 30 + `rel_` + `__` = 66. Legal field names, two hops, over the
    // limit. Before this guard PG truncated it and a sibling chain could
    // silently become the same alias.
    const long = "a".repeat(30);
    let err: AppError | null = null;
    try {
      relationAlias([long, "b".repeat(30)], "pg");
    } catch (e) {
      err = e as AppError;
    }
    expect(err?.code).toBe("VALIDATION");
    // Says the measured length and the limit, because "too long" without a
    // number leaves the caller guessing which field to shorten.
    expect(err?.message).toContain("66-character");
    expect(err?.message).toContain(String(MAX_ALIAS_CHARS));
  });

  test("exactly at the limit is allowed", () => {
    // `rel_` (4) + 59 = 63.
    expect(relationAlias(["x".repeat(59)], "pg").length).toBe(MAX_ALIAS_CHARS);
  });

  test("SQLite is not held to Postgres's limit", () => {
    // SQLite has no identifier-length limit, so the failure this guards
    // against cannot happen there. Refusing anyway would break queries that
    // work today on the D1 deployments this ships to most — protecting them
    // from nothing.
    expect(relationAlias(["a".repeat(30), "b".repeat(30)], "sqlite")).toHaveLength(66);
  });

  test("the ceiling is depth, and it is now three hops", () => {
    expect(MAX_NESTED_DOTS).toBe(3);
  });
});

describe("three hops, end to end", () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const json = async (path: string, body: unknown) => {
      const res = await h.fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`);
      return (await res.json()) as { data: { id: string } };
    };

    // orders → customers → addresses → countries. Three relation hops and a
    // leaf, which the old ceiling refused outright.
    await json("/api/collections", {
      slug: "countries",
      fields: [{ name: "name", type: "text", required: true }],
    });
    await json("/api/collections", {
      slug: "places",
      fields: [
        { name: "city", type: "text", required: true },
        { name: "country_id", type: "relation", to: "countries" },
      ],
    });
    await json("/api/collections", {
      slug: "buyers",
      fields: [
        { name: "name", type: "text", required: true },
        { name: "place_id", type: "relation", to: "places" },
      ],
    });
    await json("/api/collections", {
      slug: "sales",
      fields: [
        { name: "title", type: "text", required: true },
        { name: "buyer_id", type: "relation", to: "buyers" },
      ],
    });

    const de = (await json("/api/items/countries", { name: "Germany" })).data.id;
    const fr = (await json("/api/items/countries", { name: "France" })).data.id;
    const berlin = (await json("/api/items/places", { city: "Berlin", country_id: de })).data.id;
    const paris = (await json("/api/items/places", { city: "Paris", country_id: fr })).data.id;
    const alice = (await json("/api/items/buyers", { name: "Alice", place_id: berlin })).data.id;
    const bob = (await json("/api/items/buyers", { name: "Bob", place_id: paris })).data.id;
    await json("/api/items/sales", { title: "S-1", buyer_id: alice });
    await json("/api/items/sales", { title: "S-2", buyer_id: bob });
    await json("/api/items/sales", { title: "S-3", buyer_id: alice });
  });
  afterAll(() => h.cleanup());

  const titles = async (qs: string): Promise<string[]> => {
    const res = await h.fetch(`/api/items/sales?${qs}`);
    if (res.status !== 200) throw new Error(`${res.status} ${await res.text()}`);
    return ((await res.json()) as { data: { title: string }[] }).data.map((r) => r.title);
  };

  test("a 3-hop filter resolves through the whole ladder", async () => {
    const filter = encodeURIComponent(
      JSON.stringify({ "buyer_id.place_id.country_id.name": { _eq: "Germany" } }),
    );
    expect((await titles(`filter=${filter}`)).sort()).toEqual(["S-1", "S-3"]);
  });

  test("a 3-hop sort orders by the far end of the chain", async () => {
    // France < Germany lexically, so Bob's sale leads ascending.
    expect((await titles(`sort=${encodeURIComponent("buyer_id.place_id.country_id.name")}`))[0]).toBe(
      "S-2",
    );
    expect(
      (await titles(`sort=${encodeURIComponent("-buyer_id.place_id.country_id.name")}`)).at(-1),
    ).toBe("S-2");
  });

  test("filter and sort sharing a prefix build one ladder, not two", async () => {
    // The join cache keys on the chain prefix; a second ladder would either
    // duplicate rows or collide on the alias.
    const filter = encodeURIComponent(
      JSON.stringify({ "buyer_id.place_id.country_id.name": { _eq: "Germany" } }),
    );
    const sort = encodeURIComponent("-buyer_id.place_id.city");
    const res = await h.fetch(`/api/items/sales?filter=${filter}&sort=${sort}&meta=filter_count`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[]; meta: { filter_count: number } };
    expect(body.data).toHaveLength(2);
    expect(body.meta.filter_count).toBe(2);
  });

  test("a hop that is not a relation is named, not swallowed", async () => {
    const filter = encodeURIComponent(JSON.stringify({ "buyer_id.name.x.y": { _eq: "z" } }));
    const res = await h.fetch(`/api/items/sales?filter=${filter}`);
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("is not a relation field");
  });

  test("a query reaching through too many relation paths is refused", async () => {
    // Each distinct chain is its own JOIN ladder, and each hop costs a
    // collection load and a permission resolution before any SQL runs. That
    // was unbounded; lifting the depth cap raised the worst case per chain by
    // half again, so the count is bounded now.
    // Twenty-five DISTINCT paths, not one path with twenty-five leaves —
    // leaves collapse onto a single ladder, which is exactly the case the cap
    // is not meant to catch.
    const mk = async (path: string, body: unknown) => {
      const res = await h.fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`);
    };
    await mk("/api/collections", {
      slug: "wide",
      fields: Array.from({ length: 25 }, (_, i) => ({
        name: `link${i}`,
        type: "relation",
        to: "countries",
      })),
    });
    const clauses: Record<string, unknown> = {};
    for (let i = 0; i < 25; i++) clauses[`link${i}.name`] = { _eq: "x" };
    const res = await h.fetch(
      `/api/items/wide?filter=${encodeURIComponent(JSON.stringify(clauses))}`,
    );
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("relation paths");
  });

  test("permission is still gated at every hop, not only the first", async () => {
    // The ladder loads each target collection and resolves `read` on it. A
    // deeper hop is a deeper read, and the whole point of walking it here is
    // that the gate walks with it.
    const src = await Bun.file(
      new URL("../src/server/routes/items/list.ts", import.meta.url),
    ).text();
    const hop = src.slice(src.indexOf("const resolveHop"), src.indexOf("// Walk each chain"));
    expect(hop).toContain('resolvePermission');
    expect(hop).toContain('"read"');
    expect(hop).toContain("No read permission on relation target");
  });
});
