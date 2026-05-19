// Flows page — trigger → operations list + preview canvas + builder modal
import { Fragment, useEffect, useState } from "react";
import { I, type IconComponent } from "../icons";
import { Badge, Button, PageHeader, Switch } from "../ui";
import { FlowBuilder } from "../flow-builder";
import { compileGraph, decompileGraph, FlowCompileError, type Graph } from "../flow-graph";
import { api } from "@/lib/api";
import { fetchSafely } from "./_shared";

export function FlowsPage({ pushToast, activeFlow, setActiveFlow }: { pushToast: (m: string) => void; activeFlow?: string | null; setActiveFlow?: (id: string | null) => void }) {
  // Flows load from /api/flows on mount. No mock seed — empty workspace
  // hits the empty-state render path on the right pane.
  type FlowRow = { id: string; name: string; trigger: string; actions: string[]; status: string; runs: number; operations: any[] };
  const [flows, setFlows] = useState<FlowRow[]>([]);
  useEffect(() => {
    void (async () => {
      const [r, m] = await Promise.all([
        fetchSafely<{ data: { id: string; name: string; trigger: string; active: boolean; operations: any[] }[] }>("/api/flows"),
        fetchSafely<{ data: { flows: Record<string, { runs: number; lastRun: number | null }> } }>(`/api/admin/metrics/entities`),
      ]);
      const stats = m?.data?.flows ?? {};
      if (Array.isArray(r?.data)) {
        setFlows(
          r.data.map((f) => ({
            id: f.id,
            name: f.name,
            trigger: f.trigger,
            actions: ["fn"],
            status: f.active ? "active" : "paused",
            runs: stats[f.id]?.runs ?? 0,
            operations: Array.isArray(f.operations) ? f.operations : [],
          })),
        );
      }
    })();
  }, []);
  // The selected flow id is URL-driven (`/flows/:id`). Parent passes activeFlow
  // + setActiveFlow; we expose a thin local wrapper so the rest of the file
  // keeps the existing `active` / `setActive` API. When the URL points at a
  // flow that doesn't exist (deleted, stale link), we just render the empty
  // state — we never silently rewrite the URL.
  const active = activeFlow ?? "";
  const setActive = (id: string) => {
    setActiveFlow?.(id || null);
  };
  useEffect(() => {
    if (active || flows.length === 0) return;
    const first = flows[0];
    if (first) setActiveFlow?.(first.id);
  }, [flows, active, setActiveFlow]);
  const [builderOpen, setBuilderOpen] = useState(false);
  const [editingFlow, setEditingFlow] = useState<any>(null);
  const flow = flows.find((f) => f.id === active);

  // Edit path fetches the full row so we can rehydrate the builder graph
  // from the persisted layout (or fall back to op-only synthesis).
  const openBuilder = async (f: any) => {
    try {
      const res = await api<{ data: { id: string; name: string; trigger: string; operations: any[]; layout: Graph | null; active: boolean } }>(`/api/flows/${f.id}`);
      const row = res.data;
      const graph = decompileGraph({
        trigger: row.trigger,
        operations: row.operations ?? [],
        layout: row.layout ?? null,
      });
      setEditingFlow({
        id: row.id,
        name: row.name,
        enabled: row.active,
        nodes: graph.nodes,
        edges: graph.edges,
      });
      setBuilderOpen(true);
    } catch (e) {
      pushToast((e as Error).message);
    }
  };
  const newFlow = () => { setEditingFlow(null); setBuilderOpen(true); };
  const saveFromBuilder = async (data: any) => {
    try {
      const compiled = compileGraph({ nodes: data.nodes ?? [], edges: data.edges ?? [] });
      compiled.warnings.forEach((w) => pushToast(`⚠ ${w}`));
      const payload = {
        name: data.name,
        trigger: compiled.trigger,
        operations: compiled.operations,
        layout: compiled.layout,
        active: data.enabled,
      };
      if (data.id) {
        await api(`/api/flows/${data.id}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        });
        setFlows((arr) =>
          arr.map((f) =>
            f.id === data.id
              ? { ...f, name: data.name, trigger: compiled.trigger, status: data.enabled ? "active" : "paused", operations: compiled.operations }
              : f,
          ),
        );
      } else {
        const res = await api<{ data: { id: string } }>(`/api/flows`, {
          method: "POST",
          body: JSON.stringify(payload),
        });
        const id = res.data.id;
        setFlows((arr) => [
          { id, name: data.name, trigger: compiled.trigger, actions: [], status: data.enabled ? "active" : "paused", runs: 0, operations: compiled.operations },
          ...arr,
        ]);
        setActive(id);
      }
      setBuilderOpen(false);
    } catch (e) {
      // Compile errors stay in the builder so the user can fix without losing
      // the canvas; only show a toast and DON'T close the modal.
      pushToast(e instanceof FlowCompileError ? `Cannot save: ${e.message}` : (e as Error).message);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <PageHeader
        title="Flows"
        description="Triggers fire on collection events, schedules, or webhooks. Each step runs in the sandbox."
        actions={<Button variant="primary" icon={I.Plus} onClick={newFlow}>New flow</Button>}
      />

      <div className="master-detail" style={{ "--md-aside": "320px" } as React.CSSProperties}>
        <div className="card">
          {flows.map((f) => (
            <div key={f.id} onClick={() => setActive(f.id)} className="schema-row" style={{ gridTemplateColumns: "24px 1fr 60px", cursor: "pointer", background: active === f.id ? "var(--accent)" : "transparent" }}>
              <span><I.Bolt size={14} /></span>
              <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                <span style={{ fontSize: 13, fontWeight: 500 }}>{f.name}</span>
                <span className="font-mono muted" style={{ fontSize: 11 }}>{f.trigger}</span>
              </div>
              <Badge variant={f.status === "active" ? "default" : "secondary"}>{f.status}</Badge>
            </div>
          ))}
        </div>

        <div className="card" style={{ padding: 22, display: "flex", flexDirection: "column", gap: 18 }}>
          {!flow ? (
            <div style={{ padding: 36, textAlign: "center", color: "var(--muted-foreground)", fontSize: 13 }}>
              No flow selected. Click <strong>+ New flow</strong> to create your first one.
            </div>
          ) : (
          <>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span style={{ fontSize: 16, fontWeight: 600 }}>{flow.name}</span>
            <Badge variant={flow.status === "active" ? "default" : "secondary"}>{flow.status}</Badge>
            <span className="muted tabular-nums" style={{ fontSize: 12 }}>· {Number(flow.runs ?? 0).toLocaleString()} runs</span>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginLeft: "auto" }}>
              <Switch checked={flow.status === "active"} onChange={async (next) => {
                setFlows((arr) => arr.map((f) => f.id === flow.id ? { ...f, status: next ? "active" : "paused" } : f));
                try {
                  await api(`/api/flows/${flow.id}`, { method: "PATCH", body: JSON.stringify({ active: next }) });
                  pushToast(next ? "Flow resumed." : "Flow paused.");
                } catch (e) {
                  pushToast((e as Error).message);
                }
              }} />
              <Button variant="outline" size="sm" icon={I.Zap} onClick={async () => {
                try {
                  await api(`/api/flows/${flow.id}/run`, { method: "POST", body: JSON.stringify({}) });
                  pushToast("Test run dispatched.");
                } catch (e) {
                  pushToast((e as Error).message);
                }
              }}>Run now</Button>
              <Button variant="primary" size="sm" icon={I.Pencil} onClick={() => openBuilder(flow)}>Edit flow</Button>
            </div>
          </div>

          <FlowPreview trigger={flow.trigger} operations={flow.operations} onEdit={() => openBuilder(flow)} />

          <div className="cols-3">
            <FlowStatCard flowId={flow.id} flowRuns={flow.runs} />
          </div>
          </>
          )}
        </div>
      </div>

      {builderOpen && <FlowBuilder initial={editingFlow} onClose={() => setBuilderOpen(false)} onSave={saveFromBuilder} pushToast={pushToast} />}
    </div>
  );
}

/**
 * One-line summary of a single op for the small list-page preview. Distinct
 * from the full FlowGraph component (used elsewhere) — this is intentionally
 * truncated and read-only.
 */
function describeOpShort(op: any): string {
  if (!op || typeof op !== "object") return String(op);
  const t = op.type as string;
  switch (t) {
    case "log": return op.message?.toString().slice(0, 28) ?? "log";
    case "webhook":
    case "request": return `${op.method ?? (t === "webhook" ? "POST" : "GET")} ${(op.url ?? "").toString().slice(0, 22)}`;
    case "email": return `to ${(op.to ?? "").toString().slice(0, 22)}`;
    case "transform": return "shape";
    case "run-script": return ((op.code ?? "").toString().split("\n")[0] ?? "").slice(0, 22) || "script";
    case "condition": {
      try { return Object.keys(op.filter ?? {})[0] ?? "if"; } catch { return "if"; }
    }
    case "notification": return (op.title ?? "").toString().slice(0, 22) || "notify";
    case "function": return `fn:${(op.name ?? "").toString().slice(0, 18)}`;
    case "item.create": return `+${op.collection ?? ""}`;
    case "item.update": return `~${op.collection ?? ""}`;
    case "delay": return `wait ${op.durationMs}ms`;
    default: return t ?? "step";
  }
}

function FlowPreview({ trigger, operations, onEdit }: { trigger: string; operations: any[]; onEdit: () => void }) {
  const opKind = (op: any) => (op?.type === "condition" ? "condition" : "action");
  const visible = operations.slice(0, 3);
  const overflow = Math.max(0, operations.length - visible.length);
  const X0 = 20, Y = 80, NODE_W = 176, GAP = 104;
  return (
    <div
      style={{
        position: "relative",
        height: 220,
        background: "color-mix(in oklch, var(--muted) 40%, transparent)",
        borderRadius: "var(--radius-2xl)",
        border: "1px solid var(--border)",
        overflow: "auto",
        backgroundImage: "radial-gradient(circle, var(--border) 1px, transparent 1px)",
        backgroundSize: "14px 14px",
        cursor: "pointer",
      }}
      onClick={onEdit}
    >
      <FlowNode x={X0} y={Y} kind="trigger" title="trigger" sub={trigger || "—"} />
      {visible.map((op, i) => {
        const prevX = X0 + i * (NODE_W + GAP);
        const x = prevX + NODE_W + GAP;
        return (
          <Fragment key={i}>
            <FlowConnector x1={prevX + NODE_W} y1={Y + 28} x2={x} y2={Y + 28} />
            <FlowNode x={x} y={Y} kind={opKind(op)} title={op?.type ?? "step"} sub={describeOpShort(op)} />
          </Fragment>
        );
      })}
      {overflow > 0 && (
        <div
          style={{
            position: "absolute",
            top: Y + 14,
            left: X0 + visible.length * (NODE_W + GAP) + NODE_W + GAP + 12,
            padding: "4px 10px",
            border: "1px dashed var(--border)",
            borderRadius: "var(--radius-3xl)",
            fontSize: 11,
            color: "var(--muted-foreground)",
          }}
        >
          +{overflow} more
        </div>
      )}
      {operations.length === 0 && (
        <div style={{ position: "absolute", left: X0 + NODE_W + 24, top: Y + 12, fontSize: 12, color: "var(--muted-foreground)" }}>
          No actions yet — click to add steps.
        </div>
      )}
      <div
        style={{
          position: "absolute",
          top: 12,
          right: 14,
          padding: "6px 12px",
          background: "var(--card)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-3xl)",
          fontSize: 11.5,
          color: "var(--muted-foreground)",
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        <I.Pencil size={11} /> Click to edit
      </div>
    </div>
  );
}

/**
 * Per-flow KPI strip — replaces the hardcoded "14:21 · 184ms / 99.3% / 2"
 * placeholder. Fetches the activity rows for this specific flow id and
 * derives last-run timestamp + duration, success rate (rows without
 * action='error' / payload.error), and last-24h failure count.
 */
function FlowStatCard({ flowId, flowRuns }: { flowId: string; flowRuns: number }) {
  const [stats, setStats] = useState<{ lastRun: string; success: string; failures24h: number }>({
    lastRun: "—", success: "—", failures24h: 0,
  });
  useEffect(() => {
    if (!flowId) return;
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch(`/api/activity?collection=system_flows&itemId=${encodeURIComponent(flowId)}&limit=200`, { credentials: "include" });
        if (!r.ok || cancelled) return;
        const j = (await r.json()) as { data?: any[] };
        // `recordActivity` namespaces the stored action — flow runs land as
        // `flow.run` (not bare `run`). Failed runs carry `payload.error`.
        const rows = (j.data ?? []).filter((a) => a.action === "flow.run" || a.action === "run");
        const last = rows[0];
        const lastRunText = last
          ? `${new Date(last.createdAt ?? last.created_at).toISOString().slice(11, 16)} · ${last.durationMs ?? last.duration_ms ?? 0}ms`
          : "—";
        const errs = rows.filter((a) => {
          const p = a.payload;
          return !!(p && typeof p === "object" && (p as any).error);
        });
        const successPct = rows.length === 0 ? "—" : `${Math.round(((rows.length - errs.length) / rows.length) * 100)}%`;
        const cutoff = Date.now() - 86_400_000;
        const failures24h = errs.filter((a) => new Date(a.createdAt ?? a.created_at).getTime() >= cutoff).length;
        if (!cancelled) setStats({ lastRun: lastRunText, success: successPct, failures24h });
      } catch {
        // leave default
      }
    })();
    return () => { cancelled = true; };
  }, [flowId, flowRuns]);
  const tile = (k: string, v: string, ok: boolean) => (
    <div key={k} className="card" style={{ padding: 12, borderRadius: "var(--radius-xl)" }}>
      <div className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 }}>{k}</div>
      <div className="tabular-nums" style={{ fontSize: 18, fontWeight: 600, marginTop: 2, color: ok ? "var(--foreground)" : "var(--destructive)" }}>{v}</div>
    </div>
  );
  return (
    <>
      {tile("Last run", stats.lastRun, true)}
      {tile("Success rate", stats.success, stats.failures24h === 0)}
      {tile("Failures (24h)", String(stats.failures24h), stats.failures24h === 0)}
    </>
  );
}

function FlowNode({ x, y, kind, title, sub }: { x: number; y: number; kind: string; title: string; sub: string }) {
  const colors: Record<string, { bg: string; bd: string; ic: IconComponent }> = {
    trigger: { bg: "color-mix(in oklch, var(--primary) 20%, var(--card))", bd: "color-mix(in oklch, var(--primary) 50%, var(--border))", ic: I.Zap },
    condition: { bg: "color-mix(in oklch, oklch(0.78 0.16 75) 18%, var(--card))", bd: "color-mix(in oklch, oklch(0.78 0.16 75) 50%, var(--border))", ic: I.Filter },
    action: { bg: "var(--card)", bd: "var(--border)", ic: I.Function },
  };
  const c = colors[kind] ?? colors.action!;
  const Icon = c.ic;
  return (
    <div style={{ position: "absolute", left: x, top: y, width: 176, padding: "10px 12px", background: c.bg, border: `1px solid ${c.bd}`, borderRadius: "var(--radius-xl)", display: "flex", flexDirection: "column", gap: 2, boxShadow: "0 1px 2px oklch(0 0 0 / 0.06)", overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600, color: "var(--muted-foreground)", minWidth: 0 }}>
        <Icon size={11} /><span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</span>
      </div>
      <div className="font-mono" title={sub} style={{ fontSize: 11.5, color: "var(--foreground)", wordBreak: "break-all", overflowWrap: "anywhere" }}>{sub}</div>
    </div>
  );
}

function FlowConnector({ x1, y1, x2, y2 }: { x1: number; y1: number; x2: number; y2: number }) {
  const left = Math.min(x1, x2), top = Math.min(y1, y2);
  const w = Math.abs(x2 - x1), h = Math.abs(y2 - y1) || 2;
  return (
    <svg style={{ position: "absolute", left, top, width: w, height: h, pointerEvents: "none", overflow: "visible" }}>
      <path d={`M 0 ${y1 - top} C ${w / 2} ${y1 - top} ${w / 2} ${y2 - top} ${w} ${y2 - top}`} fill="none" stroke="var(--border)" strokeWidth="1.5" />
      <circle cx={w} cy={y2 - top} r="3" fill="var(--muted-foreground)" />
    </svg>
  );
}
