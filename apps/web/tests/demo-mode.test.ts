/**
 * Playground (DEMO_MODE) — the no-signup demo instance behind the website's
 * "try it live" funnel (roadmap #16).
 *
 *  - `/api/auth/providers` publishes the demo credentials (demo mode only),
 *  - the write-guard 403s outbound/destructive endpoints,
 *  - `resetDemoWorkspace` wipes visitor state (collections, users, api keys)
 *    and converges on a seeded workspace whose demo admin can sign in with
 *    the published credentials — including bootstrapping a brand-new DB via
 *    `maybeResetDemo` without any manual sign-up.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import { buildContext } from "../src/server/context";
import {
  DEMO_RETRY_BACKOFF_MS,
  demoResetIntervalMs,
  isDemoBlockedRequest,
  maybeResetDemo,
  resetDemoWorkspace,
} from "../src/server/services/demo";

const JSON_HEADERS = { "Content-Type": "application/json" };

let h: TestHarness;
afterEach(() => h?.cleanup());

describe("demo mode — auth surface", () => {
  test("publishes demo credentials only when DEMO_MODE is set", async () => {
    h = makeHarness({ DEMO_MODE: "1" });
    const res = await h.fetch("/api/auth/providers");
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as any;
    expect(data.demo).toEqual({ email: "demo@backlex.com", password: "playground" });
    h.cleanup();

    h = makeHarness();
    const plain = await h.fetch("/api/auth/providers");
    const { data: plainData } = (await plain.json()) as any;
    expect(plainData.demo).toBeUndefined();
  });

  test("DEMO_EMAIL / DEMO_PASSWORD override the published credentials", async () => {
    h = makeHarness({
      DEMO_MODE: "true",
      DEMO_EMAIL: "try@backlex.com",
      DEMO_PASSWORD: "let-me-in",
    });
    const { data } = (await (await h.fetch("/api/auth/providers")).json()) as any;
    expect(data.demo).toEqual({ email: "try@backlex.com", password: "let-me-in" });
  });
});

describe("demo mode — write guard", () => {
  test("isDemoBlockedRequest blocks writes on the deny-list, never reads", () => {
    expect(isDemoBlockedRequest("POST", "/api/admin/email-config")).toBe(true);
    expect(isDemoBlockedRequest("PATCH", "/api/admin/auth/config")).toBe(true);
    expect(isDemoBlockedRequest("POST", "/api/messaging/send")).toBe(true);
    expect(isDemoBlockedRequest("POST", "/api/auth/change-password")).toBe(true);
    expect(isDemoBlockedRequest("POST", "/api/admin/db/query")).toBe(true);
    expect(isDemoBlockedRequest("GET", "/api/admin/email-config")).toBe(false);
    // Prefix must match on a path boundary, not raw startsWith.
    expect(isDemoBlockedRequest("POST", "/api/admin/dbx")).toBe(false);
    // The demo experience itself stays writable.
    expect(isDemoBlockedRequest("POST", "/api/collections")).toBe(false);
    expect(isDemoBlockedRequest("POST", "/api/auth/sign-in/email")).toBe(false);
  });

  test("blocked endpoints 403 in demo mode and stay open otherwise", async () => {
    h = makeHarness({ DEMO_MODE: "1" });
    await seedAdmin(h, undefined, undefined, { openSignup: false });
    const blocked = await h.fetch("/api/admin/email-config", {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({}),
    });
    expect(blocked.status).toBe(403);
    const body = (await blocked.json()) as any;
    expect(body.error?.message ?? body.message).toContain("playground");
    // Reads on the same prefix still work.
    const read = await h.fetch("/api/admin/email-config");
    expect(read.status).not.toBe(403);
  });
});

describe("demo mode — reset", () => {
  test("resetDemoWorkspace wipes visitor state and reseeds the demo admin + template", async () => {
    h = makeHarness({ DEMO_MODE: "1", SEED_TEMPLATE: "blog" });
    // A visitor-ish admin signs up (first user) and leaves junk behind.
    await seedAdmin(h, "visitor@example.test", "correct-horse-battery", {
      openSignup: false,
    });
    const created = await h.fetch("/api/collections", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        slug: "junk",
        name: "Junk",
        fields: [{ name: "title", type: "text" }],
      }),
    });
    expect(created.status).toBe(201);

    const ctx = await buildContext(h.env);
    const result = await resetDemoWorkspace(ctx, h.env);
    expect(result.templateApplied).toBe(true);
    expect(result.droppedCollections).toBeGreaterThanOrEqual(1);

    // The visitor's account died with the wipe. (Within better-auth's 60s
    // cookie-cache window the stale session may still "authenticate", but the
    // user row is gone → 404; past the window it's a plain 401.)
    const stale = await h.fetch("/api/me");
    expect([401, 404]).toContain(stale.status);

    // The published demo credentials sign straight in as admin…
    const signIn = await h.fetch("/api/auth/sign-in/email", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ email: "demo@backlex.com", password: "playground" }),
    });
    expect(signIn.status).toBe(200);

    // …and see the seeded template collections, not the visitor's junk.
    const list = await h.fetch("/api/collections");
    expect(list.status).toBe(200);
    const { data } = (await list.json()) as any;
    const slugs = (data as Array<{ slug: string }>).map((c) => c.slug);
    expect(slugs).not.toContain("junk");
    expect(slugs.length).toBeGreaterThan(0);

    // A reset that just ran parks the timer for the full interval.
    expect(await maybeResetDemo(ctx, h.env, new Date())).toBe(false);
    const later = new Date(Date.now() + demoResetIntervalMs(h.env) + 1000);
    expect(await maybeResetDemo(ctx, h.env, later)).toBe(true);
  });

  test("a failed reset hands the claim back instead of parking for the interval", async () => {
    h = makeHarness({ DEMO_MODE: "1", SEED_TEMPLATE: "blog" });
    const ctx = await buildContext(h.env);

    // Reproduce what took the live playground down: the D1 drifted behind the
    // schema, so every reset wiped the workspace and then died seeding roles.
    // The claim is written *before* the wipe, so the old code left visitors an
    // empty workspace with a role-less demo admin until the next hour.
    await (ctx.db as any).run(sql`DROP TABLE roles`);
    const t0 = new Date();
    await expect(maybeResetDemo(ctx, h.env, t0)).rejects.toThrow();

    // Inside the backoff window the claim still holds — no per-minute retry storm.
    const soon = new Date(t0.getTime() + DEMO_RETRY_BACKOFF_MS - 1000);
    expect(await maybeResetDemo(ctx, h.env, soon)).toBe(false);

    // Past it the reset is attempted again (and throws again, because the
    // schema is still broken) rather than sitting on a wiped workspace.
    const after = new Date(t0.getTime() + DEMO_RETRY_BACKOFF_MS + 1000);
    await expect(maybeResetDemo(ctx, h.env, after)).rejects.toThrow();
  });

  test("maybeResetDemo bootstraps a brand-new instance without any sign-up", async () => {
    h = makeHarness({ DEMO_MODE: "1", SEED_TEMPLATE: "blog" });
    const ctx = await buildContext(h.env);
    expect(await maybeResetDemo(ctx, h.env, new Date())).toBe(true);

    const signIn = await h.fetch("/api/auth/sign-in/email", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ email: "demo@backlex.com", password: "playground" }),
    });
    expect(signIn.status).toBe(200);
    const list = await h.fetch("/api/collections");
    expect(list.status).toBe(200);
    const { data } = (await list.json()) as any;
    expect((data as unknown[]).length).toBeGreaterThan(0);
  });
});

/**
 * The route, as opposed to the service the tests above call directly.
 *
 * `POST /api/admin/demo/reset` is a one-request destructor: it drops every
 * managed collection's physical table and reseeds. The service refuses to run
 * outside demo mode, but the service is not what an operator's browser reaches
 * — the route is, and the route carries its OWN `isDemoMode` check plus three
 * middlewares. Nothing asserted that stack, so a production instance's admin
 * being one POST away from a wiped workspace would have been a silent change.
 */
describe("demo mode — the reset endpoint", () => {
  const reset = () => h.fetch("/api/admin/demo/reset", { method: "POST" });

  test("a normal instance does not have this endpoint at all", async () => {
    h = makeHarness(); // no DEMO_MODE
    await seedAdmin(h);
    // Liveness: an admin session that can reach other admin routes, so the 404
    // below is the demo gate and not a failed sign-in.
    expect((await h.fetch("/api/collections")).status).toBe(200);

    const res = await reset();
    expect(res.status).toBe(404);
    // Still signed in and still holding a workspace — the refusal must not have
    // been a half-run reset.
    expect((await h.fetch("/api/collections")).status).toBe(200);
  });

  test("a playground instance resets, and says what it did", async () => {
    h = makeHarness({ DEMO_MODE: "1", SEED_TEMPLATE: "blog" });
    // `seedAdmin` cannot be used here: it enables open signup first, and the
    // playground refuses that (403 "disabled in the playground"). The demo
    // admin is bootstrapped by the reset path itself and signs in with the
    // credentials the instance publishes.
    const ctx = await buildContext(h.env);
    expect(await maybeResetDemo(ctx, h.env, new Date())).toBe(true);
    const signIn = await h.fetch("/api/auth/sign-in/email", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ email: "demo@backlex.com", password: "playground" }),
    });
    expect(signIn.status).toBe(200);

    const res = await reset();
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as any;
    // The service's own tests pin the wipe; what the ROUTE owes is the report,
    // because the admin UI renders it as the confirmation that anything ran.
    expect(data).toBeTruthy();
    expect(typeof data).toBe("object");
  });

  test("a signed-out visitor cannot reset the playground", async () => {
    // The instance is public and the credentials are printed on its sign-in
    // screen, which makes it tempting to treat the reset as public too. It is
    // not: an anonymous POST would let a passer-by wipe a live demo mid-use.
    h = makeHarness({ DEMO_MODE: "1" });
    const res = await h.app.request(
      "/api/admin/demo/reset",
      { method: "POST", headers: { origin: h.env.APP_URL as string } },
      h.env,
    );
    expect(res.status).toBe(401);
  });
});
