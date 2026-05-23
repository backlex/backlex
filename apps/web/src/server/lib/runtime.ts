/**
 * Runtime detection. Used by adapter selectors to refuse code paths that
 * need raw TCP / `node:net` / `node:tls` on V8-isolate edges (Cloudflare
 * Workers, Vercel Edge) and on Deno Deploy (Netlify Edge).
 *
 * Kept tiny and synchronous — these checks fire during `buildContext` (once
 * per isolate) and inside adapter factories, so they have to work at module
 * init time on every supported runtime.
 */

const ua = (): string | undefined =>
  typeof navigator !== "undefined"
    ? (navigator as { userAgent?: string }).userAgent
    : undefined;

export const isCloudflareWorkers = (): boolean =>
  ua() === "Cloudflare-Workers";

/** Vercel Edge sets `EdgeRuntime` on globalThis and exposes `process.env.VERCEL`. */
export const isVercelEdge = (): boolean => {
  const g = globalThis as { EdgeRuntime?: unknown };
  if (typeof g.EdgeRuntime === "string") return true;
  const p = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process;
  return Boolean(p?.env?.VERCEL && typeof g.EdgeRuntime !== "undefined");
};

/** Netlify Edge runs on Deno Deploy. */
export const isNetlifyEdge = (): boolean => {
  const d = (globalThis as { Deno?: unknown }).Deno;
  if (typeof d === "undefined") return false;
  const p = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process;
  return Boolean(
    p?.env?.NETLIFY ||
      p?.env?.NETLIFY_EDGE ||
      (globalThis as { NETLIFY?: unknown }).NETLIFY,
  );
};

/** Any V8-isolate / Deno edge runtime where Node TCP, fs, and most native
 *  Node modules are unavailable. Bun, Node self-host, and traditional
 *  serverful processes return false. */
export const isEdgeRuntime = (): boolean =>
  isCloudflareWorkers() || isVercelEdge() || isNetlifyEdge();

/** Edge runtimes that are also stateless per-invocation — module-level
 *  state (Maps, in-process pub/sub) doesn't survive between requests. CF
 *  Workers reuse isolates and have Durable Objects, so they're excluded. */
export const isStatelessEdge = (): boolean =>
  isVercelEdge() || isNetlifyEdge();
