/**
 * The five "system" email templates no sender read — `verify`, `reset`, `magic`,
 * `invite`, `change_email` — are no longer seeded, and
 * `20260915120000_remove_unsent_system_email_templates` deletes the shared rows
 * the seeder left behind (#384).
 *
 * Two claims, each with a way to be wrong that would not show up as a failure:
 *
 *   1. The migration removes ONLY the shared rows. A workspace's own row under
 *      one of those keys is workspace data (an admin saved an edit, and saving a
 *      shared default writes a copy); deleting it would be silent data loss.
 *      Asserted row by row on both dialects, including a replay, because the
 *      boot-time runner re-applies any file its ledger does not name.
 *
 *   2. A flow `email` step that named one of those keys changes behaviour, and
 *      has to change it LEGIBLY. It used to mail the shared row with every link
 *      rendered empty; with the row gone and no subject or body of its own, the
 *      run must fail as a run and say which template is missing, not crash the
 *      request. That spec runs the same flow on the same database once BEFORE
 *      the migration, so the failure after it cannot come from a fixture that
 *      never resolved in the first place.
 *
 * Why no "nothing is seeded" spec: the seeder ran on the first request of a
 * PROCESS (`rolesSeeded` in `app.ts`), not of a database, so under
 * `--no-isolate` any earlier spec in the same worker would already have spent
 * it and such an assertion would pass whether or not the seeder still existed.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { PGlite } from "@electric-sql/pglite";
import { MIGRATIONS as PG_BUNDLE } from "@backlex/db/pg/migrations-bundle";
import { MIGRATIONS as SQLITE_BUNDLE } from "@backlex/db/sqlite/migrations-bundle";
import { makeHarness, PGLITE_BOOT_TIMEOUT_MS, seedAdmin, type TestHarness } from "../setup";
import { PG_TESTS_OPTIONAL } from "../setup-pg";

const TAG = "20260915120000_remove_unsent_system_email_templates";
const REMOVED = ["verify", "reset", "magic", "invite", "change_email"] as const;

const statements = (sqlText: string): string[] =>
  sqlText
    .split(/-->\s*statement-breakpoint/i)
    .map((s) => s.trim())
    .filter(Boolean);

/** The shipped bytes, by name — a rename fails here instead of testing nothing. */
const shipped = (bundle: ReadonlyArray<{ name: string; sql: string }>) => {
  const index = bundle.findIndex((m) => m.name === TAG);
  if (index < 0) throw new Error(`${TAG} is not in the bundle`);
  return { before: bundle.slice(0, index), migration: bundle[index]! };
};

interface Planted {
  tenantId: string | null;
  key: string;
}

/** Everything the migration has to tell apart: the five shared rows (one of them
 *  twice — the UNIQUE index treats NULLs as distinct, so the seeder's
 *  check-then-insert could race), workspace copies under removed keys in two
 *  workspaces, a shared row under a key nobody removed, and a workspace's
 *  customized built-in email. */
const PLANTED: Planted[] = [
  ...REMOVED.map((key) => ({ tenantId: null, key })),
  { tenantId: null, key: "verify" },
  { tenantId: "ws_a", key: "verify" },
  { tenantId: "ws_a", key: "invite" },
  { tenantId: "ws_b", key: "magic" },
  { tenantId: null, key: "digest" },
  { tenantId: "ws_a", key: "form_invite" },
];

const SURVIVORS = PLANTED.filter(
  (r) => r.tenantId !== null || !(REMOVED as readonly string[]).includes(r.key),
);

const sortRows = (rows: Planted[]) =>
  [...rows].sort((a, b) =>
    `${a.key}|${a.tenantId ?? ""}`.localeCompare(`${b.key}|${b.tenantId ?? ""}`),
  );

describe("the migration removes the shared rows and nothing else", () => {
  test("sqlite: shared rows under the five keys go; workspace copies and other keys stay; a replay changes nothing", () => {
    const { before, migration } = shipped(SQLITE_BUNDLE);
    const db = new Database(":memory:");
    try {
      // The whole bundle up to this file, exactly as it ships.
      for (const m of before) for (const st of statements(m.sql)) db.exec(st);
      const insert = db.query(
        "insert into email_templates (id, tenant_id, key, name, subject, body_html, created_at, updated_at) values (?, ?, ?, 'Name', 'Subject', '<p>Body</p>', ?, ?)",
      );
      for (const row of PLANTED) insert.run(crypto.randomUUID(), row.tenantId, row.key, Date.now(), Date.now());
      const read = () =>
        (db.query("select tenant_id as tenantId, key from email_templates").all() as Planted[]);
      expect(read()).toHaveLength(PLANTED.length);

      for (const st of statements(migration.sql)) db.exec(st);
      expect(sortRows(read())).toEqual(sortRows(SURVIVORS));

      for (const st of statements(migration.sql)) db.exec(st);
      expect(sortRows(read())).toEqual(sortRows(SURVIVORS));
    } finally {
      db.close();
    }
  });

  test(
    "pg: the same rows go and the same rows stay",
    async () => {
      const { before, migration } = shipped(PG_BUNDLE);
      // Only the files before this one that touch the table. Replaying the whole
      // pg bundle into a WASM Postgres costs seconds for a single DELETE, and
      // every other table is irrelevant to it — while a later ALTER of this
      // table, if one is ever written before it, is picked up by the filter.
      const relevant = before.filter((m) => m.sql.includes('"email_templates"'));
      expect(relevant.length).toBeGreaterThan(0);

      let pg: PGlite;
      try {
        pg = new PGlite();
        await pg.waitReady;
      } catch (err) {
        // Same rule as every pglite spec: pglite needs nothing external, so a
        // boot failure is a defect, not a missing environment. Skipping is
        // opt-in and says what it cost.
        if (!PG_TESTS_OPTIONAL) {
          throw new Error(
            `[unsent-system-email-templates] pglite failed to boot, so the pg migration was never run. ` +
              `Fix the cause, or re-run with BACKLEX_PG_TESTS=optional. Cause: ${(err as Error).message}`,
            { cause: err },
          );
        }
        console.warn("[unsent-system-email-templates] BACKLEX_PG_TESTS=optional — the pg half asserted NOTHING");
        return;
      }
      try {
        for (const m of relevant) for (const st of statements(m.sql)) await pg.exec(st);
        for (const row of PLANTED) {
          await pg.query(
            `insert into email_templates (id, tenant_id, key, name, subject, body_html) values ($1, $2, $3, 'Name', 'Subject', '<p>Body</p>')`,
            [crypto.randomUUID(), row.tenantId, row.key],
          );
        }
        const read = async () =>
          (await pg.query<Planted>(`select tenant_id as "tenantId", key from email_templates`)).rows;
        expect(await read()).toHaveLength(PLANTED.length);

        for (const st of statements(migration.sql)) await pg.exec(st);
        expect(sortRows(await read())).toEqual(sortRows(SURVIVORS));

        for (const st of statements(migration.sql)) await pg.exec(st);
        expect(sortRows(await read())).toEqual(sortRows(SURVIVORS));
      } finally {
        await pg.close();
      }
    },
    PGLITE_BOOT_TIMEOUT_MS,
  );
});

describe("a flow email step that names a removed key", () => {
  let h: TestHarness;
  let sent: string[];
  const restoreLog = console.log;

  beforeEach(async () => {
    h = makeHarness();
    await seedAdmin(h);
    sent = [];
    console.log = (...args: unknown[]) => {
      const line = args.map(String).join(" ");
      if (line.startsWith("[email]")) sent.push(line);
    };
  });
  afterEach(() => {
    console.log = restoreLog;
    h.cleanup();
  });

  const json = (body: unknown, method = "POST"): RequestInit => ({
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  /** A shared row shaped like the seeder's — `tenant_id` NULL, a link variable no
   *  flow passes. Inserted around the API, since an admin's writes land in their
   *  own workspace. */
  const plantShared = (key: string, subject: string) => {
    const db = new Database(h.env.SQLITE_PATH as string);
    try {
      db.query(
        "insert into email_templates (id, tenant_id, key, name, subject, body_html, variables, created_at, updated_at) values (?, NULL, ?, 'Seeded', ?, '<p><a href=\"{{ confirm_url }}\">Confirm</a></p>', '[\"confirm_url\"]', ?, ?)",
      ).run(crypto.randomUUID(), key, subject, Date.now(), Date.now());
    } finally {
      db.close();
    }
  };

  /** This migration's shipped SQL, applied to the harness's database file. */
  const migrate = () => {
    const db = new Database(h.env.SQLITE_PATH as string);
    try {
      for (const st of statements(shipped(SQLITE_BUNDLE).migration.sql)) db.exec(st);
    } finally {
      db.close();
    }
  };

  const flowWith = async (op: Record<string, unknown>): Promise<string> => {
    const created = await h.fetch(
      "/api/flows",
      json({
        name: `removed-key-${Math.random().toString(36).slice(2)}`,
        trigger: "manual:",
        operations: [{ type: "email", to: "ada@example.com", ...op }],
      }),
    );
    expect(created.status).toBe(201);
    return ((await created.json()) as { data: { id: string } }).data.id;
  };

  const run = async (flowId: string) => {
    const res = await h.fetch(`/api/flows/${flowId}/run`, json({ id: "rec_1" }));
    // A clean run result, not a 500 — the failure belongs to the run.
    expect(res.status).toBe(200);
    return (await res.json()) as { ok: boolean; error?: string };
  };

  test("with no wording of its own, the run fails and names the template instead of mailing blank links", async () => {
    plantShared("verify", "Confirm your email");
    const flowId = await flowWith({ templateKey: "verify" });

    // Before: the shared row resolves, and goes out.
    expect(await run(flowId)).toEqual({ ok: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('subject="Confirm your email"');

    migrate();
    sent = [];

    expect(await run(flowId)).toEqual({
      ok: false,
      error: 'Email template "verify" not found and no fallback provided',
    });
    expect(sent).toEqual([]);
  });

  test("with a subject and body of its own, the step sends those instead", async () => {
    plantShared("reset", "Reset your password");
    const flowId = await flowWith({ templateKey: "reset", subject: "Password help", text: "Reply to this email." });
    migrate();

    expect(await run(flowId)).toEqual({ ok: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('subject="Password help"');
  });

  test("a workspace's own copy survives the migration, and is what the step still sends", async () => {
    plantShared("magic", "Your sign-in link");
    const created = await h.fetch(
      "/api/admin/email-templates",
      json({ key: "magic", name: "Magic sign-in link", subject: "Workspace wording", bodyHtml: "<p>Hello</p>" }),
    );
    expect(created.status).toBe(201);
    const copy = ((await created.json()) as { data: { id: string; overridesDefault: boolean } }).data;
    expect(copy.overridesDefault).toBe(true);

    migrate();

    const listed = await h.fetch("/api/admin/email-templates");
    const rows = ((await listed.json()) as {
      data: Array<{ id: string; key: string; inherited: boolean; overridesDefault: boolean }>;
    }).data.filter((r) => r.key === "magic");
    // Nothing shared behind it any more: it is an ordinary workspace template.
    expect(rows).toEqual([expect.objectContaining({ id: copy.id, inherited: false, overridesDefault: false })]);

    const flowId = await flowWith({ templateKey: "magic" });
    expect(await run(flowId)).toEqual({ ok: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('subject="Workspace wording"');
  });
});
