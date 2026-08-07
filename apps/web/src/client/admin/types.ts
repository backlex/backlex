// Shared prop types for the admin SPA.
//
// Types that more than one page/panel declares in its own props belong here.
// The rule this file exists to enforce: a callback threaded through the admin
// has ONE signature, declared once. Re-declaring it per file lets the copies
// drift, and a narrower copy silently drops arguments the real function
// accepts — which typecheck cannot flag while the file carries `@ts-nocheck`.

/** Show a transient toast. Returned by `useToasts()` in `ui.tsx` and threaded
 *  down through page props.
 *
 *  `type` decides the toast's styling. It was previously omitted from roughly
 *  half of the prop declarations, so `pushToast(msg, "error")` calls in those
 *  subtrees typechecked against a 1-arg signature and lost the severity in the
 *  type model (the runtime function always accepted it). Declare the prop as
 *  `PushToast` — never re-spell the signature inline. */
export type PushToast = (message: string, type?: "success" | "error") => void;

/** Narrow a `Select`'s emission back to the union the field actually stores.
 *
 *  `Select` hands its handler a bare `string` — it has no way to know the
 *  option list is exhaustive — so assigning that straight into a field typed
 *  `"sum" | "avg" | …` does not compile. This is the one place that decides
 *  what happens to a value outside the set: it falls back rather than writing
 *  a union member that does not exist. Prefer it over casting at the callsite,
 *  where a stale option list would go unnoticed. */
export const asOneOf = <T extends string>(
  allowed: readonly T[],
  value: string,
  fallback: T,
): T => ((allowed as readonly string[]).includes(value) ? (value as T) : fallback);
