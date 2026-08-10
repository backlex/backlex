/**
 * Row-level security against a real Postgres.
 *
 * The compiler test proves the TEXT is right. This one proves the text does
 * what it says: it applies the policies, opens a second identity with `SET
 * ROLE`, and checks which rows come back. Nothing short of that would catch a
 * policy that is syntactically perfect and semantically inverted.
 *
 * The two claims that matter most, both asserted here rather than assumed:
 *
 *   1. **backlex itself is unaffected.** Row security exempts a table's owner
 *      and we do not `FORCE`, so the API's own reads must return exactly what
 *      they returned before the apply. If that were wrong, turning this feature
 *      on would empty every list in the product.
 *   2. **A connection that sets no identity sees nothing.** Not "sees
 *      everything", which is what a fail-open policy or an unreadable claim
 *      would produce.
 *
 * Follows `auth-hooks-pg.test.ts`: pglite's WASM bundle is environment-
 * sensitive, so a harness that fails to boot degrades to a logged skip.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { makeHarnessPg, type PgTestHarness } from "./setup-pg";
import { PGLITE_BOOT_TIMEOUT_MS, PGLITE_TEST_TIMEOUT_MS } from "./setup";

let setupError: Error | undefined;
let harness: PgTestHarness | undefined;

const BASE = "/api/admin/rls";
const JSON_HEADERS = { "Content-Type": "application/json" };

const post = (path: string, body?: unknown, method = "POST") =>
  harness!.fetch(path, {
    method,
    headers: JSON_HEADERS,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

/** Raw SQL against the same database the app is using. */
const raw = (text: string): Promise<any[]> => harness!.exec(text) as Promise<any[]>;

let table = "";
let tenantId = "";

/** Run `body` as the probe role, and get back to the owner whatever happens —
 *  a leaked `SET ROLE` would make every later test fail for the wrong reason. */
const asProbe = async <T>(setup: string[], body: () => Promise<T>): Promise<T> => {
  await raw(`SET ROLE rls_probe`);
  try {
    for (const s of setup) await raw(s);
    return await body();
  } finally {
    await raw(`RESET ROLE`);
    await raw(`RESET backlex.user_id`);
    await raw(`RESET backlex.roles`);
    await raw(`RESET backlex.tenant_id`);
  }
};

beforeAll(async () => {
  try {
    harness = await makeHarnessPg();
  } catch (err) {
    setupError = err instanceof Error ? err : new Error(String(err));
    console.warn("[rls-pg] harness setup failed — skipping:", setupError.message);
    return;
  }
  const signUp = await post("/api/auth/sign-up/email", {
    email: `pg-rls-${Date.now()}@example.test`,
    password: "correct-horse-battery",
    name: "A",
  });
  if (!signUp.ok) throw new Error(`sign-up failed: ${signUp.status}`);

  // A collection with an owner column, and a non-admin role whose read grant
  // is conditioned on it — the shape the whole feature exists for.
  const made = await post("/api/collections", {
    name: "Notes",
    slug: "notes",
    fields: [
      { name: "title", type: "text" },
      // Not `owner_id` — that is a system column the create endpoint reserves.
      // A plain column makes what the policy compares explicit.
      { name: "holder", type: "text" },
    ],
  });
  if (!made.ok) throw new Error(`collection failed: ${made.status} ${await made.text()}`);
  table = ((await made.json()) as any).data.physicalTable as string;

  const role = await post("/api/roles", { name: "reader" });
  const roleId = ((await role.json()) as any).data.id as string;
  const granted = await post(`/api/roles/${roleId}/permissions`, {
    collection: "notes",
    action: "read",
    condition: { holder: { _eq: "$user.id" } },
  });
  if (!granted.ok) throw new Error(`grant failed: ${granted.status} ${await granted.text()}`);

  await post("/api/items/notes", { title: "mine", holder: "u1" });
  await post("/api/items/notes", { title: "theirs", holder: "u2" });

  tenantId = (await raw(`SELECT id FROM tenants LIMIT 1`))[0].id as string;
}, PGLITE_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await harness?.cleanup();
});

test("the plan names the policy it would install", async () => {
  if (!harness) return;
  const plan = (await (await harness.fetch(`${BASE}/plan`)).json()) as any;
  const policy = plan.policies.find((p: any) => p.role === "reader" && p.action === "read");
  expect(policy).toBeTruthy();
  expect(policy.table).toBe(table);
  expect(policy.statements.join("\n")).toContain("backlex.uid()");
}, PGLITE_TEST_TIMEOUT_MS);

test("applying installs the policies and enables row security", async () => {
  if (!harness) return;
  const res = await post(`${BASE}/apply`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  expect(body.applied).toBeGreaterThan(0);

  const policies = await raw(
    `SELECT policyname FROM pg_policies WHERE tablename = '${table}'`,
  );
  expect(policies.length).toBeGreaterThan(0);
  const rls = await raw(
    `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = '${table}'`,
  );
  expect(rls[0].relrowsecurity).toBe(true);
  // NOT forced — forcing would put backlex's own queries behind rules meant
  // for a reporting tool.
  expect(rls[0].relforcerowsecurity).toBe(false);
}, PGLITE_TEST_TIMEOUT_MS);

test("backlex's own reads are unchanged, because the owner is exempt", async () => {
  if (!harness) return;
  const list = (await (await harness.fetch("/api/items/notes")).json()) as any;
  expect(list.data.length).toBe(2);
}, PGLITE_TEST_TIMEOUT_MS);

test("a direct connection with no identity set sees NOTHING", async () => {
  if (!harness) return;
  await raw(`DROP ROLE IF EXISTS rls_probe`);
  await raw(`CREATE ROLE rls_probe`);
  await raw(`GRANT SELECT ON "${table}" TO rls_probe`);

  const anonymous = await asProbe([], () =>
    raw(`SELECT count(*)::int AS n FROM "${table}"`),
  );
  // Not "everything" — which is what a fail-open policy, or a claim helper
  // that treated an unreadable setting as a wildcard, would produce. And not
  // an ERROR either: the helper schema is granted to PUBLIC precisely so a
  // reporting tool gets a narrower result rather than a failed query.
  expect(anonymous[0].n).toBe(0);
}, PGLITE_TEST_TIMEOUT_MS);

test("a direct connection that names an identity sees only its own rows", async () => {
  if (!harness) return;
  const mine = await asProbe(
    [
      `SET backlex.user_id = 'u1'`,
      `SET backlex.roles = 'reader'`,
      `SET backlex.tenant_id = '${tenantId}'`,
    ],
    () => raw(`SELECT title FROM "${table}" ORDER BY title`),
  );
  expect(mine.map((r: any) => r.title)).toEqual(["mine"]);
}, PGLITE_TEST_TIMEOUT_MS);

test("a role the session does not hold grants nothing", async () => {
  if (!harness) return;
  const none = await asProbe(
    [
      `SET backlex.user_id = 'u1'`,
      // The identity is right and the ROLE is wrong — `has_role` is a separate
      // clause from the condition, so this must still be empty.
      `SET backlex.roles = 'someone-else'`,
      `SET backlex.tenant_id = '${tenantId}'`,
    ],
    () => raw(`SELECT count(*)::int AS n FROM "${table}"`),
  );
  expect(none[0].n).toBe(0);
}, PGLITE_TEST_TIMEOUT_MS);

test("status reports drift after a rule changes", async () => {
  if (!harness) return;
  const role = await post("/api/roles", { name: "auditor" });
  const roleId = ((await role.json()) as any).data.id as string;
  await post(`/api/roles/${roleId}/permissions`, { collection: "notes", action: "read" });

  const status = (await (await harness.fetch(`${BASE}/status`)).json()) as any;
  expect(status.supported).toBe(true);
  // The new rule exists in the API and not in the database — which is exactly
  // the state an operator needs to be told about.
  expect(status.missing.length).toBeGreaterThan(0);
}, PGLITE_TEST_TIMEOUT_MS);

test("disable removes the policies and turns row security back off", async () => {
  if (!harness) return;
  const res = (await (await post(`${BASE}/disable`)).json()) as any;
  expect(res.dropped).toBeGreaterThan(0);
  const policies = await raw(`SELECT policyname FROM pg_policies WHERE tablename = '${table}'`);
  expect(policies.length).toBe(0);
  const rls = await raw(`SELECT relrowsecurity FROM pg_class WHERE relname = '${table}'`);
  expect(rls[0].relrowsecurity).toBe(false);
}, PGLITE_TEST_TIMEOUT_MS);
