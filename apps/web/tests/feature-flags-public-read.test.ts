/**
 * Two things a rollout percentage needs in order to be a rollout, both found
 * missing on a live workspace on 2026-08-27.
 *
 * 1. **A page that is not the workspace's own must be able to read the map.**
 *    The credentialed CORS policy answered a non-allowlisted caller with an
 *    `ACAO` of the workspace's OWN host, so a customer's marketing page —
 *    precisely the caller `docs/feature-flags.md` sells this route to — was
 *    blocked by the browser. The tag file at `/api/site/<id>.js` already
 *    answered `*`; flags never got the same treatment.
 *
 * 2. **A logged-out visitor must be able to fall on either side of it.**
 *    Bucketing fell back to the literal string `"anon"`, so every anonymous
 *    caller on earth hashed to ONE bucket per key: measured live, the flag was
 *    off for everybody at rollout 67 and on for everybody at 68. A step
 *    function, not a split — and an A/B test on a public page has no other
 *    kind of caller.
 *
 * The two halves are one test file because they are one bug from the
 * operator's seat: "I set a 50% rollout on my landing page and nothing
 * happened."
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const JSON_HEADERS = { "Content-Type": "application/json" };
const FOREIGN = "https://dealer.example.com";

describe("feature flags: the public read path", () => {
  let h: TestHarness;

  const setFlag = (key: string, body: unknown) =>
    h.fetch(`/api/admin/feature-flags/${key}`, {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });

  /** Anonymous, cross-origin — a browser on the customer's own domain. */
  const readAs = (origin: string | null, bucket?: string) =>
    h.app.fetch(
      new Request(`${h.env.APP_URL}/api/flags${bucket ? `?bucket=${encodeURIComponent(bucket)}` : ""}`, {
        headers: origin ? { Origin: origin } : {},
      }),
    );

  const enabledFor = async (key: string, bucket?: string): Promise<boolean> => {
    const res = await readAs(FOREIGN, bucket);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, { enabled: boolean }> };
    return body.data[key]?.enabled === true;
  };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  test("a foreign origin can read the map, uncredentialed", async () => {
    await setFlag("public_banner", { enabled: true, value: { copy: "hello" } });
    const res = await readAs(FOREIGN);

    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    // `*` and credentials are mutually exclusive; a browser rejects a response
    // that claims both, so this header must be GONE, not merely false.
    expect(res.headers.get("access-control-allow-credentials")).toBe(null);
    // The body is per-caller and now cacheable by anything in between.
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  test("the workspace's own origin keeps its credentialed answer", async () => {
    const res = await readAs(h.env.APP_URL as string);
    expect(res.status).toBe(200);
    // Same-origin: the ACAO must NOT be widened to `*`, because that would
    // break every credentialed caller the route already served.
    expect(res.headers.get("access-control-allow-origin")).not.toBe("*");
  });

  test("two different visitors are not forced into the same bucket", async () => {
    // 50 is the sharpest test: a working hash puts roughly half of any set of
    // ids on each side, while the old `"anon"` fallback put ALL of them on one.
    await setFlag("half", { enabled: true, rules: { rollout: 50 } });

    const ids = Array.from({ length: 40 }, (_, i) => `visitor-${i}`);
    const results = await Promise.all(ids.map((id) => enabledFor("half", id)));
    const on = results.filter(Boolean).length;

    expect(on).toBeGreaterThan(0);
    expect(on).toBeLessThan(ids.length);
  });

  test("the same visitor gets the same answer every time", async () => {
    await setFlag("sticky", { enabled: true, rules: { rollout: 50 } });
    const first = await enabledFor("sticky", "visitor-7");
    for (let i = 0; i < 4; i++) {
      expect(await enabledFor("sticky", "visitor-7")).toBe(first);
    }
  });

  test("a caller with no identity at all is outside a partial rollout", async () => {
    await setFlag("nobody", { enabled: true, rules: { rollout: 99 } });
    // Not a coin flip: a re-decided answer would flicker on every page load,
    // which is worse than an A/B test that never starts. 100 is still everyone.
    expect(await enabledFor("nobody")).toBe(false);
    await setFlag("everyone", { enabled: true, rules: { rollout: 100 } });
    expect(await enabledFor("everyone")).toBe(true);
  });

  test("saving a partial rollout says out loud who it cannot reach", async () => {
    const res = await setFlag("warned", { enabled: true, rules: { rollout: 25 } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { warning?: string };
    expect(body.warning).toContain("bucket");

    // ...and does not cry wolf on the two settings that reach everyone.
    for (const rollout of [0, 100]) {
      const quiet = (await (await setFlag(`quiet_${rollout}`, { enabled: true, rules: { rollout } })).json()) as {
        warning?: string;
      };
      expect(quiet.warning).toBeUndefined();
    }
  });
});
