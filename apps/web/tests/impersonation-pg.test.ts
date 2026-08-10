/**
 * Postgres coverage for captcha + impersonation.
 *
 * Three things here are written per dialect and the SQLite suite cannot vouch
 * for any of them: the `impersonations` migration (timestamptz vs epoch-ms,
 * boolean vs 0/1), the expiry comparison that decides whether a token still
 * works — a `Date` here and a number there — and the `activity.impersonated_by`
 * column the audit query reads.
 *
 * Follows `auth-hooks-pg.test.ts`: pglite's WASM bundle is environment-
 * sensitive, so a harness that fails to boot degrades to a logged skip.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { makeHarnessPg, type PgTestHarness } from "./setup-pg";
import { PGLITE_BOOT_TIMEOUT_MS } from "./setup";

let setupError: Error | undefined;
let harness: PgTestHarness | undefined;
let subjectId = "";

const JSON_HEADERS = { "Content-Type": "application/json" };

const post = (path: string, body?: unknown, method = "POST") =>
  harness!.fetch(path, {
    method,
    headers: JSON_HEADERS,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

beforeAll(async () => {
  try {
    harness = await makeHarnessPg();
  } catch (err) {
    setupError = err instanceof Error ? err : new Error(String(err));
    console.warn("[impersonation-pg] harness setup failed — skipping:", setupError.message);
    return;
  }
  const signUp = await post("/api/auth/sign-up/email", {
    email: `pg-imp-${Date.now()}@example.test`,
    password: "correct-horse-battery",
    name: "A",
  });
  if (!signUp.ok) throw new Error(`sign-up failed: ${signUp.status}`);

  const appUser = await post("/api/t/default/auth/sign-up/email", {
    email: "pg-subject@example.test",
    password: "correct-horse-battery",
    name: "Sub",
  });
  if (!appUser.ok) throw new Error(`app sign-up failed: ${appUser.status}`);
  const rows = await harness.exec(
    `SELECT id FROM app_users WHERE email = 'pg-subject@example.test'`,
  );
  subjectId = rows[0]!.id as string;
}, PGLITE_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await harness?.cleanup();
});

test("the captcha column round-trips a config on Postgres", async () => {
  if (!harness) return;
  const saved = await post(
    "/api/admin/captcha",
    {
      provider: "hcaptcha",
      siteKey: "pg-site",
      secretKey: "pg-secret",
      protect: ["sign-up", "forms"],
      onError: "deny",
    },
    "PUT",
  );
  expect(saved.status).toBe(200);
  const read = (await (await harness.fetch("/api/admin/captcha")).json()) as any;
  // `jsonb` here, TEXT on the SQLite twin — a round trip is the only thing
  // that proves the column type and the reader agree.
  expect(read.data.provider).toBe("hcaptcha");
  expect(read.data.protect).toEqual(["sign-up", "forms"]);
  expect(read.data.hasSecret).toBe(true);
  expect(JSON.stringify(read)).not.toContain("pg-secret");
});

test("an impersonation round-trips, and its expiry is compared correctly", async () => {
  if (!harness) return;
  const started = await post("/api/admin/impersonation", {
    subjectUserId: subjectId,
    reason: "pg round trip",
    minutes: 60,
  });
  expect(started.status).toBe(201);
  const body = (await started.json()) as { data: { id: string; readOnly: boolean } };
  expect(body.data.readOnly).toBe(true);

  const listed = (await (await harness.fetch("/api/admin/impersonation")).json()) as any;
  expect(listed.data[0].active).toBe(true);

  // Age the ROW past its expiry. On pg this is a timestamptz comparison; on
  // SQLite an integer one, and a `Date` bound against the wrong one is the
  // exact class that shipped a broken timestamp filter here once already.
  await harness.exec(
    `UPDATE impersonations SET expires_at = now() - interval '1 minute' WHERE id = '${body.data.id}'`,
  );
  const after = (await (await harness.fetch("/api/admin/impersonation")).json()) as any;
  expect(after.data[0].active).toBe(false);
});

test("ending one writes `ended_at` as a timestamptz", async () => {
  if (!harness) return;
  const started = (await (
    await post("/api/admin/impersonation", {
      subjectUserId: subjectId,
      reason: "pg end",
    })
  ).json()) as { data: { id: string } };
  const ended = await post(`/api/admin/impersonation/${started.data.id}/end`);
  expect(ended.status).toBe(200);
  const rows = await harness.exec(
    `SELECT ended_at FROM impersonations WHERE id = '${started.data.id}'`,
  );
  expect(rows[0]!.ended_at).not.toBeNull();
});

test("the activity audit column exists and is indexed", async () => {
  if (!harness) return;
  const cols = await harness.exec(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'activity' AND column_name = 'impersonated_by'`,
  );
  expect(cols.length).toBe(1);
  const idx = await harness.exec(
    `SELECT indexname FROM pg_indexes WHERE tablename = 'activity' AND indexname = 'activity_impersonated_idx'`,
  );
  // The column exists so the question can be QUERIED; the index is what keeps
  // that query from scanning the whole audit log.
  expect(idx.length).toBe(1);
});
