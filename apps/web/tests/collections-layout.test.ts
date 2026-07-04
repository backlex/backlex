/**
 * Collections grouping + manual ordering (`POST /api/collections/layout`).
 *
 * The Edit-layout mode saves the whole arrangement in one request: every
 * collection's `{group, sortOrder}` plus the ordered group-header list (an
 * `app_settings` row surfaced back as `meta.groups` on the list GET). Covers
 * the write path, validation, the auth gate, unknown-slug tolerance, the
 * same-isolate cache invalidation, and the ETag digest — including the
 * header-only reorder that changes no collection row.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type TestHarness, makeHarness, seedAdmin } from "./setup";

const JSON_HEADERS = { "Content-Type": "application/json" };

describe("collections layout (grouping + manual order)", () => {
  let h: TestHarness;
  const ts = Date.now();
  const slugs = [`laycol_a_${ts}`, `laycol_b_${ts}`, `laycol_c_${ts}`];

  const getList = async () => {
    const res = await h.fetch("/api/collections");
    expect(res.status).toBe(200);
    return (await res.json()) as {
      data: { slug: string; group: string | null; sortOrder: number | null }[];
      meta?: { groups: string[] };
    };
  };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    for (const slug of slugs) {
      const r = await h.fetch("/api/collections", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ slug, fields: [{ name: "title", type: "text" }] }),
      });
      expect(r.status).toBe(201);
    }
  });
  afterAll(() => h.cleanup());

  test("new collections default to ungrouped/unordered", async () => {
    const body = await getList();
    for (const slug of slugs) {
      const row = body.data.find((c) => c.slug === slug);
      expect(row).toBeDefined();
      expect(row!.group ?? null).toBeNull();
      expect(row!.sortOrder ?? null).toBeNull();
    }
    expect(body.meta?.groups ?? []).toEqual([]);
  });

  test("POST /layout writes rows + group order; GET reflects it immediately", async () => {
    const res = await h.fetch("/api/collections/layout", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        groups: ["CMS", "Ops"],
        items: [
          { slug: slugs[0], group: "CMS", sortOrder: 0 },
          { slug: slugs[1], group: "CMS", sortOrder: 1 },
          { slug: slugs[2], group: "Ops", sortOrder: 0 },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; changed: number };
    expect(body.ok).toBe(true);
    expect(body.changed).toBe(3);

    // Same-isolate read-your-writes: the per-isolate list + group-order
    // caches must have been invalidated by the layout write.
    const list = await getList();
    expect(list.meta?.groups).toEqual(["CMS", "Ops"]);
    const a = list.data.find((c) => c.slug === slugs[0])!;
    const c2 = list.data.find((c) => c.slug === slugs[2])!;
    expect(a.group).toBe("CMS");
    expect(a.sortOrder).toBe(0);
    expect(c2.group).toBe("Ops");
    expect(c2.sortOrder).toBe(0);
  });

  test("unchanged rows are skipped (changed count), unknown slugs tolerated", async () => {
    const res = await h.fetch("/api/collections/layout", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        groups: ["CMS", "Ops"],
        items: [
          { slug: slugs[0], group: "CMS", sortOrder: 0 }, // unchanged
          { slug: `ghost_${ts}`, group: "Ops", sortOrder: 5 }, // unknown → skipped
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; changed: number };
    expect(body.changed).toBe(0);
  });

  test("validation: bad shapes → 422", async () => {
    const cases = [
      { groups: ["CMS"] }, // missing items
      { groups: ["CMS"], items: [{ slug: slugs[0], group: "CMS", sortOrder: 1.5 }] },
      { groups: ["x".repeat(61)], items: [] },
      { groups: [""], items: [] },
    ];
    for (const payload of cases) {
      const res = await h.fetch("/api/collections/layout", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(payload),
      });
      expect(res.status).toBe(422);
    }
  });

  test("anonymous POST /layout → 401 (DDL gate)", async () => {
    const anon = makeHarness();
    try {
      const res = await anon.fetch("/api/collections/layout", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ groups: [], items: [] }),
      });
      expect(res.status).toBe(401);
    } finally {
      anon.cleanup();
    }
  });

  test("row change busts the list ETag", async () => {
    const etag = (await h.fetch("/api/collections")).headers.get("etag")!;
    const res = await h.fetch("/api/collections/layout", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        groups: ["CMS", "Ops"],
        items: [{ slug: slugs[1], group: "Ops", sortOrder: 1 }],
      }),
    });
    expect(res.status).toBe(200);
    const revalidated = await h.fetch("/api/collections", {
      headers: { "If-None-Match": etag },
    });
    expect(revalidated.status).toBe(200); // digest changed → no 304
  });

  test("header-only reorder (no row change) also busts the list ETag", async () => {
    const etag = (await h.fetch("/api/collections")).headers.get("etag")!;
    // Reorder just the group headers; every row keeps its current placement,
    // so no collections row's updatedAt moves — the digest must still change.
    const res = await h.fetch("/api/collections/layout", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ groups: ["Ops", "CMS"], items: [] }),
    });
    expect(res.status).toBe(200);
    const revalidated = await h.fetch("/api/collections", {
      headers: { "If-None-Match": etag },
    });
    expect(revalidated.status).toBe(200);
    const list = await getList();
    expect(list.meta?.groups).toEqual(["Ops", "CMS"]);
  });

  test("create accepts group; PATCH can set and clear it", async () => {
    const slug = `laycol_d_${ts}`;
    const create = await h.fetch("/api/collections", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        slug,
        group: "CMS",
        sortOrder: 7,
        fields: [{ name: "title", type: "text" }],
      }),
    });
    expect(create.status).toBe(201);
    let row = (await getList()).data.find((c) => c.slug === slug)!;
    expect(row.group).toBe("CMS");
    expect(row.sortOrder).toBe(7);

    const clear = await h.fetch(`/api/collections/${slug}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ group: null, sortOrder: null }),
    });
    expect(clear.status).toBe(200);
    row = (await getList()).data.find((c) => c.slug === slug)!;
    expect(row.group ?? null).toBeNull();
    expect(row.sortOrder ?? null).toBeNull();
  });
});
