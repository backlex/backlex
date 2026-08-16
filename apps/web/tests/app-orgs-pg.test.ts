/**
 * Postgres coverage for `roles.org_assignable`.
 *
 * Two things here are spelled per dialect and the SQLite suite cannot catch a
 * regression in either:
 *
 *   1. the migration — `boolean DEFAULT false` against `integer DEFAULT 0`,
 *      plus the backfill subquery over `app_org_member_roles`;
 *   2. the column read — Postgres hands back a real `boolean`, SQLite an
 *      integer that drizzle's `mode: "boolean"` coerces. A guard written as a
 *      truthiness check passes on one and silently opens the gate on the other.
 *
 * Follows `analytics-pg.test.ts`: pglite's WASM bundle is environment-sensitive,
 * so a harness that fails to boot degrades to a logged skip rather than failing
 * the whole suite.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { makeHarnessPgOrFail, type PgTestHarness } from "./setup-pg";
import { PGLITE_BOOT_TIMEOUT_MS, PGLITE_TEST_TIMEOUT_MS } from "./setup";

const JSON_HEADERS = { "content-type": "application/json" };
const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: JSON_HEADERS,
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

let harness: PgTestHarness | undefined;
let orgId = "";
let ownerToken = "";
let memberId = "";
let openRoleId = "";
let staffRoleId = "";

const makeEndUser = async (
  h: PgTestHarness,
  email: string,
): Promise<{ id: string; token: string }> => {
  const invited = await h.fetch("/api/app-users/invite", json("POST", { email }));
  if (invited.status !== 201) throw new Error(`invite failed: ${invited.status}`);
  const { data } = (await invited.json()) as { data: { id: string; token: string } };
  const accepted = await h.app.request(
    "/api/t/default/auth/invite/accept",
    json("POST", { token: data.token, password: "org-pass-12345" }),
  );
  if (accepted.status !== 200) throw new Error(`accept failed: ${accepted.status}`);
  const session = (await accepted.json()) as { token: string };
  return { id: data.id, token: session.token };
};

beforeAll(async () => {
  harness = (await makeHarnessPgOrFail("app-orgs-pg")) ?? undefined;
  if (!harness) return;
  const h = harness;
  const signUp = await h.fetch(
    "/api/auth/sign-up/email",
    json("POST", {
      email: `pg-orgs-${Date.now()}@example.test`,
      password: "correct-horse-battery",
      name: "A",
    }),
  );
  if (!signUp.ok) throw new Error(`sign-up failed: ${signUp.status}`);

  for (const [name, orgAssignable] of [
    ["org_editor", true],
    ["support_staff", false],
  ] as const) {
    const res = await h.fetch(
      "/api/roles",
      json("POST", { name, description: name, orgAssignable }),
    );
    if (res.status !== 201) throw new Error(`role ${name} failed: ${res.status}`);
    const id = ((await res.json()) as { data: { id: string } }).data.id;
    if (orgAssignable) openRoleId = id;
    else staffRoleId = id;
  }

  const owner = await makeEndUser(h, "owner@pg-orgs.test");
  ownerToken = owner.token;
  const member = await makeEndUser(h, "member@pg-orgs.test");
  memberId = member.id;

  const created = await h.fetch(
    "/api/app-orgs",
    json("POST", { name: "PG Grant Co", ownerAppUserId: owner.id }),
  );
  if (created.status !== 201) throw new Error(`org create failed: ${created.status}`);
  orgId = ((await created.json()) as { data: { id: string } }).data.id;
  const added = await h.fetch(
    `/api/app-orgs/${orgId}/members`,
    json("POST", { appUserId: member.id }),
  );
  if (added.status !== 201) throw new Error(`add member failed: ${added.status}`);
}, PGLITE_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await harness?.cleanup();
});

/** Only reachable under `BACKLEX_PG_TESTS=optional` — otherwise a harness that
 *  cannot boot has already failed the run in `beforeAll`. */
const skipped = (): boolean => !harness;

const asOwner = (path: string, init: RequestInit = {}) =>
  harness!.app.request(path, {
    ...init,
    headers: { ...JSON_HEADERS, ...(init.headers ?? {}), Authorization: `Bearer ${ownerToken}` },
  });

test("pg: the flag round-trips as a real boolean", async () => {
  if (skipped()) return;
  const res = await harness!.fetch("/api/roles");
  expect(res.status).toBe(200);
  const { data } = (await res.json()) as {
    data: { id: string; name: string; orgAssignable: unknown }[];
  };
  const open = data.find((r) => r.id === openRoleId);
  const staff = data.find((r) => r.id === staffRoleId);
  // Not truthiness — the point is that Postgres yields `true`/`false` here and
  // a guard reading `0`/`1` would be wrong on exactly one of the two dialects.
  expect(open!.orgAssignable).toBe(true);
  expect(staff!.orgAssignable).toBe(false);
  // Roles that predate the column start closed — the migration adds it with a
  // false default and deliberately backfills nothing.
  expect(data.find((r) => r.name === "authenticated")!.orgAssignable).toBe(false);
}, PGLITE_TEST_TIMEOUT_MS);

test("pg: an org owner is held to the flag, the control plane is not", async () => {
  if (skipped()) return;
  const barred = await asOwner(
    `/api/t/default/orgs/${orgId}/members/${memberId}`,
    json("PATCH", { roleIds: [staffRoleId] }),
  );
  expect(barred.status).toBe(422);
  expect(await barred.text()).toContain("support_staff");

  const allowed = await asOwner(
    `/api/t/default/orgs/${orgId}/members/${memberId}`,
    json("PATCH", { roleIds: [openRoleId] }),
  );
  expect(allowed.status).toBe(200);

  const operator = await harness!.fetch(
    `/api/app-orgs/${orgId}/members/${memberId}`,
    json("PATCH", { roleIds: [staffRoleId] }),
  );
  expect(operator.status).toBe(200);
}, PGLITE_TEST_TIMEOUT_MS);

test("pg: PATCH /api/roles flips the flag", async () => {
  if (skipped()) return;
  const patched = await harness!.fetch(
    `/api/roles/${staffRoleId}`,
    json("PATCH", { orgAssignable: true }),
  );
  expect(patched.status).toBe(200);

  const now = await asOwner(
    `/api/t/default/orgs/${orgId}/members/${memberId}`,
    json("PATCH", { roleIds: [staffRoleId] }),
  );
  expect(now.status).toBe(200);
}, PGLITE_TEST_TIMEOUT_MS);
