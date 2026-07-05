import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

/**
 * Template ⇄ collection-grouping integration + the professional-bar features
 * layered on top of apply: admin groups (rows + `collectionGroups` header
 * merge), inline FTS backfill for seeded samples, bundled roles/dashboards,
 * the seed manifest ("remove sample data"), and extract → apply-custom
 * round-trips. Fresh workspace per describe so counts stay deterministic.
 */
const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("template apply seeds admin groups", () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const res = await h.fetch("/api/admin/templates/apply", json({ templateId: "blog" }));
    expect(res.status).toBe(201);
  });
  afterAll(() => h.cleanup());

  test("collections land under the template's groups with stable positions", async () => {
    const res = await h.fetch("/api/collections");
    const { data, meta } = (await res.json()) as {
      data: { slug: string; group: string | null; sortOrder: number | null }[];
      meta: { groups: string[] };
    };
    const bySlug = new Map(data.map((c) => [c.slug, c]));
    expect(bySlug.get("posts")?.group).toBe("Content");
    expect(bySlug.get("pages")?.group).toBe("Content");
    expect(bySlug.get("categories")?.group).toBe("Taxonomy");
    expect(bySlug.get("tags")?.group).toBe("Taxonomy");
    expect(bySlug.get("authors")?.group).toBe("People");
    // Positions follow template order within the group (10, 20, …).
    expect(bySlug.get("media")?.sortOrder).toBe(10);
    expect(bySlug.get("posts")?.sortOrder).toBe(20);
    expect(bySlug.get("pages")?.sortOrder).toBe(30);
    // Header order merged into collectionGroups in template order.
    expect(meta.groups).toEqual(["Content", "Taxonomy", "People"]);
  });

  test("re-apply never overwrites the admin's layout edits", async () => {
    // Admin moves a collection and deletes a template header…
    const patch = await h.fetch("/api/collections/posts", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ group: "Mine", sortOrder: 5 }),
    });
    expect(patch.status).toBe(200);
    const layout = await h.fetch(
      "/api/collections/layout",
      json({
        groups: ["Content", "People", "Mine"], // Taxonomy header deleted
        items: [
          { slug: "categories", group: null, sortOrder: null },
          { slug: "tags", group: null, sortOrder: null },
        ],
      }),
    );
    expect(layout.status).toBe(200);

    // …then a full re-apply (everything skipped) must change nothing.
    const again = await h.fetch("/api/admin/templates/apply", json({ templateId: "blog" }));
    const { data } = (await again.json()) as { data: { created: string[] } };
    expect(data.created).toHaveLength(0);

    const res = await h.fetch("/api/collections");
    const { data: rows, meta } = (await res.json()) as {
      data: { slug: string; group: string | null }[];
      meta: { groups: string[] };
    };
    expect(rows.find((c) => c.slug === "posts")?.group).toBe("Mine");
    expect(rows.find((c) => c.slug === "categories")?.group).toBeNull();
    expect(meta.groups).toEqual(["Content", "People", "Mine"]); // no Taxonomy resurrection
  });

  test("seeded samples are immediately full-text searchable", async () => {
    // posts has fts + searchable title/excerpt/body; "walkthrough" only
    // appears in the second sample's body. Without the inline backfill this
    // required a manual /fts-reindex first.
    const res = await h.fetch("/api/items/posts?q=walkthrough");
    const { data } = (await res.json()) as { data: { title: string }[] };
    expect(data.map((p) => p.title)).toContain("Shipping the v1");
  });
});

describe("template bundles: roles + dashboards", () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  test("blog seeds the Editor role with grants and the Content overview dashboard", async () => {
    const apply = await h.fetch("/api/admin/templates/apply", json({ templateId: "blog" }));
    expect(apply.status).toBe(201);
    const { data } = (await apply.json()) as {
      data: { roles: string[]; dashboards: string[] };
    };
    expect(data.roles).toEqual(["Editor"]);
    expect(data.dashboards).toEqual(["Content overview"]);

    const rolesRes = await h.fetch("/api/roles");
    const roles = (await rolesRes.json()) as { data: { id: string; name: string }[] };
    const editor = roles.data.find((r) => r.name === "Editor");
    expect(editor).toBeDefined();
    const permsRes = await h.fetch(`/api/roles/${editor!.id}/permissions`);
    const perms = (await permsRes.json()) as {
      data: { collection: string; action: string }[];
    };
    expect(perms.data.some((p) => p.collection === "posts" && p.action === "publish")).toBe(true);
    expect(perms.data.some((p) => p.collection === "media" && p.action === "create")).toBe(true);

    const dashRes = await h.fetch("/api/admin/dashboards");
    const dashboards = (await dashRes.json()) as { data: { id: string; name: string }[] };
    const overview = dashboards.data.find((d) => d.name === "Content overview");
    expect(overview).toBeDefined();
    const panelsRes = await h.fetch(`/api/admin/panels?dashboardId=${overview!.id}`);
    const panels = (await panelsRes.json()) as {
      data: { name: string; kind: string; viz: string }[];
    };
    expect(panels.data).toHaveLength(3);
    expect(panels.data.every((p) => p.kind === "items-aggregate")).toBe(true);
  });

  test("re-apply skips existing bundles (no duplicates)", async () => {
    const again = await h.fetch("/api/admin/templates/apply", json({ templateId: "blog" }));
    const { data } = (await again.json()) as {
      data: { roles: string[]; dashboards: string[] };
    };
    expect(data.roles).toHaveLength(0);
    expect(data.dashboards).toHaveLength(0);

    const rolesRes = await h.fetch("/api/roles");
    const roles = (await rolesRes.json()) as { data: { name: string }[] };
    expect(roles.data.filter((r) => r.name === "Editor")).toHaveLength(1);
    const dashRes = await h.fetch("/api/admin/dashboards");
    const dashboards = (await dashRes.json()) as { data: { name: string }[] };
    expect(dashboards.data.filter((d) => d.name === "Content overview")).toHaveLength(1);
  });
});

describe("seed manifest + clear-samples", () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const res = await h.fetch("/api/admin/templates/apply", json({ templateId: "blog" }));
    expect(res.status).toBe(201);
  });
  afterAll(() => h.cleanup());

  test("clear-samples removes exactly the seeded rows, never user data", async () => {
    // Catalog reports the manifest…
    const before = (await (await h.fetch("/api/admin/templates")).json()) as {
      sampleSeeds: number;
    };
    expect(before.sampleSeeds).toBe(10);

    // …the admin adds their own row…
    const own = await h.fetch(
      "/api/items/posts",
      json({ title: "Keep me", slug: "keep-me", body: "Handwritten." }),
    );
    expect([200, 201]).toContain(own.status);

    // …and clear-samples removes only the 10 seeded rows.
    const clear = await h.fetch("/api/admin/templates/clear-samples", json({}));
    expect(clear.status).toBe(200);
    const { data } = (await clear.json()) as {
      data: { removed: number; collections: string[] };
    };
    expect(data.removed).toBe(10);
    expect(data.collections.sort()).toEqual(
      ["authors", "categories", "pages", "posts", "tags"].sort(),
    );

    const posts = (await (await h.fetch("/api/items/posts?status=all")).json()) as {
      data: { title: string }[];
    };
    expect(posts.data.map((p) => p.title)).toEqual(["Keep me"]);
    const authors = (await (await h.fetch("/api/items/authors")).json()) as {
      data: unknown[];
    };
    expect(authors.data).toHaveLength(0);

    // Cleared seeded rows also drop out of full-text search (sqlite shadow rows).
    const fts = (await (await h.fetch("/api/items/posts?q=walkthrough&status=all")).json()) as {
      data: unknown[];
    };
    expect(fts.data).toHaveLength(0);

    // Manifest is spent: second clear is a no-op, catalog reports 0.
    const again = await h.fetch("/api/admin/templates/clear-samples", json({}));
    const { data: d2 } = (await again.json()) as { data: { removed: number } };
    expect(d2.removed).toBe(0);
    const after = (await (await h.fetch("/api/admin/templates")).json()) as {
      sampleSeeds: number;
    };
    expect(after.sampleSeeds).toBe(0);
  });
});

describe("extract → apply-custom round-trip", () => {
  let a: TestHarness;
  let b: TestHarness;

  beforeAll(async () => {
    a = makeHarness();
    await seedAdmin(a);
    b = makeHarness();
    await seedAdmin(b);
  });
  afterAll(() => {
    a.cleanup();
    b.cleanup();
  });

  test("a workspace exports in template format and applies elsewhere", async () => {
    const apply = await a.fetch("/api/admin/templates/apply", json({ templateId: "blog" }));
    expect(apply.status).toBe(201);

    const extractRes = await a.fetch("/api/admin/templates/extract");
    expect(extractRes.status).toBe(200);
    const { data: template } = (await extractRes.json()) as {
      data: {
        groups: string[];
        collections: { slug: string; group?: string; fields: unknown[] }[];
      };
    };
    expect(template.groups).toEqual(["Content", "Taxonomy", "People"]);
    const slugs = template.collections.map((c) => c.slug);
    expect(slugs.sort()).toEqual(
      ["authors", "categories", "media", "pages", "posts", "tags"].sort(),
    );
    // Dependency order: relation targets precede dependents.
    expect(slugs.indexOf("authors")).toBeLessThan(slugs.indexOf("posts"));
    expect(slugs.indexOf("categories")).toBeLessThan(slugs.indexOf("posts"));
    expect(template.collections.find((c) => c.slug === "posts")?.group).toBe("Content");

    // Round-trip into a fresh workspace via the inline-template apply path.
    const customApply = await b.fetch("/api/admin/templates/apply", json({ template }));
    expect(customApply.status).toBe(201);
    const { data: applied } = (await customApply.json()) as {
      data: { templateId: string; created: string[]; seeded: number };
    };
    expect(applied.templateId).toBe("custom");
    expect(applied.created.sort()).toEqual(slugs.slice().sort());
    expect(applied.seeded).toBe(0); // extract carries no sample data

    const cols = (await (await b.fetch("/api/collections")).json()) as {
      data: { slug: string; group: string | null }[];
      meta: { groups: string[] };
    };
    expect(cols.data.find((c) => c.slug === "posts")?.group).toBe("Content");
    expect(cols.meta.groups).toEqual(["Content", "Taxonomy", "People"]);
  });

  test("extract narrows with ?collections= and validates emptiness", async () => {
    const res = await a.fetch("/api/admin/templates/extract?collections=posts,authors");
    const { data } = (await res.json()) as {
      data: { collections: { slug: string }[] };
    };
    expect(data.collections.map((c) => c.slug).sort()).toEqual(["authors", "posts"]);

    const empty = await a.fetch("/api/admin/templates/extract?collections=nope");
    expect(empty.status).toBeGreaterThanOrEqual(400);
  });

  test("apply-custom rejects invalid field defs", async () => {
    const res = await b.fetch(
      "/api/admin/templates/apply",
      json({
        template: {
          collections: [
            { slug: "badcol", fields: [{ name: "x", type: "not-a-type" }] },
          ],
        },
      }),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  test("extract preserves the admin's in-group ordering through the round-trip", async () => {
    // Blog seeds Content as media(10) → posts(20) → pages(30). Move posts to
    // the front; extract must carry the explicit sortOrder (the array itself
    // is dependency-ordered — posts trails its relation targets), and a
    // re-apply must reproduce the arrangement.
    const patch = await a.fetch("/api/collections/posts", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sortOrder: 5 }),
    });
    expect(patch.status).toBe(200);
    const res = await a.fetch("/api/admin/templates/extract");
    const { data } = (await res.json()) as {
      data: { collections: { slug: string; group?: string; sortOrder?: number }[] };
    };
    expect(data.collections.find((c) => c.slug === "posts")?.sortOrder).toBe(5);
    expect(data.collections.find((c) => c.slug === "media")?.sortOrder).toBe(10);

    const c = makeHarness();
    await seedAdmin(c);
    try {
      const apply = await c.fetch("/api/admin/templates/apply", json({ template: data }));
      expect(apply.status).toBe(201);
      const cols = (await (await c.fetch("/api/collections")).json()) as {
        data: { slug: string; group: string | null; sortOrder: number | null }[];
      };
      const posts = cols.data.find((x) => x.slug === "posts")!;
      const media = cols.data.find((x) => x.slug === "media")!;
      expect(posts.sortOrder!).toBeLessThan(media.sortOrder!);
    } finally {
      c.cleanup();
    }
  });

  test("extract carries displayTemplate + vectorizeModel through the round-trip", async () => {
    // Set fidelity fields on a collection, extract, and confirm they survive.
    const patch = await a.fetch("/api/collections/authors", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayTemplate: "{name} <{email}>" }),
    });
    expect(patch.status).toBe(200);
    const res = await a.fetch("/api/admin/templates/extract?collections=authors");
    const { data } = (await res.json()) as {
      data: { collections: { slug: string; displayTemplate?: string }[] };
    };
    expect(data.collections[0]?.displayTemplate).toBe("{name} <{email}>");
  });

  test("subset extract with an out-of-set relation target still applies (no hard FK)", async () => {
    // posts.author points at authors, which is NOT exported — relations are
    // plain indexed columns, so the apply must succeed with a dangling link.
    const res = await a.fetch("/api/admin/templates/extract?collections=posts");
    const { data: template } = (await res.json()) as { data: unknown };
    const c = makeHarness();
    await seedAdmin(c);
    try {
      const apply = await c.fetch("/api/admin/templates/apply", json({ template }));
      expect(apply.status).toBe(201);
      const { data } = (await apply.json()) as { data: { created: string[] } };
      expect(data.created).toEqual(["posts"]);
    } finally {
      c.cleanup();
    }
  });
});

describe("template surfaces are admin-gated", () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    // Second signed-in user WITHOUT the admin role.
    const su = await h.fetch("/api/auth/sign-up/email", json({
      email: "member@example.test",
      password: "correct-horse-battery",
      name: "Member",
    }));
    expect(su.status).toBe(200);
  });
  afterAll(() => h.cleanup());

  test("catalog + extract + clear-samples all reject non-admins", async () => {
    for (const [path, init] of [
      ["/api/admin/templates", undefined],
      ["/api/admin/templates/extract", undefined],
      ["/api/admin/templates/clear-samples", json({})],
      ["/api/admin/templates/apply", json({ templateId: "blog" })],
    ] as const) {
      const res = await h.fetch(path, init);
      expect(res.status).toBeGreaterThanOrEqual(401);
      expect(res.status).toBeLessThan(500);
    }
  });
});
