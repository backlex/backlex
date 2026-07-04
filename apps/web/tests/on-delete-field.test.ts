import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

// Coverage for app-layer ON DELETE triggers: deleting a referenced row nulls
// out `set_null` FKs and deletes `cascade` rows in referencing collections.
describe("ON DELETE relational triggers", () => {
  let h: TestHarness;

  const create = async (slug: string, body: unknown) => {
    const r = await h.fetch(`/api/items/${slug}`, json(body));
    return { status: r.status, body: (await r.json()) as any };
  };
  const get = async (slug: string, id: string) => {
    const r = await h.fetch(`/api/items/${slug}/${id}`);
    return { status: r.status, body: (await r.json()) as any };
  };
  const del = async (slug: string, id: string) =>
    (await h.fetch(`/api/items/${slug}/${id}`, { method: "DELETE" })).status;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    await h.fetch("/api/collections", json({ slug: "makers", fields: [{ name: "name", type: "text" }] }));
    await h.fetch(
      "/api/collections",
      json({
        slug: "widgets",
        fields: [
          { name: "label", type: "text" },
          { name: "maker_id", type: "relation", to: "makers", onDelete: "set_null" },
        ],
      }),
    );
    await h.fetch(
      "/api/collections",
      json({
        slug: "parts",
        fields: [
          { name: "label", type: "text" },
          { name: "maker_id", type: "relation", to: "makers", onDelete: "cascade" },
        ],
      }),
    );
  });
  afterAll(() => h.cleanup());

  test("set_null detaches the FK; cascade deletes the row", async () => {
    const maker = (await create("makers", { name: "Acme" })).body.data;
    const widget = (await create("widgets", { label: "w", maker_id: maker.id })).body.data;
    const part = (await create("parts", { label: "p", maker_id: maker.id })).body.data;

    expect(await del("makers", maker.id)).toBe(200);

    // set_null → the widget survives with a NULL maker_id
    const w = await get("widgets", widget.id);
    expect(w.status).toBe(200);
    expect(w.body.data.maker_id ?? null).toBeNull();

    // cascade → the part is gone
    const p = await get("parts", part.id);
    expect(p.status).toBe(404);
  });

  test("only rows pointing at the deleted item are affected", async () => {
    const keep = (await create("makers", { name: "Keep" })).body.data;
    const other = (await create("makers", { name: "Other" })).body.data;
    const wKeep = (await create("widgets", { label: "k", maker_id: keep.id })).body.data;
    const pOther = (await create("parts", { label: "o", maker_id: other.id })).body.data;

    expect(await del("makers", keep.id)).toBe(200);

    // The widget pointing at `keep` is nulled…
    expect((await get("widgets", wKeep.id)).body.data.maker_id ?? null).toBeNull();
    // …but a part pointing at a DIFFERENT maker is untouched.
    const p = await get("parts", pOther.id);
    expect(p.status).toBe(200);
    expect(p.body.data.maker_id).toBe(other.id);
  });

  test("no_action leaves referencing rows alone", async () => {
    await h.fetch(
      "/api/collections",
      json({
        slug: "tags_ref",
        fields: [{ name: "maker_id", type: "relation", to: "makers", onDelete: "no_action" }],
      }),
    );
    const m = (await create("makers", { name: "NA" })).body.data;
    const t = (await create("tags_ref", { maker_id: m.id })).body.data;
    expect(await del("makers", m.id)).toBe(200);
    const row = await get("tags_ref", t.id);
    expect(row.status).toBe(200);
    expect(row.body.data.maker_id).toBe(m.id); // dangling but untouched
  });
});

// relation_many + cascade chaining (v2 edges).
describe("ON DELETE: relation_many + chaining", () => {
  let h: TestHarness;
  const json = (body: unknown): RequestInit => ({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const create = async (slug: string, body: unknown) => {
    const r = await h.fetch(`/api/items/${slug}`, json(body));
    return { status: r.status, body: (await r.json()) as any };
  };
  const get = async (slug: string, id: string) =>
    (await h.fetch(`/api/items/${slug}/${id}`)).status;
  const getBody = async (slug: string, id: string) =>
    (await (await h.fetch(`/api/items/${slug}/${id}`)).json()).data as any;
  const del = async (slug: string, id: string) =>
    (await h.fetch(`/api/items/${slug}/${id}`, { method: "DELETE" })).status;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    await h.fetch("/api/collections", json({ slug: "tags", fields: [{ name: "name", type: "text" }] }));
    // posts.tag_ids (M2M) → tags, remove-from-list on delete
    await h.fetch("/api/collections", json({
      slug: "posts2",
      fields: [
        { name: "title", type: "text" },
        { name: "tag_ids", type: "relation_many", to: "tags", onDelete: "set_null" },
      ],
    }));
    // baskets.tag_ids (M2M) → tags, cascade
    await h.fetch("/api/collections", json({
      slug: "baskets",
      fields: [{ name: "tag_ids", type: "relation_many", to: "tags", onDelete: "cascade" }],
    }));
    // chain: a → b → c (single relations, cascade)
    await h.fetch("/api/collections", json({ slug: "a_root", fields: [{ name: "name", type: "text" }] }));
    await h.fetch("/api/collections", json({ slug: "b_mid", fields: [{ name: "a_id", type: "relation", to: "a_root", onDelete: "cascade" }] }));
    await h.fetch("/api/collections", json({ slug: "c_leaf", fields: [{ name: "b_id", type: "relation", to: "b_mid", onDelete: "cascade" }] }));
  });
  afterAll(() => h.cleanup());

  test("relation_many set_null removes the deleted id from the array", async () => {
    const t1 = (await create("tags", { name: "t1" })).body.data;
    const t2 = (await create("tags", { name: "t2" })).body.data;
    const p = (await create("posts2", { title: "p", tag_ids: [t1.id, t2.id] })).body.data;

    expect(await del("tags", t1.id)).toBe(200);
    const row = await getBody("posts2", p.id);
    expect(row.tag_ids).toEqual([t2.id]);
  });

  test("relation_many cascade deletes rows referencing the id", async () => {
    const t = (await create("tags", { name: "tc" })).body.data;
    const b = (await create("baskets", { tag_ids: [t.id] })).body.data;
    expect(await del("tags", t.id)).toBe(200);
    expect(await get("baskets", b.id)).toBe(404);
  });

  test("cascade chains through multiple levels", async () => {
    const a = (await create("a_root", { name: "a" })).body.data;
    const b = (await create("b_mid", { a_id: a.id })).body.data;
    const c = (await create("c_leaf", { b_id: b.id })).body.data;

    expect(await del("a_root", a.id)).toBe(200);
    expect(await get("b_mid", b.id)).toBe(404); // cascaded
    expect(await get("c_leaf", c.id)).toBe(404); // chained
  });
});
