// @ts-nocheck
// workeros admin — additional pages
import { Fragment, useEffect, useState, type ReactNode } from "react";
import { I, type IconComponent } from "./icons";
import { MOCK, type AdapterId } from "./mock";
import { Badge, Button, Checkbox, IconButton, PageHeader, Switch } from "./ui";
import { Select } from "./select";
import { FlowBuilder } from "./flow-builder";
import { compileGraph, decompileGraph, FlowCompileError, type Graph } from "./flow-graph";
import { RealtimeTail, type RealtimeEvent } from "./extras";
import {
  api,
} from "@/lib/api";
import {
  metricsApi,
  settingsApi,
  usersApi,
  type ApiMetrics,
  type ApiRuntime,
  type ApiUser,
} from "./api";

const fetchSafely = async <T,>(path: string): Promise<T | null> => {
  try {
    return await api<T>(path);
  } catch {
    return null;
  }
};

function Sparkline({ data, color = "var(--primary)", height = 36, fill = true }: { data: number[]; color?: string; height?: number; fill?: boolean }) {
  const w = 100, h = height;
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const span = max - min || 1;
  const pts = data.map((v, i) => [i / (data.length - 1) * w, h - ((v - min) / span) * (h - 4) - 2]);
  const d = pts.map((p, i) => (i === 0 ? "M" : "L") + p[0].toFixed(2) + "," + p[1].toFixed(2)).join(" ");
  const fillPath = d + ` L ${w},${h} L 0,${h} Z`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ width: "100%", height, display: "block" }}>
      {fill && <path d={fillPath} fill={color} opacity="0.12" />}
      <path d={d} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r="2" fill={color} />
    </svg>
  );
}

export function OverviewPage({ adapter, pushToast, setActiveNav }: { adapter: AdapterId; pushToast: (m: string) => void; setActiveNav: (id: string) => void }) {
  const profile = MOCK.adapterProfiles[adapter];
  const [range, setRange] = useState("1h");
  // Live metrics: refetched on range change. While offline / unauthenticated
  // we render zero series so the page still draws but doesn't lie about
  // throughput like the original mock did (14,820 req).
  const [metrics, setMetrics] = useState<ApiMetrics | null>(null);
  const [runtime, setRuntime] = useState<ApiRuntime | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await settingsApi.runtime();
        if (!cancelled) setRuntime(r.data);
      } catch {
        // unauthenticated — Health card falls back to design profile labels
      }
    })();
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await metricsApi.overview(range);
        if (!cancelled) setMetrics(r.data);
      } catch {
        // leave null → cards render dashes
      }
    })();
    return () => { cancelled = true; };
  }, [range]);

  const reqSeries = metrics?.series.map((b) => b.requests) ?? Array.from({ length: 40 }, () => 0);
  const errSeries = metrics?.series.map((b) => b.errors) ?? Array.from({ length: 40 }, () => 0);
  // Latency: we don't yet capture per-request latency in the activity table;
  // surface the request curve here so the card has something to show.
  const latSeries = reqSeries;
  const totalRequests = metrics?.totals.requests ?? 0;
  const errorPct = metrics?.totals.errorRate != null ? (metrics.totals.errorRate * 100).toFixed(2) + "%" : "—";
  const activeUsers = metrics?.totals.activeUsers ?? 0;

  const p95 = metrics?.totals.p95Ms ?? 0;
  const todayMetrics = [
    { label: "Requests", value: totalRequests.toLocaleString(), delta: range, up: true, series: reqSeries, color: "var(--primary)" },
    { label: "p95 latency", value: p95 ? `${p95}ms` : "—", delta: "duration_ms", up: p95 < 500, series: latSeries, color: "oklch(0.65 0.15 240)" },
    { label: "Error rate", value: errorPct, delta: "errors", up: (metrics?.totals.errorRate ?? 0) < 0.05, series: errSeries, color: "oklch(0.7 0.18 22)" },
    { label: "Active users", value: String(activeUsers), delta: range, up: activeUsers > 0, series: errSeries, color: "oklch(0.72 0.16 145)" },
  ];

  const fmtAgo = (ts: number | null | undefined): string => {
    if (!ts) return "—";
    const ms = Date.now() - ts;
    if (ms < 60_000) return "just now";
    if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
    if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
    return `${Math.floor(ms / 86_400_000)}d ago`;
  };
  const fmtBytes = (n: number) => {
    if (!n) return "—";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  };

  const collections = (metrics?.topCollections ?? []).map((c) => ({
    slug: c.slug,
    rows: c.rows,
    size: fmtBytes((c as any).bytes ?? 0),
    last: fmtAgo(c.lastWrite),
    writes: 0,
  }));

  const iconForAction = (a: string) => {
    if (/error|fail|denied/i.test(a)) return I.AlertTriangle;
    if (a.startsWith("auth.")) return I.Users;
    if (a.startsWith("flow") || a.startsWith("function")) return I.Bolt;
    if (a.startsWith("storage")) return I.Folder;
    if (a.startsWith("webhook")) return I.Webhook;
    if (a.startsWith("schema")) return I.Pencil;
    const verb = a.includes(".") ? a.slice(a.indexOf(".") + 1) : a;
    if (verb.startsWith("create") || verb.startsWith("insert")) return I.Plus;
    if (verb.startsWith("update") || verb.startsWith("patch")) return I.Pencil;
    if (verb.startsWith("delete") || verb.startsWith("remove")) return I.Trash;
    return I.Activity;
  };
  const activity = (metrics?.recent ?? []).slice(0, 8).map((r) => ({
    t: new Date(r.t).toISOString().slice(11, 16),
    who: r.userId ?? "system",
    verb: r.action,
    what: r.itemId ? `${r.collection}/${r.itemId.slice(0, 12)}` : (r.collection ?? "—"),
    icon: iconForAction(r.action),
  }));

  const recentErrors = (metrics?.recentErrors ?? []).map((e) => ({
    code: e.code,
    count: e.count,
    hook: e.resource,
    msg: e.msg,
    last: fmtAgo(e.last),
  }));

  const quickActions = [
    { label: "New collection", icon: I.Database, hint: "auto-creates c_<slug> table", onClick: () => { setActiveNav("collections"); pushToast("Collection wizard opened."); } },
    { label: "New function", icon: I.Function, hint: "http · event · cron", onClick: () => { setActiveNav("functions"); pushToast("Function scaffold ready."); } },
    { label: "New flow", icon: I.Bolt, hint: "trigger → action graph", onClick: () => { setActiveNav("flows"); pushToast("Flow draft created."); } },
    { label: "Invite user", icon: I.Users, hint: "email magic link", onClick: () => { setActiveNav("users"); pushToast("Invite dialog opened."); } },
  ];

  const c = metrics?.counts;
  const stats = [
    { label: "Collections", value: c?.collections ?? 0, sub: "physical c_<slug> tables", nav: "collections", icon: I.Database },
    { label: "Files", value: c?.files ?? 0, sub: "stored objects", nav: "storage", icon: I.Folder },
    { label: "Active flows", value: c?.activeFlows ?? 0, sub: `${c?.activeFlows ?? 0} enabled · ${c?.pausedFlows ?? 0} paused`, nav: "flows", icon: I.Bolt },
    { label: "Functions", value: c?.functions ?? 0, sub: "sandboxed handlers", nav: "functions", icon: I.Function },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <PageHeader
        title="Overview"
        description={<>Adapter auto-selected from bindings/env. <span className="font-mono">{adapter}</span> profile is active.</>}
        actions={<>
          <Select size="sm" value={range} onChange={setRange} options={[
            { value: "15m", label: "Last 15 minutes" },
            { value: "1h", label: "Last 1 hour" },
            { value: "24h", label: "Last 24 hours" },
            { value: "7d", label: "Last 7 days" },
            { value: "30d", label: "Last 30 days" },
          ]} style={{ width: 170 }} />
          <Button variant="outline" icon={I.Refresh} onClick={() => pushToast("Status refreshed.")}>Refresh</Button>
        </>}
      />

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
        {todayMetrics.map((m) => (
          <div key={m.label} className="card" style={{ padding: 0, display: "flex", flexDirection: "column", gap: 8, overflow: "hidden" }}>
            <div style={{ padding: "14px 14px 0", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div className="muted" style={{ fontSize: 11.5, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 }}>{m.label}</div>
              <span className="font-mono tabular-nums" style={{ fontSize: 11, color: m.up ? "oklch(0.55 0.16 145)" : "var(--destructive)" }}>{m.delta}</span>
            </div>
            <div className="tabular-nums" style={{ padding: "0 14px", fontSize: 24, fontWeight: 600, letterSpacing: "-0.02em" }}>{m.value}</div>
            <div style={{ marginTop: 6, display: "block", lineHeight: 0 }}>
              <Sparkline data={m.series} color={m.color} height={36} />
            </div>
          </div>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10 }}>
        {quickActions.map((a) => {
          const Icon = a.icon;
          return (
            <button key={a.label} onClick={a.onClick} className="card" style={{ padding: "12px 14px", display: "flex", alignItems: "center", gap: 12, cursor: "pointer", textAlign: "left", border: "1px dashed var(--border)", background: "transparent", font: "inherit", color: "inherit" }}>
              <span style={{ width: 32, height: 32, borderRadius: "var(--radius-lg)", background: "color-mix(in oklch, var(--primary) 16%, var(--card))", display: "grid", placeItems: "center", color: "var(--primary)" }}>
                <Icon size={14} />
              </span>
              <div style={{ display: "flex", flexDirection: "column" }}>
                <span style={{ fontSize: 13, fontWeight: 500 }}>{a.label}</span>
                <span className="muted" style={{ fontSize: 11.5 }}>{a.hint}</span>
              </div>
              <div className="spacer" />
              <I.ChevronRight size={14} className="muted" />
            </button>
          );
        })}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
        {stats.map((s) => {
          const Icon = s.icon;
          return (
            <div key={s.label} className="card" style={{ padding: 16, cursor: "pointer", display: "flex", flexDirection: "column", gap: 4 }} onClick={() => setActiveNav(s.nav)}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Icon size={13} className="muted" />
                <div className="muted" style={{ fontSize: 11.5, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 }}>{s.label}</div>
              </div>
              <div className="tabular-nums" style={{ fontSize: 28, fontWeight: 600, letterSpacing: "-0.02em", marginTop: 2 }}>{s.value}</div>
              <div className="muted" style={{ fontSize: 12 }}>{s.sub}</div>
            </div>
          );
        })}
      </div>

      <div className="split">
        <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
          <div className="card">
            <div className="card-section" style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <I.Database size={14} />
              <span style={{ fontSize: 13, fontWeight: 500 }}>Top collections</span>
              <div className="spacer" />
              <Button variant="ghost" size="sm" onClick={() => setActiveNav("collections")} iconRight={I.ChevronRight}>Manage</Button>
            </div>
            <div className="table-scroll">
            <table className="table">
              <thead><tr><th>Slug</th><th style={{ width: 80, textAlign: "right" }}>Rows</th><th style={{ width: 90, textAlign: "right" }}>Size</th><th style={{ width: 110, textAlign: "right" }}>Writes (1h)</th><th style={{ width: 100 }}>Last write</th></tr></thead>
              <tbody>
                {collections.map((c) => (
                  <tr key={c.slug} onClick={() => setActiveNav("collections")}>
                    <td><span className="font-mono" style={{ fontSize: 12.5 }}>c_{c.slug}</span></td>
                    <td className="tabular-nums" style={{ textAlign: "right" }}>{c.rows}</td>
                    <td className="tabular-nums muted" style={{ textAlign: "right" }}>{c.size}</td>
                    <td className="tabular-nums" style={{ textAlign: "right" }}>{c.writes}</td>
                    <td className="muted font-mono" style={{ fontSize: 11.5 }}>{c.last}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </div>

          <div className="card">
            <div className="card-section" style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <I.AlertTriangle size={14} />
              <span style={{ fontSize: 13, fontWeight: 500 }}>Recent errors</span>
              <span className="font-mono muted" style={{ fontSize: 12 }}>last {range} · {(metrics?.totals?.errors ?? recentErrors.reduce((a, e) => a + (e.count ?? 0), 0))} {(metrics?.totals?.errors ?? 0) === 1 ? "event" : "events"}</span>
              <div className="spacer" />
              <Button variant="ghost" size="sm" onClick={() => setActiveNav("activity")}>View all</Button>
            </div>
            {recentErrors.length === 0 ? (
              <div style={{ padding: "20px 16px", textAlign: "center" }}>
                <span className="muted" style={{ fontSize: 12.5 }}>No errors recorded.</span>
              </div>
            ) : recentErrors.map((e, i) => (
              <div key={i} style={{ padding: "10px 16px", borderBottom: i < recentErrors.length - 1 ? "1px solid var(--border)" : 0, display: "flex", alignItems: "center", gap: 12 }}>
                <Badge variant="destructive">{e.code}</Badge>
                <span className="tabular-nums muted" style={{ fontSize: 12, width: 36 }}>×{e.count}</span>
                <div style={{ display: "flex", flexDirection: "column", minWidth: 0, flex: 1 }}>
                  <span className="font-mono" style={{ fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.hook}</span>
                  <span className="muted" style={{ fontSize: 11.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.msg}</span>
                </div>
                <span className="muted font-mono" style={{ fontSize: 11.5 }}>{e.last}</span>
              </div>
            ))}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div className="card" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <I.Globe size={14} /><span style={{ fontSize: 13, fontWeight: 500 }}>Health</span>
              <div className="spacer" />
              <span className="adapter-pill"><span className="dot" />{adapter === "workers" ? "cf workers" : adapter}</span>
            </div>
            {(() => {
              // Live health rows derived from /api/admin/settings/runtime.
              // Each row's status reflects whether the binding/adapter is
              // actually present at runtime — no fake latency numbers.
              const bindByName = new Map(
                (runtime?.bindings ?? []).map((b) => [b.name, b]),
              );
              const envSet = new Set(
                (runtime?.envVars ?? [])
                  .filter((v) => v.set)
                  .map((v) => v.key),
              );
              const dbBinding = bindByName.get("D1") ?? bindByName.get("DB");
              const storageBinding = bindByName.get("R2") ?? bindByName.get("ASSETS");
              const realtimeBinding = bindByName.get("REALTIME");
              const vectorizeBinding = bindByName.get("VECTORIZE");
              const dbStatus = dbBinding ? dbBinding.status : adapter === "vercel" ? (envSet.has("DATABASE_URL") ? "connected" : "optional") : "connected";
              const storageStatus = storageBinding ? storageBinding.status : adapter === "bun" ? "connected" : (envSet.has("S3_BUCKET") ? "connected" : "optional");
              const realtimeStatus = realtimeBinding ? realtimeBinding.status : adapter === "bun" ? "connected" : "optional";
              const emailConnected = envSet.has("RESEND_API_KEY") && envSet.has("EMAIL_FROM");
              const rows = [
                ["Database", profile.db, dbStatus === "connected" ? "connected" : "optional", dbBinding?.target ?? profile.db],
                ["Storage", profile.storage, storageStatus === "connected" ? "connected" : "optional", storageBinding?.target ?? profile.storage],
                ["Realtime", profile.realtime, realtimeStatus === "connected" ? "connected" : "optional", realtimeBinding?.target ?? profile.realtime],
                ["Sandbox", profile.sandbox, "idle", profile.sandbox],
                ["Vectorize", "vector index", vectorizeBinding ? "connected" : "optional", vectorizeBinding?.target ?? "—"],
                ["Email", emailConnected ? "resend" : adapter === "bun" ? "console (dev)" : "not configured", emailConnected ? "connected" : "idle", emailConnected ? "EMAIL_FROM set" : adapter === "bun" ? "logs to stdout" : "set RESEND_API_KEY + EMAIL_FROM"],
              ];
              return rows;
            })().map(([k, v, status, hint], i, arr) => (
              <div key={k} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: i < arr.length - 1 ? "1px solid var(--border)" : 0, paddingBottom: 9 }}>
                <div>
                  <div style={{ fontSize: 12.5, fontWeight: 500 }}>{k}</div>
                  <div className="font-mono muted" style={{ fontSize: 11.5 }}>{v} · {hint}</div>
                </div>
                <span className="adapter-pill"><span className={`dot ${status === "idle" ? "amber" : ""}`} />{status}</span>
              </div>
            ))}
          </div>

          <div className="card">
            <div className="card-section" style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <I.Activity size={14} />
              <span style={{ fontSize: 13, fontWeight: 500 }}>Activity</span>
              <div className="spacer" />
              <Button variant="ghost" size="sm" iconRight={I.ChevronRight} onClick={() => setActiveNav("activity")}>All events</Button>
            </div>
            <div style={{ padding: "4px 0" }}>
              {activity.map((a, i) => {
                const Icon = a.icon;
                return (
                  <div key={i} style={{ padding: "8px 16px", display: "flex", alignItems: "flex-start", gap: 10 }}>
                    <span style={{ width: 22, height: 22, borderRadius: 999, background: "var(--muted)", display: "grid", placeItems: "center", flexShrink: 0, marginTop: 1 }}>
                      <Icon size={11} className="muted" />
                    </span>
                    <div style={{ display: "flex", flexDirection: "column", minWidth: 0, flex: 1 }}>
                      <span style={{ fontSize: 12.5 }}>
                        <span style={{ fontWeight: 500 }}>{a.who}</span>
                        <span className="muted"> {a.verb} </span>
                        <span className="font-mono" style={{ fontSize: 12 }}>{a.what}</span>
                      </span>
                    </div>
                    <span className="muted font-mono tabular-nums" style={{ fontSize: 11 }}>{a.t}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

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

      <div className="master-detail" style={{ "--md-aside": "320px" }}>
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
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 16, fontWeight: 600 }}>{flow.name}</span>
            <Badge variant={flow.status === "active" ? "default" : "secondary"}>{flow.status}</Badge>
            <span className="muted tabular-nums" style={{ fontSize: 12 }}>· {Number(flow.runs ?? 0).toLocaleString()} runs</span>
            <div className="spacer" />
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
  const c = colors[kind];
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
    if (!confirm(`Delete function "${name}"? This cannot be undone.`)) return;
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

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <PageHeader
        title="Functions"
        description="Sandboxed JS — HTTP, event-trigger, or cron. Provider auto-selected per runtime."
        actions={<Button variant="primary" icon={I.Plus} onClick={() => setNewOpen(true)}>New function</Button>}
      />

      <div className="master-detail" style={{ "--md-aside": "300px" }}>
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
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="font-mono" style={{ fontSize: 18, fontWeight: 600 }}>{active.name}</span>
            <Badge variant="outline">{active.kind}</Badge>
            <span className="font-mono muted" style={{ fontSize: 12 }}>· {active.trigger}</span>
            <div className="spacer" />
            <span className="muted" style={{ fontSize: 12 }}>{Number(active.invocations ?? 0).toLocaleString()} invocations · p95 {active.p95 ?? 0}ms</span>
            <Button variant="outline" size="sm" icon={I.Trash} onClick={() => active && removeFunction(active.name)} style={{ color: "var(--destructive)" }}>Delete</Button>
            <Button variant="outline" size="sm" icon={I.Save} onClick={saveCode}>Save</Button>
            <Button variant="primary" size="sm" icon={I.Zap} onClick={run} disabled={running}>{running ? "Running…" : "Run"}</Button>
          </div>

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
            <input
              className={`input font-mono ${nameError && name ? "error" : ""}`}
              autoFocus
              placeholder="my_function"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            {nameError && name ? (
              <div className="field-error"><I.AlertTriangle size={11} />{nameError}</div>
            ) : (
              <span className="field-hint">Lowercase, digits, <span className="font-mono">_</span> or <span className="font-mono">-</span>. Cannot be changed later.</span>
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
              <input
                className={`input ${timeoutError ? "error" : ""}`}
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
              <input
                className={`input font-mono ${patternError ? "error" : ""}`}
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
            <textarea
              className={`textarea font-mono ${codeError ? "error" : ""}`}
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

const WH_EVENTS = [
  "items.*.created", "items.*.updated", "items.*.deleted",
  "items.posts.created", "items.posts.updated", "items.posts.deleted",
  "items.comments.created", "items.comments.updated", "items.comments.deleted",
  "auth.login", "auth.logout", "auth.signup",
  "files.uploaded", "files.deleted",
];

/** `Header: value` lines ⇄ a `{ [name]: value }` map. Headers are optional —
 * an empty textarea means "no custom headers", so we send `null` rather than
 * an empty object the API would have to special-case. */
function parseHeaderLines(text: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    if (key) out[key] = line.slice(idx + 1).trim();
  }
  return Object.keys(out).length ? out : null;
}
function formatHeaderLines(headers: Record<string, string> | null | undefined): string {
  return headers ? Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join("\n") : "";
}

export function WebhooksPage({ pushToast }: { pushToast: (m: string) => void }) {
  type HookRow = { id: string; name: string; url: string; events: string[]; method: string; secret: string; headers: Record<string, string> | null; active: boolean; deliveries: number; ok: boolean; successRate: number; lastDelivery: string };
  const [hooks, setHooks] = useState<HookRow[]>([]);
  const reloadHooks = async () => {
    const [r, m] = await Promise.all([
      fetchSafely<{ data: any[] }>("/api/webhooks"),
      fetchSafely<{ data: { webhooks: Record<string, { deliveries: number; lastDelivery: number | null }> } }>(`/api/admin/metrics/entities`),
    ]);
    const stats = m?.data?.webhooks ?? {};
    const fmtAgo = (ms: number | null): string => {
      if (!ms) return "—";
      const diff = Date.now() - ms;
      if (diff < 60_000) return "just now";
      if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
      if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
      return `${Math.floor(diff / 86_400_000)}d ago`;
    };
    if (Array.isArray(r?.data)) {
      setHooks(
        r.data.map((h) => ({
          id: h.id,
          name: h.name,
          url: h.url,
          events: Array.isArray(h.events) ? h.events : [],
          method: "POST",
          secret: h.secret ?? "",
          headers: h.headers ?? null,
          active: !!h.active,
          deliveries: stats[h.id]?.deliveries ?? 0,
          ok: true,
          successRate: 100,
          lastDelivery: fmtAgo(stats[h.id]?.lastDelivery ?? null),
        })),
      );
    }
  };
  useEffect(() => { void reloadHooks(); }, []);
  const [editor, setEditor] = useState<{ mode: "create" | "edit"; hook: any } | null>(null);
  const [menuOpen, setMenuOpen] = useState<string | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [menuOpen]);

  type DeliveryRow = { id: string; t: string; hook: string; ev: string; code: number; ms: number };
  const [deliveries, setDeliveries] = useState<DeliveryRow[]>([]);
  const reloadDeliveries = async () => {
    try {
      const r = await api<{ data: any[] }>("/api/webhooks/_deliveries");
      if (Array.isArray(r.data)) {
        setDeliveries(
          r.data.map((d) => ({
            id: d.id,
            t: new Date(d.deliveredAt).toISOString().slice(11, 19),
            hook: d.webhookId,
            ev: d.event,
            code: d.status,
            ms: d.ms,
          })),
        );
      }
    } catch {
      // keep seed
    }
  };
  useEffect(() => { void reloadDeliveries(); }, []);

  const saveHook = async (data: any) => {
    try {
      const headers = parseHeaderLines(data.headers);
      if (editor!.mode === "create") {
        await api("/api/webhooks", {
          method: "POST",
          body: JSON.stringify({ name: data.name, url: data.url, events: data.events, secret: data.secret, active: data.active, headers }),
        });
        pushToast(`Webhook "${data.name}" created.`);
      } else {
        await api(`/api/webhooks/${editor!.hook.id}`, {
          method: "PATCH",
          body: JSON.stringify({ name: data.name, url: data.url, events: data.events, active: data.active, headers }),
        });
        pushToast(`Webhook "${data.name}" updated.`);
      }
      await reloadHooks();
    } catch (e) {
      pushToast((e as Error).message);
    }
    setEditor(null);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <PageHeader
        title="Webhooks"
        description="Outgoing HTTP on collection events. Failed deliveries retry with exponential backoff."
        actions={<Button variant="primary" icon={I.Plus} onClick={() => setEditor({ mode: "create", hook: null })}>New webhook</Button>}
      />
      <div className="card">
        <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th>Endpoint</th>
              <th>Events</th>
              <th style={{ textAlign: "right", width: 110 }}>Deliveries</th>
              <th style={{ width: 110 }}>Success</th>
              <th style={{ width: 100 }}>Status</th>
              <th style={{ width: 44 }}></th>
            </tr>
          </thead>
          <tbody>
            {hooks.map((h) => {
              const isOpen = menuOpen === h.id;
              return (
                <tr key={h.id} className="users-row" onClick={() => setEditor({ mode: "edit", hook: h })}>
                  <td>
                    <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                      <span style={{ fontSize: 13, fontWeight: 500 }}>{h.name}</span>
                      <span className="muted font-mono" style={{ fontSize: 11.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 360 }}>{h.method} · {h.url}</span>
                    </div>
                  </td>
                  <td><div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>{h.events.map((e) => <Badge key={e} variant="outline" mono>{e}</Badge>)}</div></td>
                  <td className="tabular-nums" style={{ textAlign: "right" }}>{h.deliveries.toLocaleString()}</td>
                  <td>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <div style={{ width: 48, height: 4, borderRadius: 999, background: "var(--muted)", overflow: "hidden" }}>
                        <div style={{ width: `${h.successRate}%`, height: "100%", background: h.successRate > 95 ? "oklch(0.78 0.15 145)" : h.successRate > 50 ? "oklch(0.78 0.15 80)" : "var(--destructive)" }} />
                      </div>
                      <span className="font-mono" style={{ fontSize: 11.5 }}>{h.successRate}%</span>
                    </div>
                  </td>
                  <td>
                    {!h.active ? <Badge variant="secondary">paused</Badge>
                      : h.ok ? <Badge variant="default">healthy</Badge>
                        : <Badge variant="destructive">failing</Badge>}
                  </td>
                  <td style={{ textAlign: "right", position: "relative" }} onClick={(e) => e.stopPropagation()}>
                    <IconButton icon={I.More} onClick={(e: any) => { e.stopPropagation(); setMenuOpen(isOpen ? null : h.id); }} />
                    {isOpen && (
                      <div className="users-menu" onClick={(e) => e.stopPropagation()}>
                        <button onClick={() => { setEditor({ mode: "edit", hook: h }); setMenuOpen(null); }}><I.Pencil size={12} />Edit</button>
                        <button onClick={async () => {
                          try {
                            await api(`/api/webhooks/${h.id}/test`, { method: "POST" });
                            pushToast(`Test event sent to ${h.name}.`);
                            await reloadDeliveries();
                          } catch (e) {
                            pushToast((e as Error).message);
                          }
                          setMenuOpen(null);
                        }}><I.Bolt size={12} />Send test</button>
                        <button onClick={async () => {
                          const next = !h.active;
                          try {
                            await api(`/api/webhooks/${h.id}`, {
                              method: "PATCH",
                              body: JSON.stringify({ active: next }),
                            });
                          } catch (e) {
                            pushToast((e as Error).message);
                          }
                          setHooks((arr) => arr.map((x) => x.id === h.id ? { ...x, active: next } : x));
                          setMenuOpen(null);
                          pushToast(`${h.name} ${next ? "resumed" : "paused"}.`);
                        }}>
                          {h.active ? <><I.Lock size={12} />Pause</> : <><I.Play size={12} />Resume</>}
                        </button>
                        <div className="users-menu-sep" />
                        <button className="danger" onClick={async () => {
                          try { await api(`/api/webhooks/${h.id}`, { method: "DELETE" }); } catch (e) { pushToast((e as Error).message); }
                          setHooks((arr) => arr.filter((x) => x.id !== h.id));
                          setMenuOpen(null);
                          pushToast(`${h.name} deleted.`);
                        }}><I.Trash size={12} />Delete</button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
            {hooks.length === 0 && (
              <tr><td colSpan={6}>
                <div className="empty" style={{ padding: "32px 0" }}>
                  <I.Webhook size={20} />
                  <h4>No webhooks yet</h4>
                  <p>Pipe collection events to Slack, your API, or any HTTPS endpoint.</p>
                </div>
              </td></tr>
            )}
          </tbody>
        </table>
        </div>
      </div>

      <div className="card">
        <div className="card-section" style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <I.Activity size={14} /><span style={{ fontSize: 13, fontWeight: 500 }}>Recent deliveries</span>
          <div className="spacer" />
          <Button variant="ghost" size="sm" icon={I.Refresh} onClick={() => pushToast("Refreshed.")}>Refresh</Button>
        </div>
        <div className="table-scroll">
        <table className="table">
          <thead><tr><th style={{ width: 100 }}>Time</th><th style={{ width: 80 }}>Hook</th><th>Event</th><th style={{ width: 90, textAlign: "right" }}>Status</th><th style={{ width: 80, textAlign: "right" }}>ms</th><th style={{ width: 60 }}></th></tr></thead>
          <tbody>
            {deliveries.map((d, i) => (
              <tr key={i}>
                <td className="font-mono muted tabular-nums" style={{ fontSize: 11.5 }}>{d.t}</td>
                <td className="font-mono" style={{ fontSize: 12 }}>{d.hook}</td>
                <td className="font-mono" style={{ fontSize: 12 }}>{d.ev}</td>
                <td className="tabular-nums" style={{ textAlign: "right" }}><Badge variant={d.code < 300 ? "default" : "destructive"}>{d.code}</Badge></td>
                <td className="tabular-nums muted" style={{ textAlign: "right" }}>{d.ms}</td>
                <td style={{ textAlign: "right" }}>
                  <Button variant="ghost" size="sm" onClick={async () => {
                    try {
                      await api(`/api/webhooks/_deliveries/${d.id}/retry`, { method: "POST" });
                      pushToast("Redelivered.");
                      await reloadDeliveries();
                    } catch (e) {
                      pushToast((e as Error).message);
                    }
                  }}>Retry</Button>
                </td>
              </tr>
            ))}
            {deliveries.length === 0 && (
              <tr><td colSpan={6}>
                <div className="empty" style={{ padding: "32px 0" }}>
                  <I.Activity size={20} />
                  <h4>No deliveries yet</h4>
                  <p>Outgoing webhook deliveries will show up here once a collection event fires.</p>
                </div>
              </td></tr>
            )}
          </tbody>
        </table>
        </div>
      </div>

      {editor && <WebhookEditorDialog mode={editor.mode} hook={editor.hook} onClose={() => setEditor(null)} onSave={saveHook} pushToast={pushToast} />}
    </div>
  );
}

function WebhookEditorDialog({ mode, hook, onClose, onSave, pushToast }: { mode: "create" | "edit"; hook: any; onClose: () => void; onSave: (data: any) => void; pushToast: (m: string) => void }) {
  const blank = { name: "", url: "", method: "POST", events: [], secret: "whsec_" + Math.random().toString(16).slice(2, 14), active: true, headers: "" };
  const [draft, setDraft] = useState<any>(hook ? { ...hook, headers: formatHeaderLines(hook.headers) } : blank);
  const [revealSecret, setRevealSecret] = useState(false);
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const update = (k: string, v: unknown) => { setDraft((d: any) => ({ ...d, [k]: v })); setErrors((e) => ({ ...e, [k]: undefined })); };

  const toggleEvent = (ev: string) => {
    setDraft((d: any) => ({ ...d, events: d.events.includes(ev) ? d.events.filter((x: string) => x !== ev) : [...d.events, ev] }));
  };

  const submit = () => {
    const e: Record<string, string> = {};
    if (!String(draft.name || "").trim()) e.name = "name is required";
    if (!String(draft.url || "").trim()) e.url = "url is required";
    else if (!/^https?:\/\//.test(draft.url)) e.url = "must start with http:// or https://";
    if (!draft.events.length) e.events = "pick at least one event";
    setErrors(e);
    if (Object.keys(e).length) return;
    onSave(draft);
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog-lg" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()} style={{ width: 640, maxWidth: "92vw" }}>
        <div className="sheet-header" style={{ borderBottom: "1px solid var(--border)" }}>
          <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 10 }}>
            <I.Webhook size={16} />
            <div>
              <h2>{mode === "create" ? "New webhook" : "Edit webhook"}</h2>
              <p>{mode === "create" ? "POST to any HTTPS endpoint when collection events fire." : <>id <span className="font-mono">{hook?.id}</span></>}</p>
            </div>
          </div>
          <IconButton icon={I.X} onClick={onClose} title="Close" />
        </div>

        <div className="dialog-body">
          <div className="field">
            <label className="field-label">Name <span style={{ color: "var(--destructive)" }}>*</span></label>
            <input className={`input ${errors.name ? "error" : ""}`} autoFocus value={draft.name} onChange={(e) => update("name", e.target.value)} placeholder="Slack #content" />
            {errors.name && <div className="field-error"><I.AlertTriangle size={11} />{errors.name}</div>}
          </div>

          <div className="field">
            <label className="field-label">Endpoint URL <span style={{ color: "var(--destructive)" }}>*</span></label>
            <div style={{ display: "flex", gap: 8 }}>
              <Select size="sm" value={draft.method} onChange={(v) => update("method", v)} style={{ width: 100, height: 36 }} options={["POST", "PUT", "PATCH"]} />
              <input className={`input font-mono ${errors.url ? "error" : ""}`} style={{ flex: 1, fontSize: 12.5 }} value={draft.url} onChange={(e) => update("url", e.target.value)} placeholder="https://api.example.com/webhooks/workeros" />
            </div>
            {errors.url ? <div className="field-error"><I.AlertTriangle size={11} />{errors.url}</div> : <span className="field-hint">Must accept the chosen HTTP method and respond with 2xx within 10s.</span>}
          </div>

          <div className="field">
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <label className="field-label">Events <span style={{ color: "var(--destructive)" }}>*</span></label>
              <span className="muted" style={{ fontSize: 11.5 }}>{draft.events.length} selected</span>
            </div>
            <div className="wh-events">
              {WH_EVENTS.map((ev) => {
                const on = draft.events.includes(ev);
                return (
                  <button key={ev} type="button" className={`wh-event ${on ? "on" : ""}`} onClick={() => toggleEvent(ev)}>
                    {on ? <I.Check size={11} /> : <I.Plus size={11} />}
                    <span className="font-mono" style={{ fontSize: 11.5 }}>{ev}</span>
                  </button>
                );
              })}
            </div>
            {errors.events && <div className="field-error"><I.AlertTriangle size={11} />{errors.events}</div>}
          </div>

          <div className="field">
            <label className="field-label">Signing secret</label>
            <div style={{ display: "flex", gap: 8 }}>
              <input className="input font-mono" style={{ flex: 1, fontSize: 12.5 }} type={revealSecret ? "text" : "password"} value={draft.secret} readOnly />
              <Button variant="outline" size="sm" icon={revealSecret ? I.X : I.Eye} onClick={() => setRevealSecret(!revealSecret)}>{revealSecret ? "Hide" : "Show"}</Button>
              <Button variant="outline" size="sm" icon={I.Refresh} onClick={() => { update("secret", "whsec_" + Math.random().toString(16).slice(2, 14)); pushToast("Secret rotated."); }}>Rotate</Button>
            </div>
            <span className="field-hint">Sent as <span className="font-mono">X-Workeros-Signature: sha256=…</span>. Verify on the receiver.</span>
          </div>

          <div className="field">
            <label className="field-label">Custom headers</label>
            <textarea className="textarea font-mono" style={{ minHeight: 70, fontSize: 12 }} value={draft.headers} onChange={(e) => update("headers", e.target.value)} placeholder={"Authorization: Bearer …\nX-Tenant: workeros"} />
            <span className="field-hint">One per line. <span className="font-mono">Content-Type</span> and <span className="font-mono">X-Workeros-*</span> are reserved.</span>
          </div>

          <div className="field-row">
            <div>
              <div style={{ fontSize: 12.5, fontWeight: 500 }}>Active</div>
              <div className="muted" style={{ fontSize: 11.5 }}>Deliveries pause immediately when off; queued events are dropped after 24h.</div>
            </div>
            <Switch checked={draft.active} onChange={(v) => update("active", v)} />
          </div>
        </div>

        <div className="sheet-footer">
          {mode === "edit" && <Button variant="ghost" icon={I.Bolt} onClick={async () => {
            try {
              await api(`/api/webhooks/${draft.id}/test`, { method: "POST" });
              pushToast(`Test event sent to ${draft.name}.`);
            } catch (e) {
              pushToast((e as Error).message);
            }
          }}>Send test</Button>}
          <div className="spacer" />
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit}>{mode === "create" ? "Create webhook" : "Save changes"}</Button>
        </div>
      </div>
    </div>
  );
}

export function RealtimePage({ events, pushToast }: { events: RealtimeEvent[]; pushToast: (m: string) => void }) {
  // Channels are derived from real collections — `items:<slug>` per
  // collection plus the system `collections` channel. Subscriber counts
  // aren't exposed by the API yet so we hide that column rather than
  // showing fabricated numbers.
  type Channel = { name: string; subs: number | null; filter: string };
  const [channels, setChannels] = useState<Channel[]>([{ name: "collections", subs: null, filter: "admin role only" }]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch("/api/collections", { credentials: "include" });
        if (!r.ok || cancelled) return;
        const j = (await r.json()) as { data?: { slug: string; ownerScoped?: boolean }[] };
        const slugs = j.data ?? [];
        const built: Channel[] = slugs.map((c) => ({
          name: `items:${c.slug}`,
          subs: null,
          filter: c.ownerScoped ? "owner_id _eq $user.id" : "permission · read",
        }));
        // Always include the system `collections` channel (admin-only schema events).
        built.push({ name: "collections", subs: null, filter: "admin role only" });
        if (!cancelled) setChannels(built);
      } catch {
        // keep default
      }
    })();
    return () => { cancelled = true; };
  }, []);
  const [active, setActive] = useState<string>("collections");
  // Lock onto the first channel once derived.
  useEffect(() => {
    if (channels.length === 0) return;
    if (!channels.some((c) => c.name === active)) setActive(channels[0]!.name);
  }, [channels]);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <PageHeader
        title="Realtime"
        description="In-process pub/sub on Bun, Durable Objects on Workers. Permission filter applies on subscribe + publish."
        actions={<Button variant="outline" icon={I.Refresh} onClick={() => pushToast("Channels refreshed.")}>Refresh</Button>}
      />
      <div className="master-detail" style={{ "--md-aside": "300px" }}>
        <div className="card">
          {channels.length === 0 && (
            <div className="muted" style={{ padding: "16px 12px", fontSize: 12 }}>No channels — create a collection to get one.</div>
          )}
          {channels.map((c) => (
            <div key={c.name} onClick={() => setActive(c.name)} className="schema-row" style={{ gridTemplateColumns: "20px 1fr auto", cursor: "pointer", background: active === c.name ? "var(--accent)" : "transparent" }}>
              <span><span className="dot" /></span>
              <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                <span className="font-mono" style={{ fontSize: 12.5 }}>{c.name}</span>
                <span className="muted" style={{ fontSize: 11 }}>{c.filter}</span>
              </div>
              {c.subs != null && <Badge variant="outline" mono>{c.subs} sub</Badge>}
            </div>
          ))}
        </div>

        <RealtimeTail events={events} channel={active} connected />
      </div>
    </div>
  );
}

const ProviderGlyph = ({ kind, size = 12 }: { kind: string; size?: number }) => {
  if (kind === "github") return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor"><path d="M12 .5a12 12 0 0 0-3.79 23.39c.6.11.82-.26.82-.58v-2.04c-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.09-.75.08-.73.08-.73 1.21.09 1.85 1.24 1.85 1.24 1.07 1.84 2.81 1.31 3.5 1 .11-.78.42-1.31.76-1.61-2.67-.3-5.47-1.34-5.47-5.95 0-1.31.47-2.39 1.24-3.23-.13-.3-.54-1.52.12-3.18 0 0 1-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.3-1.55 3.3-1.23 3.3-1.23.66 1.66.25 2.88.12 3.18.77.84 1.24 1.92 1.24 3.23 0 4.62-2.81 5.64-5.49 5.94.43.37.82 1.1.82 2.22v3.29c0 .32.22.7.83.58A12 12 0 0 0 12 .5Z" /></svg>
  );
  if (kind === "google") return (
    <svg width={size} height={size} viewBox="0 0 24 24"><path fill="#4285F4" d="M22 12.2c0-.8-.07-1.6-.2-2.4H12v4.5h5.6a4.8 4.8 0 0 1-2.1 3.1v2.6h3.4c2-1.8 3.1-4.5 3.1-7.8Z" /><path fill="#34A853" d="M12 22c2.8 0 5.2-.9 6.9-2.5l-3.4-2.6c-.9.6-2.1 1-3.5 1-2.7 0-5-1.8-5.8-4.3H2.7v2.7A10 10 0 0 0 12 22Z" /><path fill="#FBBC05" d="M6.2 13.6a6 6 0 0 1 0-3.8V7.1H2.7a10 10 0 0 0 0 9l3.5-2.5Z" /><path fill="#EA4335" d="M12 5.4c1.5 0 2.9.5 4 1.5l3-3A10 10 0 0 0 2.7 7.1l3.5 2.7C7 7.2 9.3 5.4 12 5.4Z" /></svg>
  );
  if (kind === "magic") return <I.Bolt size={size} />;
  return <I.Lock size={size} />;
};

const PROVIDER_LABEL: Record<string, string> = { password: "password", github: "github", google: "google", magic: "magic link" };

export function UsersPage({ pushToast }: { pushToast: (m: string) => void }) {
  type UserRow = { id: string; name: string; email: string; roles: string[]; status: string; provider: string; mfa: boolean; last: string; lastIso: string | null; created: string; sessions: number; hue: number };
  const [users, setUsers] = useState<UserRow[]>([]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await usersApi.list();
        if (cancelled || !Array.isArray(r.data)) return;
        const fmt = (ts: number | null): string => {
          if (!ts) return "—";
          const ms = Date.now() - ts;
          if (ms < 60_000) return "just now";
          if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
          if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
          return `${Math.floor(ms / 86_400_000)}d ago`;
        };
        setUsers(
          r.data.map((u: ApiUser & { lastSeenAt?: number | null }, i: number) => {
            const lastSeenAt = u.lastSeenAt ?? null;
            return {
              id: u.id,
              name: u.name ?? u.email.split("@")[0],
              email: u.email,
              roles: u.roles.map((x) => x.name),
              status: u.status ?? "active",
              provider: "password",
              mfa: false,
              last: fmt(lastSeenAt),
              lastIso: lastSeenAt ? new Date(lastSeenAt).toISOString().slice(0, 19).replace("T", " ") : null,
              created: u.createdAt ? String(u.createdAt).slice(0, 10) : "—",
              sessions: 0,
              hue: 30 + ((i * 47) % 320),
            };
          }) as any,
        );
      } catch (e) {
        pushToast?.((e as Error).message);
      }
    })();
    return () => { cancelled = true; };
  }, [pushToast]);
  const [q, setQ] = useState("");
  const [roleFilter, setRoleFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [providerFilter, setProviderFilter] = useState("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [activeUser, setActiveUser] = useState<any>(null);
  const [menuOpen, setMenuOpen] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);

  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [menuOpen]);

  const filtered = users.filter((u) => {
    if (q && !(u.name.toLowerCase().includes(q.toLowerCase()) || u.email.toLowerCase().includes(q.toLowerCase()))) return false;
    if (roleFilter !== "all" && !u.roles.includes(roleFilter)) return false;
    if (statusFilter !== "all" && u.status !== statusFilter) return false;
    if (providerFilter !== "all" && u.provider !== providerFilter) return false;
    return true;
  });

  const stats = {
    total: users.length,
    active24h: users.filter((u) => /m ago|h ago|just now/.test(u.last)).length,
    pending: users.filter((u) => u.status === "invited").length,
    admins: users.filter((u) => u.roles.includes("admin")).length,
  };

  const toggleAll = () => {
    if (selected.size === filtered.length) setSelected(new Set());
    else setSelected(new Set(filtered.map((u) => u.id)));
  };
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next);
  };
  const allChecked = selected.size > 0 && selected.size === filtered.length;
  const someChecked = selected.size > 0 && selected.size < filtered.length;

  const statusBadge = (s: string) => {
    if (s === "active") return <Badge variant="default">active</Badge>;
    if (s === "invited") return <Badge variant="outline">invited</Badge>;
    if (s === "suspended") return <Badge variant="destructive">suspended</Badge>;
    return <Badge variant="secondary">{s}</Badge>;
  };

  const bulk = async (verb: "delete" | "suspend" | "activate") => {
    const ids = [...selected];
    try {
      if (verb === "delete") {
        await Promise.allSettled(ids.map((id) => usersApi.remove(id)));
        setUsers((arr) => arr.filter((u) => !selected.has(u.id)));
      } else if (verb === "suspend") {
        await Promise.allSettled(ids.map((id) => usersApi.suspend(id)));
        setUsers((arr) =>
          arr.map((u) => (selected.has(u.id) ? { ...u, status: "suspended", sessions: 0 } : u)),
        );
      } else if (verb === "activate") {
        await Promise.allSettled(ids.map((id) => usersApi.activate(id)));
        setUsers((arr) => arr.map((u) => (selected.has(u.id) ? { ...u, status: "active" } : u)));
      }
      pushToast(`${verb === "delete" ? "Deleted" : verb === "suspend" ? "Suspended" : "Activated"} ${ids.length} user${ids.length === 1 ? "" : "s"}.`);
    } catch (e) {
      pushToast((e as Error).message);
    }
    setSelected(new Set());
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <PageHeader
        title="Users"
        description="The first user to sign up becomes admin; everyone else lands in authenticated. Sessions, providers, and 2FA are tracked per account."
        actions={<Button variant="primary" icon={I.Plus} onClick={() => setInviteOpen(true)}>Invite</Button>}
      />

      <div className="users-stats">
        {[
          { label: "Total users", value: stats.total, hint: `${users.filter((u) => u.status === "active").length} active` },
          { label: "Active in 24h", value: stats.active24h, hint: `${Math.round((stats.active24h / Math.max(1, stats.total)) * 100)}% of base` },
          { label: "Pending invites", value: stats.pending, hint: stats.pending ? "awaiting accept" : "none" },
          { label: "Admins", value: stats.admins, hint: "full access" },
        ].map((s) => (
          <div key={s.label} className="users-stat">
            <span className="users-stat-label">{s.label}</span>
            <span className="users-stat-value">{s.value}</span>
            <span className="users-stat-hint muted">{s.hint}</span>
          </div>
        ))}
      </div>

      <div className="filter-bar" style={{ gap: 10 }}>
        <div className="search-input" style={{ minWidth: 280, flex: "0 1 320px" }}>
          <I.Search size={14} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or email…" />
          {q && <button type="button" className="x" onClick={() => setQ("")}><I.X size={11} /></button>}
        </div>
        <div className="users-filter">
          <span className="muted">Role</span>
          <Select size="sm" value={roleFilter} onChange={setRoleFilter} style={{ width: 140 }}
            options={[{ value: "all", label: "All roles" }, { value: "admin", label: "admin" }, { value: "editor", label: "editor" }, { value: "authenticated", label: "authenticated" }]} />
        </div>
        <div className="users-filter">
          <span className="muted">Status</span>
          <Select size="sm" value={statusFilter} onChange={setStatusFilter} style={{ width: 140 }}
            options={[{ value: "all", label: "All statuses" }, { value: "active", label: "active" }, { value: "invited", label: "invited" }, { value: "suspended", label: "suspended" }]} />
        </div>
        <div className="users-filter">
          <span className="muted">Provider</span>
          <Select size="sm" value={providerFilter} onChange={setProviderFilter} style={{ width: 150 }}
            options={[{ value: "all", label: "All providers" }, { value: "password", label: "password" }, { value: "github", label: "github" }, { value: "google", label: "google" }, { value: "magic", label: "magic link" }]} />
        </div>
        <div className="spacer" />
        <span className="muted" style={{ fontSize: 12 }}>{filtered.length} of {users.length}</span>
      </div>

      {selected.size > 0 && (
        <div className="users-bulk">
          <Badge variant="default">{selected.size} selected</Badge>
          <span className="muted" style={{ fontSize: 12.5 }}>Apply to selection:</span>
          <Button size="sm" variant="outline" onClick={() => bulk("activate")}>Activate</Button>
          <Button size="sm" variant="outline" onClick={() => bulk("suspend")}>Suspend</Button>
          <Button size="sm" variant="outline" onClick={() => pushToast(`Reset link sent to ${selected.size} user${selected.size === 1 ? "" : "s"}.`)}>Reset password</Button>
          <Button size="sm" variant="outline" onClick={() => bulk("delete")} style={{ color: "var(--destructive)" }}>Delete</Button>
          <div className="spacer" />
          <button type="button" className="rb-rm" onClick={() => setSelected(new Set())} title="Clear selection"><I.X size={12} /></button>
        </div>
      )}

      <div className="card">
        <div className="table-scroll">
        <table className="table users-table">
          <thead>
            <tr>
              <th style={{ width: 36 }}>
                <Checkbox checked={allChecked} indeterminate={someChecked} onChange={toggleAll} />
              </th>
              <th>User</th>
              <th style={{ width: 200 }}>Role</th>
              <th style={{ width: 130 }}>Status</th>
              <th style={{ width: 140 }}>Provider</th>
              <th style={{ width: 70, textAlign: "center" }}>2FA</th>
              <th style={{ width: 120 }}>Last seen</th>
              <th style={{ width: 44 }}></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((u) => {
              const isOpen = menuOpen === u.id;
              return (
                <tr key={u.id} className={`users-row ${selected.has(u.id) ? "on" : ""}`} onClick={() => setActiveUser(u)}>
                  <td onClick={(e) => e.stopPropagation()}>
                    <Checkbox checked={selected.has(u.id)} onChange={() => toggle(u.id)} />
                  </td>
                  <td>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <div className="avatar users-avatar" style={{ background: `oklch(0.78 0.14 ${u.hue})`, color: `oklch(0.25 0.06 ${u.hue})` }}>{u.name.split(" ").map((p) => p[0]).slice(0, 2).join("")}</div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
                        <span style={{ fontSize: 13, fontWeight: 500 }}>{u.name}</span>
                        <span className="muted" style={{ fontSize: 11.5 }}>{u.email}</span>
                      </div>
                    </div>
                  </td>
                  <td>
                    <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                      {u.roles.map((r) => <Badge key={r} variant={r === "admin" ? "default" : "secondary"}>{r}</Badge>)}
                    </div>
                  </td>
                  <td>{statusBadge(u.status)}</td>
                  <td>
                    <span className="users-provider">
                      <ProviderGlyph kind={u.provider} />
                      <span style={{ fontSize: 12.5 }}>{PROVIDER_LABEL[u.provider]}</span>
                    </span>
                  </td>
                  <td style={{ textAlign: "center" }}>
                    {u.mfa
                      ? <span className="users-mfa on" title="2FA enabled"><I.Shield size={11} /> on</span>
                      : <span className="users-mfa off" title="2FA disabled">off</span>}
                  </td>
                  <td className="muted font-mono" style={{ fontSize: 11.5 }}>{u.last}</td>
                  <td style={{ textAlign: "right", position: "relative" }} onClick={(e) => e.stopPropagation()}>
                    <IconButton icon={I.More} onClick={(e: any) => { e.stopPropagation(); setMenuOpen(isOpen ? null : u.id); }} />
                    {isOpen && (
                      <div className="users-menu" onClick={(e) => e.stopPropagation()}>
                        <button onClick={() => { setActiveUser(u); setMenuOpen(null); }}><I.Eye size={12} />View profile</button>
                        <button onClick={() => { pushToast(`Reset link sent to ${u.email}.`); setMenuOpen(null); }}><I.Mail size={12} />Send reset link</button>
                        {u.status !== "suspended" ? (
                          <button onClick={async () => {
                            try { await usersApi.suspend(u.id); } catch (e) { pushToast((e as Error).message); }
                            setUsers((arr) => arr.map((x) => x.id === u.id ? { ...x, status: "suspended", sessions: 0 } : x));
                            setMenuOpen(null);
                            pushToast(`${u.email} suspended.`);
                          }}><I.Lock size={12} />Suspend</button>
                        ) : (
                          <button onClick={async () => {
                            try { await usersApi.activate(u.id); } catch (e) { pushToast((e as Error).message); }
                            setUsers((arr) => arr.map((x) => x.id === u.id ? { ...x, status: "active" } : x));
                            setMenuOpen(null);
                            pushToast(`${u.email} activated.`);
                          }}><I.Check size={12} />Activate</button>
                        )}
                        <div className="users-menu-sep" />
                        <button className="danger" onClick={async () => {
                          try { await usersApi.remove(u.id); } catch (e) { pushToast((e as Error).message); }
                          setUsers((arr) => arr.filter((x) => x.id !== u.id));
                          setMenuOpen(null);
                          pushToast(`${u.email} deleted.`);
                        }}><I.Trash size={12} />Delete</button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr><td colSpan={8}>
                <div className="empty" style={{ padding: "32px 0" }}>
                  <I.Users size={20} />
                  <h4>No users match</h4>
                  <p>Adjust your filters or invite a new teammate.</p>
                </div>
              </td></tr>
            )}
          </tbody>
        </table>
        </div>
      </div>

      {activeUser && <UserDrawer user={activeUser} onClose={() => setActiveUser(null)} pushToast={pushToast} />}
      {inviteOpen && <InviteUserDialog onClose={() => setInviteOpen(false)} onInvite={async (payload: any) => {
        try {
          await usersApi.invite(payload.email, payload.role);
          pushToast(`Invite sent to ${payload.email}.`);
        } catch (e) {
          pushToast((e as Error).message);
        }
        setInviteOpen(false);
      }} />}
    </div>
  );
}

function UserDrawer({ user, onClose, pushToast }: { user: any; onClose: () => void; pushToast: (m: string) => void }) {
  // Live sessions for this user — pulled from /api/users/:id/sessions which
  // surfaces sessions.user_agent + sessions.ip_address. Falls back to a
  // single placeholder row when the API returns nothing.
  const [sessions, setSessions] = useState<any[]>([]);
  // Real activity rows for this user (admin sees all; non-admin would only
  // see their own rows by virtue of the activity route's permission gate).
  const [activity, setActivity] = useState<{ t: string; ev: string; meta: string }[]>([]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch(`/api/users/${encodeURIComponent(user.id)}/sessions`, { credentials: "include" });
        if (!r.ok || cancelled) return;
        const j = (await r.json()) as { data?: any[] };
        const fmtAgo = (ms: number | null): string => {
          if (!ms) return "—";
          const d = Date.now() - ms;
          if (d < 60_000) return "just now";
          if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
          if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
          return `${Math.floor(d / 86_400_000)}d ago`;
        };
        setSessions(
          (j.data ?? []).map((s, i) => ({
            id: s.id ?? `s${i}`,
            device: s.userAgent ?? "Unknown device",
            ip: s.ipAddress ?? "—",
            last: fmtAgo(s.updatedAt ?? s.createdAt ?? null),
            current: i === 0,
          })),
        );
      } catch {
        // leave empty
      }
    })();
    void (async () => {
      try {
        const r = await fetch(`/api/activity?limit=20`, { credentials: "include" });
        if (!r.ok || cancelled) return;
        const j = (await r.json()) as { data?: any[] };
        const filtered = (j.data ?? []).filter((a) => a.userId === user.id || a.user_id === user.id);
        setActivity(
          filtered.slice(0, 6).map((a) => ({
            t: new Date(a.createdAt ?? a.created_at).toISOString().slice(0, 16).replace("T", " "),
            ev: `${a.collection ?? "?"}.${a.action}`,
            meta: a.itemId ? `id ${String(a.itemId).slice(0, 12)}` : "—",
          })),
        );
      } catch {
        // leave empty
      }
    })();
    return () => { cancelled = true; };
  }, [user.id]);

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="sheet" role="dialog" aria-modal="true">
        <div className="sheet-header">
          <div style={{ display: "flex", gap: 12, alignItems: "center", flex: 1, minWidth: 0 }}>
            <div className="avatar" style={{ width: 40, height: 40, fontSize: 14, background: `oklch(0.78 0.14 ${user.hue})`, color: `oklch(0.25 0.06 ${user.hue})` }}>{user.name.split(" ").map((p: string) => p[0]).slice(0, 2).join("")}</div>
            <div style={{ minWidth: 0 }}>
              <h2 style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {user.name}
                {user.status === "active" && <Badge variant="default">active</Badge>}
                {user.status === "invited" && <Badge variant="outline">invited</Badge>}
                {user.status === "suspended" && <Badge variant="destructive">suspended</Badge>}
              </h2>
              <p>{user.email} · id <span className="font-mono">{user.id}</span></p>
            </div>
          </div>
          <IconButton icon={I.X} onClick={onClose} title="Close" />
        </div>

        <div className="sheet-body">
          <div className="user-facts">
            <div><span className="muted">Roles</span><div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>{user.roles.map((r: string) => <Badge key={r} variant={r === "admin" ? "default" : "secondary"}>{r}</Badge>)}</div></div>
            <div><span className="muted">Provider</span><span className="users-provider"><ProviderGlyph kind={user.provider} size={12} />{PROVIDER_LABEL[user.provider]}</span></div>
            <div><span className="muted">2FA</span>{user.mfa ? <span className="users-mfa on"><I.Shield size={11} /> enrolled</span> : <span className="users-mfa off">disabled</span>}</div>
            <div><span className="muted">Created</span><span className="font-mono" style={{ fontSize: 12 }}>{user.created}</span></div>
            <div><span className="muted">Last seen</span><span className="font-mono" style={{ fontSize: 12 }}>{user.lastIso || "—"}</span></div>
            <div><span className="muted">Sessions</span><span className="font-mono" style={{ fontSize: 12 }}>{user.sessions} active</span></div>
          </div>

          <div>
            <div className="user-section-head">
              <span>Active sessions</span>
              <span className="muted">{sessions.length}</span>
            </div>
            {sessions.length === 0 ? (
              <div className="user-empty">No active sessions.</div>
            ) : (
              <div className="user-list">
                {sessions.map((s) => (
                  <div key={s.id} className="user-list-row">
                    <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                      <span style={{ fontSize: 12.5, fontWeight: 500, display: "flex", gap: 6, alignItems: "center" }}>
                        {s.device}
                        {s.current && <Badge variant="outline">this device</Badge>}
                      </span>
                      <span className="muted font-mono" style={{ fontSize: 11.5 }}>{s.ip} · last seen {s.last}</span>
                    </div>
                    <Button size="sm" variant="ghost" onClick={() => pushToast(`Session revoked: ${s.device}`)}>Revoke</Button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div>
            <div className="user-section-head">
              <span>Recent activity</span>
              <span className="muted">last 30 days</span>
            </div>
            <div className="user-list">
              {activity.map((a, i) => (
                <div key={i} className="user-list-row">
                  <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                    <span className="font-mono" style={{ fontSize: 12 }}>{a.ev}</span>
                    <span className="muted" style={{ fontSize: 11.5 }}>{a.meta}</span>
                  </div>
                  <span className="muted font-mono" style={{ fontSize: 11.5 }}>{a.t}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="user-danger">
            <div className="user-section-head"><span>Danger zone</span></div>
            <div className="user-danger-row">
              <div>
                <div style={{ fontSize: 12.5, fontWeight: 500 }}>Send password reset</div>
                <div className="muted" style={{ fontSize: 11.5 }}>Emails a one-time link valid for 30 minutes.</div>
              </div>
              <Button size="sm" variant="outline" onClick={async () => {
                try { await usersApi.invite(user.email, "authenticated"); } catch (e) { pushToast((e as Error).message); }
                pushToast(`Reset link sent to ${user.email}.`);
              }}>Send</Button>
            </div>
            <div className="user-danger-row">
              <div>
                <div style={{ fontSize: 12.5, fontWeight: 500 }}>Revoke all sessions</div>
                <div className="muted" style={{ fontSize: 11.5 }}>Forces re-login on every device immediately.</div>
              </div>
              <Button size="sm" variant="outline" onClick={async () => {
                try { await usersApi.revokeAll(user.id); } catch (e) { pushToast((e as Error).message); }
                pushToast(`Sessions revoked for ${user.email}.`);
              }}>Revoke</Button>
            </div>
            <div className="user-danger-row">
              <div>
                <div style={{ fontSize: 12.5, fontWeight: 500, color: "var(--destructive)" }}>Delete user</div>
                <div className="muted" style={{ fontSize: 11.5 }}>Permanent. Owned items remain; ownership is reassigned to admin.</div>
              </div>
              <Button size="sm" variant="outline" style={{ color: "var(--destructive)" }} onClick={async () => {
                try { await usersApi.remove(user.id); } catch (e) { pushToast((e as Error).message); }
                pushToast(`${user.email} deleted.`);
                onClose();
              }}>Delete</Button>
            </div>
          </div>
        </div>

        <div className="sheet-footer">
          <Button variant="ghost" onClick={onClose}>Close</Button>
          <Button variant="primary" onClick={() => pushToast("Profile saved.")}>Save changes</Button>
        </div>
      </div>
    </>
  );
}

function InviteUserDialog({ onClose, onInvite }: { onClose: () => void; onInvite: (data: any) => void }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("authenticated");
  const [provider, setProvider] = useState("password");
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog-lg" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()} style={{ width: 460, maxWidth: "92vw" }}>
        <div className="sheet-header" style={{ borderBottom: "1px solid var(--border)" }}>
          <div style={{ flex: 1 }}>
            <h2>Invite user</h2>
            <p>Send an email invite. The user finishes signup themselves.</p>
          </div>
          <IconButton icon={I.X} onClick={onClose} title="Close" />
        </div>
        <div className="dialog-body">
          <div className="field">
            <label className="field-label">Email</label>
            <input className="input" autoFocus placeholder="teammate@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
            <span className="field-hint">An invite link will be emailed; valid for 7 days.</span>
          </div>
          <div className="field">
            <label className="field-label">Default role</label>
            <Select value={role} onChange={setRole}
              options={[{ value: "authenticated", label: "authenticated", hint: "standard signed-in user" }, { value: "editor", label: "editor", hint: "can publish + manage content" }, { value: "admin", label: "admin", hint: "full access" }]} />
          </div>
          <div className="field">
            <label className="field-label">Sign-in method</label>
            <Select value={provider} onChange={setProvider}
              options={[{ value: "password", label: "password", hint: "set on first login" }, { value: "magic", label: "magic link", hint: "email-only, no password" }, { value: "github", label: "github SSO", hint: "OAuth required" }, { value: "google", label: "google SSO", hint: "OAuth required" }]} />
          </div>
        </div>
        <div className="sheet-footer">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!valid} onClick={() => onInvite({ email, role, provider })}>Send invite</Button>
        </div>
      </div>
    </div>
  );
}

export function ApiKeysPage({ pushToast }: { pushToast: (m: string) => void }) {
  type KeyRow = { id: string; prefix: string; name: string; user: string; created: string; lastUsed: string };
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const reloadKeys = async () => {
    const r = await fetchSafely<{ data: any[] }>("/api/api-keys");
    if (Array.isArray(r?.data)) {
      setKeys(
        r.data.map((k) => ({
          id: k.id,
          prefix: k.prefix,
          name: k.name,
          user: k.userId ?? "—",
          created: k.createdAt ? String(k.createdAt).slice(0, 10) : "—",
          lastUsed: k.lastUsedAt ? "—" : "never",
        })),
      );
    }
  };
  useEffect(() => { void reloadKeys(); }, []);
  const [revealed, setRevealed] = useState<string | null>(null);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <PageHeader
        title="API keys"
        description="pak_<8-hex prefix>_<32-hex secret>. Only the SHA-256 of the secret is stored; the plaintext is shown once."
        actions={<Button variant="primary" icon={I.Plus} onClick={async () => {
          try {
            // Backend returns the plaintext as `secret` (and a `warning` we
            // surface in the reveal pane). Older drafts of the UI read
            // `key` — that field never existed, so reveal silently failed.
            const r = await api<{ data: { id: string; secret: string; prefix: string; name: string } }>("/api/api-keys", {
              method: "POST",
              body: JSON.stringify({ name: "New key" }),
            });
            setRevealed(r.data.secret);
            await reloadKeys();
          } catch (e) {
            pushToast((e as Error).message);
          }
        }}>Create key</Button>}
      />
      {revealed && (
        <div className="card" style={{ borderColor: "color-mix(in oklch, var(--primary) 50%, var(--border))", background: "color-mix(in oklch, var(--primary) 8%, var(--card))" }}>
          <div style={{ padding: 16, display: "flex", alignItems: "center", gap: 12 }}>
            <I.Info size={16} />
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 13, fontWeight: 500 }}>Copy this now — it will not be shown again.</span>
              <span className="font-mono" style={{ fontSize: 12.5, padding: "4px 8px", background: "var(--background)", borderRadius: "var(--radius-md)", border: "1px solid var(--border)" }}>{revealed}</span>
            </div>
            <div className="spacer" />
            <Button variant="outline" size="sm" onClick={() => { navigator.clipboard?.writeText(revealed); pushToast("Key copied to clipboard."); }}>Copy</Button>
            <IconButton icon={I.X} onClick={() => setRevealed(null)} />
          </div>
        </div>
      )}
      <div className="card">
        <div className="table-scroll">
        <table className="table">
          <thead><tr><th>Name</th><th style={{ width: 200 }}>Prefix</th><th style={{ width: 200 }}>User</th><th style={{ width: 120 }}>Created</th><th style={{ width: 120 }}>Last used</th><th style={{ width: 60 }}></th></tr></thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k.id}>
                <td style={{ fontSize: 13, fontWeight: 500 }}>{k.name}</td>
                <td className="font-mono" style={{ fontSize: 12 }}>{k.prefix}<span className="muted">_••••••••••••••••</span></td>
                <td>{k.user}</td>
                <td className="muted font-mono" style={{ fontSize: 11.5 }}>{k.created}</td>
                <td className="muted font-mono" style={{ fontSize: 11.5 }}>{k.lastUsed}</td>
                <td style={{ textAlign: "right" }}><IconButton icon={I.Trash} title="Revoke" onClick={async () => {
                  try { await api(`/api/api-keys/${k.id}`, { method: "DELETE" }); } catch (e) { pushToast((e as Error).message); }
                  setKeys((arr) => arr.filter((x) => x.id !== k.id));
                  pushToast(`${k.prefix} revoked.`);
                }} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>
    </div>
  );
}

export function SettingsPage({ adapter, pushToast }: { adapter: AdapterId; pushToast: (m: string) => void }) {
  const [tab, setTab] = useState("general");
  const [appUrl, setAppUrl] = useState("http://localhost:8787");
  const [siteName, setSiteName] = useState("workeros");
  const [from, setFrom] = useState("hello@example.com");
  const [signupOpen, setSignupOpen] = useState(false);
  const [telemetry, setTelemetry] = useState(false);
  const [dirty, setDirty] = useState(false);
  // Hydrate the General-tab form from /api/admin/settings on mount. The
  // backend merges defaults from env (APP_URL, EMAIL_FROM) so a fresh
  // workspace lands with the actual deploy URL pre-filled.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await settingsApi.load();
        if (cancelled) return;
        const d = r.data as Record<string, unknown>;
        if (typeof d.siteName === "string") setSiteName(d.siteName);
        if (typeof d.appUrl === "string") setAppUrl(d.appUrl);
        if (typeof d.emailFrom === "string") setFrom(d.emailFrom);
        if (typeof d.openSignup === "boolean") setSignupOpen(d.openSignup);
        if (typeof d.telemetry === "boolean") setTelemetry(d.telemetry);
      } catch {
        // keep seed
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const [bindings, setBindings] = useState<{ id: number; type: string; name: string; target: string; status: string; warn: string | undefined }[]>([]);
  const [envVars, setEnvVars] = useState<{ id: number | string; key: string; value: string; secret: boolean; source: string }[]>([]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await settingsApi.runtime();
        if (cancelled) return;
        const rt = r.data as ApiRuntime;
        setBindings(
          rt.bindings.map((b, i) => ({
            id: i + 1,
            type: b.type,
            name: b.name,
            target: b.target,
            status: b.status,
            warn: b.status === "optional" ? `${b.name} unbound` : undefined,
          })),
        );
        setEnvVars(
          rt.envVars.map((v, i) => ({
            id: i + 1,
            key: v.key,
            value: v.set ? (v.secret ? "••••••••" : "set") : "(unset)",
            secret: v.secret,
            source: v.source,
          })),
        );
      } catch {
        // keep seed
      }
    })();
    return () => { cancelled = true; };
  }, []);
  const persistGeneral = async () => {
    try {
      await settingsApi.patch({
        siteName,
        appUrl,
        emailFrom: from,
        openSignup,
        telemetry,
      });
      setDirty(false);
      pushToast("Settings saved.");
    } catch (e) {
      pushToast((e as Error).message);
    }
  };
  const [revealed, setRevealed] = useState<Record<number, boolean>>({});
  const [newKey, setNewKey] = useState("");
  const [newVal, setNewVal] = useState("");
  const [newSecret, setNewSecret] = useState(true);

  const addEnv = async () => {
    const k = newKey.trim().toUpperCase();
    if (!k) return;
    try {
      await settingsApi.patch({ [`env.${k}`]: newSecret ? "(secret)" : newVal });
    } catch (e) {
      pushToast((e as Error).message);
    }
    setEnvVars((arr) => [...arr, { id: Date.now(), key: k, value: newSecret ? "••••••••" : newVal, secret: newSecret, source: newSecret ? "wrangler secret" : "wrangler.toml" }]);
    setNewKey(""); setNewVal(""); setDirty(true);
    pushToast(`${k} added.`);
  };
  const removeEnv = async (id: number | string) => {
    const target = envVars.find((x) => x.id === id);
    if (target) {
      try {
        await settingsApi.patch({ [`env.${target.key}`]: null });
      } catch (e) {
        pushToast((e as Error).message);
      }
    }
    setEnvVars((arr) => arr.filter((x) => x.id !== id));
    setDirty(true);
  };

  const bindingIcon = (t: string): IconComponent => (({ D1: I.Database, KV: I.Folder, R2: I.Server, DurableObj: I.Bolt, Queue: I.Webhook, AI: I.Bolt } as Record<string, IconComponent>)[t] || I.Folder);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <PageHeader title="Settings" description="Self-hosted on Cloudflare Workers. Most config lives in wrangler.toml; this page is a live view + UI for runtime-mutable values." />
      <div className="ce-tabs">
        {[
          { id: "general", label: "General", hint: "app · auth" },
          { id: "bindings", label: "Bindings", hint: `${bindings.length}` },
          { id: "env", label: "Environment", hint: `${envVars.length}` },
          { id: "about", label: "About", hint: "v0.9.4" },
        ].map((t) => (
          <button key={t.id} type="button" className={`ce-tab ${tab === t.id ? "on" : ""}`} onClick={() => setTab(t.id)}>
            <span>{t.label}</span>
            <span className="ce-tab-count">{t.hint}</span>
          </button>
        ))}
      </div>

      {tab === "general" && (
        <div className="card" style={{ padding: 22, display: "flex", flexDirection: "column", gap: 16, maxWidth: 720 }}>
          <div className="field"><label className="field-label">Site name</label><input className="input" value={siteName} onChange={(e) => { setSiteName(e.target.value); setDirty(true); }} /><span className="field-hint">Shown in the sidebar and email templates.</span></div>
          <div className="field"><label className="field-label">APP_URL</label><input className="input" value={appUrl} onChange={(e) => { setAppUrl(e.target.value); setDirty(true); }} /><span className="field-hint">Public origin of this Worker. Used for OAuth callbacks and absolute links.</span></div>
          <div className="field"><label className="field-label">EMAIL_FROM</label><input className="input" value={from} onChange={(e) => { setFrom(e.target.value); setDirty(true); }} /></div>
          <div className="field-row" style={{ borderTop: "1px solid var(--border)", paddingTop: 14 }}>
            <div>
              <div className="field-label">Open sign-up</div>
              <div className="field-hint">When off, only invited emails can sign up.</div>
            </div>
            <Switch checked={signupOpen} onChange={(v) => { setSignupOpen(v); setDirty(true); }} />
          </div>
          <div className="field-row">
            <div>
              <div className="field-label">Anonymous telemetry</div>
              <div className="field-hint">Send aggregated, opt-in usage counts to help prioritise OSS work. No content or identifiers.</div>
            </div>
            <Switch checked={telemetry} onChange={(v) => { setTelemetry(v); setDirty(true); }} />
          </div>
          <div className="field-row">
            <div>
              <div className="field-label">Runtime</div>
              <div className="field-hint">Auto-detected from <span className="font-mono">env</span> bindings.</div>
            </div>
            <span className="adapter-pill"><span className="dot" />{adapter}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, paddingTop: 6 }}>
            <Button variant="ghost" size="sm" disabled={!dirty} onClick={() => setDirty(false)}>Discard</Button>
            <Button variant="primary" size="sm" disabled={!dirty} onClick={persistGeneral}>Save</Button>
          </div>
        </div>
      )}

      {tab === "bindings" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 920 }}>
          <div className="card" style={{ padding: 14, display: "flex", alignItems: "flex-start", gap: 10, background: "var(--muted)" }}>
            <I.Info size={14} style={{ marginTop: 2 }} />
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <span style={{ fontSize: 12.5, fontWeight: 500 }}>Bindings are read-only here</span>
              <span className="muted" style={{ fontSize: 12 }}>Edit them in <span className="font-mono" style={{ color: "var(--foreground)" }}>wrangler.toml</span> and redeploy. This panel reflects the live binding map from <span className="font-mono" style={{ color: "var(--foreground)" }}>env</span>.</span>
            </div>
          </div>
          <div className="card">
            <div className="card-section" style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <I.Server size={14} /><span style={{ fontSize: 13, fontWeight: 500 }}>worker bindings</span>
              <span className="font-mono muted" style={{ fontSize: 12 }}>{bindings.filter((b) => b.status === "connected").length} connected · {bindings.filter((b) => b.status !== "connected").length} optional</span>
              <div className="spacer" />
              <Button variant="ghost" size="sm" icon={I.Refresh} onClick={() => pushToast("Bindings refreshed.")}>Refresh</Button>
            </div>
            <div className="table-scroll">
            <div className="schema-row" style={{ gridTemplateColumns: "24px 110px 160px 1fr 120px", background: "var(--muted)", fontSize: 11, color: "var(--muted-foreground)", textTransform: "uppercase", letterSpacing: 0.4 }}>
              <span></span><span>Type</span><span>Name</span><span>Resource</span><span>Status</span>
            </div>
            {bindings.map((b) => {
              const Ic = bindingIcon(b.type);
              return (
                <div key={b.id} className="schema-row" style={{ gridTemplateColumns: "24px 110px 160px 1fr 120px" }}>
                  <span><Ic size={14} /></span>
                  <span className="font-mono" style={{ fontSize: 12.5 }}>{b.type}</span>
                  <span className="font-mono" style={{ fontSize: 13 }}>{b.name}</span>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                    <span className="font-mono muted" style={{ fontSize: 12 }}>{b.target}</span>
                    {b.warn && <span className="muted" style={{ fontSize: 11.5 }}>· {b.warn}</span>}
                  </div>
                  <span>
                    {b.status === "connected" && <Badge variant="default">connected</Badge>}
                    {b.status === "optional" && <Badge variant="secondary">unbound</Badge>}
                  </span>
                </div>
              );
            })}
            </div>
          </div>
          <div className="card" style={{ padding: 16 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <I.Code size={13} />
              <span style={{ fontSize: 12.5, fontWeight: 500 }}>wrangler.toml snippet</span>
            </div>
            <pre className="alter-preview" style={{ fontSize: 11.5, margin: 0, whiteSpace: "pre-wrap" }}>{`[[d1_databases]]
binding = "DB"
database_name = "workeros-db"

[[kv_namespaces]]
binding = "CACHE"
id = "…"

[[r2_buckets]]
binding = "ASSETS"
bucket_name = "workeros-assets"`}</pre>
          </div>
        </div>
      )}

      {tab === "env" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 920 }}>
          <div className="card">
            <div className="card-section" style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <I.Lock size={14} /><span style={{ fontSize: 13, fontWeight: 500 }}>environment</span>
              <span className="font-mono muted" style={{ fontSize: 12 }}>{envVars.filter((v) => v.secret).length} secret · {envVars.filter((v) => !v.secret).length} plain</span>
              <div className="spacer" />
              <input className="input" placeholder="KEY" value={newKey} onChange={(e) => setNewKey(e.target.value.toUpperCase())} style={{ height: 30, width: 160, fontSize: 12.5 }} />
              <input className="input" placeholder={newSecret ? "(write-only)" : "value"} value={newVal} onChange={(e) => setNewVal(e.target.value)} disabled={newSecret} style={{ height: 30, width: 200, fontSize: 12.5 }} />
              <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12 }}>
                <Checkbox checked={newSecret} onChange={setNewSecret} /> secret
              </label>
              <Button variant="primary" size="sm" icon={I.Plus} onClick={addEnv}>Add</Button>
            </div>
            <div className="table-scroll">
            <div className="schema-row" style={{ gridTemplateColumns: "24px 200px 1fr 160px 32px", background: "var(--muted)", fontSize: 11, color: "var(--muted-foreground)", textTransform: "uppercase", letterSpacing: 0.4 }}>
              <span></span><span>Key</span><span>Value</span><span>Source</span><span></span>
            </div>
            {envVars.map((v) => (
              <div key={v.id} className="schema-row" style={{ gridTemplateColumns: "24px 200px 1fr 160px 32px" }}>
                <span>{v.secret ? <I.Lock size={13} /> : <I.Hash size={13} />}</span>
                <span className="font-mono" style={{ fontSize: 12.5 }}>{v.key}</span>
                <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                  <span className="font-mono muted" style={{ fontSize: 12 }}>{v.secret && !revealed[v.id] ? "••••••••••••" : v.value}</span>
                  {v.secret && (
                    <IconButton icon={I.Eye} title={revealed[v.id] ? "Hide" : "Reveal"} onClick={() => setRevealed((r) => ({ ...r, [v.id]: !r[v.id] }))} />
                  )}
                </div>
                <span className="font-mono muted" style={{ fontSize: 11.5 }}>{v.source}</span>
                <IconButton icon={I.Trash} title="Remove" onClick={() => removeEnv(v.id)} />
              </div>
            ))}
            </div>
          </div>
          <div className="card" style={{ padding: 14, display: "flex", alignItems: "flex-start", gap: 10, background: "var(--muted)" }}>
            <I.Info size={14} style={{ marginTop: 2 }} />
            <span className="muted" style={{ fontSize: 12 }}>Secret values can't be read back from Cloudflare — they're write-only after the initial <span className="font-mono" style={{ color: "var(--foreground)" }}>wrangler secret put</span>. Reveal toggles only the local cache.</span>
          </div>
        </div>
      )}

      {tab === "about" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 720 }}>
          <div className="card" style={{ padding: 22, display: "flex", flexDirection: "column", gap: 12 }}>
            {[
              ["Version", "v0.9.4 (a8b2f1c)"],
              ["Released", "2025-10-12"],
              ["Runtime", adapter],
              ["Wrangler", "3.78.0"],
              ["License", "MIT"],
              ["Repository", "github.com/workeros/workeros"],
            ].map(([k, v]) => (
              <div key={k} className="field-row" style={{ paddingTop: 0 }}>
                <span className="field-label" style={{ marginBottom: 0 }}>{k}</span>
                <span className="font-mono muted" style={{ fontSize: 12.5 }}>{v}</span>
              </div>
            ))}
          </div>
          <div className="card" style={{ padding: 18, display: "flex", alignItems: "center", gap: 10 }}>
            <I.Shield size={14} />
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <span style={{ fontSize: 13, fontWeight: 500 }}>Open-source · MIT licensed</span>
              <span className="muted" style={{ fontSize: 12 }}>Self-hosted on Cloudflare Workers. No telemetry, no billing — just clone, deploy, run.</span>
            </div>
            <div className="spacer" />
            <Button variant="outline" size="sm" icon={I.Code}>GitHub</Button>
            <Button variant="ghost" size="sm" icon={I.Folder}>Docs</Button>
          </div>
        </div>
      )}
    </div>
  );
}
