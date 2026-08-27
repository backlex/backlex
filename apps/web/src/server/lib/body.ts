import { AppError } from "@backlex/core";

/**
 * Read the request body as JSON, attributing a parse failure to the CALLER.
 *
 * `c.req.json()` is `Request.json()`, so a body that is not JSON throws a bare
 * `SyntaxError`. That is neither an `AppError` nor a `ZodError` nor hono's own
 * `HTTPException`, so it fell straight through the global handler to the
 * catch-all and came back as `500 INTERNAL / "Internal server error"` — for a
 * mistake the caller made and could have fixed, had we said what it was.
 *
 * Routes that validate through hono's validator never hit this: the validator
 * catches the same `SyntaxError` and re-raises it as `HTTPException(400)`.
 * Routes that parse the body themselves — 26 of them — had no such thing.
 *
 * The fix belongs here rather than in the error handler because only the call
 * site knows the JSON being parsed is the REQUEST. A handler that mapped every
 * `SyntaxError` to 400 would also relabel a genuine server-side parse failure
 * (stored field metadata, a cached payload) as the caller's fault, hiding our
 * bug behind their error.
 *
 * `apps/web/tests/request-envelope.test.ts` guards both halves: the answers
 * this produces, and — by scanning source — that no new route goes without it.
 */
export const readJson = async <T = unknown>(req: {
  json: () => Promise<unknown>;
}): Promise<T> => {
  try {
    return (await req.json()) as T;
  } catch {
    throw new AppError("VALIDATION", "Malformed JSON in request body");
  }
};

/**
 * The same read, tolerating a body that is absent or unparseable — for
 * endpoints where "no body" is a legitimate call (a bodyless `POST`, which is
 * what `axios` and every generated OpenAPI client send for a no-argument
 * write) and the schema underneath decides what is actually required.
 *
 * The fallback is returned for BOTH cases on purpose: a caller who sent nothing
 * and a caller who sent nonsense are told the same thing by the validator that
 * runs next, which is the field it wanted and did not get.
 */
export const readJsonOr = async <T>(
  req: { json: () => Promise<unknown> },
  fallback: T,
): Promise<T> => {
  try {
    return ((await req.json()) ?? fallback) as T;
  } catch {
    return fallback;
  }
};
