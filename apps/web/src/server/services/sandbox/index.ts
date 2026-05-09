import { bunWorkerProvider } from "./providers/bun-worker";
import { cfDispatchProvider } from "./providers/cf-dispatch";
import { quickjsProvider } from "./providers/quickjs";
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
 *   1. cf-dispatch — Workers paid plan with FUNCTIONS_DISPATCH binding (V8
 *      isolate per request via dispatch namespace).
 *   2. bun-worker — Bun runtime (full async + RPC bridge to db/fetch/email).
 *   3. quickjs — anywhere else (sync-only WASM fallback; the cross-runtime
 *      safety net for free-tier Workers and any environment where the other
 *      two aren't available).
 */
const selectProvider = (bindings: SandboxBindings): SandboxProvider => {
  if (bindings.ctx.env.FUNCTIONS_DISPATCH !== undefined) {
    return cfDispatchProvider;
  }
  if (bindings.ctx.env.D1 !== undefined) {
    // On Workers without a dispatch namespace, fall through to QuickJS —
    // bun-worker isn't usable here.
    return quickjsProvider;
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
