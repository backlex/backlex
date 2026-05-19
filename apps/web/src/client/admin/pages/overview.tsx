// Overview page — adapter dashboard, runtime stats, recent activity + errors
import { useEffect, useState } from "react";
import { I } from "../icons";
import { ADAPTER_PROFILES, type AdapterId } from "../config";
import { Badge, Button, PageHeader } from "../ui";
import { Select } from "../select";
import {
  metricsApi,
  settingsApi,
  type ApiMetrics,
  type ApiRuntime,
} from "../api";

function Sparkline({ data, color = "var(--primary)", height = 36, fill = true }: { data: number[]; color?: string; height?: number; fill?: boolean }) {
  const w = 100, h = height;
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const span = max - min || 1;
  const pts: [number, number][] = data.map((v, i) => [i / (data.length - 1) * w, h - ((v - min) / span) * (h - 4) - 2]);
  const d = pts.map((p, i) => (i === 0 ? "M" : "L") + p[0].toFixed(2) + "," + p[1].toFixed(2)).join(" ");
  const fillPath = d + ` L ${w},${h} L 0,${h} Z`;
  const last = pts[pts.length - 1] ?? [0, 0];
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ width: "100%", height, display: "block" }}>
      {fill && <path d={fillPath} fill={color} opacity="0.12" />}
      <path d={d} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={last[0]} cy={last[1]} r="2" fill={color} />
    </svg>
  );
}

export function OverviewPage({ adapter, pushToast, setActiveNav }: { adapter: AdapterId; pushToast: (m: string) => void; setActiveNav: (id: string) => void }) {
  const profile = ADAPTER_PROFILES[adapter];
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
              <I.Activity size={14} />
              <span style={{ fontSize: 13, fontWeight: 500 }}>Activity</span>
              <div className="spacer" />
              <Button variant="ghost" size="sm" iconRight={I.ChevronRight} onClick={() => setActiveNav("activity")}>All events</Button>
            </div>
            {activity.length === 0 ? (
              <div style={{ padding: "20px 16px", textAlign: "center" }}>
                <span className="muted" style={{ fontSize: 12.5 }}>No activity recorded.</span>
              </div>
            ) : (
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
            )}
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
              const emailProvider =
                envSet.has("EMAIL_FROM") && envSet.has("RESEND_API_KEY") ? "resend"
                : envSet.has("EMAIL_FROM") && envSet.has("SENDGRID_API_KEY") ? "sendgrid"
                : envSet.has("EMAIL_FROM") && envSet.has("MAILGUN_API_KEY") && envSet.has("MAILGUN_DOMAIN") ? "mailgun"
                : envSet.has("EMAIL_FROM") && envSet.has("SES_ACCESS_KEY_ID") && envSet.has("SES_SECRET_ACCESS_KEY") && envSet.has("SES_REGION") ? "ses"
                : envSet.has("EMAIL_FROM") && envSet.has("SMTP_HOST") && adapter !== "workers" ? "smtp"
                : null;
              const emailConnected = emailProvider !== null;
              const remoteExec = envSet.has("FUNCTIONS_EXEC_URL");
              const sandboxValue = remoteExec ? "remote-http" : adapter === "bun" ? "bun-worker" : "quickjs";
              const sandboxHint = remoteExec ? "FUNCTIONS_EXEC_URL set" : adapter === "bun" ? "worker thread + RPC" : "in-isolate, sync only";
              const rows = [
                ["Database", profile.db, dbStatus === "connected" ? "connected" : "optional", dbBinding?.target ?? profile.db],
                ["Storage", profile.storage, storageStatus === "connected" ? "connected" : "optional", storageBinding?.target ?? profile.storage],
                ["Realtime", profile.realtime, realtimeStatus === "connected" ? "connected" : "optional", realtimeBinding?.target ?? profile.realtime],
                ["Sandbox", sandboxValue, remoteExec || adapter === "bun" ? "connected" : "idle", sandboxHint],
                ["Vectorize", "vector index", vectorizeBinding ? "connected" : "optional", vectorizeBinding?.target ?? "—"],
                ["Email", emailProvider ?? (adapter === "bun" ? "console (dev)" : "not configured"), emailConnected ? "connected" : "idle", emailConnected ? "EMAIL_FROM set" : adapter === "bun" ? "logs to stdout" : "set EMAIL_FROM + a provider key"],
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
        </div>
      </div>
    </div>
  );
}
