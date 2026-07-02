/**
 * MySQL / MariaDB source connector (CLI-side — the server connector is
 * Postgres-only). Same read-only contract as pg-source: the caller injects
 * the executor (mysql2 in the CLI), so this stays dependency-free and
 * unit-testable with a scripted executor.
 *
 * Placeholder style: `?` (mysql wire protocol) — a connector and its
 * executor always travel as a pair, so the SQL here targets mysql2's
 * `connection.query(sql, params)` directly.
 *
 * Type notes handled here rather than in the shared mapper:
 *   - `tinyint(1)` (COLUMN_TYPE) is MySQL's boolean idiom → dbType "boolean".
 *   - `enum('a','b')` — labels parsed from COLUMN_TYPE → dropdown choices.
 *   - DATA_TYPE is used otherwise (`varchar` sizes re-attached from
 *     COLUMN_TYPE so the text/longtext split still applies).
 */
import type {
  ReadBatchOptions,
  SourceConnector,
  SourceForeignKey,
  SourceInspection,
  SourceQuery,
  SourceTable,
} from "./types";

const IDENT = /^[A-Za-z_][A-Za-z0-9_$]*$/;

const quoteIdent = (name: string): string => {
  if (!IDENT.test(name)) {
    throw new Error(`Unsupported identifier (quote-unsafe): ${name}`);
  }
  return `\`${name}\``;
};

/** Parse `enum('a','b','it''s')` COLUMN_TYPE into its labels. */
export const parseEnumLabels = (columnType: string): string[] => {
  const m = columnType.match(/^enum\((.*)\)$/i);
  if (!m) return [];
  const body = m[1]!;
  const out: string[] = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (!inQuote) {
      if (ch === "'") inQuote = true;
      // commas/space between quoted labels are skipped
    } else if (ch === "'") {
      if (body[i + 1] === "'") {
        cur += "'";
        i++;
      } else {
        inQuote = false;
        out.push(cur);
        cur = "";
      }
    } else {
      cur += ch;
    }
  }
  return out;
};

export const createMysqlSource = (query: SourceQuery): SourceConnector => {
  const listTables = async (): Promise<SourceTable[]> => {
    const rows = await query(
      `SELECT TABLE_NAME AS name, TABLE_ROWS AS approx
         FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_TYPE = 'BASE TABLE'
        ORDER BY TABLE_NAME`,
    );
    return rows.map((r) => ({
      name: String(r.name),
      approxRows:
        r.approx === null || r.approx === undefined ? null : Number(r.approx),
    }));
  };

  const inspect = async (table: string): Promise<SourceInspection> => {
    quoteIdent(table);
    const cols = await query(
      `SELECT COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = ?
        ORDER BY ORDINAL_POSITION`,
      [table],
    );
    if (cols.length === 0) {
      throw new Error(`Table "${table}" not found in the current database`);
    }

    const pkCols = cols.filter((c) => String(c.COLUMN_KEY) === "PRI");

    const fkRows = await query(
      `SELECT k.CONSTRAINT_NAME, k.COLUMN_NAME, k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME
         FROM information_schema.KEY_COLUMN_USAGE k
        WHERE k.TABLE_SCHEMA = DATABASE()
          AND k.TABLE_NAME = ?
          AND k.REFERENCED_TABLE_NAME IS NOT NULL
        ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
      [table],
    );
    const byConstraint = new Map<string, typeof fkRows>();
    for (const r of fkRows) {
      const k = String(r.CONSTRAINT_NAME);
      byConstraint.set(k, [...(byConstraint.get(k) ?? []), r]);
    }
    const foreignKeys: SourceForeignKey[] = [...byConstraint.values()].flatMap(
      (rows) =>
        rows.map((r) => ({
          column: String(r.COLUMN_NAME),
          referencesTable: String(r.REFERENCED_TABLE_NAME),
          referencesColumn: String(r.REFERENCED_COLUMN_NAME),
          composite: rows.length > 1,
        })),
    );

    const dbTypeOf = (c: Record<string, unknown>): string => {
      const columnType = String(c.COLUMN_TYPE ?? "").toLowerCase();
      const dataType = String(c.DATA_TYPE ?? "").toLowerCase();
      if (columnType === "tinyint(1)") return "boolean";
      if (dataType === "enum") return "enum";
      // Keep the size parameter so the shared mapper's text/longtext split
      // applies (`varchar(500)` → longtext).
      if (dataType === "varchar" || dataType === "char") {
        return columnType.replace(/ unsigned$/, "");
      }
      return dataType;
    };

    return {
      table,
      columns: cols.map((c) => {
        const dbType = dbTypeOf(c);
        const enumValues =
          dbType === "enum" ? parseEnumLabels(String(c.COLUMN_TYPE)) : undefined;
        return {
          name: String(c.COLUMN_NAME),
          dbType,
          nullable: String(c.IS_NULLABLE) === "YES",
          ...(enumValues && enumValues.length > 0 ? { enumValues } : {}),
        };
      }),
      pk:
        pkCols.length === 1
          ? {
              column: String(pkCols[0]!.COLUMN_NAME),
              dbType: dbTypeOf(pkCols[0]!),
            }
          : null,
      foreignKeys,
    };
  };

  const readBatch = async (
    table: string,
    pkColumn: string,
    opts: ReadBatchOptions,
  ): Promise<Record<string, unknown>[]> => {
    const t = quoteIdent(table);
    const pk = quoteIdent(pkColumn);
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.after !== undefined) {
      where.push(`${pk} > ?`);
      params.push(opts.after);
    }
    if (opts.since) {
      where.push(`${quoteIdent(opts.since.column)} >= ?`);
      params.push(opts.since.value);
    }
    params.push(opts.limit);
    return query(
      `SELECT * FROM ${t}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY ${pk} LIMIT ?`,
      params,
    );
  };

  const count = async (table: string): Promise<number> => {
    const rows = await query(`SELECT COUNT(*) AS n FROM ${quoteIdent(table)}`);
    return Number(rows[0]?.n ?? 0);
  };

  return { kind: "mysql", listTables, inspect, readBatch, count };
};
