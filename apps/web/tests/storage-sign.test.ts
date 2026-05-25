/**
 * Regression: `POST /api/storage/_sign/<key>` must work at every key depth.
 *
 * `@hono/zod-openapi`'s router has a quirk where a literal-suffix route
 * (`/:key{.+}/sign`) misses on 3+ segment catch-all keys when sibling
 * `/:key{.+}` routes exist on the same app — even when sign is registered
 * first or moved into a sub-app. Plain Hono routes both shapes fine; the
 * regression is specific to the OpenAPIHono dispatcher. We moved the sign
 * endpoint to a SENTINEL-PREFIX form (`POST /_sign/:key{.+}`), which has
 * no path-ambiguity with the catch-alls, so the matcher routes it
 * correctly at any depth.
 *
 * Don't revert to the suffix shape — these cases will fail again at 3+
 * segments and there is no known suffix-shape workaround.
 */
import { describe, test, expect, afterAll, beforeAll } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

describe("storage.sign — multi-segment keys", () => {
  let h: TestHarness;
  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  const cases = [
    "single.txt",
    "one/two.txt",
    "one/two/three.txt",
    "one/two/three/four.txt",
    "photos/2024/spring/beach.jpg",
  ];

  for (const key of cases) {
    test(`PUT + POST sign for ${key.split("/").length}-segment key`, async () => {
      const put = await h.fetch(`/api/storage/${key}`, {
        method: "PUT",
        headers: { "content-type": "text/plain" },
        body: "regression-test",
      });
      expect(put.status).toBe(201);

      const sign = await h.fetch(`/api/storage/_sign/${key}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ttlSeconds: 300 }),
      });
      expect(sign.status).toBe(200);
      const body = (await sign.json()) as { url?: string; expiresAt?: string };
      expect(typeof body.url).toBe("string");
      expect(body.url).toContain("token=");
      expect(typeof body.expiresAt).toBe("string");
    });
  }
});
