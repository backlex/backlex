/**
 * Regression: the items aggregate endpoint must not become an oracle over rows
 * the caller can't read. `runItemsAggregate` previously skipped the soft-delete
 * (and draft) filters that list/get/search all apply, so a non-privileged
 * caller could COUNT / SUM over soft-deleted rows. The REST endpoint now passes
 * `excludeSoftDeleted` / `excludeDrafts`, mirroring read visibility.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const JSON_HEADERS = { "Content-Type": "application/json" };
const PASSWORD = "correct-horse-battery";

describe("aggregate excludes soft-deleted rows for read callers", () => {
  let h: TestHarness;
  const slug = `agglife_${Date.now()}`;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);

    const create = await h.fetch("/api/collections", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        slug,
        softDelete: true,
        tenantScoped: true,
        ownerScoped: false,
        fields: [
          { name: "title", type: "text", required: true },
          { name: "total", type: "integer" },
        ],
      }),
    });
    expect(create.status).toBe(201);

    // Let the builtin `authenticated` role read every row + field.
    const roles = (
      (await (await h.fetch("/api/roles")).json()) as { data: { id: string; name: string }[] }
    ).data;
    const authRole = roles.find((r) => r.name === "authenticated")!;
    const grant = await h.fetch(`/api/roles/${authRole.id}/permissions`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ collection: slug, action: "read", condition: null }),
    });
    expect(grant.status).toBeLessThan(300);

    const ins = async (title: string, total: number) => {
      const r = await h.fetch(`/api/items/${slug}`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ title, total }),
      });
      expect(r.status).toBe(201);
      return ((await r.json()) as { data: { id: string } }).data.id;
    };
    await ins("kept", 100);
    const goneId = await ins("gone", 50);
    // Soft-delete the second row (sets deleted_at).
    const del = await h.fetch(`/api/items/${slug}/${goneId}`, { method: "DELETE" });
    expect(del.status).toBeLessThan(300);
  });

  afterAll(() => h.cleanup());

  const agg = async (body: unknown) => {
    const res = await h.fetch(`/api/items/${slug}/aggregate`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as { data: Array<{ value: unknown }> } };
  };

  test("a read caller's count/sum ignore the soft-deleted row", async () => {
    await h.fetch("/api/auth/sign-out", { method: "POST" });
    const su = await h.fetch("/api/auth/sign-up/email", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        email: `viewer-${Date.now()}@example.test`,
        password: PASSWORD,
        name: "Viewer",
      }),
    });
    expect(su.status).toBe(200);

    const count = await agg({ agg: "count" });
    expect(count.status).toBe(200);
    expect(Number(count.json.data[0]!.value)).toBe(1);

    const sum = await agg({ agg: "sum", field: "total" });
    expect(sum.status).toBe(200);
    expect(Number(sum.json.data[0]!.value)).toBe(100); // 50 from the deleted row excluded
  });
});
