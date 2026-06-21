/**
 * MCP argument completion (`completions/complete`). Lets clients autocomplete
 * the arguments of our prompts and resource templates as the user types —
 * collection slugs for the `collection` / `slug` args, and the SDK language for
 * `generate_sdk_code`'s `language` arg.
 *
 * Slugs come through the same `fetchInternal` sub-fetch as everything else, so
 * the caller only ever completes collections it has permission to read.
 */
import type { ToolCtx } from "./types";
import { listCollectionSlugs } from "./resources";
import { SDK_LANGUAGES } from "./sdk-reference";
import { readJson } from "./internal-fetch";

/** Per the spec, a completion result returns at most 100 values, with `total`
 *  and `hasMore` describing the full set. */
const MAX_VALUES = 100;

interface CompletionRef {
  type?: unknown;
  name?: unknown;
  uri?: unknown;
}
interface CompletionArgument {
  name?: unknown;
  value?: unknown;
}

const prefixFilter = (all: string[], value: string): string[] => {
  const v = value.toLowerCase();
  return v ? all.filter((x) => x.toLowerCase().startsWith(v)) : all;
};

const result = (matched: string[]) => ({
  completion: {
    values: matched.slice(0, MAX_VALUES),
    total: matched.length,
    hasMore: matched.length > MAX_VALUES,
  },
});

/** Resolve a `completions/complete` request. `ref` identifies the prompt or
 *  resource template; `argument` is the partial value being typed. Unknown
 *  arguments (free-text `intent`, etc.) return an empty completion. */
export const complete = async (
  ctx: ToolCtx,
  _ref: CompletionRef | undefined,
  argument: CompletionArgument | undefined,
): Promise<{ completion: { values: string[]; total: number; hasMore: boolean } }> => {
  const argName = typeof argument?.name === "string" ? argument.name : "";
  const argValue = typeof argument?.value === "string" ? argument.value : "";

  // Collection slug — used by every prompt's `collection` arg and the
  // `backlex://collection/{slug}` resource template's `slug` arg.
  if (argName === "collection" || argName === "slug") {
    try {
      return result(prefixFilter(await listCollectionSlugs(ctx), argValue));
    } catch {
      return result([]); // e.g. no read permission — offer nothing rather than error
    }
  }

  // explain_permissions role — role names (admin-gated; empty if not allowed).
  if (argName === "role") {
    try {
      const res = await ctx.fetchInternal(`/api/roles`);
      const body = await readJson<{ data: Array<{ name: string }> }>(res);
      return result(prefixFilter(body.data.map((r) => r.name), argValue));
    } catch {
      return result([]);
    }
  }

  // generate_sdk_code language — a fixed enum, no fetch needed.
  if (argName === "language") {
    return result(prefixFilter([...SDK_LANGUAGES], argValue));
  }

  return result([]);
};
