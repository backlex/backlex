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

/** Legacy rows warned about once per process, so a busy cron trigger does not
 *  turn a standing condition into a log flood. */
const warnedLegacy = new Set<string>();

/**
 * May THIS code have the soft sandbox? Exported so a spec can drive the
 * decision directly — a rule reachable only through a live Bun worker is a rule
 * nobody writes the negative case for, which is how the `file:` scheme hole in
 * the fetch allow-list survived.
 *
 * Reads `bindings.authorKind`, which the row carries and the run path passes.
 * See the docblock on `selectProvider` for why NULL keeps the soft sandbox and
 * why the opt-out exists.
 */
export const softSandboxAllowed = (bindings: SandboxBindings): boolean => {
  if ((bindings.ctx.env.FUNCTIONS_SANDBOX_TRUST_ALL_AUTHORS ?? "").trim() === "1") return true;
  const author = bindings.authorKind ?? null;
  if (author === "tenant") return false;
  if (author === null) {
    // Not an error and not a refusal — this row is on the behaviour it has
    // always had. Said out loud so the operator can see what is left to
    // attribute, because the alternative is a silent standing exposure.
    const key = bindings.functionName ?? "(unnamed)";
    if (!warnedLegacy.has(key)) {
      warnedLegacy.add(key);
      console.warn(
        JSON.stringify({
          level: "warn",
          msg: "sandbox-legacy-author",
          fn: key,
          detail:
            "running in the SOFT sandbox with no recorded author (row predates functions.author_kind). Re-save its code to stamp one; a tenant-authored function is clamped to quickjs.",
        }),
      );
    }
  }
  return true;
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
 *
 * ## Per-AUTHOR, since `functions.author_kind` exists
 *
 * That flag is deployment-wide, and it had to be: the table recorded
 * `tenant_id` and no author, so there was nothing to key a narrower rule by.
 * With the column, `bun-worker` means what it always claimed to — *the people
 * authoring functions are the people who run the deployment* — and a function
 * whose author was NOT the instance operator falls back to `quickjs` instead.
 *
 * Three properties of that clamp, each deliberate:
 *
 *  · **NULL keeps the soft sandbox.** A row that predates the column cannot be
 *    attributed, and treating unknown as untrusted would break every existing
 *    function on an upgrade — `quickjs` has no host I/O at all. It warns
 *    instead, naming the function, so the residue is visible rather than
 *    guessed at. Re-saving the code stamps an author and clears it.
 *  · **It only bites `bun-worker`.** `remote-http` and `quickjs` are already
 *    isolated from the host, so an author's trust level buys nothing there and
 *    a clamp would just be a second thing to keep in step.
 *  · **`FUNCTIONS_SANDBOX_TRUST_ALL_AUTHORS=1` opts out**, for the deployment
 *    whose functions are written by an automation holding an API key —
 *    `isInstanceOperator` refuses a key identity by design, so such a row is
 *    stamped `tenant` and would otherwise lose host access on upgrade. The
 *    escape hatch exists because that is a real deployment, not because the
 *    clamp is optional.
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
    if (!softSandboxAllowed(bindings)) {
      return (await import("./providers/quickjs")).quickjsProvider;
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
