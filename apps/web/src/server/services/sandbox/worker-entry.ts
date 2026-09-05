/// <reference lib="webworker" />
/**
 * Bun worker thread entry for sandboxed user-function execution.
 *
 * Loaded once per invocation by `providers/bun-worker.ts`. The host posts a
 * single `WorkerRunMessage`; this entry strips dangerous globals, builds a
 * `ctx` proxy that round-trips db/fetch/email through host RPC, runs the
 * user code, and posts back logs + the final result.
 *
 * ## This is NOT a sandbox, and the delete-loop below cannot make it one
 *
 * Measured against a real Bun Worker running exactly this construction:
 *
 *   await import("node:process")  -> the API host's whole env
 *   await import("node:fs")       -> any file the process can read
 *   globalThis.Bun.spawnSync(…)   -> arbitrary commands
 *
 * `fetch`, `process` and `WebSocket` really do delete. `Bun` does not, and
 * cannot be shadowed either: it is defined `configurable: false, writable:
 * false`, so `Object.defineProperty(globalThis, "Bun", …)` throws rather than
 * hiding it. Dynamic `import()` is a keyword, so no parameter shadows it and no
 * module resolver is reachable from here. The parameter shadows below stop a
 * bare `process` identifier and nothing else.
 *
 * So this provider is only ever selected when the operator has opted in with
 * `FUNCTIONS_SANDBOX=bun-worker`, which says "the people authoring functions
 * here are the people running this deployment". Everywhere else the default is
 * the QuickJS-WASM isolate, and hard isolation with host I/O is the
 * `remote-http` provider's job. See `services/sandbox/index.ts`.
 */

import type {
  RpcReply,
  WorkerLogMessage,
  WorkerResultMessage,
  WorkerRunMessage,
} from "./types";

const post = (msg: WorkerLogMessage | WorkerResultMessage | unknown) =>
  (self as unknown as { postMessage: (m: unknown) => void }).postMessage(msg);

const pendingRpcs = new Map<
  string,
  (reply: { ok: boolean; value?: unknown; error?: string }) => void
>();

const rpc = (op: string, args: unknown): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    pendingRpcs.set(requestId, (reply) => {
      if (reply.ok) resolve(reply.value);
      else reject(new Error(reply.error ?? "rpc error"));
    });
    post({ kind: "rpc", op, args, requestId });
  });

const buildCtx = (data: unknown, user: WorkerRunMessage["user"]) => ({
  data,
  user,
  fetch: (url: string, init?: RequestInit) => rpc("fetch", { url, init }),
  db: {
    list: (
      slug: string,
      query?: {
        filter?: unknown;
        sort?: string;
        limit?: number;
        offset?: number;
      },
    ) => rpc("db.list", { slug, query }),
    one: (slug: string, id: string) => rpc("db.one", { slug, id }),
  },
  email: {
    send: (msg: {
      to: string;
      subject: string;
      text: string;
      html?: string;
    }) => rpc("email.send", msg),
  },
  push: {
    send: (msg: {
      userId?: string;
      userIds?: string[];
      title: string;
      body: string;
      url?: string;
      data?: Record<string, string>;
    }) => rpc("push.send", msg),
  },
  ai: {
    generate: (req: {
      prompt: string;
      system?: string;
      model?: string;
      maxTokens?: number;
      timeoutMs?: number;
    }) => rpc("ai.generate", req),
  },
});

const buildConsole = () => ({
  log: (...args: unknown[]) => {
    const parts = args.map((a) =>
      typeof a === "string" ? a : (() => {
        try {
          return JSON.stringify(a);
        } catch {
          return "[unserializable]";
        }
      })(),
    );
    post({ kind: "log", parts });
  },
});

self.addEventListener("message", async (event: MessageEvent<unknown>) => {
  const msg = event.data as WorkerRunMessage | RpcReply;

  if ((msg as RpcReply).kind === "rpc-reply") {
    const r = msg as RpcReply;
    const resolver = pendingRpcs.get(r.requestId);
    if (resolver) {
      pendingRpcs.delete(r.requestId);
      resolver({ ok: r.ok, value: r.value, error: r.error });
    }
    return;
  }

  if ((msg as WorkerRunMessage).kind !== "run") return;

  const run = msg as WorkerRunMessage;

  // Strip what CAN be stripped. `fetch`, `process` and `WebSocket` delete;
  // `Bun` does not (non-configurable) and `require` / `module` were never
  // defined here in the first place. They are also shadowed as undefined
  // parameters on the user function below, which catches a bare identifier
  // reference but not `globalThis.Bun`. Defence in depth, not a boundary —
  // read the header before treating this list as one.
  const drop = ["fetch", "process", "Bun", "require", "module", "WebSocket"];
  for (const k of drop) {
    try {
      delete (globalThis as Record<string, unknown>)[k];
    } catch {
      /* non-deletable; ignore */
    }
  }

  const ctx = buildCtx(run.data, run.user);
  const console = buildConsole();

  try {
    // The user body sees `ctx`, `console` as parameters — we use `new Function`
    // so the source is parsed in a controlled env (no closure capture from
    // this entry's scope). The trailing parameters shadow the globals the
    // delete-loop above can't remove; they're invoked as undefined. This is
    // NOT isolation — see the header — it is what an operator who has opted
    // into `FUNCTIONS_SANDBOX=bun-worker` gets.
    const fn = new Function(
      "ctx",
      "console",
      ...drop,
      `return (async () => {\n${run.code}\n})()`,
    ) as (
      c: ReturnType<typeof buildCtx>,
      log: ReturnType<typeof buildConsole>,
      ...shadowed: undefined[]
    ) => Promise<unknown>;
    const value = await fn(ctx, console);
    post({ kind: "result", ok: true, value } satisfies WorkerResultMessage);
  } catch (e) {
    post({
      kind: "result",
      ok: false,
      error: (e as Error).message,
    } satisfies WorkerResultMessage);
  }
});
