import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { and, desc, eq } from "drizzle-orm";
import { AppError } from "@backlex/core";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { SECURITY, OkSchema, errorResponses } from "../lib/openapi";

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.phoneNumbers : sqlite.schema.phoneNumbers;

/** Loose E.164 check: leading + and 7–15 digits. We don't try to validate the
 *  carrier/country here — the provider rejects truly bad numbers at send time
 *  and the row is deactivated then. */
const E164 = /^\+[1-9]\d{6,14}$/;

const RegisterInput = z
  .object({
    phoneNumber: z
      .string()
      .min(1)
      .regex(E164, "phoneNumber must be E.164, e.g. +14155552671"),
  })
  .openapi("PhoneNumberRegisterInput");

const PhoneNumberRow = z
  .object({
    id: z.string(),
    phoneNumber: z.string(),
    isActive: z.boolean(),
    createdAt: z.unknown(),
    lastSeenAt: z.unknown().nullable(),
  })
  .openapi("PhoneNumberRow");

const TAGS = ["phone-numbers"];

/**
 * SMS phone-number registration, called by the end-user app (any authenticated
 * caller). A number is keyed by (userId, phoneNumber) — re-registering the same
 * number revives it (`is_active`) and refreshes `last_seen_at` rather than
 * duplicating. Callers only ever see / mutate their own numbers.
 */
export const phoneNumbersRoutes = new OpenAPIHono<AppBindings>()
  .openapi(
    createRoute({
      method: "get",
      path: "/",
      tags: TAGS,
      summary: "List the caller's registered phone numbers",
      security: SECURITY,
      middleware: [requireUser],
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": { schema: z.object({ data: z.array(PhoneNumberRow) }) },
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
          phoneNumber: t.phoneNumber,
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
      summary: "Register (or refresh) a phone number for the caller",
      description:
        "Upserts on (caller, phoneNumber): a repeat call reactivates the number and updates last-seen.",
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
      const t = tableFor(ctx.dialect);
      const now = ctx.dialect === "pg" ? new Date() : Date.now();

      const existing = (await (ctx.db as any)
        .select({ id: t.id })
        .from(t)
        .where(and(eq(t.userId, auth.userId), eq(t.phoneNumber, body.phoneNumber)))
        .limit(1)) as { id: string }[];

      if (existing[0]) {
        await (ctx.db as any)
          .update(t)
          .set({ isActive: true, lastSeenAt: now })
          .where(eq(t.id, existing[0].id));
        return c.json({ data: { id: existing[0].id } });
      }

      const id = crypto.randomUUID();
      await (ctx.db as any).insert(t).values({
        id,
        tenantId: auth.tenantId ?? null,
        userId: auth.userId,
        phoneNumber: body.phoneNumber,
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
      summary: "Unregister one of the caller's phone numbers",
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
      await (ctx.db as any)
        .delete(t)
        .where(and(eq(t.id, id), eq(t.userId, auth.userId)));
      return c.json({ ok: true });
    },
  );
