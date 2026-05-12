/// <reference lib="webworker" />
/**
 * Bun worker thread entry for sandboxed user-function execution.
 *
 * Loaded once per invocation by `providers/bun-worker.ts`. The host posts a
 * single `WorkerRunMessage`; this entry strips dangerous globals, builds a
 * `ctx` proxy that round-trips db/fetch/email through host RPC, runs the
 * user code, and posts back logs + the final result.
 *
 * Security note: the worker still has access to Bun globals (fs, process,
 * Bun, …) even after deletion — this is a SOFT sandbox. For hard isolation
 * run an out-of-isolate executor (the `remote-http` provider) instead.
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

  // Strip dangerous globals (best-effort).
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
    // this entry's scope).
    const fn = new Function(
      "ctx",
      "console",
      `return (async () => {\n${run.code}\n})()`,
    ) as (
      c: ReturnType<typeof buildCtx>,
      log: ReturnType<typeof buildConsole>,
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
