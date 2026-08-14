import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { and, eq, isNull, or } from "drizzle-orm";
import { AppError, SYSTEM_ROLES } from "@backlex/core";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import {
  bulkUpsertI18nStrings,
  deleteI18nString,
  listI18nStrings,
  loadMatrix,
  upsertI18nString,
} from "../services/i18n";
import { autoTranslateBatch } from "../services/i18n-translate";
import { loadAppSettings } from "../services/settings";
import { GLOBAL_AI_CONFIG_ID, resolveAiRuntime } from "../services/ai-config";
import { hasDirectAiCredential } from "../mcp/ai-client";
import { cloudConfigured } from "../lib/cloud-report";
import { SECURITY, OkSchema, errorResponses } from "../lib/openapi";
import { defaultHook } from "../lib/openapi-router";
import { aiMeterFor } from "../lib/usage-meter";

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.i18nStrings : sqlite.schema.i18nStrings;

const requireAdminMiddleware: MiddlewareHandler<AppBindings> = async (c, next) => {
  const auth = c.get("auth");
  if (!auth.roles.includes(SYSTEM_ROLES.admin))
    throw new AppError("FORBIDDEN", "Admin role required");
  await next();
};

const adminGate = [requireUser, requireAdminMiddleware];

const I18nUpsertInput = z
  .object({
    key: z.string().min(1).max(120),
    locale: z.string().min(2).max(8),
    value: z.string(),
  })
  .openapi("I18nUpsertInput");

const I18nBulkInput = z.array(I18nUpsertInput).openapi("I18nBulkInput");

const AutoTranslateInput = z
  .object({
    targetLocale: z.string().min(2).max(8),
    sourceLocale: z.string().min(2).max(8).optional(),
    /** Limit translation to a specific set of keys; default = every key that
     *  has a source value. */
    keys: z.array(z.string().min(1).max(120)).optional(),
    /** Default true — skip keys that already have a non-empty value in the
     *  target locale. Set false to overwrite existing translations. */
    onlyMissing: z.boolean().default(true),
  })
  .openapi("I18nAutoTranslateInput");

const I18nRow = z
  .object({
    id: z.string(),
    tenantId: z.string().nullable(),
    key: z.string(),
    locale: z.string(),
    value: z.string(),
  })
  .openapi("I18nRow");

const _I18nMatrix = z
  .object({
    locales: z.array(z.string()),
    keys: z.array(z.string()),
    values: z.record(z.string(), z.record(z.string(), z.string())),
  })
  .passthrough()
  .openapi("I18nMatrix");

interface I18nRowDb {
  id: string;
  tenantId: string | null;
  key: string;
  locale: string;
  value: string;
}

const tags = ["i18n"];

export const i18nRoutes = new OpenAPIHono<AppBindings>({ defaultHook })
  /** Returns rows in row form. The UI pivots them into a key×locale table. */
  .openapi(
    createRoute({
      method: "get",
      path: "/",
      tags,
      summary: "List i18n string rows (admin)",
      description:
        "Returns rows for the active workspace plus global fallback rows. Admin only.",
      security: SECURITY,
      middleware: adminGate,
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": { schema: z.object({ data: z.array(I18nRow) }) },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const rows = (await listI18nStrings(
        ctx.db,
        ctx.dialect,
        auth.tenantId ?? null,
      )) as I18nRowDb[];
      return c.json({ data: rows });
    },
  )
  /** Convenience: full key×locale matrix. Locales include every column the
   *  workspace has data in, plus every configured locale from settings (so
   *  the admin grid shows empty columns for languages the workspace activated
   *  but hasn't translated yet). */
  .openapi(
    createRoute({
      method: "get",
      path: "/_matrix",
      tags,
      summary: "Pivoted key×locale matrix",
      description:
        "Convenience view that includes empty columns for configured-but-untranslated locales.",
      security: SECURITY,
      middleware: adminGate,
      responses: {
        200: {
          description: "OK",
          content: { "application/json": { schema: z.any() } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const result = await loadMatrix(ctx.db, ctx.dialect, auth.tenantId ?? null);
      return c.json(result);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/",
      tags,
      summary: "Upsert a single (key, locale) string",
      security: SECURITY,
      middleware: adminGate,
      request: {
        body: { required: true, content: { "application/json": { schema: I18nUpsertInput } } },
      },
      responses: {
        200: {
          description: "Updated",
          content: { "application/json": { schema: z.any() } },
        },
        201: {
          description: "Created",
          content: { "application/json": { schema: z.any() } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const body = c.req.valid("json");
      const { id, created } = await upsertI18nString(
        ctx.db,
        ctx.dialect,
        auth.tenantId ?? null,
        body,
      );
      // Wire shape preserved verbatim from the legacy handler — no `tenantId`
      // on the responseBody. The schema treats it as optional via partial().
      return c.json({ data: { id, ...body } }, created ? 201 : 200);
    },
  )
  /** Bulk upsert; mostly used by the import button on the design's UI. */
  .openapi(
    createRoute({
      method: "put",
      path: "/_bulk",
      tags,
      summary: "Bulk upsert i18n strings",
      security: SECURITY,
      middleware: adminGate,
      request: {
        body: { required: true, content: { "application/json": { schema: I18nBulkInput } } },
      },
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": {
              schema: z.object({ ok: z.boolean(), upserts: z.number().int() }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const body = c.req.valid("json");
      const upserts = await bulkUpsertI18nStrings(
        ctx.db,
        ctx.dialect,
        auth.tenantId ?? null,
        body,
      );
      return c.json({ ok: true, upserts });
    },
  )
  /**
   * Auto-translate from `sourceLocale` (default: workspace default) into
   * `targetLocale`. With `onlyMissing: true` (the default), keys that
   * already have a value in the target locale are skipped — perfect for
   * topping up a partially translated workspace. Returns the upserted rows
   * so the UI can patch its grid without a refetch.
   */
  .openapi(
    createRoute({
      method: "post",
      path: "/_auto-translate",
      tags,
      summary: "AI auto-translate into a target locale",
      description:
        "Requires an Anthropic key (Settings → AI or `ANTHROPIC_API_KEY`) — responds 503 UNAVAILABLE when none is configured. Caps a single request to 50 keys; loops are caller-driven.",
      security: SECURITY,
      middleware: adminGate,
      request: {
        body: { required: true, content: { "application/json": { schema: AutoTranslateInput } } },
      },
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": {
              schema: z.object({
                ok: z.boolean(),
                translated: z.number().int(),
                remaining: z.number().int().optional(),
                rows: z.array(
                  I18nRow.pick({ id: true, key: true, locale: true, value: true }),
                ),
              }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      // Auto-translate runs on the shared AI config path — the workspace's
      // bring-your-own key (Settings → AI) or, failing that, the deployment
      // env, with the workspace's default model. It used to be pinned to a
      // direct Anthropic key, so a gateway-only or OpenAI-only workspace was
      // told to go get a second credential for no technical reason.
      const { env: aiEnv, model: aiModel } = await resolveAiRuntime(
        { db: ctx.db, dialect: ctx.dialect, env: ctx.env },
        auth.tenantId ?? GLOBAL_AI_CONFIG_ID,
      );
      if (!hasDirectAiCredential(aiEnv) && !cloudConfigured(aiEnv)) {
        // Missing AI config is a deployment precondition, not a server fault —
        // surface it as 503 UNAVAILABLE (same convention as the AI gateway /
        // MCP AI tools), keeping the setup hint.
        throw new AppError(
          "UNAVAILABLE",
          "Add an AI provider key in Settings → AI (or set AI_GATEWAY_API_KEY / ANTHROPIC_API_KEY in env) to enable AI auto-translate.",
        );
      }
      const body = c.req.valid("json");

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
        )) as I18nRowDb[];

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
        env: aiEnv,
        model: aiModel,
        sourceLocale: source,
        targetLocale: body.targetLocale,
        items,
        meter: aiMeterFor(c),
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
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/{id}",
      tags,
      summary: "Delete an i18n row",
      security: SECURITY,
      middleware: adminGate,
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: { description: "Deleted", content: { "application/json": { schema: OkSchema } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const { id } = c.req.valid("param");
      if (!auth.tenantId) {
        throw new AppError("UNAUTHORIZED", "Active tenant required");
      }
      await deleteI18nString(ctx.db, ctx.dialect, auth.tenantId, id);
      return c.json({ ok: true });
    },
  );