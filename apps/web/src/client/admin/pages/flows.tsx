// Flows page — trigger → operations list + preview canvas + builder modal
import { Fragment, useCallback, useEffect, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { I, type IconComponent } from "../icons";
import { Badge, Button, EmptyState, PageHeader, Switch } from "../ui";
import { FlowBuilder } from "../flow-builder";
import { compileGraph, decompileGraph, FlowCompileError, type Graph } from "../flow-graph";
import { ScrollArea } from "@backlex/ui/components/scroll-area";
import { api } from "@/lib/api";
import { fetchSafely } from "./_shared";
import { FlowsSkeleton } from "../page-skeletons";

export function FlowsPage({ pushToast, activeFlow, setActiveFlow }: { pushToast: (m: string) => void; activeFlow?: string | null; setActiveFlow?: (id: string | null) => void }) {
  const { t } = useLingui();
  // Flows load from /api/flows on mount. No mock seed — empty workspace
  // hits the empty-state render path on the right pane.
  type FlowRow = { id: string; name: string; trigger: string; actions: string[]; status: string; runs: number; operations: any[] };
  const [flows, setFlows] = useState<FlowRow[]>([]);
  // First-load gate — drives the page skeleton until flows land.
  const [loaded, setLoaded] = useState(false);
  // Bumped after a manual "Run now" so the KPI card refetches immediately.
  const [refreshNonce, setRefreshNonce] = useState(0);
  // FlowStatCard reports the authoritative run count back up so the
  // header's `· N runs` label stays in sync with the KPI tiles. Stable
  // identity (useCallback []) — it goes into FlowStatCard's effect deps.
  const handleRunCount = useCallback((id: string, runs: number) => {
    setFlows((arr) => {
      const cur = arr.find((f) => f.id === id);
      if (!cur || cur.runs === runs) return arr; // no change → skip re-render
      return arr.map((f) => (f.id === id ? { ...f, runs } : f));
    });
  }, []);
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
      setLoaded(true);
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
      pushToast(e instanceof FlowCompileError ? t`Cannot save: ${e.message}` : (e as Error).message);
    }
  };

  // First whole-page fetch — flows haven't landed yet.
  if (!loaded) return <FlowsSkeleton />;

  return (
    <div className="flex flex-col gap-4.5">
      <PageHeader
        title={t`Flows`}
        description={t`Triggers fire on collection events, schedules, or webhooks. Each step runs in the sandbox.`}
        actions={<Button variant="primary" icon={I.Plus} onClick={newFlow}><Trans>New flow</Trans></Button>}
      />

      <div className="grid grid-cols-[320px_minmax(0,1fr)] items-start gap-3.5 max-[900px]:grid-cols-[minmax(0,1fr)]">
        <div className="overflow-hidden rounded-2xl border border-border bg-card text-card-foreground">
          {flows.length === 0 && (
            <EmptyState size="sm" title={<Trans>No flows yet — click + New flow.</Trans>} />
          )}
          {flows.map((f) => (
            <div
              key={f.id}
              onClick={() => setActive(f.id)}
              className={`grid cursor-pointer grid-cols-[24px_1fr_60px] items-center gap-3 border-b border-border px-3.5 py-[11px] text-[13px] last:border-b-0 ${active === f.id ? "bg-accent" : ""}`}
            >
              <span><I.Bolt size={14} /></span>
              <div className="flex min-w-0 flex-col">
                <span className="text-[13px] font-medium">{f.name}</span>
                <span className="font-mono text-[11px] text-muted-foreground">{f.trigger}</span>
              </div>
              <Badge variant={f.status === "active" ? "default" : "secondary"}>{f.status}</Badge>
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-4.5 overflow-hidden rounded-2xl border border-border bg-card p-[22px] text-card-foreground">
          {!flow ? (
            <EmptyState
              bare
              icon={I.Bolt}
              title={<Trans>No flow selected</Trans>}
              description={<Trans>Click <strong>+ New flow</strong> to create your first one.</Trans>}
            />
          ) : (
          <>
          <div className="flex flex-wrap items-center gap-2.5">
            <span className="text-base font-semibold">{flow.name}</span>
            <Badge variant={flow.status === "active" ? "default" : "secondary"}>{flow.status}</Badge>
            <span className="tabular-nums text-xs text-muted-foreground">· {Number(flow.runs ?? 0).toLocaleString()} <Trans>runs</Trans></span>
            <div className="ml-auto flex flex-wrap items-center gap-2.5">
              <Switch checked={flow.status === "active"} onChange={async (next) => {
                setFlows((arr) => arr.map((f) => f.id === flow.id ? { ...f, status: next ? "active" : "paused" } : f));
                try {
                  await api(`/api/flows/${flow.id}`, { method: "PATCH", body: JSON.stringify({ active: next }) });
                  pushToast(next ? t`Flow resumed.` : t`Flow paused.`);
                } catch (e) {
                  pushToast((e as Error).message);
                }
              }} />
              <Button variant="outline" size="sm" icon={I.Zap} onClick={async () => {
                try {
                  await api(`/api/flows/${flow.id}/run`, { method: "POST", body: JSON.stringify({}) });
                  pushToast(t`Test run dispatched.`);
                  // Manual run is synchronous server-side — the activity row
                  // exists by the time POST resolves, so refetch right away.
                  setRefreshNonce((n) => n + 1);
                } catch (e) {
                  pushToast((e as Error).message);
                }
              }}><Trans>Run now</Trans></Button>
              <Button variant="primary" size="sm" icon={I.Pencil} onClick={() => openBuilder(flow)}><Trans>Edit flow</Trans></Button>
            </div>
          </div>

          <FlowPreview trigger={flow.trigger} operations={flow.operations} onEdit={() => openBuilder(flow)} />

          <div className="grid grid-cols-3 gap-3 max-[640px]:grid-cols-1">
            <FlowStatCard flowId={flow.id} refreshNonce={refreshNonce} onRunCount={handleRunCount} />
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
  const { t } = useLingui();
  const opKind = (op: any) => (op?.type === "condition" ? "condition" : "action");
  const visible = operations.slice(0, 3);
  const overflow = Math.max(0, operations.length - visible.length);
  const X0 = 20, Y = 80, NODE_W = 176, GAP = 104;
  // Width of the absolutely-positioned node canvas so the ScrollArea knows how
  // far it can scroll horizontally. Last node's right edge, plus room for the
  // "+N more" pill when present, plus a trailing margin.
  const lastNodeRight = X0 + visible.length * (NODE_W + GAP) + NODE_W;
  const contentWidth = lastNodeRight + (overflow > 0 ? GAP + 12 + 90 : 24);
  return (
    <div
      style={{
        position: "relative",
        height: 220,
        background: "color-mix(in oklch, var(--muted) 40%, transparent)",
        borderRadius: "var(--radius-2xl)",
        border: "1px solid var(--border)",
        overflow: "hidden",
        backgroundImage: "radial-gradient(circle, var(--border) 1px, transparent 1px)",
        backgroundSize: "14px 14px",
        cursor: "pointer",
      }}
      onClick={onEdit}
    >
      <ScrollArea className="size-full" viewportClassName="rounded-2xl">
        <div style={{ position: "relative", height: 220, minWidth: contentWidth }}>
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
              +{overflow} <Trans>more</Trans>
            </div>
          )}
          {operations.length === 0 && (
            <div style={{ position: "absolute", left: X0 + NODE_W + 24, top: Y + 12, fontSize: 12, color: "var(--muted-foreground)" }}>
              <Trans>No actions yet — click to add steps.</Trans>
            </div>
          )}
        </div>
      </ScrollArea>
      {/* Pinned to the visible top-right corner so it stays put while the canvas scrolls. */}
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
        <I.Pencil size={11} /> <Trans>Click to edit</Trans>
      </div>
    </div>
  );
}

/**
 * Per-flow KPI strip — fetches the activity rows for this specific flow id
 * and derives last-run timestamp + duration, success rate (rows without
 * action='error' / payload.error), and last-24h failure count. Refetches
 * on `refreshNonce` (bumped after a manual run) and polls every 15s so
 * background event-triggered runs surface without a page reload.
 */
function FlowStatCard({
  flowId,
  refreshNonce,
  onRunCount,
}: {
  flowId: string;
  refreshNonce: number;
  onRunCount?: (flowId: string, runs: number) => void;
}) {
  const { t } = useLingui();
  const [stats, setStats] = useState<{ lastRun: string; success: string; failures24h: number }>({
    lastRun: "—", success: "—", failures24h: 0,
  });
  useEffect(() => {
    if (!flowId) return;
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetch(`/api/activity?collection=system_flows&itemId=${encodeURIComponent(flowId)}&limit=200`, { credentials: "include" });
        if (!r.ok || cancelled) return;
        const j = (await r.json()) as { data?: any[] };
        // `recordActivity` namespaces the stored action — flow runs land as
        // `flow.run` (not bare `run`). Failed runs carry `payload.error`.
        const rows = (j.data ?? []).filter((a) => a.action === "flow.run" || a.action === "run");
        const last = rows[0];
        const lastDate = last ? new Date(last.createdAt ?? last.created_at) : null;
        // durationMs: null/undefined → not recorded (—); 0 → genuine
        // sub-millisecond run (<1ms), not missing data.
        const rawDur = last ? (last.durationMs ?? last.duration_ms) : null;
        const durText = rawDur == null ? "—" : rawDur === 0 ? "<1ms" : `${rawDur}ms`;
        const lastRunText = lastDate
          ? `${String(lastDate.getHours()).padStart(2, "0")}:${String(lastDate.getMinutes()).padStart(2, "0")} · ${durText}`
          : "—";
        const errs = rows.filter((a) => {
          const p = a.payload;
          return !!(p && typeof p === "object" && (p as any).error);
        });
        const successPct = rows.length === 0 ? "—" : `${Math.round(((rows.length - errs.length) / rows.length) * 100)}%`;
        const cutoff = Date.now() - 86_400_000;
        const failures24h = errs.filter((a) => new Date(a.createdAt ?? a.created_at).getTime() >= cutoff).length;
        if (!cancelled) {
          setStats({ lastRun: lastRunText, success: successPct, failures24h });
          onRunCount?.(flowId, rows.length);
        }
      } catch {
        // leave default
      }
    };
    void load();
    // Poll so background (event-triggered) runs surface without a reload.
    const iv = setInterval(() => { void load(); }, 15_000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [flowId, refreshNonce, onRunCount]);
  const tile = (k: string, v: string, ok: boolean) => (
    <div key={k} className="overflow-hidden rounded-xl border border-border bg-card p-3 text-card-foreground">
      <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">{k}</div>
      <div className={`mt-0.5 text-lg font-semibold tabular-nums ${ok ? "text-foreground" : "text-destructive"}`}>{v}</div>
    </div>
  );
  return (
    <>
      {tile(t`Last run`, stats.lastRun, true)}
      {tile(t`Success rate`, stats.success, stats.failures24h === 0)}
      {tile(t`Failures (24h)`, String(stats.failures24h), stats.failures24h === 0)}
    </>
  );
}

function FlowNode({ x, y, kind, title, sub }: { x: number; y: number; kind: string; title: string; sub: string }) {
  const colors: Record<string, { bg: string; bd: string; ic: IconComponent }> = {
    trigger: { bg: "color-mix(in oklch, var(--primary) 20%, var(--card))", bd: "var(--color-interactive-hover-border)", ic: I.Zap },
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
