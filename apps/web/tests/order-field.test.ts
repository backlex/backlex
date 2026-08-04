import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const json = (body: unknown, method = "POST"): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/**
 * Order fields — the position a hand-arranged list is kept in.
 *
 * The shape under test is the one 28 collections across 13 schema templates
 * carry: a `position` integer, `default: 0`, with `defaultSort: "position"`
 * declared on top of it — so every new row landed on the same number and the
 * "default sort" was whatever the planner returned. Everything asserts through
 * the REST surface, so the append subquery and the two move statements are
 * exercised exactly as a real write emits them.
 */
describe("order fields", () => {
  let h: TestHarness;

  const modules = "ord_modules";
  const lessons = "ord_lessons";
  const stages = "ord_stages";

  const create = async (slug: string, body: unknown) => {
    const r = await h.fetch(`/api/items/${slug}`, json(body));
    return { status: r.status, body: (await r.json()) as any };
  };
  const patch = async (slug: string, id: string, body: unknown) => {
    const r = await h.fetch(`/api/items/${slug}/${id}`, json(body, "PATCH"));
    return { status: r.status, body: (await r.json()) as any };
  };
  const reorder = async (slug: string, body: unknown) => {
    const r = await h.fetch(`/api/items/${slug}/reorder`, json(body));
    return { status: r.status, body: (await r.json()) as any };
  };
  const list = async (slug: string, qs = "") =>
    (await (await h.fetch(`/api/items/${slug}?sort=position&limit=100${qs}`)).json()).data as Record<
      string,
      any
    >[];
  const names = async (slug: string, qs = "") => (await list(slug, qs)).map((r) => r.name);

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    await h.fetch(
      "/api/collections",
      json({ slug: modules, fields: [{ name: "name", type: "text" }] }),
    );
    await h.fetch(
      "/api/collections",
      json({
        slug: lessons,
        fields: [
          { name: "name", type: "text" },
          { name: "module", type: "relation", to: modules },
          { name: "position", type: "integer", order: { scope: "module" } },
        ],
      }),
    );
    // The unscoped variant — one list for the whole collection, which is what a
    // top-level arrangement (pipelines, SLAs, escalation rules) means.
    await h.fetch(
      "/api/collections",
      json({
        slug: stages,
        fields: [
          { name: "name", type: "text" },
          { name: "position", type: "integer", order: {} },
        ],
      }),
    );
  });
  afterAll(() => h.cleanup());

  describe("appending", () => {
    test("consecutive creates land on 1, 2, 3 instead of all on the default", async () => {
      const a = await create(stages, { name: "new" });
      const b = await create(stages, { name: "qualified" });
      const c = await create(stages, { name: "won" });
      expect(a.status).toBe(201);
      // The position is in the CREATE RESPONSE, not only in the column — the
      // caller must not have to re-read to learn where its row went.
      expect(a.body.data.position).toBe(1);
      expect(b.body.data.position).toBe(2);
      expect(c.body.data.position).toBe(3);
    });

    test("a stated position is honoured, not overruled", async () => {
      // A CSV import, a restore and a template's sample rows all carry their own
      // arrangement; appending over it would scramble the data that was in order.
      const r = await create(stages, { name: "stated", position: 99 });
      expect(r.body.data.position).toBe(99);
    });

    test("each scope is numbered independently", async () => {
      const m1 = (await create(modules, { name: "m1" })).body.data.id as string;
      const m2 = (await create(modules, { name: "m2" })).body.data.id as string;
      const first = await create(lessons, { name: "m1-a", module: m1 });
      const second = await create(lessons, { name: "m2-a", module: m2 });
      const third = await create(lessons, { name: "m1-b", module: m1 });
      expect(first.body.data.position).toBe(1);
      // Not 2 — the second module is its own list.
      expect(second.body.data.position).toBe(1);
      expect(third.body.data.position).toBe(2);
    });

    test("rows with no parent are one list, not one list each", async () => {
      // `scope = NULL` is never true in either dialect, so a naive append would
      // find no maximum for every unparented row and hand them all the same 1.
      const a = await create(lessons, { name: "orphan-a" });
      const b = await create(lessons, { name: "orphan-b" });
      expect(a.body.data.position).toBe(1);
      expect(b.body.data.position).toBe(2);
    });

    test('an EMPTY-STRING parent is the same list as a null one', async () => {
      // The version above passed while the feature was broken, because omitting
      // the column writes NULL. The admin's item form clears a relation by
      // sending `""`, which is STORED as `""` — so "no parent" has two
      // spellings and a filter that knows only one looks in an empty partition
      // and hands every row the same 1. Found on the real screen, not here.
      const viaEmpty = await create(lessons, { name: "orphan-empty", module: "" });
      const viaOmitted = await create(lessons, { name: "orphan-null" });
      const both = [viaEmpty.body.data.position, viaOmitted.body.data.position];
      expect(new Set(both).size).toBe(2);
      expect(Math.min(...both)).toBeGreaterThan(2); // after orphan-a / orphan-b
    });
  });

  describe("moving", () => {
    let ids: Record<string, string> = {};

    beforeAll(async () => {
      // A dedicated module so the moves below cannot disturb the other cases.
      const m = (await create(modules, { name: "curriculum" })).body.data.id as string;
      ids = { module: m };
      for (const name of ["intro", "setup", "basics", "advanced"]) {
        ids[name] = (await create(lessons, { name, module: m })).body.data.id as string;
      }
    });

    const order = async () =>
      (await names(lessons, `&filter=${encodeURIComponent(JSON.stringify({ module: { _eq: ids.module } }))}`));

    test("the list starts in creation order", async () => {
      expect(await order()).toEqual(["intro", "setup", "basics", "advanced"]);
    });

    test("moving a row later puts it after its anchor", async () => {
      const r = await reorder(lessons, { field: "position", id: ids.setup, after: ids.advanced });
      expect(r.status).toBe(200);
      expect(await order()).toEqual(["intro", "basics", "advanced", "setup"]);
    });

    test("moving a row earlier puts it before its anchor", async () => {
      const r = await reorder(lessons, { field: "position", id: ids.setup, before: ids.intro });
      expect(r.status).toBe(200);
      expect(await order()).toEqual(["setup", "intro", "basics", "advanced"]);
    });

    test("a move that changes nothing writes nothing", async () => {
      const r = await reorder(lessons, { field: "position", id: ids.intro, after: ids.setup });
      expect(r.status).toBe(200);
      expect(r.body.data.shifted).toBe(0);
      expect(await order()).toEqual(["setup", "intro", "basics", "advanced"]);
    });

    test("a row cannot be moved relative to itself", async () => {
      const r = await reorder(lessons, { field: "position", id: ids.intro, after: ids.intro });
      expect(r.status).toBe(422);
    });

    test("a move needs exactly one anchor", async () => {
      const both = await reorder(lessons, {
        field: "position",
        id: ids.intro,
        after: ids.setup,
        before: ids.basics,
      });
      expect(both.status).toBe(422);
      const neither = await reorder(lessons, { field: "position", id: ids.intro });
      expect(neither.status).toBe(422);
    });

    test("a move across lists is refused rather than silently half-applied", async () => {
      const other = (await create(modules, { name: "elsewhere" })).body.data.id as string;
      const stray = (await create(lessons, { name: "stray", module: other })).body.data.id as string;
      const r = await reorder(lessons, { field: "position", id: ids.intro, after: stray });
      expect(r.status).toBe(422);
      expect(String(r.body.error?.message ?? r.body.message)).toContain("module");
    });

    test("a field that is not an order field is refused", async () => {
      const r = await reorder(lessons, { field: "name", id: ids.intro, after: ids.setup });
      expect(r.status).toBe(422);
    });
  });

  describe("re-parenting", () => {
    test("a row moved to another list appends to the end of it", async () => {
      const from = (await create(modules, { name: "from" })).body.data.id as string;
      const to = (await create(modules, { name: "to" })).body.data.id as string;
      const a = (await create(lessons, { name: "keep-1", module: to })).body.data.id as string;
      void a;
      await create(lessons, { name: "keep-2", module: to });
      const moved = (await create(lessons, { name: "moved", module: from })).body.data.id as string;
      // In its old list it was 1; in the new one that position is taken, and a
      // tie is the one state a subsequent move cannot survive.
      const r = await patch(lessons, moved, { module: to });
      expect(r.status).toBe(200);
      expect(r.body.data.position).toBe(3);
    });

    test("a patch that states the position keeps it", async () => {
      const to = (await create(modules, { name: "explicit" })).body.data.id as string;
      const row = (await create(lessons, { name: "explicit-move" })).body.data.id as string;
      const r = await patch(lessons, row, { module: to, position: 7 });
      expect(r.body.data.position).toBe(7);
    });
  });

  describe("normalizing", () => {
    test("a column of ties is renumbered into the order it read in", async () => {
      const m = (await create(modules, { name: "legacy" })).body.data.id as string;
      // Exactly the state every existing workspace is in: `default: 0`, so the
      // rows are tied and the "default sort" is whatever came back.
      for (const name of ["a", "b", "c"]) {
        await create(lessons, { name, module: m, position: 0 });
      }
      const r = await h.fetch(
        `/api/items/${lessons}/order/normalize`,
        json({ field: "position" }),
      );
      expect(r.status).toBe(200);
      const body = (await r.json()) as any;
      expect(body.data.renumbered).toBeGreaterThanOrEqual(3);
      const rows = await list(
        lessons,
        `&filter=${encodeURIComponent(JSON.stringify({ module: { _eq: m } }))}`,
      );
      expect(rows.map((x) => x.position)).toEqual([1, 2, 3]);
    });

    test("a wholly tied list is renumbered into INSERTION order, not id order", async () => {
      // This is the case the repair exists for, and the tiebreak is the entire
      // answer on it: every position is the same 0, so the position clause
      // orders nothing. Breaking the tie on the primary key would sort a
      // curriculum by the random UUIDs of its lessons — stable, and unrelated to
      // the order anyone put them in. Five rows, so id order coinciding with
      // creation order by luck is a 1-in-120 event rather than a coin flip.
      const m = (await create(modules, { name: "insertion" })).body.data.id as string;
      const expected = ["first", "second", "third", "fourth", "fifth"];
      for (const name of expected) {
        await create(lessons, { name, module: m, position: 0 });
        // `created_at` is millisecond-resolution, so five rows written in one
        // tight loop genuinely share a timestamp and fall through to the pk.
        // A person arranging a list does not create five rows in one
        // millisecond; a bulk import does, and one that had an order to keep
        // states its positions. Spaced here so the assertion is about the
        // tiebreak that exists rather than one that cannot.
        await Bun.sleep(2);
      }
      await h.fetch(`/api/items/${lessons}/order/normalize`, json({ field: "position" }));
      const rows = await list(
        lessons,
        `&filter=${encodeURIComponent(JSON.stringify({ module: { _eq: m } }))}`,
      );
      expect(rows.map((x) => x.name)).toEqual(expected);
      expect(rows.map((x) => x.position)).toEqual([1, 2, 3, 4, 5]);
    });

    test("a move repairs its own list first, so a tied column is still draggable", async () => {
      const m = (await create(modules, { name: "tied" })).body.data.id as string;
      const ids: Record<string, string> = {};
      for (const name of ["x", "y", "z"]) {
        ids[name] = (await create(lessons, { name, module: m, position: 0 })).body.data.id as string;
      }
      // Without the repair the shift matches nothing (every row holds 0) and the
      // row would land at the end instead of where it was dropped.
      const r = await reorder(lessons, { field: "position", id: ids.z, before: ids.x });
      expect(r.status).toBe(200);
      expect(r.body.data.repaired).toBeGreaterThan(0);
      const rows = await list(
        lessons,
        `&filter=${encodeURIComponent(JSON.stringify({ module: { _eq: m } }))}`,
      );
      expect(rows.map((x) => x.name)).toEqual(["z", "x", "y"]);
    });
  });

  describe("schema validation", () => {
    const badField = async (field: unknown) => {
      const r = await h.fetch(
        "/api/collections",
        json({ slug: `ord_bad_${crypto.randomUUID().slice(0, 8)}`, fields: [field] }),
      );
      return r.status;
    };

    test("an order field must be an integer", async () => {
      expect(await badField({ name: "position", type: "text", order: {} })).toBe(422);
    });

    test("a scope must name a real field", async () => {
      expect(await badField({ name: "position", type: "integer", order: { scope: "nope" } })).toBe(
        422,
      );
    });

    test("a column-level unique would stop two lists both having a first row", async () => {
      expect(
        await badField({ name: "position", type: "integer", unique: true, order: {} }),
      ).toBe(422);
    });
  });
});
