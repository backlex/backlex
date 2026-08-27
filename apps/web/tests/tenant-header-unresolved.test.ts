/**
 * An `X-Backlex-Tenant` that names nothing is refused, not swapped for a
 * different workspace.
 *
 * The header is the caller's explicit choice of workspace. A slug matching no
 * row used to resolve to `null` and fall straight through the rest of the
 * chain — cookie, active tenant, first membership, default — so the request
 * was answered, with a `200`, for a workspace the caller never named. Reads
 * returned another workspace's rows; writes landed in it. The asymmetry is
 * what marks it as a bug rather than a policy: a bogus *UUID* was already
 * refused (it is passed through and fails the membership check), only a bogus
 * *slug* redirected.
 *
 * Found by sending `{ name: "Shop 2", slug: "shop2" }` to `POST /api/tenants`,
 * which silently derived `shop-2` from the name and dropped the `slug` key —
 * after which every `X-Backlex-Tenant: shop2` call in that session ran against
 * the default workspace instead. Both halves are guarded here.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

describe("X-Backlex-Tenant: an unknown workspace is a 404", () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const res = await h.fetch("/api/collections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: "gadgets", fields: [{ name: "title", type: "text" }] }),
    });
    expect(res.status).toBe(201);
  });

  afterAll(() => h.cleanup());

  test("a read under an unknown slug is refused, not answered from the default workspace", async () => {
    const ok = await h.fetch("/api/collections");
    expect(ok.status).toBe(200);

    const res = await h.fetch("/api/collections", {
      headers: { "X-Backlex-Tenant": "no-such-workspace" },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.message).toContain("no-such-workspace");
  });

  test("a write under an unknown slug does not land in another workspace", async () => {
    const res = await h.fetch("/api/items/gadgets", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Backlex-Tenant": "typo-workspace" },
      body: JSON.stringify({ title: "stray row" }),
    });
    expect(res.status).toBe(404);

    // And nothing was written anywhere the caller could reach.
    const list = (await (await h.fetch("/api/items/gadgets")).json()) as { data: unknown[] };
    expect(list.data).toHaveLength(0);
  });

  test("an empty or whitespace-only header still means 'not sent'", async () => {
    // Indistinguishable from omitting it, and some clients send one regardless.
    for (const value of ["", "   "]) {
      const res = await h.fetch("/api/collections", { headers: { "X-Backlex-Tenant": value } });
      expect(res.status).toBe(200);
    }
  });

  test("the workspace's own slug still resolves", async () => {
    const mine = (await (await h.fetch("/api/tenants")).json()) as {
      data: { slug: string }[];
    };
    const slug = mine.data[0]?.slug;
    expect(typeof slug).toBe("string");
    const res = await h.fetch("/api/collections", {
      headers: { "X-Backlex-Tenant": slug as string },
    });
    expect(res.status).toBe(200);
  });
});

describe("X-Backlex-Tenant: 'unknown' and 'not yours' are the same answer", () => {
  let h: TestHarness;
  let foreignSlug: string;

  const JSON_HEADERS = { "Content-Type": "application/json" };

  beforeAll(async () => {
    h = makeHarness();
    // A — first signup, admin of `default`. A owns the foreign workspace.
    await seedAdmin(h);
    const created = await h.fetch("/api/tenants", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: `Private ${`${Date.now()}`.slice(-6)}` }),
    });
    expect(created.status).toBe(201);
    foreignSlug = ((await created.json()) as { data: { slug: string } }).data.slug;

    // B — an ordinary `authenticated` user with no membership in it.
    await h.fetch("/api/auth/sign-out", { method: "POST" });
    const up = await h.fetch("/api/auth/sign-up/email", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        email: `outsider-${Date.now()}@example.test`,
        password: "correct-horse-battery",
        name: "Outsider",
      }),
    });
    expect(up.ok).toBe(true);
  });

  afterAll(() => h.cleanup());

  test("a workspace that exists but is not the caller's answers exactly like one that does not", async () => {
    // Otherwise the header is an existence oracle: any signed-in user could
    // probe slugs and read off which workspaces exist from the status code.
    // Both cases fell through to the caller's own workspace before, so they
    // were indistinguishable — they have to stay that way.
    const real = await h.fetch("/api/collections", {
      headers: { "X-Backlex-Tenant": foreignSlug },
    });
    const fake = await h.fetch("/api/collections", {
      headers: { "X-Backlex-Tenant": "definitely-not-a-workspace" },
    });
    expect(real.status).toBe(fake.status);
    expect(real.status).toBe(404);

    const strip = (m: string) => m.replace(/"[^"]*"/, '"<slug>"');
    const realBody = (await real.json()) as { error: { code: string; message: string } };
    const fakeBody = (await fake.json()) as { error: { code: string; message: string } };
    expect(realBody.error.code).toBe(fakeBody.error.code);
    expect(strip(realBody.error.message)).toBe(strip(fakeBody.error.message));
  });

  test("the caller's own workspace is still reachable", async () => {
    const res = await h.fetch("/api/collections");
    expect(res.status).toBe(200);
  });
});

describe("POST /api/tenants: the slug is folded from the name and cannot be sent", () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });

  afterAll(() => h.cleanup());

  test("a supplied slug is refused by name rather than dropped", async () => {
    const res = await h.fetch("/api/tenants", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Shop Two", slug: "shoptwo" }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("VALIDATION");
    expect(body.error.message).toContain("slug");
  });

  test("the documented payload still creates a workspace", async () => {
    const res = await h.fetch("/api/tenants", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Shop Two", project: "retail", env: "development" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { slug: string; name: string } };
    expect(body.data.slug).toBe("shop-two");
    expect(body.data.name).toBe("Shop Two");
  });
});
