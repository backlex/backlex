/**
 * Sandbox policy narrowed from "one operator decision for the whole
 * deployment" to something the data model can actually key on. #335.
 *
 * Two findings, one shape. `functions` recorded `tenant_id` and no author, so
 * `FUNCTIONS_SANDBOX=bun-worker` had to grant host access to every function on
 * the instance — on a multi-tenant self-host, "author a function" and "run
 * commands on the API host" were the same permission. And
 * `FUNCTIONS_FETCH_ALLOW` is deployment-wide, so one operator decision bound
 * every tenant and a host could not let workspace A reach a partner API that
 * workspace B must not.
 *
 * The decision functions are exported and driven directly here as well as
 * end-to-end. A rule reachable only through a live Bun worker is a rule nobody
 * writes the negative case for, which is how the `file:` scheme hole in the
 * fetch allow-list survived — that lesson is in `host-bridge.ts`'s own
 * docblock and this file is written to it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import { resolveFetchAllow, parseHostList } from "../src/server/services/sandbox/host-bridge";
import { softSandboxAllowed } from "../src/server/services/sandbox";
import type { SandboxBindings } from "../src/server/services/sandbox";

const J = { "content-type": "application/json" };
const body = (o: unknown): RequestInit => ({ method: "POST", headers: J, body: JSON.stringify(o) });

describe("a workspace narrows the deployment fetch allow-list, and can never widen it", () => {
  test("no workspace choice inherits the deployment list unchanged", () => {
    // `null` is what every existing workspace has, so this is the assertion
    // that says the feature changed nothing for them.
    expect(resolveFetchAllow(["api.example.com"], null)).toEqual(["api.example.com"]);
    expect(resolveFetchAllow(["api.example.com"], undefined)).toEqual(["api.example.com"]);
  });

  test("an EMPTY list is a choice, and it means no outbound fetch", () => {
    // The distinction the setting is nullable for. `[]` defaulting to "inherit"
    // would make "turn this workspace's fetch off" unexpressible.
    expect(resolveFetchAllow(["api.example.com"], [])).toEqual([]);
  });

  test("a workspace entry survives only if the ceiling already covered it", () => {
    expect(resolveFetchAllow(["example.com", "other.test"], ["example.com"])).toEqual([
      "example.com",
    ]);
    // A subdomain of a permitted host is a NARROWING — `isAllowedFetch` already
    // admits it under the parent, so keeping it takes hosts away rather than
    // adding any.
    expect(resolveFetchAllow(["example.com"], ["api.example.com"])).toEqual(["api.example.com"]);
    // Anything else is dropped, not refused: a stale entry left over from a
    // tightened ceiling must not take the rest of the list down with it.
    expect(resolveFetchAllow(["example.com"], ["evil.test", "api.example.com"])).toEqual([
      "api.example.com",
    ]);
  });

  test("`*` on the workspace side means the deployment's list, not everything", () => {
    // The whole point. A workspace admin writing one character must not undo
    // the ceiling the setting exists to enforce.
    expect(resolveFetchAllow(["api.example.com"], ["*"])).toEqual(["api.example.com"]);
    expect(resolveFetchAllow([], ["*"])).toEqual([]);
    // `*` on the DEPLOYMENT side is the dev-only escape hatch, and there the
    // workspace list is the only thing narrowing anything.
    expect(resolveFetchAllow(["*"], ["api.example.com"])).toEqual(["api.example.com"]);
  });

  test("a deployment that permits nothing cannot be opened from a workspace", () => {
    expect(resolveFetchAllow([], ["api.example.com"])).toEqual([]);
  });

  test("the env list is parsed the way it is written", () => {
    expect(parseHostList(" a.test , b.test ,, ")).toEqual(["a.test", "b.test"]);
    expect(parseHostList(undefined)).toEqual([]);
  });
});

describe("the soft sandbox is decided per AUTHOR", () => {
  const bindings = (
    authorKind: "operator" | "tenant" | null,
    env: Record<string, string> = {},
  ): SandboxBindings =>
    ({ ctx: { env }, auth: {}, authorKind, functionName: "probe" }) as unknown as SandboxBindings;

  test("a tenant-authored function is refused it", () => {
    expect(softSandboxAllowed(bindings("tenant"))).toBe(false);
  });

  test("an operator-authored one keeps it", () => {
    expect(softSandboxAllowed(bindings("operator"))).toBe(true);
  });

  test("a row that predates the column keeps it — the backfill decision", () => {
    // Treating unknown as untrusted would break every existing function on an
    // upgrade: `quickjs` has no host I/O at all. It warns instead, so the
    // residue is visible rather than guessed at.
    expect(softSandboxAllowed(bindings(null))).toBe(true);
  });

  test("TRUST_ALL_AUTHORS restores the old deployment-wide meaning", () => {
    // For the deployment whose functions are written by an automation holding
    // an API key — `isInstanceOperator` refuses a key identity by design, so
    // such a row is stamped `tenant` and would otherwise lose host access.
    expect(
      softSandboxAllowed(bindings("tenant", { FUNCTIONS_SANDBOX_TRUST_ALL_AUTHORS: "1" })),
    ).toBe(true);
    // Anything other than "1" is not the opt-out. A truthy-string check here
    // would make `FUNCTIONS_SANDBOX_TRUST_ALL_AUTHORS=0` grant the host.
    expect(
      softSandboxAllowed(bindings("tenant", { FUNCTIONS_SANDBOX_TRUST_ALL_AUTHORS: "0" })),
    ).toBe(false);
    expect(
      softSandboxAllowed(bindings("tenant", { FUNCTIONS_SANDBOX_TRUST_ALL_AUTHORS: "true" })),
    ).toBe(false);
  });
});

describe("the author is recorded at write time, from the operator boundary", () => {
  let h: TestHarness;
  /** A workspace admin who is NOT the instance operator. */
  let tenantAdmin: { email: string; slug: string; id: string };

  const signIn = async (email: string) => {
    await h.fetch("/api/auth/sign-out", { method: "POST" });
    const res = await h.fetch(
      "/api/auth/sign-in/email",
      body({ email, password: "correct-horse-battery" }),
    );
    expect(res.status).toBe(200);
  };

  beforeAll(async () => {
    h = makeHarness({ FUNCTIONS_SANDBOX: "bun-worker" } as never);
    await seedAdmin(h, "operator-fn@example.test");

    // A second platform user with a workspace of their own. `POST /api/tenants`
    // makes them `admin` THERE — which is exactly the self-serve role that
    // `isInstanceOperator` refuses to treat as operator, and the reason the
    // deployment flag could not express the rule it wanted.
    await h.fetch("/api/auth/sign-out", { method: "POST" });
    const su = await h.fetch(
      "/api/auth/sign-up/email",
      body({ email: "tenant-fn@example.test", password: "correct-horse-battery", name: "Tenant" }),
    );
    expect(su.status).toBe(200);
    const ws = await h.fetch("/api/tenants", body({ name: "Sandbox tenant" }));
    expect(ws.status).toBe(201);
    const created = ((await ws.json()) as { data: { id: string; slug: string } }).data;
    tenantAdmin = { email: "tenant-fn@example.test", slug: created.slug, id: created.id };
  });
  afterAll(() => h.cleanup());

  const makeFn = async (name: string, code: string, tenantSlug?: string) => {
    const res = await h.fetch("/api/functions", {
      method: "POST",
      headers: { ...J, ...(tenantSlug ? { "X-Backlex-Tenant": tenantSlug } : {}) },
      body: JSON.stringify({ name, trigger: "http", timeoutMs: 3000, code }),
    });
    expect(res.status, `create ${name}`).toBe(201);
  };
  const invoke = async (name: string, tenantSlug?: string) => {
    const res = await h.fetch(`/api/functions/${name}/invoke`, {
      method: "POST",
      headers: { ...J, ...(tenantSlug ? { "X-Backlex-Tenant": tenantSlug } : {}) },
      body: "{}",
    });
    return (await res.json()) as { ok: boolean; value?: unknown; error?: string };
  };

  const PROBE = "return { bun: typeof globalThis.Bun };";

  test("the operator's function reaches the host under bun-worker", async () => {
    await signIn("operator-fn@example.test");
    await makeFn("op_probe", PROBE);
    const out = await invoke("op_probe");
    expect(out.ok).toBe(true);
    // Pinned as a CAPABILITY, matching the existing suite: this provider shares
    // the process and cannot be closed from inside, which is why it is opt-in.
    expect(out.value).toEqual({ bun: "object" });
  });

  test("a workspace admin's function does NOT, on the same deployment", async () => {
    // The finding. Before the author column, this workspace admin — a role
    // `POST /api/tenants` hands to anyone who signs up — got the same host
    // access as the operator, because the flag was the only thing that could
    // be asked.
    await signIn(tenantAdmin.email);
    await makeFn("tenant_probe", PROBE, tenantAdmin.slug);
    const out = await invoke("tenant_probe", tenantAdmin.slug);
    expect(out.ok).toBe(true);
    expect(out.value).toEqual({ bun: "undefined" });
  });

  test("an operator touching a tenant's function does not re-attribute it; re-saving the CODE does", async () => {
    // The author is whoever wrote what it RUNS. Re-stamping on any update would
    // let an operator bumping a timeout silently promote a tenant's code into
    // the soft sandbox — the exact laundering the column exists to stop.
    //
    // Re-saving the body IS the adoption path, and the refusal message says so,
    // so both halves are asserted here rather than only the safe one.
    await signIn(tenantAdmin.email);
    const invited = await h.fetch(
      `/api/tenants/${tenantAdmin.id}/members/invite`,
      body({ email: "operator-fn@example.test", role: "admin" }),
    );
    expect(invited.status, "invite the operator into the tenant's workspace").toBe(201);
    const token = ((await invited.json()) as { data: { token: string } }).data.token;

    const listed = await h.fetch("/api/functions", {
      headers: { "X-Backlex-Tenant": tenantAdmin.slug },
    });
    const rows = ((await listed.json()) as { data: { id: string; name: string }[] }).data;
    const row = rows.find((r) => r.name === "tenant_probe");
    expect(row).toBeDefined();

    await signIn("operator-fn@example.test");
    expect((await h.fetch("/api/tenants/accept", body({ token }))).status).toBe(200);

    // A non-code edit, by the operator. Still the tenant's code.
    const bumped = await h.fetch(`/api/functions/${row!.id}`, {
      method: "PATCH",
      headers: { ...J, "X-Backlex-Tenant": tenantAdmin.slug },
      body: JSON.stringify({ timeoutMs: 4000 }),
    });
    expect(bumped.status).toBe(200);
    expect((await invoke("tenant_probe", tenantAdmin.slug)).value).toEqual({ bun: "undefined" });

    // Now the operator writes the body. That is authorship, and it is how a
    // legacy or clamped function is adopted.
    const rewritten = await h.fetch(`/api/functions/${row!.id}`, {
      method: "PATCH",
      headers: { ...J, "X-Backlex-Tenant": tenantAdmin.slug },
      body: JSON.stringify({ code: PROBE }),
    });
    expect(rewritten.status).toBe(200);
    expect((await invoke("tenant_probe", tenantAdmin.slug)).value).toEqual({ bun: "object" });
  });
});

/**
 * The workspace setting is read by the RUN path, not only by a pure function.
 *
 * `resolveFetchAllow` has thorough unit coverage above, and all of it would
 * still pass if nothing called it — which is the failure mode this repo has
 * written down as "a guard that matches nothing reports success". This block
 * exists to make the wiring load-bearing.
 */
describe("the per-workspace fetch allow-list actually bounds ctx.fetch", () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = makeHarness({
      FUNCTIONS_SANDBOX: "bun-worker",
      FUNCTIONS_FETCH_ALLOW: "allowed.invalid,removed.invalid",
    } as never);
    await seedAdmin(h, "fetch-op@example.test");
  });
  afterAll(() => h.cleanup());

  /** Run a fetch and report how it failed. `.invalid` never resolves (RFC
   *  2606), so a permitted host fails on the NETWORK and a refused one fails on
   *  the allow-list — two distinguishable answers with no traffic either way. */
  const tryFetch = async (name: string, host: string): Promise<string> => {
    const created = await h.fetch(
      "/api/functions",
      body({
        name,
        trigger: "http",
        timeoutMs: 3000,
        code: `try { await ctx.fetch("https://${host}/x"); return "ok"; } catch (e) { return String(e && e.message || e); }`,
      }),
    );
    expect(created.status, `create ${name}`).toBe(201);
    const res = await h.fetch(`/api/functions/${name}/invoke`, { method: "POST", headers: J, body: "{}" });
    const out = (await res.json()) as { ok: boolean; value?: unknown; error?: string };
    return String(out.value ?? out.error ?? "");
  };

  test("with no workspace choice, both deployment hosts are permitted", async () => {
    expect(await tryFetch("f_inherit_a", "allowed.invalid")).not.toContain("allow-list");
    expect(await tryFetch("f_inherit_b", "removed.invalid")).not.toContain("allow-list");
  });

  test("narrowing the workspace list refuses the host it dropped", async () => {
    const patched = await h.fetch("/api/admin/settings", {
      method: "PATCH",
      headers: J,
      body: JSON.stringify({ functionsFetchAllow: ["allowed.invalid"] }),
    });
    expect(patched.status).toBe(200);

    expect(await tryFetch("f_narrow_a", "allowed.invalid")).not.toContain("allow-list");
    expect(await tryFetch("f_narrow_b", "removed.invalid")).toContain("not in fetch allow-list");
  });

  test("a workspace cannot widen past the deployment ceiling", async () => {
    // `*` here means "everything the deployment permits". A workspace admin
    // writing one character must not reach a host the operator excluded.
    const patched = await h.fetch("/api/admin/settings", {
      method: "PATCH",
      headers: J,
      body: JSON.stringify({ functionsFetchAllow: ["*", "elsewhere.invalid"] }),
    });
    expect(patched.status).toBe(200);
    expect(await tryFetch("f_widen", "elsewhere.invalid")).toContain("not in fetch allow-list");
  });

  test("clearing the choice with null goes back to inheriting", async () => {
    const patched = await h.fetch("/api/admin/settings", {
      method: "PATCH",
      headers: J,
      body: JSON.stringify({ functionsFetchAllow: null }),
    });
    expect(patched.status).toBe(200);
    expect(await tryFetch("f_cleared", "removed.invalid")).not.toContain("allow-list");
  });

  test("an EMPTY list switches outbound fetch off entirely", async () => {
    const patched = await h.fetch("/api/admin/settings", {
      method: "PATCH",
      headers: J,
      body: JSON.stringify({ functionsFetchAllow: [] }),
    });
    expect(patched.status).toBe(200);
    expect(await tryFetch("f_off", "allowed.invalid")).toContain("not in fetch allow-list");
  });
});
