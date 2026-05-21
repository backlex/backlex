/**
 * Advisor endpoint smoke tests.
 *
 * Covers the admin gate (200 for admin, 401 anonymous, 403 non-admin) and the
 * response shape (`data` + `score` + `generatedAt`, every finding carrying
 * `rule` + `groupTitle`), plus real-finding assertions: a public-read and a
 * public-write permission must each surface a `security` finding, and a
 * finding raised under one tenant's `public` role must not leak to another.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const JSON_HEADERS = { "Content-Type": "application/json" };

interface AdvisorCheck {
  id: string;
  kind: "security" | "performance";
  level: "error" | "warn" | "info";
  rule: string;
  groupTitle: string;
  title: string;
  body: string;
  fix: string;
  resource: string;
  link?: string;
}

interface AdvisorResult {
  data: AdvisorCheck[];
  score: number;
  generatedAt: string;
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

  test("admin GET /api/admin/advisor → 200 with { data, score, generatedAt }", async () => {
    const res = await h.fetch("/api/admin/advisor");
    expect(res.status).toBe(200);
    const body = (await res.json()) as AdvisorResult;
    expect(Array.isArray(body.data)).toBe(true);
    expect(typeof body.score).toBe("number");
    expect(body.score).toBeGreaterThanOrEqual(0);
    expect(body.score).toBeLessThanOrEqual(100);
    expect(typeof body.generatedAt).toBe("string");
    expect(Number.isFinite(new Date(body.generatedAt).getTime())).toBe(true);
    for (const c of body.data) {
      expect(typeof c.id).toBe("string");
      expect(["security", "performance"]).toContain(c.kind);
      expect(["error", "warn", "info"]).toContain(c.level);
      expect(typeof c.rule).toBe("string");
      expect(c.rule.length).toBeGreaterThan(0);
      expect(typeof c.groupTitle).toBe("string");
      expect(c.groupTitle.length).toBeGreaterThan(0);
      expect(typeof c.title).toBe("string");
      expect(typeof c.fix).toBe("string");
      expect(typeof c.resource).toBe("string");
      // `detected` has been removed — it must not reappear.
      expect("detected" in c).toBe(false);
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
    const body = (await res.json()) as AdvisorResult;
    const finding = body.data.find(
      (c) => c.kind === "security" && c.rule === "public-read" && c.resource.includes(slug),
    );
    expect(finding).toBeDefined();
    expect(finding?.level).toBe("error");
    expect(finding?.id).toContain(slug);
    expect(finding?.groupTitle).toBe("Public reads with no condition");
    expect(finding?.link).toBe(`/collections/${slug}`);
  });
});

describe("advisor: public-write permission produces an error finding", () => {
  let h: TestHarness;
  const slug = `wcoll_${Date.now()}_advisor`;

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

    // Grant the `public` role a `create` permission — anonymous writes.
    const roleRes = await h.fetch("/api/admin/db/sql/run?writes=1", {
      method: "POST",
      headers: { ...JSON_HEADERS, "x-workeros-confirm": "yes" },
      body: JSON.stringify({
        sql: `INSERT INTO permissions (id, role_id, collection, action, fields, condition, created_at) SELECT '${crypto.randomUUID()}', id, '${slug}', 'create', NULL, NULL, ${Date.now()} FROM roles WHERE name = 'public'`,
      }),
    });
    expect(roleRes.status).toBe(200);
  });

  afterAll(() => {
    h.cleanup();
  });

  test("a public create permission surfaces a security error finding", async () => {
    const res = await h.fetch("/api/admin/advisor");
    expect(res.status).toBe(200);
    const body = (await res.json()) as AdvisorResult;
    const finding = body.data.find(
      (c) => c.rule === "public-write" && c.resource.includes(slug),
    );
    expect(finding).toBeDefined();
    expect(finding?.kind).toBe("security");
    expect(finding?.level).toBe("error");
    expect(finding?.groupTitle).toBe("Public write permissions");
  });
});

describe("advisor: findings are tenant-scoped", () => {
  let h: TestHarness;
  const slug = `tcoll_${Date.now()}_advisor`;
  const otherTenant = `tenant-other-${Date.now()}`;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);

    const runSql = async (statement: string) => {
      const res = await h.fetch("/api/admin/db/sql/run?writes=1", {
        method: "POST",
        headers: { ...JSON_HEADERS, "x-workeros-confirm": "yes" },
        body: JSON.stringify({ sql: statement }),
      });
      expect(res.status).toBe(200);
    };

    // Create a collection in the default tenant and flag it with a public
    // read (a security finding for the default tenant).
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
    await runSql(
      `INSERT INTO permissions (id, role_id, collection, action, fields, condition, created_at) SELECT '${crypto.randomUUID()}', id, '${slug}', 'read', NULL, NULL, ${Date.now()} FROM roles WHERE name = 'public'`,
    );

    // Seed a *second* tenant with its own `public` role that ALSO has an
    // unconditional read permission. The advisor for the default tenant must
    // not surface that other tenant's permission row — `roles.tenantId`
    // scoping is what prevents the leak.
    const otherRoleId = crypto.randomUUID();
    const ts = Date.now();
    await runSql(
      `INSERT INTO tenants (id, name, slug, created_at, updated_at) VALUES ('${otherTenant}', 'Other', 'other-${ts}', ${ts}, ${ts})`,
    );
    await runSql(
      `INSERT INTO roles (id, tenant_id, name, description, created_at, updated_at) VALUES ('${otherRoleId}', '${otherTenant}', 'public', 'Anonymous', ${ts}, ${ts})`,
    );
    await runSql(
      `INSERT INTO permissions (id, role_id, collection, action, fields, condition, created_at) VALUES ('${crypto.randomUUID()}', '${otherRoleId}', 'leaky_other_tenant_collection', 'read', NULL, NULL, ${Date.now()})`,
    );
  });

  afterAll(() => {
    h.cleanup();
  });

  test("the default tenant's advisor does not surface the other tenant's public-read finding", async () => {
    const res = await h.fetch("/api/admin/advisor");
    expect(res.status).toBe(200);
    const body = (await res.json()) as AdvisorResult;

    // The default tenant's own finding is present.
    const own = body.data.find(
      (c) => c.rule === "public-read" && c.resource.includes(slug),
    );
    expect(own).toBeDefined();

    // The other tenant's finding must NOT appear.
    const leaked = body.data.find((c) =>
      c.resource.includes("leaky_other_tenant_collection"),
    );
    expect(leaked).toBeUndefined();
  });
});
