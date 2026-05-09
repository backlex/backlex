import type { AuthSubject } from "@workeros/core";
import type { Ctx } from "../../context";

export interface SandboxBindings {
  ctx: Ctx;
  auth: AuthSubject;
  /** Public origin of the main Worker — required by cf-dispatch so the
   *  executor sub-Worker can call back over HTTP for ctx.* RPC. Derived
   *  from the request URL by route handlers; for cron triggers falls back
   *  to `env.SELF_URL`. Other providers ignore it. */
  selfOrigin?: string;
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

export type RpcOp =
  | "fetch"
  | "db.list"
  | "db.one"
  | "email.send";

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
