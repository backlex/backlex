// Functions page — sandboxed JS editor + invocation logs + new-function wizard
import { useEffect, useState } from "react";
import { I } from "../icons";
import { Badge, Button, IconButton, PageHeader, Switch } from "../ui";
import { Select } from "../select";
import { ConfirmDialog } from "../sheet";
import { api } from "@/lib/api";
import { Input } from "@workeros/ui/components/input";
import { Textarea } from "@workeros/ui/components/textarea";
import { fetchSafely } from "./_shared";

export function FunctionsPage({ pushToast }: { pushToast: (m: string) => void }) {
  type FnRow = { name: string; kind: string; trigger: string; lang: string; invocations: number; p95: number };
  const [funcs, setFuncs] = useState<FnRow[]>([]);
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
  useEffect(() => { void reloadFuncs(); }, []);
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
      ? "Required."
      : !nameRegex.test(renameDraft.trim())
        ? "Lowercase letters, digits, _ or -; must start with a letter."
        : renameDraft.trim() !== active?.name && funcs.some((f) => f.name === renameDraft.trim())
          ? "A function with that name already exists."
          : null;

  const run = async () => {
    if (!active) { pushToast("Select a function to run."); return; }
    setRunning(true);
    setLogs([{ t: new Date().toISOString().slice(11, 19), lvl: "info", msg: `invoking ${active.name}…` }]);
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
        ? { t: ts, lvl: "info", msg: `done · ${r.durationMs ?? "—"}ms · result: ${JSON.stringify(r.value ?? null).slice(0, 200)}` }
        : { t: ts, lvl: "error", msg: r.error ?? "function failed" };
      setLogs((arr) => [...arr, ...logLines, summary]);
      if (r.ok) pushToast("Function ran successfully.");
      else pushToast(r.error ?? "Function failed");
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
    if (!active) { pushToast("Select a function to save."); return; }
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
      pushToast("Function saved.");
    } catch (e) {
      pushToast((e as Error).message);
    }
  };
  const removeFunction = async (name: string) => {
    try {
      const r = await api<{ data: { id: string; name: string }[] }>("/api/functions");
      const match = r.data.find((f) => f.name === name);
      if (!match) {
        pushToast("Function not found on server.");
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
      pushToast(`Function "${name}" deleted.`);
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
        pushToast("Function not found on server.");
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
      pushToast(`Function renamed to "${target}".`);
    } catch (e) {
      pushToast((e as Error).message);
    } finally {
      setRenameBusy(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <PageHeader
        title="Functions"
        description="Sandboxed JS — HTTP, event-trigger, or cron. Provider auto-selected per runtime."
        actions={<Button variant="primary" icon={I.Plus} onClick={() => setNewOpen(true)}>New function</Button>}
      />

      <div className="master-detail" style={{ "--md-aside": "300px" } as React.CSSProperties}>
        <div className="card">
          {funcs.length === 0 && (
            <div className="muted" style={{ padding: "16px 12px", fontSize: 12 }}>No functions yet — click + New function.</div>
          )}
          {funcs.map((f) => (
            <div key={f.name} onClick={() => setActive(f)} className="schema-row" style={{ gridTemplateColumns: "24px 1fr 70px", cursor: "pointer", background: active?.name === f.name ? "var(--accent)" : "transparent" }}>
              <span><I.Function size={14} /></span>
              <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                <span className="font-mono" style={{ fontSize: 12.5, fontWeight: 500 }}>{f.name}</span>
                <span className="font-mono muted" style={{ fontSize: 11 }}>{f.trigger}</span>
              </div>
              <Badge variant="outline">{f.kind}</Badge>
            </div>
          ))}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {!active ? (
            <div className="card" style={{ padding: 36, textAlign: "center", color: "var(--muted-foreground)", fontSize: 13 }}>
              No function selected. Click <strong>+ New function</strong> to create one.
            </div>
          ) : (
          <>
          {renameDraft !== null ? (
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <I.Pencil size={16} />
              <Input
                className="font-mono"
                aria-invalid={!!renameError}
                style={{ fontSize: 14, width: 260 }}
                autoFocus
                value={renameDraft}
                onChange={(e) => setRenameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !renameError && !renameBusy) void renameFunction(active.name, renameDraft);
                  else if (e.key === "Escape" && !renameBusy) setRenameDraft(null);
                }}
              />
              <Button variant="primary" size="sm" icon={I.Check} disabled={!!renameError || renameBusy || renameDraft.trim() === active.name} onClick={() => void renameFunction(active.name, renameDraft)}>{renameBusy ? "Renaming…" : "Rename"}</Button>
              <Button variant="ghost" size="sm" icon={I.X} onClick={() => setRenameDraft(null)} disabled={renameBusy}>Cancel</Button>
              {renameError && <span className="field-error"><I.AlertTriangle size={11} />{renameError}</span>}
            </div>
          ) : (
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span className="font-mono" style={{ fontSize: 18, fontWeight: 600 }}>{active.name}</span>
            <IconButton icon={I.Pencil} title="Rename function" onClick={() => setRenameDraft(active.name)} />
            <Badge variant="outline">{active.kind}</Badge>
            <span className="font-mono muted" style={{ fontSize: 12 }}>· {active.trigger}</span>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginLeft: "auto" }}>
              <span className="muted" style={{ fontSize: 12 }}>{Number(active.invocations ?? 0).toLocaleString()} invocations · p95 {active.p95 ?? 0}ms</span>
              <Button variant="outline" size="sm" icon={I.Trash} onClick={() => active && setConfirmDelete(active.name)} style={{ color: "var(--destructive)" }}>Delete</Button>
              <Button variant="outline" size="sm" icon={I.Save} onClick={saveCode}>Save</Button>
              <Button variant="primary" size="sm" icon={I.Zap} onClick={run} disabled={running}>{running ? "Running…" : "Run"}</Button>
            </div>
          </div>
          )}

          <textarea
            value={code}
            onChange={(e) => setCode(e.target.value)}
            spellCheck={false}
            className="alter-preview"
            style={{ minHeight: 200, fontSize: 12, width: "100%", border: "none", resize: "vertical", fontFamily: "Geist Mono, monospace", whiteSpace: "pre-wrap" }}
          />

          <div className="card" style={{ overflow: "hidden" }}>
            <div className="card-section" style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <I.Code size={14} /><span style={{ fontSize: 13, fontWeight: 500 }}>Logs</span>
              <span className="muted font-mono" style={{ fontSize: 11.5 }}>last invocation</span>
              <div className="spacer" />
              <Button variant="ghost" size="sm" onClick={() => setLogs([])}>Clear</Button>
            </div>
            <div style={{ background: "oklch(0.18 0.01 130)", color: "oklch(0.92 0.02 130)", fontFamily: "Geist Mono, monospace", fontSize: 12, padding: 12, minHeight: 130, maxHeight: 260, overflow: "auto" }}>
              {logs.length === 0 && <div style={{ color: "oklch(0.6 0.02 130)" }}>No logs yet — click Run.</div>}
              {logs.map((l, i) => (
                <div key={i}>
                  <span style={{ color: "oklch(0.6 0.02 130)" }}>{l.t}</span>{" "}
                  <span style={{ color: l.lvl === "error" ? "oklch(0.7 0.18 22)" : "oklch(0.78 0.18 95)" }}>{l.lvl.toUpperCase().padEnd(5, " ")}</span>{" "}
                  {l.msg}
                </div>
              ))}
            </div>
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
            pushToast(`Function "${created.name}" created.`);
          }}
          onError={(msg) => pushToast(msg)}
        />
      )}

      <ConfirmDialog
        open={!!confirmDelete}
        title={confirmDelete ? <>Delete function <span className="font-mono">{confirmDelete}</span>?</> : "Delete function?"}
        description="This permanently removes the function and its code. Triggers, flow steps, or callers that reference it will stop working. This can't be undone."
        actionLabel="Delete function"
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
    const t = next as Trigger;
    setTrigger(t);
    setCode(sampleFor(t));
    if (t === "cron") setPattern("*/5 * * * *");
    else if (t === "event") setPattern("items:*:*");
    else setPattern("");
  };

  const nameRegex = /^[a-z][a-z0-9_-]*$/;
  const nameError = name.length === 0
    ? "Required."
    : !nameRegex.test(name)
      ? "Lowercase letters, digits, _ or -; must start with a letter."
      : existing.includes(name)
        ? "A function with that name already exists."
        : null;
  const patternRequired = trigger !== "http";
  const patternError = patternRequired && !pattern.trim() ? "Required." : null;
  const codeError = code.trim().length === 0 ? "Required." : null;
  const timeoutError =
    !Number.isFinite(timeoutMs) || timeoutMs < 50 || timeoutMs > 60_000
      ? "Must be between 50 and 60000."
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
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        className="dialog-lg"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        style={{ width: 640, maxWidth: "94vw", maxHeight: "90vh", display: "flex", flexDirection: "column" }}
      >
        <div className="sheet-header" style={{ borderBottom: "1px solid var(--border)" }}>
          <div style={{ flex: 1 }}>
            <h2>New function</h2>
            <p>Sandboxed JS. HTTP for manual invoke, event for pub-sub triggers, or cron for scheduled runs.</p>
          </div>
          <IconButton icon={I.X} onClick={onClose} title="Close" />
        </div>

        <div className="dialog-body" style={{ overflow: "auto" }}>
          <div className="field">
            <label className="field-label">Name <span style={{ color: "var(--destructive)" }}>*</span></label>
            <Input
              className="font-mono"
              aria-invalid={!!(nameError && name)}
              autoFocus
              placeholder="my_function"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            {nameError && name ? (
              <div className="field-error"><I.AlertTriangle size={11} />{nameError}</div>
            ) : (
              <span className="field-hint">Lowercase, digits, <span className="font-mono">_</span> or <span className="font-mono">-</span>. You can rename it later.</span>
            )}
          </div>

          <div className="cols-2">
            <div className="field">
              <label className="field-label">Trigger</label>
              <Select
                value={trigger}
                onChange={onTriggerChange}
                options={[
                  { value: "http", label: "http", hint: "manual invoke via POST /api/functions/:name/invoke" },
                  { value: "event", label: "event", hint: "fires on matching pub-sub channel events" },
                  { value: "cron", label: "cron", hint: "scheduled — granularity is 1 minute" },
                ]}
              />
            </div>
            <div className="field">
              <label className="field-label">Timeout (ms)</label>
              <Input
                aria-invalid={!!timeoutError}
                type="number"
                min={50}
                max={60000}
                value={timeoutMs}
                onChange={(e) => setTimeoutMs(Number(e.target.value))}
              />
              {timeoutError && <div className="field-error"><I.AlertTriangle size={11} />{timeoutError}</div>}
            </div>
          </div>

          {trigger !== "http" && (
            <div className="field">
              <label className="field-label">{trigger === "cron" ? "Cron expression" : "Event pattern"} <span style={{ color: "var(--destructive)" }}>*</span></label>
              <Input
                className="font-mono"
                aria-invalid={!!patternError}
                value={pattern}
                onChange={(e) => setPattern(e.target.value)}
                placeholder={trigger === "cron" ? "*/5 * * * *" : "items:posts:*"}
              />
              {patternError ? (
                <div className="field-error"><I.AlertTriangle size={11} />{patternError}</div>
              ) : (
                <span className="field-hint">
                  {trigger === "cron"
                    ? "5-field cron (minute hour day month weekday)."
                    : "Examples: items:posts:created, items:posts:*, items:*:*"}
                </span>
              )}
            </div>
          )}

          <div className="field">
            <label className="field-label">Code <span style={{ color: "var(--destructive)" }}>*</span></label>
            <Textarea
              className="font-mono"
              aria-invalid={!!codeError}
              style={{ minHeight: 200, fontSize: 12, whiteSpace: "pre" }}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              spellCheck={false}
            />
            <span className="field-hint">
              Globals: <span className="font-mono">ctx.data</span>, <span className="font-mono">ctx.user</span>, <span className="font-mono">console.log</span>. Sync-only in v1; runs in QuickJS-WASM sandbox.
            </span>
          </div>

          <div className="field-row">
            <div>
              <div style={{ fontSize: 12.5, fontWeight: 500 }}>Active</div>
              <div className="muted" style={{ fontSize: 11.5 }}>When paused, triggers stop firing and HTTP invokes are rejected.</div>
            </div>
            <Switch checked={active} onChange={setActiveFlag} />
          </div>
        </div>

        <div className="sheet-footer">
          <div className="spacer" />
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={!valid || busy}>
            {busy ? "Creating…" : "Create function"}
          </Button>
        </div>
      </div>
    </div>
  );
}
