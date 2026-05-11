import type { Context } from "hono";
import { ZodError } from "zod";
import { isAppError } from "@workeros/core";
import { keepAlive, recordActivity, requestMeta } from "../services/activity";
import type { DbCtx } from "../services/seed";

/**
 * Fire-and-forget audit row for server-side failures (HTTP 5xx). These feed
 * the admin Overview "Recent errors" panel — without this nothing ever lands
 * there because successful mutations are the only thing else that writes to
 * `activity`. Client errors (4xx) are expected and deliberately not logged.
 */
const logServerError = (
  c: Context,
  status: number,
  code: string,
  message: string,
): void => {
  if (status < 500) return;
  let ctx: DbCtx | undefined;
  try {
    ctx = c.get("ctx") as DbCtx | undefined;
  } catch {
    return;
  }
  if (!ctx?.db) return;
  let auth: { userId?: string | null; tenantId?: string | null } | undefined;
  try {
    auth = c.get("auth") as { userId?: string | null; tenantId?: string | null } | undefined;
  } catch {
    auth = undefined;
  }
  const meta = requestMeta(c.req.raw);
  let path: string;
  try {
    path = new URL(c.req.url).pathname;
  } catch {
    path = c.req.path;
  }
  keepAlive(
    c,
    recordActivity(
      { db: ctx.db, dialect: ctx.dialect },
      {
        userId: auth?.userId ?? null,
        tenantId: auth?.tenantId ?? null,
        action: "request.error",
        collection: "http",
        itemId: `${c.req.method} ${path}`.slice(0, 200),
        ...meta,
        payload: { code, message, status },
      },
    ),
  );
};

export const errorHandler = (err: Error, c: Context) => {
  if (isAppError(err)) {
    const status = err.status as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500;
    logServerError(c, status, err.code, err.message);
    return c.json(
      { error: { code: err.code, message: err.message, details: err.details } },
      status,
    );
  }
  if (err instanceof ZodError) {
    const first = err.issues[0];
    const path = first?.path.join(".");
    return c.json(
      {
        error: {
          code: "VALIDATION",
          message: path
            ? `${path}: ${first?.message ?? "invalid input"}`
            : (first?.message ?? "invalid input"),
          details: err.issues,
        },
      },
      422,
    );
  }
  console.error("[unhandled]", err);
  logServerError(c, 500, "INTERNAL", err?.message ?? "Internal server error");
  return c.json(
    { error: { code: "INTERNAL", message: "Internal server error" } },
    500,
  );
};
