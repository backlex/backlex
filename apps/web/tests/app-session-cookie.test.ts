import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const JSON_HEADERS = { "Content-Type": "application/json" };

/**
 * The app plane sets a `wo_<slug>.session_token` cookie on every end-user
 * sign-in, but the session middleware used to hand any `*session_token` cookie
 * to the CONTROL-plane better-auth instance, which can never recognise one. The
 * result: the same session was accepted as a bearer and rejected as a cookie.
 *
 * That is invisible to `fetch` callers (the SDK sends the bearer) and fatal to
 * `EventSource`, which cannot set headers — so realtime was unreachable for
 * every workspace end-user browser app.
 */
describe("app plane: session cookie authenticates like the bearer", () => {
  let h: TestHarness;
  let cookieHeader: string;
  let bearer: string;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);

    // A collection the end-user may read. Owner-scoped so the request has to
    // resolve a real identity — an anonymous fallback would read nothing.
    const created = await h.fetch("/api/collections", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        slug: "cookienotes",
        name: "Cookie notes",
        ownerScoped: true,
        fields: [{ name: "title", type: "text" }],
      }),
    });
    expect(created.status).toBe(201);

    const signup = await h.fetch("/api/t/default/auth/sign-up/email", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        email: "cookie.user@example.test",
        password: "cookie-pass-123",
        name: "Cookie User",
      }),
    });
    expect(signup.status).toBe(200);
    bearer = ((await signup.json()) as { token: string }).token;

    // better-auth signs the cookie as `<token>.<signature>`; grab it exactly as
    // the browser would replay it.
    const setCookie = signup.headers.getSetCookie?.() ?? [];
    const appCookie = setCookie
      .map((c) => c.split(";")[0] ?? "")
      .find((c) => c.startsWith("wo_") && c.includes("session_token="));
    expect(appCookie).toBeDefined();
    cookieHeader = appCookie as string;
  });

  afterAll(() => {
    h.cleanup();
  });

  // Call the app directly so ONLY the header under test is sent — the harness
  // cookie jar still holds the admin session and would mask the result.
  const raw = (path: string, headers: Record<string, string>) =>
    h.app.fetch(
      new Request(`${h.env.APP_URL}${path}`, {
        headers: { Origin: h.env.APP_URL, ...headers },
      }),
    );

  test("the bearer is accepted (baseline)", async () => {
    const res = await raw("/api/items/cookienotes", {
      Authorization: `Bearer ${bearer}`,
    });
    expect(res.status).toBe(200);
  });

  test("the app-plane cookie alone is accepted", async () => {
    const res = await raw("/api/items/cookienotes", { Cookie: cookieHeader });
    expect(res.status).toBe(200);
  });

  test("realtime subscribe accepts the cookie — EventSource cannot send headers", async () => {
    const res = await raw("/api/realtime/items:cookienotes/subscribe", {
      Cookie: cookieHeader,
    });
    expect(res.status).toBe(200);
    // Don't drain the SSE body — it stays open by design.
    await res.body?.cancel();
  });

  // The harness speaks plain HTTP, so better-auth emits the bare cookie name.
  // Over HTTPS it prefixes `__Secure-`, which the first cut of this fix didn't
  // strip — so it passed every local test and still 401'd in production.
  // Rebuild the production-shaped name here so that can't recur.
  test("the __Secure- prefixed cookie is accepted (production shape)", async () => {
    const res = await raw("/api/items/cookienotes", {
      Cookie: `__Secure-${cookieHeader}`,
    });
    expect(res.status).toBe(200);
  });

  test("__Secure- prefixed cookie authenticates realtime too", async () => {
    const res = await raw("/api/realtime/items:cookienotes/subscribe", {
      Cookie: `__Secure-${cookieHeader}`,
    });
    expect(res.status).toBe(200);
    await res.body?.cancel();
  });

  test("a garbage app cookie is still rejected", async () => {
    const res = await raw("/api/items/cookienotes", {
      Cookie: "wo_default.session_token=not-a-real-token.sig",
    });
    expect(res.status).toBe(401);
  });

  test("no credentials at all is still rejected", async () => {
    const res = await raw("/api/items/cookienotes", {});
    expect(res.status).toBe(401);
  });
});
