/**
 * Account preferences (per-user locale + time zone) and the workspace-level
 * language list + default time zone.
 *
 * Resolution model: a user's effective locale/time zone is their own override
 * (`users.locale` / `users.timezone`) falling through to the workspace default
 * (`app_settings`), falling through to `en` / `UTC`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

describe("account preferences + workspace locale/timezone", () => {
  let h: TestHarness;
  afterEach(() => h?.cleanup());

  /** Build a JSON PATCH init. */
  const patch = (body: unknown): RequestInit => ({
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const getPrefs = async (): Promise<{
    user: { locale: string | null; timezone: string | null };
    workspace: { defaultLocale: string; locales: string[]; timezone: string };
    effective: { locale: string; timezone: string };
  }> => {
    const res = await h.fetch("/api/account/preferences");
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: any }).data;
  };

  test("GET /api/account/preferences requires a session", async () => {
    h = makeHarness();
    const res = await h.fetch("/api/account/preferences");
    expect(res.status).toBe(401);
  });

  test("a fresh user inherits en / UTC defaults", async () => {
    h = makeHarness();
    await seedAdmin(h);
    const d = await getPrefs();
    expect(d.user).toEqual({ locale: null, timezone: null });
    expect(d.workspace.timezone).toBe("UTC");
    expect(d.workspace.locales.length).toBeGreaterThan(0);
    expect(d.effective.timezone).toBe("UTC");
    expect(d.effective.locale).toBe(d.workspace.defaultLocale);
  });

  test("PATCH stores the user's locale + time zone", async () => {
    h = makeHarness();
    await seedAdmin(h);
    const res = await h.fetch(
      "/api/account/preferences",
      patch({ locale: "tr", timezone: "Europe/Istanbul" }),
    );
    expect(res.status).toBe(200);
    const d = await getPrefs();
    expect(d.user).toEqual({ locale: "tr", timezone: "Europe/Istanbul" });
    expect(d.effective).toEqual({ locale: "tr", timezone: "Europe/Istanbul" });
  });

  test("null clears a single preference, leaving the other untouched", async () => {
    h = makeHarness();
    await seedAdmin(h);
    await h.fetch(
      "/api/account/preferences",
      patch({ locale: "tr", timezone: "Europe/Istanbul" }),
    );
    const res = await h.fetch("/api/account/preferences", patch({ locale: null }));
    expect(res.status).toBe(200);
    const d = await getPrefs();
    expect(d.user.locale).toBeNull();
    expect(d.user.timezone).toBe("Europe/Istanbul");
  });

  test("rejects an unknown IANA time zone", async () => {
    h = makeHarness();
    await seedAdmin(h);
    const res = await h.fetch(
      "/api/account/preferences",
      patch({ timezone: "Mars/Olympus" }),
    );
    expect(res.status).toBe(400);
  });

  test("rejects a malformed locale code", async () => {
    h = makeHarness();
    await seedAdmin(h);
    const res = await h.fetch("/api/account/preferences", patch({ locale: "!!" }));
    expect(res.status).toBe(400);
  });

  test("rejects unknown keys (strict body)", async () => {
    h = makeHarness();
    await seedAdmin(h);
    const res = await h.fetch("/api/account/preferences", patch({ nope: 1 }));
    expect(res.status).toBe(400);
  });

  test("workspace time zone flows into a user's effective values", async () => {
    h = makeHarness();
    await seedAdmin(h);
    const set = await h.fetch(
      "/api/admin/settings",
      patch({ timezone: "America/New_York" }),
    );
    expect(set.status).toBe(200);
    const d = await getPrefs();
    expect(d.workspace.timezone).toBe("America/New_York");
    expect(d.effective.timezone).toBe("America/New_York");
  });

  test("a personal time zone overrides the workspace default", async () => {
    h = makeHarness();
    await seedAdmin(h);
    await h.fetch("/api/admin/settings", patch({ timezone: "America/New_York" }));
    await h.fetch("/api/account/preferences", patch({ timezone: "Asia/Tokyo" }));
    const d = await getPrefs();
    expect(d.workspace.timezone).toBe("America/New_York");
    expect(d.effective.timezone).toBe("Asia/Tokyo");
  });

  test("settings rejects an invalid workspace time zone", async () => {
    h = makeHarness();
    await seedAdmin(h);
    const res = await h.fetch("/api/admin/settings", patch({ timezone: "Not/AZone" }));
    expect(res.status).toBe(400);
  });

  test("the workspace language list round-trips and drives the default", async () => {
    h = makeHarness();
    await seedAdmin(h);
    const res = await h.fetch(
      "/api/admin/settings",
      patch({ i18nLocales: ["en", "tr", "de"], i18nDefaultLocale: "tr" }),
    );
    expect(res.status).toBe(200);
    const d = await getPrefs();
    expect(d.workspace.locales).toEqual(["en", "tr", "de"]);
    expect(d.workspace.defaultLocale).toBe("tr");
    // A user with no override now inherits the new workspace default.
    expect(d.effective.locale).toBe("tr");
  });

  test("settings rejects a default locale absent from the language list", async () => {
    h = makeHarness();
    await seedAdmin(h);
    const res = await h.fetch(
      "/api/admin/settings",
      patch({ i18nLocales: ["en", "tr"], i18nDefaultLocale: "ja" }),
    );
    expect(res.status).toBe(400);
  });
});
