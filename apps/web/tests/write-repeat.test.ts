/**
 * Every write in this suite runs against the pristine initial state.
 *
 * Measured before this file existed: of the spec files that apply a schema
 * template, exactly TWO use more than one template id, and neither applies two
 * onto the same workspace. Nothing anywhere ran a create, a delete, or a
 * migration-shaped operation TWICE. So the second-time path — the one a real
 * operator takes constantly, because they retried, double-clicked, re-ran the
 * importer, or applied a template onto a workspace that already had one — was
 * simply never executed.
 *
 * That is where the 500 lived: `ecommerce` onto a workspace already holding
 * `field-service` abandoned the apply at 39 of 61 collections. And it is where
 * this file found the next one: `POST /api/roles` with a name that already
 * exists reached the caller as `500 INTERNAL` carrying a raw
 * `UNIQUE constraint failed: roles.tenant_id, roles.name`, while the identical
 * situation on `POST /api/collections` correctly answered `409 CONFLICT` —
 * purely because collections happen to pre-check and roles do not.
 *
 * The property, which is what this file actually pins:
 *
 *   Running a write a second time is either an explicit refusal the caller can
 *   read, or a genuine no-op. Never a 5xx, and never a silent second copy.
 *
 * "Silent second copy" is the half worth stating out loud, because a 2xx that
 * quietly duplicated state reads exactly like a 2xx that correctly did nothing.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

describe("a write run twice", () => {
  let h: TestHarness;

  const post = async (path: string, body: unknown) => {
    const res = await h.fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };

  const count = async (path: string): Promise<number> => {
    const res = await h.fetch(path);
    const body = (await res.json()) as { data?: unknown[] };
    return body.data?.length ?? -1;
  };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });

  afterAll(() => h.cleanup());

  test("a duplicate collection slug is a 409 that names the clash", async () => {
    const first = await post("/api/collections", {
      slug: "crates",
      fields: [{ name: "title", type: "text" }],
    });
    expect(first.status).toBe(201);

    const second = await post("/api/collections", {
      slug: "crates",
      fields: [{ name: "title", type: "text" }],
    });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("CONFLICT");
  });

  test("a duplicate role name is a 409, not a leaked constraint", async () => {
    const first = await post("/api/roles", { name: "shipping", description: "packs boxes" });
    expect(first.status).toBe(201);

    const second = await post("/api/roles", { name: "shipping", description: "packs boxes" });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("CONFLICT");
    // The columns are named so the caller knows WHICH field collided; the
    // values are not, because a shared table's row may not be theirs to read.
    expect(second.body.error.message).toContain("name");
    expect(second.body.error.message).not.toContain("shipping");
  });

  test("and the second attempt left exactly one role behind", async () => {
    const roles = (await (await h.fetch("/api/roles")).json()) as { data: { name: string }[] };
    expect(roles.data.filter((r) => r.name === "shipping")).toHaveLength(1);
  });

  test("applying the same template twice does not seed the samples twice", async () => {
    const first = await post("/api/admin/templates/apply", { templateId: "invoicing" });
    expect(first.status).toBe(201);
    const after1 = await count("/api/items/invoices?limit=200");
    expect(after1).toBeGreaterThan(0);

    const second = await post("/api/admin/templates/apply", { templateId: "invoicing" });
    expect(second.status).toBeLessThan(500);
    const after2 = await count("/api/items/invoices?limit=200");
    expect(after2).toBe(after1);

    // The second apply must SAY it created nothing rather than reporting the
    // same success as the first — the two are indistinguishable to a caller
    // who only reads the status.
    expect(second.body.data.created).toEqual([]);
    expect(second.body.data.skipped.length).toBeGreaterThan(0);
  });

  test("clearing the samples twice removes them once and then reports zero", async () => {
    const first = await post("/api/admin/templates/clear-samples", { templateId: "invoicing" });
    expect(first.status).toBe(200);
    expect(first.body.data.removed).toBeGreaterThan(0);

    const second = await post("/api/admin/templates/clear-samples", { templateId: "invoicing" });
    expect(second.status).toBe(200);
    expect(second.body.data.removed).toBe(0);
  });

  test("deleting the same row twice is a 404 the second time, not a second success", async () => {
    const made = await post("/api/items/crates", { title: "one crate" });
    expect(made.status).toBe(201);
    const id = made.body.data.id as string;

    const first = await h.fetch(`/api/items/crates/${id}`, { method: "DELETE" });
    expect(first.status).toBe(200);

    const second = await h.fetch(`/api/items/crates/${id}`, { method: "DELETE" });
    expect(second.status).toBe(404);
    expect(((await second.json()) as any).error.code).toBe("NOT_FOUND");
  });

  test("dropping the same field twice is refused the second time, not silently re-run", async () => {
    const made = await post("/api/collections", {
      slug: "pallets",
      fields: [
        { name: "title", type: "text" },
        { name: "spare", type: "text" },
      ],
    });
    expect(made.status).toBe(201);

    const first = await h.fetch("/api/collections/pallets/fields/spare", { method: "DELETE" });
    expect(first.status).toBe(200);

    const second = await h.fetch("/api/collections/pallets/fields/spare", { method: "DELETE" });
    expect(second.status).toBeGreaterThanOrEqual(400);
    expect(second.status).toBeLessThan(500);
  });

  test("a unique field refuses the second row rather than 500-ing on the constraint", async () => {
    const made = await post("/api/collections", {
      slug: "skus",
      fields: [{ name: "code", type: "text", unique: true }],
    });
    expect(made.status).toBe(201);

    expect((await post("/api/items/skus", { code: "AB-1" })).status).toBe(201);
    const second = await post("/api/items/skus", { code: "AB-1" });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("CONFLICT");
  });

  test("no repeated write anywhere in the sweep produced a 5xx", async () => {
    // A single restatement of the property, so a future reader sees the rule
    // rather than only the eight instances of it above.
    const repeated: { label: string; run: () => Promise<number> }[] = [
      {
        label: "create a folder",
        run: async () => (await post("/api/folders", { name: "repeat-me" })).status,
      },
      {
        label: "create a collection",
        run: async () =>
          (await post("/api/collections", { slug: "repeat_me", fields: [{ name: "t", type: "text" }] }))
            .status,
      },
      {
        label: "create a role",
        run: async () => (await post("/api/roles", { name: "repeat-me" })).status,
      },
      {
        label: "apply a template",
        run: async () => (await post("/api/admin/templates/apply", { templateId: "blog" })).status,
      },
      {
        label: "clear samples",
        run: async () =>
          (await post("/api/admin/templates/clear-samples", { templateId: "blog" })).status,
      },
    ];

    const bad: string[] = [];
    for (const op of repeated) {
      const first = await op.run();
      if (first >= 500) bad.push(`${op.label}: first run → ${first}`);
      const second = await op.run();
      if (second >= 500) bad.push(`${op.label}: second run → ${second}`);
    }
    expect(bad).toEqual([]);
  });
});
