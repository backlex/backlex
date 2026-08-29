/**
 * Module hooks for {@link ./measure-startup.mjs}. Kept in its own file because
 * `module.register` loads it on a separate loader thread.
 *
 * Two things the worker bundle imports that plain Node cannot: the one
 * `cloudflare:sockets` specifier, and the `.sql` / `.wasm` assets the bundler
 * emits alongside the chunks. Both are stubbed — neither carries meaningful
 * compile cost, and the point of the measurement is the JavaScript.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const STUB = "data:text/javascript,export const connect=()=>{};export default{connect};";

export async function resolve(specifier, context, next) {
  if (specifier === "cloudflare:sockets")
    return { url: STUB, shortCircuit: true, format: "module" };
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (url.endsWith(".sql"))
    return {
      format: "module",
      shortCircuit: true,
      source: `export default ${JSON.stringify(readFileSync(fileURLToPath(url), "utf8"))};`,
    };
  if (url.endsWith(".wasm"))
    return { format: "module", shortCircuit: true, source: "export default null;" };
  return next(url, context);
}
