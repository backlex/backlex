/**
 * Source-column → backlex-field type mapping.
 *
 * A superset of the adopt flow's `suggestFieldType` (services/adopt.ts):
 * migration COPIES data into columns we create, so types the adopt flow
 * must reject (it can't reshape someone else's table) get a lossy-but-useful
 * fallback here instead — enums become `text` + dropdown choices, arrays
 * become `json`. Every fallback is reported as a warning so the plan stays
 * honest about what changed shape.
 */
import type { SourceColumn } from "./types";

/** Mirror of @backlex/db's FieldType — kept as a literal union so this
 *  package stays dependency-free. `plan.ts` output feeds straight into
 *  `POST /api/collections`, which validates against the real union. */
export type PlanFieldType =
  | "text"
  | "longtext"
  | "integer"
  | "number"
  | "boolean"
  | "json"
  | "timestamp"
  | "uuid"
  | "relation";

export interface MappedColumn {
  type: PlanFieldType;
  /** Dropdown choices, when the source column was an enum. */
  choices?: string[];
  /** Set when the mapping is lossy or approximate. */
  warning?: string;
}

/** Map one source column. Returns null when the type has no sane copy
 *  target (the plan excludes the column and records why). */
export const mapColumn = (col: SourceColumn): MappedColumn | null => {
  const raw = col.dbType;
  const t = raw.toLowerCase().replace(/\(.*\)/, "").trim();
  const sizeMatch = raw.match(/\((\d+)/);
  const size = sizeMatch ? Number(sizeMatch[1]) : null;

  // PG arrays report as `ARRAY` (information_schema) or `_type` (udt).
  if (t === "array" || t.startsWith("_")) {
    return {
      type: "json",
      warning: `array column "${col.name}" (${raw}) copied as json — element type is not preserved`,
    };
  }
  if (col.enumValues && col.enumValues.length > 0) {
    return {
      type: "text",
      choices: col.enumValues,
      warning: `enum column "${col.name}" copied as text with dropdown choices (${col.enumValues.length} values) — DB-level enum constraint becomes an API-level check`,
    };
  }
  if (t === "uuid" || t === "uniqueidentifier") return { type: "uuid" };
  if (
    t === "varchar" ||
    t === "character varying" ||
    t === "char" ||
    t === "character" ||
    t === "text" ||
    t === "citext" ||
    t === "nvarchar" ||
    t === "nchar"
  ) {
    if (t === "text" || t === "citext") return { type: "longtext" };
    if (size !== null && size > 255) return { type: "longtext" };
    return { type: "text" };
  }
  if (
    t === "int" ||
    t === "int2" ||
    t === "int4" ||
    t === "int8" ||
    t === "integer" ||
    t === "smallint" ||
    t === "bigint" ||
    t === "tinyint" ||
    t === "mediumint" ||
    t === "serial" ||
    t === "bigserial"
  ) {
    return { type: "integer" };
  }
  if (t === "numeric" || t === "decimal") {
    return {
      type: "number",
      warning: `decimal column "${col.name}" copied as double-precision number — exact decimal semantics are not preserved`,
    };
  }
  if (
    t === "real" ||
    t === "double precision" ||
    t === "double" ||
    t === "float" ||
    t === "float4" ||
    t === "float8"
  ) {
    return { type: "number" };
  }
  if (t === "boolean" || t === "bool") return { type: "boolean" };
  if (t === "json" || t === "jsonb") return { type: "json" };
  if (
    t === "timestamp" ||
    t === "timestamptz" ||
    t === "timestamp with time zone" ||
    t === "timestamp without time zone" ||
    t === "datetime" ||
    t === "date" ||
    t === "time"
  ) {
    return { type: "timestamp" };
  }
  if (t === "bytea" || t === "blob" || t === "binary" || t === "varbinary") {
    return null; // binary payloads don't belong in a JSON row copy
  }
  return null; // geometry / custom domains / anything unknown
};

/** PK column type → collection pkType. Null = the PK type can't key a
 *  backlex collection (the plan excludes the table). */
export const mapPkType = (
  dbType: string,
): "uuid" | "text" | "integer" | null => {
  const mapped = mapColumn({ name: "id", dbType, nullable: false });
  if (!mapped) return null;
  if (mapped.type === "uuid") return "uuid";
  if (mapped.type === "integer") return "integer";
  if (mapped.type === "text" || mapped.type === "longtext") return "text";
  return null;
};

/** System-column detection patterns, in priority order — the first present
 *  AND type-compatible column wins. Same list the adopt wizard uses. */
export const SYSTEM_COLUMN_PATTERNS = {
  createdAt: [
    "created_at",
    "createdAt",
    "inserted_at",
    "insertedAt",
    "date_created",
    "dateCreated",
    "created",
    "insert_time",
  ],
  updatedAt: [
    "updated_at",
    "updatedAt",
    "modified_at",
    "modifiedAt",
    "last_modified",
    "lastModified",
    "updated",
    "modify_time",
  ],
} as const;
