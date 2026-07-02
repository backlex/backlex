/**
 * Source-database abstraction for external-DB migration.
 *
 * The package is deliberately dependency-free: a connector never opens a
 * connection itself — the caller injects a {@link SourceQuery} executor
 * (postgres.js in the CLI, a pglite adapter in tests, the server's own
 * driver in the Phase-2 connector). That keeps introspection SQL testable
 * without a real TCP server and keeps this package out of the bundler's way.
 */

/** Execute one parameterized statement against the SOURCE database and
 *  return plain row objects. Placeholders are `$1..$n` (PG style); the
 *  executor adapts if its driver differs. */
export type SourceQuery = (
  sqlText: string,
  params?: unknown[],
) => Promise<Record<string, unknown>[]>;

export interface SourceTable {
  name: string;
  /** Planner estimate (`pg_class.reltuples`) — cheap, may lag reality.
   *  Null when the engine can't estimate. The copy loop never trusts it;
   *  verify uses a real COUNT(*). */
  approxRows: number | null;
}

export interface SourceColumn {
  name: string;
  /** Engine-reported type (`character varying`, `int8`, `USER-DEFINED`…). */
  dbType: string;
  nullable: boolean;
  /** For PG enum columns: the enum's labels, in order. Drives the
   *  enum → text + dropdown-choices mapping. */
  enumValues?: string[];
}

export interface SourceForeignKey {
  column: string;
  referencesTable: string;
  referencesColumn: string;
  /** Multi-column FK — detected and surfaced, but backlex relations are
   *  single-column so composite constraints never become `relation`. */
  composite: boolean;
}

export interface SourceInspection {
  table: string;
  columns: SourceColumn[];
  /** Single-column PK, or null (composite / missing PKs disqualify the
   *  table from the plan — the plan records why). */
  pk: { column: string; dbType: string } | null;
  foreignKeys: SourceForeignKey[];
}

export interface ReadBatchOptions {
  /** PK cursor — return rows with pk strictly greater. Omit for the first
   *  batch. Keyset paging (never OFFSET) so million-row tables stay O(batch). */
  after?: unknown;
  limit: number;
}

export interface SourceConnector {
  kind: "postgres";
  listTables(): Promise<SourceTable[]>;
  inspect(table: string): Promise<SourceInspection>;
  /** One keyset page, ordered by `pkColumn` ascending. */
  readBatch(
    table: string,
    pkColumn: string,
    opts: ReadBatchOptions,
  ): Promise<Record<string, unknown>[]>;
  count(table: string): Promise<number>;
}
