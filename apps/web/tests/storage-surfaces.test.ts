/**
 * Multi-surface parity for object storage.
 *
 * A key may contain slashes, and that one fact is what most of this pins. It
 * makes every storage route a catch-all, which is why the signing endpoint is
 * a sentinel PREFIX (`POST /_sign/:key`) rather than a `/sign` suffix — a
 * literal suffix beside sibling catch-alls falls through to the greedy matcher
 * and 404s on any key of three segments or more.
 *
 * What this file deliberately does NOT cover yet: `signUrl` and `url`, which
 * have no SDK method at all. `sdk-surfaces.test.ts` carries that gap as a
 * declared, dated entry, and this file grows the assertions when the entry is
 * deleted.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { storageTools } from "../src/server/mcp/tools/storage";
import { createClient } from "../../../packages/client/src/index";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const JSON_HEADERS = { "content-type": "application/json" };
const DEEP_KEY = "invoices/2026/q1/summary.txt";

describe("storage — surfaces", () => {
  let h: TestHarness;
  let client: ReturnType<typeof createClient>;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    client = createClient({ url: "", fetch: h.fetch as unknown as typeof fetch });
  });

  afterAll(() => h.close?.());

  test("SDK: a multi-segment key survives put, list, download and delete", async () => {
    await client.storage.put(DEEP_KEY, "parity", "text/plain");

    const listed = await client.storage.list("invoices/");
    expect(listed.data.some((o) => o.key === DEEP_KEY)).toBe(true);

    const got = await client.storage.download(DEEP_KEY);
    expect(got.status).toBe(200);
    expect(await got.text()).toBe("parity");

    expect((await client.storage.delete(DEEP_KEY)).ok).toBe(true);
    const after = await client.storage.list("invoices/");
    expect(after.data.some((o) => o.key === DEEP_KEY)).toBe(false);
  });

  test("SDK: a prefix narrows the listing rather than filtering it client-side", async () => {
    await client.storage.put("a/one.txt", "1", "text/plain");
    await client.storage.put("b/two.txt", "2", "text/plain");

    const onlyA = await client.storage.list("a/");
    expect(onlyA.data.map((o) => o.key)).toEqual(["a/one.txt"]);
  });

  test("MCP: the five tools an agent gets — including the signing one the SDK lacks", () => {
    expect(storageTools.map((t) => t.name).sort()).toEqual([
      "storage.delete",
      "storage.get",
      "storage.list",
      "storage.sign_url",
      "storage.upload",
    ]);
  });

  test("the SDK points at routes that exist", async () => {
    const calls: string[] = [];
    const spy = {
      request: async (m: string, p: string) => {
        calls.push(`${m} ${p}`);
        return { data: [] };
      },
      requestRaw: async (m: string, p: string) => {
        calls.push(`${m} ${p}`);
        return new Response("");
      },
      fetch: async (p: string, init?: { method?: string }) => {
        calls.push(`${init?.method ?? "GET"} ${p}`);
        return new Response("");
      },
    };
    const { makeStorage } = await import("../../../packages/client/src/clients/storage");
    const storage = makeStorage(spy as never);
    await storage.list("a/");
    await storage.delete("a/one.txt");

    // Dispatched for real. A 404 here means the SDK names a path nobody
    // registered — the class of bug that typechecks perfectly and surfaces
    // only in a consumer's terminal.
    for (const call of calls) {
      const [method, path] = call.split(" ") as [string, string];
      const res = await h.fetch(path, { method, headers: JSON_HEADERS });
      expect(`${call} → ${res.status}`).not.toContain("404");
    }
    expect(calls.length).toBeGreaterThan(0);
  });

  test("the signing route answers on the prefix form, and only that form", async () => {
    await client.storage.put(DEEP_KEY, "sign-me", "text/plain");

    const prefix = await h.fetch(`/api/storage/_sign/${DEEP_KEY}`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ ttlSeconds: 300 }),
    });
    expect(prefix.status).toBe(200);
    const { url } = (await prefix.json()) as { url: string };
    expect(url).toContain("token=");

    // The form the OpenAPI registration and the docs used to advertise. Kept
    // as an assertion so nobody "tidies" the sentinel away again.
    const suffix = await h.fetch(`/api/storage/${DEEP_KEY}/sign`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ ttlSeconds: 300 }),
    });
    expect(suffix.status).toBe(404);
  });

  test("a signed URL authorises the one object it names and no other", async () => {
    await client.storage.put(DEEP_KEY, "sign-me", "text/plain");
    await client.storage.put("a/one.txt", "1", "text/plain");

    const signed = (await (
      await h.fetch(`/api/storage/_sign/${DEEP_KEY}`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ ttlSeconds: 300 }),
      })
    ).json()) as { url: string };

    // The token really does open its own object — without this, the refusal
    // below could just as well be a missing file or a broken URL, and the
    // assertion would pass for a reason that has nothing to do with signing.
    expect((await h.fetch(signed.url)).status).toBe(200);

    // Pointed at a DIFFERENT key that definitely exists. The signature covers
    // the path, so borrowing a token for another object must fail — if it
    // succeeded, one signed link would open the whole bucket.
    const borrowed = signed.url.replace(DEEP_KEY, "a/one.txt");
    expect((await h.fetch(borrowed)).status).toBeGreaterThanOrEqual(400);
  });
});
