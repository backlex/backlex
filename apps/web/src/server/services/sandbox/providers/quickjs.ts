import {
  getQuickJS,
  type QuickJSContext,
  type QuickJSHandle,
} from "quickjs-emscripten";
import type {
  SandboxBindings,
  SandboxProvider,
  SandboxResult,
} from "../types";

// QuickJS-WASM works under Bun and Node but the published variants depend on
// `fetch('quickjs.wasm')` (wasmfile) or `node:fs` (singlefile-mjs) — neither is
// available inside a Cloudflare Workers V8 isolate. We catch the loader's
// own failure and re-throw with a developer-actionable message.
const loadQuickJS = async () => {
  try {
    return await getQuickJS();
  } catch (e) {
    const msg = (e as Error).message ?? "";
    if (/wasm|node:fs|fetching/i.test(msg)) {
      throw new Error(
        "QuickJS sandbox cannot start in this runtime (likely Cloudflare Workers). Run `bun run dev:bun` to invoke functions locally, or wire FUNCTIONS_DISPATCH for production.",
      );
    }
    throw e;
  }
};

const toQuick = (vm: QuickJSContext, value: unknown): QuickJSHandle => {
  if (value === null) return vm.null;
  if (value === undefined) return vm.undefined;
  if (typeof value === "boolean") return value ? vm.true : vm.false;
  if (typeof value === "number") return vm.newNumber(value);
  if (typeof value === "string") return vm.newString(value);
  if (Array.isArray(value)) {
    const arr = vm.newArray();
    for (let i = 0; i < value.length; i++) {
      const item = toQuick(vm, value[i]);
      vm.setProp(arr, i, item);
      item.dispose();
    }
    return arr;
  }
  if (typeof value === "object") {
    const obj = vm.newObject();
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const item = toQuick(vm, v);
      vm.setProp(obj, k, item);
      item.dispose();
    }
    return obj;
  }
  return vm.undefined;
};

const fromQuick = (vm: QuickJSContext, handle: QuickJSHandle): unknown => {
  const json = vm.getProp(vm.global, "JSON");
  const stringify = vm.getProp(json, "stringify");
  const result = vm.callFunction(stringify, json, handle);
  json.dispose();
  stringify.dispose();
  if (result.error) {
    const msg = vm.dump(result.error);
    result.error.dispose();
    throw new Error(
      `fromQuick: ${typeof msg === "string" ? msg : "non-serializable result"}`,
    );
  }
  const str = vm.dump(result.value) as string | undefined;
  result.value.dispose();
  if (str === undefined) return undefined;
  try {
    return JSON.parse(str);
  } catch {
    return str;
  }
};

/**
 * QuickJS-WASM sandbox — sync only, no host I/O bridge. True isolation
 * (WASM sandbox) but cannot do `ctx.fetch` / `ctx.db` / `ctx.email`. Used
 * as the cross-runtime fallback (e.g., Cloudflare Workers without dispatch).
 */
export const quickjsProvider: SandboxProvider = {
  name: "quickjs",
  async run(
    source: string,
    bindings: SandboxBindings,
    data: unknown,
    timeoutMs: number,
  ): Promise<SandboxResult> {
    const QuickJS = await loadQuickJS();
    const runtime = QuickJS.newRuntime();
    const start = Date.now();
    const deadline = start + Math.max(50, Math.min(60_000, timeoutMs));
    runtime.setInterruptHandler(() => Date.now() > deadline);
    runtime.setMemoryLimit(64 * 1024 * 1024);

    const vm = runtime.newContext();
    const logs: string[] = [];

    const consoleObj = vm.newObject();
    const logFn = vm.newFunction("log", (...args) => {
      const parts = args.map((h) => {
        try {
          const v = vm.dump(h);
          return typeof v === "string" ? v : JSON.stringify(v);
        } catch {
          return "[unserializable]";
        }
      });
      logs.push(parts.join(" "));
      return vm.undefined;
    });
    vm.setProp(consoleObj, "log", logFn);
    logFn.dispose();
    vm.setProp(vm.global, "console", consoleObj);
    consoleObj.dispose();

    const ctxHandle = toQuick(vm, {
      data,
      user: {
        id: bindings.auth.userId,
        email: bindings.auth.email,
        roles: bindings.auth.roles,
      },
    });
    vm.setProp(vm.global, "ctx", ctxHandle);
    ctxHandle.dispose();

    const wrapped = `(() => {\n${source}\n})()`;

    let result: SandboxResult;
    try {
      const evalResult = vm.evalCode(wrapped);
      if (evalResult.error) {
        const errVal = vm.dump(evalResult.error);
        evalResult.error.dispose();
        result = {
          ok: false,
          logs,
          error:
            typeof errVal === "object" && errVal && "message" in errVal
              ? String((errVal as { message: unknown }).message)
              : String(errVal),
          durationMs: Date.now() - start,
        };
      } else {
        const value = fromQuick(vm, evalResult.value);
        evalResult.value.dispose();
        result = { ok: true, value, logs, durationMs: Date.now() - start };
      }
    } catch (e) {
      result = {
        ok: false,
        logs,
        error: (e as Error).message,
        durationMs: Date.now() - start,
      };
    } finally {
      vm.dispose();
      runtime.dispose();
    }
    return result;
  },
};
