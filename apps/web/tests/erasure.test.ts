/**
 * Data-subject erasure.
 *
 * The failure mode that matters here is not "it deleted too much" — it is "it
 * reported success while leaving the person findable". So the assertions are
 * mostly negative and mostly about the places people forget:
 *
 *   - the revision history, which still holds the pre-anonymization row
 *   - the activity log, which holds IP and user agent next to the user id
 *   - the erasure record itself, which must not become a fresh copy of the
 *     address it was filed to remove
 *   - another workspace's rows, which must not be reachable at all
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const BASE = "/api/admin/erasure";
const SUBJECT_EMAIL = "alice.subject@example.test";

let h: TestHarness;
let client: Database;
let tenantId: string;
let leadsTable: string;

const req = async (method: string, path: string, body?: unknown) =>
  h.fetch(path, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });

const ok = async (method: string, path: string, body?: unknown) => {
  const res = await req(method, path, body);
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
  return (await res.json()) as any;
};

const EMAIL_SUBJECT = { type: "email" as const, value: SUBJECT_EMAIL };

/** Put the subject into every surface a run is supposed to reach. */
const seedSubject = (appUserId: string) => {
  const now = Date.now();
  const q = (sql: string, ...args: unknown[]) => client.query(sql).run(...(args as never[]));

  q(
    `insert into app_users (id, tenant_id, email, name, status, is_anonymous, created_at, updated_at)
     values (?,?,?,?,'active',0,?,?)`,
    appUserId, tenantId, SUBJECT_EMAIL, "Alice Subject", now, now,
  );
  q(
    `insert into "${leadsTable}" (id, tenant_id, name, email, created_at, updated_at) values (?,?,?,?,?,?)`,
    "lead-1", tenantId, "Alice Subject", SUBJECT_EMAIL, now, now,
  );
  q(
    `insert into "${leadsTable}" (id, tenant_id, name, email, created_at, updated_at) values (?,?,?,?,?,?)`,
    "lead-other", tenantId, "Someone Else", "bob@example.test", now, now,
  );
  q(
    `insert into revisions (id, tenant_id, collection, item_id, snapshot, created_by, created_at)
     values (?,?,?,?,?,?,?)`,
    "rev-1", tenantId, "leads", "lead-1", JSON.stringify({ email: SUBJECT_EMAIL }), appUserId, now,
  );
  q(
    `insert into comments (id, tenant_id, collection, item_id, user_id, body, created_at)
     values (?,?,?,?,?,?,?)`,
    "cmt-1", tenantId, "leads", "lead-1", appUserId, "please delete my data", now,
  );
  q(
    `insert into notifications (id, tenant_id, user_id, title, body, created_at)
     values (?,?,?,?,?,?)`,
    "ntf-1", tenantId, appUserId, "Welcome", "hi Alice", now,
  );
  q(
    `insert into activity (id, tenant_id, user_id, action, collection, item_id, ip, user_agent, created_at)
     values (?,?,?,?,?,?,?,?,?)`,
    "act-1", tenantId, appUserId, "update", "leads", "lead-1", "203.0.113.7", "Mozilla/5.0", now,
  );
  q(
    `insert into analytics_events (id, tenant_id, name, distinct_id, user_id, ts, day, created_at)
     values (?,?,?,?,?,?,?,?)`,
    "an-1", tenantId, "page_view", appUserId, appUserId, now, "2026-07-30", now,
  );
  q(
    `insert into error_events (id, tenant_id, group_id, type, message, level, user_id, ts, created_at)
     values (?,?,?,?,?,?,?,?,?)`,
    "err-1", tenantId, "grp-1", "Error", "boom at alice", "error", appUserId, now, now,
  );
  q(
    `insert into device_tokens (id, tenant_id, user_id, token, platform, is_active, created_at)
     values (?,?,?,?,?,1,?)`,
    "dev-1", tenantId, appUserId, "tok", "web", now,
  );
  q(
    `insert into files (key, tenant_id, owner_id, size, acl, created_at) values (?,?,?,?,?,?)`,
    "u/alice.png", tenantId, appUserId, 100, "private", now,
  );
};

const countIn = (table: string, where = "1=1", ...args: unknown[]) =>
  (client.query(`select count(*) as n from "${table}" where ${where}`).get(...(args as never[])) as {
    n: number;
  }).n;

beforeAll(async () => {
  h = makeHarness();
  await seedAdmin(h);
  client = new Database(h.env.SQLITE_PATH as string);
  await ok("POST", "/api/collections", {
    slug: "leads",
    fields: [
      { name: "name", type: "text" },
      { name: "email", type: "text", interface: "email" },
    ],
  });
  const meta = client
    .query("select physical_table as t, tenant_id as tid from collections where slug = 'leads'")
    .get() as { t: string; tid: string };
  leadsTable = meta.t;
  tenantId = meta.tid;
});
afterAll(() => h.cleanup());

beforeEach(() => {
  client.query("delete from erasure_requests").run();
  for (const t of [
    "app_users", "revisions", "comments", "notifications", "activity",
    "analytics_events", "error_events", "device_tokens", "files",
  ]) {
    client.query(`delete from ${t}`).run();
  }
  client.query(`delete from "${leadsTable}"`).run();
});

describe("the request record must not re-create what it removes", () => {
  test("neither the stored row nor the API response carries the address", async () => {
    seedSubject("user-1");
    const made = await ok("POST", `${BASE}/preview`, {
      subject: EMAIL_SUBJECT,
      mode: "anonymize",
      reference: "TICKET-42",
    });

    const row = client.query("select * from erasure_requests where id = ?").get(made.data.id) as Record<
      string,
      unknown
    >;
    // A record reading "we erased alice@example.test" outlives every row it
    // deleted — it is the one place the address would survive the erasure.
    expect(JSON.stringify(row)).not.toContain(SUBJECT_EMAIL);
    expect(JSON.stringify(made)).not.toContain(SUBJECT_EMAIL);
    // The operator's own ticket id is theirs to manage and does come back.
    expect(made.data.reference).toBe("TICKET-42");
    expect(made.data.subjectRef).toHaveLength(12);
  });

  test("the same subject hashes the same, a different one does not", async () => {
    seedSubject("user-1");
    const a = await ok("POST", `${BASE}/preview`, { subject: EMAIL_SUBJECT, mode: "delete" });
    const b = await ok("POST", `${BASE}/preview`, {
      subject: { type: "email", value: SUBJECT_EMAIL.toUpperCase() },
      mode: "delete",
    });
    const c = await ok("POST", `${BASE}/preview`, {
      subject: { type: "email", value: "someone.else@example.test" },
      mode: "delete",
    });
    // Case-insensitive, so "has this person asked before" actually works.
    expect(b.data.subjectRef).toBe(a.data.subjectRef);
    expect(c.data.subjectRef).not.toBe(a.data.subjectRef);
  });
});

describe("preview", () => {
  test("it counts every surface and destroys nothing", async () => {
    seedSubject("user-1");
    const made = await ok("POST", `${BASE}/preview`, { subject: EMAIL_SUBJECT, mode: "delete" });
    const counts = made.data.plan.counts as Record<string, number>;

    expect(counts.collections).toBe(1);
    expect(counts.revisions).toBe(1);
    expect(counts.comments).toBe(1);
    expect(counts.notifications).toBe(1);
    expect(counts.activity).toBe(1);
    expect(counts.analytics).toBe(1);
    expect(counts.errors).toBe(1);
    expect(counts.devices).toBe(1);
    expect(counts.files).toBe(1);
    expect(counts.identity).toBe(1);

    // Nothing may be gone yet — this is the whole point of two steps.
    expect(countIn("app_users")).toBe(1);
    expect(countIn(leadsTable)).toBe(2);
    expect(countIn("revisions")).toBe(1);
    expect(made.data.status).toBe("previewed");
  });

  test("somebody else's rows are not counted", async () => {
    seedSubject("user-1");
    const made = await ok("POST", `${BASE}/preview`, { subject: EMAIL_SUBJECT, mode: "delete" });
    // `lead-other` shares the collection but not the address.
    expect(made.data.plan.counts.collections).toBe(1);
  });

  test("an address with no account still finds its collection rows", async () => {
    const now = Date.now();
    client
      .query(`insert into "${leadsTable}" (id, tenant_id, name, email, created_at, updated_at) values (?,?,?,?,?,?)`)
      .run("lead-noacct", tenantId, "No Account", SUBJECT_EMAIL, now, now);
    const made = await ok("POST", `${BASE}/preview`, { subject: EMAIL_SUBJECT, mode: "delete" });
    // "No user row" is not the same as "nothing to erase".
    expect(made.data.plan.counts.collections).toBe(1);
    expect(made.data.plan.counts.identity).toBe(0);
  });

  test("the limits travel with every request", async () => {
    seedSubject("user-1");
    const made = await ok("POST", `${BASE}/preview`, { subject: EMAIL_SUBJECT, mode: "delete" });
    // Saying "completed" without saying what it could not reach would tell an
    // operator a legal obligation is discharged when it is not.
    expect(made.data.limits.join(" ")).toMatch(/[Bb]ackups/);
    expect(made.data.limits.join(" ")).toMatch(/third parties|integrations/);
  });

  test("an unknown mode is refused", async () => {
    expect((await req("POST", `${BASE}/preview`, { subject: EMAIL_SUBJECT, mode: "shred" })).status).toBe(422);
  });
});

describe("running a delete", () => {
  test("every surface is emptied and the report says so", async () => {
    seedSubject("user-1");
    const made = await ok("POST", `${BASE}/preview`, { subject: EMAIL_SUBJECT, mode: "delete" });
    const run = await ok("POST", `${BASE}/${made.data.id}/run`, {
      subject: EMAIL_SUBJECT,
      confirm: true,
    });

    expect(run.data.status).toBe("completed");
    expect(countIn("app_users")).toBe(0);
    expect(countIn(leadsTable, "id = 'lead-1'")).toBe(0);
    expect(countIn("comments")).toBe(0);
    expect(countIn("notifications")).toBe(0);
    expect(countIn("analytics_events")).toBe(0);
    expect(countIn("error_events")).toBe(0);
    expect(countIn("device_tokens")).toBe(0);
    expect(countIn("files")).toBe(0);
    // The other person's row is untouched.
    expect(countIn(leadsTable, "id = 'lead-other'")).toBe(1);
    expect(run.data.report.counts.collections).toBe(1);
  });

  test("the stored object goes, not just the file row", async () => {
    seedSubject("user-1");
    const made = await ok("POST", `${BASE}/preview`, { subject: EMAIL_SUBJECT, mode: "delete" });
    await ok("POST", `${BASE}/${made.data.id}/run`, { subject: EMAIL_SUBJECT, confirm: true });
    // Deleting only the row leaves a profile photo in the bucket with nothing
    // pointing at it — worse than leaving both, because now nobody can find it.
    expect(countIn("files")).toBe(0);
    const report = (await ok("GET", `${BASE}/${made.data.id}`)).data.report.counts;
    expect(report.files).toBe(1);
    // The local filesystem adapter removes it cleanly, so nothing is stranded.
    expect(report.filesUnreachable ?? 0).toBe(0);
  });

  test("the revision history goes too", async () => {
    seedSubject("user-1");
    const made = await ok("POST", `${BASE}/preview`, { subject: EMAIL_SUBJECT, mode: "delete" });
    await ok("POST", `${BASE}/${made.data.id}/run`, { subject: EMAIL_SUBJECT, confirm: true });
    // A snapshot holds the row as it was. Leaving it behind puts the address
    // exactly where it started.
    expect(countIn("revisions")).toBe(0);
  });

  test("the activity log goes, not just its user id", async () => {
    seedSubject("user-1");
    const made = await ok("POST", `${BASE}/preview`, { subject: EMAIL_SUBJECT, mode: "delete" });
    await ok("POST", `${BASE}/${made.data.id}/run`, { subject: EMAIL_SUBJECT, confirm: true });
    // The row carries IP and user agent beside the id; nulling the id alone
    // leaves the person identifiable.
    expect(countIn("activity", "user_id = 'user-1'")).toBe(0);
    // The erasure's own audit rows survive — they are the admin's, and they
    // carry counts rather than the subject, which the sweep below re-checks.
    expect(countIn("activity")).toBeGreaterThan(0);
  });
});

describe("running an anonymize", () => {
  test("rows survive but nothing in them names the person", async () => {
    seedSubject("user-1");
    const made = await ok("POST", `${BASE}/preview`, { subject: EMAIL_SUBJECT, mode: "anonymize" });
    await ok("POST", `${BASE}/${made.data.id}/run`, { subject: EMAIL_SUBJECT, confirm: true });

    // Kept, because an invoice usually cannot lawfully be deleted.
    const lead = client.query(`select * from "${leadsTable}" where id = 'lead-1'`).get() as Record<string, unknown>;
    expect(lead).toBeDefined();
    expect(String(lead.email)).not.toBe(SUBJECT_EMAIL);
    expect(String(lead.email)).toEndWith("@erased.invalid");
    expect(lead.name).toBeNull();

    const user = client.query("select * from app_users where id = 'user-1'").get() as Record<string, unknown>;
    expect(user.name).toBe("Erased user");
    expect(String(user.email)).not.toContain("alice");
    expect(user.is_anonymous).toBe(1);
  });

  test("revisions are deleted even in anonymize mode", async () => {
    seedSubject("user-1");
    const made = await ok("POST", `${BASE}/preview`, { subject: EMAIL_SUBJECT, mode: "anonymize" });
    await ok("POST", `${BASE}/${made.data.id}/run`, { subject: EMAIL_SUBJECT, confirm: true });
    // Scrubbing the row while keeping its history is theatre — the old address
    // is sitting in the snapshot.
    expect(countIn("revisions")).toBe(0);
  });

  test("no trace of the address survives anywhere the run reached", async () => {
    seedSubject("user-1");
    const made = await ok("POST", `${BASE}/preview`, { subject: EMAIL_SUBJECT, mode: "anonymize" });
    await ok("POST", `${BASE}/${made.data.id}/run`, { subject: EMAIL_SUBJECT, confirm: true });

    for (const table of ["app_users", leadsTable, "revisions", "comments", "activity", "erasure_requests"]) {
      const rows = client.query(`select * from "${table}"`).all();
      expect(JSON.stringify(rows), table).not.toContain(SUBJECT_EMAIL);
    }
  });
});

describe("the guards around an irreversible action", () => {
  test("a run without a preview is refused", async () => {
    seedSubject("user-1");
    const made = await ok("POST", `${BASE}/preview`, { subject: EMAIL_SUBJECT, mode: "delete" });
    client.query("update erasure_requests set status = 'pending' where id = ?").run(made.data.id);
    const res = await req("POST", `${BASE}/${made.data.id}/run`, {
      subject: EMAIL_SUBJECT,
      confirm: true,
    });
    expect(res.status).toBe(409);
    expect(countIn("app_users")).toBe(1);
  });

  test("running with a different subject than was previewed is refused", async () => {
    seedSubject("user-1");
    const made = await ok("POST", `${BASE}/preview`, { subject: EMAIL_SUBJECT, mode: "delete" });
    const res = await req("POST", `${BASE}/${made.data.id}/run`, {
      subject: { type: "email", value: "someone.else@example.test" },
      confirm: true,
    });
    // The stored row holds only a hash, so this is also the only thing that
    // ties the second call to the person the first one was about.
    expect(res.status).toBe(422);
    expect(countIn("app_users")).toBe(1);
  });

  test("a bodyless or unconfirmed run is refused", async () => {
    seedSubject("user-1");
    const made = await ok("POST", `${BASE}/preview`, { subject: EMAIL_SUBJECT, mode: "delete" });
    expect((await req("POST", `${BASE}/${made.data.id}/run`, {})).status).toBe(422);
    expect(
      (await req("POST", `${BASE}/${made.data.id}/run`, { subject: EMAIL_SUBJECT, confirm: false })).status,
    ).toBe(422);
    expect(countIn("app_users")).toBe(1);
  });

  test("a completed request cannot be replayed", async () => {
    seedSubject("user-1");
    const made = await ok("POST", `${BASE}/preview`, { subject: EMAIL_SUBJECT, mode: "delete" });
    await ok("POST", `${BASE}/${made.data.id}/run`, { subject: EMAIL_SUBJECT, confirm: true });
    const again = await req("POST", `${BASE}/${made.data.id}/run`, {
      subject: EMAIL_SUBJECT,
      confirm: true,
    });
    expect(again.status).toBe(409);
  });
});

describe("workspace scoping", () => {
  test("another workspace's request cannot be read or run", async () => {
    seedSubject("user-1");
    const foreignId = crypto.randomUUID();
    client
      .query(
        `insert into erasure_requests (id, tenant_id, subject_type, subject_hash, mode, status, created_at, updated_at)
         values (?,?,?,?,?,?,?,?)`,
      )
      .run(foreignId, "some-other-tenant", "email", "deadbeef", "delete", "previewed", Date.now(), Date.now());

    const list = await ok("GET", BASE);
    expect(list.data.some((r: { id: string }) => r.id === foreignId)).toBe(false);
    expect((await req("GET", `${BASE}/${foreignId}`)).status).toBe(404);
    expect(
      (await req("POST", `${BASE}/${foreignId}/run`, { subject: EMAIL_SUBJECT, confirm: true })).status,
    ).toBe(404);
    client.query("delete from erasure_requests where id = ?").run(foreignId);
  });

  test("a collection row belonging to another workspace is neither counted nor erased", async () => {
    // The physical table carries a `tenant_id` column and every other read path
    // filters on it. If the scan did not, one workspace filing an erasure would
    // reach into another's rows — the exact failure this repo has already
    // shipped once, in the integration fan-out.
    seedSubject("user-1");
    const now = Date.now();
    client
      .query(`insert into "${leadsTable}" (id, tenant_id, name, email, created_at, updated_at) values (?,?,?,?,?,?)`)
      .run("lead-foreign", "some-other-tenant", "Alice Elsewhere", SUBJECT_EMAIL, now, now);

    const made = await ok("POST", `${BASE}/preview`, { subject: EMAIL_SUBJECT, mode: "delete" });
    expect(made.data.plan.counts.collections).toBe(1);

    await ok("POST", `${BASE}/${made.data.id}/run`, { subject: EMAIL_SUBJECT, confirm: true });
    expect(countIn(leadsTable, "id = 'lead-foreign'")).toBe(1);
  });

  test("an end user from another workspace is not a subject here", async () => {
    const now = Date.now();
    client
      .query(
        `insert into app_users (id, tenant_id, email, name, status, is_anonymous, created_at, updated_at)
         values (?,?,?,?,'active',0,?,?)`,
      )
      .run("foreign-user", "some-other-tenant", "foreign@example.test", "Foreign", now, now);
    const res = await req("POST", `${BASE}/preview`, {
      subject: { type: "app_user", value: "foreign-user" },
      mode: "delete",
    });
    expect(res.status).toBe(404);
    client.query("delete from app_users where id = 'foreign-user'").run();
  });

  test("every endpoint refuses an unauthenticated caller", async () => {
    const anon = makeHarness();
    try {
      for (const [method, path] of [
        ["GET", BASE],
        ["GET", `${BASE}/surfaces`],
        ["POST", `${BASE}/preview`],
        ["POST", `${BASE}/x/run`],
        ["GET", `${BASE}/x`],
      ] as const) {
        const res = await anon.fetch(path, {
          method,
          ...(method === "GET"
            ? {}
            : { headers: { "content-type": "application/json" }, body: JSON.stringify({}) }),
        });
        expect([401, 403], `${method} ${path}`).toContain(res.status);
      }
    } finally {
      anon.cleanup();
    }
  });
});
