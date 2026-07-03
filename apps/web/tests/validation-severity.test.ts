import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const json = (body: unknown, method = "POST"): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

// Coverage for validation `severity`: error blocks (422); warning/info are
// advisory — the write succeeds and the failure is surfaced in `warnings`.
describe("validation severity", () => {
  let h: TestHarness;
  const slug = "signups";

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
          // hard rule: blocks
          { name: "email", type: "text", validation: { format: "email", severity: "error" } },
          // soft rule: advisory bio length
          {
            name: "bio",
            type: "text",
            validation: { minLength: 20, severity: "warning", message: "A longer bio is recommended" },
          },
        ],
      }),
    );
  });
  afterAll(() => h.cleanup());

  test("error severity blocks the write with 422", async () => {
    const { status } = await create({ email: "not-an-email", bio: "this is a nice long bio ok" });
    expect(status).toBe(422);
  });

  test("warning severity does NOT block and is returned in `warnings`", async () => {
    const { status, body } = await create({ email: "a@x.com", bio: "short" });
    expect(status).toBe(201);
    expect(body.data.bio).toBe("short");
    expect(Array.isArray(body.warnings)).toBe(true);
    expect(body.warnings).toHaveLength(1);
    expect(body.warnings[0].field).toBe("bio");
    expect(body.warnings[0].severity).toBe("warning");
    expect(body.warnings[0].message).toBe("A longer bio is recommended");
  });

  test("no warnings key when the advisory rule passes", async () => {
    const { status, body } = await create({ email: "b@x.com", bio: "this bio is definitely long enough" });
    expect(status).toBe(201);
    expect(body.warnings ?? null).toBeNull();
  });
});
