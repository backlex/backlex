/**
 * Feature flags / remote config: enable/disable, remote-config value, rollout %,
 * condition targeting (against the caller-context row), per-tenant override of a
 * global default, and the admin-only CRUD gate.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const JSON_HEADERS = { "Content-Type": "application/json" };

describe("Feature flags", () => {
  let h: TestHarness;
  let adminEmail: string;

  const setFlag = (key: string, body: unknown, scope?: "global") =>
    h.fetch(`/api/admin/feature-flags/${key}${scope ? "?scope=global" : ""}`, {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });

  const evalFlags = async (): Promise<Record<string, { enabled: boolean; value: unknown }>> => {
    const r = await h.fetch("/api/flags");
    expect(r.status).toBe(200);
    return ((await r.json()) as { data: Record<string, { enabled: boolean; value: unknown }> }).data;
  };

  beforeAll(async () => {
    h = makeHarness();
    const adm = await seedAdmin(h);
    adminEmail = adm.email;
  });
  afterAll(() => h.cleanup());

  test("enabled flag with a value evaluates on; disabled is off", async () => {
    expect((await setFlag("alpha", { enabled: true, value: { x: 1 } })).status).toBe(200);
    expect((await setFlag("beta", { enabled: false, value: "nope" })).status).toBe(200);
    const f = await evalFlags();
    expect(f.alpha!.enabled).toBe(true);
    expect(f.alpha!.value).toEqual({ x: 1 });
    expect(f.beta!.enabled).toBe(false);
    expect(f.beta!.value).toBe(null); // value withheld when off
  });

  test("rollout 0 is off, rollout 100 is on", async () => {
    await setFlag("roll0", { enabled: true, rules: { rollout: 0 } });
    await setFlag("roll100", { enabled: true, rules: { rollout: 100 } });
    const f = await evalFlags();
    expect(f.roll0!.enabled).toBe(false);
    expect(f.roll100!.enabled).toBe(true);
  });

  test("condition targeting matches the caller context", async () => {
    await setFlag("admins_only", {
      enabled: true,
      rules: { condition: { email: { _eq: adminEmail } } },
    });
    // admin matches
    expect((await evalFlags()).admins_only!.enabled).toBe(true);

    // a different (authenticated, non-admin) user does not
    await h.fetch("/api/auth/sign-out", { method: "POST" });
    await h.fetch("/api/auth/sign-up/email", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ email: `viewer-${Date.now()}@example.test`, password: "correct-horse-battery", name: "V" }),
    });
    const f = await evalFlags();
    expect(f.admins_only!.enabled).toBe(false);
    expect(f.alpha!.enabled).toBe(true); // unconditional flag still on for everyone

    // non-admin cannot manage flags
    const forbidden = await setFlag("hack", { enabled: true });
    expect(forbidden.status).toBe(403);
  });

  test("a per-tenant row overrides the global default", async () => {
    // sign back in as admin
    await h.fetch("/api/auth/sign-out", { method: "POST" });
    await h.fetch("/api/auth/sign-in/email", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ email: adminEmail, password: "correct-horse-battery" }),
    });
    // global default OFF, workspace override ON
    await setFlag("region", { enabled: false, value: "global" }, "global");
    await setFlag("region", { enabled: true, value: "ws" });
    const f = await evalFlags();
    expect(f.region!.enabled).toBe(true);
    expect(f.region!.value).toBe("ws");
  });

  test("delete removes a flag from evaluation", async () => {
    expect((await evalFlags()).alpha).toBeTruthy();
    const del = await h.fetch("/api/admin/feature-flags/alpha", { method: "DELETE" });
    expect(del.status).toBe(200);
    expect((await evalFlags()).alpha).toBeUndefined();
  });
});
