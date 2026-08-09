/**
 * Auth hooks — the app taking part in its own end-users' authentication.
 *
 * The four hook points sit on the request path of a sign-up, a token mint, a
 * password check and an auth mail, so the tests that matter are the ones about
 * what happens when the app misbehaves: it hangs, it dies, it answers nonsense,
 * or it tries to write a claim that would let it become somebody else.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { AppError } from "@backlex/core";
import {
  AUTH_HOOK_AUTODISABLE_THRESHOLD,
  MAX_AUTH_HOOK_TIMEOUT_MS,
  MAX_CUSTOM_CLAIMS_BYTES,
  RESERVED_TOKEN_CLAIMS,
  createAuthHook,
  testAuthHook,
  runBeforeUserCreatedHook,
  runCustomAccessTokenHook,
  runPasswordVerificationHook,
  runSendEmailHook,
  sanitizeCustomClaims,
  type AuthHookEvent,
} from "../src/server/services/auth-hooks";
import { signAccessToken, verifyAccessToken } from "../src/server/lib/jwt";
import { makeHarness, type TestHarness } from "./setup";

let h: TestHarness;
let client: Database;
let ctx: any;

/** Requests the fake app received. */
let seen: { url: string; body: any; headers: Record<string, string> }[] = [];

const realFetch = globalThis.fetch;

/** Install a fake app at https://hook.test/*. Honours the AbortSignal the way a
 *  real fetch does — without that the timeout test would pass against a stub
 *  that simply cannot be cancelled, i.e. assert nothing about what it names. */
const app = (handler: (body: any) => Promise<Response> | Response) => {
  globalThis.fetch = (async (url: any, init: any) => {
    const u = String(url);
    if (!u.startsWith("https://hook.test/")) return realFetch(url, init);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    seen.push({ url: u, body, headers: (init?.headers ?? {}) as Record<string, string> });
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

const insertHook = (
  event: AuthHookEvent,
  over: Partial<Record<string, unknown>> = {},
): string => {
  const row = {
    id: crypto.randomUUID(),
    tenant_id: "t1",
    event,
    target_type: "url",
    url: "https://hook.test/a",
    function_name: null,
    secret: null,
    headers: null,
    timeout_ms: 2000,
    on_error: "deny",
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
      `insert into auth_hooks (id, tenant_id, event, target_type, url, function_name, secret,
        headers, timeout_ms, on_error, enabled, consecutive_failures, last_failure_at,
        disabled_reason, created_at, updated_at)
       values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      row.id, row.tenant_id, row.event, row.target_type, row.url, row.function_name,
      row.secret, row.headers, row.timeout_ms, row.on_error, row.enabled,
      row.consecutive_failures, row.last_failure_at, row.disabled_reason,
      row.created_at, row.updated_at,
    );
  return row.id;
};

const insertFunction = (name: string, code: string): void => {
  client
    .query(
      `insert into functions (id, tenant_id, name, trigger, pattern, code, timeout_ms, active,
        created_at, updated_at) values (?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(crypto.randomUUID(), "t1", name, "http", null, code, 2000, 1, Date.now(), Date.now());
};

const breaker = (id: string) =>
  (client
    .query("select consecutive_failures as f, enabled from auth_hooks where id = ?")
    .get(id) ?? {}) as { f: number; enabled: number };

const signup = (email = "new@example.test") =>
  runBeforeUserCreatedHook(ctx, "t1", { email, via: "password" });

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

describe("no hook configured", () => {
  test("every helper is a no-op that costs the caller nothing", async () => {
    app(() => json({ allow: false }));
    await signup(); // does not throw
    expect(await runCustomAccessTokenHook(ctx, "t1", IDENTITY, async () => ["a"])).toEqual({});
    expect(await runPasswordVerificationHook(ctx, "t1", PWD)).toEqual({ allow: true });
    expect(await runSendEmailHook(ctx, "t1", MAIL)).toBe(false);
    // Nothing was called: an instance with no hooks must not reach the network
    // on its auth path at all.
    expect(seen).toHaveLength(0);
  });

  test("a null tenant never resolves a hook", async () => {
    insertHook("before-user-created");
    app(() => json({ allow: false, reason: "no" }));
    await runBeforeUserCreatedHook(ctx, null, { email: "a@b.test", via: "password" });
    expect(seen).toHaveLength(0);
  });

  test("another workspace's hook is not this workspace's", async () => {
    insertHook("before-user-created", { tenant_id: "t2" });
    app(() => json({ allow: false, reason: "no" }));
    await signup();
    expect(seen).toHaveLength(0);
  });
});

const IDENTITY = { userId: "u1", email: "u@example.test", sessionId: "s1" };
const PWD = { email: "u@example.test", valid: true, ip: null, userAgent: null };
const MAIL = { type: "magic-link" as const, to: "u@example.test", url: "https://app.test/x" };

describe("before-user-created", () => {
  test("an allow verdict lets the sign-up through, and the payload says who", async () => {
    insertHook("before-user-created");
    app(() => json({ allow: true }));
    await runBeforeUserCreatedHook(ctx, "t1", {
      email: "new@example.test",
      name: "New Person",
      via: "saml",
      subject: "idp-sub-1",
    });
    expect(seen[0]!.body.event).toBe("before-user-created");
    expect(seen[0]!.body.data).toMatchObject({
      email: "new@example.test",
      name: "New Person",
      via: "saml",
      subject: "idp-sub-1",
    });
  });

  test("a deny verdict refuses the sign-up with the hook's own reason", async () => {
    insertHook("before-user-created");
    app(() => json({ allow: false, reason: "corporate email required" }));
    expect(signup()).rejects.toThrow(/corporate email required/);
  });

  test("a deny with no reason still refuses", async () => {
    insertHook("before-user-created");
    app(() => json({ allow: false }));
    expect(signup()).rejects.toThrow(/Sign-up rejected/);
  });

  test("an omitted `allow` is NOT a refusal — only an explicit false is", async () => {
    // The verdict shape is shared across four events; a hook answering
    // `{ handled: true }` to the wrong endpoint must not silently close signup.
    insertHook("before-user-created");
    app(() => json({ handled: true }));
    await signup();
  });
});

describe("onError is the whole failure policy", () => {
  test("deny turns an unreachable hook into a refused auth action", async () => {
    insertHook("before-user-created", { on_error: "deny" });
    app(() => json({ oops: true }, 500));
    expect(signup()).rejects.toThrow(/could not be reached/);
  });

  test("allow lets the auth action proceed without the hook's answer", async () => {
    insertHook("before-user-created", { on_error: "allow" });
    app(() => json({ oops: true }, 500));
    await signup();
  });

  test("the refusal names the event but NOT the hook's address or transport error", async () => {
    // These refusals reach an unauthenticated caller — a stranger attempting a
    // sign-up. `out.error` is whatever the runtime's fetch said, which for a
    // blocked or unreachable host names that host, so a workspace's internal
    // endpoint would be printed on a public sign-up form. Found in the
    // pre-commit security review of my own code.
    insertHook("before-user-created", {
      on_error: "deny",
      url: "https://hook.test/internal-billing-gate",
    });
    app(() => {
      throw new Error("connect ECONNREFUSED https://hook.test/internal-billing-gate");
    });
    let message = "";
    await signup().catch((e) => {
      message = (e as Error).message;
    });
    expect(message).toContain("before-user-created");
    expect(message).not.toContain("internal-billing-gate");
    expect(message).not.toContain("ECONNREFUSED");
  });

  test("a 200 with a body we cannot read is a FAILURE, not an approval", async () => {
    // Otherwise a broken app quietly disables the gate it exists to provide.
    insertHook("before-user-created", { on_error: "deny" });
    app(() => new Response("<html>proxy error</html>", { status: 200 }));
    expect(signup()).rejects.toThrow(/could not be reached/);
  });

  test("a hook that hangs is cut off at its own timeout", async () => {
    const id = insertHook("before-user-created", { on_error: "deny", timeout_ms: 60 });
    app(() => new Promise<Response>(() => {}));
    const started = Date.now();
    await signup().catch(() => {});
    // Decisive: the default budget is 2000ms, so finishing inside a second can
    // only mean the hook's own 60ms was applied. The elapsed time is the
    // assertion because the message deliberately no longer carries the detail
    // (it reaches unauthenticated callers).
    expect(Date.now() - started).toBeLessThan(1000);
    // The detail IS still available where it belongs — the admin test endpoint.
    const probe = await testAuthHook(ctx, "t1", id);
    expect(probe.ok).toBe(false);
    expect(probe.error).toMatch(/timeout after 60ms/);
  });

  test("the per-hook timeout cannot exceed the ceiling", async () => {
    // Asserted at the write, which is where a caller can express one: the
    // invoke path applies the same `Math.min` to whatever is stored, and
    // timing that out would cost the suite a full ceiling of wall clock on
    // every run for a second reading of one expression.
    const created = await createAuthHook(ctx, "t1", {
      event: "before-user-created",
      targetType: "url",
      url: "https://hook.test/a",
      onError: "deny",
      timeoutMs: 999_999,
    });
    expect(created.timeoutMs).toBe(MAX_AUTH_HOOK_TIMEOUT_MS);
  });

  test("a custom-access-token failure under `deny` refuses the token", async () => {
    // The reason `allow` is not a default: a token minted without the claim an
    // authorizer reads is worse than no token at all.
    insertHook("custom-access-token", { on_error: "deny" });
    app(() => json({}, 503));
    expect(runCustomAccessTokenHook(ctx, "t1", IDENTITY, async () => [])).rejects.toThrow(
      /could not be reached/,
    );
  });
});

describe("the breaker", () => {
  test("consecutive failures accumulate and eventually disable the hook", async () => {
    const id = insertHook("before-user-created", { on_error: "allow" });
    app(() => json({}, 500));
    for (let i = 0; i < AUTH_HOOK_AUTODISABLE_THRESHOLD; i++) await signup();
    const state = breaker(id);
    expect(state.f).toBe(AUTH_HOOK_AUTODISABLE_THRESHOLD);
    expect(state.enabled).toBe(0);
  });

  test("a success clears the counter", async () => {
    const id = insertHook("before-user-created", { on_error: "allow" });
    app(() => json({}, 500));
    await signup();
    expect(breaker(id).f).toBe(1);
    app(() => json({ allow: true }));
    await signup();
    expect(breaker(id).f).toBe(0);
  });

  test("a disabled hook is not consulted", async () => {
    insertHook("before-user-created", { enabled: 0 });
    app(() => json({ allow: false, reason: "no" }));
    await signup();
    expect(seen).toHaveLength(0);
  });
});

describe("custom-access-token claim safety", () => {
  test("ordinary claims come through", async () => {
    insertHook("custom-access-token");
    app(() => json({ claims: { plan: "pro", org: "acme", seats: 4 } }));
    expect(await runCustomAccessTokenHook(ctx, "t1", IDENTITY, async () => ["authenticated"])).toEqual({
      plan: "pro",
      org: "acme",
      seats: 4,
    });
  });

  test("the roles thunk runs ONLY when a hook exists, and its result reaches the payload", async () => {
    let called = 0;
    const roles = async () => {
      called++;
      return ["staff"];
    };
    app(() => json({ claims: {} }));
    await runCustomAccessTokenHook(ctx, "t1", IDENTITY, roles);
    expect(called).toBe(0); // no hook configured — the token path pays nothing

    insertHook("custom-access-token");
    await runCustomAccessTokenHook(ctx, "t1", IDENTITY, roles);
    expect(called).toBe(1);
    expect(seen[0]!.body.data.roles).toEqual(["staff"]);
  });

  test("every reserved claim is dropped", async () => {
    insertHook("custom-access-token");
    const hostile = Object.fromEntries([...RESERVED_TOKEN_CLAIMS].map((k) => [k, "hijacked"]));
    app(() => json({ claims: { ...hostile, plan: "pro" } }));
    const claims = await runCustomAccessTokenHook(ctx, "t1", IDENTITY, async () => []);
    expect(claims).toEqual({ plan: "pro" });
  });

  test("`tid` cannot be moved even if the filter is bypassed", async () => {
    // Defence in depth: sanitizeCustomClaims is the first line, and the spread
    // order inside signAccessToken is the one that cannot be forgotten. This
    // asserts the SECOND one by handing the signer a hostile claim directly.
    const { token } = await signAccessToken(
      h.env as any,
      { sub: "u1", tid: "t1", sid: "s1", email: "u@example.test" },
      undefined,
      { tid: "other-workspace", sub: "admin", exp: 9_999_999_999, plan: "pro" },
    );
    const verified = await verifyAccessToken(h.env as any, token);
    expect(verified?.tid).toBe("t1");
    expect(verified?.sub).toBe("u1");
    expect(verified?.plan).toBe("pro");
    // And it is still a short-lived token, not the decade the hook asked for.
    expect(verified!.exp * 1000 - Date.now()).toBeLessThan(60 * 60 * 1000);
  });

  test("claims larger than the ceiling are dropped whole, not truncated", () => {
    const big = { blob: "x".repeat(MAX_CUSTOM_CLAIMS_BYTES + 1) };
    const out = sanitizeCustomClaims(big);
    expect(out.tooLarge).toBe(true);
    expect(out.claims).toEqual({});
  });

  test("a non-object `claims` is ignored rather than thrown on", () => {
    expect(sanitizeCustomClaims("nope").claims).toEqual({});
    expect(sanitizeCustomClaims(["a"]).claims).toEqual({});
    expect(sanitizeCustomClaims(null).claims).toEqual({});
  });

  test("`__proto__` is dropped rather than reassigning the claims object", () => {
    // `out["__proto__"] = x` on an object literal REPLACES the prototype
    // instead of adding a property, so without the guard a hook returning one
    // would silently lose every other claim it sent — and hand a
    // caller-controlled object to everything downstream. Found in the
    // pre-commit security review of my own code.
    const out = sanitizeCustomClaims(
      JSON.parse('{"__proto__": {"admin": true}, "plan": "pro"}'),
    );
    expect(out.claims).toEqual({ plan: "pro" });
    expect(Object.getPrototypeOf(out.claims)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
  });

  test("a cycle in the claims is refused instead of crashing the token mint", () => {
    const cyclic: Record<string, unknown> = { plan: "pro" };
    cyclic.self = cyclic;
    expect(sanitizeCustomClaims(cyclic).claims).toEqual({});
  });
});

describe("password-verification", () => {
  test("the outcome of the password check is reported, failures included", async () => {
    insertHook("password-verification");
    app(() => json({ allow: true }));
    await runPasswordVerificationHook(ctx, "t1", { ...PWD, valid: false, ip: "203.0.113.9" });
    expect(seen[0]!.body.data).toMatchObject({
      email: "u@example.test",
      valid: false,
      ip: "203.0.113.9",
    });
  });

  test("a refusal is returned rather than thrown — the caller has a session to revoke", async () => {
    insertHook("password-verification");
    app(() => json({ allow: false, reason: "impossible travel" }));
    expect(await runPasswordVerificationHook(ctx, "t1", PWD)).toEqual({
      allow: false,
      reason: "impossible travel",
    });
  });

  test("an unreachable hook under `deny` still throws — the policy is mandatory", async () => {
    insertHook("password-verification", { on_error: "deny" });
    app(() => json({}, 500));
    expect(runPasswordVerificationHook(ctx, "t1", PWD)).rejects.toThrow(AppError);
  });
});

describe("send-email", () => {
  test("a hook that answers has taken delivery", async () => {
    insertHook("send-email");
    app(() => json({ handled: true }));
    expect(await runSendEmailHook(ctx, "t1", MAIL)).toBe(true);
  });

  test("an empty 204 counts as delivered — a mail relay's 2xx means sent", async () => {
    insertHook("send-email");
    app(() => new Response(null, { status: 204 }));
    expect(await runSendEmailHook(ctx, "t1", MAIL)).toBe(true);
  });

  test("an explicit `handled: false` falls back to our own transport", async () => {
    insertHook("send-email");
    app(() => json({ handled: false }));
    expect(await runSendEmailHook(ctx, "t1", MAIL)).toBe(false);
  });

  test("under `allow`, an unreachable hook falls back rather than losing the mail", async () => {
    insertHook("send-email", { on_error: "allow" });
    app(() => json({}, 500));
    expect(await runSendEmailHook(ctx, "t1", MAIL)).toBe(false);
  });

  test("the payload carries the MEANING of the mail, not a rendered body", async () => {
    // The point of the hook is that the app re-templates; handing it a finished
    // subject line would leave it able only to re-send ours.
    insertHook("send-email");
    app(() => json({ handled: true }));
    await runSendEmailHook(ctx, "t1", { type: "email-otp", to: "u@example.test", otp: "123456" });
    expect(seen[0]!.body.data).toEqual({ type: "email-otp", to: "u@example.test", otp: "123456" });
  });
});

describe("Standard Webhooks signing", () => {
  test("an unsigned hook sends no signature headers at all", async () => {
    insertHook("before-user-created");
    app(() => json({ allow: true }));
    await signup();
    expect(seen[0]!.headers["webhook-signature"]).toBeUndefined();
  });

  test("a signed hook sends id + timestamp + v1 signature", async () => {
    insertHook("before-user-created", { secret: "whsec_c2VjcmV0LWtleQ==" });
    app(() => json({ allow: true }));
    await signup();
    const hd = seen[0]!.headers;
    expect(hd["webhook-id"]).toMatch(/^msg_/);
    expect(Number(hd["webhook-timestamp"])).toBeGreaterThan(1_700_000_000);
    expect(hd["webhook-signature"]).toMatch(/^v1,[A-Za-z0-9+/=]+$/);
  });

  test("a configured header can never overwrite the signing headers", async () => {
    insertHook("before-user-created", {
      secret: "whsec_c2VjcmV0LWtleQ==",
      headers: JSON.stringify({ "webhook-signature": "v1,forged", "x-mine": "ok" }),
    });
    app(() => json({ allow: true }));
    await signup();
    expect(seen[0]!.headers["webhook-signature"]).not.toBe("v1,forged");
    expect(seen[0]!.headers["x-mine"]).toBe("ok");
  });
});

describe("function targets", () => {
  test("a function's return value is the verdict", async () => {
    insertFunction("gate", `return { allow: false, reason: "closed for " + ctx.data.email };`);
    insertHook("before-user-created", {
      target_type: "function",
      url: null,
      function_name: "gate",
    });
    expect(signup("blocked@example.test")).rejects.toThrow(/closed for blocked@example.test/);
    // And nothing left the process — the whole point of the function target.
    expect(seen).toHaveLength(0);
  });

  test("a function target injects claims without a network hop", async () => {
    insertFunction("claims", `return { claims: { plan: "pro", who: ctx.data.userId } };`);
    insertHook("custom-access-token", {
      target_type: "function",
      url: null,
      function_name: "claims",
    });
    expect(await runCustomAccessTokenHook(ctx, "t1", IDENTITY, async () => [])).toEqual({
      plan: "pro",
      who: "u1",
    });
  });

  test("a missing function is a hook FAILURE, so onError decides", async () => {
    insertHook("before-user-created", {
      target_type: "function",
      url: null,
      function_name: "nope",
      on_error: "deny",
    });
    expect(signup()).rejects.toThrow(/could not be reached/);
  });

  test("a function that throws is a failure, not an approval", async () => {
    insertFunction("boom", `throw new Error("kaboom");`);
    insertHook("before-user-created", {
      target_type: "function",
      url: null,
      function_name: "boom",
      on_error: "deny",
    });
    expect(signup()).rejects.toThrow(/could not be reached/);
  });

  test("a function belonging to another workspace is not reachable", async () => {
    insertFunction("gate", `return { allow: false, reason: "denied" };`);
    client.query("update functions set tenant_id = 't2' where name = 'gate'").run();
    insertHook("before-user-created", {
      target_type: "function",
      url: null,
      function_name: "gate",
      on_error: "allow",
    });
    await signup(); // failed open — the function was not found in t1
  });
});
