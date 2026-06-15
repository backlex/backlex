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

/** Deno Deploy (managed) — sets `DENO_DEPLOYMENT_ID` in the isolate. Distinct
 *  from `deno run` self-host (which doesn't). Its sandboxed edge isolates have
 *  no native FFI and unreliable raw TCP, so it must use HTTP-based drivers
 *  (neon-http / Turso HTTP / aws4fetch) and the WASM image fallback. */
export const isDenoDeploy = (): boolean => {
  const g = globalThis as {
    Deno?: { env?: { get(k: string): string | undefined } };
  };
  return Boolean(g.Deno?.env?.get?.("DENO_DEPLOYMENT_ID"));
};

/** Any V8-isolate / Deno edge runtime where Node TCP, fs, and most native
 *  Node modules are unavailable. Bun, Node self-host, and traditional
 *  serverful processes return false. */
export const isEdgeRuntime = (): boolean =>
  isCloudflareWorkers() || isVercelEdge() || isNetlifyEdge() || isDenoDeploy();

/** Edge runtimes that are also stateless per-invocation — module-level
 *  state (Maps, in-process pub/sub) doesn't survive between requests. CF
 *  Workers reuse isolates and have Durable Objects, so they're excluded.
 *  Deno Deploy is included: HTTP DB driver is forced and in-proc realtime
 *  bails (use Upstash), exactly like Vercel/Netlify serverless. */
export const isStatelessEdge = (): boolean =>
  isVercelEdge() || isNetlifyEdge() || isDenoDeploy();

/** Netlify *Functions* (Node 22), as opposed to Netlify Edge (Deno). Netlify
 *  sets `NETLIFY=true` in the function environment. Used to route image
 *  transforms through the native Netlify Image CDN (`/.netlify/images`) instead
 *  of bundling sharp's native addon into the function. */
export const isNetlify = (): boolean => {
  // The Netlify Function entry sets this marker at module load — the most
  // reliable signal, since `process.env.NETLIFY` isn't guaranteed at runtime.
  if ((globalThis as { __BACKLEX_NETLIFY?: boolean }).__BACKLEX_NETLIFY) return true;
  const g = globalThis as { Deno?: unknown };
  if (typeof g.Deno !== "undefined") return false; // that's Netlify Edge
  const p = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process;
  return Boolean(p?.env?.NETLIFY);
};

/** Vercel (any plane) — both Node Functions and Edge set `process.env.VERCEL`.
 *  Unlike `isVercelEdge()` this is true on the serverful Node-Function deploy
 *  too. Used to refuse the local-fs storage fallback: a Vercel/Netlify function
 *  has a writable but EPHEMERAL fs, so uploads would vanish between
 *  invocations — those runtimes must use S3/R2 just like the true edges. */
export const isVercel = (): boolean => {
  const p = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process;
  return Boolean(p?.env?.VERCEL);
};

/** Xata Postgres endpoints host on `*.xata.sh`. Xata speaks the standard
 *  Postgres wire protocol (works with postgres-js out of the box) but does
 *  NOT ship the pgvector extension — vector workloads have to be routed
 *  through Workers Vectorize or a separate provider. */
export const isXataPgUrl = (url: string | undefined): boolean =>
  !!url && /\.xata\.sh(?::\d+)?\//.test(url);
