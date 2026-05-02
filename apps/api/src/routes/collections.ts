import { Hono } from "hono";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { AppError } from "@workeros/core";
import * as pg from "@workeros/db/pg";
import * as sqlite from "@workeros/db/sqlite";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";

const FieldSchema = z.object({
  name: z.string().min(1).regex(/^[a-z][a-z0-9_]*$/, "snake_case"),
  type: z.enum([
    "string",
    "text",
    "integer",
    "number",
    "boolean",
    "json",
    "timestamp",
    "uuid",
    "vector",
  ]),
  required: z.boolean().optional(),
  unique: z.boolean().optional(),
  default: z.unknown().optional(),
  dimensions: z.number().int().positive().optional(),
});

const CollectionInput = z.object({
  slug: z.string().min(1).regex(/^[a-z][a-z0-9_]*$/),
  fields: z.array(FieldSchema).min(1),
  ownerScoped: z.boolean().optional().default(false),
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
    const row = await (db as any).select().from(t).where(eq(t.slug, c.req.param("slug"))).limit(1);
    if (!row[0]) throw new AppError("NOT_FOUND", "Collection not found");
    return c.json({ data: row[0] });
  })
  .post("/", requireUser, async (c) => {
    const body = CollectionInput.parse(await c.req.json());
    const { db, dialect } = c.get("ctx");
    const t = tableFor(dialect);
    const existing = await (db as any).select().from(t).where(eq(t.slug, body.slug)).limit(1);
    if (existing[0]) throw new AppError("CONFLICT", "Slug already exists");
    await (db as any).insert(t).values({
      slug: body.slug,
      fields: body.fields,
      ownerScoped: body.ownerScoped,
    });
    return c.json({ data: body }, 201);
  })
  .patch("/:slug", requireUser, async (c) => {
    const body = CollectionInput.partial().parse(await c.req.json());
    const { db, dialect } = c.get("ctx");
    const t = tableFor(dialect);
    await (db as any).update(t).set({
      ...(body.fields ? { fields: body.fields } : {}),
      ...(body.ownerScoped !== undefined ? { ownerScoped: body.ownerScoped } : {}),
      updatedAt: new Date(),
    }).where(eq(t.slug, c.req.param("slug")));
    return c.json({ ok: true });
  })
  .delete("/:slug", requireUser, async (c) => {
    const { db, dialect } = c.get("ctx");
    const t = tableFor(dialect);
    await (db as any).delete(t).where(eq(t.slug, c.req.param("slug")));
    return c.json({ ok: true });
  });
