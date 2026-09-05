import { signSandboxGrant } from "../../../lib/crypto";
import type {
  SandboxBindings,
  SandboxProvider,
  SandboxResult,
} from "../types";

/** How long past the guest's own deadline a grant stays valid. The executor
 *  makes its LAST callback while the guest is still running, so the grant only
 *  has to outlive the run — plus enough slack for clock skew between the two
 *  hosts and the callback in flight when the timeout fires. */
const GRANT_SLACK_MS = 30_000;

/**
 * Generic out-of-isolate sandbox provider.
 *
 * When `env.FUNCTIONS_EXEC_URL` is set, function invocations are POSTed to
 * `${FUNCTIONS_EXEC_URL}/run` on a separate executor service (e.g. the
 * `templates/fn-exec-server` Bun process running on Fly / Railway / a VM, or
 * any compatible endpoint). The executor runs user code in a real runtime
 * where `eval` / `new Function` are allowed, so `ctx.fetch / ctx.db /
 * ctx.email` work — those calls round-trip back to the main app via
 * `${mainOrigin}/api/_internal/sandbox-rpc`, Bearer-authenticated with the
 * per-invocation grant this provider mints below.
 *
 * Wire format:
 *   POST /run  { code, data, user, timeoutMs, mainOrigin, rpcToken }
 *   ->         { ok, value?, logs, error? }
 *
 * `user` is still sent because the guest reads it as `ctx.user`. It is NOT
 * what the callback authenticates against — the executor runs user code and
 * anything it echoes back is attacker-controlled, so the callback reads its
 * subject out of `rpcToken`'s signature instead.
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
    const url = `${base.replace(/\/$/, "")}/run`;

    // What goes over the wire as `rpcToken` is a per-invocation GRANT, not
    // `SANDBOX_RPC_TOKEN` itself. The executor treats the field as opaque and
    // echoes it back as its bearer, so the wire format is unchanged and the
    // shipped template needs no edit — but the deployment secret now stays in
    // this process, and the callback derives its subject from the signature
    // instead of from the executor's request body. See `signSandboxGrant`.
    const secret = bindings.ctx.env.SANDBOX_RPC_TOKEN ?? null;
    const rpcToken = secret
      ? await signSandboxGrant(
          {
            u: bindings.auth.userId ?? null,
            e: bindings.auth.email ?? null,
            r: bindings.auth.roles ?? [],
            t: bindings.auth.tenantId ?? null,
            exp: Math.floor((Date.now() + limit + GRANT_SLACK_MS) / 1000),
          },
          secret,
        )
      : null;

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
            // Workspace scope — the executor echoes this back verbatim in its
            // sandbox-rpc callbacks so tenant-scoped ops (ctx.db / ctx.email /
            // ctx.push) resolve against the right workspace.
            tenantId: bindings.auth.tenantId ?? null,
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
