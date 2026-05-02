import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../app";

export const sessionMiddleware: MiddlewareHandler<AppBindings> = async (c, next) => {
  const ctx = c.get("ctx");
  const session = await ctx.auth.api.getSession({ headers: c.req.raw.headers });
  c.set("auth", {
    userId: session?.user?.id ?? null,
    email: session?.user?.email ?? null,
    roles: (session?.user as { roles?: string[] })?.roles ?? [],
  });
  await next();
};

export const requireUser: MiddlewareHandler<AppBindings> = async (c, next) => {
  const auth = c.get("auth");
  if (!auth.userId) return c.json({ error: { code: "UNAUTHORIZED", message: "Sign in required" } }, 401);
  await next();
};
