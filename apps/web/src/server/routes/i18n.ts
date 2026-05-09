import { Hono } from "hono";
import { z } from "zod";
import { and, eq, isNull, or } from "drizzle-orm";
import { AppError, SYSTEM_ROLES } from "@workeros/core";
import * as pg from "@workeros/db/pg";
import * as sqlite from "@workeros/db/sqlite";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.i18nStrings : sqlite.schema.i18nStrings;

const requireAdmin = (auth: { roles: string[] }) => {
  if (!auth.roles.includes(SYSTEM_ROLES.admin))
    throw new AppError("FORBIDDEN", "Admin role required");
};

const UpsertInput = z.object({
  key: z.string().min(1).max(120),
  locale: z.string().min(2).max(8),
  value: z.string(),
});

const BulkInput = z.array(UpsertInput);

interface I18nRow {
  id: string;
  tenantId: string | null;
  key: string;
  locale: string;
  value: string;
}

export const i18nRoutes = new Hono<AppBindings>()
  .use("*", requireUser, async (c, next) => {
    requireAdmin(c.get("auth"));
    await next();
  })
  /** Returns rows in row form. The UI pivots them into a key×locale table. */
  .get("/", async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const t = tableFor(ctx.dialect);
    const rows = (await (ctx.db as any)
      .select()
      .from(t)
      .where(
        or(eq(t.tenantId, auth.tenantId ?? ""), isNull(t.tenantId)),
      )) as I18nRow[];
    return c.json({ data: rows });
  })
  /** Convenience: full key×locale matrix. */
  .get("/_matrix", async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const t = tableFor(ctx.dialect);
    const rows = (await (ctx.db as any)
      .select()
      .from(t)
      .where(
        or(eq(t.tenantId, auth.tenantId ?? ""), isNull(t.tenantId)),
      )) as I18nRow[];
    const out: Record<string, Record<string, string>> = {};
    const locales = new Set<string>();
    for (const r of rows) {
      locales.add(r.locale);
      if (!out[r.key]) out[r.key] = {};
      out[r.key]![r.locale] = r.value;
    }
    return c.json({ data: out, locales: [...locales].sort() });
  })
  .put("/", async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const body = UpsertInput.parse(await c.req.json());
    const t = tableFor(ctx.dialect);
    const existing = (await (ctx.db as any)
      .select({ id: t.id })
      .from(t)
      .where(
        and(
          eq(t.key, body.key),
          eq(t.locale, body.locale),
          auth.tenantId ? eq(t.tenantId, auth.tenantId) : isNull(t.tenantId),
        ),
      )
      .limit(1)) as { id: string }[];
    if (existing[0]) {
      await (ctx.db as any)
        .update(t)
        .set({
          value: body.value,
          updatedAt: ctx.dialect === "pg" ? new Date() : Date.now(),
        })
        .where(eq(t.id, existing[0].id));
      return c.json({ data: { id: existing[0].id, ...body } });
    }
    const id = crypto.randomUUID();
    await (ctx.db as any).insert(t).values({
      id,
      tenantId: auth.tenantId ?? null,
      key: body.key,
      locale: body.locale,
      value: body.value,
    });
    return c.json({ data: { id, ...body } }, 201);
  })
  /** Bulk upsert; mostly used by the import button on the design's UI. */
  .put("/_bulk", async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const body = BulkInput.parse(await c.req.json());
    const t = tableFor(ctx.dialect);
    let upserts = 0;
    for (const row of body) {
      const existing = (await (ctx.db as any)
        .select({ id: t.id })
        .from(t)
        .where(
          and(
            eq(t.key, row.key),
            eq(t.locale, row.locale),
            auth.tenantId ? eq(t.tenantId, auth.tenantId) : isNull(t.tenantId),
          ),
        )
        .limit(1)) as { id: string }[];
      if (existing[0]) {
        await (ctx.db as any)
          .update(t)
          .set({
            value: row.value,
            updatedAt: ctx.dialect === "pg" ? new Date() : Date.now(),
          })
          .where(eq(t.id, existing[0].id));
      } else {
        await (ctx.db as any).insert(t).values({
          id: crypto.randomUUID(),
          tenantId: auth.tenantId ?? null,
          key: row.key,
          locale: row.locale,
          value: row.value,
        });
      }
      upserts += 1;
    }
    return c.json({ ok: true, upserts });
  })
  .delete("/:id", async (c) => {
    const ctx = c.get("ctx");
    const t = tableFor(ctx.dialect);
    await (ctx.db as any).delete(t).where(eq(t.id, c.req.param("id")));
    return c.json({ ok: true });
  });
