/**
 * Multi-surface parity for CDC sinks.
 *
 * The invariants every surface has to hold: the signing secret never comes
 * back, and the cursor is never settable directly — `resetCursor` is the only
 * way to move it, because a caller who could write an arbitrary cursor could
 * silently skip records nobody would ever notice missing.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cdcTools } from "../src/server/mcp/tools/cdc";
import { CDC_DESTINATIONS } from "../src/server/services/cdc";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const JSON_HEADERS = { "content-type": "application/json" };
const BASE = "/api/admin/cdc-sinks";

describe("CDC sinks — surfaces", () => {
  let h: TestHarness;
  let id = "";

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    await h.fetch("/api/collections", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        name: "Orders",
        slug: "orders",
        fields: [{ name: "title", type: "text" }],
      }),
    });
    const res = await h.fetch(BASE, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        name: "parity",
        collection: "orders",
        destination: "webhook",
        config: { url: "https://sink.test/x", secret: "whsec_PARITY" },
      }),
    });
    expect(res.status).toBe(201);
    id = ((await res.json()) as { data: { id: string } }).data.id;
  });
  afterAll(() => h.cleanup());

  test("the signing secret is absent from every read surface", async () => {
    const listed = await (await h.fetch(BASE)).text();
    expect(listed).not.toContain("whsec_PARITY");
    const log = await (await h.fetch("/api/activity?limit=50")).text();
    expect(log).not.toContain("whsec_PARITY");
  });

  test("the cursor cannot be written directly", async () => {
    const before = (await (await h.fetch(BASE)).json()) as { data: Array<{ cursor: string | null }> };
    await h.fetch(`${BASE}/${id}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ cursor: "forged" }),
    });
    const after = (await (await h.fetch(BASE)).json()) as { data: Array<{ cursor: string | null }> };
    // A caller who could set it could silently skip records, and nobody would
    // ever notice which ones were missing.
    expect(after.data[0]!.cursor).toBe(before.data[0]!.cursor);
  });

  test("every REST verb has an MCP tool, and the descriptions carry the semantics", () => {
    expect(cdcTools.map((t) => t.name).sort()).toEqual([
      "cdc.create",
      "cdc.delete",
      "cdc.list",
      "cdc.run",
      "cdc.update",
    ]);
    const create = cdcTools.find((t) => t.name === "cdc.create")!;
    // An agent that assumed exactly-once would build a destination that
    // breaks on the first retry.
    expect(create.description).toContain("AT-LEAST-ONCE");
    expect((create.inputSchema as any).properties.destination.enum).toEqual([...CDC_DESTINATIONS]);
    const update = cdcTools.find((t) => t.name === "cdc.update")!;
    expect(update.description).toContain("resetCursor");
  });

  test("the SDK points at routes that exist", async () => {
    const { makeCdc } = await import("../../../packages/client/src/clients/cdc");
    const calls: string[] = [];
    const core = {
      request: async (method: string, path: string) => {
        calls.push(`${method} ${path}`);
        return {} as never;
      },
    } as never;
    const cdc = makeCdc(core);
    await cdc.list();
    await cdc.create({} as never);
    await cdc.update(id, {});
    await cdc.run(id);
    await cdc.delete(id);
    expect(calls).toEqual([
      `GET ${BASE}`,
      `POST ${BASE}`,
      `PATCH ${BASE}/${id}`,
      `POST ${BASE}/${id}/run`,
      `DELETE ${BASE}/${id}`,
    ]);
    for (const path of [BASE, `${BASE}/${id}/run`]) {
      const res = await h.fetch(path, path.endsWith("/run") ? { method: "POST" } : undefined);
      expect(res.status).not.toBe(404);
    }
  });

  test("the routes are admin-only", async () => {
    const anon = (path: string, init?: RequestInit) =>
      h.app.request(
        path,
        { ...init, headers: { origin: "http://localhost:5173" } } as RequestInit,
        h.env,
      );
    expect((await anon(BASE)).status).toBeGreaterThanOrEqual(400);
    expect((await anon(BASE, { method: "POST" })).status).toBeGreaterThanOrEqual(400);
    expect(
      (await anon(`${BASE}/${id}/run`, { method: "POST" })).status,
    ).toBeGreaterThanOrEqual(400);
  });
});
