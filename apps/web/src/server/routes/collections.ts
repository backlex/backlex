import { Hono } from "hono";
import { z } from "zod";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { AppError, EMBEDDING_MODEL_NAMES, type EmbeddingModel } from "@workeros/core";
import * as pg from "@workeros/db/pg";
import * as sqlite from "@workeros/db/sqlite";
import {
  applyCollection,
  derivePhysicalTable,
  dropCollection,
  type FieldDef,
  validateFields,
} from "@workeros/db";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { seedOwnerScopedPermissions } from "../services/seed";
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
    }
    await logActivity(c, {
      action: "restore",
      collection: "system_collections",
      itemId: slug,
      response: { ok: true },
    });
    return c.json({ ok: true });
  })
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
    const existing = await (db as any)
      .select()
      .from(t)
      .where(and(eq(t.tenantId, tenantId), eq(t.slug, body.slug)))
      .limit(1);
    if (existing[0]) throw new AppError("CONFLICT", "Slug already exists");

    const id = crypto.randomUUID();
    const physicalTable = derivePhysicalTable(tenantId, body.slug);
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
    });
    await applyCollection(db, dialect, {
      table: physicalTable,
      fields: body.fields,
      ownerScoped: body.ownerScoped,
      tenantScoped: body.tenantScoped,
      versioned: body.versioned,
      // POST through this route always creates a managed table; the adopt
      // flow has its own service that inserts the row with `adopted=true`
      // and skips DDL via the applier's adopted branch.
      adopted: false,
    });
    if (body.ownerScoped) {
      await seedOwnerScopedPermissions({ db, dialect }, tenantId, body.slug);
    }
    const created = { id, ...body, tenantId, physicalTable };
    await logActivity(c, {
      action: "create",
      collection: "system_collections",
      itemId: body.slug,
      payload: { fields: body.fields.length },
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
