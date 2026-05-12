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
  .refine((f) => f.type !== "relation" || !!f.to, {
    message: "relation field must specify `to` (target collection slug)",
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
    const rows = await (db as any).select().from(t).where(eq(t.tenantId, tenantId));
    return c.json({ data: rows });
  })
  .get("/:slug", async (c) => {
    const { db, dialect } = c.get("ctx");
    const tenantId = requireTenant(c);
    const t = tableFor(dialect);
    const row = await (db as any)
      .select()
      .from(t)
      .where(and(eq(t.tenantId, tenantId), eq(t.slug, c.req.param("slug"))))
      .limit(1);
    if (!row[0]) throw new AppError("NOT_FOUND", "Collection not found");
    return c.json({ data: row[0] });
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
    });
    await applyCollection(db, dialect, {
      table: physicalTable,
      fields: body.fields,
      ownerScoped: body.ownerScoped,
      tenantScoped: body.tenantScoped,
      versioned: body.versioned,
    });
    if (body.ownerScoped) {
      await seedOwnerScopedPermissions({ db, dialect }, tenantId, body.slug);
    }
    await logActivity(c, {
      action: "create",
      collection: "system_collections",
      itemId: body.slug,
      payload: { fields: body.fields.length },
    });
    return c.json({ data: { id, ...body, tenantId, physicalTable } }, 201);
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
    });
    if (merged.ownerScoped) {
      await seedOwnerScopedPermissions({ db, dialect }, tenantId, nextSlug);
    }
    await logActivity(c, {
      action: "update",
      collection: "system_collections",
      itemId: nextSlug,
      payload: renameCounts ? { ...body, _rename: { from: slug, to: nextSlug, ...renameCounts } } : body,
    });
    return c.json({ ok: true, slug: nextSlug, renamed: renameCounts });
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
    await dropCollection(db, dialect, physicalTable);
    await (db as any)
      .delete(t)
      .where(and(eq(t.tenantId, tenantId), eq(t.slug, slug)));
    await logActivity(c, {
      action: "delete",
      collection: "system_collections",
      itemId: slug,
    });
    return c.json({ ok: true });
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
    await logActivity(c, {
      action: "vectorize",
      collection: "system_collections",
      itemId: slug,
      payload: { processed, skipped, total },
    });
    return c.json({ ok: true, processed, skipped, total });
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
