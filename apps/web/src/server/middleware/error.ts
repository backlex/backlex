import type { Context } from "hono";
import { ZodError } from "zod";
import { isAppError } from "@workeros/core";

export const errorHandler = (err: Error, c: Context) => {
  if (isAppError(err)) {
    return c.json(
      { error: { code: err.code, message: err.message, details: err.details } },
      err.status as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500,
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
  return c.json(
    { error: { code: "INTERNAL", message: "Internal server error" } },
    500,
  );
};
