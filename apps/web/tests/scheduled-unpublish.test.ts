/**
 * Scheduled unpublish / expiry (C1) on versioned collections:
 *   - `{ unpublishAt }` sets an expiry without changing `_status`;
 *   - the read serializer exposes `_published_at` / `_publish_at` / `_unpublish_at`
 *     (the admin badges + "edited since publish" indicator read these);
 *   - `unpublishDueItems` reverts a published row past its expiry back to draft;
 *   - `{ unpublishAt: null }` cancels a pending expiry.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import { buildContext } from "../src/server/context";
import { unpublishDueItems } from "../src/server/services/items/scheduled-publish";

const JSON_HEADERS = { "Content-Type": "application/json" };

describe("Scheduled unpublish (expiry)", () => {
  let h: TestHarness;
  const slug = `expirable_${Date.now()}`;
  let id: string;

  const getRow = async () => {
    const res = await h.fetch(`/api/items/${slug}/${id}`);
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: Record<string, unknown> }).data;
  };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const create = await h.fetch("/api/collections", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        slug,
        versioned: true,
        fields: [{ name: "title", type: "text", required: true }],
      }),
    });
    expect(create.status).toBe(201);
    const mk = await h.fetch(`/api/items/${slug}`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ title: "expires soon" }),
    });
    id = ((await mk.json()) as { data: { id: string } }).data.id;
    expect((await h.fetch(`/api/items/${slug}/${id}/publish`, { method: "POST" })).status).toBe(200);
  });
  afterAll(() => h.cleanup());

  test("setting unpublishAt records the expiry without changing status", async () => {
    const at = new Date(Date.now() + 60_000).toISOString();
    const res = await h.fetch(`/api/items/${slug}/${id}/publish`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ unpublishAt: at }),
    });
    expect(res.status).toBe(200);
    const row = (await res.json()).data as Record<string, unknown>;
    expect(row._status).toBe("published"); // still live until due
    expect(row._unpublish_at).not.toBeNull();
  });

  test("the read serializer exposes the versioned system timestamps", async () => {
    const row = await getRow();
    // Snake-case mirrors the admin SPA reads for its badges.
    expect(row).toHaveProperty("_published_at");
    expect(row).toHaveProperty("_publish_at");
    expect(row).toHaveProperty("_unpublish_at");
    expect(row._unpublish_at).not.toBeNull();
  });

  test("unpublishDueItems reverts a published row past its expiry to draft", async () => {
    // The endpoint coerces a past `unpublishAt` to null, so schedule ~250ms out
    // and let it become due, then run the tick.
    const soon = new Date(Date.now() + 250).toISOString();
    await h.fetch(`/api/items/${slug}/${id}/publish`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ unpublishAt: soon }),
    });
    expect((await getRow())._status).toBe("published");

    await new Promise((r) => setTimeout(r, 450));
    const ctx = await buildContext(h.env);
    await unpublishDueItems(ctx);

    const row = await getRow();
    expect(row._status).toBe("draft");
    expect(row._unpublish_at ?? null).toBeNull();
    expect(row._published_at ?? null).toBeNull();
  });

  test("publishAt and unpublishAt together schedule a WINDOW, not just a start", async () => {
    // Regression: the scheduled-publish branch hardcoded `_unpublish_at = NULL`
    // to avoid inheriting a stale expiry, which also discarded an `unpublishAt`
    // sent in the same body — silently, under a 200. "Publish at 09:00, pull it
    // at 17:00" is the one thing scheduled publishing exists for, and it left
    // the row with no expiry at all.
    const startAt = new Date(Date.now() + 60_000).toISOString();
    const endAt = new Date(Date.now() + 120_000).toISOString();
    const res = await h.fetch(`/api/items/${slug}/${id}/publish`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ publishAt: startAt, unpublishAt: endAt }),
    });
    expect(res.status).toBe(200);
    const row = (await res.json()).data as Record<string, unknown>;

    expect(row._status).toBe("draft"); // not live until the start is due
    expect(row._publish_at).not.toBeNull();
    expect(row._unpublish_at).not.toBeNull();
  });

  test("a scheduled publish with no unpublishAt still clears a stale expiry", async () => {
    // The other half of the same rule: absent means "no window", and a previous
    // request's expiry must not survive into it.
    await h.fetch(`/api/items/${slug}/${id}/publish`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ unpublishAt: new Date(Date.now() + 90_000).toISOString() }),
    });
    const res = await h.fetch(`/api/items/${slug}/${id}/publish`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ publishAt: new Date(Date.now() + 60_000).toISOString() }),
    });
    const row = (await res.json()).data as Record<string, unknown>;

    expect(row._publish_at).not.toBeNull();
    expect(row._unpublish_at).toBeNull();
  });

  test("unpublishAt: null cancels a pending expiry", async () => {
    // republish + schedule, then cancel.
    await h.fetch(`/api/items/${slug}/${id}/publish`, { method: "POST" });
    const at = new Date(Date.now() + 60_000).toISOString();
    await h.fetch(`/api/items/${slug}/${id}/publish`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ unpublishAt: at }),
    });
    expect((await getRow())._unpublish_at).not.toBeNull();
    const cancel = await h.fetch(`/api/items/${slug}/${id}/publish`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ unpublishAt: null }),
    });
    expect(cancel.status).toBe(200);
    const row = await getRow();
    expect(row._status).toBe("published"); // still live
    expect(row._unpublish_at ?? null).toBeNull();
  });
});
