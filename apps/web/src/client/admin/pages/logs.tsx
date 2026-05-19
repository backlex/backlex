// Logs page — multi-source structured log explorer.
//
// Visual + interaction parity with the design's parity-v2.jsx::LogsPage.
// Live/Resume + range chips are visual-only for now; rows ship inline as a
// const until a /api/admin/logs endpoint lands.
import { useMemo, useState, type CSSProperties } from "react";
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
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
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
      <div className="logs-src">
        {LOG_SOURCES.map((s) => {
          const IconComp = (I as Record<string, IconComponent>)[s.icon] ?? I.Activity;
          const n = LOG_ROWS.filter((r) => r.src === s.id).length;
          return (
            <button
              key={s.id}
              type="button"
              className={`logs-src-tab ${src === s.id ? "on" : ""}`}
              onClick={() => { setSrc(s.id); setSelected(null); }}
            >
              <IconComp size={13} />
              <span>{s.label}</span>
              <span className="logs-src-count font-mono tabular-nums">{n}</span>
            </button>
          );
        })}
      </div>

      {/* Volume + level summary */}
      <div
        className="card"
        style={{
          padding: 14,
          display: "grid",
          gridTemplateColumns: "1fr auto auto auto",
          gap: 14,
          alignItems: "center",
        }}
      >
        <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 44 }}>
          {spark.map((v, i) => (
            <div
              key={i}
              style={{
                flex: 1,
                height: `${(v / max) * 100}%`,
                background: "color-mix(in oklch, var(--primary) 70%, transparent)",
                borderRadius: 2,
                minWidth: 3,
              }}
            />
          ))}
        </div>
        {levelButtons.map((x) => (
          <button
            key={x.k}
            type="button"
            className={`logs-level ${level === x.k ? "on" : ""}`}
            onClick={() => setLevel((cur) => (cur === x.k ? "any" : x.k))}
          >
            <span className="logs-level-dot" style={{ background: x.color }} />
            <span className="font-mono">{x.label}</span>
            <span className="font-mono tabular-nums" style={{ color: "var(--muted-foreground)" }}>
              {x.count}
            </span>
          </button>
        ))}
      </div>

      {/* Search + range */}
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <div style={{ flex: 1, position: "relative" }}>
          <I.Search
            size={13}
            style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", color: "var(--muted-foreground)" }}
          />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="search path, method, user, message…"
            style={{ paddingLeft: 32 }}
          />
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          {(["15m", "1h", "24h", "7d"] as RangeFilter[]).map((r) => (
            <button key={r} type="button" className={`chip ${range === r ? "active" : ""}`} onClick={() => setRange(r)}>
              {r}
            </button>
          ))}
        </div>
      </div>

      {/* Log stream + detail */}
      <div style={{ display: "grid", gridTemplateColumns: selected ? "1fr 400px" : "1fr", gap: 14, alignItems: "start" }}>
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          {filtered.length === 0 ? (
            <div className="empty">
              <div className="ico"><I.ScrollText size={18} /></div>
              <h4>No log entries match</h4>
              <p>Try a wider time range or clear the level filter.</p>
            </div>
          ) : (
            <div>
              {filtered.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  className={`log-row ${selected?.id === r.id ? "sel" : ""} log-${r.level}`}
                  onClick={() => setSelected(r)}
                >
                  <span className="log-t font-mono">{r.t.slice(11, 23)}</span>
                  <span className={`log-pill log-pill-${r.level}`}>{r.level}</span>
                  <span className={`log-method log-method-${r.method.toLowerCase()}`}>{r.method}</span>
                  {r.status != null && (
                    <span className={`log-status log-s-${Math.floor(r.status / 100)}`}>{r.status}</span>
                  )}
                  <span className="log-path font-mono">{r.path}</span>
                  <span className="log-ms font-mono tabular-nums">{r.ms}ms</span>
                  <span className="log-msg">{r.msg}</span>
                </button>
              ))}
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
  const sectionLabel: CSSProperties = {
    fontSize: 11,
    color: "var(--muted-foreground)",
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    marginBottom: 6,
  };
  return (
    <div className="card" style={{ position: "sticky", top: 16 }}>
      <div className="card-section" style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <I.ScrollText size={14} />
        <span style={{ fontSize: 13, fontWeight: 500 }}>log entry</span>
        <span className="font-mono" style={{ fontSize: 11, color: "var(--muted-foreground)" }}>
          {row.id}
        </span>
        <div className="spacer" />
        <IconButton icon={I.X} onClick={onClose} />
      </div>
      <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 14 }}>
        <div>
          <div style={sectionLabel}>summary</div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
            <span className={`log-pill log-pill-${row.level}`}>{row.level}</span>
            <span className={`log-method log-method-${row.method.toLowerCase()}`}>{row.method}</span>
            {row.status != null && (
              <span className={`log-status log-s-${Math.floor(row.status / 100)}`}>{row.status}</span>
            )}
          </div>
          <div className="font-mono" style={{ fontSize: 12.5, wordBreak: "break-all" }}>
            {row.path}
          </div>
          <div style={{ fontSize: 12.5, marginTop: 6, color: "var(--foreground)" }}>{row.msg}</div>
        </div>

        <div>
          <div style={sectionLabel}>context</div>
          <KV k="time" v={row.t} mono />
          <KV k="duration" v={`${row.ms} ms`} mono />
          <KV k="user" v={row.user} mono />
          <KV k="ip" v={row.ip} mono />
          <KV k="trace_id" v="01HZ7K8M9NPQA4E2B9C1F0" mono />
        </div>

        {row.src === "http" && (
          <div>
            <div style={sectionLabel}>request headers</div>
            <pre className="code-block">
              {Object.entries(headers)
                .map(([k, v]) => `${k}: ${v}`)
                .join("\n")}
            </pre>
          </div>
        )}

        {body && (
          <div>
            <div style={sectionLabel}>request body</div>
            <pre className="code-block">{JSON.stringify(body, null, 2)}</pre>
          </div>
        )}

        <div style={{ display: "flex", gap: 6 }}>
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
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "90px 1fr",
        gap: 8,
        padding: "4px 0",
        fontSize: 12,
        borderBottom: "1px dashed var(--border)",
      }}
    >
      <span style={{ color: "var(--muted-foreground)" }}>{k}</span>
      <span className={mono ? "font-mono" : undefined} style={{ wordBreak: "break-all" }}>
        {v}
      </span>
    </div>
  );
}
