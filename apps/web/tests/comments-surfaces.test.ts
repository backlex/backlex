/**
 * Multi-surface parity for per-record comments.
 *
 * The invariant every surface holds: a comment is addressed by the RECORD it
 * hangs off, never on its own. There is no "list every comment", because the
 * permission that governs a comment is the read permission on the row it is
 * about — a flat listing would need a second, parallel answer to who may see
 * what, and the two would drift.
 *
 * The author is the calling identity and is not settable. A comment whose
 * author a caller could choose is a comment that can be put in someone else's
 * mouth.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { commentsTools } from "../src/server/mcp/tools/comments";
import { createClient } from "../../../packages/client/src/index";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const JSON_HEADERS = { "content-type": "application/json" };
const BASE = "/api/comments";

describe("comments — surfaces", () => {
  let h: TestHarness;
  let client: ReturnType<typeof createClient>;
  let itemId = "";

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    client = createClient({ url: "", fetch: h.fetch as unknown as typeof fetch });

    await h.fetch("/api/collections", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        name: "Articles",
        slug: "articles",
        fields: [{ name: "title", type: "text" }],
      }),
    });
    const created = await h.fetch("/api/items/articles", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ title: "Subject of discussion" }),
    });
    expect(created.status).toBe(201);
    itemId = ((await created.json()) as { data: { id: string } }).data.id;
  });

  afterAll(() => h.close?.());

  test("REST: post, list, delete — always scoped to one record", async () => {
    const posted = await h.fetch(BASE, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ collection: "articles", itemId, body: "First!" }),
    });
    expect(posted.status).toBeLessThan(300);

    const q = new URLSearchParams({ collection: "articles", itemId });
    const listed = (await (await h.fetch(`${BASE}?${q}`)).json()) as {
      data: { id: string; body: string }[];
    };
    expect(listed.data.some((c) => c.body === "First!")).toBe(true);
  });

  test("REST: a listing without a record to hang off is refused", async () => {
    // Not an empty list — a 4xx. Answering "here is nothing" to a malformed
    // question is how a missing scope check reads as an empty result.
    const res = await h.fetch(BASE);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  test("the author is the caller, not a field of the request", async () => {
    const res = await h.fetch(BASE, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        collection: "articles",
        itemId,
        body: "Impersonation attempt",
        userId: "somebody-else",
      }),
    });
    if (res.status < 300) {
      const q = new URLSearchParams({ collection: "articles", itemId });
      const listed = (await (await h.fetch(`${BASE}?${q}`)).json()) as {
        data: { body: string; userId: string | null }[];
      };
      const planted = listed.data.find((c) => c.body === "Impersonation attempt");
      expect(planted?.userId).not.toBe("somebody-else");
    } else {
      expect(res.status).toBe(422);
    }
  });

  test("MCP: the three tools an agent gets", () => {
    expect(commentsTools.map((t) => t.name).sort()).toEqual([
      "comments.delete",
      "comments.list",
      "comments.post",
    ]);
  });

  test("the SDK points at routes that exist", async () => {
    const posted = await client.comments.post({
      collection: "articles",
      itemId,
      body: "From the SDK",
    });
    const liveId = posted.data.id;

    const calls: string[] = [];
    const spy = {
      request: async (m: string, p: string) => {
        calls.push(`${m} ${p}`);
        return { data: [] };
      },
    };
    const { makeComments } = await import("../../../packages/client/src/clients/comments");
    const comments = makeComments(spy as never);
    await comments.list("articles", itemId);
    await comments.post({ collection: "articles", itemId, body: "x" });
    await comments.delete(liveId);
    expect(calls).toEqual([
      `GET ${BASE}?collection=articles&itemId=${itemId}`,
      `POST ${BASE}`,
      `DELETE ${BASE}/${liveId}`,
    ]);

    // Dispatched for real against the LIVE ids, so a 404 means the route is
    // not mounted rather than "that row does not exist".
    for (const call of calls) {
      const [method, path] = call.split(" ") as [string, string];
      const res = await h.fetch(path, {
        method,
        headers: JSON_HEADERS,
        ...(method === "POST"
          ? { body: JSON.stringify({ collection: "articles", itemId, body: "probe" }) }
          : {}),
      });
      expect(`${call} → ${res.status}`).not.toContain("404");
    }
  });

  test("SDK: the round trip an application makes", async () => {
    const posted = await client.comments.post({
      collection: "articles",
      itemId,
      body: "Round trip",
    });
    expect(posted.data.body).toBe("Round trip");

    const listed = await client.comments.list("articles", itemId);
    expect(listed.data.some((c) => c.id === posted.data.id)).toBe(true);

    expect((await client.comments.delete(posted.data.id)).ok).toBe(true);
    const after = await client.comments.list("articles", itemId);
    expect(after.data.some((c) => c.id === posted.data.id)).toBe(false);
  });
});
