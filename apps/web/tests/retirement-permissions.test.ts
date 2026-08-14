/**
 * Who may take a row out of play.
 *
 * `POST /:slug/:id/retire` writes a column. So the question the security review
 * of this feature's own code asked was the one #48 asked of `reorder`: does the
 * verb let a caller write something a `PATCH` would have refused?
 *
 * Two answers, and they deliberately differ from each other:
 *
 *  - **A FIELD allow-list that excludes the flag refuses the verb.** "May edit
 *    the product name, may not discontinue the product" is a grant an operator
 *    can express, it is enforced on `PATCH`, and a second door that ignored it
 *    would make the allow-list decorative. There is no narrower answer to give:
 *    the verb writes exactly that one column.
 *  - **A ROW condition is APPLIED, not refused** — the opposite of `reorder`,
 *    and the reason generalises. Renumbering a filtered subset collides with
 *    the rows it skipped, so a partial grant has no coherent answer there.
 *    Retirement is independent per row, so retiring the row the caller can
 *    reach is complete and correct, and a row outside the condition is simply
 *    not found.
 *
 * Each case asserts the STATE afterwards as the admin, not just the status
 * code — a 403 that had already written the column is not the guard working.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type TestHarness, makeHarness, seedAdmin } from "./setup";

const JSON_HEADERS = { "Content-Type": "application/json" };
const json = (body: unknown, method = "POST"): RequestInit => ({
  method,
  headers: JSON_HEADERS,
  body: JSON.stringify(body),
});

describe("retiring a row needs an update that covers the flag", () => {
  let h: TestHarness;
  const ts = Date.now();
  const slug = `ret_perm_${ts}`;
  let adminEmail: string;
  let authRoleId: string;
  const ids: Record<string, string> = {};

  /**
   * Sign in as somebody, and PROVE it took.
   *
   * Two traps, both of which produce a test that passes for the wrong reason:
   * `sign-in/email` is a no-op while another session cookie is live (so the
   * request under test silently runs as the previous identity), and the auth
   * rate limiter 429s after a handful of attempts from one address — which
   * lands on the LAST case in a file, exactly where a false pass is least
   * likely to be noticed. Hence the sign-out first, the per-call address, and
   * the status assertion.
   */
  let signIns = 0;
  const signInAs = async (email: string) => {
    await h.fetch("/api/auth/sign-out", { method: "POST" });
    signIns += 1;
    const r = await h.fetch("/api/auth/sign-in/email", {
      method: "POST",
      headers: { ...JSON_HEADERS, "x-forwarded-for": `10.0.0.${signIns}` },
      body: JSON.stringify({ email, password: "correct-horse-battery" }),
    });
    expect(r.status).toBe(200);
    return r;
  };
  const signInAdmin = () => signInAs(adminEmail);
  const signInMember = () => signInAs(`member-${ts}@example.test`);

  /** The flag straight off the column, admin-read, so a guard that refused the
   *  WRITE is distinguishable from one that refused the read. */
  const flags = async (): Promise<Record<string, unknown>> => {
    const r = await h.fetch(`/api/items/${slug}?sort=name&limit=50`);
    const rows = ((await r.json()) as { data: Record<string, any>[] }).data;
    return Object.fromEntries(rows.map((x) => [x.name, x.active]));
  };

  const grantUpdate = async (body: Record<string, unknown>) => {
    const list = (await (await h.fetch(`/api/roles/${authRoleId}/permissions`)).json()) as {
      data: { id: string; collection: string; action: string }[];
    };
    for (const p of list.data) {
      if (p.collection === slug && p.action === "update") {
        await h.fetch(`/api/permissions/${p.id}`, { method: "DELETE" });
      }
    }
    const r = await h.fetch(
      `/api/roles/${authRoleId}/permissions`,
      json({ collection: slug, action: "update", condition: null, ...body }),
    );
    expect(r.status).toBeLessThan(300);
  };

  beforeAll(async () => {
    h = makeHarness();
    const adm = await seedAdmin(h);
    adminEmail = adm.email;
    expect(
      (
        await h.fetch(
          "/api/collections",
          json({
            slug,
            fields: [
              { name: "name", type: "text" },
              { name: "owner_tag", type: "text" },
              { name: "active", type: "boolean", default: true, retire: {} },
            ],
          }),
        )
      ).status,
    ).toBe(201);
    for (const [name, tag] of [
      ["mine", "mine"],
      ["theirs", "other"],
    ] as const) {
      const r = await h.fetch(`/api/items/${slug}`, json({ name, owner_tag: tag }));
      ids[name] = ((await r.json()) as any).data.id;
    }

    const roles = (
      (await (await h.fetch("/api/roles")).json()) as { data: { id: string; name: string }[] }
    ).data;
    authRoleId = roles.find((r) => r.name === "authenticated")!.id;
    // Unconditioned READ throughout, so every refusal below is about the write.
    await h.fetch(
      `/api/roles/${authRoleId}/permissions`,
      json({ collection: slug, action: "read", condition: null }),
    );

    await h.fetch("/api/auth/sign-out", { method: "POST" });
    expect(
      (
        await h.fetch(
          "/api/auth/sign-up/email",
          json({
            email: `member-${ts}@example.test`,
            password: "correct-horse-battery",
            name: "Member",
          }),
        )
      ).status,
    ).toBe(200);
  });
  afterAll(() => h.cleanup());

  test("an update limited to OTHER fields cannot retire", async () => {
    await signInAdmin();
    await grantUpdate({ fields: ["name"] });
    const before = await flags();
    await signInMember();

    // The refusal `PATCH` already gives…
    expect(
      (await h.fetch(`/api/items/${slug}/${ids.mine}`, json({ active: false }, "PATCH"))).status,
    ).toBe(403);
    // …and the same one through the verb.
    expect((await h.fetch(`/api/items/${slug}/${ids.mine}/retire`, json({}))).status).toBe(403);

    await signInAdmin();
    expect(await flags()).toEqual(before);
  });

  test("a ROW-CONDITIONED update retires what it can reach, and nothing else", async () => {
    await signInAdmin();
    await grantUpdate({ condition: { owner_tag: { _eq: "mine" } } });
    await signInMember();

    // Inside the condition: applied. Retirement is independent per row, so a
    // partial grant has a complete answer here — unlike `reorder`.
    expect((await h.fetch(`/api/items/${slug}/${ids.mine}/retire`, json({}))).status).toBe(200);
    // Outside it: the row is not found, exactly as a PATCH would report.
    expect((await h.fetch(`/api/items/${slug}/${ids.theirs}/retire`, json({}))).status).toBe(404);

    await signInAdmin();
    expect(await flags()).toEqual({ mine: false, theirs: true });
  });

  test("an update that covers the flag with no row condition CAN retire and restore", async () => {
    await signInAdmin();
    await grantUpdate({ condition: null });
    await signInMember();

    expect((await h.fetch(`/api/items/${slug}/${ids.theirs}/retire`, json({}))).status).toBe(200);
    expect(
      (await h.fetch(`/api/items/${slug}/${ids.mine}/retire?restore=1`, json({}))).status,
    ).toBe(200);

    await signInAdmin();
    expect(await flags()).toEqual({ mine: true, theirs: false });
  });

  test("no update grant at all is refused", async () => {
    await signInAdmin();
    const list = (await (await h.fetch(`/api/roles/${authRoleId}/permissions`)).json()) as {
      data: { id: string; collection: string; action: string }[];
    };
    for (const p of list.data) {
      if (p.collection === slug && p.action === "update") {
        await h.fetch(`/api/permissions/${p.id}`, { method: "DELETE" });
      }
    }
    const before = await flags();
    await signInMember();
    expect((await h.fetch(`/api/items/${slug}/${ids.mine}/retire`, json({}))).status).toBe(403);

    await signInAdmin();
    expect(await flags()).toEqual(before);
  });
});
