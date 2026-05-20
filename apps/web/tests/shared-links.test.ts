import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

/**
 * Record share-link flow: an admin creates a collection + item, mints a
 * public share link, resolves it WITHOUT a session, then revokes it and
 * confirms the public token 404s.
 */
describe("record share links", () => {
  let h: TestHarness;
  const slug = `shared_notes_${Date.now()}`;
  let itemId = "";
  let linkId = "";
  let token = "";

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);

    const createCollection = await h.fetch("/api/collections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slug,
        fields: [
          { name: "title", type: "text", required: true },
          { name: "done", type: "boolean" },
        ],
      }),
    });
    expect(createCollection.status).toBe(201);

    const createItem = await h.fetch(`/api/items/${slug}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "shared record", done: true }),
    });
    expect(createItem.status).toBe(201);
    const inserted = (await createItem.json()) as { data: { id: string } };
    itemId = inserted.data.id;
  });

  afterAll(() => {
    h.cleanup();
  });

  test("admin mints a share link and gets a one-time token", async () => {
    const res = await h.fetch("/api/shared-links", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ collection: slug, itemId }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      data: { id: string; token: string; url: string };
    };
    expect(body.data.token.startsWith("svl_")).toBe(true);
    expect(body.data.url).toBe(`/s/${body.data.token}`);
    linkId = body.data.id;
    token = body.data.token;
  });

  test("listing links never exposes the token or its hash", async () => {
    const res = await h.fetch(
      `/api/shared-links?collection=${encodeURIComponent(slug)}&itemId=${encodeURIComponent(itemId)}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown>[] };
    expect(body.data.length).toBe(1);
    const row = body.data[0]!;
    expect(row.id).toBe(linkId);
    expect("token" in row).toBe(false);
    expect("tokenHash" in row).toBe(false);
  });

  test("public token resolves the record without a session", async () => {
    // Call app.fetch directly with no Cookie header — proves the route
    // needs no session (h.fetch would attach the admin's cookies).
    const res = await h.app.fetch(
      new Request(`${h.env.APP_URL}/api/shared/${token}`),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        collection: string;
        item: Record<string, unknown>;
        fields: { name: string; type: string }[];
      };
    };
    expect(body.data.collection).toBe(slug);
    expect(body.data.item.id).toBe(itemId);
    expect(body.data.item.title).toBe("shared record");
    expect(body.data.fields.some((f) => f.name === "title")).toBe(true);
  });

  test("revoking the link makes the public token 404", async () => {
    const revoke = await h.fetch(`/api/shared-links/${linkId}`, {
      method: "DELETE",
    });
    expect(revoke.status).toBe(200);

    const after = await h.app.fetch(
      new Request(`${h.env.APP_URL}/api/shared/${token}`),
    );
    expect(after.status).toBe(404);

    // The revoked link no longer appears in the active list either.
    const list = await h.fetch(
      `/api/shared-links?collection=${encodeURIComponent(slug)}&itemId=${encodeURIComponent(itemId)}`,
    );
    const listBody = (await list.json()) as { data: unknown[] };
    expect(listBody.data.length).toBe(0);
  });

  test("an unknown token 404s", async () => {
    const res = await h.app.fetch(
      new Request(`${h.env.APP_URL}/api/shared/svl_deadbeef`),
    );
    expect(res.status).toBe(404);
  });
});
