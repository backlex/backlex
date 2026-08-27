/**
 * Hono's own 4xx must not arrive as our 500.
 *
 * The framework raises an `HTTPException` before any route code runs — a body
 * that is not JSON, a FormData part it cannot parse, a payload past the size
 * cap. The global handler knew `AppError` and `ZodError` and nothing else, so
 * every one of those fell through to the catch-all and came back as
 * `500 INTERNAL / "Internal server error"`.
 *
 * Three separate costs, which is why this is guarded rather than tidied:
 *
 *  - the caller loses the message that said what to fix — "Malformed JSON in
 *    request body" became "Internal server error";
 *  - `logServerError` fires on 5xx, so a caller's typo wrote a server-error
 *    activity row and spent a cloud error report;
 *  - a **bodyless** `POST` that carries `content-type: application/json` — what
 *    `axios`, `curl -H`, and every generated OpenAPI client send by default —
 *    hit it on `publish`, `verify` and every other no-body write. The SDK
 *    escapes only because it deliberately omits the header when there is no
 *    body, which is a workaround for this bug rather than a reason to keep it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

describe("global error handler: hono's HTTPException keeps its own status", () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const res = await h.fetch("/api/collections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slug: "widgets",
        fields: [{ name: "title", type: "text" }],
      }),
    });
    expect(res.status).toBe(201);
  });

  afterAll(() => h.cleanup());

  test("a truncated JSON body is a 400 naming the problem, not a 500", async () => {
    const res = await h.fetch("/api/items/widgets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"title": "half a ro',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("VALIDATION");
    expect(body.error.message).toContain("Malformed JSON");
  });

  test("an empty body under a JSON content-type is a 400", async () => {
    const res = await h.fetch("/api/items/widgets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "",
    });
    expect(res.status).toBe(400);
  });

  test("a bodyless POST that still declares JSON does not 500", async () => {
    // What a generated client sends for a no-body write. `publish` is the one
    // an admin panel reaches for first on a versioned collection.
    const item = await h.fetch("/api/items/widgets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "real row" }),
    });
    expect(item.status).toBe(201);
    const { data } = (await item.json()) as { data: { id: string } };

    const res = await h.fetch(`/api/items/widgets/${data.id}/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBeLessThan(500);
  });

  test("a well-formed body that simply fails the schema is still a 422", async () => {
    // The fix must not swallow the ZodError branch it sits in front of.
    const res = await h.fetch("/api/items/widgets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "[1,2,3]",
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION");
  });

  test("an ordinary AppError keeps its own status and message", async () => {
    const res = await h.fetch("/api/items/widgets/00000000-0000-4000-8000-000000000000", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "ghost" }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });
});
