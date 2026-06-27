/**
 * Build-time constants injected by Vite `define` (see apps/web/vite.config.ts).
 *
 * Kept in a `.d.ts` (not an inline `declare const`) on purpose: Vite's `define`
 * does a textual replacement of the identifier across bundled modules, which
 * would corrupt an inline `declare const __TEMPLATE_VERSION__` into
 * `declare const "0.4.10"`. Ambient `.d.ts` files are type-only and never run
 * through `define`, so the declaration survives.
 */

/** Worker-template version (e.g. "0.4.10"), or "dev" outside a template build. */
declare const __TEMPLATE_VERSION__: string;

/** App version — cloud template tag, else nearest git tag, else package version. */
declare const __APP_VERSION__: string;
/** Short git commit hash of the build (e.g. "a8b2f1c"), or "unknown". */
declare const __GIT_COMMIT__: string;
/** Build date in ISO `YYYY-MM-DD`. */
declare const __BUILD_DATE__: string;
/** Installed Wrangler version at build time, or "unknown". */
declare const __WRANGLER_VERSION__: string;
