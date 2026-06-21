import type { Context } from "hono";
import { ZodError } from "zod";
import { isAppError } from "@backlex/core";
import { keepAlive, recordActivity, requestMeta } from "../services/activity";
import { reportToCloud } from "../lib/cloud-report";
import { levelForStatus, log } from "../lib/log";
import type { Env } from "../env";
import type { DbCtx } from "../services/seed";

/** Read the request correlation id set by the outermost middleware. Wrapped
 *  because errors that fire before that middleware ran (or in a bare context)
 *  may not have it set. */
const reqIdOf = (c: Context): string | undefined => {
  try {
    return c.get("requestId") as string | undefined;
  } catch {
    return undefined;
  }
};

/** One structured JSON log line per handled error, carrying the requestId so a
 *  failure can be correlated with its access log + any upstream trace. Distinct
 *  from `logServerError` below, which writes a durable audit row (5xx only). */
const logHandledError = (
  c: Context,
  status: number,
  code: string,
  message: string,
): void => {
  let path: string;
  try {
    path = new URL(c.req.url).pathname;
  } catch {
    path = c.req.path;
  }
  log[levelForStatus(status)]("request.failed", {
    requestId: reqIdOf(c),
    method: c.req.method,
    path,
    status,
    code,
    message: message.slice(0, 500),
  });
};

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
  let path: string;
  try {
    path = new URL(c.req.url).pathname;
  } catch {
    path = c.req.path;
  }
  // Opt-in cloud report — only needs `c.env`, so it fires independently of the
  // tenant DB context below. This captures admin / infra 5xx that error out
  // before (or without) a `ctx` ever being attached.
  const rep = reportToCloud(c.env as Env, {
    kind: "error",
    message: message.slice(0, 500),
    route: `${c.req.method} ${path}`.slice(0, 200),
    status,
  });
  if (rep) keepAlive(c, rep);

  // Local audit row needs the tenant DB context; skip it when unavailable.
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
        response: { error: { code, message }, status },
      },
    ),
  );
};

export const errorHandler = (err: Error, c: Context) => {
  const requestId = reqIdOf(c);
  if (isAppError(err)) {
    const status = err.status as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500;
    logHandledError(c, status, err.code, err.message);
    logServerError(c, status, err.code, err.message);
    return c.json(
      {
        error: { code: err.code, message: err.message, details: err.details },
        requestId,
      },
      status,
    );
  }
  if (err instanceof ZodError) {
    const first = err.issues[0];
    const path = first?.path.join(".");
    const message = path
      ? `${path}: ${first?.message ?? "invalid input"}`
      : (first?.message ?? "invalid input");
    logHandledError(c, 422, "VALIDATION", message);
    return c.json(
      {
        error: { code: "VALIDATION", message, details: err.issues },
        requestId,
      },
      422,
    );
  }
  // Unhandled exception — log the full error (with stack) under the requestId,
  // but never leak internals to the client.
  log.error("unhandled", {
    requestId,
    message: err?.message ?? String(err),
    stack: err?.stack,
  });
  logServerError(c, 500, "INTERNAL", err?.message ?? "Internal server error");
  return c.json(
    {
      error: { code: "INTERNAL", message: "Internal server error" },
      requestId,
    },
    500,
  );
};
