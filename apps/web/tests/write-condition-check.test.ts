/**
 * The WRITE-side half of a permission condition — `assertWriteConditions` in
 * `services/items/write.ts`.
 *
 * `perm.whereSql` answers "which rows that ALREADY EXIST may I touch". That is
 * the whole question for read and delete, and only half of it for create and
 * update. So the canonical B2B rule `docs/app-organizations.md` sells,
 * `{ org_id: { _eq: "$org.id" } }`, filtered reads, updates and deletes — and
 * did NOT constrain an insert. A member of org A could plant a row carrying
 * org B's id and simply never read it back. The Postgres RLS projection of the
 * same condition emits `WITH CHECK` for INSERT, so the database was strictly
 * stricter than the API in front of it.
 *
 * The suite had no test that the new check ever REFUSES anything: across 6,680
 * tests it fired exactly once, and that once was the relation-path SKIP path —
 * i.e. the branch that deliberately allows. This file is the regression proof.
 *
 * What it pins:
 *   1. the positive control — the member CAN create a row in their own org.
 *      It comes first on purpose: without it every refusal below is equally
 *      explained by a broken fixture;
 *   2. REST create into ANOTHER org is refused, and no row is left behind;
 *   3. the same on GraphQL, which reaches the same write core through its own
 *      resolvers;
 *   4. the update mirror — a member cannot PATCH their own row OUT of their org;
 *   5. `$org.id` genuinely RESOLVES on the write side. `authSubjectOf` used to
 *      omit org context entirely, so every org rule was judged against a null
 *      org; the assertions here invert if that plumbing is reverted;
 *   6. the WARN default — with `PERMISSION_WRITE_CHECK` unset the same
 *      cross-org create SUCCEEDS. Warn is what protects a tenant whose
 *      integrations have been writing cross-scope rows for months, and a suite
 *      that only ever runs in enforce would let the default silently flip;
 *   7. the relation-path SKIP — a dotted key (`author.department`) must not
 *      deny a write even in enforce mode, because the in-memory evaluator
 *      returns a hard `false` for it while the SQL compiler lowers it to a
 *      correlated EXISTS. Refusing there would be an outage, not a fix.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import type { Env } from "../src/server/env";

const JSON_HEADERS = { "content-type": "application/json" };

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: JSON_HEADERS,
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

type Caller = (path: string, init?: RequestInit) => Promise<Response>;

/** App-plane bearer caller. `org` sets `X-Backlex-Org` on every call. */
const bearerFor = (h: TestHarness, token: string, org?: string): Caller =>
  (path, init = {}) =>
    h.app.request(path, {
      ...init,
      headers: {
        ...JSON_HEADERS,
        ...(init.headers ?? {}),
        Authorization: `Bearer ${token}`,
        ...(org ? { "X-Backlex-Org": org } : {}),
      },
    });

interface OrgFixture {
  h: TestHarness;
  /** The end-user. A member of org A and of nothing else. */
  memberId: string;
  token: string;
  /** The org the member belongs to, and the one their role is scoped to. */
  orgA: string;
  /** A real org in the SAME workspace that the member is not a member of. */
  orgB: string;
  /** The member, acting inside org A (`X-Backlex-Org: <orgA>`). */
  inA: Caller;
}

/**
 * A real B2B fixture: one workspace, two organizations, an end-user who belongs
 * to org A only, and a role granting read/create/update on `tickets` under
 * `{ org_id: { _eq: "$org.id" } }`, bound ORG-SCOPED so it applies inside org A
 * and nowhere else.
 *
 * `overrides` is how a caller chooses enforce vs the warn default — the whole
 * point of building it twice.
 */
const buildOrgFixture = async (overrides: Partial<Env> = {}): Promise<OrgFixture> => {
  const h = makeHarness(overrides);
  await seedAdmin(h);

  // A collection whose rows belong to an organization.
  const created = await h.fetch(
    "/api/collections",
    json("POST", {
      slug: "tickets",
      fields: [
        { name: "title", type: "text" },
        { name: "org_id", type: "text" },
      ],
    }),
  );
  expect(created.status, "create the tickets collection").toBe(201);

  // The role the whole feature exists to make expressible.
  const roleRes = await h.fetch("/api/roles", json("POST", { name: "Org Editor" }));
  expect(roleRes.status, "create the Org Editor role").toBeLessThan(300);
  const editorRoleId = ((await roleRes.json()) as { data: { id: string } }).data.id;

  for (const action of ["read", "create", "update"] as const) {
    const granted = await h.fetch(
      `/api/roles/${editorRoleId}/permissions`,
      json("POST", {
        collection: "tickets",
        action,
        condition: { org_id: { _eq: "$org.id" } },
      }),
    );
    expect(granted.status, `grant ${action} on tickets`).toBeLessThan(300);
  }

  // The end-user, invited by the operator and accepted into `default`.
  const invited = await h.fetch(
    "/api/app-users/invite",
    json("POST", { email: "member@write-check.test" }),
  );
  expect(invited.status, "invite the end-user").toBe(201);
  const invite = ((await invited.json()) as {
    data: { id: string; token: string };
  }).data;
  const accepted = await h.app.request(
    "/api/t/default/auth/invite/accept",
    json("POST", { token: invite.token, password: "write-check-pass-12345" }),
  );
  expect(accepted.status, "accept the end-user invite").toBe(200);
  const token = ((await accepted.json()) as { token: string }).token;

  // Org A, owned by the member. Org B has NO members at all, so naming it is a
  // genuine escalation rather than a second hat the same person wears.
  const aRes = await h.fetch(
    "/api/app-orgs",
    json("POST", { name: "Acme", ownerAppUserId: invite.id }),
  );
  expect(aRes.status, "create org A").toBe(201);
  const orgA = ((await aRes.json()) as { data: { id: string } }).data.id;

  const bRes = await h.fetch("/api/app-orgs", json("POST", { name: "Globex" }));
  expect(bRes.status, "create org B").toBe(201);
  const orgB = ((await bRes.json()) as { data: { id: string } }).data.id;

  // Org-SCOPED grant: the role applies to this person inside org A only.
  const bound = await h.fetch(
    `/api/app-orgs/${orgA}/members/${invite.id}`,
    json("PATCH", { roleIds: [editorRoleId] }),
  );
  expect(bound.status, "bind the Org Editor role inside org A").toBe(200);

  return { h, memberId: invite.id, token, orgA, orgB, inA: bearerFor(h, token, orgA) };
};

/** Every ticket in the workspace, as the operator — who bypasses conditions and
 *  therefore sees rows the member could never read back. */
const allTicketTitles = async (h: TestHarness): Promise<string[]> => {
  const res = await h.fetch("/api/items/tickets?limit=200");
  expect(res.status, "the operator lists every ticket").toBe(200);
  const body = (await res.json()) as { data: { title: string }[] };
  return body.data.map((r) => r.title);
};

/** One GraphQL document, as the member acting inside org A. */
const gql = async (
  call: Caller,
  query: string,
  variables?: Record<string, unknown>,
): Promise<{
  data?: Record<string, unknown>;
  errors?: { message: string; extensions?: { code?: string } }[];
}> => {
  const res = await call("/api/graphql", json("POST", { query, variables }));
  return (await res.json()) as never;
};

describe("write-condition check — PERMISSION_WRITE_CHECK=enforce", () => {
  let f: OrgFixture;

  beforeAll(async () => {
    f = await buildOrgFixture({ PERMISSION_WRITE_CHECK: "enforce" });
  });
  afterAll(() => f.h.cleanup());

  /**
   * THE NON-VACUITY CONTROL, and it runs first for that reason. Every refusal
   * below would be equally well explained by a member who simply cannot write
   * at all — a missing grant, an unresolved org header, a role bound to the
   * wrong org. This proves the fixture works before anything asserts that it
   * doesn't.
   */
  test("(1) the member CAN create a row carrying their own org's id", async () => {
    const res = await f.inA(
      "/api/items/tickets",
      json("POST", { title: "own-org-rest", org_id: f.orgA }),
    );
    expect(res.status, await res.clone().text()).toBe(201);

    // …and reads it back through the very same condition, so `whereSql` and the
    // new WITH CHECK agree about the row that was just written.
    const listed = await f.inA("/api/items/tickets");
    expect(listed.status).toBe(200);
    const rows = ((await listed.json()) as { data: { title: string }[] }).data;
    expect(rows.map((r) => r.title)).toContain("own-org-rest");
  });

  test("(2) REST: creating into ANOTHER org is refused, and no row is left behind", async () => {
    const res = await f.inA(
      "/api/items/tickets",
      json("POST", { title: "planted-rest", org_id: f.orgB }),
    );
    expect(res.status, "a row outside the caller's org").toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FORBIDDEN");

    // The operator bypasses conditions entirely, so this is the only honest way
    // to ask "did it land anyway?". A member-scoped read would answer "no"
    // whether the insert was refused or merely invisible — which is exactly the
    // hole this check closes.
    expect(await allTicketTitles(f.h)).not.toContain("planted-rest");
  });

  test("(3) GraphQL: the same refusal through the other surface", async () => {
    // Positive control on THIS surface first — the two share a write core but
    // reach it through different resolvers, and a GraphQL-side 200 proves the
    // failure below is the check and not a broken document.
    const ok = await gql(
      f.inA,
      "mutation($d: TicketsInput!){ createTickets(data: $d){ id } }",
      { d: { title: "own-org-gql", orgId: f.orgA } },
    );
    expect(ok.errors, JSON.stringify(ok.errors)).toBeUndefined();
    expect(ok.data?.createTickets).toBeTruthy();

    const denied = await gql(
      f.inA,
      "mutation($d: TicketsInput!){ createTickets(data: $d){ id } }",
      { d: { title: "planted-gql", orgId: f.orgB } },
    );
    expect(denied.errors, "GraphQL refuses the cross-org create").toBeTruthy();
    expect(denied.errors?.[0]?.extensions?.code).toBe("FORBIDDEN");

    expect(await allTicketTitles(f.h)).not.toContain("planted-gql");
  });

  test("(4) the update mirror: a member cannot PATCH their own row out of their org", async () => {
    const created = await f.inA(
      "/api/items/tickets",
      json("POST", { title: "stays-put", org_id: f.orgA }),
    );
    expect(created.status).toBe(201);
    const id = String(((await created.json()) as { data: { id: unknown } }).data.id);

    // A benign patch first: `whereSql` picks this row for the caller, so a 403
    // below is about what the row BECOMES and not about which row it is.
    const benign = await f.inA(
      `/api/items/tickets/${id}`,
      json("PATCH", { title: "stays-put-renamed" }),
    );
    expect(benign.status, "an in-org patch still works").toBe(200);

    const moved = await f.inA(
      `/api/items/tickets/${id}`,
      json("PATCH", { org_id: f.orgB }),
    );
    expect(moved.status, "moving the row into org B").toBe(403);

    // Read it back as the operator: the row is untouched, still org A's.
    const after = await f.h.fetch(`/api/items/tickets/${id}`);
    expect(after.status).toBe(200);
    const row = ((await after.json()) as { data: { org_id: string; title: string } }).data;
    expect(row.org_id, "the row still belongs to org A").toBe(f.orgA);
    expect(row.title).toBe("stays-put-renamed");
  });

  /**
   * `$org.id` has to RESOLVE on the write side, and before this phase it could
   * not: `authSubjectOf` built its subject from `{userId, email, roles,
   * tenantId}` alone, so `$org.id` was null for every write.
   *
   * These two assertions are inverses of each other under that revert, which is
   * what makes them a plumbing test rather than a restatement of (1):
   *
   *   plumbed   → `$org.id` = orgA. `org_id: orgA` matches (201);
   *                              `org_id: null` does not (403).
   *   reverted  → `$org.id` = null. `org_id: orgA` would NOT match (403);
   *                              `org_id: null` WOULD (201).
   *
   * So a reverted `WriteEnv` cannot satisfy both, whichever way it fails.
   */
  test("(5) $org.id resolves on the write side — a null org would invert both answers", async () => {
    const real = await f.inA(
      "/api/items/tickets",
      json("POST", { title: "org-id-resolved", org_id: f.orgA }),
    );
    expect(real.status, "the resolved org id matches the rule").toBe(201);

    const nulled = await f.inA(
      "/api/items/tickets",
      json("POST", { title: "org-id-null", org_id: null }),
    );
    expect(
      nulled.status,
      "a null org_id would match only if $org.id itself resolved to null",
    ).toBe(403);
    expect(await allTicketTitles(f.h)).not.toContain("org-id-null");

    // And the token is SUBSTITUTED, not compared as text: a row literally
    // carrying the string "$org.id" is refused.
    const literal = await f.inA(
      "/api/items/tickets",
      json("POST", { title: "org-id-literal", org_id: "$org.id" }),
    );
    expect(literal.status, "the variable is resolved, not string-matched").toBe(403);
    expect(await allTicketTitles(f.h)).not.toContain("org-id-literal");
  });
});

/**
 * (7) The relation-path SKIP, in enforce mode.
 *
 * `packages/db/src/permission.ts` returns a hard `false` for any dotted key —
 * the in-memory evaluator is row-local and cannot traverse a relation — while
 * the SQL compiler lowers the same key to a correlated EXISTS. So a rule that
 * filters READS correctly would deny EVERY write if it were evaluated in
 * memory. That is an outage dressed as a security fix, and the check skips such
 * a condition instead (logging the skip).
 *
 * The article written here has an author whose department is deliberately WRONG
 * for the rule, so the write is only allowed because the condition was skipped —
 * not because it happened to pass.
 */
describe("write-condition check — a dotted relation path never denies a write", () => {
  let f: OrgFixture;
  let salesAuthorId: string;

  beforeAll(async () => {
    f = await buildOrgFixture({ PERMISSION_WRITE_CHECK: "enforce" });

    for (const c of [
      {
        slug: "authors",
        fields: [
          { name: "name", type: "text" },
          { name: "department", type: "text" },
        ],
      },
      {
        slug: "articles",
        fields: [
          { name: "title", type: "text" },
          { name: "author", type: "relation", to: "authors" },
        ],
      },
    ]) {
      const res = await f.h.fetch("/api/collections", json("POST", c));
      expect(res.status, `create the ${c.slug} collection`).toBe(201);
    }

    const author = await f.h.fetch(
      "/api/items/authors",
      json("POST", { name: "Sam", department: "sales" }),
    );
    expect(author.status).toBe(201);
    salesAuthorId = String(((await author.json()) as { data: { id: unknown } }).data.id);

    const roleRes = await f.h.fetch("/api/roles", json("POST", { name: "Relation Editor" }));
    expect(roleRes.status).toBeLessThan(300);
    const roleId = ((await roleRes.json()) as { data: { id: string } }).data.id;
    for (const action of ["read", "create"] as const) {
      const granted = await f.h.fetch(
        `/api/roles/${roleId}/permissions`,
        json("POST", {
          collection: "articles",
          action,
          condition: { "author.department": { _eq: "engineering" } },
        }),
      );
      expect(granted.status, `grant ${action} on articles`).toBeLessThan(300);
    }
    // Workspace-wide this time, so the skip is exercised independently of the
    // org machinery above.
    const bind = await f.h.fetch(
      `/api/app-users/${f.memberId}/roles`,
      json("PUT", { roleIds: [roleId] }),
    );
    expect(bind.status, "bind the Relation Editor role workspace-wide").toBe(200);
  });
  afterAll(() => f.h.cleanup());

  test("(7) the write lands even though the condition would be FALSE if judged in memory", async () => {
    const res = await f.inA(
      "/api/items/articles",
      json("POST", { title: "skipped-not-denied", author: salesAuthorId }),
    );
    expect(res.status, await res.clone().text()).toBe(201);

    // It really is in the table — the operator, who bypasses conditions, sees it.
    const listed = await f.h.fetch("/api/items/articles?limit=200");
    expect(listed.status).toBe(200);
    const rows = ((await listed.json()) as { data: { title: string }[] }).data;
    expect(rows.map((r) => r.title)).toContain("skipped-not-denied");

    // Non-vacuity for the SKIP itself: the rule is genuinely unsatisfied. The
    // member's own READ of the same collection is filtered by the SQL lowering
    // of that very condition, and `sales !== engineering`, so it comes back
    // empty. A rule that happened to match would have shown the row here.
    const mine = await f.inA("/api/items/articles");
    expect(mine.status).toBe(200);
    const seen = ((await mine.json()) as { data: { title: string }[] }).data;
    expect(
      seen.map((r) => r.title),
      "the same condition, compiled to SQL, excludes the row that was just written",
    ).not.toContain("skipped-not-denied");
  });
});

/**
 * (6) The WARN default.
 *
 * Identical fixture, `PERMISSION_WRITE_CHECK` unset. The cross-org create must
 * SUCCEED and the row must exist. This is not a nicety: a tenant whose
 * integration has been writing cross-scope rows for months against a rule that
 * only ever filtered reads would go down on the release that introduces the
 * check. Without this test the default could quietly become enforce and nothing
 * in the suite would notice.
 */
describe("write-condition check — the warn default lets the write through", () => {
  let f: OrgFixture;

  beforeAll(async () => {
    f = await buildOrgFixture();
  });
  afterAll(() => f.h.cleanup());

  test("(6) the same cross-org create succeeds, and the row is really there", async () => {
    // The env is genuinely unset, not merely something-other-than-enforce.
    expect(f.h.env.PERMISSION_WRITE_CHECK).toBeUndefined();

    const res = await f.inA(
      "/api/items/tickets",
      json("POST", { title: "warned-not-refused", org_id: f.orgB }),
    );
    expect(res.status, await res.clone().text()).toBe(201);

    const titles = await allTicketTitles(f.h);
    expect(titles, "warn mode logs and allows").toContain("warned-not-refused");

    // The update mirror warns too, so a tenant mid-migration is not caught by
    // the half of the check nobody thought to try.
    const created = await f.inA(
      "/api/items/tickets",
      json("POST", { title: "warned-update", org_id: f.orgA }),
    );
    expect(created.status).toBe(201);
    const id = String(((await created.json()) as { data: { id: unknown } }).data.id);
    const moved = await f.inA(`/api/items/tickets/${id}`, json("PATCH", { org_id: f.orgB }));
    expect(moved.status, "the update mirror also warns rather than refusing").toBe(200);
  });
});
