import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { AppError, SYSTEM_ROLES } from "@workeros/core";
import * as pg from "@workeros/db/pg";
import * as sqlite from "@workeros/db/sqlite";
import type { AppBindings } from "../app";

/**
 * `GET /api/me` — minimal "who am I" surface for the admin SPA so the header
 * dropdown can render name/email/avatar + a role badge without reaching for
 * better-auth's get-session (which doesn't include roles) and without an
 * admin-only data fetch. The roles array is the same shape the permission
 * resolver uses server-side; `isAdmin` is precomputed so callers can render
 * a badge in one cycle.
 */
export const meRoutes = new Hono<AppBindings>().get("/", async (c) => {
  const ctx = c.get("ctx");
  const auth = c.get("auth");
  if (!auth.userId) throw new AppError("UNAUTHORIZED", "Not signed in");
  const usersTable = ctx.dialect === "pg" ? pg.schema.users : sqlite.schema.users;
  const rows = (await (ctx.db as any)
    .select({
      id: usersTable.id,
      email: usersTable.email,
      name: usersTable.name,
      image: usersTable.image,
    })
    .from(usersTable)
    .where(eq(usersTable.id, auth.userId))
    .limit(1)) as { id: string; email: string; name: string | null; image: string | null }[];
  const user = rows[0];
  if (!user) throw new AppError("NOT_FOUND", "User not found");
  return c.json({
    data: {
      id: user.id,
      email: user.email,
      name: user.name,
      image: user.image,
      roles: auth.roles,
      isAdmin: auth.roles.includes(SYSTEM_ROLES.admin),
      tenantId: auth.tenantId ?? null,
    },
  });
});
