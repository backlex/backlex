/**
 * SQLite-FILE source end-to-end — unlike the pglite e2e, NOTHING is
 * injected: the CLI's real `openSource` dispatch opens the temp .sqlite
 * file through bun:sqlite (the suite runs under Bun), so the scheme
 * detection, the sqlite connector's PRAGMA introspection, and the copy
 * path are all exercised for real.
 */
import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import { runImportDb } from "../../../packages/cli/src/import-db";

describe("import-db end-to-end (sqlite FILE source, no injection)", () => {
  let h: TestHarness;
  let server: ReturnType<typeof Bun.serve>;
  let url: string;
  let pak: string;
  const dbPath = resolve(tmpdir(), `backlex-legacy-${randomUUID()}.sqlite`);
  const planPath = resolve(tmpdir(), `backlex-sqlite-plan-${randomUUID()}.json`);

  beforeAll(async () => {
    const src = new Database(dbPath, { create: true });
    src.exec(`
      CREATE TABLE projects (
        id INTEGER PRIMARY KEY,
        title VARCHAR(80) NOT NULL,
        stars REAL,
        archived INTEGER,
        created_at DATETIME
      );
      CREATE TABLE tasks (
        id INTEGER PRIMARY KEY,
        project_id INTEGER REFERENCES projects(id),
        body TEXT NOT NULL
      );
      INSERT INTO projects VALUES
        (1, 'apollo', 4.5, 0, '2023-01-01T00:00:00Z'),
        (2, 'gemini', 3.0, 1, '2023-02-02T00:00:00Z');
      INSERT INTO tasks VALUES
        (10, 1, 'launch'), (11, 1, 'orbit'), (12, 2, 'splashdown');
    `);
    src.close();

    h = makeHarness();
    await seedAdmin(h);
    const keyRes = await h.fetch("/api/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "sqlite-e2e" }),
    });
    pak = ((await keyRes.json()) as { data: { secret: string } }).data.secret;
    server = Bun.serve({ port: 0, fetch: (req) => h.app.fetch(req) });
    url = `http://localhost:${server.port}`;
  });

  afterAll(() => {
    server?.stop(true);
    for (const p of [dbPath, planPath, `${planPath}.state.json`]) {
      try {
        rmSync(p, { force: true });
      } catch {
        /* ignore */
      }
    }
    h?.cleanup();
  });

  test("plan via the real sqlite: scheme dispatch", async () => {
    await runImportDb(["plan", "--source", `sqlite:${dbPath}`, "--out", planPath]);
    const plan = JSON.parse(readFileSync(planPath, "utf8"));
    expect(plan.source.kind).toBe("sqlite-file");
    expect(plan.order).toEqual(["projects", "tasks"]);

    const projects = plan.tables.find((t: any) => t.table === "projects");
    expect(projects.pkType).toBe("integer");
    expect(projects.createdAtColumn).toBe("created_at");
    expect(projects.approxRows).toBe(2);
    const rel = plan.tables
      .find((t: any) => t.table === "tasks")
      .fields.find((f: any) => f.column === "project_id");
    expect(rel.type).toBe("relation");
    expect(rel.to).toBe("projects");
  });

  test("run copies the file's rows and verifies counts", async () => {
    const exitBefore = process.exitCode;
    await runImportDb([
      "run", planPath,
      "--source", `sqlite:${dbPath}`,
      "--url", url,
      "--key", pak,
    ]);
    expect(process.exitCode).toBe(exitBefore);

    const auth = { authorization: `Bearer ${pak}` };
    const tasks = (await (
      await fetch(`${url}/api/items/tasks?limit=10&meta=filter_count`, { headers: auth })
    ).json()) as { meta: { filter_count: number } };
    expect(tasks.meta.filter_count).toBe(3);

    const withParent = (await (
      await fetch(`${url}/api/items/tasks/10?expand=project_id`, { headers: auth })
    ).json()) as { data: any };
    expect(withParent.data.project_id?.title).toBe("apollo");
    expect(withParent.data.body).toBe("launch");
  });
});
