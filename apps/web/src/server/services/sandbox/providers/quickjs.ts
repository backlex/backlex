import {
  getQuickJSWASMModule,
  type QuickJSContext,
  type QuickJSHandle,
} from "@cf-wasm/quickjs";
import type {
  SandboxBindings,
  SandboxProvider,
  SandboxResult,
} from "../types";

// `@cf-wasm/quickjs` bundles the QuickJS WASM as a module import (via package
// `exports` conditions) so the sandbox starts everywhere we deploy: the
// `workerd` build for Cloudflare Workers, `edge-light` for Vercel Edge, and
// `node` for Bun / Node self-host. We still guard the loader: if a runtime we
// don't have a variant for ever fails, surface a developer-actionable message
// pointing at the out-of-isolate execution backends.
const loadQuickJS = async () => {
  try {
    return await getQuickJSWASMModule();
  } catch (e) {
    const msg = (e as Error).message ?? "";
    if (/wasm|node:fs|fetching|module/i.test(msg)) {
      throw new Error(
        "QuickJS sandbox cannot start in this runtime. Set FUNCTIONS_EXEC_URL (external Bun/Node executor) or run `bun run dev:bun` locally.",
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

/** The one message every unreachable `ctx.*` host call answers with. */
export const HOST_IO_UNAVAILABLE =
  "host I/O is not available on the in-isolate QuickJS runtime (no ctx.fetch / ctx.db / ctx.email / ctx.push / ctx.ai) — set FUNCTIONS_EXEC_URL to an out-of-isolate executor, or, on a Bun self-host where function authors are the operator, FUNCTIONS_SANDBOX=bun-worker";

/**
 * Install every host call as a function that REFUSES, rather than leaving it
 * absent.
 *
 * Absent is what it used to be, and absent reads as a typo: a function written
 * against the documented `ctx.*` surface fails here with "undefined is not an
 * object", which sends the author to look at their own code. This provider is
 * the default on stock Cloudflare Workers, Vercel and Netlify — the deployments
 * most likely to be running a function copied out of the docs — so the runtime
 * has to say that the call is real and this is the wrong place for it.
 *
 * It cannot be made to work here instead: `@cf-wasm/quickjs` ships only the SYNC
 * wasm variants, so there is no way to suspend the guest while a host promise
 * settles. That is a dependency change, not a code change.
 */
const installRefusingHostIo = (vm: QuickJSContext, ctxHandle: QuickJSHandle): void => {
  const thrower = (name: string): QuickJSHandle =>
    vm.newFunction(name, () => {
      throw new Error(HOST_IO_UNAVAILABLE);
    });
  const setFn = (target: QuickJSHandle, name: string) => {
    const fn = thrower(name);
    vm.setProp(target, name, fn);
    fn.dispose();
  };
  const setNamespace = (name: string, methods: string[]) => {
    const obj = vm.newObject();
    for (const m of methods) setFn(obj, m);
    vm.setProp(ctxHandle, name, obj);
    obj.dispose();
  };
  setFn(ctxHandle, "fetch");
  setNamespace("db", ["list", "one"]);
  setNamespace("email", ["send"]);
  setNamespace("push", ["send"]);
  setNamespace("ai", ["generate"]);
};

/**
 * Opcode-budget ceiling for a single `run`.
 *
 * QuickJS invokes the interrupt handler every ~N opcodes, so this is a rough
 * instruction budget rather than a precise one. Sized to be far beyond any
 * legitimate transform (a function shaping a row does thousands of operations,
 * not tens of millions) while still tripping in well under a Worker's CPU limit
 * on a tight infinite loop.
 */
const MAX_INTERRUPT_TICKS = 2_000_000;

/**
 * QuickJS-WASM sandbox — sync only, no host I/O bridge. True isolation
 * (WASM sandbox) but cannot do `ctx.fetch` / `ctx.db` / `ctx.email`. This is
 * the DEFAULT everywhere, and the only in-isolate provider that is actually an
 * isolate: it runs on Cloudflare Workers, Vercel Edge, Netlify Edge, Node AND
 * Bun. For functions that need `ctx.*` host I/O, point `FUNCTIONS_EXEC_URL` at
 * an out-of-isolate executor instead.
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
    // Two budgets, because the wall clock does not run where this provider is
    // the DEFAULT.
    //
    // Cloudflare Workers (and Vercel/Netlify edge) pin `Date.now()` to the last
    // I/O as a timing-attack mitigation, so it returns a CONSTANT throughout a
    // synchronous computation. QuickJS calls this handler between opcodes, but
    // it never saw the deadline pass — so `while(true){}` in a function body ran
    // until workerd killed the whole request on its CPU limit, and the clean
    // `{ok:false, error:"timed out"}` this provider promises could never fire on
    // the one runtime where it is what runs by default. Event-triggered
    // functions are dispatched on the item write path, so a single runaway
    // `active` function turned every create/update in that workspace into a
    // CPU-limit failure until an operator noticed and disabled it.
    //
    // The tick count advances regardless of the clock, so IT is the budget that
    // actually fires on Workers; the wall-clock check stays for the runtimes
    // that have a live one, where it is the more meaningful of the two.
    let ticks = 0;
    runtime.setInterruptHandler(() => ++ticks > MAX_INTERRUPT_TICKS || Date.now() > deadline);
    runtime.setMemoryLimit(64 * 1024 * 1024);

    const vm = runtime.newContext();
    const logs: string[] = [];

    const consoleObj = vm.newObject();
    const logFn = vm.newFunction("log", (...args: QuickJSHandle[]) => {
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
    installRefusingHostIo(vm, ctxHandle);
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
