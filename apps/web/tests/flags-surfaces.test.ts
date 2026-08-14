/**
 * Multi-surface parity for feature flags.
 *
 * The invariant this exists to hold: the two families answer different
 * questions. `/api/admin/feature-flags` returns the RULES — targeting
 * expressions, rollout percentages, the description an operator wrote — and
 * `/api/flags` returns only what those rules EVALUATED TO for the caller
 * asking. An application that could read the rules could work out who else is
 * in a rollout, so the app-plane surface must never grow a rules field.
 *
 * The SDK's session cache is pinned here too, because it is a behaviour a
 * consumer notices rather than an implementation detail: `get()` after
 * `all()` does not re-fetch, so a flag flipped server-side is invisible until
 * `{ refresh: true }`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { featureFlagsTools } from "../src/server/mcp/tools/feature-flags";
import { createClient } from "../../../packages/client/src/index";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const JSON_HEADERS = { "content-type": "application/json" };
const ADMIN = "/api/admin/feature-flags";

describe("feature flags — surfaces", () => {
  let h: TestHarness;
  let client: ReturnType<typeof createClient>;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    client = createClient({ url: "", fetch: h.fetch as unknown as typeof fetch });

    const res = await h.fetch(`${ADMIN}/new-checkout`, {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        enabled: true,
        value: { variant: "b" },
        description: "parity fixture",
      }),
    });
    expect(res.status).toBe(200);
  });

  afterAll(() => h.close?.());

  test("REST: the admin family holds the rules, the app family holds the verdict", async () => {
    const admin = (await (await h.fetch(ADMIN)).json()) as { data: unknown[] };
    expect(Array.isArray(admin.data)).toBe(true);

    const evaluated = (await (await h.fetch("/api/flags")).json()) as {
      data: Record<string, { enabled: boolean; value?: unknown }>;
    };
    const flag = evaluated.data["new-checkout"];
    expect(flag?.enabled).toBe(true);
    expect(flag?.value).toEqual({ variant: "b" });

    // The app plane is told the answer, never how it was reached. `rules` is
    // the field that would leak the shape of the audience.
    expect(JSON.stringify(evaluated.data)).not.toContain("rules");
  });

  test("MCP: the three tools an agent gets", () => {
    expect(featureFlagsTools.map((t) => t.name).sort()).toEqual([
      "flags.list",
      "flags.remove",
      "flags.set",
    ]);
  });

  test("the SDK points at routes that exist", async () => {
    const calls: string[] = [];
    const spy = {
      request: async (m: string, p: string) => {
        calls.push(`${m} ${p}`);
        return {};
      },
    };
    const { makeFlags } = await import("../../../packages/client/src/clients/flags");
    await makeFlags(spy as never).all();
    expect(calls).toEqual(["GET /api/flags"]);

    // Dispatched for real, so a path nobody registered fails here rather than
    // in a consumer's terminal.
    for (const call of calls) {
      const [method, path] = call.split(" ") as [string, string];
      expect((await h.fetch(path, { method })).status).not.toBe(404);
    }
  });

  test("SDK: the evaluated map, and a resolved value out of it", async () => {
    expect(await client.flags.isEnabled("new-checkout")).toBe(true);
    expect(await client.flags.get("new-checkout")).toEqual({ variant: "b" });
    // A flag nobody declared is off and undefined — never a throw, because a
    // missing flag is the normal state before one is created.
    expect(await client.flags.isEnabled("never-declared")).toBe(false);
    expect(await client.flags.get("never-declared")).toBeUndefined();
  });

  test("SDK: the cache is a contract — a flip is unseen until `refresh`", async () => {
    await client.flags.all();

    await h.fetch(`${ADMIN}/new-checkout`, {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ enabled: false, value: { variant: "b" } }),
    });

    // Still the cached verdict: this is deliberate, so a render pass cannot
    // have one flag change value halfway down the tree.
    expect(await client.flags.isEnabled("new-checkout")).toBe(true);
    expect(await client.flags.isEnabled("new-checkout", { refresh: true })).toBe(false);
  });
});
