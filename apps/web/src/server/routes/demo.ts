import { Hono } from "hono";
import { AppError } from "@backlex/core";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { requireAdminMw, requirePlatformMw } from "../services/roles/guards";
import { isDemoMode, resetDemoWorkspace } from "../services/demo";

/**
 * Playground (demo-mode) admin endpoints. Mounted at `/api/admin/demo`; every
 * route 404s outside `DEMO_MODE` so the surface simply doesn't exist on a
 * normal instance.
 */
export const demoRoutes = new Hono<AppBindings>()
  /** Manual wipe-and-reseed — the same routine the hourly cron runs. */
  .post("/reset", requireUser, requirePlatformMw, requireAdminMw, async (c) => {
    const ctx = c.get("ctx");
    if (!isDemoMode(ctx.env)) throw new AppError("NOT_FOUND", "Not a playground instance");
    const result = await resetDemoWorkspace(ctx, ctx.env);
    return c.json({ data: result });
  });
