/**
 * Who may backfill slugs.
 *
 * The backfill **writes rows the caller never named** — the same shape that
 * produced an authorization bug in `geo/backfill` (which resolved `perm` and
 * then ignored `perm.whereSql`) and two more in `reorder` / `order/normalize`.
 * So the two questions have to be asked separately, and this feature answers
 * them differently on purpose:
 *
 *  - **The FIELD allow-list is a refusal.** A role whose `update` names a field
 *    list excluding the slug column ("may retitle posts, may not change their
 *    URLs") is already refused on `PATCH`. It has to be refused here too, or
 *    the allow-list has a second door.
 *  - **The ROW condition is APPLIED, not refused** — and that is the opposite
 *    of what rearranging a list does. Renumbering a filtered subset produces
 *    positions colliding with the rows it skipped, so a partial grant there has
 *    no coherent answer. A slug is independent per row: filling the ones a role
 *    can see is complete and correct on exactly those rows, while the collision
 *    search still consults the whole table. Different rule, stated reason.
 *
 * Every case is asserted against BOTH the caller's own row AND a row outside
 * their condition, so a refusal that happened to leave data alone by accident
 * is not mistaken for the guard working.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type TestHarness, makeHarness, seedAdmin } from "./setup";

const JSON_HEADERS = { "Content-Type": "application/json" };
const json = (body: unknown, method = "POST"): RequestInit => ({
  method,
  headers: JSON_HEADERS,
  body: JSON.stringify(body),
});

describe("backfilling slugs respects the caller's update grant", () => {
  let h: TestHarness;
  const ts = Date.now();
  let adminEmail: string;
  let authRoleId: string;
  let n = 0;

  /** Sign out FIRST, always. A `sign-in/email` sent while a valid session
   *  cookie is already present is a no-op, so switching identity without this
   *  leaves the previous user signed in — and a permission test that silently
   *  runs as the admin passes while asserting nothing. */
  let signIns = 0;
  const signInAs = async (email: string) => {
    await h.fetch("/api/auth/sign-out", { method: "POST" });
    const r = await h.fetch("/api/auth/sign-in/email", {
      ...json({ email, password: "correct-horse-battery" }),
      // A distinct client IP per sign-in. The auth rate limiter keys on
      // `auth:<label>:<ip>` (lib/auth-rate-limit.ts), and this suite switches
      // identity ten times — from the harness's single synthetic IP that trips
      // the limit and every later assertion runs as whoever was signed in
      // before. `setup.ts` documents this header as the intended escape hatch.
      headers: { ...JSON_HEADERS, "x-forwarded-for": `10.0.0.${(signIns++ % 250) + 1}` },
    });
    expect(r.status).toBe(200);
    return r;
  };
  const signInAdmin = () => signInAs(adminEmail);
  const signInMember = () => signInAs(`member-${ts}@example.test`);

  /**
   * A fresh collection whose slug column PREDATES the spec, with three rows and
   * no slugs.
   *
   * One per test rather than a shared fixture blanked between them, because a
   * slug CANNOT be blanked through the API: clearing it re-derives, which is
   * the documented behaviour and the thing that makes "regenerate this" a
   * discoverable action. The only honest way to reach an empty slug is to
   * insert before the column is declared one — exactly the state every
   * workspace predating this feature is in.
   */
  const freshCollection = async (): Promise<{ slug: string; ids: Record<string, string> }> => {
    const slug = `slug_perm_${ts}_${n++}`;
    const plain = [
      { name: "title", type: "text" },
      { name: "owner_tag", type: "text" },
    ];
    expect(
      (
        await h.fetch(
          "/api/collections",
          json({ slug, fields: [...plain, { name: "slug", type: "text", unique: true }] }),
        )
      ).status,
    ).toBe(201);
    const ids: Record<string, string> = {};
    for (const [title, tag] of [
      ["Mine One", "mine"],
      ["Mine Two", "mine"],
      ["Theirs One", "other"],
    ] as const) {
      const r = await h.fetch(`/api/items/${slug}`, json({ title, owner_tag: tag }));
      ids[title] = ((await r.json()) as any).data.id;
    }
    // Only now is it a slug field, so the rows above have empty slugs.
    expect(
      (
        await h.fetch(
          `/api/collections/${slug}`,
          json(
            {
              fields: [
                ...plain,
                {
                  name: "slug",
                  type: "text",
                  unique: true,
                  interface: "slug",
                  slug: { from: ["title"] },
                },
              ],
            },
            "PATCH",
          ),
        )
      ).status,
    ).toBeLessThan(300);
    // Reading is unconditioned throughout, so every refusal below is about the
    // WRITE and not about what the caller could see.
    await h.fetch(
      `/api/roles/${authRoleId}/permissions`,
      json({ collection: slug, action: "read", condition: null }),
    );
    return { slug, ids };
  };

  /** Slugs straight off the column, admin-read, so a guard that refused the
   *  WRITE is distinguishable from one that refused the read. */
  const slugsOf = async (slug: string): Promise<Record<string, string | null>> => {
    const r = await h.fetch(`/api/items/${slug}?limit=50`);
    const rows = ((await r.json()) as { data: Record<string, any>[] }).data;
    return Object.fromEntries(rows.map((x) => [x.title, x.slug ?? null]));
  };

  /** Set the `authenticated` role's update grant on one collection. */
  const grantUpdate = async (slug: string, body: Record<string, unknown> | null) => {
    const list = (await (await h.fetch(`/api/roles/${authRoleId}/permissions`)).json()) as {
      data: { id: string; collection: string; action: string }[];
    };
    for (const p of list.data ?? []) {
      if (p.collection === slug && p.action === "update") {
        await h.fetch(`/api/permissions/${p.id}`, { method: "DELETE" });
      }
    }
    if (body === null) return;
    const r = await h.fetch(
      `/api/roles/${authRoleId}/permissions`,
      json({ collection: slug, action: "update", condition: null, ...body }),
    );
    expect(r.status).toBeLessThan(300);
  };

  const backfill = (slug: string) =>
    h.fetch(`/api/items/${slug}/slugs/backfill`, json({ apply: true }));

  beforeAll(async () => {
    h = makeHarness();
    const adm = await seedAdmin(h);
    adminEmail = adm.email;
    const roles = (
      (await (await h.fetch("/api/roles")).json()) as { data: { id: string; name: string }[] }
    ).data;
    authRoleId = roles.find((r) => r.name === "authenticated")!.id;
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
    await signInAdmin();
  });
  afterAll(() => h.cleanup());

  test("a FIELD allow-list without the slug column refuses the backfill", async () => {
    await signInAdmin();
    const { slug, ids } = await freshCollection();
    await grantUpdate(slug, { fields: ["title"] });
    await signInMember();

    // The same role is correctly refused a direct PATCH of the column…
    const direct = await h.fetch(
      `/api/items/${slug}/${ids["Mine One"]}`,
      json({ slug: "sneaky" }, "PATCH"),
    );
    expect(direct.status).toBe(403);
    // …so the maintenance route must not be a second door to it.
    expect((await backfill(slug)).status).toBe(403);

    await signInAdmin();
    const after = await slugsOf(slug);
    expect(after["Mine One"]).toBeNull();
    expect(after["Mine Two"]).toBeNull();
    expect(after["Theirs One"]).toBeNull();
  });

  test("the same refusal on GraphQL, which resolves its own permission", async () => {
    await signInAdmin();
    const { slug } = await freshCollection();
    await grantUpdate(slug, { fields: ["title"] });
    await signInMember();

    const r = (await (
      await h.fetch(
        "/api/graphql",
        json({
          query: `mutation { backfillSlugs(collection: "${slug}", apply: true) { dryRun } }`,
        }),
      )
    ).json()) as { errors?: { message: string }[] };
    expect(r.errors?.[0]?.message).toContain("No permission to write field");

    await signInAdmin();
    expect((await slugsOf(slug))["Mine One"]).toBeNull();
  });

  test("a ROW-CONDITIONED update fills its own rows and leaves the others alone", async () => {
    await signInAdmin();
    const { slug } = await freshCollection();
    await grantUpdate(slug, { condition: { owner_tag: { _eq: "mine" } } });
    await signInMember();

    const back = await backfill(slug);
    expect(back.status).toBe(200);
    const report = (await back.json()).data;
    // The report counts only what the caller's condition covers — a count that
    // included the other row would be telling them it exists.
    expect(report.fields[0].examined).toBe(2);
    expect(report.fields[0].filled).toBe(2);

    await signInAdmin();
    const after = await slugsOf(slug);
    expect(after["Mine One"]).toBe("mine-one");
    expect(after["Mine Two"]).toBe("mine-two");
    // The row outside the condition was neither counted nor written. This is
    // the assertion that fails if the SELECT drops `perm.whereSql` — the
    // `geo/backfill` bug exactly, verified by deleting that clause and watching
    // this test go red.
    //
    // It does NOT pin the scope restated on the UPDATE, and saying so matters:
    // the SELECT has already narrowed to the caller's rows, so removing the
    // UPDATE's copy leaves this suite green. That clause is defence against a
    // row LEAVING the condition between the two statements, which no test here
    // provokes. Kept deliberately, claimed accurately.
    expect(after["Theirs One"]).toBeNull();
  });

  test("an unconditioned update fills everything", async () => {
    await signInAdmin();
    const { slug } = await freshCollection();
    await grantUpdate(slug, { condition: null });
    await signInMember();

    const back = await backfill(slug);
    expect(back.status).toBe(200);
    expect((await back.json()).data.fields[0].filled).toBe(3);

    await signInAdmin();
    expect((await slugsOf(slug))["Theirs One"]).toBe("theirs-one");
  });

  test("no update grant at all is refused outright", async () => {
    // The framework-level bar. Worth an assertion of its own because the whole
    // suite turns on the caller actually BEING the member — this is the case
    // that separates "the guard works" from "everything ran as the admin",
    // which is exactly how an earlier draft of this file passed vacuously.
    await signInAdmin();
    const { slug } = await freshCollection();
    await grantUpdate(slug, null);
    await signInMember();

    expect((await backfill(slug)).status).toBe(403);

    await signInAdmin();
    const after = await slugsOf(slug);
    expect(after["Mine One"]).toBeNull();
    expect(after["Theirs One"]).toBeNull();
  });
});
