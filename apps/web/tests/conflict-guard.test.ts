/**
 * Optimistic-concurrency guard on item PATCH (`x-if-unmodified-since`).
 *
 * Opt-in: a PATCH without the header keeps last-write-wins. With the header,
 * the update only applies when the row's `updatedAt` still matches what the
 * caller loaded — otherwise 409 CONFLICT (with the current updatedAt in the
 * error details) so the editor can show a conflict banner instead of silently
 * overwriting someone else's save.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type TestHarness, makeHarness, seedAdmin } from "./setup";

describe("item PATCH conflict guard", () => {
  let h: TestHarness;
  const slug = `conflict_${Date.now()}`;
  let id = "";

  const patchWith = (header: string | null, body: Record<string, unknown>) =>
    h.fetch(`/api/items/${slug}/${id}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        ...(header !== null ? { "x-if-unmodified-since": header } : {}),
      },
      body: JSON.stringify(body),
    });

  const currentUpdatedAt = async (): Promise<string> => {
    const r = await h.fetch(`/api/items/${slug}/${id}`);
    const row = ((await r.json()) as { data: Record<string, unknown> }).data;
    return String(row.updatedAt ?? row.updated_at);
  };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const r = await h.fetch("/api/collections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slug,
        fields: [{ name: "title", type: "text", required: true }],
      }),
    });
    expect(r.status).toBe(201);
    const created = await h.fetch(`/api/items/${slug}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "v1" }),
    });
    expect(created.status).toBe(201);
    id = String(((await created.json()) as { data: { id: string } }).data.id);
  });
  afterAll(() => h.cleanup());

  test("matching precondition applies the update", async () => {
    const base = await currentUpdatedAt();
    const res = await patchWith(base, { title: "v2" });
    expect(res.status).toBe(200);
    const row = ((await res.json()) as { data: Record<string, unknown> }).data;
    expect(row.title).toBe("v2");
  });

  test("stale precondition is refused with 409 and carries the current updatedAt", async () => {
    const base = await currentUpdatedAt();
    // Move the row (unconditional PATCH), making `base` stale. The updatedAt
    // stamp is second-resolution on some dialects — wait past the boundary so
    // the second save provably lands on a different timestamp.
    await new Promise((r) => setTimeout(r, 1100));
    expect((await patchWith(null, { title: "v3" })).status).toBe(200);

    const res = await patchWith(base, { title: "mine" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: { code: string; details?: { currentUpdatedAt?: unknown } };
    };
    expect(body.error.code).toBe("CONFLICT");
    expect(body.error.details?.currentUpdatedAt).toBeTruthy();

    // The refused write must not have applied.
    const check = await h.fetch(`/api/items/${slug}/${id}`);
    const row = ((await check.json()) as { data: Record<string, unknown> }).data;
    expect(row.title).toBe("v3");
  });

  test("no precondition keeps last-write-wins", async () => {
    const res = await patchWith(null, { title: "v4" });
    expect(res.status).toBe(200);
  });

  test("garbage precondition is a validation error", async () => {
    const res = await patchWith("not-a-timestamp", { title: "v5" });
    expect(res.status).toBe(422);
  });
});
