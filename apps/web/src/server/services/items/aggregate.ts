import { and, eq, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { AppError, normalizeCondition } from "@backlex/core";
import type { AuthSubject } from "@backlex/core";
import { compileCondition, type FieldDef } from "@backlex/db";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import { queryAll } from "./sql-helpers";

/**
 * Item aggregation engine — `count` / `sum` / `avg` / `min` / `max`, with an
 * optional `groupBy`. Extracted from routes/panels.ts so both dashboard panels
 * AND the items REST/aggregate endpoint + the `collections.aggregate` MCP tool
 * share one tested implementation.
 *
 * Permission posture: panels call this admin-only with no `perm` opts (legacy
 * behavior — tenant scope only). The REST endpoint passes the caller's resolved
 * read permission (`whereSql` AND-ed into the query; `fields` allow-list gating
 * the agg target + groupBy), so a non-admin can never aggregate over rows or
 * columns they can't read.
 */

export const ITEMS_AGG_FUNCS = ["count", "sum", "avg", "min", "max"] as const;
export type ItemsAggFunc = (typeof ITEMS_AGG_FUNCS)[number];

/** Numeric column types accepted as the agg target for sum/avg/min/max. */
export const NUMERIC_FIELD_TYPES = new Set<string>(["integer", "number"]);

export const ItemsAggregateConfig = z.object({
  collection: z.string().min(1),
  agg: z.enum(ITEMS_AGG_FUNCS),
  field: z.string().min(1).optional(),
  filter: z.record(z.string(), z.unknown()).optional(),
  groupBy: z.string().min(1).optional(),
  limit: z.number().int().positive().max(200).optional(),
});
export type ItemsAggregateConfigInput = z.input<typeof ItemsAggregateConfig>;

const collectionsTable = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.collections : sqlite.schema.collections;

export interface AggregateOpts {
  /** Permission whereSql AND-ed into the aggregate (null = unrestricted). */
  permWhere?: SQL | null;
  /** Readable field allow-list (null = all). When set, the agg `field` and
   *  `groupBy` must be inside it (or a system column) — else FORBIDDEN. */
  allowedFields?: Set<string> | null;
}

/**
 * Run an items aggregate. Returns either `[{ value }]` (no groupBy) or
 * `[{ label, value }, …]` (grouped, ordered by value desc, capped by `limit`).
 */
export const runItemsAggregate = async (
  ctx: { db: unknown; dialect: "pg" | "sqlite" },
  auth: AuthSubject,
  tenantId: string,
  rawConfig: unknown,
  opts: AggregateOpts = {},
): Promise<Record<string, unknown>[]> => {
  const parsed = ItemsAggregateConfig.safeParse(rawConfig ?? {});
  if (!parsed.success) {
    throw new AppError(
      "VALIDATION",
      `Invalid aggregate config: ${parsed.error.issues.map((e) => `${e.path.join(".")}: ${e.message}`).join(", ")}`,
    );
  }
  const cfg = parsed.data;

  const colTable = collectionsTable(ctx.dialect);
  const cRows = await (ctx.db as any)
    .select()
    .from(colTable)
    .where(and(eq(colTable.tenantId, tenantId), eq(colTable.slug, cfg.collection)))
    .limit(1);
  const cRow = cRows[0] as Record<string, unknown> | undefined;
  if (!cRow) throw new AppError("NOT_FOUND", `Collection "${cfg.collection}" not found`);
  const physical = (cRow.physicalTable ?? cRow.physical_table) as string;
  const fields = (cRow.fields ?? []) as FieldDef[];
  const tenantScoped = (cRow.tenantScoped ?? cRow.tenant_scoped ?? true) ? true : false;
  const fieldByName = new Map(fields.map((f) => [f.name, f]));
  const systemColumns = new Set(["id", "owner_id", "created_at", "updated_at"]);
  const isKnownColumn = (name: string) => fieldByName.has(name) || systemColumns.has(name);
  const allowed = opts.allowedFields;
  // Surface the real column names so a caller (or the AI planner's dry-run
  // retry) can correct a near-miss like `customer_id` → `customer` instead of
  // guessing again. Relations are flagged so the model doesn't append `_id`.
  const columnHint = (): string => {
    const names = [
      ...fields
        .filter((f) => !allowed || allowed.has(f.name))
        .map((f) =>
          f.type === "relation" || f.type === "relation_many"
            ? `${f.name} (relation)`
            : f.name,
        ),
      "id",
      "created_at",
      "updated_at",
    ];
    return names.join(", ");
  };
  const gateField = (name: string) => {
    if (allowed && !systemColumns.has(name) && !allowed.has(name)) {
      throw new AppError("FORBIDDEN", `No permission to read field: ${name}`);
    }
  };
  const numericHint = (): string =>
    fields
      .filter((f) => NUMERIC_FIELD_TYPES.has(f.type) && (!allowed || allowed.has(f.name)))
      .map((f) => f.name)
      .join(", ") || "(none)";

  if (cfg.agg !== "count") {
    if (!cfg.field) throw new AppError("VALIDATION", `field is required for agg "${cfg.agg}"`);
    const f = fieldByName.get(cfg.field);
    if (!f) {
      throw new AppError(
        "VALIDATION",
        `Field "${cfg.field}" is not in collection "${cfg.collection}". Numeric columns: ${numericHint()}`,
      );
    }
    if (!NUMERIC_FIELD_TYPES.has(f.type)) {
      throw new AppError(
        "VALIDATION",
        `Field "${cfg.field}" must be numeric for agg "${cfg.agg}" (got "${f.type}"). Numeric columns: ${numericHint()}`,
      );
    }
    gateField(cfg.field);
  } else if (cfg.field && cfg.field !== "*" && !isKnownColumn(cfg.field)) {
    throw new AppError(
      "VALIDATION",
      `Field "${cfg.field}" is not in collection "${cfg.collection}". Valid columns: ${columnHint()}`,
    );
  }

  if (cfg.groupBy) {
    if (!isKnownColumn(cfg.groupBy)) {
      throw new AppError(
        "VALIDATION",
        `groupBy field "${cfg.groupBy}" is not in collection "${cfg.collection}". Valid columns: ${columnHint()}`,
      );
    }
    gateField(cfg.groupBy);
  }

  const valueExpr: SQL =
    cfg.agg === "count"
      ? sql`COUNT(*)`
      : sql`${sql.raw(cfg.agg.toUpperCase())}(${sql.identifier(cfg.field!)})`;

  const wheres: SQL[] = [];
  if (tenantScoped) wheres.push(sql`${sql.identifier("tenant_id")} = ${tenantId}`);
  if (cfg.filter && Object.keys(cfg.filter).length > 0) {
    // Accept the same input shapes as the list endpoint (aliases, implicit-eq).
    // Schema-blind: aggregate has no relation joins, so nested-object relation
    // filters aren't flattened here — a dotted relation filter would error at
    // SQL, which is the correct signal that aggregate is single-table.
    wheres.push(
      compileCondition(normalizeCondition(cfg.filter), auth, undefined, undefined, {
        dialect: ctx.dialect,
      }),
    );
  }
  if (opts.permWhere) wheres.push(opts.permWhere);
  const whereClause: SQL = wheres.length === 0 ? sql`` : sql` WHERE ${sql.join(wheres, sql` AND `)}`;

  let q: SQL;
  if (cfg.groupBy) {
    const limit = cfg.limit ?? 50;
    q = sql`SELECT ${sql.identifier(cfg.groupBy)} AS label, ${valueExpr} AS value FROM ${sql.identifier(physical)}${whereClause} GROUP BY ${sql.identifier(cfg.groupBy)} ORDER BY value DESC LIMIT ${sql.raw(String(limit))}`;
  } else {
    q = sql`SELECT ${valueExpr} AS value FROM ${sql.identifier(physical)}${whereClause}`;
  }

  try {
    return await queryAll<Record<string, unknown>>(
      { db: ctx.db, dialect: ctx.dialect } as Parameters<typeof queryAll>[0],
      q,
    );
  } catch (e) {
    throw new AppError("VALIDATION", `Aggregate query failed: ${(e as Error).message}`);
  }
};
