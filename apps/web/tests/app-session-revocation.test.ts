/**
 * Offboarding a customer — the journey nobody drives from the admin UI.
 *
 * The app-plane ACCESS TOKEN is a stateless HS256 JWT: `verifyAccessToken`
 * checks a signature and some claims and performs zero database reads. That is
 * what makes it cheap, and it is also why suspending an end-user did not
 * suspend them. `PATCH /api/app-users/{id}` deletes the user's `app_sessions`
 * rows, which reaches the two credentials that DO hit the database — the
 * opaque refresh token and the cookie — and misses the one the SDK actually
 * sends. A suspended, deleted or signed-out end-user kept full read and write
 * for the remainder of the token's TTL, while the suspend handler's own
 * docstring promised "existing tokens stop working immediately".
 *
 * `middleware/session.ts::appSessionLive` closes that by asking the
 * `app_sessions` row the token's `sid` names. This spec is the proof, and it
 * is written so that every refusal has a matching acceptance beside it: a test
 * that only ever sees a 401 cannot tell "revoked" from "never worked".
 *
 * ── the credential under test ───────────────────────────────────────────────
 *
 * Every sign-in path returns TWO tokens, and only one of them is interesting
 * here. `token` / `refreshToken` is the opaque `app_sessions.token`, which the
 * middleware has always resolved with a database read — deleting the row
 * always stopped it. `accessToken` is the JWT, and it is what these tests
 * carry. So each end-user below signs in and then exchanges the refresh token
 * at `POST /api/t/{slug}/auth/token/refresh` for the access JWT the SDK sends.
 *
 * ── what "immediate" means here, and what it does not ───────────────────────
 *
 * `appSessionLive` caches its answer per isolate for 30s (`TTL_MS` in
 * `services/permissions-cache.ts`), and the revocation handlers call
 * `invalidateAppSessions` so the isolate that SERVED the revocation evicts at
 * once. The whole suite runs in one process against one in-memory cache, so
 * every "immediate" below is the in-process guarantee: the isolate that
 * performed the suspend/delete/revoke refuses the token on the very next
 * request. Across a fleet, an isolate that had already cached a `true` for
 * that session id can still honour the token for the remainder of that 30s
 * window. Nobody should read the test-speed immediacy proven here as a
 * fleet-wide guarantee — 30s is the ceiling, and it is the same ceiling every
 * other identity fact on this path carries.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const JSON_HEADERS = { "Content-Type": "application/json" };
const END_USER_PASSWORD = "suspension-means-suspension";
const SLUG = "default";

/**
 * The app-plane surface used as the liveness probe.
 *
 * `GET /api/t/{slug}/orgs` is guarded by `requireAppUser`, which throws
 * UNAUTHORIZED "Workspace end-user sign-in required" when the request carries
 * no app-plane identity. That is exactly the distinction this spec needs: a
 * revoked token must fail as UNAUTHENTICATED (the credential is spent), not as
 * FORBIDDEN (a live identity that lacks a privilege).
 */
const PROBE = `/api/t/${SLUG}/orgs`;

interface ErrorBody {
  error?: { code?: string; message?: string };
}

let h: TestHarness;

const asEndUser = (accessToken: string, path = PROBE, init: RequestInit = {}) =>
  h.app.request(path, {
    ...init,
    headers: { ...JSON_HEADERS, ...(init.headers ?? {}), Authorization: `Bearer ${accessToken}` },
  });

const errorOf = async (res: Response): Promise<{ code?: string; message?: string }> =>
  ((await res.json()) as ErrorBody).error ?? {};

/** The `sid` claim — the `app_sessions` id this access token names. Read off
 *  the token itself rather than guessed, because "which row backs which token"
 *  is the entire subject of the scoped-revocation test below. */
const sidOf = (accessToken: string): string => {
  const payload = accessToken.split(".")[1];
  if (!payload) throw new Error(`not a JWT: ${accessToken.slice(0, 24)}…`);
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
    sid?: string;
  };
  if (!claims.sid) throw new Error("access token carries no `sid` claim");
  return claims.sid;
};

/** Exchange an opaque refresh token for the short-lived access JWT. Does NOT
 *  create a session — it re-signs against the row the refresh token already
 *  names, so a caller can hold several access tokens per session safely. */
const accessTokenFor = async (refreshToken: string): Promise<string> => {
  const res = await h.app.request(`/api/t/${SLUG}/auth/token/refresh`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ refreshToken }),
  });
  expect(res.status, "exchange refresh token for an access token").toBe(200);
  const { accessToken } = (await res.json()) as { accessToken: string };
  return accessToken;
};

/** Sign in on the app plane. Each call mints a NEW `app_sessions` row, which
 *  is how a user comes to hold two sessions (two devices). */
const signIn = async (email: string): Promise<string> => {
  const res = await h.app.request(`/api/t/${SLUG}/auth/sign-in/email`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ email, password: END_USER_PASSWORD }),
  });
  expect(res.status, `app-plane sign-in for ${email}`).toBe(200);
  const { token } = (await res.json()) as { token: string };
  return token;
};

/** Sign up an app-plane end-user, returning their id and first refresh token. */
const signUp = async (email: string): Promise<{ id: string; refreshToken: string }> => {
  const res = await h.app.request(`/api/t/${SLUG}/auth/sign-up/email`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ email, password: END_USER_PASSWORD, name: email }),
  });
  expect(res.status, `app-plane sign-up for ${email}`).toBe(200);
  const body = (await res.json()) as { token: string; user: { id: string } };
  return { id: body.user.id, refreshToken: body.token };
};

/** A live end-user holding the credential the SDK sends. */
const newEndUser = async (email: string) => {
  const { id, refreshToken } = await signUp(email);
  return { id, email, refreshToken, accessToken: await accessTokenFor(refreshToken) };
};

const setStatus = (appUserId: string, status: "active" | "suspended") =>
  h.fetch(`/api/app-users/${appUserId}`, {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify({ status }),
  });

const listSessionIds = async (appUserId: string): Promise<string[]> => {
  const res = await h.fetch(`/api/app-users/${appUserId}/sessions`);
  expect(res.status, "list end-user sessions").toBe(200);
  const { data } = (await res.json()) as { data: Array<{ id: string }> };
  return data.map((s) => s.id);
};

/**
 * The assertion the whole spec turns on: this token is refused, and refused as
 * an unauthenticated caller rather than an under-privileged one. A 403 here
 * would mean the credential still resolved to somebody — which is the bug.
 */
const expectSpent = async (accessToken: string, what: string): Promise<void> => {
  const res = await asEndUser(accessToken);
  expect(res.status, `${what}: the access token must be refused`).toBe(401);
  expect(await errorOf(res), `${what}: refused as unauthenticated, not unauthorized`).toMatchObject(
    { code: "UNAUTHORIZED", message: "Workspace end-user sign-in required" },
  );
};

/** The other half — proves the probe can answer 200, so a refusal above means
 *  something. */
const expectLive = async (accessToken: string, what: string): Promise<void> => {
  const res = await asEndUser(accessToken);
  expect(res.status, `${what}: the access token must still work`).toBe(200);
  const body = (await res.json()) as { data: unknown[] };
  expect(Array.isArray(body.data), `${what}: the probe answered with a real payload`).toBe(true);
};

beforeAll(async () => {
  h = makeHarness();
  // First signup → admin of the `default` workspace, which is the active
  // workspace for every `h.fetch` below. `/api/app-users/*` is
  // `requireUser + requireAdmin`, so this identity is the one allowed to
  // offboard an end-user.
  await seedAdmin(h);
});

afterAll(() => h.cleanup());

describe("suspending an end-user spends their access token", () => {
  test("the token works, then suspension refuses it on the very next request", async () => {
    const user = await newEndUser("suspend-me@example.test");

    // NON-VACUITY. Everything below is a refusal, and a refusal only means
    // something if the same call succeeded first.
    await expectLive(user.accessToken, "before suspension");

    const patched = await setStatus(user.id, "suspended");
    expect(patched.status, "suspend the end-user").toBe(200);

    // The token is still cryptographically valid and nowhere near its `exp`.
    // The ROW is what stopped it — which is the whole point, and what a purely
    // stateless check would have got wrong.
    await expectSpent(user.accessToken, "after suspension");
  });

  test("re-activating does not resurrect the old token; a fresh sign-in works", async () => {
    const user = await newEndUser("reactivate-me@example.test");
    await expectLive(user.accessToken, "before suspension");
    expect((await setStatus(user.id, "suspended")).status).toBe(200);
    await expectSpent(user.accessToken, "after suspension");

    expect((await setStatus(user.id, "active")).status, "re-activate the end-user").toBe(200);

    // Suspension DELETED the session rows, so re-activating restores the
    // account and not the credential: `appSessionLive` finds no row for this
    // `sid` and answers the same way it does for a suspended owner.
    await expectSpent(user.accessToken, "after re-activation");

    // …and the account really is usable again. Without this half, the
    // assertion above could be passing because the user is simply broken.
    const fresh = await accessTokenFor(await signIn(user.email));
    expect(sidOf(fresh), "a fresh sign-in names a different session row").not.toBe(
      sidOf(user.accessToken),
    );
    await expectLive(fresh, "after signing in again");
  });
});

describe("deleting an end-user spends their access token", () => {
  test("the token works, then deletion refuses it on the very next request", async () => {
    const user = await newEndUser("delete-me@example.test");
    await expectLive(user.accessToken, "before deletion");

    const deleted = await h.fetch(`/api/app-users/${user.id}`, { method: "DELETE" });
    expect(deleted.status, "delete the end-user").toBe(200);

    await expectSpent(user.accessToken, "after deletion");
  });
});

describe("revoking ONE session is scoped to that session", () => {
  test("the revoked device's token dies and the other keeps working", async () => {
    // Two sessions for one user — the shape the device list in the admin UI
    // shows, and the operation the stateless JWT used to ignore entirely.
    // Signing up minted the first row; signing in again mints a second.
    const user = await newEndUser("two-devices@example.test");
    const secondAccess = await accessTokenFor(await signIn(user.email));

    const deviceOne = sidOf(user.accessToken);
    const deviceTwo = sidOf(secondAccess);
    expect(deviceTwo, "two sign-ins must name two different session rows").not.toBe(deviceOne);

    const sessions = await listSessionIds(user.id);
    expect(sessions.sort(), "the admin device list shows both rows").toEqual(
      [deviceOne, deviceTwo].sort(),
    );

    await expectLive(user.accessToken, "device one before the revoke");
    await expectLive(secondAccess, "device two before the revoke");

    const revoked = await h.fetch(`/api/app-users/${user.id}/sessions/${deviceOne}`, {
      method: "DELETE",
    });
    expect(revoked.status, "revoke device one").toBe(200);

    await expectSpent(user.accessToken, "device one after the revoke");
    // Scope is the point. "Sign this device out" that signs every device out
    // is a different, and much worse, feature.
    await expectLive(secondAccess, "device two after the revoke");
    expect(await listSessionIds(user.id), "only the revoked row is gone").toEqual([deviceTwo]);
  });
});

describe("impersonation stays exempt", () => {
  test("an operator can act as a subject who has never signed in, and ending it cuts the token", async () => {
    // The subject is INVITED and nothing more: no password, no sign-in, and —
    // decisively for this test — no `app_sessions` row anywhere. An
    // impersonation token's `sid` is the synthetic `imp:<row-id>` that
    // `services/impersonation.ts` mints, so if `appSessionLive` were applied
    // to it the lookup would find nothing and the token would never work at
    // all. Acting as a customer who cannot sign in is precisely what support
    // impersonation is for.
    const invited = await h.fetch("/api/app-users/invite", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ email: "never-signed-in@example.test" }),
    });
    expect(invited.status, "invite an end-user").toBe(201);
    const subjectId = ((await invited.json()) as { data: { id: string } }).data.id;
    expect(await listSessionIds(subjectId), "the subject holds no session rows").toEqual([]);

    const started = await h.fetch("/api/admin/impersonation", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ subjectUserId: subjectId, reason: "offboarding audit" }),
    });
    expect(started.status, "start an impersonation").toBe(201);
    const session = (await started.json()) as { token: string; data: { id: string } };
    expect(sidOf(session.token), "an impersonation token names no app_sessions row").toBe(
      `imp:${session.data.id}`,
    );

    await expectLive(session.token, "while the impersonation is live");

    // The exemption is not a hole: the impersonation ROW is re-read on every
    // request, which is a stricter guarantee than the 30s-cached session
    // lookup — ending it takes effect with no cache window at all.
    const ended = await h.fetch(`/api/admin/impersonation/${session.data.id}/end`, {
      method: "POST",
    });
    expect(ended.status, "end the impersonation").toBe(200);
    await expectSpent(session.token, "after the impersonation ended");
  });
});
