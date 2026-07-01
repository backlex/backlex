/**
 * Functions feature — CRUD + real sandboxed execution.
 *
 * The invoke path runs on the REAL bun-worker sandbox provider (a fresh
 * Worker thread per invocation with the RPC host-bridge), so these specs
 * exercise what production Bun self-host runs — including the security
 * properties: stripped globals, fetch allow-list, permission-checked db RPC,
 * and hard timeout termination.
 *
 * Event/cron-triggered execution is fire-and-forget off the write path
 * (`runEventFunctions`) and not deterministically observable through the
 * public API, so this spec covers the http-invoke surface; trigger fan-out
 * stays with the flows/webhooks specs that share the same publishEvent path.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

let h: TestHarness;

const createFn = async (
  body: Record<string, unknown>,
): Promise<{ status: number; data: { id: string } }> => {
  const res = await h.fetch("/api/functions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ trigger: "http", timeoutMs: 3000, ...body }),
  });
  const json = res.status === 201 ? ((await res.json()) as { data: { id: string } }) : { data: { id: "" } };
  return { status: res.status, data: json.data };
};

const invoke = async (
  name: string,
  input: Record<string, unknown> = {},
): Promise<{
  status: number;
  body: { ok: boolean; value?: unknown; logs: unknown[]; error?: string; durationMs: number };
}> => {
  const res = await h.fetch(`/api/functions/${name}/invoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return { status: res.status, body: (await res.json()) as never };
};

beforeAll(async () => {
  h = makeHarness();
  await seedAdmin(h);
});

afterAll(() => h.cleanup());

describe("functions CRUD", () => {
  test("create → list → update → delete round-trip", async () => {
    const { status, data } = await createFn({ name: "crud_fn", code: "return 1" });
    expect(status).toBe(201);

    const list = await h.fetch("/api/functions");
    expect(list.status).toBe(200);
    const rows = ((await list.json()) as { data: { name: string }[] }).data;
    expect(rows.some((r) => r.name === "crud_fn")).toBe(true);

    const patch = await h.fetch(`/api/functions/${data.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "return 2", active: false }),
    });
    expect(patch.status).toBe(200);

    const del = await h.fetch(`/api/functions/${data.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    const after = ((await (await h.fetch("/api/functions")).json()) as {
      data: { name: string }[];
    }).data;
    expect(after.some((r) => r.name === "crud_fn")).toBe(false);
  });

  test("rejects invalid names and out-of-range timeouts", async () => {
    expect((await createFn({ name: "Bad Name!", code: "return 1" })).status).toBe(400);
    expect(
      (await createFn({ name: "too_slow", code: "return 1", timeoutMs: 120_000 })).status,
    ).toBe(400);
  });
});

describe("functions invoke — happy path", () => {
  test("returns the function's value, input via ctx.data, logs captured", async () => {
    expect(
      (
        await createFn({
          name: "adder",
          code: 'console.log("adding", ctx.data.a, ctx.data.b); return { sum: ctx.data.a + ctx.data.b };',
        })
      ).status,
    ).toBe(201);

    const { status, body } = await invoke("adder", { a: 2, b: 3 });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.value).toEqual({ sum: 5 });
    expect(body.logs.length).toBe(1);
    expect(String(body.logs[0])).toContain("adding 2 3");
    expect(body.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("ctx.user carries the caller's identity and roles", async () => {
    await createFn({ name: "whoami", code: "return ctx.user;" });
    const { body } = await invoke("whoami");
    expect(body.ok).toBe(true);
    const user = body.value as { id: string; email: string; roles: string[] };
    expect(user.id).toBeTruthy();
    expect(user.email).toContain("@example.test");
    expect(user.roles).toContain("admin");
  });
});

describe("functions invoke — gates", () => {
  test("404 for a missing function", async () => {
    expect((await invoke("no_such_fn")).status).toBe(404);
  });

  test("403 for an inactive function", async () => {
    await createFn({ name: "sleeping", code: "return 1", active: false });
    expect((await invoke("sleeping")).status).toBe(403);
  });

  test("400 for a non-http trigger", async () => {
    await createFn({
      name: "cron_only",
      trigger: "cron",
      pattern: "0 0 * * *",
      code: "return 1",
    });
    expect((await invoke("cron_only")).status).toBe(400);
  });

  test("non-admin users cannot list, create, or invoke", async () => {
    // Second sign-up on the same harness lands as `authenticated`, not admin.
    const member = makeHarness({ SQLITE_PATH: h.env.SQLITE_PATH });
    const res = await member.fetch("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: `member-${Date.now()}@example.test`,
        password: "correct-horse-battery",
        name: "Member",
      }),
    });
    expect(res.ok).toBe(true);
    expect((await member.fetch("/api/functions")).status).toBe(403);
    expect(
      (
        await member.fetch("/api/functions/adder/invoke", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(403);
  });
});

describe("functions sandbox — security properties", () => {
  test("dangerous globals are stripped from the function scope", async () => {
    await createFn({
      name: "probe_globals",
      code: `return {
        proc: typeof process,
        bun: typeof Bun,
        req: typeof require,
        rawFetch: typeof fetch,
        ws: typeof WebSocket,
      };`,
    });
    const { body } = await invoke("probe_globals");
    expect(body.ok).toBe(true);
    expect(body.value).toEqual({
      proc: "undefined",
      bun: "undefined",
      req: "undefined",
      rawFetch: "undefined",
      ws: "undefined",
    });
  });

  test("ctx.fetch is deny-by-default without FUNCTIONS_FETCH_ALLOW", async () => {
    await createFn({
      name: "phone_home",
      code: 'return await ctx.fetch("https://example.com/");',
    });
    const { status, body } = await invoke("phone_home");
    expect(status).toBe(500);
    expect(body.ok).toBe(false);
    expect(body.error).toContain("not in fetch allow-list");
  });

  test("a runaway loop is terminated at timeoutMs", async () => {
    await createFn({ name: "spinner", code: "while (true) {}", timeoutMs: 200 });
    const { status, body } = await invoke("spinner");
    expect(status).toBe(500);
    expect(body.ok).toBe(false);
    expect(body.error).toContain("timed out after");
    // The worker was actually terminated — duration is bounded near the limit,
    // not the suite timeout.
    expect(body.durationMs).toBeLessThan(2_000);
  });

  test("thrown errors surface as a structured 500, not a crash", async () => {
    await createFn({ name: "thrower", code: 'throw new Error("boom from user code");' });
    const { status, body } = await invoke("thrower");
    expect(status).toBe(500);
    expect(body.ok).toBe(false);
    expect(body.error).toContain("boom from user code");
  });
});

describe("functions sandbox — ctx.db RPC", () => {
  test("ctx.db.list/one round-trip a real collection with permissions applied", async () => {
    const slug = "fn_notes";
    const create = await h.fetch("/api/collections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slug,
        fields: [{ name: "title", type: "text", required: true }],
      }),
    });
    expect(create.status).toBe(201);
    const item = await h.fetch(`/api/items/${slug}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "from-rest" }),
    });
    expect(item.status).toBe(201);
    const itemId = ((await item.json()) as { data: { id: string } }).data.id;

    await createFn({
      name: "reader",
      code: `const rows = await ctx.db.list(${JSON.stringify(slug)});
        const one = await ctx.db.one(${JSON.stringify(slug)}, ctx.data.id);
        return { count: rows.length, first: rows[0]?.title, one: one?.title };`,
    });
    const { body } = await invoke("reader", { id: itemId });
    expect(body.ok).toBe(true);
    expect(body.value).toEqual({ count: 1, first: "from-rest", one: "from-rest" });
  });

  test("ctx.db.list on an unknown collection rejects inside the sandbox", async () => {
    await createFn({
      name: "bad_reader",
      code: 'return await ctx.db.list("does_not_exist");',
    });
    const { status, body } = await invoke("bad_reader");
    expect(status).toBe(500);
    expect(body.error).toContain('"does_not_exist" not found');
  });
});
