import { useMemo } from "react";
import {
  Background,
  Controls,
  ReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react";
import type { Operation } from "@workeros/core";
import "@xyflow/react/dist/style.css";

const COLUMN = 240;
const ROW = 88;

const truncate = (s: string, n = 32): string =>
  s.length > n ? s.slice(0, n - 1) + "…" : s;

const describeOp = (op: Operation): string => {
  switch (op.type) {
    case "log":
      return truncate(op.message || "(empty)");
    case "webhook":
      return `${op.method ?? "POST"} ${truncate(op.url || "(no url)")}`;
    case "request":
      return `${op.method ?? "GET"} ${truncate(op.url || "(no url)")}`;
    case "email":
      return `to: ${truncate(op.to || "(no recipient)")}`;
    case "transform":
      return "shape data";
    case "run-script":
      return truncate(op.code.split("\n")[0] || "(empty)");
    case "condition":
      return truncate(JSON.stringify(op.filter ?? {}));
    case "notification":
      return truncate(op.title || "(no title)");
    case "function":
      return `fn: ${truncate(op.name || "(no name)")}`;
    case "item.create":
      return `→ ${truncate(op.collection || "(no collection)")}`;
    case "item.update":
      return `~ ${truncate(op.collection || "(no collection)")}`;
    case "delay":
      return `wait ${op.durationMs}ms`;
  }
};

const opColor: Record<Operation["type"], string> = {
  log: "var(--muted)",
  webhook: "var(--secondary)",
  request: "var(--secondary)",
  email: "color-mix(in oklab, var(--primary) 18%, transparent)",
  transform: "color-mix(in oklab, var(--accent) 22%, transparent)",
  "run-script": "color-mix(in oklab, var(--primary) 22%, transparent)",
  condition: "color-mix(in oklab, var(--accent) 18%, transparent)",
  notification: "color-mix(in oklab, var(--primary) 14%, transparent)",
  function: "color-mix(in oklab, var(--primary) 22%, transparent)",
  "item.create": "color-mix(in oklab, var(--accent) 16%, transparent)",
  "item.update": "color-mix(in oklab, var(--accent) 16%, transparent)",
  delay: "color-mix(in oklab, var(--muted) 60%, transparent)",
};

interface BuildState {
  nodes: Node[];
  edges: Edge[];
  nextId: number;
  /** Current row cursor — increments by 1 per node placed. Used to compute Y. */
  y: number;
}

const newId = (s: BuildState): string => `n${s.nextId++}`;

const placeOp = (
  state: BuildState,
  op: Operation,
  depth: number,
): string => {
  const id = newId(state);
  state.nodes.push({
    id,
    position: { x: depth * COLUMN, y: state.y * ROW },
    data: {
      label: (
        <div className="space-y-0.5 text-left">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            {op.type}
          </div>
          <div className="text-xs">{describeOp(op)}</div>
        </div>
      ),
    },
    style: {
      background: opColor[op.type],
      border: "1px solid var(--border)",
      borderRadius: 12,
      padding: 8,
      width: COLUMN - 24,
      fontFamily: "inherit",
    },
  });
  state.y += 1;

  if (op.type === "condition") {
    if (op.then && op.then.length > 0) {
      const branchHead = placeBranch(state, op.then, depth + 1);
      if (branchHead) {
        state.edges.push({
          id: `${id}-then-${branchHead}`,
          source: id,
          target: branchHead,
          label: "then",
          style: { stroke: "#3b82f6" },
          labelStyle: { fontSize: 10, fill: "#3b82f6" },
        });
      }
    }
    if (op.else && op.else.length > 0) {
      const branchHead = placeBranch(state, op.else, depth + 1);
      if (branchHead) {
        state.edges.push({
          id: `${id}-else-${branchHead}`,
          source: id,
          target: branchHead,
          label: "else",
          style: { stroke: "#f97316" },
          labelStyle: { fontSize: 10, fill: "#f97316" },
        });
      }
    }
  }

  if (op.onSuccess && op.onSuccess.length > 0) {
    const branchHead = placeBranch(state, op.onSuccess, depth + 1);
    if (branchHead) {
      state.edges.push({
        id: `${id}-success-${branchHead}`,
        source: id,
        target: branchHead,
        label: "success",
        animated: true,
        style: { stroke: "#22c55e", strokeDasharray: "5 3" },
        labelStyle: { fontSize: 10, fill: "#22c55e" },
      });
    }
  }

  if (op.onError && op.onError.length > 0) {
    const branchHead = placeBranch(state, op.onError, depth + 1);
    if (branchHead) {
      state.edges.push({
        id: `${id}-error-${branchHead}`,
        source: id,
        target: branchHead,
        label: "error",
        animated: true,
        style: { stroke: "#ef4444", strokeDasharray: "5 3" },
        labelStyle: { fontSize: 10, fill: "#ef4444" },
      });
    }
  }

  return id;
};

const placeBranch = (
  state: BuildState,
  ops: Operation[],
  depth: number,
): string | null => {
  let prev: string | null = null;
  let head: string | null = null;
  for (const op of ops) {
    const id = placeOp(state, op, depth);
    if (head === null) head = id;
    if (prev !== null) {
      state.edges.push({
        id: `${prev}-next-${id}`,
        source: prev,
        target: id,
        style: { stroke: "var(--muted-foreground)" },
      });
    }
    prev = id;
  }
  return head;
};

const buildGraph = (ops: Operation[]): { nodes: Node[]; edges: Edge[] } => {
  const state: BuildState = { nodes: [], edges: [], nextId: 0, y: 0 };
  placeBranch(state, ops, 0);
  return { nodes: state.nodes, edges: state.edges };
};

export const FlowGraph = ({ operations }: { operations: Operation[] }) => {
  const { nodes, edges } = useMemo(() => buildGraph(operations), [operations]);
  if (operations.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-border p-8 text-center text-xs text-muted-foreground">
        Add an operation to see the graph.
      </div>
    );
  }
  return (
    <div className="h-[420px] rounded-2xl border border-border">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={16} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
};
