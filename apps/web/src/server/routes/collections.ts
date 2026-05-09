import { Hono } from "hono";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { AppError } from "@workeros/core";
import * as pg from "@workeros/db/pg";
import * as sqlite from "@workeros/db/sqlite";
import {
  applyCollection,
  dropCollection,
  validateFields,
} from "@workeros/db";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { seedOwnerScopedPermissions } from "../services/seed";

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
      .object({ values: z.array(z.string()).optional() })
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
  /** When true (default), c_<slug> gets a `tenant_id` and is scoped per workspace. */
  tenantScoped: z.boolean().optional().default(true),
  versioned: z.boolean().optional().default(false),
});

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.collections : sqlite.schema.collections;

export const collectionsRoutes = new Hono<AppBindings>()
  .get("/", async (c) => {
    const { db, dialect } = c.get("ctx");
    const t = tableFor(dialect);
    const rows = await (db as any).select().from(t);
    return c.json({ data: rows });
  })
  .get("/:slug", async (c) => {
    const { db, dialect } = c.get("ctx");
    const t = tableFor(dialect);
    const row = await (db as any)
      .select()
      .from(t)
      .where(eq(t.slug, c.req.param("slug")))
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
    const t = tableFor(dialect);
    const existing = await (db as any)
      .select()
      .from(t)
      .where(eq(t.slug, body.slug))
      .limit(1);
    if (existing[0]) throw new AppError("CONFLICT", "Slug already exists");

    await (db as any).insert(t).values({
      slug: body.slug,
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
      slug: body.slug,
      fields: body.fields,
      ownerScoped: body.ownerScoped,
      tenantScoped: body.tenantScoped,
      versioned: body.versioned,
    });
    if (body.ownerScoped) {
      await seedOwnerScopedPermissions({ db, dialect }, body.slug);
    }
    return c.json({ data: body }, 201);
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
    const t = tableFor(dialect);
    const existing = await (db as any)
      .select()
      .from(t)
      .where(eq(t.slug, slug))
      .limit(1);
    if (!existing[0]) throw new AppError("NOT_FOUND", "Collection not found");

    const merged = {
      ...existing[0],
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
    await (db as any).update(t).set(merged).where(eq(t.slug, slug));
    await applyCollection(db, dialect, {
      slug,
      fields: merged.fields,
      ownerScoped: merged.ownerScoped,
      tenantScoped: merged.tenantScoped ?? merged.tenant_scoped ?? true,
      versioned: merged.versioned,
    });
    if (merged.ownerScoped) {
      await seedOwnerScopedPermissions({ db, dialect }, slug);
    }
    return c.json({ ok: true });
  })
  .delete("/:slug", requireUser, async (c) => {
    const slug = c.req.param("slug");
    const { db, dialect } = c.get("ctx");
    const t = tableFor(dialect);
    await dropCollection(db, dialect, slug);
    await (db as any).delete(t).where(eq(t.slug, slug));
    return c.json({ ok: true });
  });
