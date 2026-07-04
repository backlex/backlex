import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { and, eq, isNull } from "drizzle-orm";
import { AppError } from "@backlex/core";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { SECURITY, OkSchema, errorResponses } from "../lib/openapi";
import { loadAppSettings } from "../services/settings";
import {
  DEFAULT_LOCALE,
  DEFAULT_TIMEZONE,
  localeCode,
  timeZoneCode,
} from "../lib/locale";

const usersTable = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.users : sqlite.schema.users;

const settingsTable = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.appSettings : sqlite.schema.appSettings;

/** `""` and `null` both mean "clear this preference → inherit the workspace
 *  default". Omitting the key leaves the stored value untouched. */
const clearable = <T extends z.ZodTypeAny>(schema: T) =>
  z.union([schema, z.literal(""), z.null()]);

const PreferencesInput = z
  .object({
    locale: clearable(localeCode).optional(),
    timezone: clearable(timeZoneCode).optional(),
  })
  .strict()
  .openapi("AccountPreferencesInput");

const PreferencesView = z
  .object({
    /** The signed-in user's own choices. `null` = not set (inherits). */
    user: z.object({
      locale: z.string().nullable(),
      timezone: z.string().nullable(),
    }),
    /** Workspace-level defaults + the locale list the user may pick from. */
    workspace: z.object({
      defaultLocale: z.string(),
      locales: z.array(z.string()),
      timezone: z.string(),
    }),
    /** Resolved values: user override → workspace default → built-in fallback. */
    effective: z.object({ locale: z.string(), timezone: z.string() }),
  })
  .openapi("AccountPreferences");

/** slug → ordered field names. Same shape + caps as the workspace-level
 *  `listColumns` app-setting; this one is the signed-in user's personal copy. */
const ListColumnsMap = z
  .record(z.string(), z.array(z.string()).max(60))
  .refine((v) => Object.keys(v).length <= 500, {
    message: "Too many collections in listColumns",
  })
  .openapi("AccountListColumns");

const ListColumnsInput = z
  .object({ listColumns: ListColumnsMap })
  .strict()
  .openapi("AccountListColumnsInput");

const isListColumnsMap = (v: unknown): v is Record<string, string[]> =>
  !!v &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  Object.values(v as Record<string, unknown>).every(
    (a) => Array.isArray(a) && a.every((s) => typeof s === "string"),
  );

const TAG = "account";

/**
 * Per-user preferences for the signed-in admin. The control-plane user pool
 * (`users` table) carries an optional `locale` + `timezone`; both fall through
 * to the workspace defaults (`app_settings`) when unset. The admin SPA reads
 * the resolved view to format dates and pick a UI language.
 */
export const accountRoutes = new OpenAPIHono<AppBindings>()
  .openapi(
    createRoute({
      method: "get",
      path: "/preferences",
      tags: [TAG],
      summary: "Get account preferences",
      description:
        "The signed-in user's locale + time zone, the workspace defaults, and the resolved effective values.",
      security: SECURITY,
      middleware: [requireUser],
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": { schema: z.object({ data: PreferencesView }) },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      if (!auth.userId) throw new AppError("UNAUTHORIZED", "Not signed in");
      const t = usersTable(ctx.dialect);
      // The user row and the workspace settings are independent reads. Each D1
      // call carries ~20ms of service round-trip overhead regardless of the
      // (sub-ms) SQL, so issue them concurrently — one round-trip on the wire
      // instead of two sequential ones.
      const [rows, settings] = await Promise.all([
        (ctx.db as any)
          .select({ locale: t.locale, timezone: t.timezone })
          .from(t)
          .where(eq(t.id, auth.userId))
          .limit(1) as Promise<
          { locale: string | null; timezone: string | null }[]
        >,
        loadAppSettings(ctx.db, ctx.dialect, auth.tenantId ?? null),
      ]);
      const user = rows[0] ?? { locale: null, timezone: null };
      return c.json({
        data: {
          user: {
            locale: user.locale ?? null,
            timezone: user.timezone ?? null,
          },
          workspace: {
            defaultLocale: settings.i18nDefaultLocale,
            locales: settings.i18nLocales,
            timezone: settings.timezone,
          },
          effective: {
            locale: user.locale || settings.i18nDefaultLocale || DEFAULT_LOCALE,
            timezone: user.timezone || settings.timezone || DEFAULT_TIMEZONE,
          },
        },
      });
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/preferences",
      tags: [TAG],
      summary: "Update account preferences",
      description:
        "Sets the signed-in user's locale and/or time zone. Pass `null` or `\"\"` to clear a field back to the workspace default; omit it to leave it unchanged.",
      security: SECURITY,
      middleware: [requireUser],
      request: {
        body: {
          required: true,
          content: { "application/json": { schema: PreferencesInput } },
        },
      },
      responses: {
        200: {
          description: "Saved",
          content: { "application/json": { schema: OkSchema } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      if (!auth.userId) throw new AppError("UNAUTHORIZED", "Not signed in");
      const body = c.req.valid("json");
      const set: Record<string, unknown> = {};
      if ("locale" in body) set.locale = body.locale ? body.locale : null;
      if ("timezone" in body) set.timezone = body.timezone ? body.timezone : null;
      if (Object.keys(set).length > 0) {
        set.updatedAt = ctx.dialect === "pg" ? new Date() : Date.now();
        const t = usersTable(ctx.dialect);
        await (ctx.db as any)
          .update(t)
          .set(set)
          .where(eq(t.id, auth.userId));
      }
      return c.json({ ok: true });
    },
  )
  /**
   * Per-user list-view columns (slug → ordered field names). Stored on the
   * `app_settings` row keyed `userListColumns:<userId>` — the same
   * no-migration convention as `erdLayout`, but one row per user so admins
   * saving their own view can't clobber each other. The workspace-level
   * `listColumns` key stays as the shared default the client falls back to.
   * `loadAppSettings` matches keys exactly, so these rows never leak into
   * the admin Settings payload. Any signed-in user may write their own row —
   * no admin role required (unlike `PATCH /api/admin/settings`).
   */
  .openapi(
    createRoute({
      method: "get",
      path: "/list-columns",
      tags: [TAG],
      summary: "Get my list columns",
      description:
        "The signed-in user's per-collection list-view columns (slug → ordered field names). Empty object when nothing is saved — the client then falls back to the workspace `listColumns` default.",
      security: SECURITY,
      middleware: [requireUser],
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": { schema: z.object({ data: ListColumnsMap }) },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      if (!auth.userId) throw new AppError("UNAUTHORIZED", "Not signed in");
      const t = settingsTable(ctx.dialect);
      const key = `userListColumns:${auth.userId}`;
      const tenantId = auth.tenantId ?? null;
      const rows = (await (ctx.db as any)
        .select({ value: t.value })
        .from(t)
        .where(
          and(eq(t.key, key), tenantId ? eq(t.tenantId, tenantId) : isNull(t.tenantId)),
        )
        .limit(1)) as { value: unknown }[];
      const value = rows[0]?.value;
      return c.json({ data: isListColumnsMap(value) ? value : {} });
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/list-columns",
      tags: [TAG],
      summary: "Update my list columns",
      description:
        "Replaces the signed-in user's per-collection column map. Send the full map; drop a slug from it to fall back to the workspace default for that collection.",
      security: SECURITY,
      middleware: [requireUser],
      request: {
        body: {
          required: true,
          content: { "application/json": { schema: ListColumnsInput } },
        },
      },
      responses: {
        200: {
          description: "Saved",
          content: { "application/json": { schema: OkSchema } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      if (!auth.userId) throw new AppError("UNAUTHORIZED", "Not signed in");
      const { listColumns } = c.req.valid("json");
      const t = settingsTable(ctx.dialect);
      const key = `userListColumns:${auth.userId}`;
      const tenantId = auth.tenantId ?? null;
      const updatedAt = ctx.dialect === "pg" ? new Date() : Date.now();
      if (tenantId !== null) {
        // Atomic upsert on the `(tenant_id, key)` unique index — same
        // race-free shape as PATCH /api/admin/settings.
        await (ctx.db as any)
          .insert(t)
          .values({ id: crypto.randomUUID(), tenantId, key, value: listColumns })
          .onConflictDoUpdate({
            target: [t.tenantId, t.key],
            set: { value: listColumns, updatedAt },
          });
      } else {
        // NULL tenant_id rows can't dedupe through the unique index on
        // SQLite/D1 (NULLs are distinct) — select-then-update. Only the
        // owning user ever writes this key, so there's no concurrent-writer
        // window worth hardening here.
        const existing = (await (ctx.db as any)
          .select({ id: t.id })
          .from(t)
          .where(and(eq(t.key, key), isNull(t.tenantId)))
          .limit(1)) as { id: string }[];
        if (existing[0]) {
          await (ctx.db as any)
            .update(t)
            .set({ value: listColumns, updatedAt })
            .where(eq(t.id, existing[0].id));
        } else {
          await (ctx.db as any)
            .insert(t)
            .values({ id: crypto.randomUUID(), tenantId: null, key, value: listColumns });
        }
      }
      return c.json({ ok: true });
    },
  );
