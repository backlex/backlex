/**
 * Regression: the GraphQL read path must honour the `permissions.fields` read
 * allow-list, exactly like REST's `projectFields`. Before the fix `renderRow`
 * was always called with the full field list, so a role with `read` scoped to
 * `fields: ["title"]` could still select `secret` over GraphQL and get the
 * value back — an intra-tenant field-level disclosure.
 */
import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const JSON_HEADERS = { "Content-Type": "application/json" };
const PASSWORD = "correct-horse-battery";

describe("GraphQL honours the read field allow-list", () => {
  let h: TestHarness;
  let adminEmail: string;
  const slug = "gqlfieldacl"; // GraphQL list field = camel(slug) = "gqlfieldacl"

  const gql = async (query: string) =>
    (await (
      await h.fetch("/api/graphql", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ query }),
      })
    ).json()) as {
      data?: Record<string, any>;
      errors?: { message: string; extensions?: { code?: string } }[];
    };

  beforeAll(async () => {
    h = makeHarness();
    const adm = await seedAdmin(h);
    adminEmail = adm.email;

    const create = await h.fetch("/api/collections", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        slug,
        tenantScoped: true,
        ownerScoped: false,
        fields: [
          { name: "title", type: "text", required: true },
          { name: "secret", type: "text" },
        ],
      }),
    });
    expect(create.status).toBe(201);

    // Grant `authenticated` read, but ONLY the `title` field — `secret` is
    // explicitly outside the allow-list.
    const roles = (
      (await (await h.fetch("/api/roles")).json()) as { data: { id: string; name: string }[] }
    ).data;
    const authRole = roles.find((r) => r.name === "authenticated")!;
    const grant = await h.fetch(`/api/roles/${authRole.id}/permissions`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        collection: slug,
        action: "read",
        condition: null,
        fields: ["title"],
      }),
    });
    expect(grant.status).toBeLessThan(300);

    // Admin (bypass) seeds one row carrying a real secret value.
    const ins = await h.fetch(`/api/items/${slug}`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ title: "visible", secret: "top-secret-value" }),
    });
    expect(ins.status).toBe(201);
  });

  afterAll(() => {
    h.cleanup();
    void adminEmail;
  });

  test("a field-restricted role gets title but NOT secret", async () => {
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

    const res = await gql(`query { ${slug} { id title secret } }`);
    expect(res.errors).toBeUndefined();
    const rows = res.data?.[slug] as { title: string; secret: string | null }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe("visible");
    // The fix: `secret` is outside the read allow-list → never returned.
    expect(rows[0]!.secret).toBeNull();
  });
});
