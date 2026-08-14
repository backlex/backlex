/**
 * Field-level validation rules — the constraints layered on top of the
 * pre-existing regex / min / max / minLength / maxLength set:
 *   - `format: "email" | "url"` (built-in canonical patterns)
 *   - `integer` (whole-number)
 *   - `minDate` / `maxDate` (timestamp bounds; absolute values here for
 *     determinism, relative-`$now` bounds are exercised in the db unit test)
 *   - `minSelect` / `maxSelect` (relation_many cardinality)
 *   - `message` (custom per-field error, overrides the generated text)
 *   - `rule` (cross-field escape hatch using `$field.<name>`)
 *
 * All are schema-level and server-enforced through the shared item write path,
 * so the seeded admin is subject to them too.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { validateValue, type FieldDef } from "@backlex/db";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const JSON_HEADERS = { "Content-Type": "application/json" };

/** Timestamp fields are stored as epoch-ms; the API takes a number (an ISO
 *  string coerces to NaN on SQLite). `validation.minDate/maxDate` config may
 *  still be ISO — it's parsed to epoch-ms before comparison. */
const ms = (iso: string): number => Date.parse(iso);

describe("field validation: per-value rules", () => {
  let h: TestHarness;
  const slug = `signups_${Date.now()}`;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const create = await h.fetch("/api/collections", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        slug,
        fields: [
          { name: "email", type: "text", validation: { format: "email" } },
          { name: "homepage", type: "text", validation: { format: "url" } },
          { name: "age", type: "integer", validation: { integer: true, min: 0 } },
          {
            name: "pin",
            type: "text",
            validation: { minLength: 4, message: "PIN must be at least 4 digits" },
          },
          {
            name: "starts_at",
            type: "timestamp",
            validation: {
              minDate: "2020-01-01T00:00:00.000Z",
              maxDate: "2030-01-01T00:00:00.000Z",
            },
          },
        ],
      }),
    });
    expect(create.status).toBe(201);
  });

  afterAll(() => h.cleanup());

  const post = (body: unknown) =>
    h.fetch(`/api/items/${slug}`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });

  test("valid row passes", async () => {
    const res = await post({
      email: "a@b.com",
      homepage: "https://example.com",
      age: 30,
      pin: "1234",
      starts_at: ms("2025-06-01T00:00:00.000Z"),
    });
    expect(res.status).toBe(201);
  });

  test("bad email → 422", async () => {
    const res = await post({ email: "not-an-email" });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("email");
  });

  test("bad url → 422", async () => {
    const res = await post({ homepage: "example.com" });
    expect(res.status).toBe(422);
  });

  test("fractional value on integer field → 422", async () => {
    const res = await post({ age: 3.5 });
    expect(res.status).toBe(422);
  });

  // The numeric bounds check is guarded by `typeof value === "number"`, so a
  // value of any OTHER type skipped validation entirely and went to the driver
  // as-is. An object arrived as the string `[object Object]` and the write
  // failed as an INTERNAL error naming the SQL — a 500 for a malformed request
  // body, which also means it pages someone.
  //
  // Reached for real: the e-commerce template gives `products.price` a money
  // type and `order_items.unit_price` a plain number (a line item has no
  // currency column of its own), so an app that copies one into the other
  // sends `{ amount, currency }` to a numeric column.
  test("an object on a numeric field → 422, not a 500", async () => {
    const res = await post({ age: { amount: 30, currency: "USD" } });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("age");
  });

  test("an array on a numeric field → 422", async () => {
    const res = await post({ age: [30] });
    expect(res.status).toBe(422);
  });

  test("a numeric string still passes — this narrows nothing that worked", async () => {
    // Not the canonical form, but it is what a form post sends and it has
    // always been accepted. The check rejects what cannot be a number, not
    // everything that is not already one.
    const res = await post({ age: "30" });
    expect(res.status).toBe(201);
  });

  test("custom message overrides the generated text", async () => {
    const res = await post({ pin: "12" });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("PIN must be at least 4 digits");
  });

  test("timestamp before minDate → 422", async () => {
    const res = await post({ starts_at: ms("2019-12-31T00:00:00.000Z") });
    expect(res.status).toBe(422);
  });

  test("timestamp after maxDate → 422", async () => {
    const res = await post({ starts_at: ms("2031-01-01T00:00:00.000Z") });
    expect(res.status).toBe(422);
  });
});

describe("field validation: relation_many cardinality", () => {
  let h: TestHarness;
  const tagSlug = `tags_${Date.now()}`;
  const postSlug = `posts_${Date.now()}`;
  const tagIds: string[] = [];

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    await h.fetch("/api/collections", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ slug: tagSlug, fields: [{ name: "label", type: "text" }] }),
    });
    for (const label of ["a", "b", "c"]) {
      const r = await h.fetch(`/api/items/${tagSlug}`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ label }),
      });
      tagIds.push(((await r.json()) as { data: { id: string } }).data.id);
    }
    await h.fetch("/api/collections", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        slug: postSlug,
        fields: [
          {
            name: "tags",
            type: "relation_many",
            to: tagSlug,
            validation: { minSelect: 1, maxSelect: 2 },
          },
        ],
      }),
    });
  });

  afterAll(() => h.cleanup());

  const post = (tags: string[]) =>
    h.fetch(`/api/items/${postSlug}`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ tags }),
    });

  test("within bounds → 201", async () => {
    const res = await post(tagIds.slice(0, 2));
    expect(res.status).toBe(201);
  });

  test("too many selected → 422", async () => {
    const res = await post(tagIds);
    expect(res.status).toBe(422);
  });

  test("too few selected → 422", async () => {
    const res = await post([]);
    expect(res.status).toBe(422);
  });
});

describe("field validation: cross-field rule", () => {
  let h: TestHarness;
  const slug = `bookings_${Date.now()}`;
  let id: string;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    await h.fetch("/api/collections", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        slug,
        fields: [
          { name: "start_date", type: "timestamp" },
          {
            name: "end_date",
            type: "timestamp",
            validation: {
              rule: { end_date: { _gte: "$field.start_date" } },
              message: "End date must be on or after start date",
            },
          },
        ],
      }),
    });
  });

  afterAll(() => h.cleanup());

  test("end after start → 201", async () => {
    const res = await h.fetch(`/api/items/${slug}`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        start_date: ms("2025-01-01T00:00:00.000Z"),
        end_date: ms("2025-01-05T00:00:00.000Z"),
      }),
    });
    expect(res.status).toBe(201);
    id = ((await res.json()) as { data: { id: string } }).data.id;
  });

  test("end before start → 422 with custom message", async () => {
    const res = await h.fetch(`/api/items/${slug}`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        start_date: ms("2025-01-10T00:00:00.000Z"),
        end_date: ms("2025-01-05T00:00:00.000Z"),
      }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("End date must be on or after start date");
  });

  test("update: patch end_date earlier than stored start_date → 422 (merged row)", async () => {
    const res = await h.fetch(`/api/items/${slug}/${id}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ end_date: ms("2024-12-01T00:00:00.000Z") }),
    });
    expect(res.status).toBe(422);
  });
});

describe("field validation: schema consistency", () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });

  afterAll(() => h.cleanup());

  const create = (fields: unknown) =>
    h.fetch("/api/collections", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ slug: `bad_${Date.now()}_${Math.trunc(performance.now())}`, fields }),
    });

  test("format on a non-text field → 422", async () => {
    const res = await create([
      { name: "n", type: "integer", validation: { format: "email" } },
    ]);
    expect(res.status).toBe(422);
  });

  test("minSelect on a non-relation_many field → 422", async () => {
    const res = await create([
      { name: "n", type: "text", validation: { minSelect: 1 } },
    ]);
    expect(res.status).toBe(422);
  });

  test("min greater than max → 422", async () => {
    const res = await create([
      { name: "n", type: "integer", validation: { min: 10, max: 1 } },
    ]);
    expect(res.status).toBe(422);
  });

  test("cross-field rule referencing an unknown field → 422", async () => {
    const res = await create([
      { name: "start_date", type: "timestamp" },
      {
        name: "end_date",
        type: "timestamp",
        validation: { rule: { end_date: { _gte: "$field.nonexistent" } } },
      },
    ]);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("nonexistent");
  });
});

describe("field validation: relative-$now date bounds (unit)", () => {
  const now = Date.parse("2026-07-03T12:00:00.000Z");
  const field: FieldDef = {
    name: "due",
    type: "timestamp",
    // Must be no earlier than "now" (a due date can't be in the past).
    validation: { minDate: "$now" },
  };

  test("value after $now passes", () => {
    expect(() =>
      validateValue(field, Date.parse("2026-07-04T00:00:00.000Z"), now),
    ).not.toThrow();
  });

  test("value before $now throws", () => {
    expect(() =>
      validateValue(field, Date.parse("2026-07-01T00:00:00.000Z"), now),
    ).toThrow();
  });

  test("relative offset: within 7 days passes, beyond throws", () => {
    const f: FieldDef = {
      name: "soon",
      type: "timestamp",
      validation: { maxDate: { $now: { add: { days: 7 } } } },
    };
    expect(() =>
      validateValue(f, Date.parse("2026-07-08T00:00:00.000Z"), now),
    ).not.toThrow();
    expect(() =>
      validateValue(f, Date.parse("2026-07-20T00:00:00.000Z"), now),
    ).toThrow();
  });
});
