/**
 * workeros fn-exec-server — out-of-isolate function executor for the
 * `remote-http` sandbox provider.
 *
 * Run this as a standalone Bun process anywhere `eval` / `new Function` are
 * allowed (Fly.io, Railway, Render, a plain VM, Cloudflare Containers, …):
 *
 *     bun run index.ts          # listens on PORT (default 8790)
 *
 * Then point the main app at it:
 *
 *     FUNCTIONS_EXEC_URL = https://your-exec-host        # base URL, no /run
 *     SANDBOX_RPC_TOKEN  = <same 32-byte hex as the main app>
 *     SELF_URL           = https://your-main-app          # for ctx.* callbacks
 *
 * The main app POSTs `{ code, data, user, timeoutMs, mainOrigin, rpcToken }`
 * to `${FUNCTIONS_EXEC_URL}/run`. We run the user code in an async IIFE with a
 * `ctx` whose `fetch / db / email` round-trip back to
 * `${mainOrigin}/api/_internal/sandbox-rpc` (Bearer-authenticated with
 * `rpcToken`). When `mainOrigin` or `rpcToken` is missing the `ctx.*` proxies
 * throw a clear error instead of silently failing.
 *
 * Security note: this is a SOFT sandbox — the worker shares the process's
 * globals. Run it as an isolated, least-privilege service (its own host /
 * container, no extra secrets, restricted egress). For hard isolation back it
 * with a microVM-backed runner.
 */

const PORT = Number(globalThis.process?.env?.PORT ?? 8790);

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

const json = (body: RunResult, status = 200): Response =>
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
        "ctx.* host bridges require SANDBOX_RPC_TOKEN + SELF_URL on the main app; ask your operator.",
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
    if (!res.ok) throw new Error(`sandbox-rpc http ${res.status}`);
    const reply = (await res.json()) as {
      ok: boolean;
      value?: unknown;
      error?: string;
    };
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

const handleRun = async (req: Request): Promise<Response> => {
  const body = (await req.json().catch(() => null)) as RunBody | null;
  if (!body || typeof body.code !== "string") {
    return json(
      {
        ok: false,
        logs: [],
        error:
          "expected JSON { code, data, user, timeoutMs, mainOrigin, rpcToken }",
      },
      400,
    );
  }

  const logs: string[] = [];
  const captureConsole = {
    log: (...args: unknown[]) => {
      logs.push(
        args
          .map((a) =>
            typeof a === "string"
              ? a
              : (() => {
                  try {
                    return JSON.stringify(a);
                  } catch {
                    return "[unserializable]";
                  }
                })(),
          )
          .join(" "),
      );
    },
  };

  const rpc = buildRpc(body.mainOrigin, body.rpcToken, body.user);
  const ctx = buildCtx(body, rpc);
  const limit = Math.max(50, Math.min(60_000, body.timeoutMs ?? 5000));

  try {
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
        setTimeout(
          () => reject(new Error(`timed out after ${limit}ms`)),
          limit,
        ),
      ),
    ]);
    return json({ ok: true, value, logs });
  } catch (e) {
    return json({ ok: false, logs, error: (e as Error).message });
  }
};

Bun.serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health") return new Response("ok");
    if (req.method === "POST" && url.pathname === "/run") return handleRun(req);
    return new Response("not found", { status: 404 });
  },
});

console.log(`workeros fn-exec-server listening on :${PORT}`);
