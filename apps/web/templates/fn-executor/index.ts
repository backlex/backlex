/**
 * workeros-fn-executor — sandbox sub-Worker for the cf-dispatch provider.
 *
 * Deploy this file as a Worker into your dispatch namespace:
 *
 *     wrangler dispatch-namespace create workeros-functions
 *     cd apps/api/templates/fn-executor
 *     wrangler deploy
 *
 * Then bind the namespace in your main `apps/api/wrangler.toml`:
 *
 *     [[dispatch_namespaces]]
 *     binding = "FUNCTIONS_DISPATCH"
 *     namespace = "workeros-functions"
 *
 * Each request lands in its own V8 isolate. The executor builds a `ctx`
 * with `data`, `user`, `console.log`, plus async proxies for
 * `ctx.fetch / ctx.db / ctx.email` that round-trip back to the main
 * Worker via `${mainOrigin}/api/_internal/sandbox-rpc` (Bearer-authenticated
 * with `rpcToken`). When `mainOrigin` or `rpcToken` is missing, the proxies
 * throw a clear error instead of silently failing.
 */

interface RunBody {
  code: string;
  data: unknown;
  user: { id: string | null; email: string | null; roles: string[] };
  timeoutMs: number;
  mainOrigin: string | null;
  rpcToken: string | null;
}

interface RunResult {
  ok: boolean;
  value?: unknown;
  logs: string[];
  error?: string;
}

const respond = (body: RunResult, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const buildRpc = (
  mainOrigin: string | null,
  rpcToken: string | null,
  user: RunBody["user"],
) => {
  if (!mainOrigin || !rpcToken) {
    return async () => {
      throw new Error(
        "ctx.* host bridges require SANDBOX_RPC_TOKEN + SELF_URL; ask your operator.",
      );
    };
  }
  const url = `${mainOrigin.replace(/\/$/, "")}/api/_internal/sandbox-rpc`;
  return async (op: string, args: unknown): Promise<unknown> => {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${rpcToken}`,
      },
      body: JSON.stringify({ op, args, auth: user }),
    });
    if (!res.ok) {
      throw new Error(`sandbox-rpc http ${res.status}`);
    }
    const reply = (await res.json()) as { ok: boolean; value?: unknown; error?: string };
    if (!reply.ok) throw new Error(reply.error ?? "rpc error");
    return reply.value;
  };
};

const buildCtx = (body: RunBody, rpc: ReturnType<typeof buildRpc>) => ({
  data: body.data,
  user: body.user,
  fetch: (url: string, init?: RequestInit) => rpc("fetch", { url, init }),
  db: {
    list: (slug: string, query?: unknown) => rpc("db.list", { slug, query }),
    one: (slug: string, id: string) => rpc("db.one", { slug, id }),
  },
  email: {
    send: (msg: { to: string; subject: string; text: string; html?: string }) =>
      rpc("email.send", msg),
  },
});

export default {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method !== "POST" || url.pathname !== "/run") {
      return new Response("not found", { status: 404 });
    }

    const body = (await req.json().catch(() => null)) as RunBody | null;
    if (!body || typeof body.code !== "string") {
      return respond(
        { ok: false, logs: [], error: "expected JSON { code, data, user, timeoutMs, mainOrigin, rpcToken }" },
        400,
      );
    }

    const logs: string[] = [];
    const captureConsole = {
      log: (...args: unknown[]) => {
        const parts = args.map((a) =>
          typeof a === "string"
            ? a
            : (() => {
                try {
                  return JSON.stringify(a);
                } catch {
                  return "[unserializable]";
                }
              })(),
        );
        logs.push(parts.join(" "));
      },
    };

    const rpc = buildRpc(body.mainOrigin, body.rpcToken, body.user);
    const ctx = buildCtx(body, rpc);
    const limit = Math.max(50, Math.min(60_000, body.timeoutMs ?? 5000));

    try {
      // Async IIFE so user code can `await ctx.fetch / ctx.db / ctx.email`.
      const fn = new Function(
        "ctx",
        "console",
        `return (async () => {\n${body.code}\n})()`,
      ) as (
        c: typeof ctx,
        log: typeof captureConsole,
      ) => Promise<unknown>;

      const value = await Promise.race([
        fn(ctx, captureConsole),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`timed out after ${limit}ms`)), limit),
        ),
      ]);
      return respond({ ok: true, value, logs });
    } catch (e) {
      return respond({
        ok: false,
        logs,
        error: (e as Error).message,
      });
    }
  },
};
