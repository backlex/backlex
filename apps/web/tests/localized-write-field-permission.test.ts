/**
 * A write permission's field allowlist covers localized columns too.
 *
 * `validateBody` is the ONLY place `perm.fields` is checked on a write, and it
 * walks the payload's own keys. `splitLocalized` empties the payload of every
 * localized column before that runs — so the check never saw them, and a role
 * granted `update` on `{title}` could also write any localized field on the
 * same collection. Read-side field permissions were never affected; this is the
 * write half only.
 *
 * Found while making a locale-less write file under the workspace default
 * instead of 422-ing. That change is what made this reachable without naming a
 * locale, which is why it is closed here rather than noted for later.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const JSON_HEADERS = { "content-type": "application/json" };
const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: JSON_HEADERS,
  body: JSON.stringify(body),
});

describe("a localized column obeys the write field allowlist", () => {
  let h: TestHarness;
  const slug = `lwp_${Date.now()}`;
  let userToken = "";

  const asUser = (path: string, init: RequestInit = {}) =>
    h.app.request(path, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${userToken}` },
    });

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    await h.fetch("/api/admin/settings", json("PATCH", { i18nLocales: ["en", "tr"], i18nDefaultLocale: "en" }));

    const created = await h.fetch(
      "/api/collections",
      json("POST", {
        slug,
        fields: [
          { name: "title", type: "text" },
          { name: "secret_note", type: "text", localized: true },
        ],
      }),
    );
    expect(created.status).toBe(201);

    const roles = await h.fetch("/api/roles");
    const roleId = ((await roles.json()) as { data: { id: string; name: string }[] }).data.find(
      (r) => r.name === "authenticated",
    )!.id;
    // `title` only. `secret_note` is deliberately NOT writable by this role.
    for (const action of ["create", "update", "read"]) {
      const granted = await h.fetch(
        `/api/roles/${roleId}/permissions`,
        json("POST", { collection: slug, action, fields: ["title"] }),
      );
      expect(granted.status).toBeLessThan(300);
    }

    const invited = await h.fetch("/api/app-users/invite", json("POST", { email: `w-${Date.now()}@perm.test` }));
    expect(invited.status).toBe(201);
    const { data } = (await invited.json()) as { data: { token: string } };
    const accepted = await h.app.request(
      "/api/t/default/auth/invite/accept",
      json("POST", { token: data.token, password: "perm-pass-12345" }),
    );
    expect(accepted.status).toBe(200);
    userToken = ((await accepted.json()) as { token: string }).token;
  });
  afterAll(() => h.cleanup());

  test("the allowed column still writes", async () => {
    // Control. Without it a blanket 403 — a broken role, a bad token — would
    // read exactly like the rule working.
    const ok = await asUser(`/api/items/${slug}`, json("POST", { title: "fine" }));
    expect(ok.status).toBe(201);
  });

  test("a bare localized value is refused, not filed under the default locale", async () => {
    const res = await asUser(`/api/items/${slug}`, json("POST", { title: "x", secret_note: "leak" }));
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("secret_note");
  });

  test("naming a locale does not get around it", async () => {
    const q = await asUser(`/api/items/${slug}?locale=tr`, json("POST", { title: "x", secret_note: "leak" }));
    expect(q.status).toBe(403);
    const map = await asUser(`/api/items/${slug}`, json("POST", { title: "x", secret_note: { tr: "leak" } }));
    expect(map.status).toBe(403);
  });

  test("clearing the column is a write too", async () => {
    // `{field: null}` on a locale-less write takes the value out of EVERY
    // locale. Refusing the set while allowing the clear would be a strange rule.
    const cleared = await asUser(`/api/items/${slug}`, json("POST", { title: "x", secret_note: null }));
    expect(cleared.status).toBe(403);
  });
});
