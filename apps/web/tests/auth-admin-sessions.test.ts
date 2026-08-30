/**
 * `POST /api/admin/auth/sessions/revoke-others` — "sign out my other devices".
 *
 * `routes/auth-admin.ts` had no spec of its own, and this is the endpoint on it
 * whose failure modes are silent in both directions. It walks the caller's
 * sessions, keeps the one the request arrived on, and deletes the rest:
 *
 *   - keep too many and the button is a lie — the session the operator is
 *     trying to kill survives, and the UI says it did not;
 *   - keep too few and the operator signs themselves out mid-incident;
 *   - keep the wrong ONE and both happen at once.
 *
 * All three answer 200 with a plausible `removed` count, so the count is not
 * the assertion. What the tests below check is which credentials can still make
 * a request afterwards, because that is the only thing the endpoint promises.
 *
 * **Revocation is not immediate, and that is by design in two layers.** A
 * sign-in hands out `better-auth.session_token` AND `better-auth.session_data`
 * — better-auth's `cookieCache`, a signed 60-second copy of the session that it
 * answers `getSession` from without reading the database. Underneath it,
 * `middleware/session.ts` keeps a per-isolate `TtlLru` keyed on the signed
 * token (`permissions-cache.ts`, TTL 30s). Deleting the row therefore does not
 * stop a device that still holds a live `session_data` blob; it stops it from
 * renewing once that blob lapses. So a "device is signed out" assertion has to
 * be made against the credential that outlives the cache — the session token on
 * its own — and both shapes are pinned below, because a test that checked only
 * the warm one would report a working revocation as a broken one, and a test
 * that checked only the cold one would hide the window from whoever reads this
 * next.
 *
 * **The inner cache is NOT nested inside the outer one, which this file used to
 * say.** It was described as "sized deliberately below the outer one so it adds
 * no lag of its own". Measured, it adds ~30s on top: a request that
 * `cookieCache` answers is written into the inner cache under the BARE token
 * key, so a browser holding a live blob keeps refreshing that 30s entry, and
 * the last warm request at t=59s leaves the token accepted until about t=89s.
 * The last test in this file pins that, because it is the number an operator
 * actually waits out and nothing else in the codebase states it.
 *
 * **This harness is a single process, so its timings are a LOWER bound.** The
 * inner cache is a module-level `TtlLru` with no shared store behind it — per
 * isolate on Workers — and `revoke-others` clears only the isolate that served
 * it (`routes/auth-admin.ts` says so at the call site). Anything measured here
 * about how fast a revocation propagates therefore describes one isolate, and
 * a conclusion like "disabling `cookieCache` makes revocation immediate" is
 * true in this file and false in production, where every other isolate still
 * serves its cached copy for up to its own 30s. `packages/auth/src/index.ts`
 * carries the production numbers on the line someone would change.
 *
 * The other sessions are real sign-ins rather than planted rows: better-auth
 * owns the session table's shape, and a row this file wrote by hand would prove
 * the handler can delete rows this file writes.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { makeHarness, nextSyntheticIp, seedAdmin, type TestHarness } from "./setup";
import { __cacheStats, invalidateAllPermissions } from "../src/server/services/permissions-cache";

/**
 * Stand in for the per-isolate session LRU's 30s TTL elapsing.
 *
 * That cache is keyed on the signed session token, so ANY earlier request from
 * a device — including the liveness probe a test needs in order not to be
 * vacuous — makes the next one answer from memory. Without this the file could
 * only ever observe the cache, never the row, and "the session is gone" would
 * be unprovable in-process. Clearing it is exactly what the TTL does in
 * production; it is not a shortcut past a check.
 */
const sessionCacheExpires = () => invalidateAllPermissions();

const BASE = "/api/admin/auth/sessions";
const PASSWORD = "correct-horse-battery";

let h: TestHarness;
let client: Database;
let admin: { email: string; password: string };
/**
 * This file drives `h.app.request` directly (it needs per-device Cookie
 * control, which the harness's cookie jar owns), and the harness's synthetic-IP
 * wrapper sits on `app.fetch` — so these calls reach `lib/auth-rate-limit.ts`
 * as IP "unknown", the one bucket the whole suite shares. Five sign-ups a
 * minute against that bucket means the 429 lands on whichever spec the
 * scheduler got to last: green alone, red in a full run, in a file that did
 * nothing wrong. Claiming an IP explicitly is the documented way out.
 */
let ip: string;

type Device = {
  /** Every cookie the sign-in set — a browser inside the 60s cache window. */
  warm: (path: string) => Promise<Response>;
  /** `session_token` only — the same browser once `session_data` has lapsed. */
  cold: (path: string) => Promise<Response>;
};

/**
 * A second signed-in client for the SAME user, with its own cookies — a second
 * browser, not a second account. `makeHarness`'s own jar belongs to the caller
 * under test, so the cookies are kept here instead.
 */
const signInSeparately = async (email: string): Promise<Device> => {
  const res = await h.app.request(
    "/api/auth/sign-in/email",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: h.env.APP_URL as string,
        "x-forwarded-for": ip,
      },
      body: JSON.stringify({ email, password: PASSWORD }),
    },
    h.env,
  );
  expect(res.status).toBe(200);
  const pairs = (res.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(";")[0] ?? "")
    .filter(Boolean);
  // Liveness for every `cold` assertion in the file: if better-auth stopped
  // emitting the token cookie under this name, `cold` would send no credential
  // at all and every "revoked device is refused" test would pass for the wrong
  // reason.
  const token = pairs.filter((p) => p.includes("session_token"));
  expect(`session_token cookie issued: ${token.length}`).toBe("session_token cookie issued: 1");

  const send = (cookie: string) => (path: string) =>
    Promise.resolve(
      h.app.request(
        path,
        { headers: { cookie, origin: h.env.APP_URL as string, "x-forwarded-for": ip } },
        h.env,
      ),
    );
  return { warm: send(pairs.join("; ")), cold: send(token.join("; ")) };
};

const sessionCount = (): number =>
  (client.query("select count(*) as n from sessions").get() as { n: number }).n;

beforeEach(async () => {
  h = makeHarness();
  ip = nextSyntheticIp();
  admin = await seedAdmin(h, `admin-${crypto.randomUUID()}@example.test`, PASSWORD);
  client = new Database(h.env.SQLITE_PATH as string);
});
afterEach(() => h.cleanup());

describe("revoking other sessions", () => {
  test("the other devices lose their sessions and the caller keeps hers", async () => {
    const deviceB = await signInSeparately(admin.email);
    const deviceC = await signInSeparately(admin.email);

    // Liveness: the assertions below are about sessions dying, so they are
    // worthless unless the sessions were alive first. A run against a user with
    // exactly one session removes nothing and passes every "the others are
    // gone" check by construction.
    expect((await deviceB.cold("/api/me")).status).toBe(200);
    expect((await deviceC.cold("/api/me")).status).toBe(200);
    expect(sessionCount()).toBeGreaterThanOrEqual(3);

    const res = await h.fetch(`${BASE}/revoke-others`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, removed: 2 });

    // The point of the endpoint, checked behaviourally rather than by row
    // count: a deleted row and a row that still authenticates look identical in
    // a `count(*)`.
    sessionCacheExpires();
    expect((await deviceB.cold("/api/me")).status).toBe(401);
    expect((await deviceC.cold("/api/me")).status).toBe(401);
    expect((await h.fetch("/api/me")).status).toBe(200);
    expect(sessionCount()).toBe(1);
  });

  test("a revoked device still passes for up to 60s on better-auth's cookieCache", async () => {
    // Recorded, not endorsed. `session_data` is a signed copy of the session
    // that better-auth trusts without a database read, so the row being gone
    // changes nothing until it lapses. That window is better-auth's default and
    // is what `permissions-cache.ts` sizes its own 30s TTL against — but it is
    // invisible from the endpoint, from its response, and from the admin UI
    // that calls it, which is why it is written down here.
    //
    // If this ever starts failing, revocation became immediate — check whether
    // `cookieCache` was disabled or whether the handler learned to expire the
    // cookie, and delete this test rather than restoring the lag.
    const device = await signInSeparately(admin.email);

    const res = await h.fetch(`${BASE}/revoke-others`, { method: "POST" });
    expect(await res.json()).toEqual({ ok: true, removed: 1 });
    expect(sessionCount()).toBe(1);

    expect((await device.warm("/api/me")).status).toBe(200);
    // Same credential, once both caches are out of the way: the row really is
    // gone, so the 200 above is the cache and nothing else.
    sessionCacheExpires();
    expect((await device.cold("/api/me")).status).toBe(401);
  });

  test("the per-isolate session cache is cleared, not left to time out", async () => {
    // The inner half of the revocation. `middleware/session.ts` answers from a
    // per-isolate LRU keyed on the SIGNED cookie, while the `sessions` row
    // holds the bare token — so `invalidateSession` matched nothing until it
    // learned to allow for the signature, and its only would-be caller deleted
    // rows by id and never called it at all.
    //
    // Driven WITHOUT `sessionCacheExpires()` on purpose: the other tests model
    // the TTL elapsing, which hides whether anything actively cleared the
    // entry. Here the cache is deliberately warmed and then has to shrink
    // because the handler emptied it.
    const device = await signInSeparately(admin.email);
    expect((await device.cold("/api/me")).status).toBe(200);
    const before = __cacheStats().session;
    expect(`cache warmed: ${before > 0}`).toBe("cache warmed: true");

    expect((await h.fetch(`${BASE}/revoke-others`, { method: "POST" })).status).toBe(200);

    // A decrease rather than zero: the CALLER's own session is legitimately
    // still cached — it was not revoked.
    expect(`cache shrank: ${__cacheStats().session < before}`).toBe("cache shrank: true");
  });

  test("it is idempotent — a second call removes nothing and keeps the caller in", async () => {
    await signInSeparately(admin.email);
    expect((await h.fetch(`${BASE}/revoke-others`, { method: "POST" })).status).toBe(200);

    // The shape that would break here is a handler that treats "no session to
    // keep" as "keep nothing": the second call would sign the caller out of the
    // request that made it.
    const again = await h.fetch(`${BASE}/revoke-others`, { method: "POST" });
    expect(await again.json()).toEqual({ ok: true, removed: 0 });
    expect((await h.fetch("/api/me")).status).toBe(200);
  });

  test("it never reaches another user's sessions", async () => {
    // Scoped by `userId`, and a missing filter would be invisible to every
    // assertion above — the caller's own devices go either way.
    const otherEmail = `other-${crypto.randomUUID()}@example.test`;
    const signUp = await h.app.request(
      "/api/auth/sign-up/email",
      {
        method: "POST",
        headers: {
        "content-type": "application/json",
        origin: h.env.APP_URL as string,
        "x-forwarded-for": ip,
      },
        body: JSON.stringify({ email: otherEmail, password: PASSWORD, name: "Other" }),
      },
      h.env,
    );
    expect(signUp.status).toBe(200);
    const other = await signInSeparately(otherEmail);
    expect((await other.cold("/api/me")).status).toBe(200);

    await signInSeparately(admin.email);
    expect((await h.fetch(`${BASE}/revoke-others`, { method: "POST" })).status).toBe(200);

    // Past every cache, so a 200 here is the row surviving rather than a
    // memoised answer — which is the whole claim.
    sessionCacheExpires();
    expect((await other.cold("/api/me")).status).toBe(200);
  });

  test("a signed-out caller cannot revoke anything", async () => {
    await signInSeparately(admin.email);
    const before = sessionCount();
    expect(before).toBeGreaterThanOrEqual(2);
    const res = await h.app.request(
      `${BASE}/revoke-others`,
      { method: "POST", headers: { origin: h.env.APP_URL as string, "x-forwarded-for": ip } },
      h.env,
    );
    expect(res.status).toBe(401);
    expect(sessionCount()).toBe(before);
  });

  test("the two caches COMPOUND rather than nest — the real lag is ~90s, not 60s", async () => {
    // The claim this replaces was that the inner 30s TTL sits "below" the outer
    // 60s one and therefore adds nothing. Three requests, each with the inner
    // cache explicitly cleared first, show otherwise — and the order matters:
    // asking warm first would repopulate the inner cache and make the cold
    // request pass for the wrong reason, which is exactly how the nesting story
    // survived this long.
    const device = await signInSeparately(admin.email);
    expect(await (await h.fetch(`${BASE}/revoke-others`, { method: "POST" })).json()).toEqual({
      ok: true,
      removed: 1,
    });

    // 1. Cold, inner cache cleared: the row really is gone.
    sessionCacheExpires();
    expect(`cold after revoke: ${(await device.cold("/api/me")).status}`).toBe(
      "cold after revoke: 401",
    );

    // 2. Warm, inner cache cleared: 200 can now only be better-auth's
    //    `cookieCache` — and it is answering `/api/me`, one of OUR routes, not
    //    just its own `/api/auth/*`. That is the cost side of `maxAge`.
    sessionCacheExpires();
    expect(`warm after revoke: ${(await device.warm("/api/me")).status}`).toBe(
      "warm after revoke: 200",
    );

    // 3. Cold again, WITHOUT clearing: the warm hit above wrote the session
    //    into the inner cache under the bare-token key, so the credential that
    //    was 401 in step 1 is now accepted. Every warm request buys the revoked
    //    device another 30s, for as long as the 60s blob lasts.
    expect(`cold immediately after a warm hit: ${(await device.cold("/api/me")).status}`).toBe(
      "cold immediately after a warm hit: 200",
    );

    // If this test starts failing, the lag got SHORTER — check whether
    // `cookieCache` was disabled or narrowed, or whether `sessionMiddleware`
    // stopped caching what `cookieCache` resolved, and delete this rather than
    // restoring the behaviour.
  });
});
