import type { Hook } from "@hono/zod-openapi";
import { AppError } from "@backlex/core";
import type { AppBindings } from "../app";

/**
 * Shared `defaultHook` for every `OpenAPIHono` construction site.
 *
 * Without this, `@hono/zod-openapi`'s built-in hook answers request-validation
 * failures with a **400** and a raw zod-error body — a different status AND
 * shape than the rest of the API. CLAUDE.md's error convention is explicit:
 * validation → `AppError("VALIDATION")` → **422** with the uniform
 * `{ error: { code, message, details }, requestId }` envelope, which is what
 * the admin SPA and the SDK parse.
 *
 * The hook converts the zod result into an `AppError` and throws; the global
 * error middleware (`middleware/error.ts`) then renders the uniform envelope.
 * Message = first issue's `path: message` (human-readable); `details` carries
 * the full issue list.
 *
 * Usage — every construction site MUST pass it:
 *
 *   new OpenAPIHono<AppBindings>({ defaultHook })
 */
export const defaultHook: Hook<unknown, AppBindings, string, unknown> = (result) => {
  if (result.success) return;
  const issues = result.error.issues;
  const first = issues[0];
  const path = first?.path?.map(String).join(".");
  const message = path
    ? `${path}: ${first?.message ?? "invalid input"}`
    : (first?.message ?? "Invalid request payload");
  throw new AppError("VALIDATION", message, issues);
};
