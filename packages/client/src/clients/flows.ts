import type { ClientCore } from "../core";

/** A visual workflow (flow) row. `operations` is the serialized op DSL the
 *  builder compiles; `layout` is a purely-presentational graph snapshot. */
export interface Flow {
  id: string;
  tenantId?: string | null;
  name: string;
  trigger: string;
  operations: unknown[];
  layout?: unknown;
  active: boolean;
}

/** Create/update payload for a flow. `operations` must be non-empty on create;
 *  `update` accepts any subset. */
export interface FlowInput {
  name: string;
  trigger: string;
  operations: unknown[];
  layout?: unknown;
  active?: boolean;
}

/** Outcome of a manual flow run. `ok: false` means the run halted on an
 *  unhandled op error; `error` carries the first failure message. */
export interface FlowRunResult {
  ok: boolean;
  error?: string;
  /**
   * What the run's `log` operations rendered, in order — the answer to "did my
   * interpolation resolve?".
   *
   * Absent when the flow has no `log` op. Capped at 50 lines (a 51st says the
   * rest were truncated) and 500 characters each, so a `log` inside a `foreach`
   * over a large collection cannot turn one run into a write amplifier.
   */
  log?: string[];
}

/** Visual workflows (admin-scoped). Mirrors `/api/flows`. See `createClient`. */
export interface FlowsClient {
  /** List every flow in the active workspace. */
  list(): Promise<{ data: Flow[] }>;
  /** Fetch a single flow's full definition by id. */
  get(id: string): Promise<{ data: Flow }>;
  /** Create a flow scoped to the active workspace. */
  create(input: FlowInput): Promise<{ data: Flow }>;
  /** Partial update of a flow by id. */
  update(id: string, patch: Partial<FlowInput>): Promise<{ ok: boolean }>;
  /** Delete a flow by id. */
  delete(id: string): Promise<{ ok: boolean }>;
  /** Synchronously run a flow with an arbitrary `input` trigger payload. */
  run(id: string, input?: Record<string, unknown>): Promise<FlowRunResult>;
}

export const makeFlows = (core: ClientCore): FlowsClient => {
  // Visual workflows. Admin-scoped CRUD over `/api/flows`; `run` triggers a
  // synchronous execution with an arbitrary input payload.
  const flows: FlowsClient = {
    /** List every flow in the active workspace. */
    list: () => core.request<{ data: Flow[] }>("GET", "/api/flows"),
    /** Fetch a single flow's full definition by id. */
    get: (id: string) =>
      core.request<{ data: Flow }>("GET", `/api/flows/${encodeURIComponent(id)}`),
    /** Create a flow scoped to the active workspace. */
    create: (input: FlowInput) => core.request<{ data: Flow }>("POST", "/api/flows", input),
    /** Partial update of a flow by id. */
    update: (id: string, patch: Partial<FlowInput>) =>
      core.request<{ ok: boolean }>("PATCH", `/api/flows/${encodeURIComponent(id)}`, patch),
    /** Delete a flow by id. */
    delete: (id: string) =>
      core.request<{ ok: boolean }>("DELETE", `/api/flows/${encodeURIComponent(id)}`),
    /** Run a flow synchronously with an arbitrary `input` trigger payload. */
    run: (id: string, input?: Record<string, unknown>) =>
      core.request<FlowRunResult>("POST", `/api/flows/${encodeURIComponent(id)}/run`, input ?? {}),
  };

  return flows;
};
