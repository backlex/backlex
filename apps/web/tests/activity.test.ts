/**
 * Activity log endpoint tests (`GET /api/activity`).
 *
 * Two things are covered here, and they used to be one.
 *
 * The first is the filter surface added when "Logs" and "Activity log" were
 * merged into one admin page: the `action` prefix filter, the `from`/`to` time
 * window, `meta=count`, `limit`/`offset` paging, and the per-user scoping a
 * non-admin gets.
 *
 * The second is WORKSPACE scoping, which this handler did not have at all. Its
 * only isolation was `eq(userId)` for non-admins — per-user, never
 * per-workspace — while `auth.tenantId` sat unused on the context. Any
 * workspace admin (a role `POST /api/tenants` hands out to whoever clicks "New
 * workspace") therefore read every other workspace's item payloads, response
 * bodies, invitee addresses and client IPs, and `?collection=` / `?action=` /
 * `?from=` turned that into targeted search rather than merely a dump. The
 * route now pushes a tenant predicate unconditionally, and the block below
 * named "activity: workspace isolation" is the regression that change exists
 * for.
 *
 * Rows are inserted straight into the `activity` table via the admin SQL
 * console so `created_at` and `tenant_id` are deterministic — `created_at` is a
 * `timestamp_ms` integer column on SQLite, so raw epoch ms is the on-disk
 * format. Every fixture row now carries an explicit `tenant_id`: leaving it
 * NULL made the filter tests pass through the operator's `tenant_id IS NULL`
 * arm rather than the ordinary workspace-scoped path they mean to exercise.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import { buildTwoPlaneCast, type Caller, type TwoPlaneCast } from "./fixtures/two-plane-cast";

const JSON_HEADERS = { "Content-Type": "application/json" };

interface ApiActivity {
  id: string;
  userId: string | null;
  tenantId: string | null;
  action: string;
  collection: string | null;
  itemId: string | null;
  createdAt: unknown;
}

interface ActivityResponse {
  data: ApiActivity[];
  limit: number;
  offset: number;
  meta?: { count: number };
}

interface ErrorBody {
  error: { code: string; message: string };
}

/** A reference instant so `from`/`to` windows are stable across the suite. */
const T0 = Date.UTC(2026, 0, 1, 12, 0, 0); // 2026-01-01T12:00:00Z
const HOUR = 60 * 60 * 1000;

const sqlEscape = (s: string) => s.replace(/'/g, "''");
const sqlText = (s: string | null) => (s === null ? "NULL" : `'${sqlEscape(s)}'`);

/**
 * Insert one activity row with an explicit `created_at` (epoch ms) and
 * `tenant_id`.
 *
 * Takes a caller rather than the harness because the SQL console is
 * `requireOperatorMw`-gated, so under the two-plane cast the writer has to be
 * the operator's caller specifically — a workspace admin is refused there, by
 * design and for the same reason this file's new tests exist.
 */
const insertRow = (
  call: Caller,
  row: {
    id: string;
    tenantId: string | null;
    userId: string | null;
    action: string;
    collection: string;
    createdAt: number;
  },
) =>
  call("/api/admin/db/sql/run?writes=1", {
    method: "POST",
    headers: { ...JSON_HEADERS, "x-backlex-confirm": "yes" },
    body: JSON.stringify({
      sql:
        "INSERT INTO activity (id, tenant_id, user_id, action, collection, created_at) VALUES (" +
        `${sqlText(row.id)}, ` +
        `${sqlText(row.tenantId)}, ` +
        `${sqlText(row.userId)}, ` +
        `${sqlText(row.action)}, ` +
        `${sqlText(row.collection)}, ` +
        `${row.createdAt})`,
    }),
  });

const seedRow = async (call: Caller, row: Parameters<typeof insertRow>[1]): Promise<void> => {
  const res = await insertRow(call, row);
  expect(res.status, `seed activity row ${row.id}`).toBe(200);
};

const activityUrl = (qs: Record<string, string | number>): string => {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(qs)) params.set(k, String(v));
  return `/api/activity?${params.toString()}`;
};

/** Raw call — for the tests that assert on a refusal rather than a payload. */
const getActivity = (call: Caller, qs: Record<string, string | number>): Promise<Response> =>
  call(activityUrl(qs));

const listActivity = async (
  call: Caller,
  qs: Record<string, string | number>,
): Promise<ActivityResponse> => {
  const res = await getActivity(call, qs);
  expect(res.status).toBe(200);
  return (await res.json()) as ActivityResponse;
};

/** Pin every request from `call` to one workspace, the way the admin SPA does
 *  when the workspace switcher is set. The header beats the cookie in
 *  `tenantMiddleware`, so this is stable regardless of who signed in last. */
const inWorkspace =
  (call: Caller, slug: string): Caller =>
  (path, init = {}) =>
    call(path, {
      ...init,
      headers: {
        ...((init.headers as Record<string, string> | undefined) ?? {}),
        "X-Backlex-Tenant": slug,
      },
    });

/** The workspace the harness's seeded admin is active in. */
const defaultTenantId = async (h: TestHarness): Promise<string> => {
  const res = await h.fetch("/api/tenants");
  expect(res.status).toBe(200);
  const { data } = (await res.json()) as { data: { id: string; slug: string }[] };
  const row = data.find((t) => t.slug === "default");
  expect(row, "the default workspace should exist after the first signup").toBeDefined();
  return row!.id;
};

describe("activity: admin filters", () => {
  let h: TestHarness;
  let tenantId: string;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    // Every fixture row is stamped with the workspace the caller is actually
    // active in, so these filters run down the ordinary workspace-scoped path.
    // Left NULL they would only be visible through the operator's
    // `tenant_id IS NULL` arm — green, but exercising the instance trail
    // instead of the filter under test.
    tenantId = await defaultTenantId(h);

    // 5 item.* rows, one per hour from T0..T0+4h.
    for (let i = 0; i < 5; i++) {
      await seedRow(h.fetch, {
        id: `item-${i}`,
        tenantId,
        userId: "admin-self",
        action: "item.create",
        collection: "posts",
        createdAt: T0 + i * HOUR,
      });
    }
    // 3 auth.* rows at T0+1h, T0+2h, T0+3h.
    for (let i = 0; i < 3; i++) {
      await seedRow(h.fetch, {
        id: `auth-${i}`,
        tenantId,
        userId: "admin-self",
        action: "auth.login",
        collection: "system_users",
        createdAt: T0 + (i + 1) * HOUR,
      });
    }
  });

  afterAll(() => h.cleanup());

  test("the seeded rows really are workspace-scoped", async () => {
    // The guard for everything below: if the fixtures had landed with a NULL
    // `tenant_id` these filters would still pass, but through the operator's
    // instance arm rather than the workspace predicate. Assert the shape the
    // rest of this block depends on before depending on it.
    const all = await listActivity(h.fetch, { action: "item", limit: 200 });
    const seeded = all.data.filter((r) => r.id.startsWith("item-"));
    expect(seeded.length).toBe(5);
    for (const r of seeded) expect(r.tenantId).toBe(tenantId);
  });

  test("action prefix filter returns only the matching namespace", async () => {
    const items = await listActivity(h.fetch, { action: "item", limit: 200 });
    const itemRows = items.data.filter((r) => r.id.startsWith("item-"));
    const authRows = items.data.filter((r) => r.id.startsWith("auth-"));
    expect(itemRows.length).toBe(5);
    expect(authRows.length).toBe(0);
    for (const r of items.data.filter((x) => x.action !== "request.error")) {
      // Sanity: every returned action starts with the prefix.
      if (r.id.startsWith("item-") || r.id.startsWith("auth-")) {
        expect(r.action.startsWith("item")).toBe(true);
      }
    }

    const auth = await listActivity(h.fetch, { action: "auth", limit: 200 });
    expect(auth.data.filter((r) => r.id.startsWith("auth-")).length).toBe(3);
    expect(auth.data.filter((r) => r.id.startsWith("item-")).length).toBe(0);
  });

  test("from/to time window excludes rows outside the window", async () => {
    // Window [T0+1h, T0+3h] — should catch item rows at +1h,+2h,+3h (3) and
    // auth rows at +1h,+2h,+3h (3) = 6 of the 8 seeded rows.
    const win = await listActivity(h.fetch, {
      from: T0 + HOUR,
      to: T0 + 3 * HOUR,
      limit: 200,
    });
    const seeded = win.data.filter(
      (r) => r.id.startsWith("item-") || r.id.startsWith("auth-"),
    );
    expect(seeded.length).toBe(6);

    // `from` excludes the earliest (T0) item row.
    const fromOnly = await listActivity(h.fetch, { from: T0 + HOUR, limit: 200 });
    expect(fromOnly.data.some((r) => r.id === "item-0")).toBe(false);

    // `to` excludes the latest (T0+4h) item row.
    const toOnly = await listActivity(h.fetch, { to: T0 + 3 * HOUR, limit: 200 });
    expect(toOnly.data.some((r) => r.id === "item-4")).toBe(false);
  });

  test("meta=count returns the total ignoring limit/offset", async () => {
    const res = await listActivity(h.fetch, { action: "item", limit: 2, meta: "count" });
    expect(res.data.length).toBe(2); // page is clipped by limit
    expect(res.meta?.count).toBe(5); // count is the full filtered total

    // Combined filter: count must reflect the same WHERE as the page.
    const windowed = await listActivity(h.fetch, {
      action: "item",
      from: T0 + HOUR,
      to: T0 + 3 * HOUR,
      limit: 1,
      meta: "count",
    });
    expect(windowed.meta?.count).toBe(3);
  });

  test("limit/offset paginate through the result set", async () => {
    const page1 = await listActivity(h.fetch, { action: "item", limit: 2, offset: 0 });
    const page2 = await listActivity(h.fetch, { action: "item", limit: 2, offset: 2 });
    const page3 = await listActivity(h.fetch, { action: "item", limit: 2, offset: 4 });
    expect(page1.data.length).toBe(2);
    expect(page2.data.length).toBe(2);
    expect(page3.data.length).toBe(1);
    const ids = new Set([
      ...page1.data.map((r) => r.id),
      ...page2.data.map((r) => r.id),
      ...page3.data.map((r) => r.id),
    ]);
    // 5 distinct item rows, no overlap between pages.
    expect(ids.size).toBe(5);
  });
});

describe("activity: non-admin sees only their own rows", () => {
  let h: TestHarness;
  let tenantId: string;
  let plainUserId: string;

  beforeAll(async () => {
    h = makeHarness();
    const admin = await seedAdmin(h); // first user → admin
    tenantId = await defaultTenantId(h);

    // Second user — lands in `default` as `authenticated`, not admin.
    const email = `user-${Date.now()}@example.test`;
    const su = await h.fetch("/api/auth/sign-up/email", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ email, password: "correct-horse-battery", name: "Plain User" }),
    });
    expect(su.status).toBe(200);
    const me = await h.fetch("/api/me");
    expect(me.status).toBe(200);
    plainUserId = ((await me.json()) as { data: { id: string } }).data.id;

    // Both fixture rows live in the SAME workspace as the non-admin caller, so
    // the only thing that can separate them is the per-user predicate. A
    // foreign-workspace row would be hidden by the tenant predicate as well,
    // and the assertion below would no longer say anything about `eq(userId)`.
    // Writing them needs the admin back in the cookie jar — the SQL console is
    // not reachable as the plain user.
    const asAdmin = await h.fetch("/api/auth/sign-in/email", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ email: admin.email, password: admin.password }),
    });
    expect(asAdmin.status).toBe(200);
    await seedRow(h.fetch, {
      id: "admin-row",
      tenantId,
      userId: "someone-else",
      action: "item.create",
      collection: "posts",
      createdAt: T0,
    });
    await seedRow(h.fetch, {
      id: "own-row",
      tenantId,
      userId: plainUserId,
      action: "item.create",
      collection: "posts",
      createdAt: T0 + HOUR,
    });

    // Back to the non-admin, who is the caller under test.
    const back = await h.fetch("/api/auth/sign-in/email", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ email, password: "correct-horse-battery" }),
    });
    expect(back.status).toBe(200);
  });

  afterAll(() => h.cleanup());

  test("a non-admin's listing omits rows owned by other users", async () => {
    const body = await listActivity(h.fetch, { limit: 200 });
    // Positive first, so the absence below cannot be vacuous: their own row in
    // this workspace IS returned.
    expect(body.data.some((r) => r.id === "own-row")).toBe(true);
    // `admin-row` sits in the same workspace but belongs to "someone-else".
    expect(body.data.some((r) => r.id === "admin-row")).toBe(false);
    // Every row the non-admin sees is scoped to their own user id.
    for (const r of body.data) {
      expect(r.userId).toBe(plainUserId);
    }
  });
});

/**
 * The regression the workspace predicate exists for.
 *
 * Before it, `GET /api/activity` was the widest cross-workspace read on the
 * control plane: a workspace admin — the role every `POST /api/tenants` caller
 * gets for free in the workspace they just minted — could page through every
 * other workspace's audit trail, payloads and response bodies included.
 *
 * The cast gives two workspaces that do not overlap (`default` is useless as a
 * victim, since every signup is a member of it), plus an operator who is admin
 * of `default` and therefore the only identity `isInstanceOperator` recognises.
 */
describe("activity: workspace isolation", () => {
  let cast: TwoPlaneCast;
  /** A collection name only this spec's fixture rows use, so counts are exact. */
  const COLL = "iso_posts";

  /** ownerB, pinned to workspace B — a workspace admin, and nothing more. */
  let inB: Caller;
  /** The operator, pinned to `default` — their ordinary Logs page. */
  let inDefault: Caller;

  beforeAll(async () => {
    cast = await buildTwoPlaneCast();
    inB = inWorkspace(cast.ownerB.fetch, cast.tenantB.slug);
    inDefault = inWorkspace(cast.operator.fetch, cast.defaultTenant.slug);

    const write = cast.operator.fetch; // the SQL console is operator-only

    // Workspace A — the workspace ownerB has no business seeing.
    await seedRow(write, {
      id: "a-own",
      tenantId: cast.tenantA.id,
      userId: cast.ownerA.userId,
      action: "item.create",
      collection: COLL,
      createdAt: T0,
    });
    // Deliberately stamped with ownerB's OWN user id. The handler's older
    // isolation was `eq(userId)`, so a row in workspace A owned by ownerA would
    // be hidden from ownerB by that per-user filter too and the assertion would
    // prove nothing about workspace scoping. Owned by ownerB, the tenant
    // predicate is the only thing that can keep it out of their listing.
    await seedRow(write, {
      id: "a-foreign-user",
      tenantId: cast.tenantA.id,
      userId: cast.ownerB.userId,
      action: "item.create",
      collection: COLL,
      createdAt: T0 + HOUR,
    });

    // Workspace B — ownerB's own.
    await seedRow(write, {
      id: "b-own",
      tenantId: cast.tenantB.id,
      userId: cast.ownerB.userId,
      action: "item.create",
      collection: COLL,
      createdAt: T0 + 2 * HOUR,
    });
    // Owned by someone else inside B. ownerB is `admin` there, so no per-user
    // filter applies and this row must come back — which is what proves the
    // absences above are the tenant predicate at work rather than `eq(userId)`
    // quietly doing all the filtering.
    await seedRow(write, {
      id: "b-other-user",
      tenantId: cast.tenantB.id,
      userId: cast.ownerA.userId,
      action: "item.create",
      collection: COLL,
      createdAt: T0 + 3 * HOUR,
    });

    // The instance's pre-auth security trail: `lib/auth-rate-limit.ts` writes
    // `auth.rate_limited` with the attempted address and source IP before any
    // workspace is known, so the row has no `tenant_id` and no `user_id`.
    await seedRow(write, {
      id: "instance-trail",
      tenantId: null,
      userId: null,
      action: "auth.rate_limited",
      collection: "system_users",
      createdAt: T0 + 4 * HOUR,
    });
  });

  afterAll(() => cast.cleanup());

  test("a workspace admin reads their own workspace and none of the other's", async () => {
    const body = await listActivity(inB, { collection: COLL, limit: 200 });
    const ids = body.data.map((r) => r.id);

    // Positive side: both of workspace B's rows come back, including the one
    // owned by another user — so ownerB really is an admin here and really is
    // reading the collection the fixtures wrote to.
    expect(ids).toContain("b-own");
    expect(ids).toContain("b-other-user");

    // The zero this whole change is about.
    expect(ids).not.toContain("a-own");
    expect(ids).not.toContain("a-foreign-user");

    // And nothing at all leaks in from outside workspace B, named rows or not.
    for (const r of body.data) expect(r.tenantId).toBe(cast.tenantB.id);
  });

  test("the operator's default view is workspace-scoped too", async () => {
    // The operator is privileged, not unscoped: their ordinary Logs page shows
    // `default` plus the instance's own unscoped trail, and neither A nor B.
    const body = await listActivity(inDefault, { collection: COLL, limit: 200 });
    const ids = body.data.map((r) => r.id);
    expect(ids).not.toContain("a-own");
    expect(ids).not.toContain("b-own");
    for (const r of body.data) {
      expect(r.tenantId === cast.defaultTenant.id || r.tenantId === null).toBe(true);
    }
  });

  test("scope=instance gives the operator every workspace at once", async () => {
    // Pinned to `default` on purpose. `scope=instance` drops the workspace
    // predicate, but the older `eq(userId)` narrowing for non-admins still keys
    // off the roles the caller holds in the ACTIVE workspace — and the operator
    // holds none inside A or B, reaching them through the cross-workspace
    // shortcut rather than a role. So an operator whose switcher happens to sit
    // on someone else's workspace gets an instance-wide query narrowed to their
    // own rows. Narrower, never wider, so it is not a leak; it is still a
    // surprise, and this spec asserts the shape an operator actually uses.
    const body = await listActivity(inDefault, {
      scope: "instance",
      collection: COLL,
      limit: 200,
    });
    const ids = body.data.map((r) => r.id);
    // All four rows exist and are reachable — which is what makes the zeros in
    // the test above a scoping result rather than an empty database.
    expect(ids).toContain("a-own");
    expect(ids).toContain("a-foreign-user");
    expect(ids).toContain("b-own");
    expect(ids).toContain("b-other-user");
  });

  test("scope=instance REFUSES a non-operator instead of downgrading them", async () => {
    // Control: the same caller's default view is a plain 200, so the refusal
    // below is about the scope they asked for and not about the route.
    const ok = await getActivity(inB, { collection: COLL, limit: 200 });
    expect(ok.status).toBe(200);

    const res = await getActivity(inB, { scope: "instance", collection: COLL, limit: 200 });
    // A silent downgrade to the workspace view would read to the caller as
    // "there is nothing there" — an honest 403 is the contract.
    expect(res.status).toBe(403);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("FORBIDDEN");
    expect(body.error.message).toContain("operator-only");
  });

  test("the NULL-tenant instance trail is the operator's alone", async () => {
    // The operator's DEFAULT view (no `scope` param) includes it: nobody owns
    // these rows at the workspace level, and the instance operator is who they
    // are for.
    const mine = await listActivity(inDefault, { action: "auth.rate_limited", limit: 200 });
    expect(mine.data.some((r) => r.id === "instance-trail")).toBe(true);

    // A workspace admin never sees it. Asserted alongside a row they DO see, so
    // the absence cannot come from an empty result set: the unconditional
    // `or(isNull(tenantId))` this route deliberately avoids would have left the
    // brute-force trail — attempted addresses and client IPs — readable by
    // every self-made workspace admin.
    const theirs = await listActivity(inB, { limit: 200 });
    expect(theirs.data.some((r) => r.id === "b-own")).toBe(true);
    expect(theirs.data.some((r) => r.id === "instance-trail")).toBe(false);
    for (const r of theirs.data) expect(r.tenantId).toBe(cast.tenantB.id);
  });

  test("meta=count is scoped identically to the page", async () => {
    // The count query reuses the same `where`, so a leak here would hand a
    // workspace admin the instance-wide total even with the rows themselves
    // withheld — enough on its own to tell them how busy every other workspace
    // is.
    const theirs = await listActivity(inB, { collection: COLL, limit: 200, meta: "count" });
    expect(theirs.data.length).toBe(2);
    expect(theirs.meta?.count).toBe(2);

    // The honest total, for contrast: four rows carry this collection. Pinned
    // to `default` for the reason spelled out on the instance-scope test above.
    const all = await listActivity(inDefault, {
      scope: "instance",
      collection: COLL,
      limit: 200,
      meta: "count",
    });
    expect(all.meta?.count).toBe(4);
  });
});
