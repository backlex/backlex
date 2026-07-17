/**
 * Slug-rename cascade (`services/collection-rename.ts::cascadeSlugRename`),
 * driven through its real trigger: `PATCH /api/collections/:slug` with a new
 * `slug`. The cascade rewrites the slug everywhere it's stored as data —
 * permissions, revisions, comments, activity, webhook event patterns,
 * function patterns, flow ops/trigger — while the physical table stays put.
 *
 * Asserted here:
 *   - items remain readable under the new slug; the old slug 404s;
 *   - the permission row granted against the old slug moves (and still
 *     authorizes reads for the granted role);
 *   - webhook `events[]` patterns and flow ops/trigger are rewritten;
 *     patterns for other collections are untouched;
 *   - activity rows move to the new slug;
 *   - relation fields in OTHER collections (`fields[].to`) are rewritten to
 *     the new slug and the counts report the touched collection.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const JSON_HEADERS = { "Content-Type": "application/json" };

describe("collection slug rename cascade", () => {
  let h: TestHarness;
  const ts = Date.now();
  const oldSlug = `authors_${ts}`;
  const newSlug = `writers_${ts}`;
  const postsSlug = `posts_${ts}`;
  const itemIds: string[] = [];
  let renamed: Record<string, number>;

  const db = () => new Database(h.env.SQLITE_PATH as string);

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);

    // Target collection (gets renamed) + a second collection with a relation
    // field pointing at it.
    const mkCollection = async (body: unknown) => {
      const r = await h.fetch("/api/collections", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
      });
      expect(r.status).toBe(201);
    };
    await mkCollection({
      slug: oldSlug,
      fields: [{ name: "name", type: "text", required: true }],
    });
    await mkCollection({
      slug: postsSlug,
      fields: [
        { name: "title", type: "text" },
        { name: "author", type: "relation", to: oldSlug },
      ],
    });

    // Two items in the collection that will be renamed.
    for (const name of ["ada", "grace"]) {
      const r = await h.fetch(`/api/items/${oldSlug}`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ name }),
      });
      expect(r.status).toBe(201);
      itemIds.push(((await r.json()) as { data: { id: string } }).data.id);
    }

    // A permission row referencing the slug: grant `authenticated` read.
    const roles = (
      (await (await h.fetch("/api/roles")).json()) as {
        data: { id: string; name: string }[];
      }
    ).data;
    const authRole = roles.find((r) => r.name === "authenticated");
    expect(authRole).toBeTruthy();
    const grant = await h.fetch(`/api/roles/${authRole!.id}/permissions`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ collection: oldSlug, action: "read", condition: null }),
    });
    expect(grant.status).toBeLessThan(300);

    // A webhook subscribed to the slug (plus an unrelated pattern that must
    // survive untouched).
    const hook = await h.fetch("/api/webhooks", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        name: "rename-hook",
        url: "https://example.test/hook",
        events: [`items:${oldSlug}:created`, "items:unrelated:created"],
      }),
    });
    expect(hook.status).toBe(201);

    // A flow triggered by the slug whose ops also write into it.
    const flow = await h.fetch("/api/flows", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        name: "rename-flow",
        trigger: `items:${oldSlug}:created`,
        operations: [
          { type: "item.create", collection: oldSlug, data: { name: "from-flow" } },
          { type: "log", message: "untouched" },
        ],
      }),
    });
    expect(flow.status).toBe(201);

    // The rename itself.
    const patch = await h.fetch(`/api/collections/${oldSlug}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ slug: newSlug }),
    });
    expect(patch.status).toBe(200);
    const body = (await patch.json()) as {
      ok: boolean;
      slug: string;
      renamed: Record<string, number>;
    };
    expect(body.ok).toBe(true);
    expect(body.slug).toBe(newSlug);
    renamed = body.renamed;
  });
  afterAll(() => h.cleanup());

  test("PATCH reports cascade counts for every touched reference", () => {
    expect(renamed.permissions).toBeGreaterThanOrEqual(1); // our authenticated-read grant
    expect(renamed.webhooks).toBe(1);
    expect(renamed.flows).toBe(1);
    expect(renamed.activity).toBeGreaterThanOrEqual(2); // the two item creates
  });

  test("items are readable under the new slug; the old slug 404s", async () => {
    const ok = await h.fetch(`/api/items/${newSlug}`);
    expect(ok.status).toBe(200);
    const rows = ((await ok.json()) as { data: { id: string; name: string }[] }).data;
    expect(rows.map((r) => r.id).sort()).toEqual([...itemIds].sort());
    expect(rows.map((r) => r.name).sort()).toEqual(["ada", "grace"]);

    expect((await h.fetch(`/api/items/${oldSlug}`)).status).toBe(404);
    expect((await h.fetch(`/api/collections/${oldSlug}`)).status).toBe(404);
    expect((await h.fetch(`/api/collections/${newSlug}`)).status).toBe(200);
  });

  test("permission rows moved to the new slug (none left on the old)", async () => {
    const client = db();
    try {
      const oldCount = (
        client
          .query("SELECT COUNT(*) AS n FROM permissions WHERE collection = ?")
          .get(oldSlug) as { n: number }
      ).n;
      const newCount = (
        client
          .query("SELECT COUNT(*) AS n FROM permissions WHERE collection = ?")
          .get(newSlug) as { n: number }
      ).n;
      expect(oldCount).toBe(0);
      expect(newCount).toBeGreaterThanOrEqual(1);
    } finally {
      client.close();
    }
  });

  test("the moved permission still authorizes the granted role under the new slug", async () => {
    // Fresh non-admin user → `authenticated` role only; its read grant was
    // created against the old slug and must keep working after the rename.
    const h2 = makeHarness({ SQLITE_PATH: h.env.SQLITE_PATH }); // same DB, fresh cookie jar
    try {
      const su = await h2.fetch("/api/auth/sign-up/email", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          email: `reader-${ts}@example.test`,
          password: "correct-horse-battery",
          name: "Reader",
        }),
      });
      expect(su.status).toBeLessThan(300);
      const read = await h2.fetch(`/api/items/${newSlug}`);
      expect(read.status).toBe(200);
      const rows = ((await read.json()) as { data: unknown[] }).data;
      expect(rows).toHaveLength(2);
    } finally {
      h2.cleanup(); // shares h's DB file; h.cleanup() in afterAll is a no-op double-rm
    }
  });

  test("webhook event patterns are rewritten; unrelated patterns untouched", async () => {
    const hooks = (
      (await (await h.fetch("/api/webhooks")).json()) as {
        data: { name: string; events: string[] }[];
      }
    ).data;
    const hook = hooks.find((w) => w.name === "rename-hook");
    expect(hook).toBeTruthy();
    expect(hook!.events).toEqual([`items:${newSlug}:created`, "items:unrelated:created"]);
  });

  test("flow trigger and item ops are rewritten; non-item ops untouched", async () => {
    const flows = (
      (await (await h.fetch("/api/flows")).json()) as {
        data: {
          name: string;
          trigger: string;
          operations: Array<Record<string, unknown>>;
        }[];
      }
    ).data;
    const flow = flows.find((f) => f.name === "rename-flow");
    expect(flow).toBeTruthy();
    expect(flow!.trigger).toBe(`items:${newSlug}:created`);
    expect(flow!.operations[0]).toMatchObject({ type: "item.create", collection: newSlug });
    expect(flow!.operations[1]).toMatchObject({ type: "log", message: "untouched" });
  });

  test("activity rows moved to the new slug", async () => {
    const client = db();
    try {
      const oldCount = (
        client
          .query("SELECT COUNT(*) AS n FROM activity WHERE collection = ?")
          .get(oldSlug) as { n: number }
      ).n;
      const newCount = (
        client
          .query("SELECT COUNT(*) AS n FROM activity WHERE collection = ?")
          .get(newSlug) as { n: number }
      ).n;
      expect(oldCount).toBe(0);
      expect(newCount).toBeGreaterThanOrEqual(2);
    } finally {
      client.close();
    }
  });

  test("relation fields in other collections are rewritten to the new slug", async () => {
    const res = await h.fetch(`/api/collections/${postsSlug}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { fields: Array<{ name: string; to?: string }> };
    };
    const author = body.data.fields.find((f) => f.name === "author");
    expect(author).toBeTruthy();
    expect(author!.to).toBe(newSlug);
    expect(renamed.relations).toBe(1);
  });
});
