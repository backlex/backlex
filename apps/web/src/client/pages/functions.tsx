import { useEffect, useState, type FormEvent } from "react";
import { CodeIcon, PlayIcon, PlusIcon, Trash2Icon, PencilIcon } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@workeros/ui/components/card";
import { Button } from "@workeros/ui/components/button";
import { Input } from "@workeros/ui/components/input";
import { Label } from "@workeros/ui/components/label";
import { Textarea } from "@workeros/ui/components/textarea";
import { Skeleton } from "@workeros/ui/components/skeleton";
import { Badge } from "@workeros/ui/components/badge";
import { ConfirmAction } from "@/components/confirm-action";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { notifyError } from "@/lib/error";
import { api } from "@/lib/api";

interface FunctionRow {
  id: string;
  name: string;
  trigger: "http" | "event" | "cron";
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

const SAMPLE_HTTP = `// ctx.data is the request body, ctx.user has the caller
console.log("invoked by", ctx.user.email);
return { greeting: "hello " + (ctx.data.name || "world") };`;

const SAMPLE_EVENT = `// For event triggers, ctx.data = { event, data }
console.log("event", ctx.data.event, "on", ctx.data.data.id);`;

const SAMPLE_CRON = `// For cron, ctx.data = { firedAt, pattern }
console.log("cron tick at", ctx.data.firedAt);`;

const Editor = ({
  initial,
  onSubmit,
  busy,
}: {
  initial?: FunctionRow;
  onSubmit: (input: {
    name: string;
    trigger: "http" | "event" | "cron";
    pattern: string | null;
    code: string;
    timeoutMs: number;
    active: boolean;
  }) => Promise<void>;
  busy: boolean;
}) => {
  const [name, setName] = useState(initial?.name ?? "");
  const [trigger, setTrigger] = useState<"http" | "event" | "cron">(
    initial?.trigger ?? "http",
  );
  const [pattern, setPattern] = useState(initial?.pattern ?? "items:*:*");
  const [code, setCode] = useState(initial?.code ?? SAMPLE_HTTP);
  const [timeoutMs, setTimeoutMs] = useState(initial?.timeoutMs ?? 5000);
  const [active, setActive] = useState(!!(initial?.active ?? true));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void onSubmit({
      name,
      trigger,
      pattern: trigger === "event" ? pattern : null,
      code,
      timeoutMs,
      active,
    });
  };

  return (
    <form className="space-y-3" onSubmit={submit}>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor="fname">Name (snake or kebab)</Label>
          <Input
            id="fname"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="my_function"
            required
            pattern="^[a-z][a-z0-9_-]*$"
            disabled={!!initial}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ftrig">Trigger</Label>
          <select
            id="ftrig"
            className="h-9 w-full rounded-3xl border border-input bg-background px-3 text-sm"
            value={trigger}
            onChange={(e) => {
              const v = e.target.value as "http" | "event" | "cron";
              setTrigger(v);
              setCode(
                v === "http"
                  ? SAMPLE_HTTP
                  : v === "event"
                    ? SAMPLE_EVENT
                    : SAMPLE_CRON,
              );
              if (v === "cron") setPattern("*/5 * * * *");
              if (v === "event") setPattern("items:*:*");
            }}
          >
            <option value="http">http (manual invoke)</option>
            <option value="event">event (pub-sub trigger)</option>
            <option value="cron">cron (scheduled)</option>
          </select>
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
          />
          {trigger === "cron" && (
            <p className="text-xs text-muted-foreground">
              5-field cron (minute hour day month weekday). Granularity is 1 minute.
            </p>
          )}
        </div>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="fcode">Code</Label>
        <Textarea
          id="fcode"
          rows={14}
          className="font-mono text-xs"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          required
        />
        <p className="text-xs text-muted-foreground">
          Globals: <code>ctx.data</code>, <code>ctx.user</code>,{" "}
          <code>console.log</code>. Sync-only in v1; runs in QuickJS-WASM
          sandbox.
        </p>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={active}
          onChange={(e) => setActive(e.target.checked)}
        />
        active
      </label>

      <div className="flex justify-end">
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : initial ? "Save" : "Create"}
        </Button>
      </div>
    </form>
  );
};

export const Functions = () => {
  const [items, setItems] = useState<FunctionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<FunctionRow | null>(null);
  const [busy, setBusy] = useState(false);

  const [invokeOpen, setInvokeOpen] = useState<FunctionRow | null>(null);
  const [invokeBody, setInvokeBody] = useState("{}");
  const [invokeResult, setInvokeResult] = useState<InvokeResult | null>(null);

  const refresh = () => {
    setLoading(true);
    api<{ data: FunctionRow[] }>("/api/functions")
      .then((r) => setItems(r.data))
      .catch((e) => notifyError(e, "Loading functions"))
      .finally(() => setLoading(false));
  };

  useEffect(refresh, []);

  const create = async (input: Parameters<typeof Editor>[0]["onSubmit"] extends (i: infer P) => unknown ? P : never) => {
    setBusy(true);
    try {
      await api("/api/functions", {
        method: "POST",
        body: JSON.stringify(input),
      });
      setShowForm(false);
      refresh();
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };

  const update = async (
    id: string,
    input: { code: string; timeoutMs: number; active: boolean; pattern: string | null; trigger: "http" | "event" | "cron" },
  ) => {
    setBusy(true);
    try {
      await api(`/api/functions/${id}`, {
        method: "PATCH",
        body: JSON.stringify(input),
      });
      setEditing(null);
      refresh();
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await api(`/api/functions/${id}`, { method: "DELETE" });
      refresh();
    } catch (e) {
      notifyError(e, "Deleting function");
    }
  };

  const invoke = async () => {
    if (!invokeOpen) return;
    setInvokeResult(null);
    try {
      const body = invokeBody.trim() ? JSON.parse(invokeBody) : {};
      const res = await fetch(
        `/api/functions/${invokeOpen.name}/invoke`,
        {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const data = (await res.json()) as InvokeResult;
      setInvokeResult(data);
    } catch (e) {
      setInvokeResult({
        ok: false,
        logs: [],
        error: (e as Error).message,
        durationMs: 0,
      });
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
            <Button
              size="sm"
              onClick={() => {
                setEditing(null);
                setShowForm((s) => !s);
              }}
            >
              <PlusIcon /> {showForm ? "Cancel" : "New"}
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[320px_1fr] items-start">
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
                <Button size="sm" onClick={() => setShowForm(true)}>
                  <PlusIcon /> New function
                </Button>
              }
            />
          ) : (
            <ul>
              {items.map((f) => {
                const isActive =
                  editing?.id === f.id || invokeOpen?.id === f.id;
                return (
                  <li
                    key={f.id}
                    onClick={() => {
                      setShowForm(false);
                      setEditing(f);
                      setInvokeOpen(null);
                    }}
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

      {/* Right: detail / new / invoke */}
      <div className="space-y-3">
      {showForm && !editing && (
        <Card>
          <CardHeader>
            <CardTitle>New function</CardTitle>
          </CardHeader>
          <CardContent>
            <Editor onSubmit={(i) => create(i)} busy={busy} />
          </CardContent>
        </Card>
      )}

      {!showForm && !editing && !invokeOpen && items.length > 0 && (
        <Card>
          <CardContent className="px-6 py-12 text-center text-sm text-muted-foreground">
            <CodeIcon className="mx-auto mb-3 size-8 opacity-40" />
            Select a function from the list to edit, or click{" "}
            <button
              type="button"
              onClick={() => setShowForm(true)}
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
            <Editor
              initial={editing}
              busy={busy}
              onSubmit={(i) =>
                update(editing.id, {
                  code: i.code,
                  timeoutMs: i.timeoutMs,
                  active: i.active,
                  pattern: i.pattern,
                  trigger: i.trigger,
                })
              }
            />
          </CardContent>
        </Card>
      )}

      {invokeOpen && (
        <Card className="ring-2 ring-primary/30">
          <CardHeader>
            <CardTitle>Invoke {invokeOpen.name}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1.5">
              <Label>Body (JSON, becomes ctx.data)</Label>
              <Textarea
                rows={4}
                className="font-mono text-xs"
                value={invokeBody}
                onChange={(e) => setInvokeBody(e.target.value)}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setInvokeOpen(null);
                  setInvokeResult(null);
                }}
              >
                Close
              </Button>
              <Button size="sm" onClick={invoke}>
                <PlayIcon /> Run
              </Button>
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
                      (invokeResult.ok ? "text-emerald-600 dark:text-emerald-400" : "text-destructive")
                    }
                  >
                    {invokeResult.ok ? "✓ ok" : "✗ error"} · {invokeResult.durationMs}ms
                  </span>
                </div>
                <div
                  className="max-h-72 overflow-auto p-3 font-mono text-[12px] leading-relaxed"
                  style={{
                    background: "oklch(0.18 0.01 130)",
                    color: "oklch(0.92 0.02 130)",
                  }}
                >
                  {invokeResult.logs.length === 0 && !invokeResult.error && invokeResult.value === undefined && (
                    <div style={{ color: "oklch(0.6 0.02 130)" }}>
                      Function returned no output.
                    </div>
                  )}
                  {invokeResult.logs.map((line, i) => (
                    <div key={i}>
                      <span style={{ color: "oklch(0.6 0.02 130)" }}>
                        {String(i + 1).padStart(3, "0")}
                      </span>{" "}
                      <span style={{ color: "oklch(0.78 0.18 95)" }}>INFO </span>{" "}
                      {line}
                    </div>
                  ))}
                  {invokeResult.error && (
                    <div className="mt-1">
                      <span style={{ color: "oklch(0.6 0.02 130)" }}>err</span>{" "}
                      <span style={{ color: "oklch(0.7 0.18 22)" }}>ERROR</span>{" "}
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
          </CardContent>
        </Card>
      )}

      </div>
      </div>
    </div>
  );
};
