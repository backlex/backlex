/**
 * Regression: suspending a workspace *membership* (`tenant_members.status =
 * 'suspended'`, via PATCH /api/users/{id}/suspend) must actually revoke access
 * on the request path — not just force a one-time logout.
 *
 * Before the fix the suspend handler only flipped `tenant_members.status` and
 * deleted sessions, but nothing on the request path consulted that status:
 * `isMember` was existence-only and the data-plane role resolver never looked
 * at membership. So a suspended user could simply sign back in (their
 * `users.status` is untouched) and `loadRolesForUser` restored their full role
 * set. This asserts the two halves of the fix:
 *   H1 — re-login after suspension yields zero workspace roles (routes 403).
 *   M1 — the suspended user's personal API keys are cascade-revoked.
 */
import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { Database } from "bun:sqlite";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const JSON_HEADERS = { "Content-Type": "application/json" };
const PASSWORD = "correct-horse-battery";

describe("membership suspend is enforced on the request path", () => {
  let h: TestHarness;
  let adminEmail: string;
  const slug = `notes_${Date.now()}_suspend`;
  const user2Email = `member-${Date.now()}@example.test`;
  let user2Id = "";
  let apiKeySecret = "";

  const signIn = (email: string) =>
    h.fetch("/api/auth/sign-in/email", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ email, password: PASSWORD }),
    });
  const signOut = () => h.fetch("/api/auth/sign-out", { method: "POST" });

  beforeAll(async () => {
    h = makeHarness();
    const adm = await seedAdmin(h);
    adminEmail = adm.email;

    // A collection the builtin `authenticated` role can read (owner-scoped →
    // every signed-in user gets a filtered read grant).
    const create = await h.fetch("/api/collections", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        slug,
        ownerScoped: true,
        fields: [{ name: "title", type: "text", required: true }],
      }),
    });
    expect(create.status).toBe(201);

    // user2 signs up → becomes an active member of the default workspace.
    await signOut();
    const su = await h.fetch("/api/auth/sign-up/email", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ email: user2Email, password: PASSWORD, name: "Member" }),
    });
    expect(su.status).toBe(200);

    // Mint a personal API key while still an active member.
    const key = await h.fetch("/api/api-keys", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: "member-key" }),
    });
    expect(key.status).toBe(201);
    apiKeySecret = ((await key.json()) as { data: { secret: string } }).data.secret;

    const db = new Database(h.env.SQLITE_PATH!);
    user2Id = (
      db.query("SELECT id FROM users WHERE email = ?").get(user2Email) as { id: string }
    ).id;
    db.close();
  });

  afterAll(() => {
    h.cleanup();
    void adminEmail;
  });

  test("active member can read the collection (cookie + API key)", async () => {
    // Cookie session (user2 is still signed in from sign-up).
    const viaCookie = await h.fetch(`/api/items/${slug}`);
    expect(viaCookie.status).toBe(200);

    // API key — drop the cookie first so the key path is exercised.
    await signOut();
    const viaKey = await h.fetch(`/api/items/${slug}`, {
      headers: { Authorization: `Bearer ${apiKeySecret}` },
    });
    expect(viaKey.status).toBe(200);
  });

  test("after suspension: re-login still authenticates but workspace routes 403", async () => {
    const adm = await signIn(adminEmail);
    expect(adm.status).toBe(200);
    const suspend = await h.fetch(`/api/users/${user2Id}/suspend`, { method: "PATCH" });
    expect(suspend.status).toBe(200);
    await signOut();

    // The crux: the user can STILL sign in (their `users.status` is active) —
    // this is exactly the path that used to restore access.
    const reLogin = await signIn(user2Email);
    expect(reLogin.status).toBe(200);

    // …but they now hold zero roles in the workspace, so reads are denied.
    const items = await h.fetch(`/api/items/${slug}`);
    expect(items.status).toBe(403);
  });

  test("after suspension: the member's API key is revoked", async () => {
    await signOut();
    const viaKey = await h.fetch(`/api/items/${slug}`, {
      headers: { Authorization: `Bearer ${apiKeySecret}` },
    });
    expect(viaKey.status).not.toBe(200);
  });
});
