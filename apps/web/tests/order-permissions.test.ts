/**
 * Who may rearrange a list.
 *
 * Both cases here came out of the security review of this feature's own code,
 * and both are the same shape: **an ordering operation writes rows the caller
 * never named.** `reorder` shifts a whole span; `order/normalize` rewrites every
 * list in the collection; and the tie repair inside `reorder` renumbers the
 * whole list before the move — which fires on the FIRST drag in any collection
 * seeded from a template, since every template's `position` defaults to 0.
 *
 * So plain `update` on the collection is not the right bar:
 *
 *  - A role whose `update` names a FIELD LIST that excludes the order column
 *    ("may rename menu entries, may not rearrange the menu") is refused on
 *    `PATCH` already. It has to be refused here too or the allow-list has a
 *    second door.
 *  - A role whose `update` carries a ROW CONDITION (every bundled self-service
 *    role does — `app_user_id = $user.id`) gets neither answer: ignoring the
 *    condition writes other people's rows, and applying it renumbers a subset
 *    that then collides with the rows it skipped. Refused, like money refusing
 *    to compare two currencies rather than answering wrong.
 *
 * Every case below is asserted against BOTH the shared column AND the caller's
 * own row, so a refusal that happened to leave the data alone by accident is
 * not mistaken for the guard working.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type TestHarness, makeHarness, seedAdmin } from "./setup";

const JSON_HEADERS = { "Content-Type": "application/json" };
const json = (body: unknown, method = "POST"): RequestInit => ({
  method,
  headers: JSON_HEADERS,
  body: JSON.stringify(body),
});

describe("rearranging a list needs an unconditioned update on the whole list", () => {
  let h: TestHarness;
  const ts = Date.now();
  const slug = `ord_perm_${ts}`;
  let adminEmail: string;
  let authRoleId: string;
  const ids: Record<string, string> = {};

  const signInAdmin = () =>
    h.fetch(
      "/api/auth/sign-in/email",
      json({ email: adminEmail, password: "correct-horse-battery" }),
    );
  const signInMember = () =>
    h.fetch(
      "/api/auth/sign-in/email",
      json({ email: `member-${ts}@example.test`, password: "correct-horse-battery" }),
    );

  /** Positions straight off the column, admin-read, so a guard that refused the
   *  write is distinguishable from one that refused the READ. */
  const positions = async (): Promise<Record<string, number>> => {
    const r = await h.fetch(`/api/items/${slug}?sort=position&limit=50`);
    const rows = ((await r.json()) as { data: Record<string, any>[] }).data;
    return Object.fromEntries(rows.map((x) => [x.name, x.position]));
  };

  /** Replace the `authenticated` role's update grant on this collection. */
  const grantUpdate = async (body: Record<string, unknown>) => {
    const list = (await (await h.fetch(`/api/roles/${authRoleId}/permissions`)).json()) as {
      data: { id: string; collection: string; action: string }[];
    };
    for (const p of list.data) {
      if (p.collection === slug) {
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
            defaultSort: "position",
            fields: [
              { name: "name", type: "text" },
              { name: "owner_tag", type: "text" },
              { name: "position", type: "integer", order: {} },
            ],
          }),
        )
      ).status,
    ).toBe(201);
    for (const name of ["a", "b", "c"]) {
      const r = await h.fetch(`/api/items/${slug}`, json({ name, owner_tag: "mine" }));
      ids[name] = ((await r.json()) as any).data.id;
    }
    // A row the member's condition will NOT match, so "did the guard stop the
    // whole-list rewrite" is answerable.
    const other = await h.fetch(`/api/items/${slug}`, json({ name: "theirs", owner_tag: "other" }));
    ids.theirs = ((await other.json()) as any).data.id;

    const roles = (
      (await (await h.fetch("/api/roles")).json()) as { data: { id: string; name: string }[] }
    ).data;
    authRoleId = roles.find((r) => r.name === "authenticated")!.id;
    // Reading is unconditioned throughout, so every refusal below is about the
    // WRITE and not about what the caller could see.
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

  test("a ROW-CONDITIONED update cannot reorder — it would renumber rows outside the condition", async () => {
    await signInAdmin();
    await grantUpdate({ condition: { owner_tag: { _eq: "mine" } } });
    const before = await positions();
    await signInMember();

    const moved = await h.fetch(
      `/api/items/${slug}/reorder`,
      json({ field: "position", id: ids.c, before: ids.a }),
    );
    expect(moved.status).toBe(403);

    await signInAdmin();
    // Not merely "the moved row stayed" — NOTHING moved, including the row the
    // member could legitimately update.
    expect(await positions()).toEqual(before);
  });

  test("a ROW-CONDITIONED update cannot normalize the collection either", async () => {
    await signInAdmin();
    await grantUpdate({ condition: { owner_tag: { _eq: "mine" } } });
    // Tie the whole column, which is the state normalize exists for — and the
    // state in which an unguarded pass would rewrite every row in the workspace.
    for (const id of Object.values(ids)) {
      await h.fetch(`/api/items/${slug}/${id}`, json({ position: 0 }, "PATCH"));
    }
    await signInMember();
    const r = await h.fetch(`/api/items/${slug}/order/normalize`, json({ field: "position" }));
    expect(r.status).toBe(403);

    await signInAdmin();
    // Still tied — the pass did not run at all.
    expect(new Set(Object.values(await positions()))).toEqual(new Set([0]));
  });

  test("an update limited to OTHER fields cannot reorder", async () => {
    await signInAdmin();
    // Repair the ties the previous case left, so this one starts from a list
    // that a permitted caller could actually have moved.
    await h.fetch(`/api/items/${slug}/order/normalize`, json({ field: "position" }));
    await grantUpdate({ fields: ["name"] });
    const before = await positions();
    await signInMember();

    // The same refusal `PATCH` gives, through the other door.
    const patched = await h.fetch(
      `/api/items/${slug}/${ids.c}`,
      json({ position: 1 }, "PATCH"),
    );
    expect(patched.status).toBe(403);
    const moved = await h.fetch(
      `/api/items/${slug}/reorder`,
      json({ field: "position", id: ids.c, before: ids.a }),
    );
    expect(moved.status).toBe(403);
    expect(
      (await h.fetch(`/api/items/${slug}/order/normalize`, json({ field: "position" }))).status,
    ).toBe(403);

    await signInAdmin();
    expect(await positions()).toEqual(before);
  });

  test("an update that covers the field with no row condition CAN reorder", async () => {
    // The other half of the gate: proving it refuses is only half an assertion
    // if it refuses everyone.
    await signInAdmin();
    await grantUpdate({ fields: ["name", "owner_tag", "position"] });
    await signInMember();
    const moved = await h.fetch(
      `/api/items/${slug}/reorder`,
      json({ field: "position", id: ids.c, before: ids.a }),
    );
    expect(moved.status).toBe(200);

    await signInAdmin();
    const after = await positions();
    expect(after.c).toBeLessThan(after.a!);
  });
});

/**
 * The same refusal over GraphQL.
 *
 * Its own harness rather than another case in the block above, and that is not
 * fastidiousness: the permission resolver caches per role, so re-granting the
 * same (role, collection, action) several times inside one suite tests the
 * cache's invalidation timing rather than the guard. One grant, one assertion.
 */
describe("GraphQL refuses a row-conditioned caller too", () => {
  let h: TestHarness;
  const ts = Date.now();
  const slug = `ord_perm_gql_${ts}`;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    await h.fetch(
      "/api/collections",
      json({
        slug,
        defaultSort: "position",
        fields: [
          { name: "name", type: "text" },
          { name: "owner_tag", type: "text" },
          { name: "position", type: "integer", order: {} },
        ],
      }),
    );
    for (const name of ["a", "b", "c"]) {
      const r = await h.fetch(`/api/items/${slug}`, json({ name, owner_tag: "mine" }));
      ids[name] = ((await r.json()) as any).data.id;
    }
    const roles = (
      (await (await h.fetch("/api/roles")).json()) as { data: { id: string; name: string }[] }
    ).data;
    const rid = roles.find((r) => r.name === "authenticated")!.id;
    await h.fetch(
      `/api/roles/${rid}/permissions`,
      json({ collection: slug, action: "read", condition: null }),
    );
    await h.fetch(
      `/api/roles/${rid}/permissions`,
      json({ collection: slug, action: "update", condition: { owner_tag: { _eq: "mine" } } }),
    );
    await h.fetch("/api/auth/sign-out", { method: "POST" });
    await h.fetch(
      "/api/auth/sign-up/email",
      json({
        email: `gqlmember-${ts}@example.test`,
        password: "correct-horse-battery",
        name: "Member",
      }),
    );
  });
  afterAll(() => h.cleanup());

  test("reorderItem is refused, and REST agrees at the same instant", async () => {
    expect(
      (
        await h.fetch(
          `/api/items/${slug}/reorder`,
          json({ field: "position", id: ids.c, before: ids.a }),
        )
      ).status,
    ).toBe(403);
    const res = (await (
      await h.fetch(
        "/api/graphql",
        json({
          query: `mutation ($c: String!, $f: String!, $id: ID!, $b: ID!) {
            reorderItem(collection: $c, field: $f, id: $id, before: $b) { position }
          }`,
          variables: { c: slug, f: "position", id: ids.c, b: ids.a },
        }),
      )
    ).json()) as { errors?: { message: string; extensions?: { code?: string } }[] };
    expect(res.errors?.[0]?.extensions?.code).toBe("FORBIDDEN");
  });

  test("normalizeOrder is refused as well", async () => {
    const res = (await (
      await h.fetch(
        "/api/graphql",
        json({
          query: `mutation ($c: String!) { normalizeOrder(collection: $c) { renumbered } }`,
          variables: { c: slug },
        }),
      )
    ).json()) as { errors?: { extensions?: { code?: string } }[] };
    expect(res.errors?.[0]?.extensions?.code).toBe("FORBIDDEN");
  });
});
