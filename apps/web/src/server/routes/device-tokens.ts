import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { and, desc, eq } from "drizzle-orm";
import { AppError } from "@backlex/core";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { SECURITY, OkSchema, errorResponses } from "../lib/openapi";
import { isPrivateHost } from "../services/storage/hosts";
import { defaultHook } from "../lib/openapi-router";

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.deviceTokens : sqlite.schema.deviceTokens;

const Platform = z.enum(["fcm", "apns", "web-push"]);

const RegisterInput = z
  .object({
    platform: Platform,
    /** FCM/APNs token, or the web-push endpoint URL. */
    token: z.string().min(1),
    /** web-push only — the subscription keys. */
    keys: z
      .object({ p256dh: z.string().min(1), auth: z.string().min(1) })
      .optional(),
    deviceName: z.string().max(200).optional(),
  })
  .openapi("DeviceTokenRegisterInput");

const DeviceTokenRow = z
  .object({
    id: z.string(),
    platform: z.string(),
    token: z.string(),
    deviceName: z.string().nullable(),
    isActive: z.boolean(),
    createdAt: z.unknown(),
    lastSeenAt: z.unknown().nullable(),
  })
  .openapi("DeviceTokenRow");

const TAGS = ["device-tokens"];

/**
 * Push device registration, called by the end-user app (any authenticated
 * caller). A device is keyed by (userId, platform, token) — re-registering the
 * same token revives it (`is_active`) and refreshes `last_seen_at` rather than
 * duplicating. Callers only ever see / mutate their own devices.
 */
export const deviceTokensRoutes = new OpenAPIHono<AppBindings>({ defaultHook })
  .openapi(
    createRoute({
      method: "get",
      path: "/",
      tags: TAGS,
      summary: "List the caller's registered devices",
      security: SECURITY,
      middleware: [requireUser],
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": { schema: z.object({ data: z.array(DeviceTokenRow) }) },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      if (!auth.userId) throw new AppError("UNAUTHORIZED", "Sign in required");
      const t = tableFor(ctx.dialect);
      const rows = await (ctx.db as any)
        .select({
          id: t.id,
          platform: t.platform,
          token: t.token,
          deviceName: t.deviceName,
          isActive: t.isActive,
          createdAt: t.createdAt,
          lastSeenAt: t.lastSeenAt,
        })
        .from(t)
        .where(eq(t.userId, auth.userId))
        .orderBy(desc(t.createdAt));
      return c.json({ data: rows });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/",
      tags: TAGS,
      summary: "Register (or refresh) a push device for the caller",
      description:
        "Upserts on (caller, platform, token): a repeat call reactivates the token and updates its keys / last-seen, so clients can register on every launch.",
      security: SECURITY,
      middleware: [requireUser],
      request: {
        body: { required: true, content: { "application/json": { schema: RegisterInput } } },
      },
      responses: {
        200: {
          description: "Registered",
          content: {
            "application/json": { schema: z.object({ data: z.object({ id: z.string() }) }) },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      if (!auth.userId) throw new AppError("UNAUTHORIZED", "Sign in required");
      const body = c.req.valid("json");
      if (body.platform === "web-push") {
        if (!body.keys) {
          throw new AppError("VALIDATION", "web-push registration requires `keys` (p256dh, auth)");
        }
        // The web-push token IS the endpoint URL the server later POSTs to —
        // validate it now so a caller can't register an internal/metadata URL
        // and turn a push send into a blind SSRF. Require https + a public host.
        let endpoint: URL;
        try {
          endpoint = new URL(body.token);
        } catch {
          throw new AppError("VALIDATION", "web-push token must be a valid endpoint URL");
        }
        if (endpoint.protocol !== "https:") {
          throw new AppError("VALIDATION", "web-push endpoint must use https");
        }
        if (isPrivateHost(endpoint.hostname)) {
          throw new AppError("VALIDATION", "web-push endpoint host is not allowed");
        }
      }
      const t = tableFor(ctx.dialect);
      const now = ctx.dialect === "pg" ? new Date() : Date.now();

      const existing = (await (ctx.db as any)
        .select({ id: t.id })
        .from(t)
        .where(
          and(
            eq(t.userId, auth.userId),
            eq(t.platform, body.platform),
            eq(t.token, body.token),
          ),
        )
        .limit(1)) as { id: string }[];

      if (existing[0]) {
        await (ctx.db as any)
          .update(t)
          .set({
            keys: body.keys ?? null,
            deviceName: body.deviceName ?? null,
            isActive: true,
            lastSeenAt: now,
          })
          .where(eq(t.id, existing[0].id));
        return c.json({ data: { id: existing[0].id } });
      }

      const id = crypto.randomUUID();
      await (ctx.db as any).insert(t).values({
        id,
        tenantId: auth.tenantId ?? null,
        userId: auth.userId,
        platform: body.platform,
        token: body.token,
        keys: body.keys ?? null,
        deviceName: body.deviceName ?? null,
        isActive: true,
        lastSeenAt: now,
      });
      return c.json({ data: { id } });
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/{id}",
      tags: TAGS,
      summary: "Unregister one of the caller's devices",
      security: SECURITY,
      middleware: [requireUser],
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: { description: "Deleted", content: { "application/json": { schema: OkSchema } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      if (!auth.userId) throw new AppError("UNAUTHORIZED", "Sign in required");
      const { id } = c.req.valid("param");
      const t = tableFor(ctx.dialect);
      // Scope the delete to the caller's own rows — never let an id delete
      // another user's device.
      await (ctx.db as any)
        .delete(t)
        .where(and(eq(t.id, id), eq(t.userId, auth.userId)));
      return c.json({ ok: true });
    },
  );
