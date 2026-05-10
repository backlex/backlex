import { Hono } from "hono";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { AppError } from "@workeros/core";
import * as pg from "@workeros/db/pg";
import * as sqlite from "@workeros/db/sqlite";
import {
  applyCollection,
  derivePhysicalTable,
  dropCollection,
  validateFields,
} from "@workeros/db";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { seedOwnerScopedPermissions } from "../services/seed";
import { logActivity } from "../services/activity";
import { cascadeSlugRename } from "../services/collection-rename";

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
    interface: z.enum(["dropdown", "richtext", "color"]).optional(),
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
  })
  .refine((f) => f.type !== "relation" || !!f.to, {
    message: "relation field must specify `to` (target collection slug)",
    path: ["to"],
  });

const CollectionInput = z.object({
  slug: z.string().min(1).regex(/^[a-z][a-z0-9_]*$/),
  singular: z.string().optional(),
  plural: z.string().optional(),
  note: z.string().optional(),
  displayTemplate: z.string().optional(),
  fields: z.array(FieldSchema).min(1),
  ownerScoped: z.boolean().optional().default(false),
  /** When true (default), the physical table gets a `tenant_id` column and
   *  rows are scoped to the active tenant. */
  tenantScoped: z.boolean().optional().default(true),
  versioned: z.boolean().optional().default(false),
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
  });
