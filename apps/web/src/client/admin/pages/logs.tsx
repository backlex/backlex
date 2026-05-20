// Logs page — multi-source structured log explorer.
//
// Visual + interaction parity with the design's parity-v2.jsx::LogsPage.
// Live/Resume + range chips are visual-only for now; rows ship inline as a
// const until a /api/admin/logs endpoint lands.
import { useMemo, useState } from "react";
import { I, type IconComponent, type IconKey } from "../icons";
import { Badge, Button, IconButton, PageHeader } from "../ui";
import { Input } from "@workeros/ui/components/input";

type LogLevel = "info" | "warn" | "error";

interface LogSource {
  id: string;
  label: string;
  icon: IconKey;
}

interface LogRow {
  id: string;
  t: string;
  src: string;
  level: LogLevel;
  status: number | null;
  method: string;
  path: string;
  ms: number;
  user: string;
  ip: string;
  msg: string;
}

// TODO(logs): replace with /api/admin/logs when the endpoint lands.
const LOG_SOURCES: LogSource[] = [
  { id: "http", label: "HTTP", icon: "ExternalLink" },
  { id: "db", label: "Database", icon: "Database" },
  { id: "auth", label: "Auth", icon: "Shield" },
  { id: "realtime", label: "Realtime", icon: "Zap" },
  { id: "functions", label: "Functions", icon: "Function" },
];

// TODO(logs): replace with /api/admin/logs when the endpoint lands.
const LOG_ROWS: LogRow[] = [
  // http
  { id: "l_001", t: "2026-05-19 14:32:11.221", src: "http", level: "info", status: 200, method: "GET", path: "/api/items/posts", ms: 18, user: "rana@workeros.dev", ip: "92.114.8.21", msg: "200 OK · 12 rows · meta=count" },
  { id: "l_002", t: "2026-05-19 14:32:10.987", src: "http", level: "info", status: 200, method: "POST", path: "/api/items/posts", ms: 42, user: "rana@workeros.dev", ip: "92.114.8.21", msg: "created 01HZ7K8M9NPR" },
  { id: "l_003", t: "2026-05-19 14:32:09.110", src: "http", level: "warn", status: 429, method: "POST", path: "/api/auth/sign-in/email", ms: 8, user: "-", ip: "45.12.3.180", msg: "rate limit · 6 attempts/60s" },
  { id: "l_004", t: "2026-05-19 14:32:07.504", src: "http", level: "error", status: 500, method: "POST", path: "/api/functions/reindex/invoke", ms: 1840, user: "priya@workeros.dev", ip: "92.114.8.21", msg: "sandbox timeout after 1500ms" },
  { id: "l_005", t: "2026-05-19 14:32:05.221", src: "http", level: "info", status: 200, method: "PATCH", path: "/api/items/posts/01HZ7K8Q6XYZ", ms: 23, user: "kai@workeros.dev", ip: "92.114.8.21", msg: "updated · 1 row" },
  { id: "l_006", t: "2026-05-19 14:32:01.802", src: "http", level: "info", status: 401, method: "GET", path: "/api/items/users", ms: 6, user: "-", ip: "104.18.32.4", msg: "missing bearer" },
  // db
  { id: "l_007", t: "2026-05-19 14:31:58.401", src: "db", level: "info", status: null, method: "SELECT", path: "c_posts", ms: 18, user: "rana@workeros.dev", ip: "-", msg: "SELECT id, title, status, view_count FROM c_posts ORDER BY updated_at DESC LIMIT 50" },
  { id: "l_008", t: "2026-05-19 14:31:54.001", src: "db", level: "warn", status: null, method: "SELECT", path: "c_comments", ms: 740, user: "system", ip: "-", msg: "slow query · no index on (post_id, created_at)" },
  { id: "l_009", t: "2026-05-19 14:31:50.110", src: "db", level: "info", status: null, method: "INSERT", path: "c_posts", ms: 5, user: "rana@workeros.dev", ip: "-", msg: "INSERT 1" },
  { id: "l_010", t: "2026-05-19 14:31:42.880", src: "db", level: "error", status: null, method: "ALTER", path: "c_orders", ms: 2200, user: "admin", ip: "-", msg: "ALTER TABLE c_orders ADD COLUMN tax decimal · constraint violated" },
  // auth
  { id: "l_011", t: "2026-05-19 14:31:38.220", src: "auth", level: "info", status: 200, method: "SIGNIN", path: "email", ms: 88, user: "kai@workeros.dev", ip: "92.114.8.21", msg: "session issued · ttl 30d" },
  { id: "l_012", t: "2026-05-19 14:31:30.118", src: "auth", level: "warn", status: 401, method: "SIGNIN", path: "oauth/github", ms: 212, user: "-", ip: "45.12.3.180", msg: "state mismatch" },
  { id: "l_013", t: "2026-05-19 14:31:11.901", src: "auth", level: "info", status: 200, method: "SIGNUP", path: "email", ms: 140, user: "new@example.com", ip: "77.88.55.21", msg: "user created · default role authenticated" },
  // realtime
  { id: "l_014", t: "2026-05-19 14:31:08.001", src: "realtime", level: "info", status: null, method: "SUB", path: "items:posts", ms: 2, user: "rana@workeros.dev", ip: "92.114.8.21", msg: "subscribed · 4 active" },
  { id: "l_015", t: "2026-05-19 14:30:58.443", src: "realtime", level: "info", status: null, method: "EMIT", path: "items:posts", ms: 1, user: "system", ip: "-", msg: "emit updated · 4 subscribers · 1 filtered" },
  { id: "l_016", t: "2026-05-19 14:30:48.001", src: "realtime", level: "warn", status: null, method: "EMIT", path: "presence:editor", ms: 1, user: "system", ip: "-", msg: "backpressure · 2 slow clients" },
  // functions
  { id: "l_017", t: "2026-05-19 14:30:42.331", src: "functions", level: "info", status: 200, method: "INVOKE", path: "reindex", ms: 48, user: "cron", ip: "-", msg: "completed · 12 rows indexed" },
  { id: "l_018", t: "2026-05-19 14:30:38.110", src: "functions", level: "error", status: 500, method: "INVOKE", path: "webhook-dispatch", ms: 1840, user: "system", ip: "-", msg: "fetch failed · ECONNREFUSED" },
  { id: "l_019", t: "2026-05-19 14:30:30.118", src: "functions", level: "info", status: 200, method: "INVOKE", path: "thumbnail", ms: 312, user: "rana@workeros.dev", ip: "-", msg: "completed · cf-image resized 1920→480" },
];

type LevelFilter = LogLevel | "any";
type RangeFilter = "15m" | "1h" | "24h" | "7d";

// Per-method / per-level / per-status color classes — mirror the legacy
// .log-method-*, .log-pill-*, .log-s-* rules (with their dark-mode variants).
function logMethodColor(method: string): string {
  const k = method.toLowerCase();
  if (["get", "select", "sub"].includes(k)) return "text-[oklch(0.55_0.13_200)] dark:text-[oklch(0.78_0.13_200)]";
  if (["post", "insert", "signin", "signup", "invoke"].includes(k)) return "text-[oklch(0.5_0.15_145)] dark:text-[oklch(0.78_0.15_145)]";
  if (["patch", "update", "alter", "emit"].includes(k)) return "text-[oklch(0.55_0.16_70)] dark:text-[oklch(0.82_0.16_70)]";
  if (["delete", "drop"].includes(k)) return "text-destructive";
  return "text-muted-foreground";
}
function logPillClass(level: string): string {
  if (level === "warn") return "border-[color-mix(in_oklch,oklch(0.75_0.18_70)_32%,transparent)] bg-[color-mix(in_oklch,oklch(0.75_0.18_70)_18%,var(--card))] text-[oklch(0.55_0.18_70)] dark:text-[oklch(0.85_0.18_70)]";
  if (level === "error") return "border-[color-mix(in_oklch,var(--destructive)_32%,transparent)] bg-[color-mix(in_oklch,var(--destructive)_18%,var(--card))] text-destructive";
  return "bg-muted text-muted-foreground";
}
function logStatusClass(status: number): string {
  const s = Math.floor(status / 100);
  if (s === 2) return "bg-[color-mix(in_oklch,var(--primary)_12%,var(--card))] text-[oklch(0.42_0.12_130)] dark:text-[oklch(0.85_0.16_130)]";
  if (s === 4) return "bg-[color-mix(in_oklch,oklch(0.75_0.18_70)_18%,var(--card))] text-[oklch(0.5_0.18_70)] dark:text-[oklch(0.82_0.18_70)]";
  if (s === 5) return "bg-[color-mix(in_oklch,var(--destructive)_22%,var(--card))] text-destructive";
  return "";
}
const LOG_PILL_BASE = "rounded-sm border border-transparent px-1.5 py-px font-mono text-[10px] uppercase tracking-[0.04em]";

export function LogsPage({ pushToast }: { pushToast: (m: string, type?: "success" | "error") => void }) {
  const [src, setSrc] = useState("http");
  const [level, setLevel] = useState<LevelFilter>("any");
  const [q, setQ] = useState("");
  const [live, setLive] = useState(true);
  const [selected, setSelected] = useState<LogRow | null>(null);
  const [range, setRange] = useState<RangeFilter>("1h");

  const filtered = useMemo(() => {
    return LOG_ROWS.filter((r) => {
      if (r.src !== src) return false;
      if (level !== "any" && r.level !== level) return false;
      if (q) {
        const hay = `${r.path} ${r.method} ${r.msg} ${r.user} ${r.ip}`.toLowerCase();
        if (!hay.includes(q.toLowerCase())) return false;
      }
      return true;
    });
  }, [src, level, q]);

  const counts = useMemo(() => {
    const out: Record<LogLevel, number> = { info: 0, warn: 0, error: 0 };
    for (const r of LOG_ROWS) if (r.src === src) out[r.level] = (out[r.level] || 0) + 1;
    return out;
  }, [src]);

  // Synthetic per-second sparkline — deterministic per source so it doesn't
  // jitter on re-render. Random component capped so bars don't tower past 100%.
  const spark = useMemo(() => {
    const seed = src.charCodeAt(0);
    return Array.from({ length: 60 }, (_, i) => 2 + Math.round(Math.sin((i + seed) / 4) * 2 + ((i * (seed + 7)) % 5)));
  }, [src]);
  const max = Math.max(...spark, 1);

  const levelButtons: { k: LevelFilter; label: string; color: string; count: number }[] = [
    { k: "info", label: "info", color: "var(--muted-foreground)", count: counts.info || 0 },
    { k: "warn", label: "warn", color: "oklch(0.65 0.18 70)", count: counts.warn || 0 },
    { k: "error", label: "error", color: "var(--destructive)", count: counts.error || 0 },
  ];

  const toggleLive = () => {
    setLive((v) => !v);
    pushToast(live ? "Live tail paused." : "Live tail resumed.");
  };

  return (
    <div className="flex flex-col gap-4.5">
      <PageHeader
        title="Logs"
        description={
          <>
            Structured logs across runtime planes. Same store as the audit log, projected through different lenses — every row carries{" "}
            <span className="font-mono">trace_id</span>.
          </>
        }
        badges={<Badge variant="outline" mono>last {range}</Badge>}
        actions={
          <>
            <Button variant="outline" icon={I.Download}>Export NDJSON</Button>
            <Button variant={live ? "primary" : "outline"} icon={live ? I.Zap : I.Play} onClick={toggleLive}>
              {live ? "Live" : "Resume"}
            </Button>
          </>
        }
      />

      {/* Source tabs */}
      <div className="flex w-fit gap-1 rounded-2xl border border-border bg-card p-1">
        {LOG_SOURCES.map((s) => {
          const IconComp = (I as Record<string, IconComponent>)[s.icon] ?? I.Activity;
          const n = LOG_ROWS.filter((r) => r.src === s.id).length;
          const on = src === s.id;
          return (
            <button
              key={s.id}
              type="button"
              className={`inline-flex cursor-pointer items-center gap-[7px] rounded-3xl border-0 px-3.5 py-1.5 text-[12.5px] hover:text-foreground ${on ? "bg-muted text-foreground" : "bg-transparent text-muted-foreground"}`}
              onClick={() => { setSrc(s.id); setSelected(null); }}
            >
              <IconComp size={13} />
              <span>{s.label}</span>
              <span className={`rounded-md border border-border px-1.5 py-px font-mono text-[10.5px] tabular-nums text-muted-foreground ${on ? "bg-card" : "bg-[color-mix(in_oklch,var(--muted)_80%,var(--card))]"}`}>{n}</span>
            </button>
          );
        })}
      </div>

      {/* Volume + level summary */}
      <div className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-3.5 overflow-hidden rounded-2xl border border-border bg-card p-3.5 text-card-foreground">
        <div className="flex h-11 items-end gap-0.5">
          {spark.map((v, i) => (
            <div
              key={i}
              className="min-w-[3px] flex-1 rounded-[2px] bg-[color-mix(in_oklch,var(--primary)_70%,transparent)]"
              style={{ height: `${(v / max) * 100}%` }}
            />
          ))}
        </div>
        {levelButtons.map((x) => (
          <button
            key={x.k}
            type="button"
            className={`inline-flex cursor-pointer items-center gap-1.5 rounded-3xl border px-3 py-[7px] text-xs hover:bg-accent ${level === x.k ? "border-[color-mix(in_oklch,var(--foreground)_35%,var(--border))] bg-accent" : "border-border bg-card"}`}
            onClick={() => setLevel((cur) => (cur === x.k ? "any" : x.k))}
          >
            <span className="size-2 rounded-full" style={{ background: x.color }} />
            <span className="font-mono">{x.label}</span>
            <span className="font-mono tabular-nums text-muted-foreground">
              {x.count}
            </span>
          </button>
        ))}
      </div>

      {/* Search + range */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <I.Search
            size={13}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="search path, method, user, message…"
            className="pl-8"
          />
        </div>
        <div className="flex gap-1">
          {(["15m", "1h", "24h", "7d"] as RangeFilter[]).map((r) => (
            <button
              key={r}
              type="button"
              className={`inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-3xl border px-[11px] text-[12.5px] text-foreground hover:bg-accent ${range === r ? "border-[color-mix(in_oklch,var(--foreground)_22%,var(--border))] bg-accent" : "border-border bg-card"}`}
              onClick={() => setRange(r)}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      {/* Log stream + detail */}
      <div className={`grid items-start gap-3.5 ${selected ? "grid-cols-[1fr_400px]" : "grid-cols-1"}`}>
        <div className="overflow-hidden rounded-2xl border border-border bg-card text-card-foreground">
          {filtered.length === 0 ? (
            <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
              <div className="grid size-10 place-items-center rounded-xl bg-muted text-primary"><I.ScrollText size={18} /></div>
              <h4 className="m-0 text-[15px] font-semibold">No log entries match</h4>
              <p className="m-0 max-w-[360px] text-[13px] text-muted-foreground">Try a wider time range or clear the level filter.</p>
            </div>
          ) : (
            <div>
              {filtered.map((r) => {
                const sel = selected?.id === r.id;
                const err = r.level === "error";
                const rowBg = err && sel
                  ? "bg-[color-mix(in_oklch,var(--destructive)_12%,transparent)]"
                  : err
                    ? "bg-[color-mix(in_oklch,var(--destructive)_5%,transparent)]"
                    : sel
                      ? "bg-[color-mix(in_oklch,var(--primary)_8%,var(--card))]"
                      : "hover:bg-[color-mix(in_oklch,var(--accent)_50%,transparent)]";
                return (
                  <button
                    key={r.id}
                    type="button"
                    className={`grid w-full cursor-pointer grid-cols-[92px_56px_70px_56px_1fr_64px_1.4fr] items-center gap-2.5 border-0 border-b border-border px-3.5 py-[7px] text-left text-xs text-foreground transition-colors last:border-b-0 ${rowBg}`}
                    onClick={() => setSelected(r)}
                  >
                    <span className="font-mono text-[11px] text-muted-foreground">{r.t.slice(11, 23)}</span>
                    <span className={`${LOG_PILL_BASE} ${logPillClass(r.level)}`}>{r.level}</span>
                    <span className={`font-mono text-[10.5px] tracking-[0.02em] ${logMethodColor(r.method)}`}>{r.method}</span>
                    {r.status != null && (
                      <span className={`rounded-md px-1.5 py-px text-center font-mono text-[11px] tabular-nums ${logStatusClass(r.status)}`}>{r.status}</span>
                    )}
                    <span className="truncate font-mono text-[11.5px] text-foreground">{r.path}</span>
                    <span className="text-right font-mono text-[11px] tabular-nums text-muted-foreground">{r.ms}ms</span>
                    <span className="truncate text-[11.5px] text-muted-foreground">{r.msg}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {selected && (
          <LogDetail
            row={selected}
            onClose={() => setSelected(null)}
            onCopyTrace={() => {
              try {
                void navigator.clipboard.writeText("01HZ7K8M9NPQA4E2B9C1F0");
                pushToast("trace_id copied to clipboard.");
              } catch {
                pushToast("Could not copy trace_id.", "error");
              }
            }}
          />
        )}
      </div>
    </div>
  );
}

function LogDetail({ row, onClose, onCopyTrace }: { row: LogRow; onClose: () => void; onCopyTrace: () => void }) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: "Bearer pak_a4e2b9c1_••••••",
    "x-trace-id": "01HZ7K8M9NPQA4E2B9C1F0",
    "user-agent": "workeros-cli/0.4.2 (darwin; arm64)",
  };
  const body = row.src === "http" && row.method === "POST" ? { title: "Drizzle 1.0 in production", status: "review" } : null;
  const sectionLabel = "mb-1.5 text-[11px] uppercase tracking-[0.05em] text-muted-foreground";
  const codeBlock = "m-0 overflow-x-auto whitespace-pre rounded-lg bg-muted px-3 py-2.5 font-mono text-[11.5px]";
  return (
    <div className="sticky top-4 overflow-hidden rounded-2xl border border-border bg-card text-card-foreground">
      <div className="flex items-center gap-2.5 border-b border-border px-4 py-3.5">
        <I.ScrollText size={14} />
        <span className="text-[13px] font-medium">log entry</span>
        <span className="font-mono text-[11px] text-muted-foreground">
          {row.id}
        </span>
        <div className="flex-1" />
        <IconButton icon={I.X} onClick={onClose} />
      </div>
      <div className="flex flex-col gap-3.5 p-3.5">
        <div>
          <div className={sectionLabel}>summary</div>
          <div className="mb-1.5 flex flex-wrap items-center gap-2">
            <span className={`${LOG_PILL_BASE} ${logPillClass(row.level)}`}>{row.level}</span>
            <span className={`font-mono text-[10.5px] tracking-[0.02em] ${logMethodColor(row.method)}`}>{row.method}</span>
            {row.status != null && (
              <span className={`rounded-md px-1.5 py-px text-center font-mono text-[11px] tabular-nums ${logStatusClass(row.status)}`}>{row.status}</span>
            )}
          </div>
          <div className="font-mono text-[12.5px] [word-break:break-all]">
            {row.path}
          </div>
          <div className="mt-1.5 text-[12.5px] text-foreground">{row.msg}</div>
        </div>

        <div>
          <div className={sectionLabel}>context</div>
          <KV k="time" v={row.t} mono />
          <KV k="duration" v={`${row.ms} ms`} mono />
          <KV k="user" v={row.user} mono />
          <KV k="ip" v={row.ip} mono />
          <KV k="trace_id" v="01HZ7K8M9NPQA4E2B9C1F0" mono />
        </div>

        {row.src === "http" && (
          <div>
            <div className={sectionLabel}>request headers</div>
            <pre className={codeBlock}>
              {Object.entries(headers)
                .map(([k, v]) => `${k}: ${v}`)
                .join("\n")}
            </pre>
          </div>
        )}

        {body && (
          <div>
            <div className={sectionLabel}>request body</div>
            <pre className={codeBlock}>{JSON.stringify(body, null, 2)}</pre>
          </div>
        )}

        <div className="flex gap-1.5">
          <Button variant="outline" size="sm" icon={I.Copy} onClick={onCopyTrace}>
            Copy trace_id
          </Button>
          <Button variant="ghost" size="sm" icon={I.ExternalLink}>
            Open in trace
          </Button>
        </div>
      </div>
    </div>
  );
}

function KV({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[90px_1fr] gap-2 border-b border-dashed border-border py-1 text-xs">
      <span className="text-muted-foreground">{k}</span>
      <span className={`[word-break:break-all] ${mono ? "font-mono" : ""}`}>
        {v}
      </span>
    </div>
  );
}
