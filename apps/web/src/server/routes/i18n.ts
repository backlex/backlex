import { Hono } from "hono";
import { z } from "zod";
import { and, eq, isNull, or } from "drizzle-orm";
import { AppError, SYSTEM_ROLES } from "@workeros/core";
import * as pg from "@workeros/db/pg";
import * as sqlite from "@workeros/db/sqlite";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { loadMatrix } from "../services/i18n";
import { autoTranslateBatch } from "../services/i18n-translate";
import { loadAppSettings } from "../services/settings";

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

const AutoTranslateInput = z.object({
  targetLocale: z.string().min(2).max(8),
  sourceLocale: z.string().min(2).max(8).optional(),
  /** Limit translation to a specific set of keys; default = every key that
   *  has a source value. */
  keys: z.array(z.string().min(1).max(120)).optional(),
  /** Default true — skip keys that already have a non-empty value in the
   *  target locale. Set false to overwrite existing translations. */
  onlyMissing: z.boolean().default(true),
});

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
  /** Convenience: full key×locale matrix. Locales include every column the
   *  workspace has data in, plus every configured locale from settings (so
   *  the admin grid shows empty columns for languages the workspace activated
   *  but hasn't translated yet). */
  .get("/_matrix", async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const result = await loadMatrix(ctx.db, ctx.dialect, auth.tenantId ?? null);
    return c.json(result);
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
  /**
   * Auto-translate from `sourceLocale` (default: workspace default) into
   * `targetLocale`. With `onlyMissing: true` (the default), keys that
   * already have a value in the target locale are skipped — perfect for
   * topping up a partially translated workspace. Returns the upserted rows
   * so the UI can patch its grid without a refetch.
   */
  .post("/_auto-translate", async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const apiKey = ctx.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new AppError(
        "INTERNAL",
        "Set ANTHROPIC_API_KEY in env to enable AI auto-translate.",
      );
    }
    const body = AutoTranslateInput.parse(await c.req.json());

    const settings = await loadAppSettings(ctx.db, ctx.dialect, auth.tenantId ?? null);
    const source = body.sourceLocale ?? settings.i18nDefaultLocale;
    if (source === body.targetLocale) {
      throw new AppError("VALIDATION", "Source and target locales must differ.");
    }

    const t = tableFor(ctx.dialect);
    const rows = (await (ctx.db as any)
      .select()
      .from(t)
      .where(
        or(eq(t.tenantId, auth.tenantId ?? ""), isNull(t.tenantId)),
      )) as I18nRow[];

    // Index by (key, locale) preferring tenant-scoped rows over global
    // fallback rows for the same pair.
    const idx = new Map<string, Map<string, string>>();
    const tenantOwned = new Set<string>();
    for (const r of rows) {
      if (r.tenantId !== null) tenantOwned.add(`${r.key}::${r.locale}`);
    }
    for (const r of rows) {
      if (r.tenantId === null && tenantOwned.has(`${r.key}::${r.locale}`)) continue;
      let perKey = idx.get(r.key);
      if (!perKey) {
        perKey = new Map();
        idx.set(r.key, perKey);
      }
      perKey.set(r.locale, r.value);
    }

    let pool = body.keys && body.keys.length > 0
      ? body.keys.filter((k) => idx.has(k))
      : [...idx.keys()];
    pool = pool.filter((k) => {
      const src = idx.get(k)?.get(source);
      if (!src) return false;
      if (body.onlyMissing) {
        const tgt = idx.get(k)?.get(body.targetLocale);
        if (tgt && tgt.length > 0) return false;
      }
      return true;
    });

    if (pool.length === 0) {
      return c.json({ ok: true, translated: 0, rows: [] });
    }

    // Cap a single request to a sane batch size to keep the model honest and
    // the latency predictable. Callers loop if they want more.
    const MAX = 50;
    const slice = pool.slice(0, MAX);
    const items = slice.map((k) => ({ key: k, value: idx.get(k)!.get(source)! }));

    const translated = await autoTranslateBatch({
      apiKey,
      sourceLocale: source,
      targetLocale: body.targetLocale,
      items,
    });

    // Upsert each translation; mirror the single-key PUT handler's logic.
    const written: { id: string; key: string; locale: string; value: string }[] = [];
    for (const r of translated) {
      // Skip rows where the model echoed the source unchanged AND we'd be
      // overwriting an existing row with the same value — saves a round trip.
      const existingValue = idx.get(r.key)?.get(body.targetLocale);
      if (existingValue === r.value) continue;

      const existing = (await (ctx.db as any)
        .select({ id: t.id })
        .from(t)
        .where(
          and(
            eq(t.key, r.key),
            eq(t.locale, body.targetLocale),
            auth.tenantId ? eq(t.tenantId, auth.tenantId) : isNull(t.tenantId),
          ),
        )
        .limit(1)) as { id: string }[];
      let id: string;
      if (existing[0]) {
        id = existing[0].id;
        await (ctx.db as any)
          .update(t)
          .set({
            value: r.value,
            updatedAt: ctx.dialect === "pg" ? new Date() : Date.now(),
          })
          .where(eq(t.id, id));
      } else {
        id = crypto.randomUUID();
        await (ctx.db as any).insert(t).values({
          id,
          tenantId: auth.tenantId ?? null,
          key: r.key,
          locale: body.targetLocale,
          value: r.value,
        });
      }
      written.push({ id, key: r.key, locale: body.targetLocale, value: r.value });
    }

    return c.json({
      ok: true,
      translated: written.length,
      remaining: Math.max(0, pool.length - slice.length),
      rows: written,
    });
  })
  .delete("/:id", async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    if (!auth.tenantId) {
      throw new AppError("UNAUTHORIZED", "Active tenant required");
    }
    const t = tableFor(ctx.dialect);
    await (ctx.db as any)
      .delete(t)
      .where(
        and(
          eq(t.id, c.req.param("id")),
          or(eq(t.tenantId, auth.tenantId), isNull(t.tenantId)),
        ),
      );
    return c.json({ ok: true });
  });
