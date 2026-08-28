/**
 * Storing an LDAP config that this runtime can never execute has to SAY so.
 *
 * `PUT /api/admin/ldap-config` accepted a complete config with `enabled: true`
 * on a Cloudflare Workers tenant and answered a bare `{"ok":true}`. LDAP needs
 * a raw TCP socket, which no V8-isolate edge provides — `isEdgeRuntime()`
 * already existed and was consulted at sign-in and by `/test`, just not at
 * write time. An operator who configured LDAP and did not press Test believed
 * SSO was on. Measured on a live managed tenant, 2026-08-27.
 *
 * A warning and not a refusal, on purpose: the row is portable, and the same
 * config is correct the moment the workspace is served from a Bun or Node
 * deployment. What is not acceptable is answering as though it took effect.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const JSON_HEADERS = { "Content-Type": "application/json" };

const asEdgeRuntime = <T>(fn: () => Promise<T>): Promise<T> => {
  const g = globalThis as { EdgeRuntime?: unknown };
  const had = "EdgeRuntime" in g;
  const prior = g.EdgeRuntime;
  g.EdgeRuntime = "vercel-edge";
  return fn().finally(() => {
    if (had) g.EdgeRuntime = prior;
    else delete g.EdgeRuntime;
  });
};

describe("LDAP config on a runtime that cannot run it", () => {
  let h: TestHarness;

  const put = (body: unknown, path = "/api/admin/ldap-config") =>
    h.fetch(path, { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify(body) });

  const config = (enabled: boolean) => ({
    enabled,
    url: "ldaps://dc.example.test:636",
    bindDn: "cn=svc,dc=example,dc=test",
    baseDn: "dc=example,dc=test",
    secrets: { bindPassword: "hunter2" },
  });

  beforeEach(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterEach(() => h.cleanup());

  test("enabling it on an edge runtime is stored, and said out loud", async () => {
    const body = await asEdgeRuntime(async () => {
      const res = await put(config(true));
      expect(res.status).toBe(200);
      return (await res.json()) as { ok: boolean; warning?: string };
    });

    expect(body.ok).toBe(true);
    expect(body.warning).toBeDefined();
    // It must name the runtime constraint AND the way out, because the
    // operator's next question is "so what do I use instead".
    expect(body.warning).toContain("TCP");
    expect(body.warning).toContain("SAML");

    // Stored, not refused: the row is portable to a Bun/Node self-host.
    const read = (await (await h.fetch("/api/admin/ldap-config")).json()) as {
      data: { enabled: boolean };
    };
    expect(read.data.enabled).toBe(true);
  });

  test("it stays quiet when there is nothing to warn about", async () => {
    // Disabled on an edge runtime: nothing was promised, so nothing is owed.
    const off = await asEdgeRuntime(async () =>
      (await (await put(config(false))).json()) as { warning?: string },
    );
    expect(off.warning).toBeUndefined();

    // Enabled on a runtime that CAN run it: this is just a working config.
    const on = (await (await put(config(true))).json()) as { warning?: string };
    expect(on.warning).toBeUndefined();
  });

  test("the platform-plane config carries the same warning", async () => {
    const body = await asEdgeRuntime(async () =>
      (await (await put(config(true), "/api/admin/platform-ldap-config")).json()) as {
        ok: boolean;
        warning?: string;
      },
    );
    expect(body.ok).toBe(true);
    expect(body.warning).toContain("TCP");
  });
});
