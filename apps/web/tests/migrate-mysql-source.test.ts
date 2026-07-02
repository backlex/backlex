/**
 * MySQL source connector — unit tests over a SCRIPTED executor (no MySQL
 * server in CI). Verifies the introspection SQL contract (`?` placeholders,
 * information_schema shapes), the MySQL-specific type idioms
 * (tinyint(1) → boolean, enum labels, varchar sizes), and keyset/since
 * read SQL.
 */
import { describe, expect, test } from "bun:test";
import {
  buildPlan,
  createMysqlSource,
  parseEnumLabels,
  type SourceQuery,
} from "../../../packages/migrate/src";

/** Executor that pattern-matches incoming SQL and records every call. */
const scripted = (routes: [RegExp, Record<string, unknown>[]][]) => {
  const calls: { sql: string; params: unknown[] }[] = [];
  const query: SourceQuery = async (sql, params) => {
    calls.push({ sql, params: params ?? [] });
    const hit = routes.find(([re]) => re.test(sql));
    if (!hit) throw new Error(`no scripted response for: ${sql}`);
    return hit[1];
  };
  return { query, calls };
};

const COLUMNS = [
  { COLUMN_NAME: "id", DATA_TYPE: "bigint", COLUMN_TYPE: "bigint unsigned", IS_NULLABLE: "NO", COLUMN_KEY: "PRI" },
  { COLUMN_NAME: "name", DATA_TYPE: "varchar", COLUMN_TYPE: "varchar(120)", IS_NULLABLE: "NO", COLUMN_KEY: "" },
  { COLUMN_NAME: "bio", DATA_TYPE: "varchar", COLUMN_TYPE: "varchar(500)", IS_NULLABLE: "YES", COLUMN_KEY: "" },
  { COLUMN_NAME: "notes", DATA_TYPE: "mediumtext", COLUMN_TYPE: "mediumtext", IS_NULLABLE: "YES", COLUMN_KEY: "" },
  { COLUMN_NAME: "is_active", DATA_TYPE: "tinyint", COLUMN_TYPE: "tinyint(1)", IS_NULLABLE: "NO", COLUMN_KEY: "" },
  { COLUMN_NAME: "tier", DATA_TYPE: "enum", COLUMN_TYPE: "enum('free','pro','it''s odd')", IS_NULLABLE: "YES", COLUMN_KEY: "" },
  { COLUMN_NAME: "updated_at", DATA_TYPE: "datetime", COLUMN_TYPE: "datetime", IS_NULLABLE: "YES", COLUMN_KEY: "" },
  { COLUMN_NAME: "avatar", DATA_TYPE: "blob", COLUMN_TYPE: "blob", IS_NULLABLE: "YES", COLUMN_KEY: "" },
];

describe("parseEnumLabels", () => {
  test("parses labels incl. escaped quotes", () => {
    expect(parseEnumLabels("enum('a','b','it''s')")).toEqual(["a", "b", "it's"]);
    expect(parseEnumLabels("varchar(20)")).toEqual([]);
  });
});

describe("mysql source connector", () => {
  test("listTables queries information_schema for base tables", async () => {
    const { query, calls } = scripted([
      [/information_schema\.TABLES/, [{ name: "users", approx: 1234 }]],
    ]);
    const src = createMysqlSource(query);
    const tables = await src.listTables();
    expect(tables).toEqual([{ name: "users", approxRows: 1234 }]);
    expect(calls[0]!.sql).toContain("TABLE_TYPE = 'BASE TABLE'");
  });

  test("inspect maps MySQL idioms onto the shared model", async () => {
    const { query } = scripted([
      [/information_schema\.COLUMNS/, COLUMNS],
      [/KEY_COLUMN_USAGE/, [
        { CONSTRAINT_NAME: "fk_team", COLUMN_NAME: "team_id", REFERENCED_TABLE_NAME: "teams", REFERENCED_COLUMN_NAME: "id" },
      ]],
    ]);
    const src = createMysqlSource(query);
    const ins = await src.inspect("users");
    expect(ins.pk).toEqual({ column: "id", dbType: "bigint" });
    const byName = new Map(ins.columns.map((c) => [c.name, c]));
    expect(byName.get("is_active")!.dbType).toBe("boolean");
    expect(byName.get("tier")!.dbType).toBe("enum");
    expect(byName.get("tier")!.enumValues).toEqual(["free", "pro", "it's odd"]);
    expect(byName.get("bio")!.dbType).toBe("varchar(500)"); // size survives for longtext split
    expect(ins.foreignKeys).toEqual([
      { column: "team_id", referencesTable: "teams", referencesColumn: "id", composite: false },
    ]);
  });

  test("composite PKs come back as null (excluded from plans)", async () => {
    const { query } = scripted([
      [/information_schema\.COLUMNS/, [
        { COLUMN_NAME: "a", DATA_TYPE: "bigint", COLUMN_TYPE: "bigint", IS_NULLABLE: "NO", COLUMN_KEY: "PRI" },
        { COLUMN_NAME: "b", DATA_TYPE: "bigint", COLUMN_TYPE: "bigint", IS_NULLABLE: "NO", COLUMN_KEY: "PRI" },
      ]],
      [/KEY_COLUMN_USAGE/, []],
    ]);
    const ins = await createMysqlSource(query).inspect("junction");
    expect(ins.pk).toBeNull();
  });

  test("the inspected shape feeds the shared plan builder", async () => {
    const { query } = scripted([
      [/information_schema\.COLUMNS/, COLUMNS],
      [/KEY_COLUMN_USAGE/, []],
    ]);
    const ins = await createMysqlSource(query).inspect("users");
    const plan = buildPlan([ins], new Map(), "mysql");
    expect(plan.source.kind).toBe("mysql");
    const t = plan.tables[0]!;
    expect(t.include).toBe(true);
    expect(t.pkType).toBe("integer");
    expect(t.updatedAtColumn).toBe("updated_at");
    const f = new Map(t.fields.map((x) => [x.column, x]));
    expect(f.get("bio")!.type).toBe("longtext"); // varchar(500)
    expect(f.get("notes")!.type).toBe("longtext"); // mediumtext
    expect(f.get("is_active")!.type).toBe("boolean");
    expect(f.get("tier")!.type).toBe("text");
    expect(f.get("tier")!.choices).toEqual(["free", "pro", "it's odd"]);
    expect(f.has("avatar")).toBe(false); // blob excluded
    expect(t.warnings.some((w) => w.includes("avatar"))).toBe(true);
  });

  test("readBatch emits `?` placeholders with keyset + since filters", async () => {
    const { query, calls } = scripted([[/SELECT \* FROM/, []]]);
    const src = createMysqlSource(query);
    await src.readBatch("users", "id", { after: 50, limit: 100, since: { column: "updated_at", value: "2030-01-01" } });
    expect(calls[0]!.sql).toBe(
      "SELECT * FROM `users` WHERE `id` > ? AND `updated_at` >= ? ORDER BY `id` LIMIT ?",
    );
    expect(calls[0]!.params).toEqual([50, "2030-01-01", 100]);

    await src.readBatch("users", "id", { limit: 10 });
    expect(calls[1]!.sql).toBe("SELECT * FROM `users` ORDER BY `id` LIMIT ?");
  });

  test("hostile identifiers are refused before reaching SQL", async () => {
    const { query } = scripted([[/./, []]]);
    const src = createMysqlSource(query);
    await expect(src.readBatch("users`; DROP TABLE x;--", "id", { limit: 1 })).rejects.toThrow(
      /quote-unsafe/,
    );
  });
});
