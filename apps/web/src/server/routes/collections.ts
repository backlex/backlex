import { Hono } from "hono";
import { z } from "zod";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { AppError, EMBEDDING_MODEL_NAMES, type EmbeddingModel } from "@backlex/core";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import {
  applyCollection,
  assertIdent,
  derivePhysicalTable,
  dropCollection,
  type FieldDef,
  tableExists,
  validateFields,
} from "@backlex/db";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { inspectTable, RESERVED_NAMES } from "../services/adopt";
import { seedOwnerScopedPermissions } from "../services/seed";
import { invalidateTenantPermissions } from "../services/permissions-cache";
import { logActivity } from "../services/activity";
import { cascadeSlugRename } from "../services/collection-rename";
import { embedAndUpsertBatch, isVectorizable } from "../services/vectorize";

const FieldSchema = z
  .object({
    name: z.string().min(1).regex(/^[a-z][a-z0-9_]*$/, "snake_case"),
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
    to: z
      .string()
      .regex(/^[a-z][a-z0-9_]*$/, "snake_case")
      .optional(),
    // UI hint only — never affects storage or security, so any catalog id
    // from the admin's interface picker (apps/web/src/client/admin/interfaces.ts)
    // is accepted. `dropdown` still gets its choices enforced by validateFields.
    interface: z.string().min(1).max(64).optional(),
    options: z
      .object({
        values: z.array(z.string()).optional(),
        choices: z
          .array(
            z.object({
              value: z.string().min(1),
              label: z.string().optional(),
              color: z.string().optional(),
              icon: z.string().optional(),
            }),
          )
          .optional(),
      })
      .optional(),
    validation: z
      .object({
        regex: z.string().optional(),
        min: z.number().optional(),
        max: z.number().optional(),
        minLength: z.number().int().nonnegative().optional(),
        maxLength: z.number().int().nonnegative().optional(),
      })
      .optional(),
    visibleWhen: z
      .object({
        field: z.string().regex(/^[a-z][a-z0-9_]*$/),
        op: z.enum(["_eq", "_neq", "_in"]),
        value: z.unknown(),
      })
      .optional(),
    group: z.string().optional(),
    /** Include this field in the embed text when the collection has
     *  `vectorize: true`. Only meaningful on text/longtext fields. */
    vectorize: z.boolean().optional(),
  })
  .refine((f) => (f.type !== "relation" && f.type !== "relation_many") || !!f.to, {
    message: "relation / relation_many field must specify `to` (target collection slug)",
    path: ["to"],
  });

const ModelEnum = z.enum(
  EMBEDDING_MODEL_NAMES as [EmbeddingModel, ...EmbeddingModel[]],
);

const CollectionInput = z.object({
  slug: z.string().min(1).regex(/^[a-z][a-z0-9_]*$/),
  singular: z.string().optional(),
  plural: z.string().optional(),
  note: z.string().optional(),
  displayTemplate: z.string().optional(),
  fields: z.array(FieldSchema),
  ownerScoped: z.boolean().optional().default(false),
  /** When true (default), the physical table gets a `tenant_id` column and
   *  rows are scoped to the active tenant. */
  tenantScoped: z.boolean().optional().default(true),
  versioned: z.boolean().optional().default(false),
  /** Master switch — when true, item writes auto-embed fields with
   *  `vectorize: true` and the bulk endpoint backfills existing rows. */
  vectorize: z.boolean().optional().default(false),
  /** Embedding model key. Null → fall back to env.EMBEDDING_DEFAULT_MODEL. */
  vectorizeModel: ModelEnum.nullable().optional(),
  /** Comma-separated default sort (`"-published_at,name"`). Field-level
   *  validity is enforced by `parseQuery` at read time against the
   *  caller's permission allow-list; here we only constrain shape. */
  defaultSort: z
    .string()
    .regex(/^[-+]?[a-z_][a-z0-9_]*(,[-+]?[a-z_][a-z0-9_]*)*$/)
    .nullable()
    .optional(),
  /** Physical table name. Optional for managed creates (defaults to
   *  `derivePhysicalTable(tenantId, slug)`); required when `adopted=true`.
   *  Custom names are allowed for managed collections too — useful when a
   *  caller wants a friendlier table name than `c_<prefix>_<slug>`. */
  physicalTable: z.string().min(1).max(120).optional(),
  /** When true, register an *existing* physical table without DDL. The
   *  table must already exist; field names, PK, and any column aliases are
   *  validated against the live table shape before the metadata row is
   *  written. Default is false (managed create — DDL runs). */
  adopted: z.boolean().optional().default(false),
  /** PK column name. Ignored for managed creates (always `"id"`); for
   *  adopted creates, must match the introspected primary key. */
  pkColumn: z.string().min(1).max(120).optional(),
  /** Adopted-only flags asserting the source table has the conventional
   *  system column. Ignored for managed creates (always true). */
  hasCreatedAt: z.boolean().optional(),
  hasUpdatedAt: z.boolean().optional(),
  /** Adopted-only: alias an existing column to a system field. e.g.
   *  `createdAtColumn: "inserted_at"` makes routes/items.ts read
   *  `created_at` from `inserted_at` without DDL. Null/omitted = use the
   *  conventional name. Ignored for managed creates. */
  createdAtColumn: z.string().min(1).max(120).nullable().optional(),
  updatedAtColumn: z.string().min(1).max(120).nullable().optional(),
  /** Adopted-only: when set on an owner-scoped collection, ownership
   *  reads from this column on the source table instead of the
   *  `item_ownership` side-table. */
  ownerIdColumn: z.string().min(1).max(120).nullable().optional(),
});

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.collections : sqlite.schema.collections;

/** Pull the active tenant from the request, throwing if it isn't set.
 *  Collections are workspace-scoped — every route here needs one. */
const requireTenant = (c: { get: (k: string) => any }): string => {
  const tenantId = c.get("auth")?.tenantId as string | undefined;
  if (!tenantId) {
    throw new AppError("UNAUTHORIZED", "Active tenant required");
  }
  return tenantId;
};

export const collectionsRoutes = new Hono<AppBindings>()
  .get("/", async (c) => {
    const { db, dialect } = c.get("ctx");
    const tenantId = requireTenant(c);
    const t = tableFor(dialect);
    // Default hides archived (adopted) collections so the admin UI
    // doesn't have to know about the lifecycle column.
    // `?include_archived=true` opts into the full set — used by the
    // "Archived" panel that exposes restore.
    const includeArchived = c.req.query("include_archived") === "true";
    const rows = await (db as any)
      .select()
      .from(t)
      .where(
        includeArchived
          ? eq(t.tenantId, tenantId)
          : and(eq(t.tenantId, tenantId), eq(t.status, "active")),
      );
    return c.json({ data: rows });
  })
  .get("/:slug", async (c) => {
    const { db, dialect } = c.get("ctx");
    const tenantId = requireTenant(c);
    const t = tableFor(dialect);
    const includeArchived = c.req.query("include_archived") === "true";
    const row = await (db as any)
      .select()
      .from(t)
      .where(and(eq(t.tenantId, tenantId), eq(t.slug, c.req.param("slug"))))
      .limit(1);
    if (!row[0]) throw new AppError("NOT_FOUND", "Collection not found");
    if (!includeArchived && (row[0].status ?? "active") !== "active") {
      throw new AppError("NOT_FOUND", "Collection not found");
    }
    return c.json({ data: row[0] });
  })
  /**
   * Restore an archived (adopted) collection. No-op when the row is
   * already active; 404 when it doesn't exist. The `authenticated`
   * role's owner-scoped permissions are re-seeded so a restore is
   * one-shot, not "restore + re-grant permissions".
   */
  .post("/:slug/restore", requireUser, async (c) => {
    const slug = c.req.param("slug");
    const { db, dialect } = c.get("ctx");
    const tenantId = requireTenant(c);
    const t = tableFor(dialect);
    const existing = await (db as any)
      .select()
      .from(t)
      .where(and(eq(t.tenantId, tenantId), eq(t.slug, slug)))
      .limit(1);
    if (!existing[0]) throw new AppError("NOT_FOUND", "Collection not found");
    if ((existing[0].status ?? "active") === "active") {
      return c.json({ ok: true, alreadyActive: true });
    }
    await (db as any)
      .update(t)
      .set({ status: "active", archivedAt: null })
      .where(and(eq(t.tenantId, tenantId), eq(t.slug, slug)));
    if (existing[0].ownerScoped ?? existing[0].owner_scoped) {
      await seedOwnerScopedPermissions({ db, dialect }, tenantId, slug);
      invalidateTenantPermissions(tenantId);
    }
    await logActivity(c, {
      action: "restore",
      collection: "system_collections",
      itemId: slug,
      response: { ok: true },
    });
    return c.json({ ok: true });
  })
  /**
   * Unified create — one endpoint for both managed (we own the DDL) and
   * adopted (existing table, no DDL) collections. `body.adopted` controls
   * which path runs; the `physical_table` column is the single source of
   * truth either way, so the runtime read path doesn't branch.
   *
   *   Managed (`adopted: false`, default):
   *     - physicalTable optional, defaults to derivePhysicalTable(tenant, slug)
   *     - table must NOT exist (we're about to CREATE it)
   *     - pkColumn / hasCreatedAt / createdAtColumn / etc. ignored — always
   *       "id" + true + null
   *
   *   Adopted (`adopted: true`):
   *     - physicalTable required, table MUST exist
   *     - introspected via inspectTable; pkColumn must match the real PK,
   *       field names must exist on the table, alias columns must be present
   *       and type-compatible
   *     - applier short-circuits — never touches the user's table
   */
  .post("/", requireUser, async (c) => {
    const body = CollectionInput.parse(await c.req.json());
    try {
      validateFields(body.fields);
    } catch (e) {
      throw new AppError("VALIDATION", (e as Error).message);
    }
    const { db, dialect } = c.get("ctx");
    const tenantId = requireTenant(c);
    const t = tableFor(dialect);

    // Slug uniqueness per workspace.
    const slugConflict = await (db as any)
      .select({ id: t.id })
      .from(t)
      .where(and(eq(t.tenantId, tenantId), eq(t.slug, body.slug)))
      .limit(1);
    if (slugConflict[0]) throw new AppError("CONFLICT", "Slug already exists");

    let physicalTable: string;
    let pkColumn = "id";
    let hasCreatedAt = true;
    let hasUpdatedAt = true;
    let createdAtColumn: string | null = null;
    let updatedAtColumn: string | null = null;
    let ownerIdColumn: string | null = null;

    if (body.adopted) {
      if (!body.physicalTable) {
        throw new AppError(
          "VALIDATION",
          "physicalTable is required when adopted is true",
        );
      }
      try {
        assertIdent(body.physicalTable);
      } catch (e) {
        throw new AppError("VALIDATION", (e as Error).message);
      }
      physicalTable = body.physicalTable;
      if (!(await tableExists(db, dialect, physicalTable))) {
        throw new AppError("NOT_FOUND", `Table "${physicalTable}" not found`);
      }
      let inspection;
      try {
        inspection = await inspectTable({ db, dialect }, physicalTable);
      } catch (e) {
        const msg = (e as Error).message;
        if (/not found/i.test(msg)) throw new AppError("NOT_FOUND", msg);
        throw new AppError("VALIDATION", msg);
      }
      if (!inspection.pk) {
        throw new AppError(
          "VALIDATION",
          `Table "${physicalTable}" has no primary key — adoption requires a single-column PK`,
        );
      }
      pkColumn = body.pkColumn ?? inspection.pk.column;
      if (pkColumn !== inspection.pk.column) {
        throw new AppError(
          "VALIDATION",
          `pkColumn "${pkColumn}" does not match the table's primary key column "${inspection.pk.column}"`,
        );
      }
      const colNames = new Set(inspection.columns.map((col) => col.name));
      for (const f of body.fields) {
        if (!colNames.has(f.name)) {
          throw new AppError(
            "VALIDATION",
            `Field "${f.name}" not found on table "${physicalTable}"`,
          );
        }
        // The pkColumn override may legitimately point at "id"; everything
        // else colliding with a reserved name is a footgun.
        if (RESERVED_NAMES.has(f.name) && f.name !== pkColumn) {
          throw new AppError(
            "VALIDATION",
            `Field name "${f.name}" collides with a reserved system column`,
          );
        }
      }
      // Alias resolution. We never invent columns; an alias pointing nowhere
      // would silently corrupt reads.
      const colByName = new Map(
        inspection.columns.map((col) => [col.name, col] as const),
      );
      const validateAlias = (
        logical: "createdAt" | "updatedAt" | "ownerId",
        raw: string | null | undefined,
      ): string | null => {
        if (!raw) return null;
        const col = colByName.get(raw);
        if (!col) {
          throw new AppError(
            "VALIDATION",
            `${logical}Column "${raw}" not found on table "${physicalTable}"`,
          );
        }
        if (logical === "ownerId") {
          if (
            col.suggested !== "text" &&
            col.suggested !== "longtext" &&
            col.suggested !== "uuid"
          ) {
            throw new AppError(
              "VALIDATION",
              `${logical}Column "${raw}" must be a text/uuid type (got ${col.dbType})`,
            );
          }
        } else {
          if (col.suggested !== "timestamp" && col.suggested !== "integer") {
            throw new AppError(
              "VALIDATION",
              `${logical}Column "${raw}" must be a timestamp/integer type (got ${col.dbType})`,
            );
          }
        }
        return raw;
      };
      // Normalize: an alias pointing at the conventional name is the same
      // as no alias (cleaner storage; routes/items.ts treats null as "use
      // the conventional name").
      createdAtColumn = validateAlias(
        "createdAt",
        body.createdAtColumn === "created_at" ? null : body.createdAtColumn,
      );
      updatedAtColumn = validateAlias(
        "updatedAt",
        body.updatedAtColumn === "updated_at" ? null : body.updatedAtColumn,
      );
      ownerIdColumn = validateAlias(
        "ownerId",
        body.ownerIdColumn === "owner_id" ? null : body.ownerIdColumn,
      );
      hasCreatedAt =
        Boolean(createdAtColumn) ||
        (body.hasCreatedAt ?? false) ||
        inspection.systemColumnsPresent.createdAt;
      hasUpdatedAt =
        Boolean(updatedAtColumn) ||
        (body.hasUpdatedAt ?? false) ||
        inspection.systemColumnsPresent.updatedAt;
      if (
        body.hasCreatedAt &&
        !inspection.systemColumnsPresent.createdAt &&
        !createdAtColumn
      ) {
        throw new AppError(
          "VALIDATION",
          "hasCreatedAt is true but the table has no created_at column (use createdAtColumn to alias an existing column instead)",
        );
      }
      if (
        body.hasUpdatedAt &&
        !inspection.systemColumnsPresent.updatedAt &&
        !updatedAtColumn
      ) {
        throw new AppError(
          "VALIDATION",
          "hasUpdatedAt is true but the table has no updated_at column",
        );
      }
      if (ownerIdColumn && !body.ownerScoped) {
        throw new AppError(
          "VALIDATION",
          "ownerIdColumn is set but ownerScoped is false — drop one or the other",
        );
      }
    } else {
      // Managed path. Custom physicalTable is allowed but optional — the
      // default `c_<tenantPrefix12>_<slug>` keeps two workspaces from
      // colliding when they happen to pick the same slug.
      if (body.physicalTable) {
        try {
          assertIdent(body.physicalTable);
        } catch (e) {
          throw new AppError("VALIDATION", (e as Error).message);
        }
        physicalTable = body.physicalTable;
      } else {
        physicalTable = derivePhysicalTable(tenantId, body.slug);
      }
      if (await tableExists(db, dialect, physicalTable)) {
        throw new AppError(
          "CONFLICT",
          `Physical table "${physicalTable}" already exists. To register it as a collection, set adopted=true instead.`,
        );
      }
    }

    // Physical-table uniqueness check (friendly per-workspace error; the
    // DB-level `collections_physical_table_idx` enforces the hard guarantee).
    const tableConflict = await (db as any)
      .select({ slug: t.slug })
      .from(t)
      .where(and(eq(t.tenantId, tenantId), eq(t.physicalTable, physicalTable)))
      .limit(1);
    if (tableConflict[0]) {
      throw new AppError(
        "CONFLICT",
        `Physical table "${physicalTable}" is already registered as collection "${tableConflict[0].slug}"`,
      );
    }

    const id = crypto.randomUUID();
    await (db as any).insert(t).values({
      id,
      slug: body.slug,
      tenantId,
      physicalTable,
      singular: body.singular ?? null,
      plural: body.plural ?? null,
      note: body.note ?? null,
      displayTemplate: body.displayTemplate ?? null,
      fields: body.fields,
      ownerScoped: body.ownerScoped,
      tenantScoped: body.tenantScoped,
      versioned: body.versioned,
      vectorize: body.vectorize,
      vectorizeModel: body.vectorizeModel ?? null,
      defaultSort: body.defaultSort ?? null,
      adopted: body.adopted,
      pkColumn,
      hasCreatedAt,
      hasUpdatedAt,
      createdAtColumn,
      updatedAtColumn,
      ownerIdColumn,
    });
    await applyCollection(db, dialect, {
      table: physicalTable,
      fields: body.fields,
      ownerScoped: body.ownerScoped,
      tenantScoped: body.tenantScoped,
      versioned: body.versioned,
      adopted: body.adopted,
    });
    if (body.ownerScoped) {
      await seedOwnerScopedPermissions({ db, dialect }, tenantId, body.slug);
      invalidateTenantPermissions(tenantId);
    }
    const created = {
      id,
      slug: body.slug,
      tenantId,
      physicalTable,
      singular: body.singular ?? null,
      plural: body.plural ?? null,
      note: body.note ?? null,
      displayTemplate: body.displayTemplate ?? null,
      fields: body.fields,
      ownerScoped: body.ownerScoped,
      tenantScoped: body.tenantScoped,
      versioned: body.versioned,
      vectorize: body.vectorize,
      vectorizeModel: body.vectorizeModel ?? null,
      defaultSort: body.defaultSort ?? null,
      adopted: body.adopted,
      pkColumn,
      hasCreatedAt,
      hasUpdatedAt,
      createdAtColumn,
      updatedAtColumn,
      ownerIdColumn,
    };
    await logActivity(c, {
      action: "create",
      collection: "system_collections",
      itemId: body.slug,
      payload: { fields: body.fields.length, adopted: body.adopted },
      response: { data: created },
    });
    return c.json({ data: created }, 201);
  })
  .patch("/:slug", requireUser, async (c) => {
    const slug = c.req.param("slug");
    const body = CollectionInput.partial().parse(await c.req.json());
    if (body.fields) {
      try {
        validateFields(body.fields);
      } catch (e) {
        throw new AppError("VALIDATION", (e as Error).message);
      }
    }
    const { db, dialect } = c.get("ctx");
    const tenantId = requireTenant(c);
    const t = tableFor(dialect);
    const existing = await (db as any)
      .select()
      .from(t)
      .where(and(eq(t.tenantId, tenantId), eq(t.slug, slug)))
      .limit(1);
    if (!existing[0]) throw new AppError("NOT_FOUND", "Collection not found");

    // Slug rename: only when the body explicitly sends a different slug.
    // Validate target uniqueness within the tenant before touching anything,
    // then cascade the slug to every place it's stored as data (permissions,
    // revisions, comments, activity, webhook patterns, function patterns,
    // flow ops). The physical table name is not touched.
    let renameCounts: Awaited<ReturnType<typeof cascadeSlugRename>> | null = null;
    let nextSlug = slug;
    if (body.slug && body.slug !== slug) {
      const conflict = await (db as any)
        .select({ slug: t.slug })
        .from(t)
        .where(and(eq(t.tenantId, tenantId), eq(t.slug, body.slug)))
        .limit(1);
      if (conflict[0]) {
        throw new AppError("CONFLICT", `Collection slug "${body.slug}" already exists in this workspace`);
      }
      nextSlug = body.slug;
    }

    const merged = {
      ...existing[0],
      ...(nextSlug !== slug ? { slug: nextSlug } : {}),
      ...(body.singular !== undefined ? { singular: body.singular } : {}),
      ...(body.plural !== undefined ? { plural: body.plural } : {}),
      ...(body.note !== undefined ? { note: body.note } : {}),
      ...(body.displayTemplate !== undefined
        ? { displayTemplate: body.displayTemplate }
        : {}),
      ...(body.fields ? { fields: body.fields } : {}),
      ...(body.ownerScoped !== undefined
        ? { ownerScoped: body.ownerScoped }
        : {}),
      ...(body.tenantScoped !== undefined
        ? { tenantScoped: body.tenantScoped }
        : {}),
      ...(body.versioned !== undefined ? { versioned: body.versioned } : {}),
      ...(body.vectorize !== undefined ? { vectorize: body.vectorize } : {}),
      ...(body.vectorizeModel !== undefined
        ? { vectorizeModel: body.vectorizeModel ?? null }
        : {}),
      ...(body.defaultSort !== undefined
        ? { defaultSort: body.defaultSort ?? null }
        : {}),
      updatedAt: new Date(),
    };
    await (db as any)
      .update(t)
      .set(merged)
      .where(and(eq(t.tenantId, tenantId), eq(t.slug, slug)));

    if (nextSlug !== slug) {
      renameCounts = await cascadeSlugRename(db, dialect, tenantId, slug, nextSlug);
      // Permission rows just got their `collection` rewritten; cached entries
      // keyed by the old slug would still claim allow=true.
      invalidateTenantPermissions(tenantId);
    }

    await applyCollection(db, dialect, {
      table: merged.physicalTable ?? merged.physical_table,
      fields: merged.fields,
      ownerScoped: merged.ownerScoped,
      tenantScoped: merged.tenantScoped ?? merged.tenant_scoped ?? true,
      versioned: merged.versioned,
      adopted: Boolean(merged.adopted),
    });
    if (merged.ownerScoped) {
      await seedOwnerScopedPermissions({ db, dialect }, tenantId, nextSlug);
      invalidateTenantPermissions(tenantId);
    }
    const updateResponse = { ok: true, slug: nextSlug, renamed: renameCounts };
    await logActivity(c, {
      action: "update",
      collection: "system_collections",
      itemId: nextSlug,
      payload: renameCounts ? { ...body, _rename: { from: slug, to: nextSlug, ...renameCounts } } : body,
      response: updateResponse,
    });
    return c.json(updateResponse);
  })
  .delete("/:slug", requireUser, async (c) => {
    const slug = c.req.param("slug");
    const { db, dialect } = c.get("ctx");
    const tenantId = requireTenant(c);
    const t = tableFor(dialect);
    const existing = await (db as any)
      .select()
      .from(t)
      .where(and(eq(t.tenantId, tenantId), eq(t.slug, slug)))
      .limit(1);
    if (!existing[0]) throw new AppError("NOT_FOUND", "Collection not found");
    const physicalTable = (existing[0].physicalTable ?? existing[0].physical_table) as string;
    const adopted = Boolean(existing[0].adopted);
    if (adopted) {
      // Archive adopted collections: physical table is intact (the
      // applier already short-circuits on adopted), so flipping
      // `status` on the metadata row is enough. The data stays
      // queryable directly on the source DB; only workeros stops
      // treating the table as a collection. `POST /:slug/restore`
      // flips it back. We DON'T do this for managed collections
      // because their `c_<slug>` table is about to be dropped — a
      // restorable row with no data behind it would be a lie.
      await (db as any)
        .update(t)
        .set({ status: "archived", archivedAt: new Date() })
        .where(and(eq(t.tenantId, tenantId), eq(t.slug, slug)));
    } else {
      // Managed collections — physical `c_<slug>` table goes too; the
      // metadata row is hard-deleted. There's nothing to restore.
      await dropCollection(db, dialect, physicalTable, { adopted });
      await (db as any)
        .delete(t)
        .where(and(eq(t.tenantId, tenantId), eq(t.slug, slug)));
      // Permission rows referencing this slug are now ghosts; cached lookups
      // would still say "allowed" for a slug that no longer exists.
      invalidateTenantPermissions(tenantId);
    }
    await logActivity(c, {
      action: adopted ? "archive" : "delete",
      collection: "system_collections",
      itemId: slug,
      payload: { adopted, archived: adopted },
      response: { ok: true },
    });
    return c.json({ ok: true, archived: adopted });
  })
  /**
   * Backfill: embed every existing row in the collection's physical table
   * and upsert into the vector store. Synchronous + paginated (100 rows per
   * batch, one provider call per batch). The collection must have
   * `vectorize: true` and at least one text/longtext field with
   * `vectorize: true`.
   *
   * Returns `{ processed, total, skipped }` — `skipped` counts rows whose
   * vectorize fields are all empty (nothing to embed).
   */
  .post("/:slug/vectorize", requireUser, async (c) => {
    const slug = c.req.param("slug");
    const ctx = c.get("ctx");
    const { db, dialect } = ctx;
    const tenantId = requireTenant(c);
    const t = tableFor(dialect);
    const rows = await (db as any)
      .select()
      .from(t)
      .where(and(eq(t.tenantId, tenantId), eq(t.slug, slug)))
      .limit(1);
    if (!rows[0]) throw new AppError("NOT_FOUND", "Collection not found");
    const r = rows[0] as Record<string, unknown>;
    const meta = {
      slug,
      vectorize: Boolean(r.vectorize),
      vectorizeModel:
        ((r.vectorizeModel ?? r.vectorize_model) as string | null | undefined) ??
        null,
      fields: r.fields as FieldDef[],
    };
    if (!meta.vectorize) {
      throw new AppError(
        "VALIDATION",
        `Collection "${slug}" has vectorize disabled. Enable it on the collection first.`,
      );
    }
    if (!isVectorizable(meta, ctx.env)) {
      throw new AppError(
        "VALIDATION",
        "No embedding model resolves for this collection, or no field is marked `vectorize: true`. " +
          "Pick a model (or set EMBEDDING_DEFAULT_MODEL) and flag at least one text/longtext field.",
      );
    }
    const physicalTable = (r.physicalTable ?? r.physical_table) as string;
    const tenantWhere: SQL = sql`${sql.identifier("tenant_id")} = ${tenantId}`;
    const totalRow = await runQuery<{ count: number | string | bigint }>(
      ctx,
      sql`SELECT COUNT(*) AS count FROM ${sql.identifier(physicalTable)} WHERE ${tenantWhere}`,
    );
    const total = Number(totalRow[0]?.count ?? 0);

    let processed = 0;
    let skipped = 0;
    let offset = 0;
    const batchSize = 100;
    while (offset < total) {
      const batch = await runQuery<Record<string, unknown>>(
        ctx,
        sql`SELECT * FROM ${sql.identifier(physicalTable)} WHERE ${tenantWhere} ORDER BY ${sql.identifier("id")} LIMIT ${batchSize} OFFSET ${offset}`,
      );
      if (batch.length === 0) break;
      const upserted = await embedAndUpsertBatch(
        ctx,
        meta,
        tenantId,
        batch.map((row) => ({ id: row.id as string, row })),
      );
      processed += upserted;
      skipped += batch.length - upserted;
      offset += batch.length;
    }
    const vectorizeResponse = { ok: true, processed, skipped, total };
    await logActivity(c, {
      action: "vectorize",
      collection: "system_collections",
      itemId: slug,
      payload: { processed, skipped, total },
      response: vectorizeResponse,
    });
    return c.json(vectorizeResponse);
  });

const runQuery = async <T>(
  ctx: { db: unknown; dialect: "pg" | "sqlite" },
  query: SQL,
): Promise<T[]> => {
  if (ctx.dialect === "pg") {
    const r = await (ctx.db as any).execute(query);
    if (Array.isArray(r)) return r as T[];
    if (r && typeof r === "object" && "rows" in r) return r.rows as T[];
    return r as T[];
  }
  return (await (ctx.db as any).all(query)) as T[];
};
