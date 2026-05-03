import { Hono } from "hono";
import type { AppBindings } from "../app";

/**
 * better-auth ships its own router. We mount it at /api/auth/* and let it
 * own everything from /sign-in to /callback/:provider.
 */
export const authRoutes = new Hono<AppBindings>().all("/*", (c) => {
  const ctx = c.get("ctx");
  return ctx.auth.handler(c.req.raw);
});
