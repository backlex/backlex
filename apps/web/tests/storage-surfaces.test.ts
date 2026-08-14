/**
 * Multi-surface parity for object storage.
 *
 * A key may contain slashes, and that one fact is what most of this pins. It
 * makes every storage route a catch-all, which is why the signing endpoint is
 * a sentinel PREFIX (`POST /_sign/:key`) rather than a `/sign` suffix — a
 * literal suffix beside sibling catch-alls falls through to the greedy matcher
 * and 404s on any key of three segments or more.
 *
 * `url()` is a pure string builder and is compared byte for byte against a
 * hand-written string. That is the assertion that would have caught the
 * signing path shipping as `/{key}/sign` for months: a URL the SDK composes is
 * never exercised by a round trip, so nothing else notices when its shape
 * drifts from the route's.
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
      // Asserts the STATUS, and keeps `call` in the failure output so a real
      // miss still names the route. It used to substring-match the rendered
      // line for "404" — which a UUID like `…-4047-…` satisfies on its own, so
      // every one of these files failed a few runs in a hundred for no reason.
      expect({ call, status: res.status }).not.toMatchObject({ status: 404 });
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

  test("`url()` composes the path by hand, and the bytes are pinned", () => {
    const built = createClient({ url: "https://api.test", fetch: h.fetch as never });

    // Byte comparison against a string written out in full. A round trip would
    // pass against almost any shape; this is what notices a drift.
    expect(built.storage.url(DEEP_KEY)).toBe(
      "https://api.test/api/storage/invoices/2026/q1/summary.txt",
    );
    expect(built.storage.url(DEEP_KEY, { width: 320, format: "webp" })).toBe(
      "https://api.test/api/storage/invoices/2026/q1/summary.txt?width=320&format=webp",
    );

    // Slashes survive because the route is a catch-all; everything else is
    // escaped, so a key containing `?` cannot become a query string.
    expect(built.storage.url("odd keys/a?b#c.txt")).toBe(
      "https://api.test/api/storage/odd%20keys/a%3Fb%23c.txt",
    );

    // A dot segment is REFUSED, not escaped, and the difference is the whole
    // point: `encodeURIComponent` leaves `..` alone, and percent-encoding it
    // does not help either, because the URL standard normalizes dot segments
    // AFTER percent-decoding. Proven here rather than asserted, so nobody
    // "fixes" the refusal by encoding:
    expect(new URL("https://api.test/api/storage/%2E%2E/%2E%2E/admin").pathname).toBe("/admin");

    // So a key that cannot be addressed is reported as such, instead of
    // composing a link that quietly points outside `/api/storage/`.
    expect(() => built.storage.url("a/../../etc/passwd")).toThrow();
    expect(() => built.storage.url("a/./b.txt")).toThrow();
    expect(() => built.storage.signUrl("../../admin")).toThrow();

    // A dot INSIDE a segment is ordinary and stays ordinary.
    expect(built.storage.url("a/..hidden.txt")).toBe(
      "https://api.test/api/storage/a/..hidden.txt",
    );
  });

  test("`url()` issues no request — it is what goes straight into an `<img src>`", async () => {
    let calls = 0;
    const counted = createClient({
      url: "https://api.test",
      fetch: (async () => {
        calls++;
        return new Response("{}");
      }) as unknown as typeof fetch,
    });
    counted.storage.url(DEEP_KEY, { width: 100 });
    // Fetching bytes into a blob is exactly what an application does without
    // this method, and it costs the browser's cache, lazy loading, and the
    // transform itself.
    expect(calls).toBe(0);
  });

  test("`signUrl` reaches the prefix route and its URL actually serves", async () => {
    await client.storage.put(DEEP_KEY, "signed", "text/plain");
    const signed = await client.storage.signUrl(DEEP_KEY, 300);

    expect(signed.url).toContain("token=");
    expect(typeof signed.expiresAt).toBe("string");

    const res = await h.fetch(signed.url);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("signed");
  });

  test("`update`, `folderCounts` and `fromUrl` point at routes that answer", async () => {
    await client.storage.put("counted/one.txt", "1", "text/plain");

    const counts = await client.storage.folderCounts();
    expect(typeof counts.total).toBe("number");
    expect(counts.total).toBeGreaterThan(0);

    // `update` changes visibility/filing rather than bytes.
    await client.storage.update("counted/one.txt", { acl: "private" });

    // `fromUrl` fetches server-side and is SSRF-guarded, so a loopback target
    // is refused rather than followed — the guard is the feature.
    await expect(
      client.storage.fromUrl({ url: "http://169.254.169.254/latest/meta-data/" }),
    ).rejects.toBeDefined();
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
