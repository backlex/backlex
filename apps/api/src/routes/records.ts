import { Hono } from "hono";
import { z } from "zod";
import { and, desc, eq, asc } from "drizzle-orm";
import { AppError } from "@workeros/core";
import * as pg from "@workeros/db/pg";
import * as sqlite from "@workeros/db/sqlite";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";

const tables = (dialect: "pg" | "sqlite") =>
  dialect === "pg"
    ? { records: pg.schema.records, collections: pg.schema.collections }
    : { records: sqlite.schema.records, collections: sqlite.schema.collections };

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  order: z.enum(["asc", "desc"]).default("desc"),
  orderBy: z.enum(["createdAt", "updatedAt"]).default("createdAt"),
});

const validateAgainstFields = (
  data: Record<string, unknown>,
  fields: Array<{ name: string; type: string; required?: boolean }>,
) => {
  for (const f of fields) {
    if (f.required && (data[f.name] === undefined || data[f.name] === null)) {
      throw new AppError("VALIDATION", `Field "${f.name}" is required`);
    }
  }
};

const loadCollection = async (
  db: any,
  dialect: "pg" | "sqlite",
  slug: string,
) => {
  const t = tables(dialect).collections;
  const row = await db.select().from(t).where(eq(t.slug, slug)).limit(1);
  if (!row[0]) throw new AppError("NOT_FOUND", `Collection "${slug}" not found`);
  return row[0] as { slug: string; fields: any[]; ownerScoped: boolean };
};

export const recordsRoutes = new Hono<AppBindings>()
  .get("/:slug", async (c) => {
    const { db, dialect } = c.get("ctx");
    const auth = c.get("auth");
    const q = ListQuery.parse(Object.fromEntries(new URL(c.req.url).searchParams));
    const collection = await loadCollection(db, dialect, c.req.param("slug"));
    const t = tables(dialect).records;

    const where = and(
      eq(t.collectionSlug, collection.slug),
      collection.ownerScoped && auth.userId
        ? eq(t.ownerId, auth.userId)
        : undefined,
    );

    const orderCol = q.orderBy === "updatedAt" ? t.updatedAt : t.createdAt;
    const rows = await (db as any)
      .select()
      .from(t)
      .where(where)
      .orderBy(q.order === "asc" ? asc(orderCol) : desc(orderCol))
      .limit(q.limit)
      .offset(q.offset);

    return c.json({ data: rows, limit: q.limit, offset: q.offset });
  })
  .get("/:slug/:id", async (c) => {
    const { db, dialect } = c.get("ctx");
    const collection = await loadCollection(db, dialect, c.req.param("slug"));
    const t = tables(dialect).records;
    const row = await (db as any)
      .select()
      .from(t)
      .where(and(eq(t.collectionSlug, collection.slug), eq(t.id, c.req.param("id"))))
      .limit(1);
    if (!row[0]) throw new AppError("NOT_FOUND", "Record not found");
    return c.json({ data: row[0] });
  })
  .post("/:slug", requireUser, async (c) => {
    const { db, dialect } = c.get("ctx");
    const auth = c.get("auth");
    const collection = await loadCollection(db, dialect, c.req.param("slug"));
    const data = (await c.req.json()) as Record<string, unknown>;
    validateAgainstFields(data, collection.fields as any);
    const t = tables(dialect).records;
    const id = crypto.randomUUID();
    await (db as any).insert(t).values({
      id,
      collectionSlug: collection.slug,
      ownerId: collection.ownerScoped ? auth.userId : null,
      data,
    });
    return c.json({ data: { id, ...data } }, 201);
  })
  .patch("/:slug/:id", requireUser, async (c) => {
    const { db, dialect } = c.get("ctx");
    const auth = c.get("auth");
    const collection = await loadCollection(db, dialect, c.req.param("slug"));
    const t = tables(dialect).records;
    const id = c.req.param("id");
    const existing = await (db as any)
      .select()
      .from(t)
      .where(and(eq(t.collectionSlug, collection.slug), eq(t.id, id)))
      .limit(1);
    if (!existing[0]) throw new AppError("NOT_FOUND", "Record not found");
    if (collection.ownerScoped && existing[0].ownerId !== auth.userId) {
      throw new AppError("FORBIDDEN", "Not your record");
    }
    const patch = (await c.req.json()) as Record<string, unknown>;
    const merged = { ...(existing[0].data as object), ...patch };
    await (db as any)
      .update(t)
      .set({ data: merged, updatedAt: new Date() })
      .where(eq(t.id, id));
    return c.json({ data: { id, ...merged } });
  })
  .delete("/:slug/:id", requireUser, async (c) => {
    const { db, dialect } = c.get("ctx");
    const auth = c.get("auth");
    const collection = await loadCollection(db, dialect, c.req.param("slug"));
    const t = tables(dialect).records;
    const id = c.req.param("id");
    const existing = await (db as any)
      .select()
      .from(t)
      .where(and(eq(t.collectionSlug, collection.slug), eq(t.id, id)))
      .limit(1);
    if (!existing[0]) throw new AppError("NOT_FOUND", "Record not found");
    if (collection.ownerScoped && existing[0].ownerId !== auth.userId) {
      throw new AppError("FORBIDDEN", "Not your record");
    }
    await (db as any).delete(t).where(eq(t.id, id));
    return c.json({ ok: true });
  });
