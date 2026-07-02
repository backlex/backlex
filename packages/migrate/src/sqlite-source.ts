/**
 * SQLite-file source connector (CLI-side, Bun-only there — the executor is a
 * bun:sqlite handle over a database FILE the user points at). Introspection
 * mirrors the adopt flow's SQLite inspector: sqlite_master for tables,
 * `PRAGMA table_info` for columns/PK, `PRAGMA foreign_key_list` for FKs.
 *
 * PRAGMA statements can't take bound parameters, so identifiers are
 * validated + inlined; data reads use `?` placeholders.
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
  return `"${name}"`;
};

export const createSqliteFileSource = (query: SourceQuery): SourceConnector => {
  const listTables = async (): Promise<SourceTable[]> => {
    const rows = await query(
      `SELECT name FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name`,
    );
    const out: SourceTable[] = [];
    for (const r of rows) {
      const name = String(r.name);
      if (!IDENT.test(name)) continue; // exotic names can't be quoted safely
      // A real COUNT is affordable on a local file (no network round-trip).
      const c = await query(`SELECT COUNT(*) AS n FROM ${quoteIdent(name)}`);
      out.push({ name, approxRows: Number(c[0]?.n ?? 0) });
    }
    return out;
  };

  const inspect = async (table: string): Promise<SourceInspection> => {
    const t = quoteIdent(table);
    const cols = await query(`PRAGMA table_info(${t})`);
    if (cols.length === 0) {
      throw new Error(`Table "${table}" not found in the database file`);
    }
    const pkCols = cols.filter((c) => Number(c.pk) > 0);

    const fkRows = await query(`PRAGMA foreign_key_list(${t})`);
    const byId = new Map<number, typeof fkRows>();
    for (const r of fkRows) {
      const id = Number(r.id);
      byId.set(id, [...(byId.get(id) ?? []), r]);
    }
    const foreignKeys: SourceForeignKey[] = [];
    for (const rows of byId.values()) {
      for (const r of rows) {
        let referencesColumn = r.to === null || r.to === undefined ? "" : String(r.to);
        // `REFERENCES parent` without a column list → resolve the parent PK.
        if (!referencesColumn && IDENT.test(String(r.table))) {
          const parentCols = await query(
            `PRAGMA table_info(${quoteIdent(String(r.table))})`,
          );
          const parentPk = parentCols.filter((c) => Number(c.pk) > 0);
          if (parentPk.length === 1) referencesColumn = String(parentPk[0]!.name);
        }
        foreignKeys.push({
          column: String(r.from),
          referencesTable: String(r.table),
          referencesColumn,
          composite: rows.length > 1,
        });
      }
    }

    return {
      table,
      columns: cols.map((c) => ({
        name: String(c.name),
        // Declared type (`VARCHAR(80)`, `INTEGER`, sometimes empty). The
        // shared mapper lower-cases + strips sizes; an empty declaration is
        // unmappable and gets excluded with a warning downstream.
        dbType: String(c.type ?? "") || "unknown",
        nullable: Number(c.notnull) === 0,
      })),
      pk:
        pkCols.length === 1
          ? { column: String(pkCols[0]!.name), dbType: String(pkCols[0]!.type ?? "integer") }
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

  return { kind: "sqlite-file", listTables, inspect, readBatch, count };
};
