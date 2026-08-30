import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

/**
 * `GET /api/t/:slug/auth/invite/:token` — the public preview the end-user
 * invitation page (`/t/:slug/join/:token`) renders before the invitee has an
 * account.
 *
 * Two properties are load-bearing and neither is visible from the handler
 * alone, which is why they are pinned here rather than left to review:
 *
 *  1. It answers a caller with NO session. `h.app.request` sends no cookies and
 *     no Authorization header, which is exactly the invitee's situation — the
 *     link arrived by mail, on whatever device opened it. This also proves the
 *     route is not swallowed by the better-auth catch-all it is registered in
 *     front of (`.all("/:slug/auth/*")`): if it were, the response would be
 *     better-auth's own 404 rather than a `{ data }` envelope.
 *
 *  2. Every unusable token answers ONE byte-identical body. Unknown, expired,
 *     already spent, and pointing at a suspended account are four different
 *     server states and one response, so the endpoint cannot be walked to learn
 *     which invitation tokens exist or which addresses were ever invited here.
 *     A test that only checked `valid === false` would pass while the handler
 *     leaked the invited address on the expired branch, so these assert the
 *     WHOLE body by deep equality against a single shared constant.
 */

const JSON_HEADERS = { "content-type": "application/json" };

/** The one body every refusal must produce. Declared once so a test cannot
 *  accidentally bless a second shape. */
const UNUSABLE = { valid: false, workspaceName: null, email: null };

interface Invited {
  id: string;
  email: string;
  token: string;
}

const invite = async (h: TestHarness, email: string): Promise<Invited> => {
  const res = await h.fetch("/api/app-users/invite", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ email }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { data: Invited };
  return body.data;
};

/** The public resolve call, made the way the invitee makes it: no cookies, no
 *  Authorization header, nothing but the URL. */
const resolve = async (h: TestHarness, token: string): Promise<Response> =>
  h.app.request(`/api/t/default/auth/invite/${encodeURIComponent(token)}`);

const dataOf = async (res: Response): Promise<Record<string, unknown>> => {
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: Record<string, unknown> };
  return body.data;
};

describe("public end-user invite resolve", () => {
  test("answers an anonymous caller with the workspace name + invited address, and nothing else", async () => {
    const h = makeHarness();
    try {
      await seedAdmin(h);
      const inv = await invite(h, "Ada@X.Test");

      const res = await resolve(h, inv.token);
      // No `Authorization`, no cookie jar — `h.app.request` is the raw app.
      const data = await dataOf(res);

      const db = new Database(h.env.SQLITE_PATH as string);
      const ws = db
        .query("SELECT name FROM tenants WHERE slug = 'default'")
        .get() as { name: string } | null;
      db.close();
      expect(ws?.name).toBeTruthy();

      expect(data).toEqual({
        valid: true,
        workspaceName: ws!.name,
        // Normalised at invite time; the preview echoes what was stored, so the
        // page's locked email box matches the address accept will bind.
        email: "ada@x.test",
      });

      // The key set is asserted exactly. A future field added to the handler —
      // a tenant id, a role list, who sent it — would fail here, which is the
      // point: this response is read by a stranger holding only a mailed URL.
      expect(Object.keys(data).sort()).toEqual(["email", "valid", "workspaceName"]);
    } finally {
      h.cleanup();
    }
  });

  test("unknown, expired, spent and suspended are one indistinguishable answer", async () => {
    const h = makeHarness();
    try {
      await seedAdmin(h);

      // (a) a token that was never issued.
      expect(await dataOf(await resolve(h, "not-a-real-token"))).toEqual(UNUSABLE);

      // (b) expired. Aged out directly in the row rather than by waiting: the
      // TTL is 7 days. The identifier is a digest of the token now, so the row
      // is found by the appUserId embedded in its JSON `value`.
      const stale = await invite(h, "stale@x.test");
      const db = new Database(h.env.SQLITE_PATH as string);
      const aged = db.run(
        "UPDATE app_verifications SET expires_at = ? WHERE value LIKE ?",
        [Date.now() - 60_000, `%${stale.id}%`],
      );
      expect(aged.changes).toBe(1);
      db.close();
      expect(await dataOf(await resolve(h, stale.token))).toEqual(UNUSABLE);

      // (c) already spent. Accept consumes the one-shot row.
      const spent = await invite(h, "spent@x.test");
      const accepted = await h.app.request("/api/t/default/auth/invite/accept", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ token: spent.token, password: "invite-pass-123" }),
      });
      expect(accepted.status).toBe(200);
      expect(await dataOf(await resolve(h, spent.token))).toEqual(UNUSABLE);

      // (d) the invitation is live but the account behind it was suspended, so
      // accept would refuse it. The preview has to agree, or the page seats the
      // invitee at a form that cannot succeed.
      const barred = await invite(h, "barred@x.test");
      const db2 = new Database(h.env.SQLITE_PATH as string);
      const susp = db2.run("UPDATE app_users SET status = 'suspended' WHERE id = ?", [
        barred.id,
      ]);
      expect(susp.changes).toBe(1);
      db2.close();
      expect(await dataOf(await resolve(h, barred.token))).toEqual(UNUSABLE);
    } finally {
      h.cleanup();
    }
  });

  test("a live invitation still resolves after an unrelated one is spent", async () => {
    // Guards the one-shot consume against over-reach: accepting one invitation
    // must not invalidate another workspace member's pending link. Cheap to
    // check and the kind of thing a `DELETE ... WHERE identifier LIKE` would
    // break silently.
    const h = makeHarness();
    try {
      await seedAdmin(h);
      const first = await invite(h, "first@x.test");
      const second = await invite(h, "second@x.test");

      const accepted = await h.app.request("/api/t/default/auth/invite/accept", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ token: first.token, password: "invite-pass-123" }),
      });
      expect(accepted.status).toBe(200);

      const data = await dataOf(await resolve(h, second.token));
      expect(data.valid).toBe(true);
      expect(data.email).toBe("second@x.test");
    } finally {
      h.cleanup();
    }
  });
});
