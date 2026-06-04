/**
 * Regression for the Ask AI planner schema drift (fix/ai-ask-vector-search).
 *
 * The planner tool catalog used to advertise vector.search as
 * `{collection, query, top_k}`. The real `POST /api/vector/search` route
 * requires `{model, text, topK?}`, so every generated call hard-400'd on the
 * Zod schema with "model invalid" + "text undefined".
 *
 * This test pins the actual route contract so the planner description in
 * ai-ask.ts can't silently drift back: the OLD shape must 400 (reproducing
 * the user-reported bug), and the NEW shape must clear validation (it may
 * still fail downstream on the missing Vectorize binding — that's infra, not
 * the request contract, so we assert it is NOT a 400 validation error).
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

describe("vector.search request contract", () => {
  let h: TestHarness;
  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  const search = (body: unknown) =>
    h.fetch("/api/vector/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  test("OLD planner shape {collection, query, top_k} → 400 on model + text", async () => {
    const res = await search({
      collection: "customers",
      query: "($and: [{ created_at: { _gte: $now } }])",
      top_k: 10,
    });
    expect(res.status).toBe(400);
    const text = await res.text();
    // The exact two issues the user hit: model enum + missing text string.
    expect(text).toContain("model");
    expect(text).toContain("text");
  });

  test("NEW planner shape {model, text, topK} → clears validation (not a 400)", async () => {
    const res = await search({
      model: "bge-m3",
      text: "recent enterprise customers",
      topK: 10,
    });
    // No Vectorize binding in the local/test env, so this won't reach 200 —
    // but it must get PAST request validation. A 400 here would mean the
    // shape the planner now emits is still rejected.
    expect(res.status).not.toBe(400);
  });

  test("bad model value is rejected against the registry enum", async () => {
    const res = await search({ model: "not-a-real-model", text: "hi" });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("model");
  });
});
