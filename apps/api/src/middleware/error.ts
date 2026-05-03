import type { Context } from "hono";
import { isAppError } from "@workeros/core";

export const errorHandler = (err: Error, c: Context) => {
  if (isAppError(err)) {
    return c.json(
      { error: { code: err.code, message: err.message, details: err.details } },
      err.status as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500,
    );
  }
  console.error("[unhandled]", err);
  return c.json(
    { error: { code: "INTERNAL", message: "Internal server error" } },
    500,
  );
};
