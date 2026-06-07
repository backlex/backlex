import type {
  SandboxBindings,
  SandboxProvider,
  SandboxResult,
} from "./types";

export type { SandboxBindings, SandboxResult, SandboxProvider } from "./types";

const isBun = (): boolean =>
  typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

/**
 * Provider selection priority:
 *   1. remote-http  — FUNCTIONS_EXEC_URL set: out-of-isolate Bun/Node executor
 *                     over HTTP. Works from any runtime (CF Workers, Vercel
 *                     Edge, Netlify Edge, …) and supports ctx.* host I/O.
 *   2. bun-worker   — Bun self-host: worker thread + RPC bridge to
 *                     db / fetch / email.
 *   3. quickjs      — everywhere else: in-isolate QuickJS-WASM (sync only, no
 *                     host I/O). The cross-runtime safety net — runs on CF
 *                     Workers, Vercel Edge, Netlify Edge and Node without any
 *                     external infra.
 */
const selectProvider = async (
  bindings: SandboxBindings,
): Promise<SandboxProvider> => {
  // Dynamic-import each provider so the heavy QuickJS-WASM blob (and the
  // bun-worker / remote-http graphs) stay out of the worker's cold-start eval
  // path — they load only when a function actually executes. Paired with the
  // `undefined` manualChunks branch in vite.config so they land in lazy chunks.
  if (bindings.ctx.env.FUNCTIONS_EXEC_URL) {
    return (await import("./providers/remote-http")).remoteHttpProvider;
  }
  if (isBun()) return (await import("./providers/bun-worker")).bunWorkerProvider;
  return (await import("./providers/quickjs")).quickjsProvider;
};

export const runFunction = async (
  source: string,
  bindings: SandboxBindings,
  data: unknown,
  timeoutMs: number,
): Promise<SandboxResult> => {
  const provider = await selectProvider(bindings);
  return provider.run(source, bindings, data, timeoutMs);
};
