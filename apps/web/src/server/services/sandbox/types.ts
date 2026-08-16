import type { AuthSubject } from "@backlex/core";
import type { Ctx } from "../../context";

export interface SandboxBindings {
  ctx: Ctx;
  auth: AuthSubject;
  /** Public origin of the main Worker — required by the `remote-http`
   *  provider so the executor service can call back over HTTP for ctx.*
   *  RPC. Derived from the request URL by route handlers; for cron triggers
   *  falls back to `env.SELF_URL`. Other providers ignore it. */
  selfOrigin?: string;
  /** W3C `traceparent` of the request/trigger that invoked this function.
   *  Injected onto the function's outbound `fetch()` calls (unless the function
   *  set its own) so a downstream service — including a call back into this API
   *  — continues the same trace. Absent for triggers without a trace context. */
  traceparent?: string;
}

export interface SandboxResult {
  ok: boolean;
  value?: unknown;
  logs: string[];
  error?: string;
  durationMs: number;
}

export interface SandboxProvider {
  /** Stable name for diagnostics — admin invoke result includes this. */
  readonly name: string;
  run(
    source: string,
    bindings: SandboxBindings,
    data: unknown,
    timeoutMs: number,
  ): Promise<SandboxResult>;
}

/**
 * The host calls a sandboxed function can make.
 *
 * This is the CANONICAL list and every other copy of it is a copy: the zod enum
 * in `routes/sandbox-rpc.ts` (the remote executor's callback), the guest shim in
 * `worker-entry.ts` (bun), and the guest shim in
 * `apps/web/templates/fn-exec-server/index.ts` (the remote executor). Adding an
 * op to fewer than all four breaks it on exactly one provider and nowhere else,
 * which is how `push.send` came to be missing from the remote executor while
 * working everywhere its tests looked.
 */
export type RpcOp =
  | "fetch"
  | "db.list"
  | "db.one"
  | "email.send"
  | "push.send"
  | "ai.generate";

export interface RpcRequest {
  kind: "rpc";
  requestId: string;
  op: RpcOp;
  args: unknown;
}

export interface RpcReply {
  kind: "rpc-reply";
  requestId: string;
  ok: boolean;
  value?: unknown;
  error?: string;
}

export interface WorkerRunMessage {
  kind: "run";
  code: string;
  data: unknown;
  user: { id: string | null; email: string | null; roles: string[] };
}

export interface WorkerLogMessage {
  kind: "log";
  parts: string[];
}

export interface WorkerResultMessage {
  kind: "result";
  ok: boolean;
  value?: unknown;
  error?: string;
}
