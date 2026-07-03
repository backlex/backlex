/**
 * Per-field conditions — the server-enforced `required` effect.
 *
 * A field carries `conditions: [{ rule, required }]`; when the rule matches the
 * (merged) row and the value is empty, create/update is rejected 422. Applies to
 * everyone (schema-level, not permission-level) — so the seeded admin is subject
 * to it too. `readonly` / `hidden` are UI-only and not exercised here.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const JSON_HEADERS = { "Content-Type": "application/json" };

describe("field conditions: conditional required", () => {
  let h: TestHarness;
  const slug = `shipments_${Date.now()}`;
  let pendingId: string;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const create = await h.fetch("/api/collections", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        slug,
        fields: [
          { name: "status", type: "text" },
          {
            name: "tracking_number",
            type: "text",
            conditions: [
              {
                name: "shipped needs tracking",
                rule: { status: { _eq: "shipped" } },
                required: true,
              },
            ],
          },
        ],
      }),
    });
    expect(create.status).toBe(201);
  });

  afterAll(() => h.cleanup());

  test("create: rule not matching → field stays optional (201)", async () => {
    const res = await h.fetch(`/api/items/${slug}`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ status: "pending" }),
    });
    expect(res.status).toBe(201);
    pendingId = ((await res.json()) as { data: { id: string } }).data.id;
  });

  test("create: rule matches + value empty → 422", async () => {
    const res = await h.fetch(`/api/items/${slug}`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ status: "shipped" }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("tracking_number");
  });

  test("create: rule matches + value present → 201", async () => {
    const res = await h.fetch(`/api/items/${slug}`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ status: "shipped", tracking_number: "1Z999" }),
    });
    expect(res.status).toBe(201);
  });

  test("update: patch flips status to shipped on the merged row, no tracking → 422", async () => {
    const res = await h.fetch(`/api/items/${slug}/${pendingId}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ status: "shipped" }),
    });
    expect(res.status).toBe(422);
  });

  test("update: patch supplies status + tracking together → 200", async () => {
    const res = await h.fetch(`/api/items/${slug}/${pendingId}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ status: "shipped", tracking_number: "1Z000" }),
    });
    expect(res.status).toBe(200);
  });
});

describe("field conditions: schema validation", () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });

  afterAll(() => h.cleanup());

  test("condition rule referencing an unknown field is rejected at create", async () => {
    const res = await h.fetch("/api/collections", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        slug: `bad_${Date.now()}`,
        fields: [
          { name: "status", type: "text" },
          {
            name: "note",
            type: "text",
            conditions: [{ rule: { nonexistent: { _eq: "x" } }, required: true }],
          },
        ],
      }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("nonexistent");
  });
});
