import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type TestHarness, makeHarness, seedAdmin } from "./setup";

/**
 * `kanbanGroupBy` is an admin-UI preference (which field the Kanban board
 * groups cards by) persisted on the collection metadata row. Pin the create +
 * PATCH round-trip, the `_status` sentinel, and that clearing it back to null
 * works — the same shape as defaultSort/group.
 */
describe("collections — kanbanGroupBy round-trip", () => {
  let h: TestHarness;
  const slug = "kanban_group_probe";
  const JSON_HEADERS = { "content-type": "application/json" };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const create = await h.fetch("/api/collections", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        slug,
        versioned: true,
        kanbanGroupBy: "stage",
        fields: [
          { name: "title", type: "text" },
          {
            name: "stage",
            type: "text",
            interface: "dropdown",
            options: { values: ["todo", "doing", "done"] },
          },
        ],
      }),
    });
    expect(create.status).toBe(201);
  });
  afterAll(() => h.cleanup());

  const getRow = async () => {
    const res = await h.fetch(`/api/collections/${slug}`);
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: { kanbanGroupBy: string | null } }).data;
  };

  test("create persists the chosen field", async () => {
    expect((await getRow()).kanbanGroupBy).toBe("stage");
  });

  test("PATCH to the _status lifecycle sentinel persists", async () => {
    const patch = await h.fetch(`/api/collections/${slug}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ kanbanGroupBy: "_status" }),
    });
    expect(patch.status).toBe(200);
    expect((await getRow()).kanbanGroupBy).toBe("_status");
  });

  test("a note-only PATCH leaves kanbanGroupBy untouched", async () => {
    const patch = await h.fetch(`/api/collections/${slug}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ note: "unrelated" }),
    });
    expect(patch.status).toBe(200);
    expect((await getRow()).kanbanGroupBy).toBe("_status");
  });

  test("PATCH null clears it back to auto-detect", async () => {
    const patch = await h.fetch(`/api/collections/${slug}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ kanbanGroupBy: null }),
    });
    expect(patch.status).toBe(200);
    expect((await getRow()).kanbanGroupBy).toBeNull();
  });

  test("rejects an invalid field name", async () => {
    const patch = await h.fetch(`/api/collections/${slug}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ kanbanGroupBy: "Bad Name!" }),
    });
    expect(patch.status).toBe(422);
  });
});

describe("collections — kanbanActionMap (custom-status → lifecycle triggers)", () => {
  let h: TestHarness;
  const slug = "kanban_action_probe";
  const JSON_HEADERS = { "content-type": "application/json" };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const create = await h.fetch("/api/collections", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        slug,
        versioned: true,
        kanbanGroupBy: "stage",
        kanbanActionMap: { done: "publish" },
        fields: [
          { name: "title", type: "text" },
          {
            name: "stage",
            type: "text",
            interface: "dropdown",
            options: { values: ["todo", "done"] },
          },
        ],
      }),
    });
    expect(create.status).toBe(201);
  });
  afterAll(() => h.cleanup());

  const getRow = async () => {
    const res = await h.fetch(`/api/collections/${slug}`);
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: { kanbanActionMap: Record<string, string> | null } }).data;
  };

  test("create persists the action map (parsed object on both dialects)", async () => {
    expect((await getRow()).kanbanActionMap).toEqual({ done: "publish" });
  });

  test("PATCH replaces the map", async () => {
    const patch = await h.fetch(`/api/collections/${slug}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ kanbanActionMap: { done: "publish", cancelled: "archive" } }),
    });
    expect(patch.status).toBe(200);
    expect((await getRow()).kanbanActionMap).toEqual({ done: "publish", cancelled: "archive" });
  });

  test("PATCH null clears the map", async () => {
    const patch = await h.fetch(`/api/collections/${slug}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ kanbanActionMap: null }),
    });
    expect(patch.status).toBe(200);
    expect((await getRow()).kanbanActionMap ?? null).toBeNull();
  });

  test("rejects an unknown action value", async () => {
    const patch = await h.fetch(`/api/collections/${slug}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ kanbanActionMap: { done: "explode" } }),
    });
    expect(patch.status).toBe(422);
  });
});
