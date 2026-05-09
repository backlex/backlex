import type {
  SandboxBindings,
  SandboxProvider,
  SandboxResult,
} from "../types";

/**
 * Cloudflare Workers-for-Platforms dispatch-namespace provider (v4).
 *
 * Routes function invocations to a single shared executor sub-Worker named
 * `workeros-fn-executor` deployed into the bound dispatch namespace. The
 * executor accepts:
 *   { code, data, user, timeoutMs, mainOrigin, rpcToken }
 * runs user code in its own V8 isolate, and (when `mainOrigin` + `rpcToken`
 * are provided) exposes async `ctx.fetch / ctx.db / ctx.email` that proxy
 * back to the main Worker via `/api/_internal/sandbox-rpc`.
 *
 * Setup (operator):
 *   1. Create the namespace:    wrangler dispatch-namespace create workeros-functions
 *   2. Deploy the executor:     cd apps/api/templates/fn-executor && wrangler deploy
 *   3. Bind in main wrangler.toml:
 *        [[dispatch_namespaces]]
 *        binding = "FUNCTIONS_DISPATCH"
 *        namespace = "workeros-functions"
 *   4. Generate + set the RPC token (any 32-byte hex):
 *        wrangler secret put SANDBOX_RPC_TOKEN
 *   5. Set SELF_URL for cron-triggered functions (optional for HTTP):
 *        wrangler secret put SELF_URL  # e.g. https://api.workeros.dev
 */
export const cfDispatchProvider: SandboxProvider = {
  name: "cf-dispatch",
  async run(
    source: string,
    bindings: SandboxBindings,
    data: unknown,
    timeoutMs: number,
  ): Promise<SandboxResult> {
    const start = Date.now();
    const dispatch = bindings.ctx.env.FUNCTIONS_DISPATCH;
    if (!dispatch) {
      return {
        ok: false,
        logs: [],
        error: "FUNCTIONS_DISPATCH binding is not configured",
        durationMs: Date.now() - start,
      };
    }

    let stub;
    try {
      stub = dispatch.get("workeros-fn-executor");
    } catch (e) {
      return {
        ok: false,
        logs: [],
        error: `dispatch.get failed: ${(e as Error).message}`,
        durationMs: Date.now() - start,
      };
    }

    const limit = Math.max(50, Math.min(60_000, timeoutMs));
    const mainOrigin =
      bindings.selfOrigin ?? bindings.ctx.env.SELF_URL ?? null;
    const rpcToken = bindings.ctx.env.SANDBOX_RPC_TOKEN ?? null;

    let res: Response;
    try {
      res = await stub.fetch("https://exec/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          code: source,
          data,
          user: {
            id: bindings.auth.userId,
            email: bindings.auth.email,
            roles: bindings.auth.roles,
          },
          timeoutMs: limit,
          mainOrigin,
          rpcToken,
        }),
      });
    } catch (e) {
      return {
        ok: false,
        logs: [],
        error: `executor fetch failed: ${(e as Error).message}`,
        durationMs: Date.now() - start,
      };
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return {
        ok: false,
        logs: [],
        error: `executor http ${res.status}: ${text.slice(0, 200)}`,
        durationMs: Date.now() - start,
      };
    }

    const body = (await res.json().catch(() => null)) as
      | {
          ok: boolean;
          value?: unknown;
          logs?: string[];
          error?: string;
        }
      | null;
    if (!body) {
      return {
        ok: false,
        logs: [],
        error: "executor returned non-JSON body",
        durationMs: Date.now() - start,
      };
    }
    return {
      ok: body.ok,
      value: body.value,
      logs: body.logs ?? [],
      error: body.error,
      durationMs: Date.now() - start,
    };
  },
};
