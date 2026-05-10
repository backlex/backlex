import { Hono } from "hono";
import { z } from "zod";
import { and, eq, isNull, or, type SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { AppError, SYSTEM_ROLES } from "@workeros/core";
import { compileCondition, type FieldDef } from "@workeros/db";
import * as pg from "@workeros/db/pg";
import * as sqlite from "@workeros/db/sqlite";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.savedPanels : sqlite.schema.savedPanels;

const collectionsTable = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.collections : sqlite.schema.collections;

const ITEMS_AGG_FUNCS = ["count", "sum", "avg", "min", "max"] as const;
type ItemsAggFunc = (typeof ITEMS_AGG_FUNCS)[number];

/** Numeric column types accepted as the agg target for sum/avg/min/max. */
const NUMERIC_FIELD_TYPES = new Set<string>(["integer", "number"]);

const ItemsAggregateConfig = z.object({
  collection: z.string().min(1),
  agg: z.enum(ITEMS_AGG_FUNCS),
  field: z.string().min(1).optional(),
  filter: z.record(z.unknown()).optional(),
  groupBy: z.string().min(1).optional(),
  limit: z.number().int().positive().max(200).optional(),
});

const PanelInput = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(500).nullable().optional(),
  kind: z.enum(["sql", "items-aggregate", "static"]).default("sql"),
  sql: z.string().nullable().optional(),
  viz: z.enum(["sparkline", "bars", "donut", "counter", "table"]).default("sparkline"),
  config: z.record(z.unknown()).nullable().optional(),
  layout: z
    .object({
      x: z.number().int(),
      y: z.number().int(),
      w: z.number().int().positive(),
      h: z.number().int().positive(),
    })
    .nullable()
    .optional(),
});

const requireAdmin = (auth: { roles: string[] }) => {
  if (!auth.roles.includes(SYSTEM_ROLES.admin))
    throw new AppError("FORBIDDEN", "Admin role required");
};

const requireTenant = (c: { get: (k: string) => any }): string => {
  const tenantId = c.get("auth")?.tenantId as string | undefined;
  if (!tenantId) throw new AppError("UNAUTHORIZED", "Active tenant required");
  return tenantId;
};

/**
 * Reject anything that isn't a single SELECT — protects the panel-run
 * endpoint from being abused as a generic SQL gateway. The Database page
 * has its own (more permissive but still gated) editor for that.
 */
const isReadOnly = (s: string): boolean => {
  const trimmed = s.trim().replace(/;$/, "");
  if (!/^select\b/i.test(trimmed)) return false;
  if (/\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|attach|detach)\b/i.test(trimmed)) {
    return false;
  }
  return true;
};

const queryAll = async <T>(
  ctx: { db: unknown; dialect: "pg" | "sqlite" },
  q: ReturnType<typeof sql.raw>,
): Promise<T[]> => {
  if (ctx.dialect === "pg") {
    const r = await (ctx.db as any).execute(q);
    if (Array.isArray(r)) return r as T[];
    if (r && typeof r === "object" && "rows" in r) return r.rows as T[];
    return r as T[];
  }
  return (await (ctx.db as any).all(q)) as T[];
};

export const panelsRoutes = new Hono<AppBindings>()
  .use("*", requireUser, async (c, next) => {
    requireAdmin(c.get("auth"));
    await next();
  })
  .get("/", async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const t = tableFor(ctx.dialect);
    const rows = await (ctx.db as any)
      .select()
      .from(t)
      .where(or(eq(t.tenantId, auth.tenantId ?? ""), isNull(t.tenantId)));
    return c.json({ data: rows });
  })
  .post("/", async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const body = PanelInput.parse(await c.req.json());
    if (body.kind === "sql" && body.sql && !isReadOnly(body.sql)) {
      throw new AppError("VALIDATION", "Panel SQL must be a single read-only SELECT.");
    }
    const t = tableFor(ctx.dialect);
    const id = crypto.randomUUID();
    await (ctx.db as any).insert(t).values({
      id,
      tenantId: auth.tenantId ?? null,
      name: body.name,
      description: body.description ?? null,
      kind: body.kind,
      sql: body.sql ?? null,
      viz: body.viz,
      config: body.config ?? null,
      layout: body.layout ?? null,
      createdBy: auth.userId,
    });
    return c.json({ data: { id, ...body } }, 201);
  })
  .patch("/:id", async (c) => {
    const ctx = c.get("ctx");
    const tenantId = requireTenant(c);
    const id = c.req.param("id");
    const body = PanelInput.partial().parse(await c.req.json());
    if (body.sql && !isReadOnly(body.sql)) {
      throw new AppError("VALIDATION", "Panel SQL must be a single read-only SELECT.");
    }
    const t = tableFor(ctx.dialect);
    await (ctx.db as any)
      .update(t)
      .set({
        ...body,
        updatedAt: ctx.dialect === "pg" ? new Date() : Date.now(),
      })
      // Allow editing global (tenantId NULL) panels too — system-seeded
      // dashboards belong to no workspace but should still be editable by
      // admins; admin role is already required above.
      .where(
        and(
          eq(t.id, id),
          or(eq(t.tenantId, tenantId), isNull(t.tenantId)),
        ),
      );
    return c.json({ ok: true });
  })
  .delete("/:id", async (c) => {
    const ctx = c.get("ctx");
    const tenantId = requireTenant(c);
    const t = tableFor(ctx.dialect);
    await (ctx.db as any)
      .delete(t)
      .where(
        and(
          eq(t.id, c.req.param("id")),
          or(eq(t.tenantId, tenantId), isNull(t.tenantId)),
        ),
      );
    return c.json({ ok: true });
  })
  /** Run an in-progress panel without saving it. The editor uses this for the
   *  "Run preview" button so authors can verify their query (or aggregate
   *  config) before committing the row. Same security gates as the saved-run
   *  endpoint — admin-only, SELECT-only for SQL, tenant-scoped for items. */
  .post("/preview", async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const tenantId = requireTenant(c);
    const body = (await c.req.json()) as { kind?: string; sql?: string; config?: unknown };
    if (body.kind === "items-aggregate") {
      const t0 = Date.now();
      const out = await runItemsAggregate(ctx, auth, tenantId, body.config);
      return c.json({ data: out, ms: Date.now() - t0 });
    }
    if (body.kind !== "sql" || !body.sql) {
      throw new AppError("VALIDATION", `Preview only supports kind "sql" or "items-aggregate" (got "${body.kind ?? "unknown"}")`);
    }
    if (!isReadOnly(body.sql)) {
      throw new AppError("FORBIDDEN", "Panel SQL is not read-only.");
    }
    try {
      const t0 = Date.now();
      const out = await queryAll<Record<string, unknown>>(
        { db: ctx.db, dialect: ctx.dialect },
        sql.raw(body.sql),
      );
      return c.json({ data: out, ms: Date.now() - t0 });
    } catch (e) {
      throw new AppError("VALIDATION", `SQL error: ${(e as Error).message}`);
    }
  })
  /** Run a saved panel — useful when the dashboard renders a sparkline. */
  .post("/:id/run", async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const tenantId = requireTenant(c);
    const t = tableFor(ctx.dialect);
    const rows = await (ctx.db as any)
      .select()
      .from(t)
      .where(
        and(
          eq(t.id, c.req.param("id")),
          or(eq(t.tenantId, tenantId), isNull(t.tenantId)),
        ),
      )
      .limit(1);
    const panel = rows[0];
    if (!panel) throw new AppError("NOT_FOUND", "Panel not found");

    if (panel.kind === "items-aggregate") {
      const t0 = Date.now();
      const out = await runItemsAggregate(ctx, auth, tenantId, panel.config);
      return c.json({ data: out, ms: Date.now() - t0 });
    }

    if (panel.kind !== "sql" || !panel.sql) {
      return c.json({ data: [], note: "Non-SQL panel — return static config to the UI." });
    }
    if (!isReadOnly(panel.sql as string)) {
      throw new AppError("FORBIDDEN", "Panel SQL is not read-only.");
    }
    try {
      const t0 = Date.now();
      const out = await queryAll<Record<string, unknown>>(
        { db: ctx.db, dialect: ctx.dialect },
        sql.raw(panel.sql as string),
      );
      return c.json({ data: out, ms: Date.now() - t0 });
    } catch (e) {
      throw new AppError("VALIDATION", `SQL error: ${(e as Error).message}`);
    }
  });

/**
 * Execute an items-aggregate panel. Resolves the collection's physical table,
 * validates the agg function + numeric column constraints, applies a tenant
 * filter (when the collection is tenant-scoped) AND the user's optional DSL
 * filter, and runs a single grouped or scalar query.
 *
 * Returns rows shaped like `[{ value: <n> }]` for non-grouped, or
 * `[{ label, value }, …]` for grouped — same wire format as a SQL panel,
 * so the existing client viz code (counter / sparkline / bars / donut /
 * table) renders without a special case.
 */
async function runItemsAggregate(
  ctx: { db: unknown; dialect: "pg" | "sqlite" },
  auth: { userId: string | null; email: string | null; tenantId?: string | null; roles: string[] },
  tenantId: string,
  rawConfig: unknown,
): Promise<Record<string, unknown>[]> {
  const parsed = ItemsAggregateConfig.safeParse(rawConfig ?? {});
  if (!parsed.success) {
    throw new AppError("VALIDATION", `Invalid items-aggregate config: ${parsed.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join(", ")}`);
  }
  const cfg = parsed.data;

  // Resolve collection metadata so we can map slug -> physical_table and
  // validate that field/groupBy names refer to actual columns.
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
  // System columns the user can also reference for groupBy/filter.
  const systemColumns = new Set(["id", "owner_id", "created_at", "updated_at"]);
  const isKnownColumn = (name: string) => fieldByName.has(name) || systemColumns.has(name);

  if (cfg.agg !== "count") {
    if (!cfg.field) throw new AppError("VALIDATION", `field is required for agg "${cfg.agg}"`);
    const f = fieldByName.get(cfg.field);
    if (!f) throw new AppError("VALIDATION", `Field "${cfg.field}" is not in collection "${cfg.collection}"`);
    if (!NUMERIC_FIELD_TYPES.has(f.type)) {
      throw new AppError("VALIDATION", `Field "${cfg.field}" must be numeric for agg "${cfg.agg}" (got "${f.type}")`);
    }
  } else if (cfg.field && cfg.field !== "*" && !isKnownColumn(cfg.field)) {
    throw new AppError("VALIDATION", `Field "${cfg.field}" is not in collection "${cfg.collection}"`);
  }

  if (cfg.groupBy && !isKnownColumn(cfg.groupBy)) {
    throw new AppError("VALIDATION", `groupBy field "${cfg.groupBy}" is not in collection "${cfg.collection}"`);
  }

  // value = COUNT(*) | <agg>(<field>)
  const valueExpr: SQL = cfg.agg === "count"
    ? sql`COUNT(*)`
    : sql`${sql.raw(cfg.agg.toUpperCase())}(${sql.identifier(cfg.field!)})`;

  const wheres: SQL[] = [];
  if (tenantScoped) {
    wheres.push(sql`${sql.identifier("tenant_id")} = ${tenantId}`);
  }
  if (cfg.filter && Object.keys(cfg.filter).length > 0) {
    wheres.push(compileCondition(cfg.filter as never, auth as never));
  }
  const whereClause: SQL = wheres.length === 0 ? sql`` : sql` WHERE ${sql.join(wheres, sql` AND `)}`;

  let q: SQL;
  if (cfg.groupBy) {
    const limit = cfg.limit ?? 50;
    q = sql`SELECT ${sql.identifier(cfg.groupBy)} AS label, ${valueExpr} AS value FROM ${sql.identifier(physical)}${whereClause} GROUP BY ${sql.identifier(cfg.groupBy)} ORDER BY value DESC LIMIT ${sql.raw(String(limit))}`;
  } else {
    q = sql`SELECT ${valueExpr} AS value FROM ${sql.identifier(physical)}${whereClause}`;
  }

  try {
    return await queryAll<Record<string, unknown>>({ db: ctx.db, dialect: ctx.dialect }, q);
  } catch (e) {
    throw new AppError("VALIDATION", `Aggregate query failed: ${(e as Error).message}`);
  }
}
