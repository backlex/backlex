/**
 * `PATCH /api/collections/:slug` used to answer `{ok:true}` to two bodies that
 * destroyed something, and both were found on a customer's first afternoon.
 *
 * 1. `fields` is a REPLACE, not a merge. Sending only the field being edited
 *    reduced a 6-field collection to 1. The response said nothing, and the
 *    collection then 422'd every read because its own `defaultSort` named a
 *    field the metadata had just forgotten.
 * 2. A field's `type` can change, but `applyCollection` is additive and never
 *    rewrites a column — so the change alters only how bytes already on disk
 *    are read back. `number` ⇄ `money` is the expensive case: `money` holds
 *    integer minor units, `number` holds major, so a ₺184 invoice read back as
 *    ₺1.84 and the write reported success.
 *
 * One exemption is deliberate and lives in `unknown-field-type.test.ts`, which
 * can write the broken metadata this route refuses to accept: a field whose
 * stored type is not a field type at all reinterprets nothing when repaired, so
 * writing a real type back is NOT gated. The first version of this guard
 * blocked that, putting a confirmation in front of the recovery path.
 *
 * Both are now refused by default and gated behind an explicit acknowledgement,
 * because both ARE legitimate things to want on purpose. The tests that matter
 * most here are the ones asserting the legitimate paths still pass — a guard
 * that blocks real work is worse than the bug it replaced.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const JSON_HEADERS = { "Content-Type": "application/json" };

describe("PATCH /api/collections/:slug destructive-body guards", () => {
  let h: TestHarness;
  const slug = `invoices_${Date.now()}`;

  const patch = (body: unknown) =>
    h.fetch(`/api/collections/${slug}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });

  const FULL_FIELDS = [
    { name: "number", type: "text", required: true },
    { name: "amount", type: "money", money: { currency: "TRY" } },
    { name: "status", type: "text" },
    { name: "issued_at", type: "timestamp" },
  ];

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const r = await h.fetch("/api/collections", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ slug, fields: FULL_FIELDS }),
    });
    expect(r.status).toBe(201);
  });

  test("a body carrying only the edited field is refused, and names what it would drop", async () => {
    const r = await patch({ fields: [{ name: "amount", type: "money", money: { currency: "TRY" } }] });
    expect(r.status).toBe(422);
    const b = (await r.json()) as { error: { code: string; message: string; details: { dropped: string[] } } };
    expect(b.error.code).toBe("VALIDATION");
    expect(b.error.details.dropped.sort()).toEqual(["issued_at", "number", "status"]);
    // The message has to be actionable on its own — this is the whole fix.
    expect(b.error.message).toContain("allowFieldRemoval");
    expect(b.error.message).toContain("number, status, issued_at");
  });

  test("the schema is untouched by a refused PATCH", async () => {
    const r = await h.fetch(`/api/collections/${slug}`);
    const b = (await r.json()) as { data: { fields: { name: string }[] } };
    expect(b.data.fields.map((f) => f.name).sort()).toEqual(["amount", "issued_at", "number", "status"]);
  });

  test("a deliberate removal goes through with the acknowledgement", async () => {
    const r = await patch({ allowFieldRemoval: true, fields: FULL_FIELDS.filter((f) => f.name !== "status") });
    expect(r.status).toBe(200);
    const after = (await (await h.fetch(`/api/collections/${slug}`)).json()) as {
      data: { fields: { name: string }[] };
    };
    expect(after.data.fields.map((f) => f.name)).not.toContain("status");
    // put it back for the rest of the suite
    expect((await patch({ fields: FULL_FIELDS })).status).toBe(200);
  });

  test("number ⇄ money is refused, and the message names the 100x unit shift", async () => {
    const r = await patch({
      fields: FULL_FIELDS.map((f) => (f.name === "amount" ? { name: "amount", type: "number" } : f)),
    });
    expect(r.status).toBe(422);
    const b = (await r.json()) as {
      error: { message: string; details: { changed: { field: string; from: string; to: string }[] } };
    };
    expect(b.error.details.changed).toEqual([{ field: "amount", from: "money", to: "number" }]);
    expect(b.error.message).toContain("100×");
    expect(b.error.message).toContain("allowFieldTypeChange");
    // The safe path exists and is documented; the error is where a caller meets it.
    expect(b.error.message).toContain("/docs/schema-versions/");
  });

  test("a type change goes through with the acknowledgement", async () => {
    const asNumber = FULL_FIELDS.map((f) => (f.name === "amount" ? { name: "amount", type: "number" } : f));
    expect((await patch({ allowFieldTypeChange: true, fields: asNumber })).status).toBe(200);
    expect((await patch({ allowFieldTypeChange: true, fields: FULL_FIELDS })).status).toBe(200);
  });


  test("the ordinary edits this endpoint exists for are unaffected", async () => {
    // Same list, one field gains a property — no drop, no type change.
    //
    // This said `note:` until the unknown-field-key guard landed, and `note` is
    // not a field key — the per-field help text is `description`. Zod stripped
    // it, so the property this test claims to add was never stored and the
    // assertion passed on the status code alone. Same shape as the guard it
    // sits beside: the write reported success and did less than it said.
    const withHelp = FULL_FIELDS.map((f) =>
      f.name === "status" ? { ...f, description: "draft → sent → paid" } : f,
    );
    expect((await patch({ fields: withHelp })).status).toBe(200);
    // …and now assert it actually landed, which is what the test meant to say.
    const stored = (await (await h.fetch(`/api/collections/${slug}`)).json()) as {
      data: { fields: { name: string; description?: string }[] };
    };
    expect(stored.data.fields.find((f) => f.name === "status")?.description).toBe(
      "draft → sent → paid",
    );
    // A body that never mentions `fields` must not be touched by either guard.
    expect((await patch({ note: "Amounts are TRY." })).status).toBe(200);
    // Adding a field is additive and needs no acknowledgement.
    expect((await patch({ fields: [...FULL_FIELDS, { name: "paid_at", type: "timestamp" }] })).status).toBe(200);
  });
});
