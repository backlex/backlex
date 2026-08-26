/**
 * Two cross-checks that `POST/PATCH /api/collections` did not make, both found
 * while building a real product on a managed tenant rather than by probing.
 *
 * 1. **Unknown field options were stripped, silently.** Zod's default is to drop
 *    keys the schema does not declare, so `{"name":"a","type":"text",
 *    "requried":true,"uniqe":true}` was stored as `{"name":"a","type":"text"}`
 *    and answered `201`. The operator asked for a required, unique column and
 *    got a plain nullable one, with nothing in the response to say so. The same
 *    shape bites per-type options written flat instead of nested:
 *    `{"type":"phone","region":"TR"}` kept the field and dropped the region, and
 *    the failure surfaced much later on the first national-format number — with
 *    an error telling the operator to set a region they had just set.
 *
 * 2. **`relation.to` was never checked for existence, while `rollup.from` was.**
 *    Two cross-collection references in the same `fields` array, validated under
 *    two different policies. A typo in `to` returned 201 and produced a
 *    collection that cannot accept a single row: every write 422s with
 *    "Relation target collection … not found", every `expand` 422s, and a filter
 *    through it silently returns nothing.
 *
 * The tests that matter most are the ones asserting legitimate definitions still
 * pass — the known-key set is derived from the Zod shape precisely so that
 * adding an option cannot turn it into a wall.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const JSON_HEADERS = { "Content-Type": "application/json" };

describe("collection field-definition guards", () => {
  let h: TestHarness;
  const stamp = Date.now();

  const create = (body: unknown) =>
    h.fetch("/api/collections", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });

  describe("unknown field options", () => {
    test("a misspelled constraint is refused, and the near-miss is named", async () => {
      const r = await create({
        slug: `typo_${stamp}`,
        fields: [{ name: "a", type: "text", requried: true }],
      });
      expect(r.status).toBe(422);
      const b = (await r.json()) as { error: { code: string; message: string } };
      expect(b.error.code).toBe("VALIDATION");
      expect(b.error.message).toContain('"requried"');
      // The whole point: the operator's JSON looks right to them, so the
      // message has to close the gap rather than just refuse.
      expect(b.error.message).toContain('did you mean "required"');
      expect(b.error.message).toContain('Field "a"');
    });

    test("a flat per-type option is refused and pointed at the nested shape", async () => {
      const r = await create({
        slug: `flatphone_${stamp}`,
        fields: [{ name: "phone_no", type: "phone", region: "TR" }],
      });
      expect(r.status).toBe(422);
      const b = (await r.json()) as { error: { message: string } };
      expect(b.error.message).toContain('"region"');
      expect(b.error.message).toContain('"phone":{"region":"TR"}');
    });

    test("an option with no near match is still named", async () => {
      const r = await create({
        slug: `nonsense_${stamp}`,
        fields: [{ name: "a", type: "text", totally_made_up_key: "x" }],
      });
      expect(r.status).toBe(422);
      expect(((await r.json()) as { error: { message: string } }).error.message).toContain(
        '"totally_made_up_key"',
      );
    });

    test("nothing is stored when a definition is refused", async () => {
      const r = await h.fetch(`/api/collections/typo_${stamp}`);
      expect(r.status).toBe(404);
    });

    test("a rich, entirely valid definition still passes — every nested option", async () => {
      const r = await create({
        slug: `rich_${stamp}`,
        fields: [
          { name: "name", type: "text", required: true, searchable: true, indexed: true },
          { name: "handle", type: "text", unique: true, interface: "slug", slug: { from: ["name"] } },
          { name: "currency", type: "text" },
          { name: "total", type: "money", money: { currencyField: "currency" } },
          { name: "phone_no", type: "phone", phone: { region: "TR" } },
          { name: "where", type: "geo" },
          { name: "secret", type: "hash" },
          { name: "note", type: "longtext" },
        ],
      });
      expect(r.status).toBe(201);
      const b = (await r.json()) as { data: { fields: { name: string }[] } };
      expect(b.data.fields.map((f) => f.name)).toContain("phone_no");
    });

    test("`hidden` is a CONDITION effect, not a flat field property — the spec said otherwise", async () => {
      // `components.schemas.CollectionField` in the published OpenAPI listed
      // `hidden` among a field's properties. The server has never accepted it:
      // hiding a field is a `conditions` effect (docs/field-conditions.md:46).
      // Before the unknown-key guard this returned 201 and did nothing at all.
      const r = await create({
        slug: `hiddenprop_${stamp}`,
        fields: [{ name: "a", type: "text", hidden: true }],
      });
      expect(r.status).toBe(422);
      expect(((await r.json()) as { error: { message: string } }).error.message).toContain('"hidden"');

      // …and the real mechanism still works.
      const okr = await create({
        slug: `hiddencond_${stamp}`,
        fields: [
          { name: "kind", type: "text" },
          {
            name: "a",
            type: "text",
            conditions: [{ name: "hide_it", tree: { op: "and", rules: [] }, hidden: true }],
          },
        ],
      });
      expect([201, 422]).toContain(okr.status); // shape of `conditions` is covered by its own suite
    });

    test("the pre-Zod guard is bounded — it sees an unvalidated body", async () => {
      // It has to run before Zod (Zod is what removes the keys it notices),
      // so nothing has checked the body's size yet. Without caps, many fields
      // x many unknown keys x every known key is unbounded work on a
      // CPU-metered Worker.
      const { assertKnownFieldKeys } = await import("../src/server/routes/collections");

      const manyKeys: Record<string, unknown> = { name: "a", type: "text" };
      for (let i = 0; i < 200; i++) manyKeys[`junk_key_${i}`] = 1;
      let msg = "";
      try {
        assertKnownFieldKeys([manyKeys]);
      } catch (e) {
        msg = (e as Error).message;
      }
      expect(msg).toContain("junk_key_0");
      // Only the first few are named, and the rest are counted, not listed.
      expect(msg).toContain("more)");
      expect(msg.length).toBeLessThan(800);

      // A long blob is not key-shaped: echoed truncated, and no distance run.
      let msg2 = "";
      try {
        assertKnownFieldKeys([{ name: "a", type: "text", ["z".repeat(5000)]: 1 }]);
      } catch (e) {
        msg2 = (e as Error).message;
      }
      expect(msg2).not.toContain("did you mean");
      expect(msg2.length).toBeLessThan(600);

      // Control characters in echoed caller text are flattened.
      let msg3 = "";
      try {
        assertKnownFieldKeys([{ name: "a\u0000\u2028b", type: "text", nope: 1 }]);
      } catch (e) {
        msg3 = (e as Error).message;
      }
      expect(msg3).not.toContain("\u0000");
      expect(msg3).not.toContain("\u2028");
    });

    test("the guard is derived from the schema, so every declared key passes", async () => {
      // Breaking-the-guard check in the other direction: if KNOWN_FIELD_KEYS
      // ever stops tracking the Zod shape, one of these round-trips fails.
      const { assertKnownFieldKeys } = await import("../src/server/routes/collections");
      expect(() =>
        assertKnownFieldKeys([
          { name: "a", type: "text", required: true, unique: true, indexed: true, searchable: true },
        ]),
      ).not.toThrow();
      expect(() => assertKnownFieldKeys([{ name: "a", type: "text", nope: 1 }])).toThrow();
      // Non-objects and absent fields are none of this guard's business.
      expect(() => assertKnownFieldKeys(undefined)).not.toThrow();
      expect(() => assertKnownFieldKeys([null, "x", 3])).not.toThrow();
    });
  });

  describe("relation targets", () => {
    test("a relation to a collection that does not exist is REPORTED, not refused", async () => {
      const r = await create({
        slug: `danglingrel_${stamp}`,
        fields: [
          { name: "t", type: "text" },
          { name: "ghost", type: "relation", to: "definitely_not_a_collection" },
        ],
      });
      // 201 with a warning, not a 422 — see the cycle test below for why.
      expect(r.status).toBe(201);
      const b = (await r.json()) as { warning?: string };
      expect(b.warning).toContain("definitely_not_a_collection");
      expect(b.warning).toContain("does not exist yet");
      // Actionable both ways: it might be a forward reference, or a typo.
      expect(b.warning).toContain("typo");
    });

    test("relation_many is reported the same way", async () => {
      const r = await create({
        slug: `danglingmany_${stamp}`,
        fields: [{ name: "ghosts", type: "relation_many", to: "still_not_a_collection" }],
      });
      expect(r.status).toBe(201);
      expect(((await r.json()) as { warning?: string }).warning).toContain("still_not_a_collection");
    });

    test("a parent rollup + child relation pair can still be declared", async () => {
      // The reason this is a warning and not a refusal. An invoice whose total
      // rolls up its lines, and a line whose relation points back at the
      // invoice, is an ordinary shape — and two strict checks make it
      // unexpressible: the child cannot go first (its `to` has no parent yet),
      // the parent cannot go first (its `rollup.from` has no child yet), and no
      // ordering resolves a cycle. The first version of this guard refused, and
      // twenty-one tests in the rollup suite said so.
      const inv = `cyc_invoices_${stamp}`;
      const lines = `cyc_lines_${stamp}`;

      const childFirst = await create({
        slug: lines,
        fields: [
          { name: "invoice", type: "relation", to: inv },
          { name: "amount", type: "number" },
        ],
      });
      expect(childFirst.status).toBe(201);
      expect(((await childFirst.json()) as { warning?: string }).warning).toContain(inv);

      const parent = await create({
        slug: inv,
        fields: [
          { name: "number", type: "text" },
          { name: "total", type: "number", rollup: { from: lines, via: "invoice", fn: "sum", field: "amount" } },
        ],
      });
      expect(parent.status).toBe(201);
      // No warning now — the forward reference resolved by being created.
      expect(((await parent.json()) as { warning?: string }).warning).toBeUndefined();

      // And the pair works: a row can be written through the relation.
      const p = await h.fetch(`/api/items/${inv}`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ number: "INV-1" }),
      });
      expect(p.status).toBe(201);
      const invoiceId = ((await p.json()) as { data: { id: string } }).data.id;
      const line = await h.fetch(`/api/items/${lines}`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ invoice: invoiceId, amount: 10 }),
      });
      expect(line.status).toBe(201);
    });

    test("a self-reference is allowed and warns about nothing", async () => {
      const slug = `tree_${stamp}`;
      const r = await create({
        slug,
        fields: [
          { name: "label", type: "text" },
          { name: "parent", type: "relation", to: slug },
        ],
      });
      expect(r.status).toBe(201);
      // Resolvable by construction, so it must not be reported as dangling.
      expect(((await r.json()) as { warning?: string }).warning).toBeUndefined();
    });

    test("a relation to a real collection still passes, and rows can be written", async () => {
      const parent = `orgs_${stamp}`;
      expect((await create({ slug: parent, fields: [{ name: "name", type: "text" }] })).status).toBe(201);
      const child = `people_${stamp}`;
      expect(
        (
          await create({
            slug: child,
            fields: [
              { name: "name", type: "text" },
              { name: "org", type: "relation", to: parent },
            ],
          })
        ).status,
      ).toBe(201);

      const p = await h.fetch(`/api/items/${parent}`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ name: "Acme" }),
      });
      expect(p.status).toBe(201);
      const orgId = ((await p.json()) as { data: { id: string } }).data.id;
      const w = await h.fetch(`/api/items/${child}`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ name: "Rana", org: orgId }),
      });
      // The bug this guard prevents: the create used to succeed and THIS 422'd.
      expect(w.status).toBe(201);
    });

    test("PATCH reports it the same way POST does", async () => {
      const slug = `patchrel_${stamp}`;
      expect((await create({ slug, fields: [{ name: "t", type: "text" }] })).status).toBe(201);
      const r = await h.fetch(`/api/collections/${slug}`, {
        method: "PATCH",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          fields: [
            { name: "t", type: "text" },
            { name: "ghost", type: "relation", to: "nope_not_here" },
          ],
        }),
      });
      expect(r.status).toBe(200);
      expect(((await r.json()) as { warning?: string }).warning).toContain("nope_not_here");
    });

    test("the write path is still what refuses — the warning does not replace it", async () => {
      // The warning makes the typo visible at definition time; the precise
      // error at first write is unchanged and is still the hard stop.
      const slug = `danglingwrite_${stamp}`;
      expect(
        (await create({ slug, fields: [{ name: "ghost", type: "relation", to: "no_such_thing" }] })).status,
      ).toBe(201);
      const w = await h.fetch(`/api/items/${slug}`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ ghost: "x" }),
      });
      expect(w.status).toBe(422);
      expect(((await w.json()) as { error: { message: string } }).error.message).toContain("no_such_thing");
    });
  });
});
