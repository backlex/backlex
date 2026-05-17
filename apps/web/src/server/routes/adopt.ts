/**
 * Admin-only collection-adoption endpoints. Lets an admin register an
 * existing physical table as a workeros collection **without** any DDL on
 * that table.
 *
 * Three endpoints:
 *   - `GET  /tables`  — list adopt-eligible tables in the active DB.
 *   - `POST /inspect` — introspect a single table (columns, PK, etc.).
 *   - `POST /apply`   — write the `collections` metadata row + (optional)
 *                       owner-scoped permission seed. **Never touches the
 *                       physical table.**
 *
 * Mounted at `/api/admin/adopt` from `app.ts`. The schema applier's
 * `def.adopted === true` short-circuit + `routes/items.ts` flag-driven
 * column handling do the heavy lifting at runtime — this file is purely
 * the metadata-and-validation entry point.
 */
import { Hono } from "hono";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { AppError, SYSTEM_ROLES } from "@workeros/core";
import * as pg from "@workeros/db/pg";
import * as sqlite from "@workeros/db/sqlite";
import { applyCollection, validateFields, type FieldDef } from "@workeros/db";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import {
  inspectTable,
  listAdoptableTables,
  RESERVED_NAMES,
} from "../services/adopt";
import { seedOwnerScopedPermissions } from "../services/seed";

const requireAdmin = (auth: { roles: string[] }) => {
  if (!auth.roles.includes(SYSTEM_ROLES.admin))
    throw new AppError("FORBIDDEN", "Admin role required");
};

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.collections : sqlite.schema.collections;

const SLUG_RE = /^[a-z][a-z0-9_]*$/;

const FieldInput = z.object({
  name: z.string().min(1).regex(SLUG_RE, "snake_case"),
  type: z.enum([
    "text",
    "longtext",
    "integer",
    "number",
    "boolean",
    "json",
    "timestamp",
    "uuid",
    "relation",
  ]),
  required: z.boolean().optional(),
  unique: z.boolean().optional(),
  to: z.string().regex(SLUG_RE).optional(),
  interface: z.string().min(1).max(64).optional(),
});

const ApplyInput = z.object({
  table: z.string().min(1).max(120),
  slug: z.string().min(1).max(60).regex(SLUG_RE, "lowercase slug"),
  singular: z.string().optional(),
  plural: z.string().optional(),
  note: z.string().optional(),
  pkColumn: z.string().min(1).max(120),
  ownerScoped: z.boolean().optional().default(false),
  tenantScoped: z.boolean().optional().default(false),
  /** Caller can flag system columns present that they want us to treat as
   *  managed (so `parseQuery` default-sort + items.ts row shaping match). */
  addCreatedAt: z.boolean().optional().default(false),
  addUpdatedAt: z.boolean().optional().default(false),
  defaultSort: z
    .string()
    .regex(/^[-+]?[a-z_][a-z0-9_]*(,[-+]?[a-z_][a-z0-9_]*)*$/)
    .nullable()
    .optional(),
  fields: z.array(FieldInput),
});

export const adoptRoutes = new Hono<AppBindings>()
  .use("*", requireUser, async (c, next) => {
    requireAdmin(c.get("auth"));
    const auth = c.get("auth");
    if (!auth.tenantId) {
      throw new AppError("VALIDATION", "Active workspace required for collection adoption");
    }
    await next();
  })
  /**
   * List every physical table in the active database that is eligible for
   * adoption — i.e. not a managed `c_*` collection, not a workeros system
   * table, and not already adopted by this workspace.
   */
  .get("/tables", async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const t = tableFor(ctx.dialect);
    // Anything this workspace has already adopted is hidden — we don't
    // include cross-tenant adoptions because two workspaces in the same
    // physical DB sharing a table is a deliberate (admin-driven) action.
    const already = await (ctx.db as any)
      .select({ physicalTable: t.physicalTable, adopted: t.adopted })
      .from(t)
      .where(and(eq(t.tenantId, auth.tenantId!), eq(t.adopted, true)));
    const excluded = new Set<string>(
      (already as { physicalTable: string | null }[])
        .map((r) => r.physicalTable)
        .filter((n): n is string => Boolean(n)),
    );
    const data = await listAdoptableTables(
      { db: ctx.db, dialect: ctx.dialect },
      excluded,
    );
    return c.json({ data });
  })
  /**
   * Introspect a single physical table. Returns column shape + PK info +
   * which workeros system columns happen to already exist on the table
   * (we don't add or rename — admins read the inspection result, then
   * pass back the matching flags to `POST /apply`).
   */
  .post("/inspect", async (c) => {
    const ctx = c.get("ctx");
    const body = z
      .object({ table: z.string().min(1).max(120) })
      .parse(await c.req.json());
    try {
      const data = await inspectTable(
        { db: ctx.db, dialect: ctx.dialect },
        body.table,
      );
      return c.json({ data });
    } catch (e) {
      const msg = (e as Error).message;
      if (/not found/i.test(msg)) throw new AppError("NOT_FOUND", msg);
      throw new AppError("VALIDATION", msg);
    }
  })
  /**
   * Adopt a physical table. Validates the payload, ensures no slug or
   * `physical_table` conflict, writes the `collections` metadata row with
   * `adopted = true`, and seeds owner-scoped permissions when requested.
   *
   * **No DDL is sent against the user's table.** The schema applier short-
   * circuits on `adopted` — we still call it for symmetry with the managed
   * create path, but the call is a no-op by contract.
   */
  .post("/apply", async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const body = ApplyInput.parse(await c.req.json());

    // Field validation — same gate the regular create route uses. The
    // applier's `adopted` branch never runs the field code, but we still
    // want a clean error before we write the metadata row.
    try {
      validateFields(body.fields as FieldDef[]);
    } catch (e) {
      throw new AppError("VALIDATION", (e as Error).message);
    }
    // pk + addCreatedAt/addUpdatedAt sanity — we never invent columns,
    // so a flag the table can't honor would silently corrupt reads.
    let inspection;
    try {
      inspection = await inspectTable(
        { db: ctx.db, dialect: ctx.dialect },
        body.table,
      );
    } catch (e) {
      const msg = (e as Error).message;
      if (/not found/i.test(msg)) throw new AppError("NOT_FOUND", msg);
      throw new AppError("VALIDATION", msg);
    }
    if (!inspection.pk) {
      throw new AppError(
        "VALIDATION",
        `Table "${body.table}" has no primary key — adoption requires a single-column PK`,
      );
    }
    if (inspection.pk.column !== body.pkColumn) {
      throw new AppError(
        "VALIDATION",
        `pkColumn "${body.pkColumn}" does not match the table's primary key column "${inspection.pk.column}"`,
      );
    }
    const colNames = new Set(inspection.columns.map((c) => c.name));
    for (const f of body.fields) {
      if (!colNames.has(f.name)) {
        throw new AppError(
          "VALIDATION",
          `Field "${f.name}" not found on table "${body.table}"`,
        );
      }
      if (RESERVED_NAMES.has(f.name) && f.name !== body.pkColumn) {
        // The pkColumn override may legitimately point at "id"; everything
        // else colliding with a reserved name is a footgun.
        throw new AppError(
          "VALIDATION",
          `Field name "${f.name}" collides with a reserved system column`,
        );
      }
    }
    const hasCreatedAt = body.addCreatedAt || inspection.systemColumnsPresent.createdAt;
    const hasUpdatedAt = body.addUpdatedAt || inspection.systemColumnsPresent.updatedAt;
    if (body.addCreatedAt && !inspection.systemColumnsPresent.createdAt) {
      throw new AppError(
        "VALIDATION",
        "addCreatedAt is true but the table has no created_at column",
      );
    }
    if (body.addUpdatedAt && !inspection.systemColumnsPresent.updatedAt) {
      throw new AppError(
        "VALIDATION",
        "addUpdatedAt is true but the table has no updated_at column",
      );
    }

    const t = tableFor(ctx.dialect);

    // Conflict checks — slug unique per tenant, physical_table unique per
    // tenant (so the same physical table can't be adopted twice; but two
    // workspaces in the same physical DB sharing a table is still possible
    // by design, hence the tenant scope).
    const slugConflict = await (ctx.db as any)
      .select({ id: t.id })
      .from(t)
      .where(and(eq(t.tenantId, auth.tenantId!), eq(t.slug, body.slug)))
      .limit(1);
    if (slugConflict[0]) {
      throw new AppError(
        "CONFLICT",
        `Collection slug "${body.slug}" already exists in this workspace`,
      );
    }
    const tableConflict = await (ctx.db as any)
      .select({ slug: t.slug })
      .from(t)
      .where(and(eq(t.tenantId, auth.tenantId!), eq(t.physicalTable, body.table)))
      .limit(1);
    if (tableConflict[0]) {
      throw new AppError(
        "CONFLICT",
        `Table "${body.table}" is already adopted as collection "${tableConflict[0].slug}"`,
      );
    }

    // No-op DDL call — kept for parity with the managed create path so any
    // future side effects (e.g. realtime metadata broadcast) land here too.
    await applyCollection(ctx.db, ctx.dialect, {
      table: body.table,
      fields: body.fields as FieldDef[],
      ownerScoped: body.ownerScoped,
      tenantScoped: body.tenantScoped,
      versioned: false,
      adopted: true,
    });

    const id = crypto.randomUUID();
    await (ctx.db as any).insert(t).values({
      id,
      slug: body.slug,
      tenantId: auth.tenantId!,
      physicalTable: body.table,
      singular: body.singular ?? null,
      plural: body.plural ?? null,
      note: body.note ?? null,
      displayTemplate: null,
      fields: body.fields,
      ownerScoped: body.ownerScoped,
      tenantScoped: body.tenantScoped,
      versioned: false,
      vectorize: false,
      vectorizeModel: null,
      defaultSort: body.defaultSort ?? null,
      adopted: true,
      pkColumn: body.pkColumn,
      hasCreatedAt,
      hasUpdatedAt,
    });

    if (body.ownerScoped) {
      await seedOwnerScopedPermissions(
        { db: ctx.db, dialect: ctx.dialect },
        auth.tenantId!,
        body.slug,
      );
    }

    const created = {
      id,
      slug: body.slug,
      tenantId: auth.tenantId!,
      physicalTable: body.table,
      singular: body.singular ?? null,
      plural: body.plural ?? null,
      note: body.note ?? null,
      fields: body.fields,
      ownerScoped: body.ownerScoped,
      tenantScoped: body.tenantScoped,
      versioned: false,
      vectorize: false,
      defaultSort: body.defaultSort ?? null,
      adopted: true,
      pkColumn: body.pkColumn,
      hasCreatedAt,
      hasUpdatedAt,
    };
    return c.json({ data: created }, 201);
  });
