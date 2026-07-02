/**
 * End-to-end external-DB migration: a real (pglite) Postgres source →
 * `backlex import-db plan` → `run` against a live harness server → verify.
 *
 * The CLI's source factory is injected (pglite has no TCP listener for
 * postgres.js to dial); everything else — introspection SQL, plan build,
 * collection creation, keyset copy, ingest, verify — is the production path.
 */
import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import { createPgSource, type SourceQuery } from "../../../packages/migrate/src";
import { runImportDb } from "../../../packages/cli/src/import-db";

describe("import-db end-to-end (pglite source → harness target)", () => {
  let h: TestHarness;
  let pg: PGlite;
  let server: ReturnType<typeof Bun.serve>;
  let url: string;
  let pak: string;
  const planPath = resolve(tmpdir(), `backlex-import-plan-${randomUUID()}.json`);
  const statePath = `${planPath}.state.json`;

  const deps = {
    openSource: () => {
      const query: SourceQuery = async (text, params) =>
        (await pg.query(text, (params ?? []) as unknown[])).rows as Record<
          string,
          unknown
        >[];
      return { connector: createPgSource(query), close: async () => {} };
    },
  };

  beforeAll(async () => {
    // Source: a small legacy commerce schema with the interesting shapes —
    // bigint PKs, camelCase column, enum, numeric, timestamptz, array, FK.
    pg = new PGlite();
    await pg.exec(`
      CREATE TYPE order_status AS ENUM ('pending', 'shipped');
      CREATE TABLE customers (
        id bigint PRIMARY KEY,
        "fullName" varchar(120) NOT NULL,
        email text,
        tags text[],
        created_at timestamptz
      );
      CREATE TABLE orders (
        id bigint PRIMARY KEY,
        customer_id bigint REFERENCES customers(id),
        status order_status,
        total numeric(10,2),
        created_at timestamptz
      );
      INSERT INTO customers (id, "fullName", email, tags, created_at) VALUES
        (1, 'Ada Lovelace', 'ada@example.test', '{vip,eu}', '2020-01-01T00:00:00Z'),
        (2, 'Grace Hopper', 'grace@example.test', NULL,      '2020-06-15T12:00:00Z'),
        (3, 'Alan Turing',  NULL,                '{eu}',     '2021-03-03T03:03:03Z');
      INSERT INTO orders (id, customer_id, status, total, created_at) VALUES
        (10, 1, 'pending', 12.50,  '2022-01-01T00:00:00Z'),
        (11, 1, 'shipped', 99.99,  '2022-02-02T00:00:00Z'),
        (12, 2, 'shipped', 5.00,   '2022-03-03T00:00:00Z'),
        (13, 3, 'pending', 42.00,  '2022-04-04T00:00:00Z'),
        (14, NULL, NULL,   0.01,   '2022-05-05T00:00:00Z');
    `);

    // Target: harness app on a real port + an admin API key for the CLI.
    h = makeHarness();
    await seedAdmin(h);
    const keyRes = await h.fetch("/api/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "import-db-e2e" }),
    });
    expect(keyRes.status).toBe(201);
    pak = ((await keyRes.json()) as { data: { secret: string } }).data.secret;
    server = Bun.serve({ port: 0, fetch: (req) => h.app.fetch(req) });
    url = `http://localhost:${server.port}`;
  });

  afterAll(async () => {
    server?.stop(true);
    await pg?.close();
    for (const p of [planPath, statePath]) {
      try {
        rmSync(p, { force: true });
      } catch {
        /* ignore */
      }
    }
    h?.cleanup();
  });

  test("plan: introspects the source into an editable, ordered plan", async () => {
    await runImportDb(
      ["plan", "--source", "pglite://in-memory", "--out", planPath],
      deps,
    );
    const plan = JSON.parse(readFileSync(planPath, "utf8"));
    expect(plan.order).toEqual(["customers", "orders"]);

    const customers = plan.tables.find((t: any) => t.table === "customers");
    expect(customers.pkType).toBe("integer");
    expect(customers.createdAtColumn).toBe("created_at");
    const fullName = customers.fields.find((f: any) => f.column === "fullName");
    expect(fullName.name).toBe("full_name");
    expect(fullName.required).toBe(true);
    expect(customers.fields.find((f: any) => f.column === "tags").type).toBe("json");

    const orders = plan.tables.find((t: any) => t.table === "orders");
    const rel = orders.fields.find((f: any) => f.column === "customer_id");
    expect(rel.type).toBe("relation");
    expect(rel.to).toBe("customers");
    expect(orders.fields.find((f: any) => f.column === "status").choices).toEqual([
      "pending",
      "shipped",
    ]);
  });

  test("run: creates collections, copies rows in FK order, verifies counts", async () => {
    // bun:test manages process.exitCode itself; a failed verify would CHANGE
    // it (the CLI sets 1), so assert it stayed whatever it was.
    const exitBefore = process.exitCode;
    await runImportDb(
      [
        "run",
        planPath,
        "--source",
        "pglite://in-memory",
        "--url",
        url,
        "--key",
        pak,
        "--batch",
        "2", // force keyset paging across several batches
      ],
      deps,
    );
    expect(process.exitCode).toBe(exitBefore);

    const auth = { authorization: `Bearer ${pak}` };
    const custRes = await fetch(`${url}/api/items/customers?limit=50&meta=filter_count`, {
      headers: auth,
    });
    expect(custRes.status).toBe(200);
    const cust = (await custRes.json()) as { data: any[]; meta: { filter_count: number } };
    expect(cust.meta.filter_count).toBe(3);

    const ada = await (
      await fetch(`${url}/api/items/customers/1`, { headers: auth })
    ).json() as { data: any };
    expect(ada.data.full_name).toBe("Ada Lovelace");
    expect(ada.data.tags).toEqual(["vip", "eu"]);
    expect(new Date(ada.data.createdAt).toISOString()).toBe("2020-01-01T00:00:00.000Z");

    const ordRes = await fetch(`${url}/api/items/orders?limit=50&meta=filter_count`, {
      headers: auth,
    });
    const ord = (await ordRes.json()) as { data: any[]; meta: { filter_count: number } };
    expect(ord.meta.filter_count).toBe(5);

    // Preserved PKs keep FK values valid: expand resolves the parent row.
    const withParent = await (
      await fetch(`${url}/api/items/orders/10?expand=customer_id`, { headers: auth })
    ).json() as { data: any };
    expect(withParent.data.customer_id?.full_name).toBe("Ada Lovelace");
    expect(withParent.data.total).toBe(12.5);
    expect(withParent.data.status).toBe("pending");

    // The enum landed as a dropdown on the collection metadata.
    const coll = await (
      await fetch(`${url}/api/collections/orders`, { headers: auth })
    ).json() as { data: { fields: any[] } };
    const status = coll.data.fields.find((f) => f.name === "status");
    expect(status.interface).toBe("dropdown");
    expect(status.options.choices.map((c: any) => c.value)).toEqual([
      "pending",
      "shipped",
    ]);
  });

  test("run --resume is a no-op on an already-complete migration", async () => {
    expect(existsSync(statePath)).toBe(true);
    const exitBefore = process.exitCode;
    await runImportDb(
      ["run", planPath, "--source", "x", "--url", url, "--key", pak, "--resume"],
      deps,
    );
    expect(process.exitCode).toBe(exitBefore);
    const auth = { authorization: `Bearer ${pak}` };
    const cust = (await (
      await fetch(`${url}/api/items/customers?limit=1&meta=filter_count`, { headers: auth })
    ).json()) as { meta: { filter_count: number } };
    expect(cust.meta.filter_count).toBe(3); // still 3 — no dupes
  });
});
