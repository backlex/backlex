/**
 * A `validation.rule` that looks ONE relation hop out — the cross-ROW invariant.
 *
 * `$field.<name>` has always been row-local, which made the rule every stocked
 * warehouse actually needs unexpressible: *a bin's zone must belong to the bin's
 * own warehouse*. Written as `{ warehouse: { _eq: "$field.zone.warehouse" } }`
 * it saved cleanly and then matched NOTHING — the row matcher resolved the hop
 * to `undefined`, and `_eq` against `undefined` is false for every real value,
 * so the collection refused every write to that column. Fail-closed, silent, and
 * indistinguishable from "the API is broken".
 *
 * The write path now fetches the hop's value and puts it on the row before the
 * rule is judged, so the shape above means what it reads as. The rest of this
 * file is the fence around that: everything one fetch cannot answer is refused
 * when the SCHEMA is saved, where an admin can see it, rather than at write time
 * where it looks like an outage.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const JSON_HEADERS = { "Content-Type": "application/json" };
const stamp = Date.now();

describe("validation.rule: one relation hop", () => {
  let h: TestHarness;
  const whSlug = `wh_${stamp}`;
  const zoneSlug = `zn_${stamp}`;
  const binSlug = `bin_${stamp}`;
  let whA = "";
  let whB = "";
  let zoneA = "";
  let zoneB = "";

  const mkCollection = (body: unknown) =>
    h.fetch("/api/collections", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });

  const post = (slug: string, body: unknown) =>
    h.fetch(`/api/items/${slug}`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });

  const patch = (slug: string, id: string, body: unknown) =>
    h.fetch(`/api/items/${slug}/${id}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });

  const newId = async (slug: string, body: unknown): Promise<string> => {
    const r = await post(slug, body);
    expect(r.status).toBe(201);
    return ((await r.json()) as { data: { id: string } }).data.id;
  };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);

    expect(
      (await mkCollection({ slug: whSlug, fields: [{ name: "name", type: "text" }] })).status,
    ).toBe(201);
    expect(
      (
        await mkCollection({
          slug: zoneSlug,
          fields: [
            { name: "name", type: "text" },
            { name: "warehouse", type: "relation", to: whSlug },
          ],
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await mkCollection({
          slug: binSlug,
          fields: [
            { name: "code", type: "text" },
            { name: "zone", type: "relation", to: zoneSlug },
            {
              name: "warehouse",
              type: "relation",
              to: whSlug,
              validation: {
                rule: { warehouse: { _eq: "$field.zone.warehouse" } },
                message: "A bin's zone must belong to the bin's own warehouse",
              },
            },
          ],
        })
      ).status,
    ).toBe(201);

    whA = await newId(whSlug, { name: "Istanbul" });
    whB = await newId(whSlug, { name: "Izmir" });
    zoneA = await newId(zoneSlug, { name: "A-1", warehouse: whA });
    zoneB = await newId(zoneSlug, { name: "B-1", warehouse: whB });
  });

  afterAll(() => h.cleanup());

  test("a row that SATISFIES the invariant is accepted", async () => {
    // The regression this whole feature exists for: before the hop was
    // hydrated, this returned 422 — the rule refused the very row it describes.
    const r = await post(binSlug, { code: "A-1-01", zone: zoneA, warehouse: whA });
    expect(r.status).toBe(201);
  });

  test("a row that VIOLATES it is refused, with the field's own message", async () => {
    const r = await post(binSlug, { code: "X-1", zone: zoneA, warehouse: whB });
    expect(r.status).toBe(422);
    expect((await r.json()).error.message).toBe(
      "A bin's zone must belong to the bin's own warehouse",
    );
  });

  test("no relation set is a question, not a violation", async () => {
    // With no zone there is no row on the other side, so the rule has nothing to
    // judge. Refusing here would make the column unfillable in the ordinary
    // order of work — a bin exists before it is assigned a zone.
    const r = await post(binSlug, { code: "UNASSIGNED", warehouse: whA });
    expect(r.status).toBe(201);
  });

  test("a PATCH is judged against the row the relation now points at", async () => {
    const id = await newId(binSlug, { code: "P-1", zone: zoneA, warehouse: whA });
    const moved = await patch(binSlug, id, { zone: zoneB });
    expect(moved.status).toBe(422);
    const repointed = await patch(binSlug, id, { warehouse: whB });
    expect(repointed.status).toBe(422);
    // Both endpoints moved at once: consistent again, so allowed.
    const both = await patch(binSlug, id, { zone: zoneB, warehouse: whB });
    expect(both.status).toBe(200);
  });

  test("a PATCH that names neither side still reads the stored relation", async () => {
    // The merged row carries `zone` from the row on disk, so the hop resolves
    // even though the patch never mentions it. If it did not, this write would
    // be refused for a rule it does not touch.
    const id = await newId(binSlug, { code: "P-2", zone: zoneA, warehouse: whA });
    const r = await patch(binSlug, id, { code: "P-2b" });
    expect(r.status).toBe(200);
  });

  test("a money hop compares major units, not the stored minor ones", async () => {
    // The reason the hop is read back through `deserializeField` rather than
    // straight off the column. A money column stores integer MINOR units, so an
    // un-deserialized ceiling of 100.00 TRY arrives as 10000 and every price
    // under a hundred pounds of lira slips under it.
    const plans = `plans_${stamp}`;
    const subs = `subs_${stamp}`;
    expect(
      (
        await mkCollection({
          slug: plans,
          fields: [
            { name: "name", type: "text" },
            { name: "max_price", type: "money", money: { currency: "TRY" } },
          ],
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await mkCollection({
          slug: subs,
          fields: [
            { name: "plan", type: "relation", to: plans },
            {
              name: "price",
              type: "money",
              money: { currency: "TRY" },
              validation: {
                rule: { price: { _lte: "$field.plan.max_price" } },
                message: "over the plan ceiling",
              },
            },
          ],
        })
      ).status,
    ).toBe(201);
    const plan = await newId(plans, { name: "Basic", max_price: 100 });
    expect((await post(subs, { plan, price: 50 })).status).toBe(201);
    expect((await post(subs, { plan, price: 100 })).status).toBe(201);
    const over = await post(subs, { plan, price: 150 });
    expect(over.status).toBe(422);
    expect((await over.json()).error.message).toBe("over the plan ceiling");
  });

  test("an advisory hop rule warns instead of refusing", async () => {
    const slug = `advisory_${stamp}`;
    expect(
      (
        await mkCollection({
          slug,
          fields: [
            { name: "zone", type: "relation", to: zoneSlug },
            {
              name: "warehouse",
              type: "relation",
              to: whSlug,
              validation: {
                rule: { warehouse: { _eq: "$field.zone.warehouse" } },
                severity: "warning",
                message: "zone is in another warehouse",
              },
            },
          ],
        })
      ).status,
    ).toBe(201);
    const r = await post(slug, { zone: zoneA, warehouse: whB });
    expect(r.status).toBe(201);
    const body = (await r.json()) as { warnings?: { field: string; message: string }[] };
    expect(body.warnings?.[0]?.message).toBe("zone is in another warehouse");
  });
});

describe("validation.rule: what a hop may not do", () => {
  let h: TestHarness;
  const whSlug = `whx_${stamp}`;
  const zoneSlug = `znx_${stamp}`;

  const mkCollection = (body: unknown) =>
    h.fetch("/api/collections", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });

  /** Save a one-field-plus-rule collection and return [status, message]. */
  const trySchema = async (
    extraFields: unknown[],
    rule: unknown,
  ): Promise<[number, string]> => {
    const r = await mkCollection({
      slug: `probe_${Math.random().toString(36).slice(2, 10)}`,
      fields: [
        ...extraFields,
        { name: "warehouse", type: "relation", to: whSlug, validation: { rule } },
      ],
    });
    const body = (await r.json()) as { error?: { message?: string } };
    return [r.status, body.error?.message ?? ""];
  };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    expect(
      (
        await mkCollection({
          slug: whSlug,
          fields: [
            { name: "name", type: "text" },
            { name: "title", type: "text", localized: true },
            { name: "divider_1", type: "divider" },
          ],
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await mkCollection({
          slug: zoneSlug,
          fields: [
            { name: "name", type: "text" },
            { name: "warehouse", type: "relation", to: whSlug },
          ],
        })
      ).status,
    ).toBe(201);
  });

  afterAll(() => h.cleanup());

  // Each of these used to SAVE and then refuse every write to the collection.
  // The point of the group is that the failure is now visible where the mistake
  // was made, and that the message says which spelling to use instead.

  test("two hops are refused, and the message says one is the limit", async () => {
    const [status, message] = await trySchema(
      [{ name: "zone", type: "relation", to: zoneSlug }],
      { warehouse: { _eq: "$field.zone.warehouse.name" } },
    );
    expect(status).toBe(422);
    expect(message).toContain("only one hop is supported");
  });

  test("a hop through a non-relation field is refused", async () => {
    const [status, message] = await trySchema([{ name: "code", type: "text" }], {
      warehouse: { _eq: "$field.code.name" },
    });
    expect(status).toBe(422);
    expect(message).toContain("not a relation");
  });

  test("a hop through relation_many is refused", async () => {
    const [status, message] = await trySchema(
      [{ name: "zones", type: "relation_many", to: zoneSlug }],
      { warehouse: { _eq: "$field.zones.warehouse" } },
    );
    expect(status).toBe(422);
    expect(message).toContain("relation_many");
  });

  test("the hop spelled as a left-hand key is refused, not silently false", async () => {
    // `{"zone.warehouse": …}` is the query language's correlated-EXISTS form.
    // The row matcher answers `false` to any dotted key it is handed, so this
    // spelling refused every write; the message now names the one that works.
    const [status, message] = await trySchema(
      [{ name: "zone", type: "relation", to: zoneSlug }],
      { "zone.warehouse": { _eq: "$field.warehouse" } },
    );
    expect(status).toBe(422);
    expect(message).toContain("left of a comparison");
  });

  test("a sub-field the target does not have is refused, and the target's fields are listed", async () => {
    // The one refusal that needs the other collection. Left alone it is the
    // worst of the set: an unresolvable hop is SKIPPED at write time, so a typo
    // here leaves the invariant quietly unenforced forever.
    const [status, message] = await trySchema(
      [{ name: "zone", type: "relation", to: zoneSlug }],
      { warehouse: { _eq: "$field.zone.warehoose" } },
    );
    expect(status).toBe(422);
    expect(message).toContain(`has no field "warehoose"`);
    expect(message).toContain("warehouse");
  });

  test("a hop onto a localized column is refused", async () => {
    const [status, message] = await trySchema(
      [{ name: "wh2", type: "relation", to: whSlug }],
      { warehouse: { _eq: "$field.wh2.title" } },
    );
    expect(status).toBe(422);
    expect(message).toContain("translations sidecar");
  });

  test("a hop onto a presentational block is refused", async () => {
    // Only reachable through a SELF-reference: `loadCollection` strips
    // divider/notice blocks, so a hop into another collection reports the sub
    // as absent (the test above) rather than as layout. A self-hop is judged
    // against the incoming list, which still has them.
    const slug = `layout_${stamp}`;
    const r = await mkCollection({
      slug,
      fields: [
        { name: "divider_1", type: "divider" },
        { name: "parent", type: "relation", to: slug },
        {
          name: "name",
          type: "text",
          validation: { rule: { name: { _eq: "$field.parent.divider_1" } } },
        },
      ],
    });
    expect(r.status).toBe(422);
    expect(((await r.json()) as { error: { message: string } }).error.message).toContain(
      "owns no column",
    );
  });

  test("a hop into a collection that does not exist YET is allowed through", async () => {
    // Same asymmetry `checkRelationTargets` documents: refusing a forward
    // reference makes an ordinary parent↔child pair uncreatable in either
    // order. The dangling `to` is already reported as a warning.
    const r = await mkCollection({
      slug: `forward_${stamp}`,
      fields: [
        { name: "later", type: "relation", to: `not_yet_${stamp}` },
        {
          name: "warehouse",
          type: "relation",
          to: whSlug,
          validation: { rule: { warehouse: { _eq: "$field.later.warehouse" } } },
        },
      ],
    });
    expect(r.status).toBe(201);
    const body = (await r.json()) as { warning?: string };
    expect(body.warning ?? "").toContain("does not exist yet");
  });

  test("a self-referencing hop is judged against the INCOMING fields", async () => {
    // The parent column and the hop that reads it can arrive in one body; the
    // stored shape is the old one and would not have it.
    const slug = `selfref_${stamp}`;
    const r = await mkCollection({
      slug,
      fields: [
        { name: "region", type: "text" },
        { name: "parent", type: "relation", to: slug },
        {
          name: "region_check",
          type: "text",
          validation: { rule: { region: { _eq: "$field.parent.region" } } },
        },
      ],
    });
    expect(r.status).toBe(201);
  });

  test("a same-row rule is unaffected", async () => {
    const r = await mkCollection({
      slug: `sameRow_${stamp}`.toLowerCase(),
      fields: [
        { name: "start_date", type: "timestamp" },
        {
          name: "end_date",
          type: "timestamp",
          validation: { rule: { end_date: { _gte: "$field.start_date" } } },
        },
      ],
    });
    expect(r.status).toBe(201);
  });
});
