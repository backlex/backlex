/**
 * The Workers entry's HTTP cron endpoint (`entries/worker.ts::handleCronTick`).
 *
 * A Workers-for-Platforms user Worker exports `scheduled()` but has no schedules
 * resource to hang a cron trigger on, so on a managed instance the handler is
 * present and never invoked — every periodic task silently does not run. This
 * route is how such a platform drives `cronTick` instead.
 *
 * It is reachable from the public internet on every instance that runs the
 * bundle, so the auth gate is the whole of its security surface and gets the
 * bulk of the assertions here. `cronTick`'s own behaviour is covered by
 * `scheduled-tasks.test.ts`, which drives it directly.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, type TestHarness } from "./setup";
import { handleCronTick } from "../src/server/entries/worker";
import type { Env } from "../src/server/env";

const SECRET = "s3cr3t-cron-token";

let h: TestHarness;

beforeAll(async () => {
  h = await makeHarness();
});
afterAll(() => {
  h.cleanup();
});

const envWith = (secret?: string): Env => ({ ...h.env, CRON_SECRET: secret }) as Env;

const tick = (env: Env, headers: Record<string, string> = {}) =>
  handleCronTick(new Request("https://inst.example/api/_cron/tick", { headers }), env);

describe("worker HTTP cron route", () => {
  test("closed by default — no CRON_SECRET means no caller can drive it", async () => {
    // The self-host case. Adding this route must not open anything on an
    // instance whose operator never opted in.
    const res = await tick(envWith(undefined), { "x-cron-secret": SECRET });

    expect(res.status).toBe(401);
  });

  test("an unauthenticated caller is refused", async () => {
    const res = await tick(envWith(SECRET));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  test.each([
    ["a wrong secret", { "x-cron-secret": "not-the-secret" }],
    ["a wrong bearer", { authorization: `Bearer not-the-secret` }],
    ["an empty header", { "x-cron-secret": "" }],
    // Same prefix, different length — the compare must not stop at the first
    // mismatch, and must not accept a prefix.
    ["a prefix of the secret", { "x-cron-secret": SECRET.slice(0, -1) }],
    ["the secret plus a suffix", { "x-cron-secret": `${SECRET}x` }],
  ])("%s is refused", async (_label, headers) => {
    const res = await tick(envWith(SECRET), headers);

    expect(res.status).toBe(401);
  });

  test("the shared secret drives a tick, via either header", async () => {
    for (const headers of [{ "x-cron-secret": SECRET }, { authorization: `Bearer ${SECRET}` }]) {
      const res = await tick(envWith(SECRET), headers);

      expect(res.status).toBe(200);
      expect((await res.json()) as { ok: boolean }).toMatchObject({ ok: true });
    }
  });
});
