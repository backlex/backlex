/**
 * Synchronous hooks — an external service participating in a write.
 *
 * The hook runs on the request path and its answer decides whether the row is
 * written, so the tests that matter are the ones about what happens when the
 * app misbehaves: it hangs, it dies, it answers nonsense, it tries to rewrite a
 * field it was not given permission to touch.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { AppError } from "@backlex/core";
import {
  HOOK_AUTODISABLE_THRESHOLD,
  MAX_HOOK_TIMEOUT_MS,
  matchesHookEvent,
  runSyncHooks,
} from "../src/server/services/sync-hooks";
import { makeHarness, type TestHarness } from "./setup";

let h: TestHarness;
let client: Database;
let ctx: any;

/** Requests the fake app received. */
let seen: { url: string; body: any; headers: Record<string, string> }[] = [];

const realFetch = globalThis.fetch;

/** Install a fake app at https://hook.test/<name>. */
const app = (
  handler: (body: any) => Promise<Response> | Response,
) => {
  globalThis.fetch = (async (url: any, init: any) => {
    const u = String(url);
    if (!u.startsWith("https://hook.test/")) return realFetch(url, init);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    seen.push({ url: u, body, headers: (init?.headers ?? {}) as Record<string, string> });
    // Honour the AbortSignal the way a real fetch does. Without this the
    // timeout tests would pass on a stub that simply cannot be cancelled —
    // i.e. they would assert nothing about the behaviour they name.
    const signal: AbortSignal | undefined = init?.signal;
    if (signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    return await new Promise<Response>((resolve, reject) => {
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      Promise.resolve(handler(body)).then(
        (res) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener("abort", onAbort);
          resolve(res);
        },
        (e) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener("abort", onAbort);
          reject(e);
        },
      );
    });
  }) as typeof fetch;
};

const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

const insertHook = (over: Partial<Record<string, unknown>> = {}) => {
  const row = {
    id: crypto.randomUUID(),
    tenant_id: "t1",
    name: "guard",
    url: "https://hook.test/a",
    secret: null,
    events: JSON.stringify(["posts.beforeCreate"]),
    headers: null,
    timeout_ms: 2000,
    on_error: "deny",
    can_mutate: 0,
    priority: 0,
    enabled: 1,
    consecutive_failures: 0,
    last_failure_at: null,
    disabled_reason: null,
    created_at: Date.now(),
    updated_at: Date.now(),
    ...over,
  };
  client
    .query(
      `insert into sync_hooks (id, tenant_id, name, url, secret, events, headers, timeout_ms,
        on_error, can_mutate, priority, enabled, consecutive_failures, last_failure_at,
        disabled_reason, created_at, updated_at)
       values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      row.id, row.tenant_id, row.name, row.url, row.secret, row.events, row.headers,
      row.timeout_ms, row.on_error, row.can_mutate, row.priority, row.enabled,
      row.consecutive_failures, row.last_failure_at, row.disabled_reason,
      row.created_at, row.updated_at,
    );
  return row.id;
};

const run = (data: Record<string, unknown> = { title: "x" }, phase: any = "beforeCreate") =>
  runSyncHooks(ctx, { tenantId: "t1", collection: "posts", phase, id: null, data });

const failure = (id: string) =>
  (client.query("select consecutive_failures as f, enabled from sync_hooks where id = ?").get(id) ??
    {}) as { f: number; enabled: number };

beforeEach(() => {
  seen = [];
  h = makeHarness();
  client = new Database(h.env.SQLITE_PATH as string);
  ctx = { db: drizzle({ client }), dialect: "sqlite", env: h.env };
});
afterEach(() => {
  globalThis.fetch = realFetch;
  h.cleanup();
});

describe("event matching", () => {
  test("exact, collection wildcard, phase wildcard and total wildcard", () => {
    expect(matchesHookEvent("posts.beforeCreate", "posts", "beforeCreate")).toBe(true);
    expect(matchesHookEvent("posts.*", "posts", "beforeUpdate")).toBe(true);
    expect(matchesHookEvent("*.beforeDelete", "orders", "beforeDelete")).toBe(true);
    expect(matchesHookEvent("*", "anything", "beforeCreate")).toBe(true);
  });

  test("a pattern does not leak across collections or phases", () => {
    expect(matchesHookEvent("posts.beforeCreate", "orders", "beforeCreate")).toBe(false);
    expect(matchesHookEvent("posts.beforeCreate", "posts", "beforeUpdate")).toBe(false);
    expect(matchesHookEvent("*.beforeCreate", "posts", "beforeDelete")).toBe(false);
    // No prefix matching — `post` must not select `posts`.
    expect(matchesHookEvent("post.*", "posts", "beforeCreate")).toBe(false);
  });
});

describe("verdicts", () => {
  test("no hooks configured is a no-op that makes no request", async () => {
    app(() => json({ allow: true }));
    const out = await run();
    expect(out.ran).toEqual([]);
    expect(seen).toHaveLength(0);
  });

  test("an allowing hook lets the write through", async () => {
    insertHook();
    app(() => json({ allow: true }));
    const out = await run();
    expect(out.ran).toEqual(["guard"]);
    expect(out.data).toEqual({ title: "x" });
  });

  test("a rejecting hook blocks the write and surfaces its reason", async () => {
    insertHook();
    app(() => json({ allow: false, reason: "title is banned" }));
    await expect(run()).rejects.toThrow(/title is banned/);
  });

  test("the hook receives the pending payload and the actor", async () => {
    insertHook();
    app(() => json({ allow: true }));
    await runSyncHooks(ctx, {
      tenantId: "t1",
      collection: "posts",
      phase: "beforeCreate",
      id: null,
      data: { title: "hello" },
      actor: { userId: "u1", email: "a@x.test", roles: ["admin"] },
    });
    expect(seen[0]!.body).toMatchObject({
      event: "posts.beforeCreate",
      collection: "posts",
      phase: "beforeCreate",
      id: null,
      data: { title: "hello" },
      actor: { userId: "u1", email: "a@x.test", roles: ["admin"] },
    });
  });
});

describe("mutation is opt-in", () => {
  test("a patch from a can_mutate hook is applied", async () => {
    insertHook({ can_mutate: 1 });
    app(() => json({ allow: true, data: { slug: "generated" } }));
    const out = await run({ title: "x" });
    expect(out.data).toEqual({ title: "x", slug: "generated" });
  });

  test("a patch from a hook WITHOUT can_mutate is ignored", async () => {
    insertHook({ can_mutate: 0 });
    // A hook registered to validate must not be able to rewrite rows just by
    // returning a `data` key.
    app(() => json({ allow: true, data: { title: "hijacked", role: "admin" } }));
    const out = await run({ title: "x" });
    expect(out.data).toEqual({ title: "x" });
  });

  test("the patch is a shallow merge, not a replacement", async () => {
    insertHook({ can_mutate: 1 });
    app(() => json({ allow: true, data: { b: 2 } }));
    const out = await run({ a: 1 });
    expect(out.data).toEqual({ a: 1, b: 2 });
  });
});

describe("failure handling", () => {
  test("on_error=deny blocks the write when the app is down", async () => {
    insertHook({ on_error: "deny" });
    app(() => json({ error: "boom" }, 500));
    await expect(run()).rejects.toThrow(/could not be reached/);
  });

  test("on_error=allow lets the write through when the app is down", async () => {
    insertHook({ on_error: "allow" });
    app(() => json({ error: "boom" }, 500));
    const out = await run();
    // The operator accepted this failure mode explicitly.
    expect(out.data).toEqual({ title: "x" });
    expect(out.ran).toEqual([]);
  });

  test("a 200 with an unreadable body is NOT an approval", async () => {
    insertHook({ on_error: "deny" });
    // Treating a malformed verdict as `allow` would let a broken app silently
    // disable the guarantee it exists to provide.
    app(() => new Response("not json", { status: 200 }));
    await expect(run()).rejects.toThrow(/could not be reached/);
  });

  test("a 200 whose body omits `allow` is NOT an approval", async () => {
    insertHook({ on_error: "deny" });
    app(() => json({ data: { title: "y" } }));
    await expect(run()).rejects.toThrow(/could not be reached/);
  });

  test("a hanging app is cut off at its timeout rather than hanging the write", async () => {
    insertHook({ on_error: "deny", timeout_ms: 100 });
    app(
      () =>
        new Promise<Response>((resolve) =>
          setTimeout(() => resolve(json({ allow: true })), 5000),
        ),
    );
    const started = Date.now();
    await expect(run()).rejects.toThrow(/timeout after 100ms/);
    // The write must not have waited for the app.
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("a hook cannot ask for an unbounded timeout", async () => {
    insertHook({ on_error: "deny", timeout_ms: 999_999 });
    app(
      () =>
        new Promise<Response>((resolve) =>
          setTimeout(() => resolve(json({ allow: true })), MAX_HOOK_TIMEOUT_MS + 5000),
        ),
    );
    const started = Date.now();
    await expect(run()).rejects.toThrow(/timeout after/);
    // Clamped to the ceiling, not the requested value.
    expect(Date.now() - started).toBeLessThan(MAX_HOOK_TIMEOUT_MS + 2000);
  }, 30_000);
});

describe("ordering and chaining", () => {
  test("hooks run sequentially by priority and each sees the previous patch", async () => {
    insertHook({ name: "first", priority: 0, can_mutate: 1, url: "https://hook.test/1" });
    insertHook({ name: "second", priority: 1, can_mutate: 1, url: "https://hook.test/2" });
    app((body) =>
      body.data.step
        ? json({ allow: true, data: { step: `${body.data.step}->2` } })
        : json({ allow: true, data: { step: "1" } }),
    );
    const out = await run({ title: "x" });
    expect(out.ran).toEqual(["first", "second"]);
    // Running them in parallel would make this a coin flip.
    expect(out.data.step).toBe("1->2");
  });

  test("the first rejection stops the chain", async () => {
    insertHook({ name: "first", priority: 0, url: "https://hook.test/1" });
    insertHook({ name: "second", priority: 1, url: "https://hook.test/2" });
    app((body) =>
      body.data.title === "x" ? json({ allow: false, reason: "no" }) : json({ allow: true }),
    );
    await expect(run()).rejects.toThrow(/no/);
    // The second hook must not have been called after a rejection.
    expect(seen).toHaveLength(1);
  });
});

describe("scoping", () => {
  test("another workspace's hook does not fire", async () => {
    insertHook({ tenant_id: "t2" });
    app(() => json({ allow: false, reason: "should not run" }));
    const out = await run();
    expect(out.ran).toEqual([]);
    expect(seen).toHaveLength(0);
  });

  test("an instance-wide hook (tenant_id null) fires for a workspace write", async () => {
    insertHook({ tenant_id: null, name: "global" });
    app(() => json({ allow: true }));
    expect((await run()).ran).toEqual(["global"]);
  });

  test("a disabled hook does not fire", async () => {
    insertHook({ enabled: 0 });
    app(() => json({ allow: false, reason: "should not run" }));
    expect((await run()).ran).toEqual([]);
  });

  test("a hook for a different phase does not fire", async () => {
    insertHook({ events: JSON.stringify(["posts.beforeDelete"]) });
    app(() => json({ allow: false, reason: "should not run" }));
    expect((await run({ title: "x" }, "beforeCreate")).ran).toEqual([]);
  });
});

describe("circuit breaker", () => {
  test("failures accumulate and a success clears them", async () => {
    const id = insertHook({ on_error: "allow" });
    app(() => json({}, 500));
    await run();
    await run();
    expect(failure(id).f).toBe(2);

    app(() => json({ allow: true }));
    await run();
    expect(failure(id).f).toBe(0);
  });

  test("crossing the threshold disables the hook so it stops blocking writes", async () => {
    const id = insertHook({ on_error: "allow" });
    app(() => json({}, 500));
    for (let i = 0; i < HOOK_AUTODISABLE_THRESHOLD; i++) await run();
    const row = failure(id);
    expect(row.enabled).toBe(0);
    expect(row.f).toBe(HOOK_AUTODISABLE_THRESHOLD);

    // A dead deny-hook that stayed enabled would block every write forever.
    seen = [];
    expect((await run()).ran).toEqual([]);
    expect(seen).toHaveLength(0);
  });
});

describe("signing", () => {
  test("a hook with a secret gets a timestamped signature", async () => {
    insertHook({ secret: "shh" });
    app(() => json({ allow: true }));
    await run();
    const hdr = seen[0]!.headers;
    expect(hdr["x-backlex-timestamp"]).toBeTruthy();
    expect(hdr["x-backlex-signature"]).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a custom header cannot override the signing headers", async () => {
    insertHook({
      secret: "shh",
      headers: JSON.stringify({ "x-backlex-signature": "forged", "x-custom": "ok" }),
    });
    app(() => json({ allow: true }));
    await run();
    expect(seen[0]!.headers["x-custom"]).toBe("ok");
    expect(seen[0]!.headers["x-backlex-signature"]).not.toBe("forged");
  });

  test("an unsigned hook sends no signature headers at all", async () => {
    insertHook({ secret: null });
    app(() => json({ allow: true }));
    await run();
    expect(seen[0]!.headers["x-backlex-signature"]).toBeUndefined();
  });
});

describe("error shape", () => {
  test("a rejection is a FORBIDDEN AppError, not a 500", async () => {
    insertHook();
    app(() => json({ allow: false, reason: "nope" }));
    const err = await run().catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("FORBIDDEN");
  });

  test("an over-long reason is truncated rather than echoed wholesale", async () => {
    insertHook();
    app(() => json({ allow: false, reason: "x".repeat(5000) }));
    const err = (await run().catch((e) => e)) as AppError;
    expect(err.message.length).toBeLessThanOrEqual(500);
  });
});
