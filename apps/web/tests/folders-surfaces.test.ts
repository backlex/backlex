/**
 * Multi-surface parity for file folders.
 *
 * The invariant, and the reason folders are modelled the way they are: a
 * folder is METADATA, not a key prefix. An object's key is whatever it was
 * uploaded as, and `folderId` says where it is filed. So renaming a folder
 * moves nothing and breaks no URL, and **deleting a folder does not delete the
 * files in it** — it unfiles them. Destroying files is `storage.delete`, which
 * is deliberately a separate decision made by a separate call.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { foldersTools } from "../src/server/mcp/tools/folders";
import { createClient } from "../../../packages/client/src/index";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const JSON_HEADERS = { "content-type": "application/json" };
const BASE = "/api/folders";

describe("folders — surfaces", () => {
  let h: TestHarness;
  let client: ReturnType<typeof createClient>;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    client = createClient({ url: "", fetch: h.fetch as unknown as typeof fetch });
  });

  afterAll(() => h.cleanup?.());

  test("SDK: create, nest, rename, list", async () => {
    const parent = await client.folders.create({ name: "Invoices" });
    expect(parent.data.parentId).toBeNull();

    const child = await client.folders.create({ name: "2026", parentId: parent.data.id });
    expect(child.data.parentId).toBe(parent.data.id);

    expect((await client.folders.update(child.data.id, { name: "2026 Q1" })).ok).toBe(true);

    const listed = await client.folders.list();
    expect(listed.data.find((f) => f.id === child.data.id)?.name).toBe("2026 Q1");
    // Flat, with `parentId` as the tree — a nested response would make every
    // consumer walk a shape they did not ask for.
    expect(listed.data.some((f) => f.id === parent.data.id)).toBe(true);
    expect(listed.data.some((f) => f.id === child.data.id && f.parentId === parent.data.id)).toBe(
      true,
    );
  });

  test("deleting a folder unfiles its contents rather than destroying them", async () => {
    const folder = await client.folders.create({ name: "Temporary" });

    await client.storage.put("reports/keep-me.txt", "important", "text/plain");
    const filed = await h.fetch("/api/storage/reports/keep-me.txt", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ folderId: folder.data.id }),
    });
    expect(filed.status).toBeLessThan(300);

    expect((await client.folders.delete(folder.data.id)).ok).toBe(true);

    // The file is still there. A folder is a label; removing the label is not
    // a decision to destroy what was wearing it.
    const still = await client.storage.download("reports/keep-me.txt");
    expect(still.status).toBe(200);
    expect(await still.text()).toBe("important");

    const listed = await client.folders.list();
    expect(listed.data.some((f) => f.id === folder.data.id)).toBe(false);
  });

  test("deleting a folder promotes its children rather than orphaning them", async () => {
    const grandparent = await client.folders.create({ name: "Archive" });
    const parent = await client.folders.create({
      name: "2025",
      parentId: grandparent.data.id,
    });
    const child = await client.folders.create({ name: "Q4", parentId: parent.data.id });

    expect((await client.folders.delete(parent.data.id)).ok).toBe(true);

    // `folders.parent_id` carries no constraint in either dialect, so nothing
    // in the database would have noticed the subtree losing its parent — it
    // would simply have stopped appearing under anything.
    const listed = await client.folders.list();
    expect(listed.data.find((f) => f.id === child.data.id)?.parentId).toBe(grandparent.data.id);
  });

  test("MCP: the three tools an agent gets", () => {
    expect(foldersTools.map((t) => t.name).sort()).toEqual([
      "folders.create",
      "folders.delete",
      "folders.list",
    ]);
  });

  test("the SDK points at routes that exist", async () => {
    const live = await client.folders.create({ name: "Probe target" });

    const calls: string[] = [];
    const spy = {
      request: async (m: string, p: string) => {
        calls.push(`${m} ${p}`);
        return { data: [] };
      },
    };
    const { makeFolders } = await import("../../../packages/client/src/clients/folders");
    const folders = makeFolders(spy as never);
    await folders.list();
    await folders.create({ name: "x" });
    await folders.update(live.data.id, { name: "y" });
    await folders.delete(live.data.id);
    expect(calls).toEqual([
      `GET ${BASE}`,
      `POST ${BASE}`,
      `PATCH ${BASE}/${live.data.id}`,
      `DELETE ${BASE}/${live.data.id}`,
    ]);

    // Dispatched for real against the LIVE id.
    for (const call of calls) {
      const [method, path] = call.split(" ") as [string, string];
      const res = await h.fetch(path, {
        method,
        headers: JSON_HEADERS,
        ...(method === "POST" || method === "PATCH"
          ? { body: JSON.stringify({ name: "probe" }) }
          : {}),
      });
      expect(`${call} → ${res.status}`).not.toContain("404");
    }
  });
});
