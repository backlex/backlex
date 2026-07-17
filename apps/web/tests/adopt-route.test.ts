/**
 * REST coverage for `/api/admin/adopt` (routes/adopt.ts) — the discovery +
 * introspection helpers behind the adopt-a-table wizard.
 *
 * A raw physical table is created directly on the harness SQLite file (same
 * pattern as auto-migrate.test.ts — a second bun:sqlite connection on the
 * WAL db), then the admin endpoints list and inspect it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const JSON_HEADERS = { "Content-Type": "application/json" };

interface AdoptableTable {
  name: string;
  columns: number;
  rowCount: number;
  disabled: string | null;
}

interface InspectedColumn {
  name: string;
  dbType: string;
  nullable: boolean;
  isPk: boolean;
  suggested: string | null;
  reserved?: string;
}

interface InspectResult {
  table: string;
  pk: { column: string; dbType: string; supported: boolean } | null;
  columns: InspectedColumn[];
  systemColumnsPresent: { createdAt: boolean; updatedAt: boolean; ownerId: boolean };
  foreignKeys: unknown[];
  warnings: string[];
}

describe("admin adopt helpers", () => {
  let h: TestHarness;
  const adminPassword = "correct-horse-battery";
  const userEmail = `plain-${Date.now()}@example.test`;
  let adminEmail = "";

  beforeAll(async () => {
    h = makeHarness();
    adminEmail = (await seedAdmin(h)).email;

    // Raw physical tables, written through a second connection on the same
    // WAL SQLite file the app is serving.
    const raw = new Database(h.env.SQLITE_PATH!, { readwrite: true });
    raw.exec(`
      CREATE TABLE legacy_products (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        price REAL,
        created_at INTEGER
      );
      INSERT INTO legacy_products (id, name, price, created_at)
        VALUES ('p1', 'Widget', 9.99, 1700000000000),
               ('p2', 'Gadget', 19.5, 1700000001000);
      CREATE TABLE legacy_join (
        a TEXT NOT NULL,
        b TEXT NOT NULL,
        PRIMARY KEY (a, b)
      );
    `);
    raw.close();
  });
  afterAll(() => h.cleanup());

  test("GET /tables lists the raw table with column + row counts", async () => {
    const res = await h.fetch("/api/admin/adopt/tables");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: AdoptableTable[] };
    const products = body.data.find((t) => t.name === "legacy_products");
    expect(products).toBeDefined();
    expect(products!.columns).toBe(4);
    expect(products!.rowCount).toBe(2);
    expect(products!.disabled).toBeNull();
  });

  test("GET /tables hides system tables and flags composite PKs", async () => {
    const res = await h.fetch("/api/admin/adopt/tables");
    const body = (await res.json()) as { data: AdoptableTable[] };
    const names = body.data.map((t) => t.name);
    expect(names).not.toContain("collections");
    expect(names).not.toContain("users");
    const join = body.data.find((t) => t.name === "legacy_join");
    expect(join).toBeDefined();
    expect(join!.disabled).toBe("Composite primary key");
  });

  test("POST /inspect returns columns, PK and system-column detection", async () => {
    const res = await h.fetch("/api/admin/adopt/inspect", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ table: "legacy_products" }),
    });
    expect(res.status).toBe(200);
    const data = ((await res.json()) as { data: InspectResult }).data;
    expect(data.table).toBe("legacy_products");
    expect(data.pk).toEqual({ column: "id", dbType: "TEXT", supported: true });

    const byName = new Map(data.columns.map((c) => [c.name, c]));
    expect(data.columns.length).toBe(4);
    expect(byName.get("id")?.isPk).toBe(true);
    expect(byName.get("id")?.reserved).toBe("id"); // reserved-name collision flagged
    // Bare SQLite TEXT (no width) is promoted to longtext by suggestFieldType.
    expect(byName.get("name")?.suggested).toBe("longtext");
    expect(byName.get("name")?.nullable).toBe(false);
    expect(byName.get("price")?.suggested).toBe("number");
    expect(byName.get("price")?.nullable).toBe(true);
    expect(byName.get("created_at")?.suggested).toBe("integer");

    expect(data.systemColumnsPresent).toEqual({
      createdAt: true,
      updatedAt: false,
      ownerId: false,
    });
    expect(data.foreignKeys).toEqual([]);
  });

  test("POST /inspect on a missing table 404s", async () => {
    const res = await h.fetch("/api/admin/adopt/inspect", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ table: "does_not_exist" }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });

  test("POST /inspect on a composite-PK table is a 422 VALIDATION error", async () => {
    const res = await h.fetch("/api/admin/adopt/inspect", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ table: "legacy_join" }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("VALIDATION");
    expect(body.error.message).toContain("Composite primary keys");
  });

  test("non-admin users get 403", async () => {
    await h.fetch("/api/auth/sign-out", { method: "POST" });
    const su = await h.fetch("/api/auth/sign-up/email", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        email: userEmail,
        password: adminPassword,
        name: "Plain User",
      }),
    });
    expect(su.status).toBe(200);

    const tables = await h.fetch("/api/admin/adopt/tables");
    expect(tables.status).toBe(403);
    const body = (await tables.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("FORBIDDEN");
    expect(body.error.message).toContain("Admin role required");

    const inspect = await h.fetch("/api/admin/adopt/inspect", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ table: "legacy_products" }),
    });
    expect(inspect.status).toBe(403);

    // Restore the admin session for any later tests.
    await h.fetch("/api/auth/sign-out", { method: "POST" });
    const si = await h.fetch("/api/auth/sign-in/email", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ email: adminEmail, password: adminPassword }),
    });
    expect(si.status).toBe(200);
  });

  test("anonymous requests get 401", async () => {
    const res = await h.app.fetch(
      new Request(`${h.env.APP_URL}/api/admin/adopt/tables`, {
        headers: { Origin: h.env.APP_URL },
      }),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("UNAUTHORIZED");
  });
});
