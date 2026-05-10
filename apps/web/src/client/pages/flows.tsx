import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  PlayIcon,
  PlusIcon,
  Trash2Icon,
  WorkflowIcon,
  ChevronDownIcon,
  ChevronRightIcon,
} from "lucide-react";
import {
  FlowTriggerKinds,
  OPERATION_TYPES,
  OperationsSchema,
  type FlowTriggerKind,
  type Operation,
  type OperationType,
} from "@workeros/core";
import { Card, CardContent, CardHeader, CardTitle } from "@workeros/ui/components/card";
import { Button } from "@workeros/ui/components/button";
import { Input } from "@workeros/ui/components/input";
import { Label } from "@workeros/ui/components/label";
import { Badge } from "@workeros/ui/components/badge";
import { Skeleton } from "@workeros/ui/components/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workeros/ui/components/dialog";
import { ConfirmAction } from "@/components/confirm-action";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { notifyError } from "@/lib/error";
import { toast } from "@workeros/ui/components/sonner";
import { Textarea } from "@workeros/ui/components/textarea";
import { FlowGraph } from "@/components/flow-graph";
import { api } from "@/lib/api";

interface Flow {
  id: string;
  name: string;
  trigger: string;
  operations: Operation[];
  active: boolean | number;
  createdAt: string;
}

const blankOperation = (type: OperationType): Operation => {
  switch (type) {
    case "log":
      return { type: "log", message: "" };
    case "webhook":
      return { type: "webhook", url: "", method: "POST" };
    case "request":
      return { type: "request", url: "", method: "GET" };
    case "email":
      return { type: "email", to: "", subject: "", text: "" };
    case "transform":
      return { type: "transform", value: {} };
    case "run-script":
      return {
        type: "run-script",
        code: "// return any value to expose as $last\nreturn { ok: true, data };",
      };
    case "condition":
      return { type: "condition", filter: {}, then: [], else: [] };
    case "notification":
      return { type: "notification", title: "" };
    case "function":
      return { type: "function", name: "" };
    case "item.create":
      return { type: "item.create", collection: "", data: {} };
    case "item.update":
      return { type: "item.update", collection: "", id: "", data: {} };
    case "delay":
      return { type: "delay", durationMs: 5000 };
  }
};

const SELECT_CLS =
  "h-9 w-full rounded-3xl border border-input bg-background px-3 text-sm";

const VARIABLE_HINTS = [
  { token: "{{ data.id }}", label: "event payload field" },
  { token: "{{ data.title }}", label: "event payload field" },
  { token: "{{ $user.id }}", label: "current user id (when wired)" },
  { token: "{{ $user.email }}", label: "current user email" },
  { token: "{{ $user.roles }}", label: "user role list" },
  { token: "{{ $last.status }}", label: "previous webhook HTTP status" },
  { token: "{{ $last.body }}", label: "previous op result body" },
  { token: "{{ $last.matched }}", label: "did previous condition match" },
];

interface OperationEditorProps {
  op: Operation;
  onChange: (next: Operation) => void;
  onDelete: () => void;
  depth: number;
}

const OperationEditor = ({ op, onChange, onDelete, depth }: OperationEditorProps) => {
  const patch = (partial: Record<string, unknown>) => {
    onChange({ ...(op as Record<string, unknown>), ...partial } as Operation);
  };

  return (
    <div
      className="space-y-3 rounded-2xl border border-border bg-card/50 p-3"
      style={{ marginInlineStart: depth * 12 }}
    >
      <div className="flex items-center gap-2">
        <select
          className={SELECT_CLS + " max-w-[140px]"}
          value={op.type}
          onChange={(e) => onChange(blankOperation(e.target.value as OperationType))}
        >
          {OPERATION_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <div className="flex-1" />
        <Button variant="ghost" size="icon-sm" type="button" onClick={onDelete}>
          <Trash2Icon />
        </Button>
      </div>

      {op.type === "log" && (
        <div className="space-y-1.5">
          <Label>Message</Label>
          <Input
            value={op.message}
            onChange={(e) => patch({ message: e.target.value })}
            placeholder="New item: {{ data.id }}"
          />
        </div>
      )}

      {op.type === "webhook" && (
        <>
          <div className="grid grid-cols-[1fr_120px] gap-2">
            <div className="space-y-1.5">
              <Label>URL</Label>
              <Input
                value={op.url}
                onChange={(e) => patch({ url: e.target.value })}
                placeholder="https://example.com/notify"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Method</Label>
              <select
                className={SELECT_CLS}
                value={op.method ?? "POST"}
                onChange={(e) => patch({ method: e.target.value })}
              >
                {["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Body (JSON, optional - defaults to event data)</Label>
            <Textarea
              rows={4}
              className="font-mono text-xs"
              value={op.body !== undefined ? JSON.stringify(op.body, null, 2) : ""}
              onChange={(e) => {
                const v = e.target.value;
                if (v === "") {
                  const { body: _drop, ...rest } = op;
                  onChange(rest as Operation);
                } else {
                  try {
                    patch({ body: JSON.parse(v) });
                  } catch {
                    patch({ body: v });
                  }
                }
              }}
              placeholder='{ "title": "{{ data.title }}" }'
            />
          </div>
          <div className="space-y-1.5">
            <Label>Headers (JSON, optional)</Label>
            <Textarea
              rows={2}
              className="font-mono text-xs"
              value={op.headers ? JSON.stringify(op.headers, null, 2) : ""}
              onChange={(e) => {
                const v = e.target.value;
                if (v === "") {
                  const { headers: _drop, ...rest } = op;
                  onChange(rest as Operation);
                } else {
                  try {
                    const parsed = JSON.parse(v);
                    if (parsed && typeof parsed === "object") {
                      patch({ headers: parsed });
                    }
                  } catch {
                    /* swallow until valid */
                  }
                }
              }}
              placeholder='{ "x-api-key": "..." }'
            />
          </div>
        </>
      )}

      {op.type === "email" && (
        <>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <Label>To</Label>
              <Input
                value={op.to}
                onChange={(e) => patch({ to: e.target.value })}
                placeholder="user@example.com"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Subject</Label>
              <Input
                value={op.subject}
                onChange={(e) => patch({ subject: e.target.value })}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Text</Label>
            <Textarea
              rows={4}
              value={op.text}
              onChange={(e) => patch({ text: e.target.value })}
              placeholder="Hello {{ data.name }}, ..."
            />
          </div>
        </>
      )}

      {op.type === "request" && (
        <>
          <div className="grid grid-cols-[1fr_120px] gap-2">
            <div className="space-y-1.5">
              <Label>URL</Label>
              <Input
                value={op.url}
                onChange={(e) => patch({ url: e.target.value })}
                placeholder="https://api.example.com/things/{{ data.id }}"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Method</Label>
              <select
                className={SELECT_CLS}
                value={op.method ?? "GET"}
                onChange={(e) => patch({ method: e.target.value })}
              >
                {["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <Label>Query (JSON)</Label>
              <Textarea
                rows={2}
                className="font-mono text-xs"
                value={op.query ? JSON.stringify(op.query, null, 2) : ""}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === "") {
                    const { query: _drop, ...rest } = op;
                    onChange(rest as Operation);
                  } else {
                    try {
                      const parsed = JSON.parse(v);
                      if (parsed && typeof parsed === "object") {
                        patch({ query: parsed });
                      }
                    } catch {
                      /* swallow until valid */
                    }
                  }
                }}
                placeholder='{ "page": "1" }'
              />
            </div>
            <div className="space-y-1.5">
              <Label>Headers (JSON)</Label>
              <Textarea
                rows={2}
                className="font-mono text-xs"
                value={op.headers ? JSON.stringify(op.headers, null, 2) : ""}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === "") {
                    const { headers: _drop, ...rest } = op;
                    onChange(rest as Operation);
                  } else {
                    try {
                      const parsed = JSON.parse(v);
                      if (parsed && typeof parsed === "object") {
                        patch({ headers: parsed });
                      }
                    } catch {
                      /* swallow until valid */
                    }
                  }
                }}
                placeholder='{ "x-api-key": "..." }'
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Body (JSON, optional)</Label>
            <Textarea
              rows={3}
              className="font-mono text-xs"
              value={op.body !== undefined ? JSON.stringify(op.body, null, 2) : ""}
              onChange={(e) => {
                const v = e.target.value;
                if (v === "") {
                  const { body: _drop, ...rest } = op;
                  onChange(rest as Operation);
                } else {
                  try {
                    patch({ body: JSON.parse(v) });
                  } catch {
                    patch({ body: v });
                  }
                }
              }}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Timeout (ms, default 10000)</Label>
            <Input
              type="number"
              value={op.timeoutMs ?? ""}
              onChange={(e) =>
                patch({
                  timeoutMs: e.target.value ? Number(e.target.value) : undefined,
                })
              }
            />
          </div>
        </>
      )}

      {op.type === "transform" && (
        <div className="space-y-1.5">
          <Label>Value (JSON, interpolated; replaces $last)</Label>
          <Textarea
            rows={5}
            className="font-mono text-xs"
            value={JSON.stringify(op.value ?? {}, null, 2)}
            onChange={(e) => {
              try {
                patch({ value: JSON.parse(e.target.value) });
              } catch {
                /* swallow until valid */
              }
            }}
            placeholder='{ "summary": "{{ data.title }} ({{ $last.body.count }})" }'
          />
        </div>
      )}

      {op.type === "run-script" && (
        <>
          <div className="space-y-1.5">
            <Label>Code (JS — runs in sandbox; receives `data` and `last`)</Label>
            <Textarea
              rows={8}
              className="font-mono text-xs"
              value={op.code}
              onChange={(e) => patch({ code: e.target.value })}
              placeholder="return { ok: true, double: data.value * 2 }"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Timeout (ms, default 5000)</Label>
            <Input
              type="number"
              value={op.timeoutMs ?? ""}
              onChange={(e) =>
                patch({
                  timeoutMs: e.target.value ? Number(e.target.value) : undefined,
                })
              }
            />
          </div>
        </>
      )}

      {op.type === "condition" && (
        <>
          <div className="space-y-1.5">
            <Label>Filter (DSL - same as permissions)</Label>
            <Textarea
              rows={3}
              className="font-mono text-xs"
              value={JSON.stringify(op.filter ?? {}, null, 2)}
              onChange={(e) => {
                try {
                  patch({ filter: JSON.parse(e.target.value) });
                } catch {
                  /* swallow until valid */
                }
              }}
              placeholder='{ "published": { "_eq": true } }'
            />
          </div>
          <BranchEditor
            label="Then"
            ops={op.then ?? []}
            onChange={(next) => patch({ then: next })}
            depth={depth + 1}
          />
          <BranchEditor
            label="Else"
            ops={op.else ?? []}
            onChange={(next) => patch({ else: next })}
            depth={depth + 1}
          />
        </>
      )}

      <BranchEditor
        label="On success"
        ops={op.onSuccess ?? []}
        onChange={(next) =>
          patch({ onSuccess: next.length > 0 ? next : undefined })
        }
        depth={depth + 1}
      />
      <BranchEditor
        label="On error"
        ops={op.onError ?? []}
        onChange={(next) =>
          patch({ onError: next.length > 0 ? next : undefined })
        }
        depth={depth + 1}
      />
    </div>
  );
};

interface BranchEditorProps {
  label: string;
  ops: Operation[];
  onChange: (next: Operation[]) => void;
  depth: number;
}

const BranchEditor = ({ label, ops, onChange, depth }: BranchEditorProps) => {
  const [open, setOpen] = useState(ops.length > 0);
  return (
    <div className="space-y-2">
      <button
        type="button"
        className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
        onClick={() => setOpen((s) => !s)}
      >
        {open ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
        {label} ({ops.length})
      </button>
      {open && (
        <div className="space-y-2">
          {ops.map((sub, i) => (
            <OperationEditor
              key={i}
              op={sub}
              depth={depth}
              onChange={(next) => {
                const copy = ops.slice();
                copy[i] = next;
                onChange(copy);
              }}
              onDelete={() => onChange(ops.filter((_, j) => j !== i))}
            />
          ))}
          <AddOperationButton onAdd={(t) => onChange([...ops, blankOperation(t)])} />
        </div>
      )}
    </div>
  );
};

const AddOperationButton = ({ onAdd }: { onAdd: (t: OperationType) => void }) => {
  const [type, setType] = useState<OperationType>("log");
  return (
    <div className="flex items-center gap-2">
      <select
        className={SELECT_CLS + " max-w-[140px]"}
        value={type}
        onChange={(e) => setType(e.target.value as OperationType)}
      >
        {OPERATION_TYPES.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
      <Button type="button" variant="outline" size="sm" onClick={() => onAdd(type)}>
        <PlusIcon /> Add operation
      </Button>
    </div>
  );
};

const buildTrigger = (kind: FlowTriggerKind, value: string): string => {
  if (kind === "manual") return "manual:";
  if (kind === "cron") return `cron:${value}`;
  return `event:${value}`;
};

const parseTrigger = (raw: string): { kind: FlowTriggerKind; value: string } => {
  if (raw.startsWith("manual:")) return { kind: "manual", value: "" };
  if (raw.startsWith("cron:")) return { kind: "cron", value: raw.slice(5) };
  if (raw.startsWith("event:")) return { kind: "event", value: raw.slice(6) };
  // Legacy bare patterns (items:slug:event) — treat as event.
  return { kind: "event", value: raw };
};

export const Flows = () => {
  const [items, setItems] = useState<Flow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [triggerKind, setTriggerKind] = useState<FlowTriggerKind>("event");
  const [triggerValue, setTriggerValue] = useState("items:*:created");
  const [operations, setOperations] = useState<Operation[]>([
    { type: "log", message: "New item: {{ data.id }}" },
  ]);
  const [editorMode, setEditorMode] = useState<"form" | "json" | "graph">("form");
  const [jsonText, setJsonText] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = () => {
    setLoading(true);
    api<{ data: Flow[] }>("/api/flows")
      .then((r) => setItems(r.data))
      .catch((e) => notifyError(e, "Loading flows"))
      .finally(() => setLoading(false));
  };

  useEffect(refresh, []);

  const validation = useMemo(
    () => OperationsSchema.safeParse(operations),
    [operations],
  );

  const switchToJson = () => {
    setJsonText(JSON.stringify(operations, null, 2));
    setEditorMode("json");
  };

  const switchToForm = () => {
    try {
      const parsed = OperationsSchema.parse(JSON.parse(jsonText));
      setOperations(parsed as Operation[]);
      setEditorMode("form");
    } catch (e) {
      notifyError(e, "JSON invalid");
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      let ops: Operation[];
      if (editorMode === "json") {
        ops = OperationsSchema.parse(JSON.parse(jsonText)) as Operation[];
      } else {
        ops = OperationsSchema.parse(operations) as Operation[];
      }
      await api("/api/flows", {
        method: "POST",
        body: JSON.stringify({
          name,
          trigger: buildTrigger(triggerKind, triggerValue),
          operations: ops,
        }),
      });
      setShowForm(false);
      setName("");
      setTriggerKind("event");
      setTriggerValue("items:*:created");
      setOperations([{ type: "log", message: "New item: {{ data.id }}" }]);
      setEditorMode("form");
      refresh();
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await api(`/api/flows/${id}`, { method: "DELETE" });
      refresh();
    } catch (e) {
      notifyError(e, "Deleting flow");
    }
  };

  const [runningFlow, setRunningFlow] = useState<Flow | null>(null);
  const [runPayload, setRunPayload] = useState('{ "manual": true }');
  const [runBusy, setRunBusy] = useState(false);
  const [selectedFlowId, setSelectedFlowId] = useState<string | null>(null);
  const selectedFlow = items.find((f) => f.id === selectedFlowId) ?? null;

  useEffect(() => {
    if (selectedFlowId || items.length === 0) return;
    const first = items[0];
    if (first) setSelectedFlowId(first.id);
  }, [items, selectedFlowId]);

  const runFlow = async () => {
    if (!runningFlow) return;
    let body: unknown;
    try {
      body = runPayload.trim() ? JSON.parse(runPayload) : {};
    } catch {
      notifyError("Payload must be valid JSON");
      return;
    }
    setRunBusy(true);
    try {
      await api(`/api/flows/${runningFlow.id}/run`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      toast.success(`Flow "${runningFlow.name}" dispatched`);
      setRunningFlow(null);
    } catch (e) {
      notifyError(e, "Running flow");
    } finally {
      setRunBusy(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="Flows"
        description="Operation pipelines on event / manual / cron triggers. Form, JSON, or graph editor — same Operation tree."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={refresh}>
              Refresh
            </Button>
            <Button size="sm" onClick={() => setShowForm((s) => !s)}>
              <PlusIcon /> {showForm ? "Cancel" : "New"}
            </Button>
          </>
        }
      />

      {showForm && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>New flow</CardTitle>
          </CardHeader>
          <CardContent>
            <form className="space-y-4" onSubmit={submit}>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="name">Name</Label>
                  <Input
                    id="name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Trigger</Label>
                  <div className="flex gap-2">
                    <select
                      className={SELECT_CLS + " max-w-[110px]"}
                      value={triggerKind}
                      onChange={(e) => {
                        const k = e.target.value as FlowTriggerKind;
                        setTriggerKind(k);
                        if (k === "manual") setTriggerValue("");
                        else if (k === "cron") setTriggerValue("0 9 * * *");
                        else setTriggerValue("items:*:created");
                      }}
                    >
                      {FlowTriggerKinds.map((k) => (
                        <option key={k} value={k}>
                          {k}
                        </option>
                      ))}
                    </select>
                    <Input
                      value={triggerValue}
                      onChange={(e) => setTriggerValue(e.target.value)}
                      placeholder={
                        triggerKind === "cron"
                          ? "0 9 * * * (5-field cron)"
                          : triggerKind === "manual"
                            ? "(no value — manual trigger)"
                            : "items:posts:created"
                      }
                      disabled={triggerKind === "manual"}
                    />
                  </div>
                </div>
              </div>

              <div>
                <div className="mb-2 flex items-center justify-between">
                  <Label>Operations</Label>
                  <div className="flex gap-1 text-xs">
                    {(["form", "json", "graph"] as const).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        className={
                          editorMode === mode
                            ? "rounded-md bg-secondary px-2 py-1"
                            : "px-2 py-1 text-muted-foreground hover:text-foreground"
                        }
                        onClick={() => {
                          if (editorMode === mode) return;
                          if (editorMode === "json" && mode !== "json") {
                            switchToForm();
                            if (mode === "graph") setEditorMode("graph");
                          } else if (editorMode !== "json" && mode === "json") {
                            switchToJson();
                          } else {
                            setEditorMode(mode);
                          }
                        }}
                      >
                        {mode}
                      </button>
                    ))}
                  </div>
                </div>

                {editorMode === "form" && (
                  <div className="space-y-2">
                    {operations.map((op, i) => (
                      <OperationEditor
                        key={i}
                        op={op}
                        depth={0}
                        onChange={(next) => {
                          const copy = operations.slice();
                          copy[i] = next;
                          setOperations(copy);
                        }}
                        onDelete={() =>
                          setOperations(operations.filter((_, j) => j !== i))
                        }
                      />
                    ))}
                    <AddOperationButton
                      onAdd={(t) => setOperations([...operations, blankOperation(t)])}
                    />
                    {!validation.success && operations.length > 0 && (
                      <p className="text-xs text-destructive">
                        {validation.error.issues[0]?.path.join(".")}: {" "}
                        {validation.error.issues[0]?.message}
                      </p>
                    )}
                  </div>
                )}
                {editorMode === "json" && (
                  <Textarea
                    rows={14}
                    className="font-mono text-xs"
                    value={jsonText}
                    onChange={(e) => setJsonText(e.target.value)}
                  />
                )}
                {editorMode === "graph" && (
                  <div className="space-y-2">
                    <FlowGraph operations={operations} />
                    <p className="text-xs text-muted-foreground">
                      Read-only preview. Edit in <strong>Form</strong> or{" "}
                      <strong>JSON</strong> mode. Edge legend:{" "}
                      <span style={{ color: "#22c55e" }}>green</span> = onSuccess,{" "}
                      <span style={{ color: "#ef4444" }}>red</span> = onError,{" "}
                      <span style={{ color: "#3b82f6" }}>blue</span> = then,{" "}
                      <span style={{ color: "#f97316" }}>orange</span> = else.
                    </p>
                  </div>
                )}
              </div>

              <details className="rounded-2xl border border-border bg-muted/30 p-3 text-xs">
                <summary className="cursor-pointer font-medium">
                  Available variables
                </summary>
                <ul className="mt-2 space-y-1 font-mono">
                  {VARIABLE_HINTS.map((v) => (
                    <li key={v.token} className="flex justify-between gap-3">
                      <code className="text-foreground">{v.token}</code>
                      <span className="text-muted-foreground">{v.label}</span>
                    </li>
                  ))}
                </ul>
              </details>

              <div className="flex justify-end">
                <Button
                  type="submit"
                  disabled={busy || (editorMode === "form" && !validation.success)}
                >
                  {busy ? "Creating…" : "Create"}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}


      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[320px_1fr] items-start">
        <Card className="overflow-hidden">
          <CardContent className="p-0">
            {loading ? (
              <ul className="divide-y divide-border">
                {Array.from({ length: 3 }).map((_, i) => (
                  <li key={i} className="space-y-2 p-3">
                    <Skeleton className="h-4 w-2/3" />
                    <Skeleton className="h-3 w-1/2" />
                  </li>
                ))}
              </ul>
            ) : items.length === 0 ? (
              <EmptyState
                icon={WorkflowIcon}
                title="No flows yet"
                description="Operations on event, manual, or cron triggers."
                action={
                  <Button size="sm" onClick={() => setShowForm(true)}>
                    <PlusIcon /> New flow
                  </Button>
                }
              />
            ) : (
              <ul>
                {items.map((f) => {
                  const t = parseTrigger(f.trigger);
                  const active = selectedFlowId === f.id;
                  return (
                    <li
                      key={f.id}
                      onClick={() => setSelectedFlowId(f.id)}
                      className={`grid cursor-pointer grid-cols-[20px_1fr_auto] items-center gap-2 border-b border-border px-3 py-2.5 last:border-b-0 transition-colors ${
                        active ? "bg-accent" : "hover:bg-muted/40"
                      }`}
                    >
                      <WorkflowIcon className="size-3.5 text-muted-foreground" />
                      <div className="min-w-0">
                        <div className="truncate text-[13px] font-medium">
                          {f.name}
                        </div>
                        <div className="truncate font-mono text-[11px] text-muted-foreground">
                          {t.value || "(manual)"}
                        </div>
                      </div>
                      <Badge
                        variant={f.active ? "default" : "secondary"}
                        className="text-[10px]"
                      >
                        {f.active ? "active" : "paused"}
                      </Badge>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>

        <div className="space-y-3">
          {!selectedFlow ? (
            <Card>
              <CardContent className="px-6 py-12 text-center text-sm text-muted-foreground">
                <WorkflowIcon className="mx-auto mb-3 size-8 opacity-40" />
                Select a flow on the left to inspect its trigger, operations
                graph, and run statistics.
              </CardContent>
            </Card>
          ) : (
            <>
              <Card>
                <CardContent className="space-y-4 p-5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-base font-semibold">
                      {selectedFlow.name}
                    </span>
                    <Badge variant="outline" className="text-[10px] uppercase tracking-wide">
                      {parseTrigger(selectedFlow.trigger).kind}
                    </Badge>
                    {selectedFlow.active ? (
                      <Badge>active</Badge>
                    ) : (
                      <Badge variant="secondary">paused</Badge>
                    )}
                    <span className="font-mono text-xs text-muted-foreground">
                      · {selectedFlow.operations.length} operation(s)
                    </span>
                    <div className="flex-1" />
                    <Button
                      size="sm"
                      onClick={() => {
                        setRunningFlow(selectedFlow);
                        setRunPayload('{ "manual": true }');
                      }}
                    >
                      <PlayIcon /> Run now
                    </Button>
                    <ConfirmAction
                      title={`Delete flow "${selectedFlow.name}"?`}
                      description="The flow stops firing immediately. This cannot be undone."
                      actionLabel="Delete"
                      destructive
                      onConfirm={async () => {
                        const id = selectedFlow.id;
                        await remove(id);
                        setSelectedFlowId(null);
                      }}
                    >
                      <Button variant="ghost" size="icon-sm">
                        <Trash2Icon />
                      </Button>
                    </ConfirmAction>
                  </div>
                  <div className="font-mono text-xs text-muted-foreground">
                    trigger: {selectedFlow.trigger}
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardContent className="p-4">
                  <FlowGraph operations={selectedFlow.operations} />
                </CardContent>
              </Card>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                {[
                  { k: "Last run", v: "—" },
                  { k: "Success rate", v: "—" },
                  { k: "Failures (24h)", v: "—" },
                ].map((s) => (
                  <Card key={s.k}>
                    <CardContent className="p-4">
                      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        {s.k}
                      </div>
                      <div className="mt-1 text-xl font-semibold tabular-nums">
                        {s.v}
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>

              <p className="text-xs text-muted-foreground">
                Per-flow run metrics are not yet recorded server-side; the
                cards above will populate once flow execution observability
                lands.
              </p>
            </>
          )}
        </div>
      </div>

      <Dialog
        open={runningFlow !== null}
        onOpenChange={(o) => !o && setRunningFlow(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Run flow now</DialogTitle>
            <DialogDescription>
              {runningFlow ? `"${runningFlow.name}" — provide an optional JSON payload.` : ""}
            </DialogDescription>
          </DialogHeader>
          <Textarea
            rows={10}
            className="font-mono text-xs"
            value={runPayload}
            onChange={(e) => setRunPayload(e.target.value)}
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRunningFlow(null)}>
              Cancel
            </Button>
            <Button onClick={runFlow} disabled={runBusy}>
              {runBusy ? "Running…" : "Run"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
