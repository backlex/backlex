/**
 * A template may give the built-in `authenticated` role READ grants — on the
 * collections its own apply created, and nowhere else (#376).
 *
 * `examples/ecommerce-react` is a storefront for a signed-in end-user, and the
 * E-commerce template gave that identity nothing about the catalog: the grid
 * said "No read permission for products". A template could not fix that,
 * because `seedRoles` skips every role name the workspace already has — so an
 * entry named `authenticated` vanished without a word.
 *
 * Every block asserts both directions. The shopper can read the catalog AND
 * still cannot read an order; a re-apply adds nothing AND a fresh apply adds
 * everything; a condition naming no column is refused AND a real one applies.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { TEMPLATES } from "../../src/server/templates/catalog";
import { isPresentational } from "@backlex/db";
import { makeHarness, seedAdmin, type TestHarness } from "../setup";

const J = { "content-type": "application/json" };
const APPLY_TIMEOUT_MS = 120_000;

interface Grant {
  role: string;
  collection: string;
  action: string;
  reason?: string;
}
/** A grant as GraphQL returns it: only the selected fields, and a nullable
 *  `reason` (null on a grant that was added). */
interface GqlGrant {
  role?: string;
  collection: string;
  action?: string;
  reason: string | null;
}
interface ApplyResult {
  created: string[];
  skipped: string[];
  roles: string[];
  builtInGrants: Grant[];
  builtInGrantsSkipped: Grant[];
}
interface PermRow {
  id: string;
  collection: string;
  action: string;
  fields: string[] | null;
  condition: unknown;
}

const post = (h: TestHarness, path: string, body: unknown, headers: Record<string, string> = {}) =>
  h.fetch(path, { method: "POST", headers: { ...J, ...headers }, body: JSON.stringify(body) });

const applyTemplate = async (h: TestHarness, body: unknown) => {
  const res = await post(h, "/api/admin/templates/apply", body);
  const json = (await res.json()) as { data?: ApplyResult; error?: { message?: string } };
  return { status: res.status, data: json.data as ApplyResult, message: json.error?.message ?? "" };
};

/** The `authenticated` role's grants, read the way an admin reads them. */
const authenticatedGrants = async (h: TestHarness): Promise<PermRow[]> => {
  const roles = (await (await h.fetch("/api/roles")).json()) as { data: { id: string; name: string }[] };
  const id = roles.data.find((r) => r.name === "authenticated")!.id;
  return ((await (await h.fetch(`/api/roles/${id}/permissions`)).json()) as { data: PermRow[] }).data;
};

/** A fresh app-plane sign-up of the default workspace — it holds exactly
 *  `authenticated`, which is the identity the storefront example uses. */
const signUpShopper = async (h: TestHarness) => {
  const res = await post(h, "/api/t/default/auth/sign-up/email", {
    email: `shopper-${crypto.randomUUID()}@example.test`,
    password: "shopper-pass-123",
    name: "Shopper",
  });
  expect(res.status).toBe(200);
  const token = ((await res.json()) as { token?: string }).token!;
  expect(token).toBeTruthy();
  return (path: string, init: RequestInit = {}) =>
    Promise.resolve(
      h.app.request(path, {
        ...init,
        headers: { ...J, ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
      }),
    );
};

const rowsOf = async (res: Response) => ((await res.json()) as { data: Record<string, unknown>[] }).data;

// ---------------------------------------------------------------------------

describe("the E-commerce storefront, as a signed-in shopper", () => {
  let h: TestHarness;
  let applied: ApplyResult;
  let shopper: Awaited<ReturnType<typeof signUpShopper>>;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const out = await applyTemplate(h, { templateId: "ecommerce" });
    expect(out.status).toBe(201);
    applied = out.data;
    shopper = await signUpShopper(h);
    // A full commerce apply plus a password hash — past bun's 5 s default on a
    // loaded machine, which reads as a failure of the code when it is not.
  }, APPLY_TIMEOUT_MS);
  afterAll(() => h.cleanup());

  test("lists the catalog: products and categories", async () => {
    const products = await shopper("/api/items/products?locale=en");
    expect(products.status).toBe(200);
    const names = (await rowsOf(products)).map((p) => p.name);
    expect(names).toContain("Classic Tee");
    expect(names).toContain("Canvas Tote");

    const categories = await shopper("/api/items/categories?locale=en");
    expect(categories.status).toBe(200);
    expect((await rowsOf(categories)).map((c) => c.name)).toContain("Apparel");
  });

  test("a product that is not active is not for sale, even once published", async () => {
    // `status` is the product's own switch, separate from `_status`. Publishing
    // it puts it past the draft filter — only the grant's condition stops it.
    const made = await post(h, "/api/items/products?locale=en", {
      name: "Unreleased Jacket",
      status: "draft",
      price: 90,
      currency: "USD",
    });
    expect(made.status).toBe(201);
    const id = ((await made.json()) as { data: { id: string } }).data.id;
    expect((await post(h, `/api/items/products/${id}/publish`, {})).status).toBe(200);

    const admin = await rowsOf(await h.fetch("/api/items/products?locale=en&limit=100"));
    expect(admin.map((p) => p.id)).toContain(id);
    const seen = await rowsOf(await shopper("/api/items/products?locale=en&limit=100"));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.map((p) => p.id)).not.toContain(id);
    expect((await shopper(`/api/items/products/${id}`)).status).toBe(404);
  });

  test("a variant comes back without its cost — on every read path", async () => {
    const adminRows = await rowsOf(await h.fetch("/api/items/product_variants"));
    // The positive control: the column is there, holding a real value.
    expect(adminRows.some((v) => v.cost != null)).toBe(true);

    const list = await shopper("/api/items/product_variants");
    expect(list.status).toBe(200);
    const rows = await rowsOf(list);
    expect(rows.length).toBe(adminRows.length);
    for (const v of rows) {
      expect(v).not.toHaveProperty("cost");
      expect(v).toHaveProperty("price");
    }

    const one = await shopper(`/api/items/product_variants/${rows[0]!.id}`);
    expect(one.status).toBe(200);
    expect(((await one.json()) as { data: Record<string, unknown> }).data).not.toHaveProperty("cost");

    // Asking for it by name, filtering on it, or totalling it are each an
    // oracle for the value, and each is refused.
    expect((await shopper("/api/items/product_variants?fields=cost")).status).toBe(403);
    expect((await shopper("/api/items/product_variants?fields=sku")).status).toBe(200);
    const filter = (cond: unknown) =>
      shopper(`/api/items/product_variants?filter=${encodeURIComponent(JSON.stringify(cond))}`);
    expect((await filter({ cost: { _gt: 0 } })).status).toBe(422);
    expect((await filter({ sku: { _nempty: true } })).status).toBe(200);
    const sum = (field: string) =>
      shopper("/api/items/product_variants/aggregate", {
        method: "POST",
        body: JSON.stringify({ agg: "sum", field, groupBy: "currency" }),
      });
    expect((await sum("cost")).status).toBe(403);
    // The same call over a column the shopper may read works — so the refusal
    // above is the allow-list, not a route that answers nothing.
    expect((await sum("price")).status).toBe(200);

    // And through a relation from a table the shopper CAN read.
    const choice = (await rowsOf(await h.fetch("/api/items/modifier_values")))[0]!;
    const patched = await h.fetch(`/api/items/modifier_values/${choice.id}`, {
      method: "PATCH",
      headers: J,
      body: JSON.stringify({ component_variant: rows[0]!.id }),
    });
    expect(patched.status).toBe(200);
    const expanded = await shopper(`/api/items/modifier_values/${choice.id}?expand=component_variant`);
    expect(expanded.status).toBe(200);
    const inlined = ((await expanded.json()) as { data: { component_variant: Record<string, unknown> } }).data
      .component_variant;
    expect(inlined).toHaveProperty("sku");
    expect(inlined).not.toHaveProperty("cost");
  });

  test("orders, customers and price lists stay refused, and nothing is writable", async () => {
    for (const slug of ["orders", "order_items", "customers", "addresses", "carts", "discounts", "gift_cards", "price_lists", "prices"]) {
      expect((await shopper(`/api/items/${slug}`)).status, slug).toBe(403);
    }
    const write = await shopper("/api/items/products", {
      method: "POST",
      body: JSON.stringify({ name: "Mine now", price: 1, currency: "USD" }),
    });
    expect(write.status).toBe(403);
  });

  test("the result names every grant it added, and only on the built-in role", async () => {
    expect(applied.roles).toEqual(["Store staff"]);
    expect(applied.builtInGrantsSkipped).toEqual([]);
    const tpl = TEMPLATES.find((t) => t.id === "ecommerce")!;
    const declared = tpl.roles!.find((r) => r.name === "authenticated")!.permissions;
    expect(applied.builtInGrants).toHaveLength(declared.length);
    for (const g of applied.builtInGrants) expect([g.role, g.action]).toEqual(["authenticated", "read"]);
    // What landed is what the template said, conditions and allow-lists included.
    const held = await authenticatedGrants(h);
    const products = held.filter((p) => p.collection === "products" && p.action === "read");
    expect(products).toHaveLength(1);
    expect(products[0]!.condition).toEqual({ status: { _eq: "active" } });
    expect(held.find((p) => p.collection === "product_variants")?.fields).not.toContain("cost");
  });
});

// ---------------------------------------------------------------------------

describe("an apply never widens access on a collection it did not create", () => {
  test("a workspace that already had `products` gets no grant on it", async () => {
    const h = makeHarness();
    try {
      await seedAdmin(h);
      expect(
        (await post(h, "/api/collections", { slug: "products", fields: [{ name: "name", type: "text" }] })).status,
      ).toBe(201);
      expect((await post(h, "/api/items/products", { name: "Private prototype" })).status).toBe(201);

      const out = await applyTemplate(h, { templateId: "ecommerce" });
      expect(out.status).toBe(201);
      expect(out.data.skipped).toContain("products");
      expect(out.data.builtInGrantsSkipped).toContainEqual({
        role: "authenticated",
        collection: "products",
        action: "read",
        reason: "collection-existed",
      });
      expect(out.data.builtInGrants.map((g) => g.collection)).not.toContain("products");
      expect(out.data.builtInGrants.map((g) => g.collection)).toContain("categories");

      expect((await authenticatedGrants(h)).some((p) => p.collection === "products")).toBe(false);
      const shopper = await signUpShopper(h);
      expect((await shopper("/api/items/products")).status).toBe(403);
      expect((await shopper("/api/items/categories")).status).toBe(200);
    } finally {
      h.cleanup();
    }
  }, APPLY_TIMEOUT_MS);

  test("re-applying the same template adds nothing and duplicates nothing", async () => {
    const h = makeHarness();
    try {
      await seedAdmin(h);
      const first = await applyTemplate(h, { templateId: "ecommerce" });
      expect(first.data.builtInGrants.length).toBeGreaterThan(0);
      const before = (await authenticatedGrants(h)).length;

      const again = await applyTemplate(h, { templateId: "ecommerce" });
      expect(again.status).toBe(201);
      expect(again.data.builtInGrants).toEqual([]);
      expect(again.data.builtInGrantsSkipped).toHaveLength(first.data.builtInGrants.length);
      expect(new Set(again.data.builtInGrantsSkipped.map((g) => g.reason))).toEqual(new Set(["collection-existed"]));
      expect((await authenticatedGrants(h)).length).toBe(before);
    } finally {
      h.cleanup();
    }
  }, APPLY_TIMEOUT_MS);

  test("a grant whose condition reaches into a collection the workspace already had is skipped", async () => {
    // The condition was checked against the TEMPLATE's `authors`, and the one on
    // disk is somebody else's — so the created-list rule covers every hop.
    const h = makeHarness();
    try {
      await seedAdmin(h);
      expect(
        (await post(h, "/api/collections", { slug: "authors", fields: [{ name: "handle", type: "text" }] })).status,
      ).toBe(201);
      const out = await applyTemplate(h, {
        template: {
          collections: [
            { slug: "authors", fields: [{ name: "handle", type: "text" }, { name: "verified", type: "boolean" }] },
            { slug: "posts", fields: [{ name: "title", type: "text" }, { name: "author", type: "relation", to: "authors" }] },
          ],
          roles: [
            {
              name: "authenticated",
              permissions: [{ collection: "posts", action: "read", condition: { "author.verified": { _eq: true } } }],
            },
          ],
        },
      });
      expect(out.status).toBe(201);
      expect(out.data.created).toEqual(["posts"]);
      expect(out.data.builtInGrants).toEqual([]);
      expect(out.data.builtInGrantsSkipped).toEqual([
        { role: "authenticated", collection: "posts", action: "read", reason: "collection-existed" },
      ]);
    } finally {
      h.cleanup();
    }
  }, APPLY_TIMEOUT_MS);

  test("a collection dropped and re-created keeps one grant, not two", async () => {
    // Dropping a collection leaves its permission rows behind; the next apply
    // that re-creates it must recognise the grant it already made.
    const h = makeHarness();
    try {
      await seedAdmin(h);
      const template = {
        collections: [{ slug: "notices", fields: [{ name: "body", type: "text" }] }],
        roles: [{ name: "authenticated", permissions: [{ collection: "notices", action: "read", fields: ["body"] }] }],
      };
      expect((await applyTemplate(h, { template })).data.builtInGrants).toHaveLength(1);
      expect((await h.fetch("/api/collections/notices", { method: "DELETE" })).status).toBe(200);

      const again = await applyTemplate(h, { template });
      expect(again.data.created).toEqual(["notices"]);
      expect(again.data.builtInGrants).toEqual([]);
      expect(again.data.builtInGrantsSkipped).toEqual([
        { role: "authenticated", collection: "notices", action: "read", reason: "already-granted" },
      ]);
      expect((await authenticatedGrants(h)).filter((p) => p.collection === "notices")).toHaveLength(1);
    } finally {
      h.cleanup();
    }
  }, APPLY_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------

describe("what a built-in role entry may ask for", () => {
  let h: TestHarness;
  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  const collection = {
    slug: "guides",
    versioned: true,
    fields: [
      { name: "title", type: "text", localized: true },
      { name: "state", type: "text" },
      { name: "topic", type: "relation", to: "topics" },
    ],
  };
  const topics = {
    slug: "topics",
    fields: [
      { name: "label", type: "text" },
      { name: "pinned", type: "relation", to: "guides" },
    ],
  };
  const withGrant = (role: Record<string, unknown>) => ({
    template: { collections: [topics, collection], roles: [role] },
  });

  const refused: [string, Record<string, unknown>, string][] = [
    ["a write", { name: "authenticated", permissions: [{ collection: "guides", action: "create" }] }, "`read`"],
    ["the anonymous role", { name: "public", permissions: [{ collection: "guides", action: "read" }] }, "anonymous"],
    ["the admin role", { name: "admin", permissions: [] }, "admin role"],
    ["a new description", { name: "authenticated", description: "Shoppers", permissions: [] }, "description"],
    [
      "a collection the template does not create",
      { name: "authenticated", permissions: [{ collection: "orders", action: "read" }] },
      "not a collection this template creates",
    ],
    [
      "a condition naming no column",
      { name: "authenticated", permissions: [{ collection: "guides", action: "read", condition: { stat: { _neq: "draft" } } }] },
      'names no column of "guides"',
    ],
    [
      "a hop through a field that is not a relation",
      { name: "authenticated", permissions: [{ collection: "guides", action: "read", condition: { "state.label": { _eq: "x" } } }] },
      "is not a relation",
    ],
    [
      // The hop lowers to a subquery over the base table, where a localized
      // column does not live.
      "a localized column past a hop",
      { name: "authenticated", permissions: [{ collection: "topics", action: "read", condition: { "pinned.title": { _eq: "x" } } }] },
      'names no column of "guides"',
    ],
    [
      "a condition that compares nothing",
      { name: "authenticated", permissions: [{ collection: "guides", action: "read", condition: { $and: [] } }] },
      "must compare a column",
    ],
    [
      "an unknown operator",
      { name: "authenticated", permissions: [{ collection: "guides", action: "read", condition: { state: { _equals: "live" } } }] },
      "_equals",
    ],
    [
      "a nested object instead of a dotted path",
      { name: "authenticated", permissions: [{ collection: "guides", action: "read", condition: { topic: { label: { _eq: "x" } } } }] },
      "not a comparison",
    ],
    [
      "an allow-list naming a field that does not exist",
      { name: "authenticated", permissions: [{ collection: "guides", action: "read", fields: ["title", "secret"] }] },
      '"secret"',
    ],
  ];

  for (const [what, role, says] of refused) {
    test(`refuses ${what}, before anything is written`, async () => {
      const out = await applyTemplate(h, withGrant(role));
      expect(out.status).toBe(422);
      expect(out.message).toContain(says);
      const slugs = ((await (await h.fetch("/api/collections")).json()) as { data: { slug: string }[] }).data.map(
        (c) => c.slug,
      );
      expect(slugs).not.toContain("guides");
    });
  }

  test("accepts a read with a real condition, a versioned column and an allow-list — and a hop", async () => {
    const out = await applyTemplate(
      h,
      withGrant({
        name: "authenticated",
        permissions: [
          { collection: "guides", action: "read", fields: ["title", "state"], condition: { $and: [{ state: { _eq: "live" } }, { _status: { _eq: "published" } }] } },
          { collection: "topics", action: "read", condition: { "pinned.state": { _eq: "live" } } },
        ],
      }),
    );
    expect(out.status).toBe(201);
    expect(out.data.builtInGrants.map((g) => g.collection).sort()).toEqual(["guides", "topics"]);
  });

  test("GraphQL reports the same grants, with the reason on a skipped one", async () => {
    const template = {
      collections: [{ slug: "faqs", fields: [{ name: "q", type: "text" }] }],
      roles: [{ name: "authenticated", permissions: [{ collection: "faqs", action: "read" }] }],
    };
    const gql = async () =>
      (await (
        await post(h, "/api/graphql", {
          query: `mutation($tpl:String!){ applyCustomTemplate(template:$tpl){ builtInGrants { role collection action reason } builtInGrantsSkipped { collection reason } } }`,
          variables: { tpl: JSON.stringify(template) },
        })
      ).json()) as { data?: { applyCustomTemplate: { builtInGrants: GqlGrant[]; builtInGrantsSkipped: GqlGrant[] } }; errors?: unknown };
    const first = await gql();
    expect(first.errors).toBeUndefined();
    expect(first.data?.applyCustomTemplate.builtInGrants).toEqual([
      { role: "authenticated", collection: "faqs", action: "read", reason: null },
    ]);
    const again = await gql();
    expect(again.data?.applyCustomTemplate.builtInGrantsSkipped).toEqual([
      { collection: "faqs", reason: "collection-existed" },
    ]);
  });
});

// ---------------------------------------------------------------------------

describe("extract carries a built-in role's reads, and names what it cannot", () => {
  interface Extracted {
    roles?: { name: string; permissions: { collection: string; action: string; condition?: unknown; fields?: string[] }[] }[];
    omissions?: { resource: string; what: string; reason: string }[];
  }

  let h: TestHarness;
  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    for (const c of [
      { slug: "articles", fields: [{ name: "title", type: "text" }, { name: "state", type: "text" }] },
      // Owner-scoped: the engine seeds `authenticated` its default grants, which
      // must NOT travel as template grants — they come back with the collection.
      { slug: "drafts", ownerScoped: true, fields: [{ name: "body", type: "text" }] },
      { slug: "internal", fields: [{ name: "note", type: "text" }] },
    ]) {
      expect((await post(h, "/api/collections", c)).status).toBe(201);
    }
    const roles = (await (await h.fetch("/api/roles")).json()) as { data: { id: string; name: string }[] };
    const id = (name: string) => roles.data.find((r) => r.name === name)!.id;
    for (const [role, grant] of [
      ["authenticated", { collection: "articles", action: "read", fields: ["title"], condition: { state: { _eq: "live" } } }],
      ["authenticated", { collection: "internal", action: "read" }],
      ["public", { collection: "articles", action: "read" }],
    ] as const) {
      expect((await post(h, `/api/roles/${id(role)}/permissions`, grant)).status).toBe(201);
    }
  });
  afterAll(() => h.cleanup());

  const extract = async (query = ""): Promise<Extracted> =>
    ((await (await h.fetch(`/api/admin/templates/extract${query}`)).json()) as { data: Extracted }).data;

  test("the reads travel as an `authenticated` entry; the owner-scoped defaults do not", async () => {
    const t = await extract();
    const entry = t.roles?.find((r) => r.name === "authenticated");
    expect(entry?.permissions.map((p) => p.collection).sort()).toEqual(["articles", "internal"]);
    expect(entry?.permissions.find((p) => p.collection === "articles")).toEqual({
      collection: "articles",
      action: "read",
      fields: ["title"],
      condition: { state: { _eq: "live" } },
    });
    expect(entry?.permissions.some((p) => p.collection === "drafts")).toBe(false);
    // The anonymous role never travels, and says so.
    expect(t.roles?.some((r) => r.name === "public")).toBe(false);
    expect(t.omissions?.some((o) => o.resource === "role:public" && o.what.includes("articles"))).toBe(true);
  });

  test("a read on a collection the export leaves behind is named", async () => {
    const t = await extract("?collections=articles");
    expect(t.roles?.find((r) => r.name === "authenticated")?.permissions.map((p) => p.collection)).toEqual([
      "articles",
    ]);
    expect(t.omissions?.some((o) => o.resource === "role:authenticated" && o.what.includes("internal"))).toBe(true);
  });

  test("the round trip grants the read in the target workspace", async () => {
    const doc = await extract();
    const target = ((await (await post(h, "/api/tenants", { name: "Target" })).json()) as { data: { id: string } }).data;
    const as = { "x-backlex-tenant": target.id };
    const out = await post(h, "/api/admin/templates/apply", { template: { ...doc, label: "Round trip" } }, as);
    expect(out.status).toBe(201);
    const data = ((await out.json()) as { data: ApplyResult }).data;
    expect(data.builtInGrants.map((g) => g.collection).sort()).toEqual(["articles", "internal"]);

    const roles = (await (await h.fetch("/api/roles", { headers: as })).json()) as { data: { id: string; name: string }[] };
    const id = roles.data.find((r) => r.name === "authenticated")!.id;
    const grants = ((await (await h.fetch(`/api/roles/${id}/permissions`, { headers: as })).json()) as { data: PermRow[] })
      .data;
    expect(grants.find((g) => g.collection === "articles" && g.action === "read")?.condition).toEqual({
      state: { _eq: "live" },
    });
    // The owner-scoped defaults are there because the collection is, once each.
    expect(grants.filter((g) => g.collection === "drafts" && g.action === "read")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------

describe("the E-commerce variant allow-list is a decision, not a default", () => {
  test("every variant column is either shown to shoppers or deliberately held back", () => {
    // An allow-list, so a new column is hidden until somebody decides. This is
    // the somebody: adding a field to `product_variants` fails here until it is
    // placed on one side.
    const HELD_BACK = new Set(["cost", "map_price", "listing_status", "listing_id", "listed_at", "listing_error"]);
    const tpl = TEMPLATES.find((t) => t.id === "ecommerce")!;
    const variants = tpl.collections.find((c) => c.slug === "product_variants")!;
    const columns = variants.fields.filter((f) => !isPresentational(f)).map((f) => f.name);
    const shown = tpl.roles!
      .find((r) => r.name === "authenticated")!
      .permissions.find((p) => p.collection === "product_variants")!.fields!;
    expect([...shown, ...HELD_BACK].sort()).toEqual([...columns].sort());
    expect(shown.some((f) => HELD_BACK.has(f))).toBe(false);
  });
});
