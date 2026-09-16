/**
 * The version this instance reports — Settings → About and the footer of every
 * auth card.
 *
 * `__APP_VERSION__` is a build-time define (`apps/web/vite.config.ts`) derived
 * from the shipped `worker-v*` tag, so it moves on every release. The auth
 * pages used to import `version` out of `apps/web/package.json` instead, and
 * that field has read `0.0.1` since the workspace was created — nothing bumps
 * it, because the tenant runtime is released by tag, not by npm version. So
 * every deploy ever made printed `v0.0.1` on its sign-in screen.
 *
 * The `typeof` guard is for runtimes that evaluate these modules without
 * vite's `define` — bun test imports the pages directly, where the identifier
 * simply does not exist and a bare reference is a ReferenceError.
 */
export const APP_VERSION: string =
  typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "dev";

/**
 * Same string without a leading `v`: `AuthShell` renders its own `v` prefix,
 * and `git describe` output already carries one (`v0.4.126-131-g1037d0fc`).
 */
export const APP_VERSION_LABEL: string = APP_VERSION.replace(/^v/, "");
