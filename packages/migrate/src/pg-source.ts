/**
 * Postgres source connector. All statements are read-only introspection /
 * SELECTs against the CALLER's database — this package never writes to the
 * source. Identifier safety: table/column names woven into SQL text are
 * validated against a strict pattern first (values always go through
 * parameters).
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

export const createPgSource = (query: SourceQuery): SourceConnector => {
  const listTables = async (): Promise<SourceTable[]> => {
    const rows = await query(
      `SELECT c.relname AS name, c.reltuples::bigint AS approx
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema()
          AND c.relkind = 'r'
        ORDER BY c.relname`,
    );
    return rows.map((r) => ({
      name: String(r.name),
      approxRows: r.approx === null || r.approx === undefined || Number(r.approx) < 0
        ? null
        : Number(r.approx),
    }));
  };

  const inspect = async (table: string): Promise<SourceInspection> => {
    quoteIdent(table);
    const cols = await query(
      `SELECT column_name, data_type, udt_name, is_nullable
         FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = $1
        ORDER BY ordinal_position`,
      [table],
    );
    if (cols.length === 0) {
      throw new Error(`Table "${table}" not found in current schema`);
    }
    // Enum labels for USER-DEFINED columns, one query for the whole table.
    const enumUdts = [
      ...new Set(
        cols
          .filter((c) => String(c.data_type) === "USER-DEFINED")
          .map((c) => String(c.udt_name)),
      ),
    ];
    const enumsByUdt = new Map<string, string[]>();
    if (enumUdts.length > 0) {
      const enumRows = await query(
        `SELECT t.typname, e.enumlabel
           FROM pg_type t
           JOIN pg_enum e ON e.enumtypid = t.oid
          WHERE t.typname = ANY($1)
          ORDER BY t.typname, e.enumsortorder`,
        [enumUdts],
      );
      for (const r of enumRows) {
        const k = String(r.typname);
        const list = enumsByUdt.get(k) ?? [];
        list.push(String(r.enumlabel));
        enumsByUdt.set(k, list);
      }
    }

    const pkRows = await query(
      `SELECT a.attname AS column_name, format_type(a.atttypid, a.atttypmod) AS data_type
         FROM pg_index i
         JOIN pg_class c ON c.oid = i.indrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
        WHERE n.nspname = current_schema()
          AND c.relname = $1
          AND i.indisprimary`,
      [table],
    );

    const fkRows = await query(
      `SELECT con.conname,
              src.attname  AS column_name,
              ref.relname  AS references_table,
              dst.attname  AS references_column,
              cardinality(con.conkey) AS width,
              k.ord
         FROM pg_constraint con
         JOIN pg_class c ON c.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_class ref ON ref.oid = con.confrelid
         JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY
              AS k(src_attnum, dst_attnum, ord) ON true
         JOIN pg_attribute src ON src.attrelid = con.conrelid AND src.attnum = k.src_attnum
         JOIN pg_attribute dst ON dst.attrelid = con.confrelid AND dst.attnum = k.dst_attnum
        WHERE con.contype = 'f'
          AND n.nspname = current_schema()
          AND c.relname = $1
        ORDER BY con.conname, k.ord`,
      [table],
    );
    const foreignKeys: SourceForeignKey[] = fkRows.map((r) => ({
      column: String(r.column_name),
      referencesTable: String(r.references_table),
      referencesColumn: String(r.references_column),
      composite: Number(r.width) > 1,
    }));

    return {
      table,
      columns: cols.map((c) => {
        const udt = String(c.udt_name ?? "");
        const enumValues =
          String(c.data_type) === "USER-DEFINED" ? enumsByUdt.get(udt) : undefined;
        return {
          name: String(c.column_name),
          // information_schema says `ARRAY` for arrays; the udt (`_int4`)
          // is more useful downstream, so prefer it there. Enums keep the
          // generic marker + labels.
          dbType:
            String(c.data_type) === "ARRAY"
              ? udt || "array"
              : enumValues
                ? "enum"
                : String(c.data_type),
          nullable: String(c.is_nullable) === "YES",
          ...(enumValues ? { enumValues } : {}),
        };
      }),
      pk:
        pkRows.length === 1
          ? {
              column: String(pkRows[0]!.column_name),
              dbType: String(pkRows[0]!.data_type),
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
    if (opts.after === undefined) {
      return query(`SELECT * FROM ${t} ORDER BY ${pk} LIMIT $1`, [opts.limit]);
    }
    return query(
      `SELECT * FROM ${t} WHERE ${pk} > $1 ORDER BY ${pk} LIMIT $2`,
      [opts.after, opts.limit],
    );
  };

  const count = async (table: string): Promise<number> => {
    const t = quoteIdent(table);
    const rows = await query(`SELECT COUNT(*) AS n FROM ${t}`);
    return Number(rows[0]?.n ?? 0);
  };

  return { kind: "postgres", listTables, inspect, readBatch, count };
};
