/**
 * `backlex gen-openapi` — fetch the live OpenAPI spec (`/api/openapi.json`) and
 * write it to disk. The spec is generated dynamically from the collection
 * schemas + per-route decorators, so it always matches the running instance.
 * Feed it to `openapi-generator`, Postman, or `backlex sdk <lang>`'s typed-model
 * step. The endpoint is admin-readable, so a key is required.
 */
import { writeFileSync } from "node:fs";
import { BacklexError } from "backlex";
import { authedFetch, flag, resolveContext } from "./client";

export const runGenOpenapi = async (args: string[]): Promise<void> => {
  const ctx = resolveContext(args);
  if (!ctx.key) {
    process.stderr.write("gen-openapi: no API key — run `backlex login` first.\n");
    process.exit(1);
  }
  try {
    const res = await authedFetch(ctx, "GET", "/api/openapi.json");
    if (!res.ok) throw new BacklexError(res.status, undefined);
    // Re-stringify so the output is pretty-printed and stable to diff.
    const doc = await res.json();
    const out = `${JSON.stringify(doc, null, 2)}\n`;
    const outPath = flag(args, "--out");
    if (outPath) {
      writeFileSync(outPath, out, "utf8");
      process.stderr.write(`✓ wrote OpenAPI spec → ${outPath}\n`);
    } else {
      process.stdout.write(out);
    }
  } catch (e) {
    const msg = e instanceof BacklexError ? `${e.status} ${e.message}` : (e as Error).message;
    process.stderr.write(`gen-openapi: ${msg}\n`);
    process.exit(1);
  }
};
