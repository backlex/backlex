import type { Operation } from "@workeros/core";
import { parseFilter, FilterParseError } from "./filter-dsl";

/**
 * Builder ↔ runtime translation layer.
 *
 * The flow builder works in graph form (positioned `nodes` + branching
 * `edges`). The runtime needs a flat `operations` array plus a `trigger`
 * string. `compileGraph` reduces graph → runtime, and `decompileGraph`
 * rehydrates a saved flow back into the graph form so editing is round-
 * trippable. The original graph is also persisted to `flows.layout` so
 * positions survive even when no clean inverse exists for an op.
 */

export interface GraphNode {
  id: string;
  kind: "trigger" | "action" | "control";
  type: string;
  x: number;
  y: number;
  config: Record<string, any>;
}
export interface GraphEdge {
  from: string;
  to: string;
  branch: "true" | "false" | null;
}
export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** Action types the backend can execute today. Anything outside this set
 *  is preserved in the saved layout but emitted as a warning + skipped at
 *  runtime so the flow still saves. */
const SUPPORTED_ACTIONS = new Set([
  "email",
  "webhook",
  "request",
  "log",
  "notification",
  "transform",
  "run-script",
  // Wired in later phases — listed so the compiler emits a clearer warning
  // ("requires phase 2") instead of "unknown step".
  "fn",
  "item.create",
  "item.update",
  "slack",
  "delay",
]);

const PHASE_PENDING: Record<string, string> = {
  slack: "slack action is a phase-2 alias for webhook",
};

/**
 * Parse a duration string like "30s", "5m", "1h", "2d" into milliseconds.
 * Bare numbers are treated as ms. Throws on unparseable input.
 */
export const parseDurationMs = (raw: string): number => {
  const s = raw.trim();
  if (!s) throw new FlowCompileError("Delay duration is empty");
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i.exec(s);
  if (!m) throw new FlowCompileError(`Cannot parse duration "${raw}"`);
  const n = Number(m[1]);
  const unit = (m[2] ?? "ms").toLowerCase();
  const mult: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  return Math.round(n * mult[unit]!);
};

export const formatDurationMs = (ms: number): string => {
  if (ms < 1000) return `${ms}ms`;
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1000 === 0) return `${ms / 1000}s`;
  return `${ms}ms`;
};

export interface CompileResult {
  trigger: string;
  operations: Operation[];
  layout: Graph;
  warnings: string[];
}

export class FlowCompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlowCompileError";
  }
}

/* ─────────────────────────── compile ─────────────────────────── */

export const compileGraph = (graph: Graph): CompileResult => {
  const trigger = graph.nodes.find((n) => n.kind === "trigger");
  if (!trigger) throw new FlowCompileError("Flow needs a trigger node");

  const triggerStr = compileTrigger(trigger);

  const warnings: string[] = [];
  // BFS from trigger along edges with `branch == null` (the trigger only has
  // one outgoing path). Branching only kicks in on control "if" nodes.
  const next = nextLinear(graph, trigger.id, null);
  let operations = walk(graph, next, warnings);

  if (operations.length === 0) {
    throw new FlowCompileError(
      "Flow needs at least one action after the trigger",
    );
  }

  // Wrap operations in a top-level `condition` when the trigger has a
  // "When (filter DSL)" expression. The runtime evaluates conditions
  // against the event payload's `data`, so this gates the whole flow on
  // the predicate without requiring the admin to drop in an explicit if
  // step. Empty / whitespace-only when expressions pass through.
  const whenRaw = String((trigger.config.when ?? "")).trim();
  if (whenRaw) {
    let filter;
    try {
      filter = parseFilter(whenRaw);
    } catch (e) {
      throw new FlowCompileError(
        e instanceof FilterParseError
          ? `Trigger filter is invalid: ${e.message}`
          : (e as Error).message,
      );
    }
    operations = [
      { type: "condition", filter, then: operations, else: [] },
    ];
  }

  return {
    trigger: triggerStr,
    operations,
    layout: { nodes: graph.nodes, edges: graph.edges },
    warnings,
  };
};

const compileTrigger = (node: GraphNode): string => {
  switch (node.type) {
    case "item.created":
    case "item.updated":
    case "item.deleted": {
      const evt = node.type.split(".")[1]!; // created/updated/deleted
      const collection = node.config.collection || "*";
      return `event:items:${collection}:${evt}`;
    }
    case "cron": {
      const pattern = String(node.config.cron || "").trim();
      if (!pattern)
        throw new FlowCompileError(
          "Cron trigger needs a pattern (e.g. 0 9 * * *)",
        );
      return `cron:${pattern}`;
    }
    case "auth.signup":
      return "event:auth:signup";
    case "webhook": {
      // Incoming webhook trigger — the actual /api/webhook/:flowId endpoint
      // arrives in phase 4, but the trigger string is stable so saved flows
      // start firing as soon as the route lands.
      return "webhook";
    }
    default:
      throw new FlowCompileError(`Unknown trigger type "${node.type}"`);
  }
};

const walk = (
  graph: Graph,
  startId: string | null,
  warnings: string[],
): Operation[] => {
  const out: Operation[] = [];
  let cursor = startId;
  const guard = new Set<string>();
  while (cursor) {
    if (guard.has(cursor)) {
      warnings.push(`Cycle detected at node "${cursor}" — truncating`);
      break;
    }
    guard.add(cursor);
    const node = graph.nodes.find((n) => n.id === cursor);
    if (!node) break;
    const op = compileNode(graph, node, warnings);
    if (op) out.push(op);
    cursor = nextLinear(graph, cursor, null);
  }
  return out;
};

const nextLinear = (
  graph: Graph,
  fromId: string,
  branch: "true" | "false" | null,
): string | null => {
  const edge = graph.edges.find((e) => e.from === fromId && e.branch === branch);
  return edge?.to ?? null;
};

const compileNode = (
  graph: Graph,
  node: GraphNode,
  warnings: string[],
): Operation | null => {
  if (node.kind === "control" && node.type === "if") {
    let filter;
    try {
      filter = parseFilter(String(node.config.test ?? ""));
    } catch (e) {
      throw new FlowCompileError(
        e instanceof FilterParseError
          ? `Filter on "if" step is invalid: ${e.message}`
          : (e as Error).message,
      );
    }
    const thenStart = nextLinear(graph, node.id, "true");
    const elseStart = nextLinear(graph, node.id, "false");
    return {
      type: "condition",
      filter,
      then: walk(graph, thenStart, warnings),
      else: walk(graph, elseStart, warnings),
    };
  }

  if (node.kind === "action") {
    if (!SUPPORTED_ACTIONS.has(node.type)) {
      warnings.push(`Skipped unknown action "${node.type}"`);
      return null;
    }
    if (PHASE_PENDING[node.type]) {
      warnings.push(
        `"${node.type}" step skipped at runtime — ${PHASE_PENDING[node.type]}`,
      );
      return null;
    }
    return compileAction(node);
  }

  // Trigger reached via walk — should never happen because we start AFTER it.
  return null;
};

const compileAction = (node: GraphNode): Operation => {
  const c = node.config;
  switch (node.type) {
    case "email": {
      // The email op accepts either a templateKey OR literal subject+text.
      // Validate at compile time so a half-filled inspector fails fast
      // instead of surfacing a 422 from the runtime.
      const hasTemplate = !!c.templateKey;
      if (!hasTemplate && !c.subject)
        throw new FlowCompileError(
          "Email step needs either a template or a Subject",
        );
      if (!hasTemplate && !c.text && !c.html)
        throw new FlowCompileError(
          "Email step needs either a template or a Body (text/html)",
        );
      return {
        type: "email",
        to: String(c.to ?? ""),
        ...(c.templateKey ? { templateKey: String(c.templateKey) } : {}),
        ...(c.vars ? { vars: c.vars } : {}),
        ...(c.subject ? { subject: String(c.subject) } : {}),
        ...(c.html ? { html: String(c.html) } : {}),
        ...(c.text ? { text: String(c.text) } : {}),
      };
    }
    case "webhook":
    case "request": {
      if (!c.url) throw new FlowCompileError(`${node.type} step needs a URL`);
      return {
        type: node.type as "webhook" | "request",
        url: String(c.url),
        ...(c.method ? { method: c.method } : {}),
        ...(c.headers ? { headers: c.headers } : {}),
        ...(c.body !== undefined ? { body: tryParseJson(c.body) } : {}),
      } as Operation;
    }
    case "log": {
      return { type: "log", message: String(c.message ?? "") };
    }
    case "notification": {
      if (!c.title)
        throw new FlowCompileError("Notification step needs a Title");
      return {
        type: "notification",
        title: String(c.title),
        ...(c.body ? { body: String(c.body) } : {}),
        ...(c.url ? { url: String(c.url) } : {}),
        ...(c.userId !== undefined ? { userId: c.userId ?? null } : {}),
      };
    }
    case "transform": {
      return {
        type: "transform",
        value: c.value !== undefined ? tryParseJson(c.value) : null,
      };
    }
    case "run-script": {
      if (!c.code) throw new FlowCompileError("Script step needs code");
      return {
        type: "run-script",
        code: String(c.code),
        ...(c.timeoutMs ? { timeoutMs: Number(c.timeoutMs) } : {}),
      };
    }
    case "fn": {
      // The builder's "fn" select stores the function name (matches the
      // unique `(tenantId, name)` index in the functions table).
      const name = String(c.fn ?? c.name ?? "").trim();
      if (!name) throw new FlowCompileError("Function step needs a name");
      return {
        type: "function",
        name,
        ...(c.input !== undefined ? { input: tryParseJson(c.input) } : {}),
      };
    }
    case "item.create": {
      const collection = String(c.collection ?? "").trim();
      if (!collection)
        throw new FlowCompileError("Item create step needs a collection");
      return {
        type: "item.create",
        collection,
        // Keep strings as strings so the runtime can interpolate templates
        // before parsing. Objects pass through untouched.
        data:
          typeof c.data === "string"
            ? c.data
            : (tryParseJson(c.data) as Record<string, unknown>),
      };
    }
    case "item.update": {
      const collection = String(c.collection ?? "").trim();
      const id = String(c.id ?? "").trim();
      if (!collection)
        throw new FlowCompileError("Item update step needs a collection");
      if (!id) throw new FlowCompileError("Item update step needs an id");
      return {
        type: "item.update",
        collection,
        id,
        data:
          typeof c.data === "string"
            ? c.data
            : (tryParseJson(c.data) as Record<string, unknown>),
      };
    }
    case "delay": {
      const raw = String(c.duration ?? "").trim();
      const durationMs = parseDurationMs(raw);
      return { type: "delay", durationMs };
    }
    default:
      throw new FlowCompileError(`No compiler for action "${node.type}"`);
  }
};

/** Body fields are typed as textareas; try to JSON-parse so users can pass
 *  objects without manual quoting, but fall back to the raw string when
 *  parsing fails (intentional template strings like "{{ data.title }}"). */
const tryParseJson = (v: unknown): unknown => {
  if (typeof v !== "string") return v;
  const trimmed = v.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return v;
    }
  }
  return v;
};

/* ─────────────────────────── decompile ─────────────────────────── */

const DEFAULT_TRIGGER: GraphNode = {
  id: "n-trigger",
  kind: "trigger",
  type: "item.updated",
  x: 60,
  y: 160,
  config: { collection: "posts", when: "" },
};

/**
 * Rehydrate a builder graph from a saved flow.
 *
 * Preferred path: when `layout` was persisted, it's the source of truth —
 * the operations are the executable projection, but layout keeps the
 * canvas exactly as the admin left it.
 *
 * Fallback path: derive a fresh linear graph from `operations`. Used for
 * flows created before A1 landed, or anything written via the API
 * directly. Branches are reconstructed from `condition` ops; positions
 * are auto-assigned left-to-right.
 */
export const decompileGraph = (input: {
  trigger: string;
  operations: Operation[];
  layout?: Graph | null;
}): Graph => {
  if (input.layout && Array.isArray(input.layout.nodes)) {
    return input.layout;
  }
  return synthesize(input.trigger, input.operations);
};

const synthesize = (trigger: string, operations: Operation[]): Graph => {
  const triggerNode = parseTrigger(trigger);

  // Inverse of compileGraph's "trigger.when" wrap: if the first op is a
  // condition with an empty `else` branch, lift its filter back onto the
  // trigger and unwrap the `then` so the canvas matches what the admin
  // originally drew (rather than showing a synthetic If/else node).
  let ops = operations;
  if (
    ops.length === 1 &&
    ops[0]?.type === "condition" &&
    (!ops[0].else || ops[0].else.length === 0)
  ) {
    triggerNode.config.when = JSON.stringify(ops[0].filter, null, 2);
    ops = ops[0].then ?? [];
  }

  const nodes: GraphNode[] = [triggerNode];
  const edges: GraphEdge[] = [];

  let counter = 1;
  const newId = () => `n${counter++}`;
  const place = (depth: number, lane: number): { x: number; y: number } => ({
    x: 60 + depth * 260,
    y: 160 + lane * 100,
  });

  const layout = (
    ops: Operation[],
    parentId: string,
    parentBranch: "true" | "false" | null,
    depth: number,
    lane: number,
  ): void => {
    let prevId = parentId;
    let prevBranch = parentBranch;
    ops.forEach((op, i) => {
      const id = newId();
      const pos = place(depth + i, lane);
      const node: GraphNode = {
        id,
        kind: op.type === "condition" ? "control" : "action",
        type: op.type === "condition" ? "if" : op.type,
        ...pos,
        config: opToConfig(op),
      };
      nodes.push(node);
      edges.push({ from: prevId, to: id, branch: prevBranch });
      prevId = id;
      prevBranch = null;

      if (op.type === "condition") {
        if (op.then?.length) layout(op.then, id, "true", depth + i + 1, lane - 1);
        if (op.else?.length) layout(op.else, id, "false", depth + i + 1, lane + 1);
      }
    });
  };

  layout(ops, nodes[0]!.id, null, 1, 0);
  return { nodes, edges };
};

const parseTrigger = (s: string): GraphNode => {
  const t = s.startsWith("event:") ? s.slice("event:".length) : s;
  if (t.startsWith("items:")) {
    const parts = t.split(":"); // items:<slug>:<event>
    const collection = parts[1] || "*";
    const event = parts[2] || "updated";
    return {
      ...DEFAULT_TRIGGER,
      type: `item.${event}`,
      config: { collection, when: "" },
    };
  }
  if (t.startsWith("cron:") || s.startsWith("cron:")) {
    const pattern = (s.startsWith("cron:") ? s : t).slice("cron:".length);
    return {
      ...DEFAULT_TRIGGER,
      type: "cron",
      config: { cron: pattern },
    };
  }
  if (t === "auth:signup")
    return { ...DEFAULT_TRIGGER, type: "auth.signup", config: {} };
  if (s === "webhook" || s.startsWith("webhook:"))
    return { ...DEFAULT_TRIGGER, type: "webhook", config: {} };
  return DEFAULT_TRIGGER;
};

const opToConfig = (op: Operation): Record<string, any> => {
  switch (op.type) {
    case "email":
      return {
        to: op.to,
        templateKey: op.templateKey ?? "",
        vars: op.vars,
        subject: op.subject ?? "",
        html: op.html ?? "",
        text: op.text ?? "",
      };
    case "webhook":
    case "request":
      return {
        url: op.url,
        method: op.method,
        headers: op.headers,
        body:
          op.body === undefined
            ? ""
            : typeof op.body === "string"
              ? op.body
              : JSON.stringify(op.body, null, 2),
      };
    case "condition": {
      // Filter is shown as JSON in the textarea — round-trip lossless.
      return { test: JSON.stringify(op.filter, null, 2) };
    }
    case "log":
      return { message: op.message };
    case "notification":
      return {
        title: op.title,
        body: op.body ?? "",
        url: op.url ?? "",
        userId: op.userId ?? null,
      };
    case "transform":
      return {
        value:
          op.value === undefined
            ? ""
            : typeof op.value === "string"
              ? op.value
              : JSON.stringify(op.value, null, 2),
      };
    case "run-script":
      return { code: op.code, timeoutMs: op.timeoutMs };
    case "function":
      return {
        fn: op.name,
        input:
          op.input === undefined
            ? ""
            : typeof op.input === "string"
              ? op.input
              : JSON.stringify(op.input, null, 2),
      };
    case "item.create":
      return {
        collection: op.collection,
        data:
          typeof op.data === "string"
            ? op.data
            : JSON.stringify(op.data, null, 2),
      };
    case "item.update":
      return {
        collection: op.collection,
        id: op.id,
        data:
          typeof op.data === "string"
            ? op.data
            : JSON.stringify(op.data, null, 2),
      };
    case "delay":
      return { duration: formatDurationMs(op.durationMs) };
    default:
      return {};
  }
};
