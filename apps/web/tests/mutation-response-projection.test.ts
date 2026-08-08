/**
 * What a write hands back, and whose allow-list decides it.
 *
 * Permissions are one row per (role, collection, ACTION), so `update` and
 * `read` carry independent field lists. Nothing intersects them. A role can
 * therefore be granted `update: [internal_score]` while its `read` names only
 * `title` — "you may set the score, you may not see it" — and that is a
 * configuration an admin can reach through the ordinary UI.
 *
 * The two write surfaces disagree about what such a caller gets back:
 *
 *  - REST (`routes/items/write.ts` → `performUpdate` → `projectFields(row,
 *    perm.fields)`) projects through the **update** list. There is no read
 *    projection anywhere in the write path.
 *  - GraphQL (`services/graphql/core.ts::updateResolver`) re-resolves the
 *    caller's **read** permission and renders the response through that — with
 *    a comment claiming it mirrors REST, which it does not.
 *
 * This file does not decide which is right. It pins what each surface does
 * today, so the answer is a decision someone makes on purpose rather than a
 * side effect of unifying the two write paths. Whichever way that goes, one of
 * the two `expect`s below changes and the change is visible in the diff.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type TestHarness, makeHarness, seedAdmin } from "./setup";

const JSON_HEADERS = { "Content-Type": "application/json" };
const json = (body: unknown, method = "POST"): RequestInit => ({
  method,
  headers: JSON_HEADERS,
  body: JSON.stringify(body),
});

describe("a write's response, and the allow-list that shapes it", () => {
  let h: TestHarness;
  const ts = Date.now();
  const slug = `proj_${ts}`;
  let adminEmail: string;
  let itemId: string;

  const signInAdmin = () =>
    h.fetch("/api/auth/sign-in/email", json({ email: adminEmail, password: "correct-horse-battery" }));
  const signInMember = () =>
    h.fetch(
      "/api/auth/sign-in/email",
      json({ email: `member-${ts}@example.test`, password: "correct-horse-battery" }),
    );

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
              { name: "title", type: "text" },
              { name: "internal_score", type: "integer" },
              { name: "internal_note", type: "text" },
            ],
          }),
        )
      ).status,
    ).toBe(201);

    const created = await h.fetch(`/api/items/${slug}`, json({ title: "Visible", internal_score: 1 }));
    expect(created.status).toBe(201);
    itemId = ((await created.json()) as { data: { id: string } }).data.id;

    const roles = ((await (await h.fetch("/api/roles")).json()) as {
      data: { id: string; name: string }[];
    }).data;
    const authRoleId = roles.find((r) => r.name === "authenticated")!.id;

    // The whole point of the fixture: the two lists are disjoint.
    await h.fetch(
      `/api/roles/${authRoleId}/permissions`,
      json({ collection: slug, action: "read", condition: null, fields: ["title"] }),
    );
    await h.fetch(
      `/api/roles/${authRoleId}/permissions`,
      json({ collection: slug, action: "update", condition: null, fields: ["internal_score"] }),
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

  /** The fixture is only meaningful if the read grant really does hide the
   *  column. Asserted first so neither case below can pass vacuously. */
  test("the member cannot READ internal_score", async () => {
    await signInMember();
    const res = await h.fetch(`/api/items/${slug}/${itemId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data.title).toBe("Visible");
    expect("internal_score" in body.data).toBe(false);
  });

  test("REST hands back the field the caller may write but not read", async () => {
    await signInMember();
    const res = await h.fetch(`/api/items/${slug}/${itemId}`, json({ internal_score: 42 }, "PATCH"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    // Today's behaviour: projected through the UPDATE list, so the value comes
    // back to a caller whose read grant does not name the column.
    expect(body.data.internal_score).toBe(42);
    expect("title" in body.data).toBe(false);
  });

  test("GraphQL does not — it projects the same write through the READ list", async () => {
    await signInMember();
    // The schema keeps the slug's underscores and only capitalises the first
    // letter: `proj_123` → `updateProj_123`, input `Proj_123Input`.
    const typeName = slug.charAt(0).toUpperCase() + slug.slice(1);
    const res = await h.fetch(
      "/api/graphql",
      json({
        query: `mutation($id: ID!, $data: ${typeName}Input!) {
          update${typeName}(id: $id, data: $data) { id title internalScore }
        }`,
        variables: { id: itemId, data: { internalScore: 7 } },
      }),
    );
    const body = (await res.json()) as {
      data?: Record<string, { id: string; title: string | null; internalScore: number | null }>;
      errors?: { message: string }[];
    };
    expect(body.errors ?? []).toEqual([]);
    const row = body.data![`update${typeName}`]!;

    // Today's behaviour, and the opposite of REST's: the write landed, but the
    // response is rendered through the caller's READ list, which does not name
    // the column — so the value they just wrote comes back null.
    expect(row.internalScore).toBeNull();
    expect(row.title).toBe("Visible");
  });

  /** The write itself must have happened on both surfaces — otherwise the two
   *  cases above would be comparing a refusal to a success rather than two
   *  projections of the same successful write. */
  test("both writes actually landed", async () => {
    await signInAdmin();
    const res = await h.fetch(`/api/items/${slug}/${itemId}`);
    const body = (await res.json()) as { data: { internal_score: number } };
    expect(body.data.internal_score).toBe(7);
  });

  /**
   * The sharp version. Above, the value handed back is one the caller had just
   * supplied, so "leak" is arguable. Here the update grant names a SECOND
   * column the caller never writes and cannot read — and REST returns its
   * stored value anyway, because the projection is a filter over the whole
   * refreshed row rather than over what the request touched.
   */
  test("REST also hands back an update-list field the caller never wrote", async () => {
    await signInAdmin();
    // Widen the update grant, and put a value in the new column that only the
    // admin knows.
    const list = ((await (await h.fetch(`/api/roles`)).json()) as {
      data: { id: string; name: string }[];
    }).data;
    const authRoleId = list.find((r) => r.name === "authenticated")!.id;
    const perms = ((await (await h.fetch(`/api/roles/${authRoleId}/permissions`)).json()) as {
      data: { id: string; collection: string; action: string }[];
    }).data;
    for (const p of perms) {
      if (p.collection === slug && p.action === "update") {
        await h.fetch(`/api/permissions/${p.id}`, { method: "DELETE" });
      }
    }
    expect(
      (
        await h.fetch(
          `/api/roles/${authRoleId}/permissions`,
          json({
            collection: slug,
            action: "update",
            condition: null,
            fields: ["internal_score", "internal_note"],
          }),
        )
      ).status,
    ).toBeLessThan(300);
    await h.fetch(`/api/items/${slug}/${itemId}`, json({ internal_note: "board-only" }, "PATCH"));

    await signInMember();
    const res = await h.fetch(`/api/items/${slug}/${itemId}`, json({ internal_score: 5 }, "PATCH"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    // Never sent by this request, never readable by this caller.
    expect(body.data.internal_note).toBe("board-only");
  });
});
