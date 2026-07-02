/**
 * MongoDB source connector (CLI-side). MongoDB has no schema catalog, so
 * `inspect` INFERS one by sampling documents: field union across the sample,
 * majority-vote typing, sparse fields nullable. The inference emits the same
 * synthetic dbType tokens the shared mapper already understands, so the rest
 * of the pipeline (plan → collections → ingest) is unchanged.
 *
 * Driver-agnosticism: instead of a SQL executor, the connector wraps a
 * {@link DocumentSource} — the CLI backs it with the `mongodb` driver, tests
 * with an in-memory fake. Driver-specific concerns (ObjectId↔hex cursor
 * round-trips, Date coercion for `since`) live in the CLI's implementation.
 *
 * What doesn't exist here, by nature of the source:
 *   - foreign keys — Mongo has none, so no relation auto-wiring. Values are
 *     copied verbatim; preserved PKs mean a field can be flipped to
 *     `relation` in the plan file by hand and still resolve.
 *   - fields outside the sample — documents are free-form; keys never seen
 *     in the sampled set aren't copied. The CLI surfaces this as a per-table
 *     plan warning (tune with --sample-size).
 */
import type {
  ReadBatchOptions,
  SourceColumn,
  SourceConnector,
  SourceInspection,
  SourceTable,
} from "./types";

/** Minimal document-store surface the connector needs. Implementations must
 *  return JSON-safe rows: ObjectId values as hex strings, Date values may
 *  stay Date instances (they serialize to ISO). `findBatch` must order by
 *  `_id` ascending and treat `afterId` as an exclusive lower bound. */
export interface DocumentSource {
  listCollections(): Promise<string[]>;
  count(collection: string): Promise<number>;
  /** Up to `limit` documents used ONLY for schema inference. */
  sample(collection: string, limit: number): Promise<Record<string, unknown>[]>;
  findBatch(
    collection: string,
    opts: ReadBatchOptions,
  ): Promise<Record<string, unknown>[]>;
}

export const MONGO_DEFAULT_SAMPLE = 500;

const HEX24 = /^[0-9a-f]{24}$/i;

type Inferred =
  | "boolean"
  | "integer"
  | "number"
  | "string"
  | "longstring"
  | "timestamp"
  | "json";

const classify = (v: unknown): Inferred | null => {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  if (v instanceof Date) return "timestamp";
  if (typeof v === "string") return v.length > 255 ? "longstring" : "string";
  return "json"; // objects, arrays, anything exotic
};

/** Merge two inferred types into the narrowest common one. */
const widen = (a: Inferred, b: Inferred): Inferred => {
  if (a === b) return a;
  const pair = new Set([a, b]);
  if (pair.has("integer") && pair.has("number")) return "number";
  if (pair.has("string") && pair.has("longstring")) return "longstring";
  // Anything else disagreeing (string vs number, date vs string, …) can only
  // be stored losslessly as JSON.
  return "json";
};

/** Synthetic dbType token for the shared mapper. */
const toDbType = (t: Inferred): string =>
  t === "boolean"
    ? "boolean"
    : t === "integer"
      ? "bigint"
      : t === "number"
        ? "double precision"
        : t === "string"
          ? "varchar(255)"
          : t === "longstring"
            ? "text"
            : t === "timestamp"
              ? "timestamptz"
              : "jsonb";

/** Infer a tabular column model from sampled documents. Exported for tests. */
export const inferColumns = (
  docs: Record<string, unknown>[],
): { columns: SourceColumn[]; idDbType: string } => {
  const types = new Map<string, Inferred>();
  const seenIn = new Map<string, number>();
  let idType: Inferred | null = null;
  for (const doc of docs) {
    for (const [key, value] of Object.entries(doc)) {
      const t = classify(value);
      if (key === "_id") {
        if (t) idType = idType ? widen(idType, t) : t;
        continue;
      }
      if (t === null) continue; // nulls don't vote, they only mark nullable
      seenIn.set(key, (seenIn.get(key) ?? 0) + 1);
      const prev = types.get(key);
      types.set(key, prev ? widen(prev, t) : t);
    }
  }
  const columns: SourceColumn[] = [...types.entries()].map(([name, t]) => ({
    name,
    dbType: toDbType(t),
    // Sparse or sometimes-null fields are nullable; only fields present and
    // non-null in EVERY sampled doc count as required.
    nullable: (seenIn.get(name) ?? 0) < docs.length,
  }));
  // _id: hex ObjectId strings and free-form strings key as text; all-numeric
  // ids as integer. Empty collections default to text.
  const idDbType =
    idType === "integer"
      ? "bigint"
      : idType === "number"
        ? "double precision" // unmappable as a PK → table excluded with reason
        : "varchar(64)";
  return { columns, idDbType };
};

export const createMongoSource = (
  client: DocumentSource,
  opts: { sampleSize?: number } = {},
): SourceConnector => {
  const sampleSize = Math.max(1, opts.sampleSize ?? MONGO_DEFAULT_SAMPLE);

  const listTables = async (): Promise<SourceTable[]> => {
    const names = (await client.listCollections())
      .filter((n) => !n.startsWith("system."))
      .sort();
    const out: SourceTable[] = [];
    for (const name of names) {
      out.push({ name, approxRows: await client.count(name) });
    }
    return out;
  };

  const inspect = async (table: string): Promise<SourceInspection> => {
    const docs = await client.sample(table, sampleSize);
    const { columns, idDbType } = inferColumns(docs);
    return {
      table,
      columns,
      pk: { column: "_id", dbType: idDbType },
      foreignKeys: [], // no FK catalog in a document store
    };
  };

  const readBatch = (
    table: string,
    pkColumn: string,
    batchOpts: ReadBatchOptions,
  ): Promise<Record<string, unknown>[]> => {
    if (pkColumn !== "_id") {
      throw new Error(`MongoDB sources page by "_id" (got "${pkColumn}")`);
    }
    return client.findBatch(table, batchOpts);
  };

  return {
    kind: "mongodb",
    listTables,
    inspect,
    readBatch,
    count: (table) => client.count(table),
  };
};

/** Is this value a hex ObjectId string? (Driver impls use it to decide
 *  whether a resume cursor needs re-wrapping into an ObjectId.) */
export const looksLikeObjectIdHex = (v: unknown): v is string =>
  typeof v === "string" && HEX24.test(v);
