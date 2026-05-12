import type {
  SandboxBindings,
  SandboxProvider,
  SandboxResult,
} from "../types";

/**
 * Generic out-of-isolate sandbox provider.
 *
 * When `env.FUNCTIONS_EXEC_URL` is set, function invocations are POSTed to
 * `${FUNCTIONS_EXEC_URL}/run` on a separate executor service (e.g. the
 * `templates/fn-exec-server` Bun process running on Fly / Railway / a VM, or
 * any compatible endpoint). The executor runs user code in a real runtime
 * where `eval` / `new Function` are allowed, so `ctx.fetch / ctx.db /
 * ctx.email` work — those calls round-trip back to the main app via
 * `${mainOrigin}/api/_internal/sandbox-rpc`, Bearer-authenticated with
 * `env.SANDBOX_RPC_TOKEN`.
 *
 * Wire format:
 *   POST /run  { code, data, user, timeoutMs, mainOrigin, rpcToken }
 *   ->         { ok, value?, logs, error? }
 *
 * This lets the API stay on an edge runtime (CF Workers / Vercel Edge /
 * Netlify Edge) while still offering DB-aware functions.
 */
export const remoteHttpProvider: SandboxProvider = {
  name: "remote-http",
  async run(
    source: string,
    bindings: SandboxBindings,
    data: unknown,
    timeoutMs: number,
  ): Promise<SandboxResult> {
    const start = Date.now();
    const base = bindings.ctx.env.FUNCTIONS_EXEC_URL;
    if (!base) {
      return {
        ok: false,
        logs: [],
        error: "FUNCTIONS_EXEC_URL is not configured",
        durationMs: Date.now() - start,
      };
    }

    const limit = Math.max(50, Math.min(60_000, timeoutMs));
    const mainOrigin =
      bindings.selfOrigin ?? bindings.ctx.env.SELF_URL ?? null;
    const rpcToken = bindings.ctx.env.SANDBOX_RPC_TOKEN ?? null;
    const url = `${base.replace(/\/$/, "")}/run`;

    let res: Response;
    try {
      res = await fetch(url, {
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
      | { ok: boolean; value?: unknown; logs?: string[]; error?: string }
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
