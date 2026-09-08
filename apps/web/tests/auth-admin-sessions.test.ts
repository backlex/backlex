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
import {
  __cacheStats,
  invalidateAllPermissions,
  setCachedSession,
} from "../src/server/services/permissions-cache";
import { __resetEpochMemo, EPOCH_TTL_MS } from "../src/server/services/revocation-epoch";

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
  /** Every cookie the sign-in set. Identical to `cold` now that `cookieCache`
   *  is off and no `session_data` blob is issued — kept because that EQUALITY
   *  is a property worth asserting, not an accident. */
  warm: (path: string) => Promise<Response>;
  /** `session_token` only. */
  cold: (path: string) => Promise<Response>;
  /**
   * The SIGNED cookie value — `<token>.<signature>`.
   *
   * `middleware/session.ts` keys its cache on this, not on the bare token the
   * `sessions` row holds. The distinction is load-bearing and this file learned
   * it the hard way: a test that plants a cache entry under the bare token
   * plants it where nothing will ever look, then passes because the request
   * 401s for the ordinary reason. See `invalidateSession`, which carries the
   * same warning at the same cost.
   */
  signedToken: string;
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
  // decodeURIComponent, and it is load-bearing: the signature is base64, so a
  // `+` reaches the Set-Cookie header as `%2B`. `getCookie` decodes before the
  // middleware looks the value up, so the RAW pair is a key nothing reads —
  // planting under it makes a cache-hit test pass for the ordinary reason.
  // Measured, not assumed: raw and decoded differ on every sign-in.
  const signedToken = decodeURIComponent((token[0] ?? "").split("=").slice(1).join("="));
  expect(`signed token captured: ${signedToken.length > 0}`).toBe("signed token captured: true");
  return {
    warm: send(pairs.join("; ")),
    cold: send(token.join("; ")),
    signedToken,
  };
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
    expect(await res.json()).toEqual({ ok: true, removed: 2, apiKeys: 0, apiKeysRevoked: 0 });

    // The point of the endpoint, checked behaviourally rather than by row
    // count: a deleted row and a row that still authenticates look identical in
    // a `count(*)`.
    sessionCacheExpires();
    expect((await deviceB.cold("/api/me")).status).toBe(401);
    expect((await deviceC.cold("/api/me")).status).toBe(401);
    expect((await h.fetch("/api/me")).status).toBe(200);
    expect(sessionCount()).toBe(1);
  });

  test("a revoked device is refused immediately — warm and cold alike", async () => {
    // This test used to assert the OPPOSITE, and its own note said what to do:
    // "if this ever starts failing, revocation became immediate — check whether
    // `cookieCache` was disabled ... and delete this test rather than restoring
    // the lag." It was disabled (#319). Reversed rather than deleted, so the
    // 60s window cannot come back unnoticed.
    //
    // `warm` and `cold` are the same request now: with no `session_data` blob
    // there is nothing for the warm shape to carry that the cold one does not.
    // Both are asserted anyway, because that equality IS the property.
    const device = await signInSeparately(admin.email);

    const res = await h.fetch(`${BASE}/revoke-others`, { method: "POST" });
    expect(await res.json()).toEqual({ ok: true, removed: 1, apiKeys: 0, apiKeysRevoked: 0 });
    expect(sessionCount()).toBe(1);

    expect(`warm after revoke: ${(await device.warm("/api/me")).status}`).toBe(
      "warm after revoke: 401",
    );
    expect(`cold after revoke: ${(await device.cold("/api/me")).status}`).toBe(
      "cold after revoke: 401",
    );
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
    expect(await again.json()).toEqual({ ok: true, removed: 0, apiKeys: 0, apiKeysRevoked: 0 });
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

  test("sign-in issues NO `session_data` blob at all", async () => {
    // The stronger form of what this used to check. The old test pinned that
    // the blob was not REFRESHED by traffic, because that ceiling was the only
    // thing bounding the window. With `cookieCache` off there is no blob, so
    // there is no window to bound — and this is the assertion that says so.
    //
    // It is also the liveness guard for the test above: `warm` and `cold` being
    // equal there means nothing unless a warm sign-in genuinely stopped
    // carrying an extra credential.
    const res = await h.app.request(
      "/api/auth/sign-in/email",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: h.env.APP_URL as string,
          "x-forwarded-for": ip,
        },
        body: JSON.stringify({ email: admin.email, password: PASSWORD }),
      },
      h.env,
    );
    expect(res.status).toBe(200);
    const names = (res.headers.getSetCookie?.() ?? []).map((c) => c.split("=")[0] ?? "");
    expect(`sign-in issued session_data: ${names.some((n) => n.includes("session_data"))}`).toBe(
      "sign-in issued session_data: false",
    );
    // And it still issues the token, so the absence above is a disabled cache
    // and not a broken sign-in.
    expect(`sign-in issued session_token: ${names.some((n) => n.includes("session_token"))}`).toBe(
      "sign-in issued session_token: true",
    );
  });

  test("an isolate that never heard the revoke drops the session once it reads the epoch", async () => {
    // THE test for #319, and the one this file previously said could not be
    // written: "this harness is a single process ... a conclusion like
    // 'disabling cookieCache makes revocation immediate' is true in this file
    // and false in production, where every other isolate still serves its
    // cached copy for up to its own 30s."
    //
    // That neighbouring isolate is simulated rather than assumed. `revoke-others`
    // clears the LOCAL cache, so the entry is re-planted by hand afterwards,
    // stamped with an epoch from BEFORE the revoke — which is exactly the state
    // an isolate that never served the revoke is in.
    const device = await signInSeparately(admin.email);
    // Warm it so the real code has stored a real entry, then read the token the
    // way the middleware keys on it.
    expect((await device.cold("/api/me")).status).toBe(200);
    const staleUserId = (
      client.query("select id from users limit 1").get() as { id: string }
    ).id;

    await h.fetch(`${BASE}/revoke-others`, { method: "POST" });

    // The neighbour: still holding the entry, stamped before the bump. Keyed on
    // the SIGNED cookie, which is what the middleware looks up — planting under
    // the bare `sessions.token` would put it where nothing reads and make this
    // test pass for the ordinary reason instead of the one it is about.
    setCachedSession(device.signedToken, {
      userId: staleUserId,
      email: admin.email,
      sessionId: null,
      epoch: 0,
    });
    // …and its poll comes due, so it re-reads the epoch the revoke wrote.
    __resetEpochMemo();

    expect(`neighbour after its poll: ${(await device.cold("/api/me")).status}`).toBe(
      "neighbour after its poll: 401",
    );
  });

  test("the bound is the poll interval, not zero — and that is stated, not hidden", async () => {
    // The honest other half. Between the bump and a neighbour's next epoch read
    // it goes on serving, and no amount of shared state changes that without
    // putting a read on EVERY request. `EPOCH_TTL_MS` is that bound.
    //
    // Same setup as above with one difference: the memo is NOT reset, so the
    // neighbour is inside its poll window and has not heard yet.
    const device = await signInSeparately(admin.email);
    expect((await device.cold("/api/me")).status).toBe(200);
    const staleUserId = (
      client.query("select id from users limit 1").get() as { id: string }
    ).id;

    await h.fetch(`${BASE}/revoke-others`, { method: "POST" });

    // Planted with an epoch NEWER than anything the bump could have written, so
    // the entry is unambiguously inside its holder's poll window. Using
    // "whatever the epoch is now" would be the same assertion with a race in it.
    setCachedSession(device.signedToken, {
      userId: staleUserId,
      email: admin.email,
      sessionId: null,
      epoch: Number.MAX_SAFE_INTEGER,
    });

    expect(`inside the poll window: ${(await device.cold("/api/me")).status}`).toBe(
      "inside the poll window: 200",
    );
    expect(EPOCH_TTL_MS).toBeLessThanOrEqual(1_000);
  });
});

describe("API keys outlive a session revocation, and the endpoint says so", () => {
  /**
   * The gap this closes. `api_keys` is keyed on `user_id` and carries no
   * session reference at all, so "sign out my other devices" has never touched
   * one — which is what makes the ~90s revocation window above expensive: it is
   * long enough for a stolen session to mint a `pak_` key that survives the
   * sign-out completely.
   *
   * Revoking them by DEFAULT would be the worse bug, and that is the half these
   * tests spend the most effort on: the same personal key routinely powers a CI
   * job or a server integration that has nothing to do with the laptop being
   * signed out, so a default revoke turns a hygiene action into an outage.
   */
  const mintKey = async (name: string): Promise<{ id: string; secret: string }> => {
    const r = await h.fetch("/api/api-keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    expect(`mint ${name}: ${r.status}`).toBe(`mint ${name}: 201`);
    const { data } = (await r.json()) as { data: { id: string; secret: string } };
    return data;
  };

  /**
   * A bare Bearer call with NO cookie. Going through `h.fetch` would send the
   * caller's session jar too, and the request would pass on the cookie no
   * matter what the key's state is — the assertion would then be vacuous in
   * exactly the direction that matters.
   */
  const callWithKey = (secret: string) =>
    Promise.resolve(
      h.app.fetch(
        new Request(`${h.env.APP_URL}/api/me`, {
          headers: {
            Authorization: `Bearer ${secret}`,
            Origin: h.env.APP_URL as string,
            "x-forwarded-for": ip,
          },
        }),
      ),
    );

  test("the count is reported even when nothing is revoked", async () => {
    await mintKey("ci-deploy");
    await mintKey("reporting-job");
    const body = (await (
      await h.fetch(`${BASE}/revoke-others`, { method: "POST" })
    ).json()) as { ok: boolean; removed: number; apiKeys: number; apiKeysRevoked: number };
    // The number an operator has to act on, surfaced from a call that did not
    // touch it. Without this the gap is invisible from the endpoint, from its
    // response, and from the screen that calls it.
    expect(body).toEqual({ ok: true, removed: 0, apiKeys: 2, apiKeysRevoked: 0 });
  });

  test("by default the keys KEEP WORKING — a revoke is not an outage", async () => {
    const { secret: key } = await mintKey("ci-deploy");
    expect(`key before: ${(await callWithKey(key)).status}`).toBe("key before: 200");

    await signInSeparately(admin.email);
    const body = (await (
      await h.fetch(`${BASE}/revoke-others`, { method: "POST" })
    ).json()) as { removed: number; apiKeys: number; apiKeysRevoked: number };
    expect(`removed ${body.removed}, keys revoked ${body.apiKeysRevoked}`).toBe(
      "removed 1, keys revoked 0",
    );
    // The session went; the key did not. This is the assertion that keeps the
    // default safe, and it has to be made against a REAL request rather than
    // the count, because a count can be right while the credential is dead.
    expect(`key after: ${(await callWithKey(key)).status}`).toBe("key after: 200");
  });

  test("`?apiKeys=1` revokes them, and the credential really stops working", async () => {
    const { secret: key } = await mintKey("compromised");
    expect((await callWithKey(key)).status).toBe(200);

    const body = (await (
      await h.fetch(`${BASE}/revoke-others?apiKeys=1`, { method: "POST" })
    ).json()) as { ok: boolean; removed: number; apiKeys: number; apiKeysRevoked: number };
    expect(body).toEqual({ ok: true, removed: 0, apiKeys: 0, apiKeysRevoked: 1 });

    expect(`key after opt-in revoke: ${(await callWithKey(key)).status}`).toBe(
      "key after opt-in revoke: 401",
    );
  });

  test("`apiKeys` reports what is live AFTER the call, not before", async () => {
    // A response that reported the pre-call count would tell an operator who
    // just revoked everything that they still have keys to deal with.
    await mintKey("a");
    await mintKey("b");
    const body = (await (
      await h.fetch(`${BASE}/revoke-others?apiKeys=1`, { method: "POST" })
    ).json()) as { ok: boolean; removed: number; apiKeys: number; apiKeysRevoked: number };
    expect(body).toEqual({ ok: true, removed: 0, apiKeys: 0, apiKeysRevoked: 2 });
  });

  test("an already-revoked key is neither counted nor revoked twice", async () => {
    const keep = await mintKey("still-live");
    const gone = await mintKey("already-gone");
    expect((await h.fetch(`/api/api-keys/${gone.id}`, { method: "DELETE" })).status).toBe(200);
    // Liveness: the surviving key must actually work before the call, or the
    // 401 below would prove nothing about the revoke.
    expect(`keep works first: ${(await callWithKey(keep.secret)).status}`).toBe(
      "keep works first: 200",
    );

    const body = (await (
      await h.fetch(`${BASE}/revoke-others?apiKeys=1`, { method: "POST" })
    ).json()) as { ok: boolean; removed: number; apiKeys: number; apiKeysRevoked: number };
    // ONE revoked, not two: the already-dead key is neither counted nor touched.
    expect(body).toEqual({ ok: true, removed: 0, apiKeys: 0, apiKeysRevoked: 1 });
    expect(`the live one is gone too: ${(await callWithKey(keep.secret)).status}`).toBe(
      "the live one is gone too: 401",
    );
  });

  test("any other query value is treated as absent — only `1` revokes", async () => {
    // The flag destroys credentials, so it opts IN on one exact value rather
    // than on truthiness. `?apiKeys=0` and `?apiKeys=false` are the two a
    // caller would plausibly send meaning "no".
    const { secret: key } = await mintKey("safe");
    // `0` is a real answer and must work; anything else is refused rather
    // than guessed at, because guessing on a destructive flag is how a "no"
    // becomes a revoke.
    const r0 = await h.fetch(`${BASE}/revoke-others?apiKeys=0`, { method: "POST" });
    const b0 = (await r0.json()) as { apiKeysRevoked: number };
    expect(`apiKeys=0 -> ${r0.status}, revoked ${b0.apiKeysRevoked}`).toBe(
      "apiKeys=0 -> 200, revoked 0",
    );
    for (const q of ["true", "yes", "", "01"]) {
      const r = await h.fetch(`${BASE}/revoke-others?apiKeys=${q}`, { method: "POST" });
      expect(`apiKeys=${q} -> ${r.status}`).toBe(`apiKeys=${q} -> 422`);
    }
    expect(`key survived: ${(await callWithKey(key)).status}`).toBe("key survived: 200");
  });
});
