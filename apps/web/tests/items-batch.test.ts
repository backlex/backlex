import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

describe("batch writes", () => {
  let h: TestHarness;
  const slug = `batch_${Date.now()}`;

  const post = (body: unknown) =>
    h.fetch(`/api/items/${slug}/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const createOne = async (title: string): Promise<string> => {
    const r = await h.fetch(`/api/items/${slug}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
    return ((await r.json()) as { data: { id: string } }).data.id;
  };
  const count = async (): Promise<number> => {
    const r = await h.fetch(`/api/items/${slug}?meta=filter_count&limit=1`);
    const j = (await r.json()) as { meta?: { filter_count?: number } };
    return j.meta?.filter_count ?? 0;
  };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    await h.fetch("/api/collections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slug,
        fields: [{ name: "title", type: "text", required: true }, { name: "n", type: "integer" }],
      }),
    });
  });
  afterAll(() => h.cleanup());

  test("non-atomic bulk create returns per-row results", async () => {
    const res = await post({
      operations: [
        { op: "create", data: { title: "a" } },
        { op: "create", data: { title: "b" } },
        { op: "create", data: { title: "c" } },
      ],
    });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as {
      data: { atomic: boolean; total: number; succeeded: number; failed: number; results: any[] };
    };
    expect(data.atomic).toBe(false);
    expect(data.total).toBe(3);
    expect(data.succeeded).toBe(3);
    expect(data.results.every((r) => r.ok && r.id)).toBe(true);
  });

  test("non-atomic: a bad row fails but the others still commit", async () => {
    const before = await count();
    const res = await post({
      operations: [
        { op: "create", data: { title: "ok1" } },
        { op: "create", data: { n: 5 } }, // missing required `title` → fails
        { op: "create", data: { title: "ok2" } },
      ],
    });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { succeeded: number; failed: number; results: any[] } };
    expect(data.succeeded).toBe(2);
    expect(data.failed).toBe(1);
    expect(data.results[1].ok).toBe(false);
    expect(data.results[1].error.code).toBe("VALIDATION");
    expect(await count()).toBe(before + 2); // only the 2 good rows landed
  });

  test("non-atomic mixed create/update/delete", async () => {
    const id1 = await createOne("upd-me");
    const id2 = await createOne("del-me");
    const res = await post({
      operations: [
        { op: "create", data: { title: "new" } },
        { op: "update", id: id1, data: { title: "updated" } },
        { op: "delete", id: id2 },
      ],
    });
    const { data } = (await res.json()) as { data: { succeeded: number; results: any[] } };
    expect(data.succeeded).toBe(3);
    const got = await h.fetch(`/api/items/${slug}/${id1}`);
    expect(((await got.json()) as { data: { title: string } }).data.title).toBe("updated");
    expect((await h.fetch(`/api/items/${slug}/${id2}`)).status).toBe(404);
  });

  test("atomic batch commits all on success", async () => {
    const before = await count();
    const res = await post({
      atomic: true,
      operations: [
        { op: "create", data: { title: "atom-1" } },
        { op: "create", data: { title: "atom-2" } },
      ],
    });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { atomic: boolean; succeeded: number } };
    expect(data.atomic).toBe(true);
    expect(data.succeeded).toBe(2);
    expect(await count()).toBe(before + 2);
  });

  test("atomic batch rolls back entirely when one op fails", async () => {
    const before = await count();
    const res = await post({
      atomic: true,
      operations: [
        { op: "create", data: { title: "good" } },
        { op: "create", data: { n: 1 } }, // missing required title → aborts whole batch
      ],
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("operation #1");
    expect(await count()).toBe(before); // nothing committed
  });

  test("atomic update rolls back when a later delete targets a missing row", async () => {
    const id = await createOne("keep");
    const res = await post({
      atomic: true,
      operations: [
        { op: "update", id, data: { title: "changed" } },
        { op: "delete", id: "does-not-exist" }, // NOT_FOUND → rollback
      ],
    });
    expect(res.status).toBe(404);
    // the update must NOT have stuck
    const got = await h.fetch(`/api/items/${slug}/${id}`);
    expect(((await got.json()) as { data: { title: string } }).data.title).toBe("keep");
  });

  test("rejects an over-size batch", async () => {
    const operations = Array.from({ length: 101 }, () => ({ op: "create", data: { title: "x" } }));
    const res = await post({ operations });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  test("a role-less caller is denied per-row (FORBIDDEN)", async () => {
    // Sign up a second user on the same DB — the first user is auto-promoted to
    // admin, this one gets no roles, so it has no create permission. (Last test
    // in the block; switching the session cookie here is fine.)
    const up = await h.fetch("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: `u2-${Date.now()}@example.test`,
        password: "correct-horse-battery",
        name: "U2",
      }),
    });
    expect(up.ok).toBe(true);
    const res = await post({ operations: [{ op: "create", data: { title: "x" } }] });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { failed: number; results: any[] } };
    expect(data.failed).toBe(1);
    expect(data.results[0].error.code).toBe("FORBIDDEN");
  });
});
