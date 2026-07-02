/**
 * Bulk row ingest for external-DB migration (`POST /api/admin/migrate/ingest/:slug`).
 *
 * This is the one write path that deliberately does NOT go through
 * `performCreate`: a million-row copy can't afford per-row revisions,
 * realtime events, webhooks, or FTS/vector indexing — and it must preserve
 * the source's primary keys (the normal create path strips/regenerates them).
 * Preserved PKs are the whole trick: the source's FK values stay valid in
 * the target without an id-remap table.
 *
 * Contract:
 *   - Managed collections only (an adopted table already holds its data).
 *   - Multi-row `INSERT … ON CONFLICT DO NOTHING` — idempotent, so a
 *     half-finished migration can be re-run (`--resume`) without dupes.
 *   - Statements are chunked to stay under D1's ~100 bound-parameter cap.
 *   - No per-row side-effects. Callers backfill FTS/vectors afterwards via
 *     the existing `fts-reindex` / vectorize-backfill endpoints.
 *   - Structural validation only (unknown column, missing PK, NOT NULL
 *     holes). Soft validation rules are skipped — the source data is
 *     authoritative; relation membership is checked by the final verify
 *     step, not per row (FK-cycle-safe).
 */
import { sql } from "drizzle-orm";
import { AppError } from "@backlex/core";
import type { FieldDef } from "@backlex/db";
import type { Ctx } from "../context";
import type { CollectionRow } from "./items/collection-loader";
import { execute, queryAll } from "./items/sql-helpers";

export interface IngestFailure {
  /** Index into the request's `rows` array. */
  index: number;
  error: string;
}

export interface IngestResult {
  received: number;
  /** Rows that landed (measured as the tenant-scoped count delta — exact
   *  on both dialects without relying on driver-specific change counts). */
  inserted: number;
  /** insert mode: rows that hit ON CONFLICT (already present — typical on
   *  resume). Always 0 in upsert mode (conflicts update instead). */
  skipped: number;
  /** upsert mode: rows that matched an existing PK and were overwritten.
   *  Always 0 in insert mode. */
  updated: number;
  failed: IngestFailure[];
  /** Tenant-scoped row count in the target table after this call — the
   *  CLI's verify step compares it against the source COUNT(*). */
  total: number;
}

export type IngestMode = "insert" | "upsert";

/** Max rows per HTTP call — the CLI chunks larger copies client-side. */
export const INGEST_MAX_ROWS = 2000;

/** Bound-parameter budget per INSERT statement. D1 caps a statement at
 *  ~100 bound params; postgres.js allows far more, but one conservative
 *  constant keeps the chunking dialect-free. */
const PARAM_BUDGET = 90;

/** Timestamp coercion the shared `serialize` can't do: source values arrive
 *  as ISO strings, epoch numbers, or `YYYY-MM-DD HH:MM:SS` strings. */
const toMs = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (v instanceof Date) return v.getTime();
  const ms = Date.parse(String(v));
  return Number.isNaN(ms) ? null : ms;
};

const serializeTimestamp = (
  v: unknown,
  dialect: "pg" | "sqlite",
): string | number | null => {
  const ms = toMs(v);
  if (ms === null) return null;
  return dialect === "pg" ? new Date(ms).toISOString() : ms;
};

/** Field-value serialization for direct inserts. Mirrors items/serialize.ts
 *  but is lenient about numeric strings — postgres.js returns `bigint`
 *  columns as strings, and the CLI forwards them verbatim. */
const serializeField = (
  v: unknown,
  type: FieldDef["type"],
  dialect: "pg" | "sqlite",
): unknown => {
  if (v === null || v === undefined) return null;
  if (type === "timestamp") return serializeTimestamp(v, dialect);
  if (type === "integer" || type === "number") {
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) {
      return Number(v);
    }
    return v;
  }
  if (type === "boolean") {
    const b = typeof v === "number" ? v !== 0 : Boolean(v);
    return dialect === "pg" ? b : b ? 1 : 0;
  }
  if (type === "json" || type === "relation_many" || type === "i18n_text") {
    return dialect === "sqlite" ? JSON.stringify(v) : v;
  }
  return v;
};

interface ColumnPlan {
  column: string;
  value: (row: Record<string, unknown>, nowVal: string | number) => unknown;
}

const pickRaw = (
  row: Record<string, unknown>,
  ...keys: string[]
): unknown => {
  for (const k of keys) {
    if (row[k] !== undefined) return row[k];
  }
  return undefined;
};

export const ingestRows = async (
  ctx: Ctx,
  collection: CollectionRow,
  tenantId: string,
  rows: Record<string, unknown>[],
  opts: { mode?: IngestMode } = {},
): Promise<IngestResult> => {
  const mode: IngestMode = opts.mode ?? "insert";
  if (collection.adopted) {
    throw new AppError(
      "VALIDATION",
      "Ingest targets managed collections only — an adopted table already owns its data",
    );
  }
  if (rows.length > INGEST_MAX_ROWS) {
    throw new AppError(
      "VALIDATION",
      `Too many rows (${rows.length}); max ${INGEST_MAX_ROWS} per call — chunk client-side`,
    );
  }
  const { dialect } = ctx;
  const table = collection.physicalTable;
  const pk = collection.pkColumn;
  const nowVal: string | number =
    dialect === "pg" ? new Date().toISOString() : Date.now();

  // Insertable fields — computed columns regenerate themselves and can't be
  // written; everything else gets a slot in the (uniform) column plan.
  const insertableFields = collection.fields.filter((f) => !f.computed);

  const plan: ColumnPlan[] = [
    { column: pk, value: (row) => pickRaw(row, pk, "id") ?? null },
  ];
  if (collection.tenantScoped) {
    plan.push({ column: "tenant_id", value: () => tenantId });
  }
  if (collection.ownerScoped) {
    plan.push({
      column: "owner_id",
      value: (row) => {
        const v = pickRaw(row, "owner_id", "ownerId");
        return v === undefined || v === null || v === "" ? null : String(v);
      },
    });
  }
  if (collection.hasCreatedAt) {
    plan.push({
      column: collection.createdAtColumn ?? "created_at",
      value: (row, now) =>
        serializeTimestamp(pickRaw(row, "created_at", "createdAt"), dialect) ?? now,
    });
  }
  if (collection.hasUpdatedAt) {
    plan.push({
      column: collection.updatedAtColumn ?? "updated_at",
      value: (row, now) =>
        serializeTimestamp(pickRaw(row, "updated_at", "updatedAt"), dialect) ?? now,
    });
  }
  if (collection.softDelete) {
    plan.push({
      column: "deleted_at",
      value: (row) =>
        serializeTimestamp(pickRaw(row, "deleted_at", "deletedAt"), dialect),
    });
  }
  if (collection.versioned) {
    // Migrated rows default to `published` — a draft default would make the
    // entire copied dataset invisible to non-privileged readers.
    plan.push({
      column: "_status",
      value: (row) => {
        const v = pickRaw(row, "_status");
        return v === "draft" || v === "published" ? v : "published";
      },
    });
    plan.push({
      column: "_published_at",
      value: (row, now) => {
        const explicit = serializeTimestamp(pickRaw(row, "_published_at"), dialect);
        if (explicit !== null) return explicit;
        const status = pickRaw(row, "_status");
        return status === "draft" ? null : now;
      },
    });
  }
  for (const f of insertableFields) {
    plan.push({
      column: f.name,
      value: (row) => serializeField(row[f.name], f.type, dialect),
    });
  }

  // Structural validation — a typo'd source column must fail its row, not
  // silently drop data.
  const knownKeys = new Set<string>([
    pk,
    "id",
    "created_at",
    "createdAt",
    "updated_at",
    "updatedAt",
    "owner_id",
    "ownerId",
    "deleted_at",
    "deletedAt",
    "tenant_id",
    "_status",
    "_published_at",
    "_publish_at",
    ...collection.fields.map((f) => f.name),
  ]);
  const requiredFields = insertableFields.filter((f) => f.required);

  const failed: IngestFailure[] = [];
  const good: { index: number; values: unknown[] }[] = [];
  rows.forEach((row, index) => {
    const pkVal = pickRaw(row, pk, "id");
    if (pkVal === undefined || pkVal === null || pkVal === "") {
      failed.push({ index, error: `Primary key "${pk}" is required` });
      return;
    }
    if (typeof pkVal === "object") {
      failed.push({ index, error: `Primary key "${pk}" must be a scalar` });
      return;
    }
    const unknown = Object.keys(row).find((k) => !knownKeys.has(k));
    if (unknown) {
      failed.push({ index, error: `Unknown column "${unknown}"` });
      return;
    }
    const missing = requiredFields.find(
      (f) => row[f.name] === undefined || row[f.name] === null,
    );
    if (missing) {
      // A NULL in a NOT NULL column would abort the whole multi-row
      // statement — fail the row upfront so its chunk-mates still land.
      failed.push({ index, error: `Required field "${missing.name}" is null` });
      return;
    }
    good.push({ index, values: plan.map((p) => p.value(row, nowVal)) });
  });

  const countTarget = async (): Promise<number> => {
    const where = collection.tenantScoped
      ? sql` WHERE ${sql.identifier("tenant_id")} = ${tenantId}`
      : sql``;
    const r = await queryAll<{ n: number | string }>(
      ctx,
      sql`SELECT COUNT(*) AS n FROM ${sql.identifier(table)}${where}`,
    );
    return Number(r[0]?.n ?? 0);
  };

  const before = await countTarget();

  const colSql = sql.join(
    plan.map((p) => sql.identifier(p.column)),
    sql`, `,
  );
  // Upsert (`--since` delta re-sync): PK conflicts overwrite instead of
  // skip. `created_at` and `tenant_id` keep their original values — a delta
  // pass must not re-stamp creation time or move a row across tenants.
  // (Both dialects support `excluded`; a conflict on a NON-pk unique field
  // still errors and fails its chunk, same as insert mode.)
  const updatableCols = plan
    .map((p) => p.column)
    .filter(
      (c) =>
        c !== pk &&
        c !== "tenant_id" &&
        c !== (collection.createdAtColumn ?? "created_at"),
    );
  const conflictSql =
    mode === "upsert" && updatableCols.length > 0
      ? sql`ON CONFLICT (${sql.identifier(pk)}) DO UPDATE SET ${sql.join(
          updatableCols.map(
            (c) => sql`${sql.identifier(c)} = excluded.${sql.identifier(c)}`,
          ),
          sql`, `,
        )}`
      : sql`ON CONFLICT DO NOTHING`;
  const rowsPerStmt = Math.max(1, Math.floor(PARAM_BUDGET / plan.length));
  let attempted = 0;
  for (let i = 0; i < good.length; i += rowsPerStmt) {
    const chunk = good.slice(i, i + rowsPerStmt);
    const valuesSql = sql.join(
      chunk.map(
        (r) => sql`(${sql.join(r.values.map((v) => sql`${v}`), sql`, `)})`,
      ),
      sql`, `,
    );
    try {
      await execute(
        ctx,
        sql`INSERT INTO ${sql.identifier(table)} (${colSql}) VALUES ${valuesSql} ${conflictSql}`,
      );
      attempted += chunk.length;
    } catch (e) {
      // A chunk-level failure (type mismatch the DB rejects, etc.) fails
      // every row in the chunk; later chunks still run. ON CONFLICT keeps
      // a retry of the same payload safe.
      const msg = e instanceof AppError ? e.message : (e as Error).message;
      for (const r of chunk) failed.push({ index: r.index, error: msg });
    }
  }

  const total = await countTarget();
  const inserted = Math.max(0, total - before);
  const conflicted = Math.max(0, attempted - inserted);
  return {
    received: rows.length,
    inserted,
    skipped: mode === "upsert" ? 0 : conflicted,
    updated: mode === "upsert" ? conflicted : 0,
    failed: failed.sort((a, b) => a.index - b.index),
    total,
  };
};
