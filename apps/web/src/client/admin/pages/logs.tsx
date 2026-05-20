// Logs page — multi-source structured log explorer.
//
// This is a lens over the `activity` audit table (`GET /api/activity`): there
// is no separate logging pipeline, the activity log IS the store. Each row is
// projected into a source (HTTP / Data / Automation / Functions / Storage) and
// a derived level (info / warn / error), then rendered in the log-row UI.
import { useMemo, useState, type CSSProperties } from "react";
import { I, type IconComponent, type IconKey } from "../icons";
import { Badge, Button, IconButton, PageHeader } from "../ui";
import { Input } from "@workeros/ui/components/input";
import { Tabs, TabsList, TabsTrigger } from "@workeros/ui/components/tabs";
import { Skeleton } from "@workeros/ui/components/skeleton";
import { useActivity } from "../queries";
import { authorById } from "../items";
import type { ApiActivity } from "../api";

type LogLevel = "info" | "warn" | "error";
type LevelFilter = LogLevel | "any";
type RangeFilter = "15m" | "1h" | "24h" | "7d";

/** Source ids the page projects activity rows into. `other` is only surfaced
 *  when at least one row lands there. */
type SourceId = "http" | "data" | "automation" | "functions" | "storage" | "other";

interface SourceDef {
  id: SourceId;
  label: string;
  icon: IconKey;
}

const SOURCE_DEFS: SourceDef[] = [
  { id: "http", label: "HTTP", icon: "ExternalLink" },
  { id: "data", label: "Data", icon: "Database" },
  { id: "automation", label: "Automation", icon: "Webhook" },
  { id: "functions", label: "Functions", icon: "Function" },
  { id: "storage", label: "Storage", icon: "Archive" },
  { id: "other", label: "Other", icon: "Activity" },
];

const RANGE_MS: Record<RangeFilter, number> = {
  "15m": 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
};

/** A normalized activity row, projected into the log-row shape. */
interface LogRow {
  id: string;
  ts: number;
  src: SourceId;
  level: LogLevel;
  status: number | null;
  method: string;
  path: string;
  ms: number | null;
  user: string;
  ip: string | null;
  userAgent: string | null;
  msg: string;
  action: string;
  payload: unknown;
  response: unknown;
}

/** Map the action category (the part before the first `.`) to a source. */
function sourceForAction(action: string): SourceId {
  if (action === "request.error") return "http";
  const category = action.split(".", 1)[0] ?? "";
  switch (category) {
    case "item":
    case "schema":
    case "role":
      return "data";
    case "webhook":
    case "flow":
      return "automation";
    case "function":
      return "functions";
    case "storage":
      return "storage";
    default:
      return "other";
  }
}

/** Derive a log level from real activity data — error rows, then duration. */
function levelForRow(action: string, durationMs: number | null): LogLevel {
  if (action === "request.error") return "error";
  if (durationMs != null) {
    if (durationMs >= 2000) return "error";
    if (durationMs >= 500) return "warn";
  }
  return "info";
}

/** Parse the activity `createdAt` (Unix-ms on SQLite, ISO/Date on PG). */
function tsOf(createdAt: unknown): number {
  if (typeof createdAt === "number") return createdAt;
  const d = new Date(createdAt as string);
  return Number.isNaN(d.getTime()) ? 0 : d.getTime();
}

/** Read a string field off a JSON payload object without throwing. */
function payloadField(payload: unknown, key: string): unknown {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return (payload as Record<string, unknown>)[key];
  }
  return undefined;
}

function projectRow(a: ApiActivity): LogRow {
  const action = a.action;
  const src = sourceForAction(action);
  const level = levelForRow(action, a.durationMs);
  const verb = action.split(".").slice(1).join(".") || action;
  const method = verb.toUpperCase();

  const isError = action === "request.error";
  let status: number | null = null;
  if (isError) {
    const s = payloadField(a.payload, "status");
    status = typeof s === "number" ? s : null;
  }

  let path: string;
  if (src === "http") {
    // `itemId` holds "<METHOD> <path>" for request.error rows.
    path = a.itemId ?? a.collection ?? "—";
  } else {
    path = `${a.collection ?? "—"}${a.itemId ? `/${a.itemId}` : ""}`;
  }

  let msg: string;
  if (isError) {
    const m = payloadField(a.payload, "message");
    msg = typeof m === "string" ? m : action;
  } else {
    msg = a.collection ? `${action} · ${a.collection}` : action;
  }

  return {
    id: a.id,
    ts: tsOf(a.createdAt),
    src,
    level,
    status,
    method,
    path,
    ms: a.durationMs,
    user: a.userId ? authorById(a.userId).name : "system",
    ip: a.ip,
    userAgent: a.userAgent,
    msg,
    action,
    payload: a.payload,
    response: a.response,
  };
}

const fmtTime = (ts: number): string => {
  if (!ts) return "—";
  // 24h HH:MM:SS.mmm — mirrors the previous fixed-width timestamp column.
  return new Date(ts).toISOString().slice(11, 23);
};

export function LogsPage({ pushToast }: { pushToast: (m: string, type?: "success" | "error") => void }) {
  const [src, setSrc] = useState<SourceId | null>(null);
  const [level, setLevel] = useState<LevelFilter>("any");
  const [q, setQ] = useState("");
  const [live, setLive] = useState(false);
  const [selected, setSelected] = useState<LogRow | null>(null);
  const [range, setRange] = useState<RangeFilter>("24h");

  const { data, isLoading, isError } = useActivity(200, live);

  // All activity rows, projected.
  const allRows = useMemo<LogRow[]>(
    () => (data?.data ?? []).map(projectRow),
    [data],
  );

  // Rows inside the selected time range.
  const inRange = useMemo<LogRow[]>(() => {
    const cutoff = Date.now() - RANGE_MS[range];
    return allRows.filter((r) => r.ts >= cutoff);
  }, [allRows, range]);

  // Per-source row counts (within the time range) — feeds the tab badges.
  const sourceCounts = useMemo<Record<SourceId, number>>(() => {
    const out: Record<SourceId, number> = {
      http: 0,
      data: 0,
      automation: 0,
      functions: 0,
      storage: 0,
      other: 0,
    };
    for (const r of inRange) out[r.src]++;
    return out;
  }, [inRange]);

  // Visible source tabs: the fixed five, plus Other only when it has rows.
  const sources = useMemo(
    () => SOURCE_DEFS.filter((s) => s.id !== "other" || sourceCounts.other > 0),
    [sourceCounts.other],
  );

  // Default tab: the source with the most rows, else HTTP.
  const activeSrc: SourceId = useMemo(() => {
    if (src && sources.some((s) => s.id === src)) return src;
    let best: SourceId = "http";
    let bestN = -1;
    for (const s of sources) {
      const n = sourceCounts[s.id];
      if (n > bestN) {
        best = s.id;
        bestN = n;
      }
    }
    return best;
  }, [src, sources, sourceCounts]);

  // Rows for the active source (range-filtered, before level/search).
  const sourceRows = useMemo(
    () => inRange.filter((r) => r.src === activeSrc),
    [inRange, activeSrc],
  );

  // Derived level counts for the active source — drives the filter buttons.
  const counts = useMemo(() => {
    const out: Record<LogLevel, number> = { info: 0, warn: 0, error: 0 };
    for (const r of sourceRows) out[r.level]++;
    return out;
  }, [sourceRows]);

  // Final visible rows: level filter + free-text search.
  const filtered = useMemo(() => {
    return sourceRows.filter((r) => {
      if (level !== "any" && r.level !== level) return false;
      if (q) {
        const hay = `${r.path} ${r.method} ${r.msg} ${r.user}`.toLowerCase();
        if (!hay.includes(q.toLowerCase())) return false;
      }
      return true;
    });
  }, [sourceRows, level, q]);

  // Sparkline — real per-bucket row counts for the active source across the
  // selected range (24 buckets).
  const spark = useMemo(() => {
    const BUCKETS = 48;
    const span = RANGE_MS[range];
    const now = Date.now();
    const start = now - span;
    const bucketMs = span / BUCKETS;
    const out = new Array<number>(BUCKETS).fill(0);
    for (const r of sourceRows) {
      const idx = Math.floor((r.ts - start) / bucketMs);
      if (idx >= 0 && idx < BUCKETS) out[idx] = (out[idx] ?? 0) + 1;
    }
    return out;
  }, [sourceRows, range]);
  const sparkMax = Math.max(...spark, 1);

  const levelButtons: { k: LevelFilter; label: string; color: string; count: number }[] = [
    { k: "info", label: "info", color: "var(--muted-foreground)", count: counts.info },
    { k: "warn", label: "warn", color: "oklch(0.65 0.18 70)", count: counts.warn },
    { k: "error", label: "error", color: "var(--destructive)", count: counts.error },
  ];

  const toggleLive = () => {
    setLive((v) => {
      pushToast(v ? "Live tail paused." : "Live tail resumed.");
      return !v;
    });
  };

  const exportNdjson = () => {
    if (filtered.length === 0) {
      pushToast("Nothing to export — the current view is empty.", "error");
      return;
    }
    const ndjson = filtered
      .map((r) =>
        JSON.stringify({
          id: r.id,
          createdAt: new Date(r.ts).toISOString(),
          source: r.src,
          level: r.level,
          method: r.method,
          status: r.status,
          path: r.path,
          durationMs: r.ms,
          user: r.user,
          ip: r.ip,
          msg: r.msg,
          action: r.action,
          payload: r.payload,
          response: r.response,
        }),
      )
      .join("\n");
    try {
      const blob = new Blob([ndjson], { type: "application/x-ndjson" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `logs-${activeSrc}-${Date.now()}.ndjson`;
      a.click();
      URL.revokeObjectURL(url);
      pushToast(`Exported ${filtered.length} rows as NDJSON.`);
    } catch {
      pushToast("Could not export logs.", "error");
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <PageHeader
        title="Logs"
        description="Structured logs across runtime planes. Same store as the audit log, projected through different lenses — HTTP, data, automation, functions, and storage."
        badges={<Badge variant="outline" mono>last {range}</Badge>}
        actions={
          <>
            <Button variant="outline" icon={I.Download} onClick={exportNdjson}>
              Export NDJSON
            </Button>
            <Button variant={live ? "primary" : "outline"} icon={live ? I.Zap : I.Play} onClick={toggleLive}>
              {live ? "Live" : "Resume"}
            </Button>
          </>
        }
      />

      {isLoading ? (
        <div className="card" style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : isError ? (
        <div className="card empty">
          <div className="ico"><I.AlertTriangle size={18} /></div>
          <h4>Couldn't load logs</h4>
          <p>The activity endpoint returned an error. Try again in a moment.</p>
        </div>
      ) : allRows.length === 0 ? (
        <div className="card empty">
          <div className="ico"><I.ScrollText size={18} /></div>
          <h4>No activity yet</h4>
          <p>Once requests, item writes, and automation runs start flowing, they'll show up here.</p>
        </div>
      ) : (
        <>
          {/* Source tabs */}
          <Tabs value={activeSrc} onValueChange={(v) => { setSrc(v as SourceId); setSelected(null); }}>
            <TabsList>
              {sources.map((s) => {
                const IconComp = (I as Record<string, IconComponent>)[s.icon] ?? I.Activity;
                return (
                  <TabsTrigger key={s.id} value={s.id}>
                    <IconComp size={13} />
                    <span>{s.label}</span>
                    <span className="count">{sourceCounts[s.id]}</span>
                  </TabsTrigger>
                );
              })}
            </TabsList>
          </Tabs>

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
                  title={`${v} ${v === 1 ? "entry" : "entries"}`}
                  style={{
                    flex: 1,
                    height: `${Math.max((v / sparkMax) * 100, v > 0 ? 6 : 2)}%`,
                    background:
                      v > 0
                        ? "color-mix(in oklch, var(--primary) 70%, transparent)"
                        : "var(--muted)",
                    borderRadius: 2,
                    minWidth: 3,
                  }}
                />
              ))}
            </div>
            {levelButtons.map((x) => (
              <Button
                key={x.k}
                variant={level === x.k ? "secondary" : "outline"}
                size="sm"
                onClick={() => setLevel((cur) => (cur === x.k ? "any" : x.k))}
              >
                <span
                  style={{ width: 8, height: 8, borderRadius: 999, background: x.color, display: "inline-block" }}
                />
                <span className="font-mono">{x.label}</span>
                <span className="font-mono tabular-nums" style={{ color: "var(--muted-foreground)" }}>
                  {x.count}
                </span>
              </Button>
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
            <Tabs value={range} onValueChange={(v) => setRange(v as RangeFilter)}>
              <TabsList>
                {(["15m", "1h", "24h", "7d"] as RangeFilter[]).map((r) => (
                  <TabsTrigger key={r} value={r}>
                    {r}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
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
                      <span className="log-t font-mono">{fmtTime(r.ts)}</span>
                      <span className={`log-pill log-pill-${r.level}`}>{r.level}</span>
                      <span className={`log-method log-method-${r.method.toLowerCase()}`}>{r.method}</span>
                      {r.status != null && (
                        <span className={`log-status log-s-${Math.floor(r.status / 100)}`}>{r.status}</span>
                      )}
                      <span className="log-path font-mono">{r.path}</span>
                      {r.ms != null && (
                        <span className="log-ms font-mono tabular-nums">{r.ms}ms</span>
                      )}
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
                onCopyId={() => {
                  try {
                    void navigator.clipboard.writeText(selected.id);
                    pushToast("Entry id copied to clipboard.");
                  } catch {
                    pushToast("Could not copy entry id.", "error");
                  }
                }}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}

const sectionLabel: CSSProperties = {
  fontSize: 11,
  color: "var(--muted-foreground)",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  marginBottom: 6,
};

function LogDetail({ row, onClose, onCopyId }: { row: LogRow; onClose: () => void; onCopyId: () => void }) {
  return (
    <div className="card" style={{ position: "sticky", top: 16 }}>
      <div className="card-section" style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <I.ScrollText size={14} />
        <span style={{ fontSize: 13, fontWeight: 500 }}>log entry</span>
        <span className="font-mono" style={{ fontSize: 11, color: "var(--muted-foreground)", wordBreak: "break-all" }}>
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
          <KV k="id" v={row.id} mono />
          <KV k="time" v={row.ts ? new Date(row.ts).toISOString() : "—"} mono />
          <KV k="duration" v={row.ms != null ? `${row.ms} ms` : "—"} mono />
          <KV k="user" v={row.user} mono />
          <KV k="ip" v={row.ip ?? "—"} mono />
          {row.userAgent && <KV k="user-agent" v={row.userAgent} mono />}
        </div>

        {row.payload != null && (
          <div>
            <div style={sectionLabel}>payload</div>
            <pre className="code-block">{JSON.stringify(row.payload, null, 2)}</pre>
          </div>
        )}

        {row.response != null && (
          <div>
            <div style={sectionLabel}>response</div>
            <pre className="code-block">{JSON.stringify(row.response, null, 2)}</pre>
          </div>
        )}

        <div style={{ display: "flex", gap: 6 }}>
          <Button variant="outline" size="sm" icon={I.Copy} onClick={onCopyId}>
            Copy id
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
