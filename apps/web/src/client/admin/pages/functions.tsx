// Functions page — sandboxed JS editor + invocation logs + new-function wizard
import { useEffect, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { I } from "../icons";
import { Badge, Button, EmptyState, IconButton, PageHeader, Switch } from "../ui";
import { Select } from "../select";
import { ConfirmDialog } from "../sheet";
import { api } from "@/lib/api";
import { Input } from "@backlex/ui/components/input";
import { Textarea } from "@backlex/ui/components/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@backlex/ui/components/dialog";
import { ScrollArea } from "@backlex/ui/components/scroll-area";
import { fetchSafely } from "./_shared";
import { FunctionsSkeleton } from "../page-skeletons";

export function FunctionsPage({ pushToast }: { pushToast: (m: string) => void }) {
  const { t } = useLingui();
  type FnRow = { name: string; kind: string; trigger: string; lang: string; invocations: number; p95: number };
  const [funcs, setFuncs] = useState<FnRow[]>([]);
  // First-load gate — drives the page skeleton until functions land.
  const [loaded, setLoaded] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  // Pull invocation counts + p95 from /api/admin/metrics/entities so the
  // sidebar + header show real numbers instead of hardcoded `1102 / 128ms`.
  const reloadFuncs = async () => {
    const [r, m] = await Promise.all([
      fetchSafely<{ data: { name: string; trigger: string; pattern: string | null; active: boolean }[] }>("/api/functions"),
      fetchSafely<{ data: { functions: Record<string, { invocations: number; p95Ms: number; lastInvoke: number | null }> } }>(`/api/admin/metrics/entities`),
    ]);
    const stats = m?.data?.functions ?? {};
    if (Array.isArray(r?.data)) {
      setFuncs(
        r.data.map((f) => ({
          name: f.name,
          kind: f.trigger,
          trigger: f.pattern ?? f.trigger,
          lang: "js",
          invocations: stats[f.name]?.invocations ?? 0,
          p95: stats[f.name]?.p95Ms ?? 0,
        })),
      );
    }
    return r?.data ?? [];
  };
  useEffect(() => { void reloadFuncs().finally(() => setLoaded(true)); }, []);
  const [active, setActive] = useState<FnRow | null>(null);
  // Auto-select first function once funcs are loaded.
  useEffect(() => {
    if (active && funcs.some((f) => f.name === active.name)) return;
    setActive(funcs[0] ?? null);
  }, [funcs]);
  const [code, setCode] = useState("");
  // Pull the actual code for the active function once we know its name.
  useEffect(() => {
    if (!active) { setCode(""); return; }
    void (async () => {
      try {
        const r = await api<{ data: { id: string; name: string; code: string }[] }>("/api/functions");
        const match = r.data?.find((f) => f.name === active.name);
        if (match?.code) setCode(match.code);
      } catch {
        // keep what's in the editor
      }
    })();
  }, [active?.name]);
  const [logs, setLogs] = useState<{ t: string; lvl: string; msg: string }[]>([]);
  const [running, setRunning] = useState(false);
  // Name of the function pending a delete confirmation (null = no dialog open).
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  // Draft value while inline-editing the active function's name (null = not editing).
  const [renameDraft, setRenameDraft] = useState<string | null>(null);
  const [renameBusy, setRenameBusy] = useState(false);
  // Leaving the rename editor open across function switches would be confusing.
  useEffect(() => { setRenameDraft(null); }, [active?.name]);

  const nameRegex = /^[a-z][a-z0-9_-]*$/;
  const renameError = renameDraft === null
    ? null
    : renameDraft.trim().length === 0
      ? t`Required.`
      : !nameRegex.test(renameDraft.trim())
        ? t`Lowercase letters, digits, _ or -; must start with a letter.`
        : renameDraft.trim() !== active?.name && funcs.some((f) => f.name === renameDraft.trim())
          ? t`A function with that name already exists.`
          : null;

  const run = async () => {
    if (!active) { pushToast(t`Select a function to run.`); return; }
    setRunning(true);
    setLogs([{ t: new Date().toISOString().slice(11, 19), lvl: "info", msg: t`invoking ${active.name}…` }]);
    try {
      // The invoke route returns the SandboxResult directly (no `{data: …}`
      // wrapper): `{ ok, logs: string[], error?, value?, durationMs }`. Map
      // each log line into the {t, lvl, msg} shape the UI renders.
      const r = await api<{ ok: boolean; logs: string[]; value?: unknown; error?: string; durationMs?: number }>(
        `/api/functions/${active.name}/invoke`,
        { method: "POST", body: JSON.stringify({}) },
      );
      const ts = new Date().toISOString().slice(11, 19);
      const logLines = (r.logs ?? []).map((m) => ({ t: ts, lvl: "info", msg: m }));
      const summary = r.ok
        ? { t: ts, lvl: "info", msg: t`done · ${r.durationMs ?? "—"}ms · result: ${JSON.stringify(r.value ?? null).slice(0, 200)}` }
        : { t: ts, lvl: "error", msg: r.error ?? t`function failed` };
      setLogs((arr) => [...arr, ...logLines, summary]);
      if (r.ok) pushToast(t`Function ran successfully.`);
      else pushToast(r.error ?? t`Function failed`);
    } catch (e) {
      // Non-2xx responses parse the same way: api() throws AppError with the
      // server's message. For the function endpoint a 500 still carries the
      // SandboxResult body, so try to surface the sandbox error if present.
      const ts = new Date().toISOString().slice(11, 19);
      const msg = (e as Error).message;
      let parsed: { error?: string; logs?: string[] } | null = null;
      try { parsed = JSON.parse(msg); } catch { /* not JSON */ }
      const lines = (parsed?.logs ?? []).map((m) => ({ t: ts, lvl: "info", msg: m }));
      setLogs((arr) => [...arr, ...lines, { t: ts, lvl: "error", msg: parsed?.error ?? msg }]);
      pushToast(parsed?.error ?? msg);
    } finally {
      setRunning(false);
    }
  };
  const saveCode = async () => {
    if (!active) { pushToast(t`Select a function to save.`); return; }
    try {
      const r = await api<{ data: { id: string }[] }>("/api/functions");
      const match = r.data.find((f: any) => f.name === active.name);
      if (match) {
        await api(`/api/functions/${match.id}`, {
          method: "PATCH",
          body: JSON.stringify({ code }),
        });
      } else {
        await api(`/api/functions`, {
          method: "POST",
          body: JSON.stringify({
            name: active.name,
            trigger: active.kind,
            pattern: active.trigger,
            code,
            timeoutMs: 5000,
            active: true,
          }),
        });
      }
      pushToast(t`Function saved.`);
    } catch (e) {
      pushToast((e as Error).message);
    }
  };
  const removeFunction = async (name: string) => {
    try {
      const r = await api<{ data: { id: string; name: string }[] }>("/api/functions");
      const match = r.data.find((f) => f.name === name);
      if (!match) {
        pushToast(t`Function not found on server.`);
        await reloadFuncs();
        return;
      }
      await api(`/api/functions/${match.id}`, { method: "DELETE" });
      if (active?.name === name) {
        setActive(null);
        setCode("");
        setLogs([]);
      }
      await reloadFuncs();
      pushToast(t`Function "${name}" deleted.`);
    } catch (e) {
      pushToast((e as Error).message);
    }
  };
  const renameFunction = async (oldName: string, nextName: string) => {
    const target = nextName.trim();
    if (!target || target === oldName) { setRenameDraft(null); return; }
    setRenameBusy(true);
    try {
      const r = await api<{ data: { id: string; name: string }[] }>("/api/functions");
      const match = r.data.find((f) => f.name === oldName);
      if (!match) {
        pushToast(t`Function not found on server.`);
        await reloadFuncs();
        return;
      }
      await api(`/api/functions/${match.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: target }),
      });
      setActive((a) => (a && a.name === oldName ? { ...a, name: target } : a));
      setRenameDraft(null);
      await reloadFuncs();
      pushToast(t`Function renamed to "${target}".`);
    } catch (e) {
      pushToast((e as Error).message);
    } finally {
      setRenameBusy(false);
    }
  };

  // First whole-page fetch — functions haven't landed yet.
  if (!loaded) return <FunctionsSkeleton />;

  return (
    <div className="flex flex-col gap-4.5">
      <PageHeader
        title={t`Functions`}
        description={t`Sandboxed JS — HTTP, event-trigger, or cron. Provider auto-selected per runtime.`}
        actions={<Button variant="primary" icon={I.Plus} onClick={() => setNewOpen(true)}><Trans>New function</Trans></Button>}
      />

      <div className="grid grid-cols-[300px_minmax(0,1fr)] items-start gap-3.5 max-[900px]:grid-cols-[minmax(0,1fr)]">
        <div className="overflow-hidden rounded-2xl border border-border bg-card text-card-foreground">
          {funcs.length === 0 && (
            <EmptyState size="sm" title={<Trans>No functions yet — click + New function.</Trans>} />
          )}
          {funcs.map((f) => (
            <div
              key={f.name}
              onClick={() => setActive(f)}
              className={`grid cursor-pointer grid-cols-[24px_1fr_70px] items-center gap-3 border-b border-border px-3.5 py-[11px] text-[13px] last:border-b-0 ${active?.name === f.name ? "bg-accent" : ""}`}
            >
              <span><I.Function size={14} /></span>
              <div className="flex min-w-0 flex-col">
                <span className="font-mono text-[12.5px] font-medium">{f.name}</span>
                <span className="font-mono text-[11px] text-muted-foreground">{f.trigger}</span>
              </div>
              <Badge variant="outline">{f.kind}</Badge>
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-3">
          {!active ? (
            <EmptyState
              size="md"
              icon={I.Function}
              title={<Trans>No function selected</Trans>}
              description={<Trans>Click <strong>+ New function</strong> to create one.</Trans>}
            />
          ) : (
          <>
          {renameDraft !== null ? (
            <div className="flex flex-wrap items-center gap-2">
              <I.Pencil size={16} />
              <Input
                className="font-mono w-[260px] text-sm"
                aria-invalid={!!renameError}
                autoFocus
                value={renameDraft}
                onChange={(e) => setRenameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !renameError && !renameBusy) void renameFunction(active.name, renameDraft);
                  else if (e.key === "Escape" && !renameBusy) setRenameDraft(null);
                }}
              />
              <Button variant="primary" size="sm" icon={I.Check} disabled={!!renameError || renameBusy || renameDraft.trim() === active.name} onClick={() => void renameFunction(active.name, renameDraft)}>{renameBusy ? <Trans>Renaming…</Trans> : <Trans>Rename</Trans>}</Button>
              <Button variant="ghost" size="sm" icon={I.X} onClick={() => setRenameDraft(null)} disabled={renameBusy}><Trans>Cancel</Trans></Button>
              {renameError && <span className="flex items-center gap-1 text-[11.5px] text-destructive"><I.AlertTriangle size={11} />{renameError}</span>}
            </div>
          ) : (
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-lg font-semibold">{active.name}</span>
            <IconButton icon={I.Pencil} title={t`Rename function`} onClick={() => setRenameDraft(active.name)} />
            <Badge variant="outline">{active.kind}</Badge>
            <span className="font-mono text-xs text-muted-foreground">· {active.trigger}</span>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">{Number(active.invocations ?? 0).toLocaleString()} <Trans>invocations · p95</Trans> {active.p95 ?? 0}ms</span>
              <Button variant="outline" size="sm" icon={I.Trash} onClick={() => active && setConfirmDelete(active.name)} className="text-destructive"><Trans>Delete</Trans></Button>
              <Button variant="outline" size="sm" icon={I.Save} onClick={saveCode}><Trans>Save</Trans></Button>
              <Button variant="primary" size="sm" icon={I.Zap} onClick={run} disabled={running}>{running ? <Trans>Running…</Trans> : <Trans>Run</Trans>}</Button>
            </div>
          </div>
          )}

          <Textarea
            value={code}
            onChange={(e) => setCode(e.target.value)}
            spellCheck={false}
            className="min-h-[200px] w-full resize-y whitespace-pre-wrap rounded-xl border-0 bg-[oklch(from_var(--primary)_0.18_0.01_h)] p-3.5 font-mono text-xs leading-[1.55] text-[oklch(from_var(--primary)_0.95_0.02_h)] [word-break:break-word]"
          />

          <div className="overflow-hidden rounded-2xl border border-border bg-card text-card-foreground">
            <div className="flex items-center gap-2 border-b border-border px-4 py-3.5">
              <I.Code size={14} /><span className="text-[13px] font-medium"><Trans>Logs</Trans></span>
              <span className="font-mono text-[11.5px] text-muted-foreground"><Trans>last invocation</Trans></span>
              <div className="flex-1" />
              <Button variant="ghost" size="sm" onClick={() => setLogs([])}><Trans>Clear</Trans></Button>
            </div>
            <ScrollArea className="bg-[oklch(0.18_0.01_130)]" viewportClassName="max-h-[260px] min-h-[130px]">
            <div className="p-3 font-mono text-xs text-[oklch(0.92_0.02_130)]">
              {logs.length === 0 && <div className="text-[oklch(0.6_0.02_130)]"><Trans>No logs yet — click Run.</Trans></div>}
              {logs.map((l, i) => (
                <div key={i}>
                  <span className="text-[oklch(0.6_0.02_130)]">{l.t}</span>{" "}
                  <span className={l.lvl === "error" ? "text-[oklch(0.7_0.18_22)]" : "text-[oklch(0.78_0.18_95)]"}>{l.lvl.toUpperCase().padEnd(5, " ")}</span>{" "}
                  {l.msg}
                </div>
              ))}
            </div>
            </ScrollArea>
          </div>
          </>
          )}
        </div>
      </div>

      {newOpen && (
        <NewFunctionDialog
          existing={funcs.map((f) => f.name)}
          onClose={() => setNewOpen(false)}
          onCreated={async (created) => {
            const all = await reloadFuncs();
            const fresh = all.find((f) => f.name === created.name);
            if (fresh) {
              setActive({
                name: fresh.name,
                kind: fresh.trigger,
                trigger: fresh.pattern ?? fresh.trigger,
                lang: "js",
                invocations: 0,
                p95: 0,
              });
            }
            setNewOpen(false);
            pushToast(t`Function "${created.name}" created.`);
          }}
          onError={(msg) => pushToast(msg)}
        />
      )}

      <ConfirmDialog
        open={!!confirmDelete}
        title={confirmDelete ? <><Trans>Delete function</Trans> <span className="font-mono">{confirmDelete}</span>?</> : <Trans>Delete function?</Trans>}
        description={t`This permanently removes the function and its code. Triggers, flow steps, or callers that reference it will stop working. This can't be undone.`}
        actionLabel={t`Delete function`}
        destructive
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => {
          const name = confirmDelete;
          setConfirmDelete(null);
          if (name) void removeFunction(name);
        }}
      />
    </div>
  );
}

const SAMPLE_HTTP = `// ctx.data is the request body, ctx.user has the caller
console.log("invoked by", ctx.user.email);
return { greeting: "hello " + (ctx.data.name || "world") };`;

const SAMPLE_EVENT = `// For event triggers, ctx.data = { event, data }
console.log("event", ctx.data.event, "on", ctx.data.data.id);`;

const SAMPLE_CRON = `// For cron, ctx.data = { firedAt, pattern }
console.log("cron tick at", ctx.data.firedAt);`;

function NewFunctionDialog({
  existing,
  onClose,
  onCreated,
  onError,
}: {
  existing: string[];
  onClose: () => void;
  onCreated: (created: { name: string; trigger: string; pattern: string | null }) => void;
  onError: (msg: string) => void;
}) {
  const { t } = useLingui();
  type Trigger = "http" | "event" | "cron";
  const [name, setName] = useState("");
  const [trigger, setTrigger] = useState<Trigger>("http");
  const [pattern, setPattern] = useState("");
  const [code, setCode] = useState(SAMPLE_HTTP);
  const [timeoutMs, setTimeoutMs] = useState(5000);
  const [active, setActiveFlag] = useState(true);
  const [busy, setBusy] = useState(false);

  const sampleFor = (t: Trigger): string =>
    t === "http" ? SAMPLE_HTTP : t === "event" ? SAMPLE_EVENT : SAMPLE_CRON;

  const onTriggerChange = (next: string) => {
    const trig = next as Trigger;
    setTrigger(trig);
    setCode(sampleFor(trig));
    if (trig === "cron") setPattern("*/5 * * * *");
    else if (trig === "event") setPattern("items:*:*");
    else setPattern("");
  };

  const nameRegex = /^[a-z][a-z0-9_-]*$/;
  const nameError = name.length === 0
    ? t`Required.`
    : !nameRegex.test(name)
      ? t`Lowercase letters, digits, _ or -; must start with a letter.`
      : existing.includes(name)
        ? t`A function with that name already exists.`
        : null;
  const patternRequired = trigger !== "http";
  const patternError = patternRequired && !pattern.trim() ? t`Required.` : null;
  const codeError = code.trim().length === 0 ? t`Required.` : null;
  const timeoutError =
    !Number.isFinite(timeoutMs) || timeoutMs < 50 || timeoutMs > 60_000
      ? t`Must be between 50 and 60000.`
      : null;
  const valid = !nameError && !patternError && !codeError && !timeoutError;

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    try {
      await api("/api/functions", {
        method: "POST",
        body: JSON.stringify({
          name,
          trigger,
          pattern: trigger === "http" ? null : pattern,
          code,
          timeoutMs,
          active,
        }),
      });
      onCreated({ name, trigger, pattern: trigger === "http" ? null : pattern });
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="flex max-h-[90vh] w-[640px] max-w-[94vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-none">
        <DialogHeader className="border-b border-border px-5 pb-3.5 pr-12 pt-[18px] text-left">
          <DialogTitle className="text-base font-semibold tracking-[-0.01em]"><Trans>New function</Trans></DialogTitle>
          <DialogDescription className="mt-0.5 text-[12.5px]"><Trans>Sandboxed JS. HTTP for manual invoke, event for pub-sub triggers, or cron for scheduled runs.</Trans></DialogDescription>
        </DialogHeader>

        <ScrollArea viewportClassName="max-h-[calc(90vh-10rem)]">
        <div className="flex flex-col gap-4 px-5 py-[18px]">
          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Name</Trans> <span className="text-destructive">*</span></label>
            <Input
              className="font-mono"
              aria-invalid={!!(nameError && name)}
              autoFocus
              placeholder="my_function"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            {nameError && name ? (
              <div className="flex items-center gap-1 text-[11.5px] text-destructive"><I.AlertTriangle size={11} />{nameError}</div>
            ) : (
              <span className="text-[11.5px] text-muted-foreground"><Trans>Lowercase, digits, <span className="font-mono">_</span> or <span className="font-mono">-</span>. You can rename it later.</Trans></span>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3 max-[640px]:grid-cols-1">
            <div className="flex flex-col gap-1.5">
              <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Trigger</Trans></label>
              <Select
                value={trigger}
                onChange={onTriggerChange}
                options={[
                  { value: "http", label: "http", hint: t`manual invoke via POST /api/functions/:name/invoke` },
                  { value: "event", label: "event", hint: t`fires on matching pub-sub channel events` },
                  { value: "cron", label: "cron", hint: t`scheduled — granularity is 1 minute` },
                ]}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Timeout (ms)</Trans></label>
              <Input
                aria-invalid={!!timeoutError}
                type="number"
                min={50}
                max={60000}
                value={timeoutMs}
                onChange={(e) => setTimeoutMs(Number(e.target.value))}
              />
              {timeoutError && <div className="flex items-center gap-1 text-[11.5px] text-destructive"><I.AlertTriangle size={11} />{timeoutError}</div>}
            </div>
          </div>

          {trigger !== "http" && (
            <div className="flex flex-col gap-1.5">
              <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">{trigger === "cron" ? <Trans>Cron expression</Trans> : <Trans>Event pattern</Trans>} <span className="text-destructive">*</span></label>
              <Input
                className="font-mono"
                aria-invalid={!!patternError}
                value={pattern}
                onChange={(e) => setPattern(e.target.value)}
                placeholder={trigger === "cron" ? "*/5 * * * *" : "items:posts:*"}
              />
              {patternError ? (
                <div className="flex items-center gap-1 text-[11.5px] text-destructive"><I.AlertTriangle size={11} />{patternError}</div>
              ) : (
                <span className="text-[11.5px] text-muted-foreground">
                  {trigger === "cron"
                    ? <Trans>5-field cron (minute hour day month weekday).</Trans>
                    : <Trans>Examples: items:posts:created, items:posts:*, items:*:*</Trans>}
                </span>
              )}
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Code</Trans> <span className="text-destructive">*</span></label>
            <Textarea
              className="font-mono min-h-[200px] text-xs whitespace-pre"
              aria-invalid={!!codeError}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              spellCheck={false}
            />
            <span className="text-[11.5px] text-muted-foreground">
              <Trans>Globals: <span className="font-mono">ctx.data</span>, <span className="font-mono">ctx.user</span>, <span className="font-mono">console.log</span>. Sync-only in v1; runs in QuickJS-WASM sandbox.</Trans>
            </span>
          </div>

          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-[12.5px] font-medium"><Trans>Active</Trans></div>
              <div className="text-[11.5px] text-muted-foreground"><Trans>When paused, triggers stop firing and HTTP invokes are rejected.</Trans></div>
            </div>
            <Switch checked={active} onChange={setActiveFlag} />
          </div>
        </div>
        </ScrollArea>

        <DialogFooter className="border-t border-border bg-card px-5 py-3 sm:justify-end">
          <div className="flex-1" />
          <Button variant="ghost" onClick={onClose} disabled={busy}><Trans>Cancel</Trans></Button>
          <Button variant="primary" onClick={submit} disabled={!valid || busy}>
            {busy ? <Trans>Creating…</Trans> : <Trans>Create function</Trans>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
