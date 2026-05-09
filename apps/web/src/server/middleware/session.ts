import type { MiddlewareHandler } from "hono";
import { eq } from "drizzle-orm";
import * as pg from "@workeros/db/pg";
import * as sqlite from "@workeros/db/sqlite";
import type { AppBindings } from "../app";
import { findApiKey, touchLastUsed } from "../services/api-keys";

const loadRoleNames = async (
  ctx: { db: unknown; dialect: "pg" | "sqlite" },
  userId: string,
): Promise<string[]> => {
  const t =
    ctx.dialect === "pg"
      ? { roles: pg.schema.roles, userRoles: pg.schema.userRoles }
      : { roles: sqlite.schema.roles, userRoles: sqlite.schema.userRoles };
  const rows = (await (ctx.db as any)
    .select({ name: t.roles.name })
    .from(t.userRoles)
    .innerJoin(t.roles, eq(t.userRoles.roleId, t.roles.id))
    .where(eq(t.userRoles.userId, userId))) as { name: string }[];
  return rows.map((r) => r.name);
};

const loadUserEmail = async (
  ctx: { db: unknown; dialect: "pg" | "sqlite" },
  userId: string,
): Promise<string | null> => {
  const t = ctx.dialect === "pg" ? pg.schema.users : sqlite.schema.users;
  const rows = (await (ctx.db as any)
    .select({ email: t.email })
    .from(t)
    .where(eq(t.id, userId))
    .limit(1)) as { email: string }[];
  return rows[0]?.email ?? null;
};

export const sessionMiddleware: MiddlewareHandler<AppBindings> = async (c, next) => {
  const ctx = c.get("ctx");

  let userId: string | null = null;
  let email: string | null = null;

  const session = await ctx.auth.api.getSession({ headers: c.req.raw.headers });
  if (session?.user?.id) {
    userId = session.user.id;
    email = session.user.email ?? null;
  }

  if (!userId) {
    const authHeader = c.req.raw.headers.get("authorization") ?? "";
    if (authHeader.toLowerCase().startsWith("bearer pak_")) {
      const raw = authHeader.slice("bearer ".length).trim();
      const key = await findApiKey(ctx, raw);
      if (key) {
        userId = key.userId;
        email = await loadUserEmail(ctx, key.userId);
        // fire-and-forget last-used update
        void touchLastUsed(ctx, key.id);
      }
    }
  }

  const roles = userId ? await loadRoleNames(ctx, userId) : [];

  c.set("auth", { userId, email, roles });
  await next();
};

export const requireUser: MiddlewareHandler<AppBindings> = async (c, next) => {
  const auth = c.get("auth");
  if (!auth.userId)
    return c.json(
      { error: { code: "UNAUTHORIZED", message: "Sign in required" } },
      401,
    );
  await next();
};
