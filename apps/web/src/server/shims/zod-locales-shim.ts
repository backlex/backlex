/**
 * zod's locale table, removed from the bundle.
 *
 * `zod/v4/classic/external.js` ends with `export * as locales from
 * "../locales/index.js"`. An `export * as` builds a namespace OBJECT, which has
 * to be materialised, so every one of the 63 locale modules is reachable and no
 * bundler can drop them. Measured on this tree with `bun build --minify`:
 *
 *   import { z } from "zod"          282,733 B
 *   import * as l from "zod/v4/locales"  152,209 B   ← 53% of the above
 *   import en from ".../locales/en.js"     3,290 B   ← the one actually used
 *
 * ~149 KB of that sits in the worker's EAGER chunk, which Cloudflare compiles
 * at every cold start — the budget that produces error 10021 and the one
 * `docs/performance.md` is mostly about.
 *
 * Nothing needs it. Zero references to `z.locales`, `z.config` or
 * `zod/v4/locales` in this repo, and zero in the five packages that consume zod
 * here (better-auth, @hono/zod-openapi, @asteasolutions/zod-to-openapi, ai,
 * @ai-sdk/provider-utils) — checked, not assumed. English messages are
 * unaffected: `en` is imported DIRECTLY by zod's barrel, on its own line, and is
 * not part of this namespace.
 *
 * So `z.locales` is `{}` in this build. If something ever needs a non-English
 * locale, delete the plugin in `vite.config.ts` rather than adding a key here —
 * a half-populated namespace would be worse than an empty one, because the
 * missing language would look like a zod bug.
 */
export {};
