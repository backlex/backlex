import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";
import { isAppError } from "@backlex/core";
import { keepAlive, recordActivity, requestMeta } from "../services/activity";
import { reportToCloud } from "../lib/cloud-report";
import { log } from "../lib/log";
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

/** Stash the error code on the context so the access-log middleware can include
 *  it in the single per-request line. The access log runs AFTER `onError`
 *  returns (Hono resolves the outer `await next()` only once the error handler
 *  has produced the response), so the value is always set by the time it reads.
 *  We deliberately do NOT emit a separate `request.failed` line here — that
 *  double-logged every thrown error (one line from here, one from the access
 *  log). The access log is the single source of truth for per-request lines. */
const markError = (c: Context, code: string): void => {
  try {
    c.set("errorCode", code);
  } catch {
    /* bare context (shouldn't happen) — nothing to mark */
  }
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
  // A thrown error short-circuits past the access-log middleware's post-`next()`
  // header write, so stamp the correlation id onto the error response here too —
  // every response (success or failure) then carries `x-request-id`.
  if (requestId) c.header("x-request-id", requestId);
  if (isAppError(err)) {
    const status = err.status as 400 | 401 | 403 | 404 | 409 | 410 | 422 | 429 | 500;
    markError(c, err.code);
    logServerError(c, status, err.code, err.message);
    return c.json(
      {
        error: { code: err.code, message: err.message, details: err.details },
        requestId,
      },
      status,
    );
  }
  // Hono raises its OWN 4xx as an `HTTPException` before any route code runs:
  // a body that is not JSON, a FormData part it cannot parse, a payload past
  // the size cap. Falling through to the generic branch below turned every one
  // of those into a 500 — which is wrong three times over. The caller loses the
  // status AND the message that said what to fix ("Malformed JSON in request
  // body" became "Internal server error"); `logServerError` fires, so a caller's
  // mistake writes a server-error activity row and burns a cloud error report;
  // and a bodyless `POST` that carries `content-type: application/json` — which
  // is what every generated client, `axios`, and `curl -H` send — pages someone
  // for a 400. The SDK only escapes it by omitting the header on bodyless
  // writes, which is a workaround for this, not a reason to keep it.
  if (err instanceof HTTPException) {
    const status = err.status;
    // Some HTTPExceptions carry a whole Response rather than a message —
    // hono's `basicAuth`/`bearerAuth` attach the `WWW-Authenticate` header that
    // way, and `bodyLimit` its own 413. None of those are mounted here today,
    // but rebuilding the envelope around one would silently drop the header
    // that makes it work. Hand it back as hono built it.
    if (err.res) {
      markError(c, "HTTP_EXCEPTION");
      logServerError(c, status, "HTTP_EXCEPTION", err.message);
      return err.getResponse();
    }
    const code = status === 401 ? "UNAUTHORIZED" : status === 403 ? "FORBIDDEN" : status === 404 ? "NOT_FOUND" : status === 413 ? "PAYLOAD_TOO_LARGE" : status === 429 ? "RATE_LIMITED" : status >= 500 ? "INTERNAL" : "VALIDATION";
    markError(c, code);
    logServerError(c, status, code, err.message);
    return c.json(
      {
        // A 5xx from Hono is still ours to hide; a 4xx is the caller's to read.
        error: { code, message: status >= 500 ? "Internal server error" : err.message },
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
    markError(c, "VALIDATION");
    return c.json(
      {
        error: { code: "VALIDATION", message, details: err.issues },
        requestId,
      },
      422,
    );
  }
  // Unhandled exception — log the full error (with stack) under the requestId
  // (the access log's single line carries status/code; this adds the stack),
  // but never leak internals to the client. Drizzle wraps driver failures as
  // "Failed query: <sql>" and hides the real driver error (e.g. a transient D1
  // "Network connection lost") on `err.cause` — surface it so intermittent 5xx
  // are diagnosable instead of an opaque "Failed query".
  markError(c, "INTERNAL");
  const cause = (err as { cause?: unknown })?.cause;
  log.error("unhandled", {
    requestId,
    message: err?.message ?? String(err),
    stack: err?.stack,
    ...(cause !== undefined
      ? { cause: cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause) }
      : {}),
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
