/**
 * What a write hands back, and whose allow-list decides it.
 *
 * A permission row is per (role, collection, ACTION), so `update` and `read`
 * carry independent field lists and nothing intersects them. A role can be
 * granted `update: [internal_score, internal_note]` while its `read` names only
 * `title` — "you may set the score, you may not see it" — and that is a
 * configuration an admin reaches through the ordinary UI.
 *
 * **The response to a write is a READ.** The write grant authorises the write;
 * it does not authorise reading the result back. Both surfaces now project
 * through the caller's read allow-list (`WriteEnv.readFields`).
 *
 * They did not always. This file was first written to pin the divergence:
 *
 *  - REST projected through the UPDATE list (`routes/items/write.ts` →
 *    `performUpdate` → `projectFields(row, perm.fields)`), so it handed back
 *    columns the caller could not read — and not merely the value they had just
 *    sent, because the projection filters the whole refreshed row.
 *  - GraphQL re-resolved the caller's READ permission and rendered through
 *    that, with a comment claiming it mirrored REST, which it did not.
 *
 * The last case below is the one that made the choice obvious: a caller who
 * PATCHes one column used to get a DIFFERENT column's stored value back,
 * carrying whatever an admin last put in it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type TestHarness, makeHarness, seedAdmin } from "./setup";

const JSON_HEADERS = { "Content-Type": "application/json" };
const json = (body: unknown, method = "POST"): RequestInit => ({
  method,
  headers: JSON_HEADERS,
  body: JSON.stringify(body),
});

describe("a write's response is projected through the caller's READ grant", () => {
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
    // Only the admin knows what is in here.
    await h.fetch(`/api/items/${slug}/${itemId}`, json({ internal_note: "board-only" }, "PATCH"));

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
      json({
        collection: slug,
        action: "update",
        condition: null,
        fields: ["internal_score", "internal_note"],
      }),
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
   *  columns. Asserted first so nothing below can pass vacuously. */
  test("the member can read `title` and neither internal column", async () => {
    await signInMember();
    const res = await h.fetch(`/api/items/${slug}/${itemId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data.title).toBe("Visible");
    expect("internal_score" in body.data).toBe(false);
    expect("internal_note" in body.data).toBe(false);
  });

  test("REST does not hand back a field the caller may write but not read", async () => {
    await signInMember();
    const res = await h.fetch(`/api/items/${slug}/${itemId}`, json({ internal_score: 42 }, "PATCH"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect("internal_score" in body.data).toBe(false);
    // …and it DOES hand back what the caller may read, which the update-list
    // projection used to withhold.
    expect(body.data.title).toBe("Visible");
  });

  /**
   * The sharp case, and the reason this is a leak rather than an echo. Above,
   * the withheld value is one the caller had just supplied. Here the update
   * grant names a SECOND column the caller never writes and cannot read: under
   * the update-list projection its stored value came back, because the
   * projection is a filter over the whole refreshed row rather than over what
   * the request touched.
   */
  test("nor a field it never wrote, whose value only the admin set", async () => {
    await signInMember();
    const res = await h.fetch(`/api/items/${slug}/${itemId}`, json({ internal_score: 5 }, "PATCH"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(JSON.stringify(body)).not.toContain("board-only");
    expect("internal_note" in body.data).toBe(false);
  });

  test("GraphQL answers the same way", async () => {
    await signInMember();
    // The schema keeps the slug's underscores and only capitalises the first
    // letter: `proj_123` → `updateProj_123`, input `Proj_123Input`.
    const typeName = slug.charAt(0).toUpperCase() + slug.slice(1);
    const res = await h.fetch(
      "/api/graphql",
      json({
        query: `mutation($id: ID!, $data: ${typeName}Input!) {
          update${typeName}(id: $id, data: $data) { id title internalScore internalNote }
        }`,
        variables: { id: itemId, data: { internalScore: 7 } },
      }),
    );
    const body = (await res.json()) as {
      data?: Record<
        string,
        { id: string; title: string | null; internalScore: number | null; internalNote: string | null }
      >;
      errors?: { message: string }[];
    };
    expect(body.errors ?? []).toEqual([]);
    const row = body.data![`update${typeName}`]!;
    expect(row.internalScore).toBeNull();
    expect(row.internalNote).toBeNull();
    expect(row.title).toBe("Visible");
  });

  /**
   * Both writes must have landed — otherwise the cases above would be
   * comparing a refusal to a success rather than two projections of the same
   * successful write. The member could not see either value; the admin can.
   */
  test("every write actually landed", async () => {
    await signInAdmin();
    const res = await h.fetch(`/api/items/${slug}/${itemId}`);
    const body = (await res.json()) as {
      data: { internal_score: number; internal_note: string };
    };
    expect(body.data.internal_score).toBe(7); // the GraphQL write, last in
    expect(body.data.internal_note).toBe("board-only");
  });

  /**
   * The parity the whole exercise is for: one caller, one collection, two
   * surfaces, the same visible shape. Asserted on the KEY SET rather than on
   * spellings, so this stays true when a field is added and fails when only one
   * surface learns to hide something.
   */
  test("REST and GraphQL expose the same fields for the same write", async () => {
    await signInMember();
    const rest = (await (
      await h.fetch(`/api/items/${slug}/${itemId}`, json({ internal_score: 11 }, "PATCH"))
    ).json()) as { data: Record<string, unknown> };

    const typeName = slug.charAt(0).toUpperCase() + slug.slice(1);
    const gql = (await (
      await h.fetch(
        "/api/graphql",
        json({
          query: `mutation($id: ID!, $data: ${typeName}Input!) {
            update${typeName}(id: $id, data: $data) { id title internalScore internalNote }
          }`,
          variables: { id: itemId, data: { internalScore: 11 } },
        }),
      )
    ).json()) as { data: Record<string, Record<string, unknown>> };
    const row = gql.data[`update${typeName}`]!;

    // Compared over the collection's OWN columns only. GraphQL returns what the
    // query selected and nothing else, while REST always carries `id` and the
    // timestamps through `projectFields`' system keeps — a difference in what
    // the two protocols are, not in what either is willing to show. And an
    // unreadable field arrives from GraphQL as an explicit null rather than
    // being absent, so the comparable set is the non-null ones.
    const OWN = ["title", "internalScore", "internalNote"];
    const gqlVisible = OWN.filter((k) => row[k] !== null).sort();
    const restVisible = ["title", "internal_score", "internal_note"]
      .filter((k) => k in rest.data)
      .map((k) => k.replace(/_(.)/g, (_, ch: string) => ch.toUpperCase()))
      .sort();
    expect(gqlVisible).toEqual(restVisible);
    // Non-vacuous: both really do show something, and it is `title`.
    expect(restVisible).toEqual(["title"]);
  });
});
