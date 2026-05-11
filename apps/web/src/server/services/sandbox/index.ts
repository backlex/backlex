import { bunWorkerProvider } from "./providers/bun-worker";
import { cfDispatchProvider } from "./providers/cf-dispatch";
import { quickjsProvider } from "./providers/quickjs";
import { remoteHttpProvider } from "./providers/remote-http";
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
 *   1. cf-dispatch  — Cloudflare Workers for Platforms with FUNCTIONS_DISPATCH
 *                     binding (V8 isolate per request via dispatch namespace).
 *   2. remote-http  — FUNCTIONS_EXEC_URL set: out-of-isolate Bun/Node executor
 *                     over HTTP. Works from any runtime (CF Workers, Vercel
 *                     Edge, Netlify Edge, …) and supports ctx.* host I/O.
 *   3. bun-worker   — Bun self-host: worker thread + RPC bridge to
 *                     db / fetch / email.
 *   4. quickjs      — everywhere else: in-isolate QuickJS-WASM (sync only, no
 *                     host I/O). The cross-runtime safety net — runs on CF
 *                     Workers, Vercel Edge, Netlify Edge and Node without any
 *                     external infra.
 */
const selectProvider = (bindings: SandboxBindings): SandboxProvider => {
  if (bindings.ctx.env.FUNCTIONS_DISPATCH !== undefined) {
    return cfDispatchProvider;
  }
  if (bindings.ctx.env.FUNCTIONS_EXEC_URL) {
    return remoteHttpProvider;
  }
  if (isBun()) return bunWorkerProvider;
  return quickjsProvider;
};

export const runFunction = async (
  source: string,
  bindings: SandboxBindings,
  data: unknown,
  timeoutMs: number,
): Promise<SandboxResult> => {
  const provider = selectProvider(bindings);
  return provider.run(source, bindings, data, timeoutMs);
};
