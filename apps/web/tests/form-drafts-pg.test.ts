/**
 * Postgres coverage for saved form progress.
 *
 * Two things here are written per dialect and therefore cannot be proved by the
 * SQLite suite: the upsert that makes a second save replace the first
 * (`ON CONFLICT (form_id, key_hash)`), and the sweep's comparison against
 * `updated_at`, whose bound value is a `Date` on Postgres and a number on
 * SQLite. Either one failing to parse is invisible in the SQLite suite and
 * breaks every save on the only dialect a production workspace is likely to run.
 *
 * Follows `forms-results-pg.test.ts`: pglite's WASM bundle is
 * environment-sensitive, so a harness that fails to boot degrades to a logged
 * skip rather than a red gate that says nothing about this code.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { makeHarnessPg, type PgTestHarness } from "./setup-pg";
import { PGLITE_BOOT_TIMEOUT_MS, PGLITE_TEST_TIMEOUT_MS } from "./setup";

let setupError: Error | undefined;
let harness: PgTestHarness | undefined;
let formToken = "";
const slug = `pg_draft_${Date.now()}`;

const post = async (path: string, body: unknown) =>
  harness!.fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

/** Unauthenticated call — the draft endpoints are public, and the harness's
 *  own `fetch` carries the admin session cookie. */
const publicFetch = (path: string, init?: RequestInit) =>
  harness!.app.fetch(new Request(`${harness!.env.APP_URL}${path}`, init));

const saveDraft = (body: unknown, cookie?: string) =>
  publicFetch(`/api/public/forms/${formToken}/draft`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });

const definition = async (cookie?: string) => {
  const res = await publicFetch(
    `/api/public/forms/${formToken}`,
    cookie ? { headers: { cookie } } : undefined,
  );
  return (await res.json()) as {
    data?: { draft: { data: Record<string, unknown>; step: number } | null };
  };
};

beforeAll(async () => {
  try {
    harness = await makeHarnessPg();
  } catch (err) {
    setupError = err instanceof Error ? err : new Error(String(err));
    console.warn(
      "[form-drafts-pg] harness setup failed — skipping pg path tests:",
      setupError.message,
    );
    return;
  }
  const signUp = await post("/api/auth/sign-up/email", {
    email: `pg-drafts-${Date.now()}@example.test`,
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
    name: "Long survey",
    collection: slug,
    fields: [{ name: "answer" }],
    settings: { saveProgress: true },
  });
  if (form.status !== 201) throw new Error(`form failed: ${form.status}`);
  formToken = ((await form.json()) as { data: { token: string } }).data.token;
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

test("pg: a second save replaces the draft rather than forking it", async () => {
  if (skipped()) return;
  const first = await saveDraft({ data: { answer: "one" }, step: 0 });
  expect(first.status).toBe(200);
  const cookie = (first.headers.get("set-cookie") ?? "").split(";")[0]!;
  expect(cookie).toContain("blx_fp_");

  const second = await saveDraft({ data: { answer: "two" }, step: 1 }, cookie);
  expect(second.status).toBe(200);

  // One row, the newer one — a failed ON CONFLICT target would either error
  // here or leave two rows and resume from whichever came back first.
  const back = await definition(cookie);
  expect(back.data?.draft?.data).toEqual({ answer: "two" });
  expect(back.data?.draft?.step).toBe(1);
}, PGLITE_TEST_TIMEOUT_MS);

test("pg: the stale sweep's timestamp comparison parses", async () => {
  if (skipped()) return;
  const { buildContext } = await import("../src/server/context");
  const { sweepStaleFormDrafts } = await import("../src/server/services/form-drafts");
  const ctx = (await buildContext(harness!.env)) as any;
  // Nothing is stale yet, so the assertion is that it RUNS: the bound value is
  // a Date here and a number on SQLite, and only one of those parses.
  await sweepStaleFormDrafts(ctx);

  const fresh = await saveDraft({ data: { answer: "kept" }, step: 0 });
  const cookie = (fresh.headers.get("set-cookie") ?? "").split(";")[0]!;
  await sweepStaleFormDrafts(ctx);
  expect((await definition(cookie)).data?.draft?.data).toEqual({ answer: "kept" });
}, PGLITE_TEST_TIMEOUT_MS);
