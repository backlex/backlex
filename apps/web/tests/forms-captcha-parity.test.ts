/**
 * The captcha a form's submit ENFORCES and the captcha its public definition
 * PUBLISHES have to be the same captcha.
 *
 * They were not. `publicFormDefinition` handed the page
 * `env.TURNSTILE_SITE_KEY` — a deployment-wide legacy variable — while the
 * submit handler enforced the WORKSPACE captcha config. No managed cloud
 * tenant sets that variable, so switching on `protect: ["forms"]` in the admin
 * left the hosted page with no widget to render, therefore no token to send,
 * therefore `Captcha verification failed` on every attempt — worded as though
 * the visitor had failed a challenge they were never shown. Found on a live
 * tenant on 2026-08-27; the form had been unsubmittable since the toggle.
 *
 * The invariant is deliberately written in BOTH directions, because only one
 * of them was broken and the other is what makes the first one safe to trust:
 * a definition that publishes a challenge must be enforced, and an enforced
 * challenge must be published. A test that only checked "protected forms
 * publish a key" would still pass a build that published a key for a form
 * nobody gates.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const JSON_HEADERS = { "Content-Type": "application/json" };
const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: JSON_HEADERS,
  body: JSON.stringify(body),
});

const realFetch = globalThis.fetch;

/** The provider always says yes. What is under test is whether the page can
 *  ever OBTAIN a token, not what the provider thinks of one. */
const stubProvider = (): void => {
  globalThis.fetch = (async (url: any, init: any) => {
    if (!/siteverify/.test(String(url))) return realFetch(url, init);
    return new Response(JSON.stringify({ success: true }), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
};

interface PublicDef {
  captcha: { provider: string; siteKey: string } | null;
  turnstileSiteKey: string | null;
}

describe("form captcha parity", () => {
  let h: TestHarness;
  let token = "";
  const slug = `lead_${Date.now()}`;

  const publicFetch = (path: string, init?: RequestInit) =>
    h.app.fetch(new Request(`${h.env.APP_URL}${path}`, init));

  const setCaptcha = (over: Record<string, unknown> = {}) =>
    h.fetch("/api/admin/captcha", {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        provider: "turnstile",
        siteKey: "ws-site-key",
        secretKey: "ws-secret-key",
        protect: ["forms"],
        onError: "deny",
        ...over,
      }),
    });

  const definition = async (): Promise<PublicDef> => {
    const res = await publicFetch(`/api/public/forms/${token}`);
    expect(res.status).toBe(200);
    const raw = await res.text();
    // `loadCaptchaConfig` returns the decrypted SECRET alongside the site key,
    // and this endpoint is unauthenticated. The secret really is present in the
    // config every caller here stores, so this negative is loaded rather than
    // vacuous — it would fail today if the pick became a spread.
    expect(raw).not.toContain("ws-secret-key");
    return (JSON.parse(raw) as { data: PublicDef }).data;
  };

  const submit = (extra: Record<string, unknown> = {}) =>
    publicFetch(
      `/api/public/forms/${token}/submit`,
      json({ data: { full_name: `Ada ${Math.random()}` }, ...extra }),
    );

  beforeEach(async () => {
    h = makeHarness();
    await seedAdmin(h);
    stubProvider();

    expect(
      (
        await h.fetch(
          "/api/collections",
          json({ slug, fields: [{ name: "full_name", type: "text", required: true }] }),
        )
      ).status,
    ).toBe(201);

    const created = await h.fetch(
      "/api/admin/forms",
      json({ name: "Leads", collection: slug, fields: [{ name: "full_name" }] }),
    );
    expect(created.status).toBe(201);
    token = ((await created.json()) as { data: { token: string } }).data.token;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    h.cleanup();
  });

  test("no workspace captcha: nothing published, nothing enforced", async () => {
    const def = await definition();
    expect(def.captcha).toBe(null);
    expect((await submit()).status).toBe(201);
  });

  test("a captcha that does NOT cover forms is neither published nor enforced", async () => {
    expect((await setCaptcha({ protect: ["sign-up"] })).status).toBe(200);
    const def = await definition();
    // Publishing a key here would tell the page to gate a submit that is not
    // gated — the mirror image of the bug, and just as confusing.
    expect(def.captcha).toBe(null);
    expect((await submit()).status).toBe(201);
  });

  test("protecting forms publishes the SAME key the submit enforces", async () => {
    expect((await setCaptcha()).status).toBe(200);

    const def = await definition();
    expect(def.captcha).toEqual({ provider: "turnstile", siteKey: "ws-site-key" });
    // Back-compat: a client written against the old single field gets the
    // workspace key too, because this workspace's provider IS Turnstile.
    expect(def.turnstileSiteKey).toBe("ws-site-key");

    // Enforcement is real...
    expect((await submit()).status).toBe(403);
    // ...and satisfiable with what the definition published.
    expect((await submit({ captchaToken: "tok" })).status).toBe(201);
  });

  test("the other two providers are published as themselves, not as Turnstile", async () => {
    for (const provider of ["hcaptcha", "recaptcha"] as const) {
      expect((await setCaptcha({ provider, siteKey: `${provider}-key` })).status).toBe(200);
      const def = await definition();
      expect(def.captcha).toEqual({ provider, siteKey: `${provider}-key` });
      // A non-Turnstile key handed to a client that only knows this field
      // would be rendered by the wrong widget and rejected — null is the
      // honest answer, and `captcha` above is where the truth lives.
      expect(def.turnstileSiteKey).toBe(null);
      expect((await submit()).status).toBe(403);
      expect((await submit({ captchaToken: "tok" })).status).toBe(201);
    }
  });
});
