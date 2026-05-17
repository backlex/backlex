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
import { and, eq, inArray } from "drizzle-orm";
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
    "relation_many",
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
  /** Alias an existing column to a system field. e.g.
   *  `createdAtColumn: "inserted_at"` makes routes/items.ts read `created_at`
   *  from `inserted_at`, without DDL. When set, it also implies
   *  hasCreatedAt = true. Mutually exclusive in spirit with the
   *  `addCreatedAt` flag (both setting hasCreatedAt = true) — `addCreatedAt`
   *  is the "table actually has a created_at column" path, `createdAtColumn`
   *  is the "table has it under a different name" path. */
  createdAtColumn: z.string().min(1).max(120).nullable().optional(),
  updatedAtColumn: z.string().min(1).max(120).nullable().optional(),
  /** When set on an owner-scoped collection, ownership reads from this
   *  column on the source table directly instead of the `item_ownership`
   *  side-table. Useful when the table already carries a `user_id` /
   *  `created_by` column the admin wants to keep authoritative. */
  ownerIdColumn: z.string().min(1).max(120).nullable().optional(),
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
    const auth = c.get("auth");
    const body = z
      .object({ table: z.string().min(1).max(120) })
      .parse(await c.req.json());
    try {
      const data = await inspectTable(
        { db: ctx.db, dialect: ctx.dialect },
        body.table,
      );
      // Per-FK target collection lookup. Service layer doesn't know about
      // the request's tenant; we resolve here so the wizard can pre-fill
      // the relation dropdown with the matching slug. One SELECT covers
      // all FKs on the table (collections is a small metadata table).
      if (data.foreignKeys.length > 0 && auth.tenantId) {
        const t = tableFor(ctx.dialect);
        const parentTables = [...new Set(data.foreignKeys.map((fk) => fk.referencesTable))];
        const rows: { id: string; slug: string; physicalTable: string }[] = await (ctx.db as any)
          .select({ id: t.id, slug: t.slug, physicalTable: t.physicalTable })
          .from(t)
          .where(and(eq(t.tenantId, auth.tenantId), inArray(t.physicalTable, parentTables)));
        const byPhys = new Map(rows.map((r) => [r.physicalTable, { slug: r.slug, id: r.id }]));
        for (const fk of data.foreignKeys) {
          const hit = byPhys.get(fk.referencesTable);
          if (hit) fk.targetCollection = hit;
        }
      }
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
    // Resolve alias columns: must exist on the table, must have a
    // compatible workeros field type. We never invent columns; an alias
    // pointing nowhere would silently corrupt reads.
    const colByName = new Map(inspection.columns.map((c) => [c.name, c] as const));
    const validateAlias = (
      logical: "createdAt" | "updatedAt" | "ownerId",
      raw: string | null | undefined,
    ): string | null => {
      if (!raw) return null;
      const col = colByName.get(raw);
      if (!col) {
        throw new AppError("VALIDATION", `${logical}Column "${raw}" not found on table "${body.table}"`);
      }
      if (logical === "ownerId") {
        if (col.suggested !== "text" && col.suggested !== "longtext" && col.suggested !== "uuid") {
          throw new AppError("VALIDATION", `${logical}Column "${raw}" must be a text/uuid type (got ${col.dbType})`);
        }
      } else {
        if (col.suggested !== "timestamp" && col.suggested !== "integer") {
          throw new AppError("VALIDATION", `${logical}Column "${raw}" must be a timestamp/integer type (got ${col.dbType})`);
        }
      }
      return raw;
    };
    // Normalize: alias pointing at the conventional name is the same as no
    // alias (cleaner storage; routes/items.ts treats null as "use the
    // conventional name").
    const createdAtColumn = validateAlias("createdAt", body.createdAtColumn === "created_at" ? null : body.createdAtColumn);
    const updatedAtColumn = validateAlias("updatedAt", body.updatedAtColumn === "updated_at" ? null : body.updatedAtColumn);
    const ownerIdColumn = validateAlias("ownerId", body.ownerIdColumn === "owner_id" ? null : body.ownerIdColumn);

    // hasCreatedAt is true if: an alias was set, OR addCreatedAt was set
    // (and the conventional column exists), OR the conventional column is
    // already present. Same logic for updatedAt.
    const hasCreatedAt = Boolean(createdAtColumn) || body.addCreatedAt || inspection.systemColumnsPresent.createdAt;
    const hasUpdatedAt = Boolean(updatedAtColumn) || body.addUpdatedAt || inspection.systemColumnsPresent.updatedAt;
    if (body.addCreatedAt && !inspection.systemColumnsPresent.createdAt && !createdAtColumn) {
      throw new AppError(
        "VALIDATION",
        "addCreatedAt is true but the table has no created_at column (use createdAtColumn to alias an existing column instead)",
      );
    }
    if (body.addUpdatedAt && !inspection.systemColumnsPresent.updatedAt && !updatedAtColumn) {
      throw new AppError(
        "VALIDATION",
        "addUpdatedAt is true but the table has no updated_at column",
      );
    }
    if (ownerIdColumn && !body.ownerScoped) {
      throw new AppError(
        "VALIDATION",
        "ownerIdColumn is set but ownerScoped is false — drop one or the other",
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
      createdAtColumn,
      updatedAtColumn,
      ownerIdColumn,
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
