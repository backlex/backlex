/**
 * Advisor endpoint smoke tests.
 *
 * Covers the admin gate (200 for admin, 401 anonymous, 403 non-admin) and the
 * response shape, plus one real-finding assertion: a public-read permission
 * with no condition must surface a `security` finding.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const JSON_HEADERS = { "Content-Type": "application/json" };

interface AdvisorCheck {
  id: string;
  kind: "security" | "performance";
  level: "error" | "warn" | "info";
  title: string;
  body: string;
  fix: string;
  resource: string;
  detected: string;
}

const signUp = (h: TestHarness, email: string) =>
  h.fetch("/api/auth/sign-up/email", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ email, password: "correct-horse-battery", name: "U" }),
  });

const signOut = (h: TestHarness) =>
  h.fetch("/api/auth/sign-out", { method: "POST" });

describe("advisor: admin gate + shape", () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });

  afterAll(() => {
    h.cleanup();
  });

  test("admin GET /api/admin/advisor → 200 with { data: AdvisorCheck[] }", async () => {
    const res = await h.fetch("/api/admin/advisor");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: AdvisorCheck[] };
    expect(Array.isArray(body.data)).toBe(true);
    for (const c of body.data) {
      expect(typeof c.id).toBe("string");
      expect(["security", "performance"]).toContain(c.kind);
      expect(["error", "warn", "info"]).toContain(c.level);
      expect(typeof c.title).toBe("string");
      expect(typeof c.fix).toBe("string");
      expect(typeof c.resource).toBe("string");
      expect(typeof c.detected).toBe("string");
    }
  });

  test("anonymous GET /api/admin/advisor → 401", async () => {
    await signOut(h);
    const res = await h.fetch("/api/admin/advisor");
    expect(res.status).toBe(401);
  });

  test("non-admin GET /api/admin/advisor → 403", async () => {
    // A fresh sign-up lands as `authenticated`, not admin.
    const su = await signUp(h, `user-${Date.now()}@example.test`);
    expect(su.status).toBe(200);
    const res = await h.fetch("/api/admin/advisor");
    expect(res.status).toBe(403);
  });
});

describe("advisor: public-read permission produces a finding", () => {
  let h: TestHarness;
  const slug = `posts_${Date.now()}_advisor`;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);

    const create = await h.fetch("/api/collections", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        slug,
        ownerScoped: false,
        fields: [{ name: "title", type: "text" }],
      }),
    });
    expect(create.status).toBe(201);

    // Grant the `public` role an unconditional read on this collection via
    // the SQL console — the advisor should flag it.
    const roleRes = await h.fetch("/api/admin/db/sql/run?writes=1", {
      method: "POST",
      headers: { ...JSON_HEADERS, "x-workeros-confirm": "yes" },
      body: JSON.stringify({
        sql: `INSERT INTO permissions (id, role_id, collection, action, fields, condition, created_at) SELECT '${crypto.randomUUID()}', id, '${slug}', 'read', NULL, NULL, ${Date.now()} FROM roles WHERE name = 'public'`,
      }),
    });
    expect(roleRes.status).toBe(200);
  });

  afterAll(() => {
    h.cleanup();
  });

  test("a public read with no condition surfaces a security error finding", async () => {
    const res = await h.fetch("/api/admin/advisor");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: AdvisorCheck[] };
    const finding = body.data.find(
      (c) => c.kind === "security" && c.resource.includes(slug),
    );
    expect(finding).toBeDefined();
    expect(finding?.level).toBe("error");
    expect(finding?.id).toContain(slug);
  });
});
