/**
 * Multi-surface parity for geo fields.
 *
 * Reading a point proves little — it is a JSON column on the read path. What
 * has to hold identically on every surface is what the SERVER owns:
 *
 *   1. **A point is canonicalized to `{ lat, lng }` on the way in.** Four input
 *      shapes are accepted, and every surface has to store, echo and broadcast
 *      the same one — otherwise a client that posted a GeoJSON pair gets an
 *      array back from a create and an object back from the next read.
 *   2. **A coordinate that is not on the earth is refused.** REST gets this
 *      from `validateValue`; GraphQL's resolver never calls it, so latitude 91
 *      went in verbatim and `_near` then read the row as having no location at
 *      all — invisible, with nothing logged.
 *   3. **Auto-geocode fires from every write surface**, because the resolvers
 *      that hand-build their own SQL do not go through `performCreate` — which
 *      is exactly how the rollup refresh (#38) and the sequence allocation
 *      (#39) each shipped on four surfaces out of five the first time.
 *   4. **`_near` is a filter, so it works wherever a filter does.**
 *
 * The CLI is checked structurally rather than by spawning a shell — it is a
 * thin argv parser over the SDK, and what rots is a subcommand quietly
 * disappearing from the dispatch or the help.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "../../../packages/client/src/index";
import { geoTools } from "../src/server/mcp/tools/geo";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const GEOCODE_HOST = "http://nominatim.test";
/** Sultanahmet — the one place the fake provider knows. */
const POINT = { lat: 41.0082, lng: 28.9784 };
const ADDRESS = "Sultanahmet, İstanbul";

let h: TestHarness;
let restoreFetch: () => void;
let providerCalls: number;

const json = (body: unknown, method = "POST"): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const gql = async (query: string, variables?: unknown) =>
  (await (await h.fetch("/api/graphql", json({ query, variables }))).json()) as {
    data?: Record<string, any>;
    errors?: { message: string }[];
  };

const sdk = () => createClient({ url: "", fetch: h.fetch as unknown as typeof fetch });

const mcp = (name: string, args: Record<string, unknown>) => {
  const tool = geoTools.find((x) => x.name === name);
  if (!tool) throw new Error(`missing MCP tool ${name}`);
  return tool.handler(args, {
    fetchInternal: (p: string, init?: RequestInit) => h.fetch(p, init),
  } as never);
};

const SLUG = "geo_sites";

const installProvider = () => {
  const real = globalThis.fetch;
  providerCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!href.startsWith(GEOCODE_HOST)) return real(input as never, init);
    providerCalls++;
    const url = new URL(href);
    if (url.pathname === "/reverse") {
      return Response.json({ lat: POINT.lat, lon: POINT.lng, display_name: "Sultanahmet" });
    }
    return Response.json(
      (url.searchParams.get("q") ?? "").includes("Sultanahmet")
        ? [{ lat: String(POINT.lat), lon: String(POINT.lng), display_name: "Sultanahmet Meydanı" }]
        : [],
    );
  }) as typeof fetch;
  return () => { globalThis.fetch = real; };
};

beforeEach(async () => {
  h = makeHarness({ GEOCODE_PROVIDER: "nominatim", GEOCODE_URL: GEOCODE_HOST });
  await seedAdmin(h);
  restoreFetch = installProvider();
  await h.fetch(
    "/api/collections",
    json({
      slug: SLUG,
      fields: [
        { name: "name", type: "text", required: true },
        { name: "address", type: "text" },
        { name: "city", type: "text" },
        { name: "location", type: "geo", geo: { geocodeFrom: ["address", "city"] } },
      ],
    }),
  );
});
afterEach(() => {
  restoreFetch();
  h.cleanup();
});

/** Read one row straight back, so every assertion compares against what is
 *  actually STORED rather than against what the write surface echoed. */
const stored = async (id: string): Promise<Record<string, any>> =>
  ((await (await h.fetch(`/api/items/${SLUG}/${id}`)).json()) as any).data;

describe("a point is stored in one shape, whichever surface writes it", () => {
  // The GeoJSON pair is the sharpest case: it is [lng, lat], so a surface that
  // stored it verbatim would also have the axes the wrong way round.
  const GEOJSON_PAIR = [POINT.lng, POINT.lat];

  test("REST", async () => {
    const r = await h.fetch(`/api/items/${SLUG}`, json({ name: "rest", location: GEOJSON_PAIR }));
    const created = (await r.json()) as any;
    expect(created.data.location).toEqual(POINT);
    expect(await stored(created.data.id)).toMatchObject({ location: POINT });
  });

  test("SDK", async () => {
    const c = sdk();
    const created = (await c.from(SLUG).create({ name: "sdk", location: GEOJSON_PAIR } as never)) as any;
    expect(created.data.location).toEqual(POINT);
    expect(await stored(created.data.id)).toMatchObject({ location: POINT });
  });

  test("GraphQL", async () => {
    const res = await gql(
      `mutation ($data: JSON!) { createGeoSites(data: { name: "gql", location: $data }) { id location } }`,
      { data: GEOJSON_PAIR },
    );
    expect(res.errors).toBeUndefined();
    const row = res.data!.createGeoSites;
    // The hand-built response object, not just the column — a client that
    // creates a row must not have to re-read it to learn the shape.
    expect(row.location).toEqual(POINT);
    expect(await stored(row.id)).toMatchObject({ location: POINT });
  });

  test("batch", async () => {
    const r = await h.fetch(
      `/api/items/${SLUG}/batch`,
      json({ operations: [{ op: "create", data: { name: "batch", location: GEOJSON_PAIR } }] }),
    );
    expect(r.status).toBe(200);
    const listed = (await (await h.fetch(`/api/items/${SLUG}?limit=100`)).json()) as any;
    const row = listed.data.find((x: any) => x.name === "batch");
    expect(row.location).toEqual(POINT);
  });
});

describe("a coordinate off the earth is refused, whichever surface sends it", () => {
  const BAD = { lat: 91, lng: 0 };

  test("REST", async () => {
    const r = await h.fetch(`/api/items/${SLUG}`, json({ name: "x", location: BAD }));
    expect(r.status).toBe(422);
  });

  test("SDK", async () => {
    await expect(
      sdk().from(SLUG).create({ name: "x", location: BAD } as never),
    ).rejects.toThrow();
  });

  test("GraphQL", async () => {
    const res = await gql(
      `mutation ($data: JSON!) { createGeoSites(data: { name: "x", location: $data }) { id } }`,
      { data: BAD },
    );
    expect(res.errors?.[0]?.message).toContain("latitude");
    // And nothing was written — a refused write must not leave a row behind.
    const listed = (await (await h.fetch(`/api/items/${SLUG}?limit=100`)).json()) as any;
    expect(listed.data).toHaveLength(0);
  });

  test("GraphQL, on update too", async () => {
    const r = await h.fetch(`/api/items/${SLUG}`, json({ name: "ok", location: POINT }));
    const id = ((await r.json()) as any).data.id;
    const res = await gql(
      `mutation ($id: ID!, $data: JSON!) { updateGeoSites(id: $id, data: { location: $data }) { id } }`,
      { id, data: { lat: 0, lng: 181 } },
    );
    expect(res.errors?.[0]?.message).toContain("longitude");
    expect(await stored(id)).toMatchObject({ location: POINT });
  });
});

describe("the address is geocoded, whichever surface writes it", () => {
  test("REST", async () => {
    const r = await h.fetch(`/api/items/${SLUG}`, json({ name: "rest", address: ADDRESS }));
    expect(((await r.json()) as any).data.location).toEqual(POINT);
  });

  test("SDK", async () => {
    const created = (await sdk().from(SLUG).create({ name: "sdk", address: ADDRESS } as never)) as any;
    expect(created.data.location).toEqual(POINT);
  });

  test("GraphQL", async () => {
    const res = await gql(
      `mutation { createGeoSites(data: { name: "gql", address: "${ADDRESS}" }) { id location } }`,
    );
    expect(res.errors).toBeUndefined();
    expect(res.data!.createGeoSites.location).toEqual(POINT);
    expect(await stored(res.data!.createGeoSites.id)).toMatchObject({ location: POINT });
  });

  test("GraphQL, on update", async () => {
    const res = await gql(`mutation { createGeoSites(data: { name: "gql" }) { id } }`);
    const id = res.data!.createGeoSites.id;
    expect(await stored(id)).toMatchObject({ location: null });
    const upd = await gql(
      `mutation ($id: ID!) { updateGeoSites(id: $id, data: { address: "${ADDRESS}" }) { id } }`,
      { id },
    );
    expect(upd.errors).toBeUndefined();
    expect(await stored(id)).toMatchObject({ location: POINT });
  });

  test("an explicit point still wins on every surface", async () => {
    const before = providerCalls;
    const hand = { lat: 1, lng: 2 };
    await h.fetch(`/api/items/${SLUG}`, json({ name: "r", address: ADDRESS, location: hand }));
    await sdk().from(SLUG).create({ name: "s", address: ADDRESS, location: hand } as never);
    await gql(
      `mutation ($p: JSON!) { createGeoSites(data: { name: "g", address: "${ADDRESS}", location: $p }) { id } }`,
      { p: hand },
    );
    expect(providerCalls).toBe(before);
    const listed = (await (await h.fetch(`/api/items/${SLUG}?limit=100`)).json()) as any;
    for (const row of listed.data) expect(row.location).toEqual(hand);
  });
});

describe("`_near` narrows the same way, whichever surface asks", () => {
  const near = (radius: string) =>
    JSON.stringify({ location: { _near: { ...POINT, radius } } });

  beforeEach(async () => {
    // Two rows about 5.7 km apart, plus one with no location at all.
    await h.fetch(`/api/items/${SLUG}`, json({ name: "here", location: POINT }));
    await h.fetch(`/api/items/${SLUG}`, json({ name: "across", location: { lat: 41.0422, lng: 29.0083 } }));
    await h.fetch(`/api/items/${SLUG}`, json({ name: "nowhere" }));
  });

  test("REST", async () => {
    const r = await h.fetch(`/api/items/${SLUG}?filter=${encodeURIComponent(near("2km"))}&limit=100`);
    const body = (await r.json()) as any;
    expect(body.data.map((x: any) => x.name)).toEqual(["here"]);
  });

  test("SDK", async () => {
    const res = await sdk()
      .from(SLUG)
      .list({ filter: { location: { _near: { ...POINT, radius: "2km" } } } as never, limit: 100 });
    expect(res.data.map((x: any) => x.name)).toEqual(["here"]);
  });

  test("GraphQL", async () => {
    const res = await gql(
      `query ($f: JSON) { geoSites(filter: $f, limit: 100) { name } }`,
      { f: { location: { _near: { ...POINT, radius: "2km" } } } },
    );
    expect(res.errors).toBeUndefined();
    expect(res.data!.geoSites.map((x: any) => x.name)).toEqual(["here"]);
  });

  test("sorting by distance orders the same way everywhere", async () => {
    const q = `filter=${encodeURIComponent(near("50km"))}&sort=location&limit=100`;
    const rest = (await (await h.fetch(`/api/items/${SLUG}?${q}`)).json()) as any;
    expect(rest.data.map((x: any) => x.name)).toEqual(["here", "across"]);
    const res = await gql(
      `query ($f: JSON) { geoSites(filter: $f, sort: "location", limit: 100) { name } }`,
      { f: { location: { _near: { ...POINT, radius: "50km" } } } },
    );
    expect(res.errors).toBeUndefined();
    expect(res.data!.geoSites.map((x: any) => x.name)).toEqual(["here", "across"]);
  });
});

describe("the repair path reaches every surface", () => {
  /** Imported rows: addresses, no points — the import deliberately skips
   *  geocoding, which is the whole reason backfill exists. */
  const importRows = async () => {
    const r = await h.fetch(`/api/items/${SLUG}/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([
        { name: "i1", address: ADDRESS },
        { name: "i2", address: ADDRESS },
      ]),
    });
    expect(((await r.json()) as any).data.inserted).toBe(2);
  };

  test("REST", async () => {
    await importRows();
    const r = await h.fetch(`/api/geo/backfill/${SLUG}`, json({ field: "location" }));
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).data).toMatchObject({ located: 2, remaining: 0 });
  });

  test("SDK", async () => {
    await importRows();
    const out = await sdk().from(SLUG).backfillGeo("location");
    expect(out).toMatchObject({ located: 2, remaining: 0 });
  });

  test("MCP", async () => {
    await importRows();
    const out = await mcp("geo.backfill", { collection: SLUG, field: "location" });
    expect((out.structuredContent as any).data).toMatchObject({ located: 2, remaining: 0 });
  });

  test("MCP also places a one-off address, and reverses one", async () => {
    const fwd = await mcp("geo.geocode", { address: ADDRESS });
    expect((fwd.structuredContent as any).data).toMatchObject(POINT);
    const back = await mcp("geo.reverse", { lat: POINT.lat, lng: POINT.lng });
    expect((back.structuredContent as any).data.lat).toBe(POINT.lat);
  });

  test("CLI", () => {
    // Structural: the command has to be dispatched AND documented. A
    // subcommand that exists but is missing from the help is one nobody finds.
    const src = readFileSync(
      resolve(import.meta.dir, "../../../packages/cli/src/collections.ts"),
      "utf8",
    );
    expect(src).toContain('sub === "backfill-geo"');
    expect(src).toContain("backfill-geo <slug> <field>");
    expect(src).toContain("/api/geo/backfill/");
  });
});
