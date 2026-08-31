/**
 * An attacker's pass over the Phase 3 write-condition check.
 *
 * Phase 3 claims that a create or update cannot produce a row outside what the
 * caller's own permission condition allows — the `WITH CHECK` the Postgres RLS
 * projection has always emitted and the API in front of it never did. The claim
 * is made by ONE function, `assertWriteConditions` in
 * `services/items/write.ts`, called from exactly TWO places: `performCreate`,
 * just before the INSERT is built, and `performUpdate`, just before the SET.
 *
 * A guarantee asserted in one place and relied on everywhere is only as wide as
 * the paths that reach it, so this file attacks it from three directions:
 *
 *   1. the CONDITION — can a rule be shaped so the check declines to judge it?
 *   2. the SUBJECT — does every caller of the write core hand it the identity
 *      the rule is written against, or do some build a stale `WriteEnv`?
 *   3. the PATH — which routes write a row without going through those two
 *      functions at all?
 *
 * Every attack runs with `PERMISSION_WRITE_CHECK: "enforce"`, because in the
 * default `warn` mode nothing is refused and every one of them "works"
 * trivially. Five got through. Each is pinned below with the CURRENT behaviour
 * asserted and a comment naming what it should be, so the file stays green and
 * the day a fix lands it fails loudly and says why — the same shape the Phase 0
 * specs used.
 *
 * The scenario throughout is the canonical B2B rule `docs/app-organizations.md`
 * sells: `{ org_id: { _eq: "$org.id" } }`, an app-plane end-user acting inside
 * one org, and a second org they have no business writing into.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import { buildContext } from "../src/server/context";
import { unpublishDueItems } from "../src/server/services/items/scheduled-publish";

const JSON_HEADERS = { "content-type": "application/json" };

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: JSON_HEADERS,
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

type Caller = (path: string, init?: RequestInit) => Promise<Response>;

/** App-plane caller. `org` sets `X-Backlex-Org`, which is what selects `$org.id`. */
const bearerFor = (h: TestHarness, token: string, org?: string): Caller =>
  (path, init = {}) =>
    Promise.resolve(h.app.request(path, {
      ...init,
      headers: {
        ...JSON_HEADERS,
        ...(init.headers ?? {}),
        Authorization: `Bearer ${token}`,
        ...(org ? { "X-Backlex-Org": org } : {}),
      },
    }));

interface EndUser {
  id: string;
  email: string;
  token: string;
}

/** Admin-invite an end-user and accept it — same two steps `app-orgs.test.ts` uses. */
const makeEndUser = async (h: TestHarness, email: string): Promise<EndUser> => {
  const invited = await h.fetch("/api/app-users/invite", json("POST", { email }));
  expect(invited.status).toBe(201);
  const { data } = (await invited.json()) as {
    data: { id: string; email: string; token: string };
  };
  const accepted = await h.app.request(
    "/api/t/default/auth/invite/accept",
    json("POST", { token: data.token, password: "write-check-12345" }),
  );
  expect(accepted.status).toBe(200);
  const session = (await accepted.json()) as { token: string };
  return { id: data.id, email: data.email, token: session.token };
};

const roleIdByName = async (h: TestHarness, name: string): Promise<string> => {
  const res = await h.fetch("/api/roles");
  expect(res.status).toBe(200);
  const roles = ((await res.json()) as { data: { id: string; name: string }[] }).data;
  const role = roles.find((r) => r.name === name);
  expect(role, `role "${name}" should exist`).toBeDefined();
  return role!.id;
};

const dataOf = async (res: Response): Promise<Record<string, unknown>> =>
  ((await res.json()) as { data: Record<string, unknown> }).data;

/** The rule the whole feature exists to make expressible. */
const ORG_RULE = { org_id: { _eq: "$org.id" } } as const;

/**
 * A rule that fences a column AND traverses a relation — the shape a real B2B
 * schema reaches for the moment it has more than one table: "your org's rows,
 * and only while the project they hang off is still open".
 */
const MIXED_RULE = {
  $and: [{ org_id: { _eq: "$org.id" } }, { "project.status": { _eq: "open" } }],
} as const;

describe("write-condition check — what it actually fences", () => {
  let h: TestHarness;
  let alice: EndUser;
  let acme: string;
  let victim: string;
  let openProject: string;

  /** A row the admin plants in `org`, so the caller under test never made it. */
  const seedTicket = async (org: string, title = "seed"): Promise<string> => {
    const res = await h.fetch("/api/items/tickets", json("POST", { title, org_id: org }));
    expect(res.status).toBe(201);
    return String((await dataOf(res)).id);
  };

  const asAlice = (): Caller => bearerFor(h, alice.token, acme);

  beforeAll(async () => {
    h = makeHarness({ PERMISSION_WRITE_CHECK: "enforce" });
    await seedAdmin(h);

    for (const c of [
      { slug: "projects", fields: [{ name: "status", type: "text" }] },
      {
        slug: "tickets",
        fields: [
          { name: "title", type: "text" },
          { name: "org_id", type: "text" },
        ],
      },
      {
        // Same shape as `tickets`, but its rule also traverses a relation.
        slug: "mixed",
        fields: [
          { name: "title", type: "text" },
          { name: "org_id", type: "text" },
          { name: "project", type: "relation", to: "projects" },
        ],
      },
      {
        // Two separate permission ROWS, one dotted and one not — the case the
        // OR-ing loop handles correctly, kept here so the difference from
        // `mixed` (one row carrying both) is visible side by side.
        slug: "split",
        fields: [
          { name: "title", type: "text" },
          { name: "org_id", type: "text" },
          { name: "project", type: "relation", to: "projects" },
        ],
      },
      {
        // `$user.email` rather than `$org.id`, to ask the same question of a
        // different variable on the subject.
        slug: "notes",
        fields: [
          { name: "body", type: "text" },
          { name: "author", type: "text" },
        ],
      },
      {
        slug: "articles",
        versioned: true,
        stagedEdits: true,
        fields: [
          { name: "title", type: "text" },
          { name: "org_id", type: "text" },
        ],
      },
      {
        slug: "docs",
        fields: [
          { name: "title", type: "text" },
          { name: "region", type: "text", localized: true },
        ],
      },
    ]) {
      const res = await h.fetch("/api/collections", json("POST", c));
      expect(res.status, `create collection ${c.slug}`).toBe(201);
    }

    // Every app-plane end-user is `authenticated`, so that is where the rules go.
    const authRoleId = await roleIdByName(h, "authenticated");
    for (const p of [
      { collection: "projects", action: "read" },
      { collection: "tickets", action: "read", condition: ORG_RULE },
      { collection: "tickets", action: "create", condition: ORG_RULE },
      { collection: "tickets", action: "update", condition: ORG_RULE },
      { collection: "mixed", action: "read", condition: MIXED_RULE },
      { collection: "mixed", action: "create", condition: MIXED_RULE },
      { collection: "mixed", action: "update", condition: MIXED_RULE },
      // Two rows: the org fence and the relation hop are granted separately.
      { collection: "split", action: "read", condition: ORG_RULE },
      { collection: "split", action: "create", condition: ORG_RULE },
      {
        collection: "split",
        action: "create",
        condition: { "project.status": { _eq: "open" } },
      },
      { collection: "notes", action: "read" },
      { collection: "notes", action: "create", condition: { author: { _eq: "$user.email" } } },
      { collection: "articles", action: "read", condition: ORG_RULE },
      { collection: "articles", action: "update", condition: ORG_RULE },
      { collection: "docs", action: "read" },
      { collection: "docs", action: "create", condition: { region: { _neq: "confidential" } } },
    ]) {
      const g = await h.fetch(`/api/roles/${authRoleId}/permissions`, json("POST", p));
      expect(g.status, `grant ${p.collection}.${p.action}`).toBeLessThan(300);
    }

    alice = await makeEndUser(h, "alice@write-check.test");
    const bob = await makeEndUser(h, "bob@write-check.test");
    for (const [name, owner] of [
      ["Acme", alice.id],
      ["Victim", bob.id],
    ] as const) {
      const res = await h.fetch("/api/app-orgs", json("POST", { name, ownerAppUserId: owner }));
      expect(res.status).toBe(201);
      const org = await dataOf(res);
      if (name === "Acme") acme = String(org.id);
      else victim = String(org.id);
    }

    const pj = await h.fetch("/api/items/projects", json("POST", { status: "open" }));
    expect(pj.status).toBe(201);
    openProject = String((await dataOf(pj)).id);
  });
  afterAll(() => h.cleanup());

  /* ───────────────────────── the fence, where it holds ───────────────────── */

  describe("the guarantee, on the paths that reach it", () => {
    test("REST create: own org allowed, another org refused", async () => {
      const ok = await asAlice()(
        "/api/items/tickets",
        json("POST", { title: "mine", org_id: acme }),
      );
      expect(ok.status).toBe(201);

      const planted = await asAlice()(
        "/api/items/tickets",
        json("POST", { title: "planted", org_id: victim }),
      );
      expect(planted.status).toBe(403);
      const body = (await planted.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("FORBIDDEN");
      // The message names the collection, never the rejected values — the row
      // is the caller's own payload but the log line is shared.
      expect(body.error.message).toContain("tickets");
    });

    test("REST update: a row cannot be patched out of the org it is in", async () => {
      const row = await seedTicket(acme);
      const moved = await asAlice()(
        `/api/items/tickets/${row}`,
        json("PATCH", { org_id: victim }),
      );
      expect(moved.status).toBe(403);

      // …and the row did not move. `whereSql` alone would have allowed this:
      // it picks WHICH row may be touched and says nothing about what it becomes.
      const after = await h.fetch(`/api/items/tickets/${row}`);
      expect((await dataOf(after)).org_id).toBe(acme);
    });

    test("clearing the fenced column is a move too, and is refused", async () => {
      // `org_id: null` orphans the row out of every org rather than into a named
      // one. It is the same escape and the single-row path catches it.
      const row = await seedTicket(acme);
      const orphaned = await asAlice()(`/api/items/tickets/${row}`, json("PATCH", { org_id: null }));
      expect(orphaned.status).toBe(403);
      const after = await h.fetch(`/api/items/tickets/${row}`);
      expect((await dataOf(after)).org_id).toBe(acme);
    });

    test("GraphQL create is the same chokepoint, not a second one", async () => {
      const gql = async (query: string) =>
        (await (await asAlice()("/api/graphql", json("POST", { query }))).json()) as {
          data?: Record<string, unknown> | null;
          errors?: { message: string }[];
        };

      // GraphQL camel-cases the column, which is the only thing about it that
      // differs from the REST call above.
      const ok = await gql(
        `mutation { createTickets(data: { title: "gql-mine", orgId: "${acme}" }) { id } }`,
      );
      expect(ok.errors ?? []).toEqual([]);

      const bad = await gql(
        `mutation { createTickets(data: { title: "gql-planted", orgId: "${victim}" }) { id } }`,
      );
      expect(bad.errors?.length ?? 0).toBeGreaterThan(0);
      expect(bad.errors![0]!.message).toContain("outside what your permission");
    });

    test("the batch endpoint does not get its own answer", async () => {
      const res = await asAlice()(
        "/api/items/tickets/batch",
        json("POST", {
          operations: [
            { op: "create", data: { title: "batch-mine", org_id: acme } },
            { op: "create", data: { title: "batch-planted", org_id: victim } },
          ],
        }),
      );
      expect(res.status).toBe(200);
      const result = (await dataOf(res)) as {
        results: { ok: boolean; error?: { code: string } }[];
      };
      expect(result.results[0]!.ok).toBe(true);
      expect(result.results[1]!.ok).toBe(false);
      expect(result.results[1]!.error?.code).toBe("FORBIDDEN");
    });

    test("import goes row by row through the same check", async () => {
      const res = await asAlice()(
        "/api/items/tickets/import",
        json("POST", [
          { title: "import-mine", org_id: acme },
          { title: "import-planted", org_id: victim },
        ]),
      );
      expect(res.status).toBe(200);
      const summary = (await dataOf(res)) as {
        inserted: number;
        failed: number;
        errors: { row: number; error: string }[];
      };
      expect(summary.inserted).toBe(1);
      expect(summary.failed).toBe(1);
      expect(summary.errors[0]!.error).toContain("outside what your permission");
    });

    test("a column the proposed row does not carry fails CLOSED, not open", async () => {
      // `_eq` against an absent value is a real verdict — false — and that is the
      // safe direction. Omitting `org_id` entirely must not read as "no opinion".
      const res = await asAlice()("/api/items/tickets", json("POST", { title: "no org at all" }));
      expect(res.status).toBe(403);
    });

    test("two permission rows: a relation rule does not excuse the column rule", async () => {
      // `split` grants create twice — once fenced on `org_id`, once on a relation
      // path the in-memory evaluator cannot judge. The loop skips the second and
      // still demands the first, which is the strict and correct reading: a rule
      // it cannot evaluate is not a rule that passes.
      const planted = await asAlice()(
        "/api/items/split",
        json("POST", { title: "planted", org_id: victim, project: openProject }),
      );
      expect(planted.status).toBe(403);

      const mine = await asAlice()(
        "/api/items/split",
        json("POST", { title: "mine", org_id: acme, project: openProject }),
      );
      expect(mine.status).toBe(201);
    });
  });

  /* ─────────────────────────── HOLE 1 — the skip ─────────────────────────── */

  describe("HOLE — one relation key disarms every OTHER key in the same rule", () => {
    /**
     * `assertWriteConditions` skips a condition whose keys include a relation
     * path, because `packages/db/src/permission.ts` returns a hard `false` for
     * any dotted key and refusing every write under a rule that filters reads
     * correctly would be an outage rather than a fix. That reasoning is sound.
     * The implementation of it is not: `hasDottedKey`
     * (services/items/write.ts:379) answers for the WHOLE condition tree, and
     * `skipped.push(cond); continue;` (write.ts:328) drops the whole condition.
     *
     * So `{ $and: [ {org_id: {_eq: "$org.id"}}, {"project.status": {_eq: "open"}} ] }`
     * — one plain column fence AND one relation hop, which is what a B2B schema
     * writes the moment it has two tables — is treated as unjudgeable in full.
     * `skipped.length === perm.conditions.length`, the function logs
     * `permission-write-check-skipped` and RETURNS, and the org fence never runs.
     *
     * The log line even says "every condition uses a relation path the in-memory
     * evaluator cannot judge", which is false here: one of the two conjuncts is
     * an ordinary text column. `packages/db/src/permission.ts::checkableRule`
     * already solves exactly this — narrow the rule to the part that CAN be
     * judged and keep enforcing it, which is sound for `$and` because a
     * conjunction only gets stricter as branches drop.
     */
    test("READS are fenced by the mixed rule — so an operator has every reason to trust it", async () => {
      const mine = await h.fetch(
        "/api/items/mixed",
        json("POST", { title: "mine", org_id: acme, project: openProject }),
      );
      const theirs = await h.fetch(
        "/api/items/mixed",
        json("POST", { title: "theirs", org_id: victim, project: openProject }),
      );
      const mineId = String((await dataOf(mine)).id);
      const theirsId = String((await dataOf(theirs)).id);

      const list = await asAlice()("/api/items/mixed");
      expect(list.status).toBe(200);
      const seen = ((await list.json()) as { data: { id: string }[] }).data.map((r) =>
        String(r.id),
      );
      // The SQL compiler lowers the relation hop to a correlated EXISTS and the
      // column fence to a plain comparison, so the read side honours BOTH.
      expect(seen).toContain(mineId);
      expect(seen).not.toContain(theirsId);
    });

    test("the judgeable conjunct still fences a CREATE into the other org", async () => {
      const planted = await asAlice()(
        "/api/items/mixed",
        json("POST", { title: "planted", org_id: victim, project: openProject }),
      );

      // `org_id` is an ordinary column and the rule fences it. The relation hop
      // beside it cannot be judged in memory and is DROPPED from the
      // conjunction, which is sound in one direction only: a conjunction gets
      // stricter as branches fall away, so what survives can still refuse.
      expect(planted.status).toBe(403);
    });

    test("…and an existing row cannot be UPDATED out of the org either", async () => {
      const mine = await h.fetch(
        "/api/items/mixed",
        json("POST", { title: "movable", org_id: acme, project: openProject }),
      );
      const id = String((await dataOf(mine)).id);

      const moved = await asAlice()(`/api/items/mixed/${id}`, json("PATCH", { org_id: victim }));
      expect(moved.status).toBe(403);
      // The row is unmoved. A 403 that had already written would be worse than
      // the 200 this used to return.
      const after = await h.fetch(`/api/items/mixed/${id}`);
      expect((await dataOf(after)).org_id).toBe(acme);
    });

    // The other half of this — a rule that is relation paths ALL the way down
    // must still be SKIPPED rather than denied — is covered against a real
    // fixture in `write-condition-check.test.ts` ("relation-path skip in
    // enforce mode"). The narrowing must not quietly become "judge
    // everything": that would deny writes the product has been accepting under
    // a rule its author wrote for reads, which is the outage the skip exists
    // to avoid.
  });

  /* ──────────────────────── HOLE 2 — the stale subject ───────────────────── */

  describe("HOLE — bulk-update builds a WriteEnv with no identity to judge against", () => {
    /**
     * The check can only be as good as the subject it evaluates `$org.id` /
     * `$user.email` against, and that subject is built by `authSubjectOf(env)`
     * from the `WriteEnv` each call site hands in. Phase 3 threaded
     * `orgId`/`orgRole`/`orgIds` through the REST, GraphQL, CSV, ingest, batch
     * and forms call sites — but NOT through
     * `services/items/bulk.ts::baseEnv` (line 102), which still names only
     * `userId`, `tenantId` and `roles`. It never carried `email` either.
     *
     * So on `POST /api/items/{slug}/bulk-update` (and its GraphQL twin
     * `bulkUpdate<Collection>`, which shares `runBulkUpdate`) `$org.id`
     * resolves to `null`. That breaks in BOTH directions at once, which is the
     * tell that it is a missing wire rather than a policy:
     *
     *   - every legitimate in-org bulk update is refused, because the row's real
     *     `org_id` can never equal `null`;
     *   - and `org_id: null` is ACCEPTED, because `null === null` matches — the
     *     one value the single-row PATCH above refuses.
     *
     * `services/items/write.ts:227` names this exact failure as the reason the
     * org context had to arrive before the check could mean anything: "that
     * would have made the write-condition check below evaluate every org rule
     * against a null org and refuse every insert, which is a worse bug than the
     * one it fixes". It is still true on this one path.
     */
    test("a bulk update of the caller's OWN in-org row is allowed", async () => {
      const row = await seedTicket(acme, "bulk-target");
      const res = await asAlice()(
        "/api/items/tickets/bulk-update",
        json("POST", { keys: [row], data: { title: "renamed" } }),
      );
      expect(res.status).toBe(200);
      const result = (await dataOf(res)) as {
        updated: number;
        failed: number;
        results: { ok: boolean; error?: { code: string } }[];
      };

      // The row is squarely inside the org the caller is acting in, and the
      // same patch through PATCH succeeds. It used to be refused here alone,
      // because `baseEnv()` handed the check a subject with no org on it.
      expect(result.updated).toBe(1);
      expect(result.failed).toBe(0);
      expect(result.results[0]!.ok).toBe(true);

      // The single-row path proves the patch itself is fine.
      const single = await asAlice()(`/api/items/tickets/${row}`, json("PATCH", { title: "ok" }));
      expect(single.status).toBe(200);
    });

    test("…and the SAME endpoint refuses the org escape PATCH refuses", async () => {
      const row = await seedTicket(acme, "bulk-orphan");

      // Control: the single-row path refuses to clear the fenced column.
      const single = await asAlice()(`/api/items/tickets/${row}`, json("PATCH", { org_id: null }));
      expect(single.status).toBe(403);

      const bulk = await asAlice()(
        "/api/items/tickets/bulk-update",
        json("POST", { keys: [row], data: { org_id: null } }),
      );
      expect(bulk.status).toBe(200);
      const result = (await dataOf(bulk)) as { updated: number; failed: number };

      // `null` is not `$org.id`, and the two surfaces must not disagree about
      // one permission. The direction matters as much as the refusal: the same
      // missing wire made this endpoint ACCEPT the escape that PATCH refuses.
      expect(result.updated).toBe(0);
      expect(result.failed).toBe(1);

      // The row never left the org.
      const after = await h.fetch(`/api/items/tickets/${row}`);
      expect((await dataOf(after)).org_id).toBe(acme);
      expect((await asAlice()(`/api/items/tickets/${row}`)).status).toBe(200);
    });

    test("`$user.email` resolves on the import surface too", async () => {
      // Same root cause, different variable and different route:
      // `routes/items/csv.ts:374` and `routes/items/ingest.ts:223` both gained
      // `orgId`/`orgRole`/`orgIds` in Phase 3 and neither carries `email`.
      const rest = await asAlice()(
        "/api/items/notes",
        json("POST", { body: "via REST", author: alice.email }),
      );
      expect(rest.status).toBe(201);

      const imported = await asAlice()(
        "/api/items/notes/import",
        json("POST", [{ body: "via import", author: alice.email }]),
      );
      expect(imported.status).toBe(200);
      const summary = (await dataOf(imported)) as { inserted: number; failed: number };

      // Byte-for-byte the row REST just accepted, written by the same caller
      // under the same rule — so the two surfaces have to agree. They did not
      // while the CSV and ingest WriteEnvs omitted `email`.
      expect(summary.inserted).toBe(1);
      expect(summary.failed).toBe(0);
    });
  });

  /* ──────────────────── HOLE 3 — a path that never asks ──────────────────── */

  describe("HOLE — reverting a revision rewrites the row without asking anything", () => {
    /**
     * `routes/revisions.ts:185` builds its own `UPDATE … SET … WHERE id = ?` from
     * the stored snapshot. It checks `perm.allowed` — that the caller has
     * `update` on the collection AT ALL — and then applies neither
     * `perm.whereSql` nor the condition behind it. Phase 3 did not touch the
     * file, because the file does not call `performUpdate`.
     *
     * A revision snapshot is `beforeRow` (services/items/write.ts:1114): the row
     * as it stood before some earlier edit. So any value the column has EVER
     * held is replayable by anyone holding a conditioned `update` grant — and
     * "before an admin moved this row into your org" is exactly such a value.
     */
    test("a revert obeys the same condition the item route does", async () => {
      // The admin creates the row in the victim's org, then moves it into Acme.
      // That second write is what records a snapshot holding `org_id = victim`.
      const created = await h.fetch(
        "/api/items/tickets",
        json("POST", { title: "was theirs", org_id: victim }),
      );
      const id = String((await dataOf(created)).id);
      expect((await h.fetch(`/api/items/tickets/${id}`, json("PATCH", { org_id: acme }))).status)
        .toBe(200);

      // Alice may now read it — it is in her org — which is also what lets her
      // list its revisions (`GET /api/revisions/{collection}/{itemId}` gates on
      // `read`).
      const revs = await asAlice()(`/api/revisions/tickets/${id}`);
      expect(revs.status).toBe(200);
      const list = ((await revs.json()) as { data: { id: string }[] }).data;
      expect(list.length).toBeGreaterThan(0);

      // Control: saying the same thing through the item route is refused.
      expect((await asAlice()(`/api/items/tickets/${id}`, json("PATCH", { org_id: victim }))).status)
        .toBe(403);

      const reverted = await asAlice()(`/api/revisions/${list[0]!.id}/revert`, json("POST"));
      // The revert produces a row the caller's own condition forbids, and the
      // write core says so — the same 403 the item route gives, because it is
      // now the same code path. The revert used to build its own UPDATE from a
      // four-field private `loadCollection`, and that private loader is what
      // made the private statement look reasonable.
      expect(reverted.status).toBe(403);

      const after = await h.fetch(`/api/items/tickets/${id}`);
      expect((await dataOf(after)).org_id).toBe(acme);
      // Still hers, and still visible to her — a refused revert wrote nothing.
      expect((await asAlice()(`/api/items/tickets/${id}`)).status).toBe(200);
    });
  });

  /* ─────────────── HOLE 4 — a deferred write with no caller left ─────────── */

  describe("HOLE — the scheduler applies an end-user's staged patch unchecked", () => {
    /**
     * Two halves meet here, and each is defensible alone.
     *
     * (a) On a `stagedEdits` collection, a PATCH against a PUBLISHED row returns
     *     from `performUpdate` at services/items/write.ts:868 — the staged-edits
     *     interception — which is BEFORE `assertWriteConditions` at line 1028.
     *     Nothing is written to the live row, so skipping the check reads as
     *     harmless: the patch is judged later, when it is applied. The manual
     *     `POST /{slug}/{id}/publish` does exactly that, threading the caller's
     *     real `conditions` through (routes/items/write.ts:424).
     *
     * (b) `services/items/scheduled-publish.ts:175` applies the same staged
     *     patch from the cron sweep with `{ whereSql: null, fields: null,
     *     conditions: null }`, and the comment justifies it: "the scheduler is
     *     publishing what an operator already staged and approved".
     *
     * The premise in (b) is false whenever a collection grants `update` to
     * anyone who is not an operator, which is the whole point of a conditioned
     * grant. The staged patch was authored by the end-user, never judged on the
     * way in by (a), and is applied by (b) as if it had been. `conditions: null`
     * is the value the field's own docstring reserves for "an internal,
     * non-user-initiated write" — this one is user-initiated in full.
     */
    test("a staged org move is refused on the way in, so the sweep has nothing to publish", async () => {
      const created = await h.fetch(
        "/api/items/articles",
        json("POST", { title: "staged", org_id: acme }),
      );
      const id = String((await dataOf(created)).id);
      expect((await h.fetch(`/api/items/articles/${id}/publish`, { method: "POST" })).status)
        .toBe(200);

      // The staged save is REFUSED on the way in. Checking here rather than at
      // apply time is what makes the answer independent of who applies it: a
      // patch that could not be written live cannot be staged either, so the
      // cron sweep has nothing bad to publish and its `conditions: null` stays
      // honest.
      const staged = await asAlice()(`/api/items/articles/${id}`, json("PATCH", { org_id: victim }));
      expect(staged.status).toBe(403);
      // Nothing was staged, and the live row never moved.
      expect((await dataOf(await h.fetch(`/api/items/articles/${id}`))).org_id).toBe(acme);

      // An operator schedules an ordinary expiry — nothing about this action
      // mentions `org_id`, and the person doing it has no reason to inspect a
      // pending staged patch.
      const soon = new Date(Date.now() + 250).toISOString();
      expect(
        (
          await h.fetch(
            `/api/items/articles/${id}/publish`,
            json("POST", { unpublishAt: soon }),
          )
        ).status,
      ).toBe(200);

      await new Promise((r) => setTimeout(r, 450));
      await unpublishDueItems(await buildContext(h.env));

      const after = await dataOf(await h.fetch(`/api/items/articles/${id}`));
      // The sweep still runs and still unpublishes — only the org move it used
      // to carry is gone, because it was never allowed to be staged.
      expect(after.org_id).toBe(acme);
      expect(after._status).toBe("draft");
    });
  });

  /* ────── CLOSED — a localized column, judged at the default locale ────── */

  describe("a localized column is judged, at the workspace default locale", () => {
    /**
     * This was HOLE 5, and it is closed.
     *
     * `splitLocalized` pulls every localized field off the payload long before
     * the check runs, so the proposed row had no value to compare and the key
     * was narrowed out — the rule did not apply to writes at all. Meanwhile the
     * READ side did apply it, so the same rule hid a row from you and let you
     * create one.
     *
     * Both halves now compile to the same question: the value at the WORKSPACE
     * DEFAULT locale. The write path reads it from this write if it set that
     * locale, otherwise from what is stored.
     *
     * A field with NO value in the default locale is counted as unsatisfied
     * rather than as "no opinion" — deliberately, because the two evaluators
     * disagree there in the permissive direction: `matchesCondition` answers
     * `_neq` against an absent value with TRUE, while SQL answers `NULL != 'x'`
     * with NULL and drops the row. Refusing matches the read.
     */
    test("the forbidden value is refused, in the locale the rule is read in", async () => {
      // Positive control: `region` really is localized, so this is not quietly
      // passing against an ordinary column. The proof is where the value LANDS
      // — the sidecar, which `?locale=*` renders as a per-locale map.
      const control = await asAlice()(
        "/api/items/docs",
        json("POST", { title: "no locale", region: "public" }),
      );
      expect(control.status).toBe(201);
      const controlMap = await dataOf(
        await h.fetch(`/api/items/docs/${String((await dataOf(control)).id)}?locale=*`),
      );
      expect(typeof controlMap.region).toBe("object");
      expect(Object.values(controlMap.region as Record<string, unknown>)).toEqual(["public"]);

      // Was 201 — the write the rule exists to prevent.
      const res = await asAlice()(
        "/api/items/docs?locale=en",
        json("POST", { title: "leak", region: "confidential" }),
      );
      expect(res.status).toBe(403);

      // And a locale-less write of the same value, which reaches the sidecar
      // by the same route now that a bare value means the default locale.
      const bare = await asAlice()(
        "/api/items/docs",
        json("POST", { title: "leak2", region: "confidential" }),
      );
      expect(bare.status).toBe(403);
    });

    test("a value only in another locale is refused too, because the read would drop the row", async () => {
      // Nothing in the default locale means `NULL` on the read side, and
      // `NULL != 'confidential'` is not true — the row would be invisible to
      // the very role creating it.
      const res = await asAlice()(
        "/api/items/docs?locale=tr",
        json("POST", { title: "tr only", region: "public" }),
      );
      expect(res.status).toBe(403);
    });
  });
});

/* ────────────────────────── the default posture ────────────────────────── */

describe("write-condition check — the default is warn, and warn means allowed", () => {
  /**
   * Pinned so nobody reads the holes above as "the check is off by default
   * anyway". They are all reproduced with `PERMISSION_WRITE_CHECK: "enforce"`,
   * which is the mode this feature exists to be run in; this block is only here
   * to state what the OTHER mode does, since an operator who has not opted in
   * gets no protection from any of it and should not think otherwise.
   */
  let h: TestHarness;
  let alice: EndUser;
  let acme: string;
  let victim: string;

  beforeAll(async () => {
    h = makeHarness(); // no PERMISSION_WRITE_CHECK — the shipped default
    await seedAdmin(h);
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
    expect(created.status).toBe(201);

    const authRoleId = await roleIdByName(h, "authenticated");
    for (const action of ["read", "create", "update"]) {
      const g = await h.fetch(
        `/api/roles/${authRoleId}/permissions`,
        json("POST", { collection: "tickets", action, condition: ORG_RULE }),
      );
      expect(g.status).toBeLessThan(300);
    }

    alice = await makeEndUser(h, "alice@warn-mode.test");
    const bob = await makeEndUser(h, "bob@warn-mode.test");
    for (const [name, owner] of [
      ["Acme", alice.id],
      ["Victim", bob.id],
    ] as const) {
      const res = await h.fetch("/api/app-orgs", json("POST", { name, ownerAppUserId: owner }));
      expect(res.status).toBe(201);
      const org = await dataOf(res);
      if (name === "Acme") acme = String(org.id);
      else victim = String(org.id);
    }
  });
  afterAll(() => h.cleanup());

  test("an unset PERMISSION_WRITE_CHECK still plants the row", async () => {
    const planted = await bearerFor(h, alice.token, acme)(
      "/api/items/tickets",
      json("POST", { title: "planted", org_id: victim }),
    );
    expect(planted.status).toBe(201);
    expect((await dataOf(planted)).org_id).toBe(victim);
  });
});
