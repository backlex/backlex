/**
 * The advisor rule that has to exist before `PERMISSION_WRITE_CHECK` can be
 * flipped — issue #334.
 *
 * WHY THE FLIP NEEDED A RULE FIRST
 *
 * `PERMISSION_WRITE_CHECK` defaults to `warn`: a write landing outside its
 * role's `write` conditions is counted and allowed. `PLANE_GUARD` had the same
 * permissive default and phase 10 flipped it, but the reason for THIS one had
 * not expired. A tenant's integrations may have been writing cross-scope rows
 * for months against a rule that only ever filtered READS; turning that into a
 * 403 on upgrade breaks a working application for somebody who changed nothing.
 *
 * The operator could not tell whether they were that tenant. The check wrote a
 * `console.warn` and moved on — nobody queries last week's logs from the
 * Advisor page — so "is enforce safe here?" was a guess about their own data.
 *
 * WHAT THIS FILE PINS
 *
 *   1. the positive control — a legitimate in-org write records NOTHING, and
 *      the advisor says so with the `info` finding. It comes first because
 *      without it every count below is equally explained by a dead recorder;
 *   2. the violating write is recorded, and the advisor names the collection
 *      and the action, at `error`, while the mode is still `warn`;
 *   3. the count is per REQUEST and does not bleed — a clean request after a
 *      violating one does not inherit the marker. This is the assertion that
 *      would fail if the collector were created on the base `Ctx`, which
 *      `buildContext` memoizes PER ISOLATE: every concurrent request on that
 *      isolate would share one array;
 *   4. under `enforce` the write is refused AND still recorded, at `warn`,
 *      with wording that says it already happened rather than that it would;
 *   5. `foldWriteChecks` dedupes and caps, so a 5,000-row import that misses
 *      the same condition every time writes one span attribute, not 5,000.
 *
 * The identities are real and there are two of them: the operator runs the
 * advisor, an app-plane member makes the writes. A spec that drove only the
 * operator would prove nothing here — the operator bypasses conditions, so
 * every write it makes is legitimate and the recorder would look dead in
 * exactly the same way it looks correct.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import { foldWriteChecks } from "../src/server/services/traces";
import type { Env } from "../src/server/env";

const JSON_HEADERS = { "content-type": "application/json" };

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: JSON_HEADERS,
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

interface AdvisorFinding {
  id: string;
  rule: string;
  level: string;
  title: string;
  body: string;
  fix: string;
  resource: string;
  evidence?: { requests: number; windowDays: number };
}

interface WriteCheckStat {
  collection: string;
  action: string;
  requests: number;
  refused: boolean;
}

interface Fixture {
  h: TestHarness;
  /** The end-user, a member of org A and of nothing else. */
  token: string;
  orgA: string;
  /** A real org in the same workspace the member does not belong to. */
  orgB: string;
}

/** One call as the member, acting inside `org`. */
const asMember = (f: Fixture, org: string, path: string, init: RequestInit) =>
  f.h.app.request(path, {
    ...init,
    headers: {
      ...JSON_HEADERS,
      ...(init.headers ?? {}),
      Authorization: `Bearer ${f.token}`,
      "X-Backlex-Org": org,
    },
  });

/**
 * One workspace, two organizations, an end-user in org A only, and a role
 * granting create/read on `tickets` under `{ org_id: { _eq: "$org.id" } }`
 * bound org-scoped — the canonical B2B rule from `docs/app-organizations.md`.
 */
const buildFixture = async (overrides: Partial<Env> = {}): Promise<Fixture> => {
  const h = makeHarness(overrides);
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
  expect(created.status, "create the tickets collection").toBe(201);

  const roleRes = await h.fetch("/api/roles", json("POST", { name: "Org Editor" }));
  expect(roleRes.status, "create the Org Editor role").toBeLessThan(300);
  const roleId = ((await roleRes.json()) as { data: { id: string } }).data.id;

  for (const action of ["read", "create"] as const) {
    const granted = await h.fetch(
      `/api/roles/${roleId}/permissions`,
      json("POST", {
        collection: "tickets",
        action,
        condition: { org_id: { _eq: "$org.id" } },
      }),
    );
    expect(granted.status, `grant ${action} on tickets`).toBeLessThan(300);
  }

  const invited = await h.fetch(
    "/api/app-users/invite",
    json("POST", { email: "member@advisor-write-check.test" }),
  );
  expect(invited.status, "invite the end-user").toBe(201);
  const invite = ((await invited.json()) as { data: { id: string; token: string } }).data;

  const accepted = await h.app.request(
    "/api/t/default/auth/invite/accept",
    json("POST", { token: invite.token, password: "advisor-write-check-12345" }),
  );
  expect(accepted.status, "accept the end-user invite").toBe(200);
  const token = ((await accepted.json()) as { token: string }).token;

  const aRes = await h.fetch(
    "/api/app-orgs",
    json("POST", { name: "Acme", ownerAppUserId: invite.id }),
  );
  expect(aRes.status, "create org A").toBe(201);
  const orgA = ((await aRes.json()) as { data: { id: string } }).data.id;

  // Org B has no members at all, so naming it is a real escalation rather than
  // a second hat the same person wears.
  const bRes = await h.fetch("/api/app-orgs", json("POST", { name: "Globex" }));
  expect(bRes.status, "create org B").toBe(201);
  const orgB = ((await bRes.json()) as { data: { id: string } }).data.id;

  const bound = await h.fetch(
    `/api/app-orgs/${orgA}/members/${invite.id}`,
    json("PATCH", { roleIds: [roleId] }),
  );
  expect(bound.status, "bind the Org Editor role inside org A").toBe(200);

  return { h, token, orgA, orgB };
};

/**
 * Poll the insights endpoint until the fire-and-forget span writes settle.
 *
 * `app.ts` floats the span insert on runtimes with no `ExecutionContext`, which
 * is every runtime the suite uses — same shape `tracing-surfaces.test.ts` waits
 * on. Bounded, and every caller asserts on the result rather than on the wait.
 */
const writeChecksAfter = async (
  h: TestHarness,
  want: number,
): Promise<WriteCheckStat[]> => {
  let stats: WriteCheckStat[] = [];
  for (let i = 0; i < 40; i++) {
    const res = await h.fetch("/api/admin/advisor/insights?days=1");
    expect(res.status, "insights is readable by the operator").toBe(200);
    const body = (await res.json()) as { permissionWriteChecks: WriteCheckStat[] };
    stats = body.permissionWriteChecks;
    if (stats.length >= want) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  return stats;
};

const advisorFindings = async (h: TestHarness): Promise<AdvisorFinding[]> => {
  const res = await h.fetch("/api/admin/advisor?days=1");
  expect(res.status, "the operator runs the advisor").toBe(200);
  return ((await res.json()) as { data: AdvisorFinding[] }).data;
};

const writeCheckRule = (findings: AdvisorFinding[]): AdvisorFinding[] =>
  findings.filter((f) => f.rule === "permission-write-check");

describe("advisor: PERMISSION_WRITE_CHECK=warn — what the flip would cost", () => {
  let f: Fixture;

  beforeAll(async () => {
    // No override: `warn` is the default, and running the default is the point.
    f = await buildFixture();
  });
  afterAll(() => f.h.cleanup());

  test("a legitimate in-org write records nothing, and the advisor says the flip is clear", async () => {
    const res = await asMember(
      f,
      f.orgA,
      "/api/items/tickets",
      json("POST", { title: "own org", org_id: f.orgA }),
    );
    expect(res.status, "the member may write inside their own org").toBe(201);

    // Wait for THIS request's span, not for a write-check that must not exist:
    // asking for one and timing out would look identical to a dead recorder.
    let spanCount = 0;
    for (let i = 0; i < 40; i++) {
      const ins = await f.h.fetch("/api/admin/advisor/insights?days=1");
      const body = (await ins.json()) as {
        permissionWriteChecks: WriteCheckStat[];
        window: { spanCount: number };
      };
      spanCount = body.window.spanCount;
      if (spanCount > 0) {
        expect(body.permissionWriteChecks, "a legitimate write records nothing").toEqual([]);
        break;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(spanCount, "traffic was actually recorded").toBeGreaterThan(0);

    const clear = writeCheckRule(await advisorFindings(f.h));
    expect(clear.length, "one finding, the all-clear").toBe(1);
    expect(clear[0]?.level).toBe("info");
    expect(clear[0]?.id).toBe("sec-permission-write-check-clear");
    expect(clear[0]?.title).toContain("would have been refused");
    expect(clear[0]?.fix).toContain("PERMISSION_WRITE_CHECK=enforce");
    expect(clear[0]?.evidence?.requests).toBe(0);
    // The count excludes relation-path conditions, and says so — "zero" has to
    // mean what the operator reads it as.
    expect(clear[0]?.body).toContain("relation");
  });

  test("a cross-org write is ALLOWED under warn, and the advisor names it", async () => {
    const res = await asMember(
      f,
      f.orgA,
      "/api/items/tickets",
      json("POST", { title: "other org", org_id: f.orgB }),
    );
    expect(res.status, "warn allows it — that is what warn IS").toBe(201);

    const stats = await writeChecksAfter(f.h, 1);
    expect(stats.length, "the violating write reached the span").toBe(1);
    expect(stats[0]).toMatchObject({
      collection: "tickets",
      action: "create",
      requests: 1,
      refused: false,
    });

    const findings = writeCheckRule(await advisorFindings(f.h));
    expect(findings.length, "the all-clear is replaced, not accompanied").toBe(1);
    const finding = findings[0];
    expect(finding?.level, "an operator about to flip needs this at error").toBe("error");
    expect(finding?.id).toBe("sec-permission-write-check-tickets-create");
    expect(finding?.title).toContain("would be refused under enforce");
    expect(finding?.resource).toBe("permissions · tickets");
    expect(finding?.evidence?.requests).toBe(1);
    expect(finding?.fix, "the fix has to say NOT to flip yet").toContain("Do NOT set");
  });

  test("the count is per REQUEST — a clean write after a dirty one inherits nothing", async () => {
    // The collector lives on the per-request Ctx. `buildContext` is memoized
    // per isolate, so a collector that defaulted itself onto the base Ctx would
    // be shared by every request on it — and this second, LEGITIMATE write
    // would carry the previous request's marker into its own span, taking the
    // count to 2 for traffic that never violated anything.
    const before = await writeChecksAfter(f.h, 1);
    expect(before[0]?.requests, "one violation so far").toBe(1);

    const ok = await asMember(
      f,
      f.orgA,
      "/api/items/tickets",
      json("POST", { title: "clean again", org_id: f.orgA }),
    );
    expect(ok.status).toBe(201);

    // Give the clean request's span every chance to land before reading.
    await new Promise((r) => setTimeout(r, 200));
    const after = await writeChecksAfter(f.h, 1);
    expect(after.length).toBe(1);
    expect(after[0]?.requests, "still one — the clean request carried nothing").toBe(1);
  });
});

describe("advisor: PERMISSION_WRITE_CHECK=enforce — what the flip is costing", () => {
  let f: Fixture;

  beforeAll(async () => {
    f = await buildFixture({ PERMISSION_WRITE_CHECK: "enforce" });
  });
  afterAll(() => f.h.cleanup());

  test("the write is refused AND recorded — a 403 is not the end of the operator's question", async () => {
    const res = await asMember(
      f,
      f.orgA,
      "/api/items/tickets",
      json("POST", { title: "other org", org_id: f.orgB }),
    );
    expect(res.status, "enforce refuses it").toBe(403);

    const stats = await writeChecksAfter(f.h, 1);
    expect(stats.length, "a refusal is recorded too").toBe(1);
    expect(stats[0]).toMatchObject({
      collection: "tickets",
      action: "create",
      refused: true,
    });

    const findings = writeCheckRule(await advisorFindings(f.h));
    expect(findings.length).toBe(1);
    const finding = findings[0];
    // Already refused is a smaller emergency than about-to-be-refused: the
    // caller is broken, but no data landed where it should not have.
    expect(finding?.level).toBe("warn");
    expect(finding?.title).toContain("were refused");
    expect(finding?.title).not.toContain("would be refused");
    expect(finding?.fix).not.toContain("Do NOT set");
  });

  test("no all-clear is offered while the mode is already enforce", async () => {
    const findings = writeCheckRule(await advisorFindings(f.h));
    expect(findings.some((x) => x.id === "sec-permission-write-check-clear")).toBe(false);
  });
});

describe("foldWriteChecks — one span row per request, whatever the request did", () => {
  const entry = (collection: string, action: string, mode = "warn") => ({
    collection,
    action,
    mode,
  });

  test("a bulk import that misses the same condition 5,000 times folds to one", () => {
    const many = Array.from({ length: 5000 }, () => entry("tickets", "create"));
    expect(foldWriteChecks(many)).toEqual(["tickets:create:warn"]);
  });

  test("distinct collection/action/mode triples all survive", () => {
    expect(
      foldWriteChecks([
        entry("tickets", "create"),
        entry("tickets", "update"),
        entry("notes", "create"),
        entry("tickets", "create", "enforce"),
      ]),
    ).toEqual([
      "tickets:create:warn",
      "tickets:update:warn",
      "notes:create:warn",
      "tickets:create:enforce",
    ]);
  });

  test("the cap holds, because one span row must stay one span row", () => {
    const wide = Array.from({ length: 40 }, (_, i) => entry(`c${i}`, "create"));
    expect(foldWriteChecks(wide)).toHaveLength(8);
    expect(foldWriteChecks(wide, 2)).toHaveLength(2);
  });

  test("nothing recorded is an empty list, not a null attribute", () => {
    expect(foldWriteChecks(undefined)).toEqual([]);
    expect(foldWriteChecks([])).toEqual([]);
  });
});
