/**
 * Postgres coverage for invite reminders.
 *
 * Three things here are written per dialect and therefore cannot be proved by
 * the SQLite suite: the JOIN that resolves a reminder's link back to the invite
 * it belongs to, the `IN (…)` + `reminder_count + 1` update that stamps a whole
 * batch at once, and the timestamps those write — a `Date` on Postgres and a
 * number on SQLite. A reminder link that fails to resolve here means an invited
 * person clicking the mail we just sent them is turned away, on the only
 * dialect a production workspace is likely to run.
 *
 * Follows `form-drafts-pg.test.ts`: pglite's WASM bundle is
 * environment-sensitive, so a harness that fails to boot degrades to a logged
 * skip rather than a red gate that says nothing about this code.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { makeHarnessPg, type PgTestHarness } from "./setup-pg";
import { PGLITE_BOOT_TIMEOUT_MS, PGLITE_TEST_TIMEOUT_MS } from "./setup";

let setupError: Error | undefined;
let harness: PgTestHarness | undefined;
let formId = "";
let formToken = "";
const slug = `pg_invite_${Date.now()}`;

const post = async (path: string, body: unknown) =>
  harness!.fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

/** Unauthenticated — the public form endpoints have no session. */
const publicFetch = (path: string, init?: RequestInit) =>
  harness!.app.fetch(new Request(`${harness!.env.APP_URL}${path}`, init));

const submit = (data: Record<string, unknown>, invite: string) =>
  publicFetch(`/api/public/forms/${formToken}/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data, invite }),
  });

beforeAll(async () => {
  try {
    harness = await makeHarnessPg();
  } catch (err) {
    setupError = err instanceof Error ? err : new Error(String(err));
    console.warn(
      "[form-invites-pg] harness setup failed — skipping pg path tests:",
      setupError.message,
    );
    return;
  }
  const signUp = await post("/api/auth/sign-up/email", {
    email: `pg-invites-${Date.now()}@example.test`,
    password: "correct-horse-battery",
    name: "A",
  });
  if (!signUp.ok) throw new Error(`sign-up failed: ${signUp.status}`);

  const created = await post("/api/collections", {
    slug,
    fields: [{ name: "answer", type: "text" }],
  });
  if (created.status !== 201) throw new Error(`collection failed: ${created.status}`);

  const form = await post("/api/admin/forms", {
    name: "Staff survey",
    collection: slug,
    fields: [{ name: "answer" }],
    settings: { inviteOnly: true },
  });
  if (form.status !== 201) throw new Error(`form failed: ${form.status}`);
  const body = (await form.json()) as { data: { form: { id: string }; token: string } };
  formId = body.data.form.id;
  formToken = body.data.token;
}, PGLITE_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await harness?.cleanup();
}, PGLITE_BOOT_TIMEOUT_MS);

const skipped = (): boolean => {
  if (setupError || !harness) {
    expect(setupError).toBeDefined();
    return true;
  }
  return false;
};

test("pg: a reminder's link resolves to the invite, and spends the same turn", async () => {
  if (skipped()) return;
  const minted = await post(`/api/admin/forms/${formId}/invites`, {
    recipients: [{ email: "ada@example.test" }, { email: "grace@example.test" }],
    formToken,
  });
  expect(minted.status).toBe(201);
  const first = ((await minted.json()) as {
    data: { invites: { id: string; token: string }[] };
  }).data.invites;

  const nudged = await post(`/api/admin/forms/${formId}/invites/remind`, {
    formToken,
    force: true,
  });
  expect(nudged.status).toBe(200);
  const reminded = ((await nudged.json()) as {
    data: { invites: { id: string; token: string }[]; skipped: number };
  }).data.invites;
  expect(reminded.length).toBe(2);

  // The JOIN: a link minted by the reminder has to find its invite.
  const def = await publicFetch(`/api/public/forms/${formToken}?i=${reminded[0]!.token}`);
  expect(((await def.json()) as { data: { closed: unknown } }).data.closed).toBeNull();

  // One turn, two links: answering with the reminder's spends the original's.
  expect((await submit({ answer: "via the reminder" }, reminded[0]!.token)).status).toBe(201);
  expect((await submit({ answer: "via the first mail" }, first[0]!.token)).status).toBe(410);

  // The batch update: both rows were stamped, and the counter went up by one.
  const list = await harness!.fetch(`/api/admin/forms/${formId}/invites`);
  const rows = ((await list.json()) as {
    data: { id: string; remindedAt: unknown; reminderCount: number }[];
  }).data;
  expect(rows.length).toBe(2);
  for (const row of rows) {
    expect(row.reminderCount).toBe(1);
    expect(row.remindedAt).not.toBeNull();
  }
}, PGLITE_TEST_TIMEOUT_MS);
