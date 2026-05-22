import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import { AppError } from "@workeros/core";
import * as pg from "@workeros/db/pg";
import * as sqlite from "@workeros/db/sqlite";
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
      const rows = (await (ctx.db as any)
        .select({ locale: t.locale, timezone: t.timezone })
        .from(t)
        .where(eq(t.id, auth.userId))
        .limit(1)) as { locale: string | null; timezone: string | null }[];
      const user = rows[0] ?? { locale: null, timezone: null };
      const settings = await loadAppSettings(
        ctx.db,
        ctx.dialect,
        auth.tenantId ?? null,
      );
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
  );
