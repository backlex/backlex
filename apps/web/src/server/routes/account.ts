import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { and, eq, isNull } from "drizzle-orm";
import { AppError } from "@backlex/core";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { SECURITY, OkSchema, errorResponses } from "../lib/openapi";
import { loadAppSettings } from "../services/settings";
import { defaultHook } from "../lib/openapi-router";
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

/** Physical storage key for a user's account avatar. Deliberately OUTSIDE the
 *  `tenants/<tid>/…` namespace: the avatar follows the user across every
 *  workspace, so it must resolve regardless of which tenant is active. */
const avatarKey = (userId: string): string => `account/${userId}/avatar`;

const AVATAR_CONTENT_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const AVATAR_MAX_BYTES = 5 * 1024 * 1024;

/** Magic-byte sniff limited to the upload allowlist — used when the storage
 *  backend doesn't persist content type (the fs adapter). */
const sniffImageType = (b: Uint8Array): string | null => {
  if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47)
    return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  )
    return "image/webp";
  return null;
};

/**
 * Per-user preferences for the signed-in admin. The control-plane user pool
 * (`users` table) carries an optional `locale` + `timezone`; both fall through
 * to the workspace defaults (`app_settings`) when unset. The admin SPA reads
 * the resolved view to format dates and pick a UI language.
 */
export const accountRoutes = new OpenAPIHono<AppBindings>({ defaultHook })
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
  )
  /**
   * Account avatar — user-scoped, workspace-independent.
   *
   * The profile picture belongs to the *user*, not to a workspace, so it
   * can't live in the tenant-scoped storage surface (`/api/storage/<key>`
   * resolves under `tenants/<active-tenant>/…` — an avatar uploaded there
   * 404s the moment the user switches workspaces). These routes write the
   * object at the reserved, un-prefixed physical key `account/<uid>/avatar`,
   * which no tenant upload can collide with (those are always written under
   * `tenants/…`).
   *
   * Plain (non-`createRoute`) handlers, same as the binary storage routes —
   * a raw image body has nothing for zod-openapi to validate.
   *
   * `users.image` stores the ready-to-render URL (`/api/account/avatar/<uid>
   * ?v=<etag>`) rather than a storage key, so every consumer — header
   * dropdown, author bylines — can use it verbatim, and the `?v` bust
   * changes on each replace.
   */
  .put("/avatar", requireUser, async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    if (!auth.userId) throw new AppError("UNAUTHORIZED", "Not signed in");
    const contentType = c.req.header("content-type") ?? "";
    if (!AVATAR_CONTENT_TYPES.has(contentType)) {
      throw new AppError(
        "VALIDATION",
        `Avatar must be one of: ${[...AVATAR_CONTENT_TYPES].join(", ")}`,
      );
    }
    // Buffer instead of streaming: gives a definitive size check and avatars
    // are small by contract.
    const body = await c.req.arrayBuffer();
    if (body.byteLength === 0) throw new AppError("BAD_REQUEST", "Empty body");
    if (body.byteLength > AVATAR_MAX_BYTES) {
      throw new AppError(
        "VALIDATION",
        `Avatar must be at most ${Math.floor(AVATAR_MAX_BYTES / (1024 * 1024))} MB`,
      );
    }
    const obj = await ctx.storage.put({
      key: avatarKey(auth.userId),
      body,
      contentType,
    });
    const bust = obj.etag ?? String(obj.uploadedAt.getTime());
    return c.json(
      {
        data: {
          url: `/api/account/avatar/${auth.userId}?v=${encodeURIComponent(bust)}`,
          size: obj.size,
          contentType,
        },
      },
      201,
    );
  })
  .get("/avatar/:userId", requireUser, async (c) => {
    const ctx = c.get("ctx");
    const userId = c.req.param("userId");
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(userId)) {
      throw new AppError("VALIDATION", "Invalid user id");
    }
    const obj = await ctx.storage.get(avatarKey(userId));
    if (!obj) throw new AppError("NOT_FOUND", "Avatar not found");
    // fs adapter has no metadata sidecar (R2/S3 do persist both), so fall
    // back to a weak mtime etag and magic-byte sniffing for the content type.
    const etag = obj.meta.etag
      ? `"${obj.meta.etag}"`
      : `W/"${obj.meta.uploadedAt.getTime()}-${obj.meta.size}"`;
    if (c.req.header("if-none-match") === etag) {
      return new Response(null, { status: 304, headers: { etag } });
    }
    let contentType = obj.meta.contentType ?? null;
    let body: ReadableStream | ArrayBuffer = obj.body;
    if (!contentType) {
      const buf = await new Response(obj.body).arrayBuffer();
      body = buf;
      contentType = sniffImageType(new Uint8Array(buf));
    }
    return new Response(body, {
      headers: {
        "content-type": contentType ?? "application/octet-stream",
        "content-length": String(obj.meta.size),
        // The `?v=` bust in the stored URL changes on every replace, so a
        // long private cache is safe; the etag covers un-busted fetches.
        "cache-control": "private, max-age=86400",
        etag,
      },
    });
  })
  .delete("/avatar", requireUser, async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    if (!auth.userId) throw new AppError("UNAUTHORIZED", "Not signed in");
    await ctx.storage.delete(avatarKey(auth.userId));
    return c.json({ ok: true });
  });
