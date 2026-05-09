import { dispatchRpc } from "../host-bridge";
import type {
  RpcRequest,
  SandboxBindings,
  SandboxProvider,
  SandboxResult,
  WorkerLogMessage,
  WorkerResultMessage,
  WorkerRunMessage,
} from "../types";

/**
 * Bun worker thread sandbox. Each invocation spawns a fresh Worker, posts the
 * user code, and pumps RPC traffic between the worker and the host until the
 * worker returns a result or the timeout terminates it.
 */
export const bunWorkerProvider: SandboxProvider = {
  name: "bun-worker",
  async run(
    source: string,
    bindings: SandboxBindings,
    data: unknown,
    timeoutMs: number,
  ): Promise<SandboxResult> {
    const start = Date.now();
    const logs: string[] = [];
    const limit = Math.max(50, Math.min(60_000, timeoutMs));

    const workerUrl = new URL("../worker-entry.ts", import.meta.url);
    const worker = new Worker(workerUrl, { type: "module" });

    return new Promise<SandboxResult>((resolve) => {
      let settled = false;
      const finish = (r: SandboxResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        worker.terminate();
        resolve(r);
      };

      const timer = setTimeout(() => {
        finish({
          ok: false,
          logs,
          error: `timed out after ${limit}ms`,
          durationMs: Date.now() - start,
        });
      }, limit);

      worker.addEventListener("message", async (event: MessageEvent<unknown>) => {
        const msg = event.data as
          | WorkerLogMessage
          | WorkerResultMessage
          | RpcRequest;

        if (msg.kind === "log") {
          logs.push(msg.parts.join(" "));
          return;
        }

        if (msg.kind === "rpc") {
          try {
            const value = await dispatchRpc(bindings, msg.op, msg.args);
            worker.postMessage({
              kind: "rpc-reply",
              requestId: msg.requestId,
              ok: true,
              value,
            });
          } catch (e) {
            worker.postMessage({
              kind: "rpc-reply",
              requestId: msg.requestId,
              ok: false,
              error: (e as Error).message,
            });
          }
          return;
        }

        if (msg.kind === "result") {
          finish({
            ok: msg.ok,
            value: msg.value,
            error: msg.error,
            logs,
            durationMs: Date.now() - start,
          });
        }
      });

      worker.addEventListener("error", (event: ErrorEvent) => {
        finish({
          ok: false,
          logs,
          error: event.message ?? "worker error",
          durationMs: Date.now() - start,
        });
      });

      const runMsg: WorkerRunMessage = {
        kind: "run",
        code: source,
        data,
        user: {
          id: bindings.auth.userId,
          email: bindings.auth.email,
          roles: bindings.auth.roles,
        },
      };
      worker.postMessage(runMsg);
    });
  },
};
