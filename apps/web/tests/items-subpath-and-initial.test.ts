/**
 * Two small refusals that used to send the caller looking in the wrong place.
 *
 * 1. `transitions.initial` was the ONE value slot in the spec that refused a
 *    bare string. `from` and `to` both take `"draft"` or `["draft"]`; `initial`
 *    took only the list, and the difference read as an arbitrary rule rather
 *    than a design. Seven collections in a row were refused for it.
 *
 * 2. `/api/items/{slug}/{id}` matches any second segment, so `GET .../search`
 *    was routed to the by-id handler, found no row called "search", and
 *    answered `404 Item not found` — a sentence about a missing ROW when the
 *    path exists and only wants a different verb.
 *
 * The second one has a security shape and the test says so: an id that is NOT
 * one of these names must keep the identical, uninformative message, or the
 * endpoint becomes an oracle for which rows exist.
 */
import { beforeAll, afterAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import { POST_ONLY_SUBPATHS, itemNotFoundMessage } from "../src/server/routes/items/shared";

const json = { "content-type": "application/json" };

const err = async (res: Response): Promise<string> =>
  ((await res.json()) as { error: { message: string } }).error.message;

describe("transitions.initial accepts a bare value, like from and to", () => {
  let h: TestHarness;
  const slug = `tr_init_${Date.now()}`;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  const field = (initial: unknown) => ({
    name: "state",
    type: "text",
    interface: "dropdown",
    options: { choices: [{ value: "new" }, { value: "done" }] },
    transitions: { initial, allow: [{ from: "new", to: "done" }] },
  });

  test("a string is stored as a one-element list", async () => {
    const res = await h.fetch("/api/collections", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ slug, fields: [field("new")] }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      data: { fields: Array<{ transitions?: { initial?: string[] } }> };
    };
    expect(body.data.fields[0]?.transitions?.initial).toEqual(["new"]);
  });

  test("the list form is unchanged", async () => {
    const res = await h.fetch("/api/collections", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ slug: `${slug}_arr`, fields: [field(["new", "done"])] }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      data: { fields: Array<{ transitions?: { initial?: string[] } }> };
    };
    expect(body.data.fields[0]?.transitions?.initial).toEqual(["new", "done"]);
  });

  // Normalizing must not soften the rule — that would trade a confusing 422
  // for a lifecycle nothing enforces, which is much worse.
  test("the normalized value is still enforced on write", async () => {
    const bad = await h.fetch(`/api/items/${slug}`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ state: "done" }),
    });
    expect(bad.status).toBe(422);
    expect(await err(bad)).toContain("is not a starting value");

    const ok = await h.fetch(`/api/items/${slug}`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ state: "new" }),
    });
    expect(ok.status).toBe(201);
  });

  test("a value that is not one of the choices is still refused", async () => {
    const res = await h.fetch("/api/collections", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ slug: `${slug}_bogus`, fields: [field("banana")] }),
    });
    expect(res.status).toBe(422);
  });
});

describe("a GET of a POST-only sub-path says which verb it wants", () => {
  let h: TestHarness;
  const slug = `sub_${Date.now()}`;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const res = await h.fetch("/api/collections", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ slug, fields: [{ name: "title", type: "text" }] }),
    });
    expect(res.status).toBe(201);
  });
  afterAll(() => h.cleanup());

  test.each(Object.keys(POST_ONLY_SUBPATHS))("GET /%s names the endpoint", async (sub) => {
    const res = await h.fetch(`/api/items/${slug}/${sub}`);
    expect(res.status).toBe(404);
    const m = await err(res);
    expect(m).toContain(`"${sub}" is not an item id`);
    expect(m).toContain("POST");
    expect(m).not.toBe("Item not found");
  });

  /**
   * The half that matters for more than ergonomics. Every id that is not one of
   * those names — missing, malformed, or a real row the caller may not read —
   * has to answer with the SAME words, or the message becomes an existence
   * oracle.
   */
  // `export` and `changes` are absent on purpose: they are real GET endpoints
  // and answer 200, which is why they must never appear in the map either.
  test.each([
    "00000000-0000-0000-0000-000000000000",
    "not-a-uuid",
    "Search",
    "searchx",
    "aggregate2",
    "bulk_update",
    // Prototype-chain keys: a bare `MAP[id]` finds these on Object.prototype
    // and answers with a native function's source. They are ids like any other.
    "constructor",
    "toString",
    "valueOf",
    "hasOwnProperty",
    "__proto__",
  ])("a miss on %p still says only 'Item not found'", async (id) => {
    const res = await h.fetch(`/api/items/${slug}/${id}`);
    expect(res.status).toBe(404);
    expect(await err(res)).toBe("Item not found");
  });

  test("the map only names paths that really are POST-only", () => {
    // `export` and `changes` answer GET, so listing them here would tell a
    // caller to send a POST that 405s.
    expect(POST_ONLY_SUBPATHS.export).toBeUndefined();
    expect(POST_ONLY_SUBPATHS.changes).toBeUndefined();
    for (const [name, what] of Object.entries(POST_ONLY_SUBPATHS)) {
      expect(what.length).toBeGreaterThan(8);
      expect(itemNotFoundMessage(name)).toContain(what);
    }
  });
});
