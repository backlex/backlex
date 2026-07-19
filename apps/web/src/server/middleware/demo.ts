import type { MiddlewareHandler } from "hono";
import { AppError } from "@backlex/core";
import { DEMO_BLOCKED_MESSAGE, isDemoBlockedRequest } from "../services/demo";

/**
 * Playground write-guard — mounted on `/api/*` only when `DEMO_MODE` is set
 * (see `createApp`). Rejects writes to endpoints that send outbound traffic,
 * run raw SQL, or could lock everyone out of the shared demo account. The
 * block list itself lives in services/demo.ts next to the rest of the
 * playground policy.
 */
export const demoGuardMiddleware: MiddlewareHandler = async (c, next) => {
  if (isDemoBlockedRequest(c.req.method, new URL(c.req.url).pathname)) {
    throw new AppError("FORBIDDEN", DEMO_BLOCKED_MESSAGE);
  }
  await next();
};
