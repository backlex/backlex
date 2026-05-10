import { useEffect, useState } from "react";
import { CodeIcon, PlayIcon, PlusIcon, Trash2Icon } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@workeros/ui/components/card";
import { Button } from "@workeros/ui/components/button";
import { Input } from "@workeros/ui/components/input";
import { Label } from "@workeros/ui/components/label";
import { Textarea } from "@workeros/ui/components/textarea";
import { Skeleton } from "@workeros/ui/components/skeleton";
import { Badge } from "@workeros/ui/components/badge";
import { Switch } from "@workeros/ui/components/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workeros/ui/components/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workeros/ui/components/select";
import { ConfirmAction } from "@/components/confirm-action";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { CodeEditor } from "@/components/code-editor-lazy";
import { notifyError } from "@/lib/error";
import { api } from "@/lib/api";

type Trigger = "http" | "event" | "cron";

interface FunctionRow {
  id: string;
  name: string;
  trigger: Trigger;
  pattern: string | null;
  code: string;
  timeoutMs: number;
  active: boolean | number;
  createdAt: string;
}

interface InvokeResult {
  ok: boolean;
  value?: unknown;
  logs: string[];
  error?: string;
  durationMs: number;
}

interface FunctionInput {
  name: string;
  trigger: Trigger;
  pattern: string | null;
  code: string;
  timeoutMs: number;
  active: boolean;
}

const SAMPLE_HTTP = `// ctx.data is the request body, ctx.user has the caller
console.log("invoked by", ctx.user.email);
return { greeting: "hello " + (ctx.data.name || "world") };`;

const SAMPLE_EVENT = `// For event triggers, ctx.data = { event, data }
console.log("event", ctx.data.event, "on", ctx.data.data.id);`;

const SAMPLE_CRON = `// For cron, ctx.data = { firedAt, pattern }
console.log("cron tick at", ctx.data.firedAt);`;

const sampleFor = (t: Trigger): string =>
  t === "http" ? SAMPLE_HTTP : t === "event" ? SAMPLE_EVENT : SAMPLE_CRON;

const defaultPatternFor = (t: Trigger): string =>
  t === "cron" ? "*/5 * * * *" : t === "event" ? "items:*:*" : "";

const TRIGGER_LABEL: Record<Trigger, string> = {
  http: "http (manual invoke)",
  event: "event (pub-sub trigger)",
  cron: "cron (scheduled)",
};

const useFunctionForm = (initial?: FunctionRow) => {
  const [name, setName] = useState(initial?.name ?? "");
  const [trigger, setTrigger] = useState<Trigger>(initial?.trigger ?? "http");
  const [pattern, setPattern] = useState(
    initial?.pattern ?? defaultPatternFor(initial?.trigger ?? "http"),
  );
  const [code, setCode] = useState(
    initial?.code ?? sampleFor(initial?.trigger ?? "http"),
  );
  const [timeoutMs, setTimeoutMs] = useState(initial?.timeoutMs ?? 5000);
  const [active, setActive] = useState(!!(initial?.active ?? true));

  const onTriggerChange = (next: Trigger) => {
    setTrigger(next);
    if (!initial) {
      setCode(sampleFor(next));
      setPattern(defaultPatternFor(next));
    } else if (next !== initial.trigger) {
      setPattern(defaultPatternFor(next));
    }
  };

  return {
    values: { name, trigger, pattern, code, timeoutMs, active },
    setName,
    setPattern,
    setCode,
    setTimeoutMs,
    setActive,
    onTriggerChange,
  };
};

const FieldsBlock = ({
  values,
  setName,
  setPattern,
  setCode,
  setTimeoutMs,
  setActive,
  onTriggerChange,
  isEdit,
}: ReturnType<typeof useFunctionForm> & { isEdit: boolean }) => {
  const { name, trigger, pattern, code, timeoutMs, active } = values;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor="fname">Name</Label>
          <Input
            id="fname"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="my_function"
            required
            pattern="^[a-z][a-z0-9_-]*$"
            disabled={isEdit}
          />
          <p className="text-[11px] text-muted-foreground">
            lowercase, digits, <code>_</code> or <code>-</code>; must start with
            a letter.
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ftrig">Trigger</Label>
          <Select
            value={trigger}
            onValueChange={(v) => onTriggerChange(v as Trigger)}
          >
            <SelectTrigger id="ftrig" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="http">{TRIGGER_LABEL.http}</SelectItem>
              <SelectItem value="event">{TRIGGER_LABEL.event}</SelectItem>
              <SelectItem value="cron">{TRIGGER_LABEL.cron}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ftout">Timeout (ms)</Label>
          <Input
            id="ftout"
            type="number"
            min={50}
            max={60000}
            value={timeoutMs}
            onChange={(e) => setTimeoutMs(Number(e.target.value))}
          />
        </div>
      </div>

      {trigger !== "http" && (
        <div className="space-y-1.5">
          <Label htmlFor="fpat">
            {trigger === "cron" ? "Cron expression" : "Event pattern"}
          </Label>
          <Input
            id="fpat"
            value={pattern}
            onChange={(e) => setPattern(e.target.value)}
            placeholder={
              trigger === "cron" ? "*/5 * * * *" : "items:posts:*"
            }
            required
          />
          <p className="text-[11px] text-muted-foreground">
            {trigger === "cron"
              ? "5-field cron (minute hour day month weekday). Granularity is 1 minute."
              : "Examples: items:posts:created, items:posts:*, items:*:*"}
          </p>
        </div>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="fcode">Code</Label>
        <CodeEditor
          value={code}
          onChange={setCode}
          language="plain"
          minHeight="220px"
        />
        <p className="text-[11px] text-muted-foreground">
          Globals: <code>ctx.data</code>, <code>ctx.user</code>,{" "}
          <code>console.log</code>. Sync-only in v1; runs in QuickJS-WASM
          sandbox.
        </p>
      </div>

      <div className="flex items-center justify-between rounded-2xl border border-border bg-muted/30 px-3 py-2.5">
        <div>
          <Label htmlFor="factive" className="cursor-pointer text-sm">
            Active
          </Label>
          <p className="text-[11px] text-muted-foreground">
            When paused, triggers stop firing and HTTP invokes are rejected.
          </p>
        </div>
        <Switch id="factive" checked={active} onCheckedChange={setActive} />
      </div>
    </div>
  );
};

const buildInput = (values: ReturnType<typeof useFunctionForm>["values"]): FunctionInput => ({
  name: values.name,
  trigger: values.trigger,
  pattern: values.trigger === "http" ? null : values.pattern,
  code: values.code,
  timeoutMs: values.timeoutMs,
  active: values.active,
});

const NewFunctionDialog = ({
  open,
  onOpenChange,
  onCreate,
  busy,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreate: (input: FunctionInput) => Promise<void>;
  busy: boolean;
}) => {
  const form = useFunctionForm();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New function</DialogTitle>
          <DialogDescription>
            Create a sandboxed JS function. HTTP for manual invoke, event for
            pub-sub triggers, or cron for scheduled runs.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void onCreate(buildInput(form.values));
          }}
          className="space-y-4"
        >
          <FieldsBlock {...form} isEdit={false} />
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Creating…" : "Create function"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

const EditFunctionForm = ({
  initial,
  busy,
  onSave,
}: {
  initial: FunctionRow;
  busy: boolean;
  onSave: (input: FunctionInput) => Promise<void>;
}) => {
  const form = useFunctionForm(initial);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void onSave(buildInput(form.values));
      }}
      className="space-y-4"
    >
      <FieldsBlock {...form} isEdit={true} />
      <div className="flex justify-end">
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </form>
  );
};

export const Functions = () => {
  const [items, setItems] = useState<FunctionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [editing, setEditing] = useState<FunctionRow | null>(null);
  const [busy, setBusy] = useState(false);

  const [invokeOpen, setInvokeOpen] = useState<FunctionRow | null>(null);
  const [invokeBody, setInvokeBody] = useState("{}");
  const [invokeBusy, setInvokeBusy] = useState(false);
  const [invokeResult, setInvokeResult] = useState<InvokeResult | null>(null);

  const refresh = () => {
    setLoading(true);
    api<{ data: FunctionRow[] }>("/api/functions")
      .then((r) => {
        setItems(r.data);
        // keep a fresh copy of the currently-selected row so the editor
        // reflects server-side state after a save.
        setEditing((prev) =>
          prev ? r.data.find((f) => f.id === prev.id) ?? null : null,
        );
      })
      .catch((e) => notifyError(e, "Loading functions"))
      .finally(() => setLoading(false));
  };

  useEffect(refresh, []);

  const create = async (input: FunctionInput) => {
    setBusy(true);
    try {
      await api("/api/functions", {
        method: "POST",
        body: JSON.stringify(input),
      });
      setShowNew(false);
      refresh();
    } catch (e) {
      notifyError(e, "Creating function");
    } finally {
      setBusy(false);
    }
  };

  const update = async (id: string, input: FunctionInput) => {
    setBusy(true);
    try {
      await api(`/api/functions/${id}`, {
        method: "PATCH",
        body: JSON.stringify({
          trigger: input.trigger,
          pattern: input.pattern,
          code: input.code,
          timeoutMs: input.timeoutMs,
          active: input.active,
        }),
      });
      refresh();
    } catch (e) {
      notifyError(e, "Saving function");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await api(`/api/functions/${id}`, { method: "DELETE" });
      if (editing?.id === id) setEditing(null);
      refresh();
    } catch (e) {
      notifyError(e, "Deleting function");
    }
  };

  const invoke = async () => {
    if (!invokeOpen) return;
    setInvokeBusy(true);
    setInvokeResult(null);
    try {
      const body = invokeBody.trim() ? JSON.parse(invokeBody) : {};
      const res = await fetch(`/api/functions/${invokeOpen.name}/invoke`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as InvokeResult;
      setInvokeResult(data);
    } catch (e) {
      setInvokeResult({
        ok: false,
        logs: [],
        error: (e as Error).message,
        durationMs: 0,
      });
    } finally {
      setInvokeBusy(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="Functions"
        description="Sandboxed JS — HTTP, event-trigger, or cron. Provider auto-selected per runtime (cf-dispatch / bun-worker / quickjs)."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={refresh}>
              Refresh
            </Button>
            <Button size="sm" onClick={() => setShowNew(true)}>
              <PlusIcon /> New
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[320px_1fr]">
        {/* Left: function list */}
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
                icon={CodeIcon}
                title="No functions yet"
                description="Functions run sandboxed JS on demand (HTTP), event triggers, or cron schedules."
                action={
                  <Button size="sm" onClick={() => setShowNew(true)}>
                    <PlusIcon /> New function
                  </Button>
                }
              />
            ) : (
              <ul>
                {items.map((f) => {
                  const isActive = editing?.id === f.id;
                  return (
                    <li
                      key={f.id}
                      onClick={() => setEditing(f)}
                      className={`grid cursor-pointer grid-cols-[20px_1fr_auto] items-center gap-2 border-b border-border px-3 py-2.5 last:border-b-0 transition-colors ${
                        isActive ? "bg-accent" : "hover:bg-muted/40"
                      }`}
                    >
                      <CodeIcon className="size-3.5 text-muted-foreground" />
                      <div className="min-w-0">
                        <div className="truncate font-mono text-[12.5px] font-medium">
                          {f.name}
                        </div>
                        <div className="truncate font-mono text-[11px] text-muted-foreground">
                          {f.pattern ?? f.trigger}
                        </div>
                      </div>
                      <div className="flex items-center gap-1">
                        <Badge
                          variant="outline"
                          className="font-mono text-[10px]"
                        >
                          {f.trigger}
                        </Badge>
                        {!f.active && (
                          <Badge variant="secondary" className="text-[10px]">
                            paused
                          </Badge>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* Right: detail / invoke */}
        <div className="space-y-3">
          {!editing && items.length > 0 && (
            <Card>
              <CardContent className="px-6 py-12 text-center text-sm text-muted-foreground">
                <CodeIcon className="mx-auto mb-3 size-8 opacity-40" />
                Select a function from the list to edit, or click{" "}
                <button
                  type="button"
                  onClick={() => setShowNew(true)}
                  className="font-medium text-foreground underline-offset-4 hover:underline"
                >
                  New
                </button>{" "}
                to create one.
              </CardContent>
            </Card>
          )}

          {editing && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center justify-between gap-2">
                  <span>
                    <span className="font-mono">{editing.name}</span>
                    <span className="ml-2 text-xs font-normal text-muted-foreground">
                      edit
                    </span>
                  </span>
                  <div className="flex gap-1">
                    {editing.trigger === "http" && editing.active && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setInvokeOpen(editing);
                          setInvokeBody("{}");
                          setInvokeResult(null);
                        }}
                      >
                        <PlayIcon /> Run
                      </Button>
                    )}
                    <ConfirmAction
                      title={`Delete function "${editing.name}"?`}
                      description="The function will be removed permanently. Active triggers stop firing immediately."
                      actionLabel="Delete"
                      destructive
                      onConfirm={() => remove(editing.id)}
                    >
                      <Button variant="ghost" size="icon-sm">
                        <Trash2Icon />
                      </Button>
                    </ConfirmAction>
                  </div>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <EditFunctionForm
                  key={editing.id}
                  initial={editing}
                  busy={busy}
                  onSave={(i) => update(editing.id, i)}
                />
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      <NewFunctionDialog
        open={showNew}
        onOpenChange={setShowNew}
        onCreate={create}
        busy={busy}
      />

      <Dialog
        open={invokeOpen !== null}
        onOpenChange={(o) => {
          if (!o) {
            setInvokeOpen(null);
            setInvokeResult(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              Invoke{" "}
              <span className="font-mono">{invokeOpen?.name}</span>
            </DialogTitle>
            <DialogDescription>
              Body becomes <code>ctx.data</code> inside the sandbox. Returns
              logs and the function's return value.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="invokeBody">Body (JSON)</Label>
              <Textarea
                id="invokeBody"
                rows={4}
                className="font-mono text-xs"
                value={invokeBody}
                onChange={(e) => setInvokeBody(e.target.value)}
              />
            </div>
            {invokeResult && (
              <div className="overflow-hidden rounded-2xl border border-border">
                <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs">
                  <CodeIcon className="size-3.5" />
                  <span className="font-medium">Logs</span>
                  <span className="font-mono text-muted-foreground">
                    last invocation
                  </span>
                  <div className="flex-1" />
                  <span
                    className={
                      "font-mono tabular-nums " +
                      (invokeResult.ok
                        ? "text-emerald-600 dark:text-emerald-400"
                        : "text-destructive")
                    }
                  >
                    {invokeResult.ok ? "✓ ok" : "✗ error"} ·{" "}
                    {invokeResult.durationMs}ms
                  </span>
                </div>
                <div
                  className="max-h-72 overflow-auto p-3 font-mono text-[12px] leading-relaxed"
                  style={{
                    background: "oklch(0.18 0.01 130)",
                    color: "oklch(0.92 0.02 130)",
                  }}
                >
                  {invokeResult.logs.length === 0 &&
                    !invokeResult.error &&
                    invokeResult.value === undefined && (
                      <div style={{ color: "oklch(0.6 0.02 130)" }}>
                        Function returned no output.
                      </div>
                    )}
                  {invokeResult.logs.map((line, i) => (
                    <div key={i}>
                      <span style={{ color: "oklch(0.6 0.02 130)" }}>
                        {String(i + 1).padStart(3, "0")}
                      </span>{" "}
                      <span style={{ color: "oklch(0.78 0.18 95)" }}>
                        INFO
                      </span>{" "}
                      {line}
                    </div>
                  ))}
                  {invokeResult.error && (
                    <div className="mt-1">
                      <span style={{ color: "oklch(0.6 0.02 130)" }}>err</span>{" "}
                      <span style={{ color: "oklch(0.7 0.18 22)" }}>
                        ERROR
                      </span>{" "}
                      <span className="break-all whitespace-pre-wrap">
                        {invokeResult.error}
                      </span>
                    </div>
                  )}
                  {invokeResult.value !== undefined && (
                    <div className="mt-2 border-t border-[oklch(0.3_0.01_130)] pt-2">
                      <div style={{ color: "oklch(0.6 0.02 130)" }}>
                        return value
                      </div>
                      <pre className="whitespace-pre-wrap break-all">
                        {JSON.stringify(invokeResult.value, null, 2)}
                      </pre>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => {
                setInvokeOpen(null);
                setInvokeResult(null);
              }}
            >
              Close
            </Button>
            <Button onClick={invoke} disabled={invokeBusy}>
              <PlayIcon /> {invokeBusy ? "Running…" : "Run"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
