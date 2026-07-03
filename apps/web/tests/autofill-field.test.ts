import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const json = (body: unknown, method = "POST"): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

// Coverage for onCreate/onUpdate server-side auto-fill: computed + written
// server-side, read-only for the caller, and refreshed on update. Runs against
// the harness SQLite (same code path serves PG).
describe("onCreate / onUpdate auto-fill", () => {
  let h: TestHarness;
  const slug = "audit_rows";

  const gql = async (query: string, variables?: unknown) =>
    (await (await h.fetch("/api/graphql", json({ query, variables }))).json()) as {
      data?: Record<string, any>;
      errors?: { message: string }[];
    };

  const create = async (body: unknown) => {
    const r = await h.fetch(`/api/items/${slug}`, json(body));
    return { status: r.status, body: (await r.json()) as any };
  };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    await h.fetch(
      "/api/collections",
      json({
        slug,
        fields: [
          { name: "title", type: "text", required: true },
          { name: "ext_id", type: "uuid", onCreate: "uuid" },
          { name: "author_id", type: "text", onCreate: "user" },
          { name: "touched_at", type: "timestamp", onUpdate: "now" },
        ],
      }),
    );
  });
  afterAll(() => h.cleanup());

  test("create auto-fills onCreate columns and echoes them", async () => {
    const { status, body } = await create({ title: "first" });
    expect(status).toBe(201);
    expect(body.data.title).toBe("first");
    // uuid shape
    expect(String(body.data.ext_id)).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof body.data.author_id).toBe("string");
    expect(body.data.author_id.length).toBeGreaterThan(0);
    // onUpdate column isn't filled on insert
    expect(body.data.touched_at ?? null).toBeNull();
  });

  test("a caller cannot write an auto-filled column (read-only)", async () => {
    const { status, body } = await create({ title: "spoof", ext_id: "11111111-1111-1111-1111-111111111111" });
    expect(status).toBe(422);
    expect(String(body.error?.message ?? "")).toContain("auto-filled");
  });

  test("update refreshes the onUpdate column", async () => {
    const { body } = await create({ title: "to-update" });
    const id = body.data.id;
    const origExt = body.data.ext_id;

    const r = await h.fetch(`/api/items/${slug}/${id}`, json({ title: "updated" }, "PATCH"));
    const patched = (await r.json()).data as Record<string, any>;
    expect(patched.title).toBe("updated");
    // touched_at now set to an ISO timestamp
    expect(typeof patched.touched_at).toBe("string");
    expect(Number.isNaN(Date.parse(patched.touched_at))).toBe(false);
    // ext_id (onCreate) is unchanged by the update
    expect(patched.ext_id).toBe(origExt);
  });

  test("GraphQL: input type rejects auto-filled fields but the row exposes them", async () => {
    // Writing an auto-filled field via GraphQL input is a schema error.
    const bad = await gql(
      `mutation { createAuditRows(data: { title: "g", extId: "x" }) { id } }`,
    );
    expect(bad.errors?.length ?? 0).toBeGreaterThan(0);
    // A clean create returns the auto-filled values.
    const ok = await gql(`mutation { createAuditRows(data: { title: "g2" }) { id extId authorId } }`);
    expect(ok.errors ?? []).toHaveLength(0);
    expect(String(ok.data?.createAuditRows?.extId)).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof ok.data?.createAuditRows?.authorId).toBe("string");
  });
});
