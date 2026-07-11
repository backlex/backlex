/**
 * Account avatar — user-scoped, workspace-independent.
 *
 * Regression for the "broken avatar after switching workspaces" bug: the old
 * flow uploaded the profile picture through the tenant-scoped storage surface
 * (`PUT /api/storage/account-avatars/<uid>.<ext>`), which namespaced the
 * object under `tenants/<active-tenant>/…`. `user.image` is a *user*-level
 * field shared across every workspace, so as soon as the user switched to a
 * different workspace the same URL resolved under the new tenant's namespace
 * and 404'd.
 *
 * The dedicated `/api/account/avatar` surface stores the object at the
 * un-prefixed physical key `account/<uid>/avatar` — reachable no matter which
 * workspace is active.
 */
import { describe, test, expect, afterAll, beforeAll } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

// 1×1 transparent PNG.
const PNG_BYTES = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  ),
  (ch) => ch.charCodeAt(0),
);

describe("account avatar", () => {
  let h: TestHarness;
  let avatarUrl: string;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  test("PUT /api/account/avatar stores the image and returns a render URL", async () => {
    const res = await h.fetch("/api/account/avatar", {
      method: "PUT",
      headers: { "content-type": "image/png" },
      body: PNG_BYTES,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { url: string; size: number } };
    expect(body.data.url).toMatch(/^\/api\/account\/avatar\/[A-Za-z0-9_-]+\?v=/);
    expect(body.data.size).toBe(PNG_BYTES.byteLength);
    avatarUrl = body.data.url;
  });

  test("GET serves the avatar with an image content type", async () => {
    const res = await h.fetch(avatarUrl);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.byteLength).toBe(PNG_BYTES.byteLength);
  });

  test("GET keeps working when a different workspace is active", async () => {
    // Create a second workspace and read the avatar with it pinned active —
    // this is the exact path that 404'd under the tenant-scoped flow.
    const create = await h.fetch("/api/tenants", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Avatar Second WS" }),
    });
    expect(create.status).toBe(201);
    const { data } = (await create.json()) as { data: { slug: string } };

    const res = await h.fetch(avatarUrl, {
      headers: { "X-Backlex-Tenant": data.slug },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
  });

  test("etag round-trips as a 304", async () => {
    const first = await h.fetch(avatarUrl);
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();
    const second = await h.fetch(avatarUrl, {
      headers: { "if-none-match": etag! },
    });
    expect(second.status).toBe(304);
  });

  test("rejects non-image content types", async () => {
    const res = await h.fetch("/api/account/avatar", {
      method: "PUT",
      headers: { "content-type": "text/html" },
      body: "<script>alert(1)</script>",
    });
    expect(res.status).toBe(422);
  });

  test("another signed-in user can read it; anonymous cannot", async () => {
    // Anonymous: a bare app.fetch call carries no cookie jar.
    const anon = await h.app.fetch(
      new Request(`http://localhost:5173${avatarUrl}`),
    );
    expect(anon.status).toBe(401);

    // Second user (open signup is enabled by seedAdmin) — sign-up switches
    // the harness cookie jar to the new session.
    const signUp = await h.fetch("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: `viewer-${Date.now()}@example.test`,
        password: "correct-horse-battery",
        name: "Viewer",
      }),
    });
    expect(signUp.ok).toBe(true);
    const res = await h.fetch(avatarUrl);
    expect(res.status).toBe(200);
  });

  test("DELETE removes only the caller's own avatar", async () => {
    // The harness is now signed in as the viewer. Deleting with no avatar of
    // their own is a 200 noop — and must not touch the admin's object.
    const noop = await h.fetch("/api/account/avatar", { method: "DELETE" });
    expect(noop.status).toBe(200);
    expect((await h.fetch(avatarUrl)).status).toBe(200);

    // Upload as the viewer, delete, and confirm it's gone.
    const put = await h.fetch("/api/account/avatar", {
      method: "PUT",
      headers: { "content-type": "image/png" },
      body: PNG_BYTES,
    });
    expect(put.status).toBe(201);
    const { data } = (await put.json()) as { data: { url: string } };
    expect((await h.fetch(data.url)).status).toBe(200);
    expect(
      (await h.fetch("/api/account/avatar", { method: "DELETE" })).status,
    ).toBe(200);
    expect((await h.fetch(data.url)).status).toBe(404);
  });
});
