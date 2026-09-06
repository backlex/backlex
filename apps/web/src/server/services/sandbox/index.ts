import type {
  SandboxBindings,
  SandboxProvider,
  SandboxResult,
} from "./types";

export type { SandboxBindings, SandboxResult, SandboxProvider } from "./types";

const isBun = (): boolean =>
  typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

/** What an operator may pin `FUNCTIONS_SANDBOX` to. Anything else — including
 *  the empty string — reads as `auto`. */
const PROVIDERS = ["auto", "remote-http", "bun-worker", "quickjs"] as const;
type ProviderName = (typeof PROVIDERS)[number];

const readChoice = (raw: string | undefined): ProviderName => {
  const v = (raw ?? "").trim().toLowerCase();
  return (PROVIDERS as readonly string[]).includes(v)
    ? (v as ProviderName)
    : "auto";
};

/**
 * Provider selection.
 *
 * `auto` (the default) picks the strongest isolation the deployment can offer:
 *   1. remote-http  — FUNCTIONS_EXEC_URL set: out-of-isolate Bun/Node executor
 *                     over HTTP. Works from any runtime (CF Workers, Vercel
 *                     Edge, Netlify Edge, …) and supports ctx.* host I/O.
 *   2. quickjs      — everywhere else: in-isolate QuickJS-WASM (sync only, no
 *                     host I/O). The cross-runtime safety net — runs on CF
 *                     Workers, Vercel Edge, Netlify Edge, Node AND Bun without
 *                     any external infra.
 *
 * ## Why `bun-worker` is not in that list any more
 *
 * It used to be step 2, chosen automatically whenever the runtime was Bun. It
 * is a SOFT sandbox and always said so in a comment — but the gap is not
 * partial. Measured directly against a Worker running this repo's own
 * delete-loop + `new Function` construction: `await import("node:process")`
 * returns the API host's whole env, `await import("node:fs")` reads any file,
 * and `globalThis.Bun.spawnSync(["whoami"])` runs commands. None of it is
 * fixable from inside the isolate — `Bun` is defined `configurable: false,
 * writable: false`, so the redefinition trick throws rather than shadowing it,
 * and `import()` is a keyword that no parameter can shadow.
 *
 * Function authoring is gated on the `admin` role, which `POST /api/tenants`
 * grants to whoever creates a workspace. So on a multi-tenant Bun self-host
 * "author a function" and "run commands on the API host, read DATABASE_URL,
 * read every other workspace's data" were the same permission.
 *
 * A soft sandbox is still the right tool where the function author IS the
 * operator — a single-tenant self-host, a dev box — and nothing in the schema
 * says which of those a deployment is. So it stays available and the operator
 * says: `FUNCTIONS_SANDBOX=bun-worker`. Default closed, opt in deliberately.
 */
const selectProvider = async (
  bindings: SandboxBindings,
): Promise<SandboxProvider> => {
  // Dynamic-import each provider so the heavy QuickJS-WASM blob (and the
  // bun-worker / remote-http graphs) stay out of the worker's cold-start eval
  // path — they load only when a function actually executes. Paired with the
  // `undefined` manualChunks branch in vite.config so they land in lazy chunks.
  const choice = readChoice(bindings.ctx.env.FUNCTIONS_SANDBOX);

  if (choice === "bun-worker") {
    if (!isBun()) {
      throw new Error(
        "FUNCTIONS_SANDBOX=bun-worker needs the Bun runtime; this deployment is not on Bun. Unset it to fall back to the in-isolate QuickJS sandbox, or set FUNCTIONS_EXEC_URL.",
      );
    }
    return (await import("./providers/bun-worker")).bunWorkerProvider;
  }
  if (choice === "quickjs") {
    return (await import("./providers/quickjs")).quickjsProvider;
  }
  if (choice === "remote-http" || bindings.ctx.env.FUNCTIONS_EXEC_URL) {
    return (await import("./providers/remote-http")).remoteHttpProvider;
  }
  return (await import("./providers/quickjs")).quickjsProvider;
};

export const runFunction = async (
  source: string,
  bindings: SandboxBindings,
  data: unknown,
  timeoutMs: number,
): Promise<SandboxResult> => {
  const start = Date.now();
  let provider: SandboxProvider;
  try {
    provider = await selectProvider(bindings);
  } catch (e) {
    // A misconfigured FUNCTIONS_SANDBOX is an operator problem, and it reads
    // best as the run's own error — the same shape `remote-http` already
    // answers with when FUNCTIONS_EXEC_URL is missing. Letting it escape would
    // surface as a 500 with no clue which setting is wrong.
    return {
      ok: false,
      logs: [],
      error: (e as Error).message,
      durationMs: Date.now() - start,
    };
  }
  return provider.run(source, bindings, data, timeoutMs);
};
