/**
 * Multi-surface parity for version history.
 *
 * Two invariants worth stating out loud:
 *
 *  - A revision is addressed by its OWN id, not the row's. That is what makes
 *    `revert` unambiguous when several revisions of one row are on screen, and
 *    it is why the SDK's signature is `revert(revisionId)` rather than
 *    `revert(collection, itemId, n)`.
 *  - Reverting is itself a write. It records a new revision instead of erasing
 *    the ones after it, so an accidental revert is undoable and the history
 *    stays a history rather than becoming a claim about one.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { revisionsTools } from "../src/server/mcp/tools/revisions";
import { createClient } from "../../../packages/client/src/index";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const JSON_HEADERS = { "content-type": "application/json" };
const BASE = "/api/revisions";

describe("revisions — surfaces", () => {
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
        name: "Pages",
        slug: "pages",
        revisions: true,
        fields: [{ name: "title", type: "text" }],
      }),
    });
    const created = await h.fetch("/api/items/pages", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ title: "Version one" }),
    });
    expect(created.status).toBe(201);
    itemId = ((await created.json()) as { data: { id: string } }).data.id;

    await h.fetch(`/api/items/pages/${itemId}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ title: "Version two" }),
    });
  });

  afterAll(() => h.cleanup());

  test("REST: a row that has been edited has a history", async () => {
    const res = await h.fetch(`${BASE}/pages/${itemId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string; snapshot: Record<string, unknown> }[] };
    expect(body.data.length).toBeGreaterThan(0);
    // The snapshot is the row as it stood, so it carries the field values —
    // a history of ids nobody could read would be no history at all.
    expect(Object.keys(body.data[0]!.snapshot).length).toBeGreaterThan(0);
  });

  test("MCP: the two tools an agent gets", () => {
    expect(revisionsTools.map((t) => t.name).sort()).toEqual([
      "revisions.list",
      "revisions.revert",
    ]);
  });

  test("the SDK points at routes that exist", async () => {
    const live = await client.revisions.list("pages", itemId);
    const revisionId = live.data[0]!.id;

    const calls: string[] = [];
    const spy = {
      request: async (m: string, p: string) => {
        calls.push(`${m} ${p}`);
        return { data: [] };
      },
    };
    const { makeRevisions } = await import("../../../packages/client/src/clients/revisions");
    const revisions = makeRevisions(spy as never);
    await revisions.list("pages", itemId);
    await revisions.revert(revisionId);
    expect(calls).toEqual([
      `GET ${BASE}/pages/${itemId}`,
      `POST ${BASE}/${revisionId}/revert`,
    ]);

    // Dispatched for real against the LIVE revision id.
    for (const call of calls) {
      const [method, path] = call.split(" ") as [string, string];
      const res = await h.fetch(path, { method, headers: JSON_HEADERS });
      // Asserts the STATUS, and keeps `call` in the failure output so a real
      // miss still names the route. It used to substring-match the rendered
      // line for "404" — which a UUID like `…-4047-…` satisfies on its own, so
      // every one of these files failed a few runs in a hundred for no reason.
      expect({ call, status: res.status }).not.toMatchObject({ status: 404 });
    }
  });

  test("SDK: reverting puts the row back, and keeps the history", async () => {
    const before = await client.revisions.list("pages", itemId);
    const target = before.data.find(
      (r) => (r.snapshot as { title?: string }).title === "Version one",
    );
    expect(target, "the pre-edit snapshot should be recorded").toBeDefined();

    expect((await client.revisions.revert(target!.id)).ok).toBe(true);

    const row = await client.from<{ id: string; title: string }>("pages").one(itemId);
    expect(row.data.title).toBe("Version one");

    // A revert is a write, so the history grew rather than being rewound.
    // Erasing the newer revisions would make an accidental revert permanent.
    const after = await client.revisions.list("pages", itemId);
    expect(after.data.length).toBeGreaterThan(before.data.length);
  });
});
