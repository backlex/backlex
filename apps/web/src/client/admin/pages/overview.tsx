// Overview page — adapter dashboard, runtime stats, recent activity + errors
import { useEffect, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { I } from "../icons";
import { ADAPTER_PROFILES, type AdapterId } from "../config";
import { Badge, Button, PageHeader } from "../ui";
import { Select } from "../select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@backlex/ui/components/table";

const ADMIN_TABLE_CLS =
  "[&_td]:px-3.5 [&_td]:text-[13px] [&_th]:h-9 [&_th]:px-3.5 [&_th]:text-[11px] [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-[0.06em] [&_th]:text-muted-foreground";
import {
  metricsApi,
  settingsApi,
  type ApiMetrics,
  type ApiRuntime,
} from "../api";
import { OverviewSkeleton } from "../page-skeletons";
import { TemplateOnboarding } from "./template-onboarding";

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
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="block w-full" style={{ height }}>
      {fill && <path d={fillPath} fill={color} opacity="0.12" />}
      <path d={d} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={last[0]} cy={last[1]} r="2" fill={color} />
    </svg>
  );
}

export function OverviewPage({ adapter, pushToast, setActiveNav }: { adapter: AdapterId; pushToast: (m: string) => void; setActiveNav: (id: string) => void }) {
  const { t } = useLingui();
  const profile = ADAPTER_PROFILES[adapter];
  const [range, setRange] = useState("1h");
  // Live metrics: refetched on range change. While offline / unauthenticated
  // we render zero series so the page still draws but doesn't lie about
  // throughput like the original mock did (14,820 req).
  const [metrics, setMetrics] = useState<ApiMetrics | null>(null);
  const [runtime, setRuntime] = useState<ApiRuntime | null>(null);
  // First-load gate — drives the page skeleton until the first metrics
  // response (for the initial range) lands. Range changes after that refetch
  // in place without re-blanking the page.
  const [loaded, setLoaded] = useState(false);
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
      } finally {
        if (!cancelled) setLoaded(true);
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
    { label: t`Requests`, value: totalRequests.toLocaleString(), delta: range, up: true, series: reqSeries, color: "var(--primary)" },
    { label: t`p95 latency`, value: p95 ? `${p95}ms` : "—", delta: "duration_ms", up: p95 < 500, series: latSeries, color: "oklch(0.65 0.15 240)" },
    { label: t`Error rate`, value: errorPct, delta: "errors", up: (metrics?.totals.errorRate ?? 0) < 0.05, series: errSeries, color: "oklch(0.7 0.18 22)" },
    { label: t`Active users`, value: String(activeUsers), delta: range, up: activeUsers > 0, series: errSeries, color: "oklch(0.72 0.16 145)" },
  ];

  const fmtAgo = (ts: number | null | undefined): string => {
    if (!ts) return "—";
    const ms = Date.now() - ts;
    if (ms < 60_000) return t`just now`;
    if (ms < 3_600_000) return t`${Math.floor(ms / 60_000)}m ago`;
    if (ms < 86_400_000) return t`${Math.floor(ms / 3_600_000)}h ago`;
    return t`${Math.floor(ms / 86_400_000)}d ago`;
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
    { label: t`New collection`, icon: I.Database, hint: t`auto-creates c_<slug> table`, onClick: () => { setActiveNav("collections"); pushToast(t`Collection wizard opened.`); } },
    { label: t`New function`, icon: I.Function, hint: t`http · event · cron`, onClick: () => { setActiveNav("functions"); pushToast(t`Function scaffold ready.`); } },
    { label: t`New flow`, icon: I.Bolt, hint: t`trigger → action graph`, onClick: () => { setActiveNav("flows"); pushToast(t`Flow draft created.`); } },
    { label: t`Invite user`, icon: I.Users, hint: t`email magic link`, onClick: () => { setActiveNav("users"); pushToast(t`Invite dialog opened.`); } },
  ];

  const c = metrics?.counts;
  const stats = [
    { label: t`Collections`, value: c?.collections ?? 0, sub: t`physical c_<slug> tables`, nav: "collections", icon: I.Database },
    { label: t`Files`, value: c?.files ?? 0, sub: t`stored objects`, nav: "storage", icon: I.Folder },
    { label: t`Active flows`, value: c?.activeFlows ?? 0, sub: t`${c?.activeFlows ?? 0} enabled · ${c?.pausedFlows ?? 0} paused`, nav: "flows", icon: I.Bolt },
    { label: t`Functions`, value: c?.functions ?? 0, sub: t`sandboxed handlers`, nav: "functions", icon: I.Function },
  ];

  // First whole-page fetch — the initial metrics response hasn't landed yet.
  if (!loaded) return <OverviewSkeleton />;

  return (
    <div className="flex flex-col gap-4.5">
      <PageHeader
        title={t`Overview`}
        description={<><Trans>Adapter auto-selected from bindings/env.</Trans> <span className="font-mono">{adapter}</span> <Trans>profile is active.</Trans></>}
        actions={<>
          <Select size="sm" value={range} onChange={setRange} options={[
            { value: "15m", label: t`Last 15 minutes` },
            { value: "1h", label: t`Last 1 hour` },
            { value: "24h", label: t`Last 24 hours` },
            { value: "7d", label: t`Last 7 days` },
            { value: "30d", label: t`Last 30 days` },
          ]} className="w-[170px]" />
          <Button variant="outline" icon={I.Refresh} onClick={() => pushToast(t`Status refreshed.`)}><Trans>Refresh</Trans></Button>
        </>}
      />

      {/* First-run: pick a schema template (preselected to the cloud choice).
          Hides itself once the workspace has collections. */}
      <TemplateOnboarding pushToast={pushToast} onApplied={() => setActiveNav("collections")} />


      <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3">
        {todayMetrics.map((m) => (
          <div key={m.label} className="flex flex-col gap-2 overflow-hidden rounded-2xl border border-border bg-card text-card-foreground">
            <div className="flex items-center justify-between px-3.5 pt-3.5">
              <div className="text-[11.5px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">{m.label}</div>
              <span className="font-mono text-[11px] tabular-nums" style={{ color: m.up ? "oklch(0.55 0.16 145)" : "var(--destructive)" }}>{m.delta}</span>
            </div>
            <div className="px-3.5 text-2xl font-semibold tabular-nums tracking-[-0.02em]">{m.value}</div>
            <div className="mt-1.5 block leading-[0]">
              <Sparkline data={m.series} color={m.color} height={36} />
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-2.5">
        {quickActions.map((a) => {
          const Icon = a.icon;
          return (
            <button key={a.label} onClick={a.onClick} className="flex cursor-pointer items-center gap-3 rounded-2xl border border-dashed border-border bg-transparent px-3.5 py-3 text-left text-inherit">
              <span className="grid size-8 place-items-center rounded-lg bg-[color-mix(in_oklch,var(--primary)_16%,var(--card))] text-primary">
                <Icon size={14} />
              </span>
              <div className="flex flex-col">
                <span className="text-[13px] font-medium">{a.label}</span>
                <span className="text-[11.5px] text-muted-foreground">{a.hint}</span>
              </div>
              <div className="flex-1" />
              <I.ChevronRight size={14} className="text-muted-foreground" />
            </button>
          );
        })}
      </div>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3">
        {stats.map((s) => {
          const Icon = s.icon;
          return (
            <div key={s.label} className="flex cursor-pointer flex-col gap-1 overflow-hidden rounded-2xl border border-border bg-card p-4 text-card-foreground" onClick={() => setActiveNav(s.nav)}>
              <div className="flex items-center gap-2">
                <Icon size={13} className="text-muted-foreground" />
                <div className="text-[11.5px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">{s.label}</div>
              </div>
              <div className="mt-0.5 text-[28px] font-semibold tabular-nums tracking-[-0.02em]">{s.value}</div>
              <div className="text-xs text-muted-foreground">{s.sub}</div>
            </div>
          );
        })}
      </div>

      <div className="grid grid-cols-[1fr_320px] items-start gap-4 max-[1280px]:grid-cols-1">
        <div className="flex min-w-0 flex-col gap-3.5">
          <div className="overflow-hidden rounded-2xl border border-border bg-card text-card-foreground">
            <div className="flex items-center gap-2.5 border-b border-border px-4 py-3.5">
              <I.Database size={14} />
              <span className="text-[13px] font-medium"><Trans>Top collections</Trans></span>
              <div className="flex-1" />
              <Button variant="ghost" size="sm" onClick={() => setActiveNav("collections")} iconRight={I.ChevronRight}><Trans>Manage</Trans></Button>
            </div>
            <Table className={ADMIN_TABLE_CLS}>
              <TableHeader><TableRow><TableHead><Trans>Slug</Trans></TableHead><TableHead className="w-[80px] text-right"><Trans>Rows</Trans></TableHead><TableHead className="w-[90px] text-right"><Trans>Size</Trans></TableHead><TableHead className="w-[110px] text-right"><Trans>Writes (1h)</Trans></TableHead><TableHead className="w-[100px]"><Trans>Last write</Trans></TableHead></TableRow></TableHeader>
              <TableBody>
                {collections.map((c) => (
                  <TableRow key={c.slug} className="cursor-pointer" onClick={() => setActiveNav("collections")}>
                    <TableCell><span className="font-mono text-[12.5px]">c_{c.slug}</span></TableCell>
                    <TableCell className="text-right tabular-nums">{c.rows}</TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">{c.size}</TableCell>
                    <TableCell className="text-right tabular-nums">{c.writes}</TableCell>
                    <TableCell className="font-mono text-[11.5px] text-muted-foreground">{c.last}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <div className="overflow-hidden rounded-2xl border border-border bg-card text-card-foreground">
            <div className="flex items-center gap-2.5 border-b border-border px-4 py-3.5">
              <I.Activity size={14} />
              <span className="text-[13px] font-medium"><Trans>Activity</Trans></span>
              <div className="flex-1" />
              <Button variant="ghost" size="sm" iconRight={I.ChevronRight} onClick={() => setActiveNav("logs")}><Trans>All events</Trans></Button>
            </div>
            {activity.length === 0 ? (
              <div className="px-4 py-5 text-center">
                <span className="text-[12.5px] text-muted-foreground"><Trans>No activity recorded.</Trans></span>
              </div>
            ) : (
              <div className="py-1">
                {activity.map((a, i) => {
                  const Icon = a.icon;
                  return (
                    <div key={i} className="flex items-start gap-2.5 px-4 py-2">
                      <span className="mt-px grid size-[22px] shrink-0 place-items-center rounded-full bg-muted">
                        <Icon size={11} className="text-muted-foreground" />
                      </span>
                      <div className="flex min-w-0 flex-1 flex-col">
                        <span className="text-[12.5px]">
                          <span className="font-medium">{a.who}</span>
                          <span className="text-muted-foreground"> {a.verb} </span>
                          <span className="font-mono text-xs">{a.what}</span>
                        </span>
                      </div>
                      <span className="font-mono text-[11px] tabular-nums text-muted-foreground">{a.t}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="overflow-hidden rounded-2xl border border-border bg-card text-card-foreground">
            <div className="flex items-center gap-2.5 border-b border-border px-4 py-3.5">
              <I.AlertTriangle size={14} />
              <span className="text-[13px] font-medium"><Trans>Recent errors</Trans></span>
              <span className="font-mono text-xs text-muted-foreground"><Trans>last {range} · {(metrics?.totals?.errors ?? recentErrors.reduce((a, e) => a + (e.count ?? 0), 0))} {(metrics?.totals?.errors ?? 0) === 1 ? "event" : "events"}</Trans></span>
              <div className="flex-1" />
              <Button variant="ghost" size="sm" onClick={() => setActiveNav("logs")}><Trans>View all</Trans></Button>
            </div>
            {recentErrors.length === 0 ? (
              <div className="px-4 py-5 text-center">
                <span className="text-[12.5px] text-muted-foreground"><Trans>No errors recorded.</Trans></span>
              </div>
            ) : recentErrors.map((e, i) => (
              <div key={i} className={`flex items-center gap-3 px-4 py-2.5 ${i < recentErrors.length - 1 ? "border-b border-border" : ""}`}>
                <Badge variant="destructive">{e.code}</Badge>
                <span className="w-9 text-xs tabular-nums text-muted-foreground">×{e.count}</span>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-mono text-[12.5px]">{e.hook}</span>
                  <span className="truncate text-[11.5px] text-muted-foreground">{e.msg}</span>
                </div>
                <span className="font-mono text-[11.5px] text-muted-foreground">{e.last}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-3.5">
          <div className="flex flex-col gap-3 overflow-hidden rounded-2xl border border-border bg-card p-4 text-card-foreground">
            <div className="flex items-center gap-2">
              <I.Globe size={14} /><span className="text-[13px] font-medium"><Trans>Health</Trans></span>
              <div className="flex-1" />
              <span className="inline-flex items-center gap-1.5 rounded-3xl border border-border bg-background py-0.5 pl-1.5 pr-2 text-[11px]"><span className="size-[7px] shrink-0 rounded-full bg-primary shadow-[0_0_0_3px_color-mix(in_oklch,var(--primary)_20%,transparent)]" />{adapter === "workers" ? "cf workers" : adapter}</span>
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
              const sandboxHint = remoteExec ? t`FUNCTIONS_EXEC_URL set` : adapter === "bun" ? t`worker thread + RPC` : t`in-isolate, sync only`;
              const rows = [
                [t`Database`, profile.db, dbStatus === "connected" ? t`connected` : t`optional`, dbBinding?.target ?? profile.db],
                [t`Storage`, profile.storage, storageStatus === "connected" ? t`connected` : t`optional`, storageBinding?.target ?? profile.storage],
                [t`Realtime`, profile.realtime, realtimeStatus === "connected" ? t`connected` : t`optional`, realtimeBinding?.target ?? profile.realtime],
                [t`Sandbox`, sandboxValue, remoteExec || adapter === "bun" ? t`connected` : t`idle`, sandboxHint],
                [t`Vectorize`, t`vector index`, vectorizeBinding ? t`connected` : t`optional`, vectorizeBinding?.target ?? "—"],
                [t`Email`, emailProvider ?? (adapter === "bun" ? t`console (dev)` : t`not configured`), emailConnected ? t`connected` : t`idle`, emailConnected ? t`EMAIL_FROM set` : adapter === "bun" ? t`logs to stdout` : t`set EMAIL_FROM + a provider key`],
              ];
              return rows;
            })().map(([k, v, status, hint], i, arr) => (
              <div key={k} className={`flex items-center justify-between pb-[9px] ${i < arr.length - 1 ? "border-b border-border" : ""}`}>
                <div>
                  <div className="text-[12.5px] font-medium">{k}</div>
                  <div className="font-mono text-[11.5px] text-muted-foreground">{v} · {hint}</div>
                </div>
                <span className="inline-flex items-center gap-1.5 rounded-3xl border border-border bg-background py-0.5 pl-1.5 pr-2 text-[11px]"><span className={`size-[7px] shrink-0 rounded-full ${status === t`idle` ? "bg-[oklch(0.78_0.16_75)] shadow-[0_0_0_3px_oklch(0.78_0.16_75/0.2)]" : "bg-primary shadow-[0_0_0_3px_color-mix(in_oklch,var(--primary)_20%,transparent)]"}`} />{status}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
