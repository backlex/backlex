// Logs page — unified log explorer (formerly "Logs" + "Activity log").
//
// This is the single lens over the `activity` audit table
// (`GET /api/activity`): there is no separate logging pipeline, the activity
// log IS the store. The page offers two views over the same data:
//
//   - Stream — multi-source structured log explorer. Each row is projected
//     into a source (HTTP / Data / Automation / Functions / Storage) and a
//     derived level (info / warn / error).
//   - Table  — append-only audit trail with Time / Duration / Action /
//     Resource / Diff / IP columns and a click-through detail modal.
//
// The time range and the action-category filter are pushed to the *server*
// (`from` + `action` query params) and the data layer paginates via
// `useInfiniteQuery`, so the view is never clipped to the freshest 200 rows.
import { useMemo, useState, type CSSProperties } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { I, type IconComponent, type IconKey } from "../icons";
import { Badge, Button, EmptyState, IconButton, JsonBlock, PageHeader } from "../ui";
import { Input } from "@backlex/ui/components/input";
import { Tabs, TabsList, TabsTrigger } from "@backlex/ui/components/tabs";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@backlex/ui/components/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@backlex/ui/components/table";
import { ScrollArea } from "@backlex/ui/components/scroll-area";
import { Card } from "@backlex/ui/components/card";
import { useActivity } from "../queries";
import { LogsSkeleton } from "../page-skeletons";
import { authorById } from "../items";
import type { ApiActivity } from "../api";
import { exportToCsv } from "@/lib/csv-export";

type LogLevel = "info" | "warn" | "error";
type LevelFilter = LogLevel | "any";
type RangeFilter = "15m" | "1h" | "24h" | "7d";
type ViewMode = "stream" | "table";

/** Page size for each server request — also the infinite-query cursor step. */
const PAGE_SIZE = 100;

/** Source ids the Stream view projects activity rows into. `other` is only
 *  surfaced when at least one row lands there. */
type SourceId =
  | "http"
  | "data"
  | "access"
  | "automation"
  | "functions"
  | "storage"
  | "other";

interface SourceDef {
  id: SourceId;
  label: string;
  icon: IconKey;
}

const SOURCE_DEFS: SourceDef[] = [
  { id: "http", label: "HTTP", icon: "ExternalLink" },
  { id: "data", label: "Data", icon: "Database" },
  { id: "access", label: "Access", icon: "Eye" },
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

/** Action-category chips for the Table view. Each chip sets the server-side
 *  `action` prefix filter; `all` clears it. */
const CATEGORY_CHIPS = [
  "all",
  "item",
  "access",
  "auth",
  "schema",
  "role",
  "storage",
  "flow",
  "function",
  "webhook",
  "backup",
] as const;
type CategoryChip = (typeof CATEGORY_CHIPS)[number];

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
  collection: string | null;
  itemId: string | null;
  payload: unknown;
  response: unknown;
  /** Original epoch ms of `createdAt`, kept for ISO rendering. */
  createdAt: unknown;
}

/** Map the action category (the part before the first `.`) to a source. */
function sourceForAction(action: string): SourceId {
  if (action === "request.error") return "http";
  const category = action.split(".", 1)[0] ?? "";
  switch (category) {
    case "access":
      return "access";
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
    // Always resolve the actor to a human name — never surface the raw UUID.
    user: a.userId ? authorById(a.userId).name : "system",
    ip: a.ip,
    userAgent: a.userAgent,
    msg,
    action,
    collection: a.collection ?? null,
    itemId: a.itemId ?? null,
    payload: a.payload,
    response: a.response,
    createdAt: a.createdAt,
  };
}

const fmtTime = (ts: number): string => {
  if (!ts) return "—";
  // 24h HH:MM:SS.mmm — mirrors the previous fixed-width timestamp column.
  return new Date(ts).toISOString().slice(11, 23);
};

const fmtTableTime = (ts: number): string => {
  if (!ts) return "—";
  return new Date(ts).toISOString().replace("T", " ").slice(0, 19);
};

const formatDuration = (ms: number | null): string => {
  if (ms == null || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
};

export function LogsPage({
  pushToast,
}: {
  pushToast: (m: string, type?: "success" | "error") => void;
}) {
  const { t } = useLingui();
  // View switch + shared controls.
  const [view, setView] = useState<ViewMode>("stream");
  const [range, setRange] = useState<RangeFilter>("24h");
  const [q, setQ] = useState("");
  const [live, setLive] = useState(false);

  // Stream-view filters.
  const [src, setSrc] = useState<SourceId | null>(null);
  const [level, setLevel] = useState<LevelFilter>("any");
  const [selected, setSelected] = useState<LogRow | null>(null);

  // Table-view filters.
  const [category, setCategory] = useState<CategoryChip>("all");
  const [openRow, setOpenRow] = useState<LogRow | null>(null);

  // `from` is recomputed each render from the range so a refetch always uses
  // a window relative to *now* (avoids a stale cutoff frozen at mount).
  const from = Date.now() - RANGE_MS[range];

  // The action prefix only applies to the Table view; the Stream view keeps
  // its own client-side source projection (HTTP/Data/…). Sending `action`
  // unconditionally would hide rows from the Stream sources.
  const actionFilter =
    view === "table" && category !== "all" ? category : undefined;

  const {
    data,
    isLoading,
    isError,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useActivity(
    {
      // Bucket `from` to whole minutes so small render-to-render drift doesn't
      // thrash the query key (and the cache) on every keystroke / interval.
      from: Math.floor(from / 60000) * 60000,
      action: actionFilter,
      pageSize: PAGE_SIZE,
    },
    live,
  );

  // Flatten every loaded page into a single projected list.
  const allRows = useMemo<LogRow[]>(
    () => (data?.pages ?? []).flatMap((p) => p.data).map(projectRow),
    [data],
  );

  // Server-reported total for the current filters (independent of paging).
  const totalCount = data?.pages?.[0]?.meta?.count ?? null;

  // First whole-page fetch — the activity rows haven't landed yet.
  if (isLoading) return <LogsSkeleton />;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <PageHeader
        title={t`Logs`}
        description={t`Unified log explorer over the activity audit store. Switch between the Stream lens (HTTP, data, automation, functions, storage) and the Table audit trail — both read the same rows.`}
        descriptionClassName="hidden sm:block"
        badges={
          <>
            <Badge variant="outline" mono>
              <Trans>last {range}</Trans>
            </Badge>
            {totalCount != null && (
              <Badge variant="outline" mono>
                <Trans>{totalCount} total</Trans>
              </Badge>
            )}
          </>
        }
        actions={
          <>
            <Tabs value={view} onValueChange={(v) => setView(v as ViewMode)}>
              <TabsList>
                <TabsTrigger value="stream">
                  <I.ScrollText size={13} />
                  <span><Trans>Stream</Trans></span>
                </TabsTrigger>
                <TabsTrigger value="table">
                  <I.LayoutList size={13} />
                  <span><Trans>Table</Trans></span>
                </TabsTrigger>
              </TabsList>
            </Tabs>
            <Button
              variant={live ? "primary" : "outline"}
              icon={live ? I.Zap : I.Play}
              onClick={() => {
                setLive((v) => {
                  pushToast(v ? t`Live tail paused.` : t`Live tail resumed.`);
                  return !v;
                });
              }}
            >
              {live ? <Trans>Live</Trans> : <Trans>Resume</Trans>}
            </Button>
          </>
        }
      />

      {/* Shared range control + search */}
      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <div style={{ flex: 1, position: "relative", minWidth: 180 }}>
          <I.Search
            size={13}
            style={{
              position: "absolute",
              left: 12,
              top: "50%",
              transform: "translateY(-50%)",
              color: "var(--muted-foreground)",
            }}
          />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t`search loaded rows — path, action, user, message…`}
            style={{ paddingLeft: 32 }}
          />
        </div>
        {/* `ml-auto` keeps the range picker hugging the right edge — on its own
            line on mobile (search takes the full width above it) and inline on
            desktop where the flex-1 search already pushes it right. */}
        <Tabs
          className="ml-auto"
          value={range}
          onValueChange={(v) => setRange(v as RangeFilter)}
        >
          <TabsList>
            {(["15m", "1h", "24h", "7d"] as RangeFilter[]).map((r) => (
              <TabsTrigger key={r} value={r}>
                {r}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>

      {isError ? (
        <EmptyState
          icon={I.AlertTriangle}
          title={<Trans>Couldn't load logs</Trans>}
          description={<Trans>The activity endpoint returned an error. Try again in a moment.</Trans>}
        />
      ) : allRows.length === 0 ? (
        <EmptyState
          icon={I.ScrollText}
          title={<Trans>No activity in this window</Trans>}
          description={
            <Trans>
              Nothing landed in the last {range}. Widen the range, or wait for
              requests, item writes, and automation runs to flow in.
            </Trans>
          }
        />
      ) : view === "stream" ? (
        <StreamView
          rows={allRows}
          range={range}
          q={q}
          src={src}
          setSrc={setSrc}
          level={level}
          setLevel={setLevel}
          selected={selected}
          setSelected={setSelected}
          hasNextPage={!!hasNextPage}
          isFetchingNextPage={isFetchingNextPage}
          onLoadMore={() => void fetchNextPage()}
          pushToast={pushToast}
        />
      ) : (
        <TableView
          rows={allRows}
          q={q}
          category={category}
          setCategory={setCategory}
          openRow={openRow}
          setOpenRow={setOpenRow}
          totalCount={totalCount}
          hasNextPage={!!hasNextPage}
          isFetchingNextPage={isFetchingNextPage}
          onLoadMore={() => void fetchNextPage()}
          pushToast={pushToast}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Stream view                                                         */
/* ------------------------------------------------------------------ */

function StreamView({
  rows,
  range,
  q,
  src,
  setSrc,
  level,
  setLevel,
  selected,
  setSelected,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
  pushToast,
}: {
  rows: LogRow[];
  range: RangeFilter;
  q: string;
  src: SourceId | null;
  setSrc: (s: SourceId | null) => void;
  level: LevelFilter;
  setLevel: (l: LevelFilter | ((p: LevelFilter) => LevelFilter)) => void;
  selected: LogRow | null;
  setSelected: (r: LogRow | null) => void;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
  pushToast: (m: string, type?: "success" | "error") => void;
}) {
  const { t } = useLingui();
  // Per-source row counts (within the loaded window) — feeds the tab badges.
  const sourceCounts = useMemo<Record<SourceId, number>>(() => {
    const out: Record<SourceId, number> = {
      http: 0,
      data: 0,
      access: 0,
      automation: 0,
      functions: 0,
      storage: 0,
      other: 0,
    };
    for (const r of rows) out[r.src]++;
    return out;
  }, [rows]);

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

  // Rows for the active source (before level/search).
  const sourceRows = useMemo(
    () => rows.filter((r) => r.src === activeSrc),
    [rows, activeSrc],
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

  // Sparkline — per-bucket row counts for the active source across the
  // selected range (48 buckets).
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

  const levelButtons: {
    k: LevelFilter;
    label: string;
    color: string;
    count: number;
  }[] = [
    { k: "info", label: "info", color: "var(--muted-foreground)", count: counts.info },
    { k: "warn", label: "warn", color: "oklch(0.65 0.18 70)", count: counts.warn },
    { k: "error", label: "error", color: "var(--destructive)", count: counts.error },
  ];

  const exportNdjson = () => {
    if (filtered.length === 0) {
      pushToast(t`Nothing to export — the current view is empty.`, "error");
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
      pushToast(t`Exported ${filtered.length} rows as NDJSON.`);
    } catch {
      pushToast(t`Could not export logs.`, "error");
    }
  };

  return (
    <>
      {/* Source tabs + export */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {/* `flex-1 min-w-0` lets the lens strip claim the full row width and
            scroll within it (TabsList is overflow-x-auto), instead of being
            pinched by the export button on narrow screens. */}
        <Tabs
          className="min-w-0 flex-1"
          value={activeSrc}
          onValueChange={(v) => {
            setSrc(v as SourceId);
            setSelected(null);
          }}
        >
          <TabsList>
            {sources.map((s) => {
              const IconComp =
                (I as Record<string, IconComponent>)[s.icon] ?? I.Activity;
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
        <Button
          variant="outline"
          icon={I.Download}
          onClick={exportNdjson}
          aria-label={t`Export NDJSON`}
          // Icon-only on mobile (label hidden) so the lens strip gets the full
          // row width. `px-2` keeps the icon-only button square — the default
          // `pl-2 / pr-3` icon padding would leave dead space right of the icon.
          className="px-2 sm:px-3"
        >
          <span className="hidden sm:inline">
            <Trans>Export NDJSON</Trans>
          </span>
        </Button>
      </div>

      {/* Volume + level summary */}
      <div className="card flex flex-col gap-3 p-3.5 sm:flex-row sm:items-center sm:gap-3.5">
        <div
          className="sm:flex-1"
          style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 44 }}
        >
          {spark.map((v, i) => (
            <div
              // Bucket index is a stable position in a fixed-length array.
              key={`spark-${i}`}
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
        <div className="flex flex-wrap justify-end gap-2 sm:justify-start">
          {levelButtons.map((x) => (
            <Button
              key={x.k}
              variant={level === x.k ? "secondary" : "outline"}
              size="sm"
              onClick={() => setLevel((cur) => (cur === x.k ? "any" : x.k))}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 999,
                  background: x.color,
                  display: "inline-block",
                }}
              />
              <span className="font-mono">{x.label}</span>
              <span
                className="font-mono tabular-nums"
                style={{ color: "var(--muted-foreground)" }}
              >
                {x.count}
              </span>
            </Button>
          ))}
        </div>
      </div>

      {/* Log stream + detail */}
      <div
        className={`grid items-start gap-3.5${
          selected ? " lg:grid-cols-[1fr_400px]" : ""
        }`}
      >
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          {filtered.length === 0 ? (
            <EmptyState
              bare
              icon={I.ScrollText}
              title={<Trans>No log entries match</Trans>}
              description={<Trans>Try a wider time range or clear the level filter.</Trans>}
            />
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
                  <span
                    className={`log-method log-method-${r.method.toLowerCase()}`}
                    title={r.method}
                  >
                    {r.method}
                  </span>
                  {r.status != null && (
                    <span
                      className={`log-status log-s-${Math.floor(r.status / 100)}`}
                    >
                      {r.status}
                    </span>
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
          <LoadMoreBar
            loadedLabel={t`${filtered.length} shown · ${rows.length} loaded`}
            hasNextPage={hasNextPage}
            isFetchingNextPage={isFetchingNextPage}
            onLoadMore={onLoadMore}
          />
        </div>

        {selected && (
          <LogDetail
            row={selected}
            onClose={() => setSelected(null)}
            onCopyId={() => {
              try {
                void navigator.clipboard.writeText(selected.id);
                pushToast(t`Entry id copied to clipboard.`);
              } catch {
                pushToast(t`Could not copy entry id.`, "error");
              }
            }}
          />
        )}
      </div>
    </>
  );
}

const sectionLabel: CSSProperties = {
  fontSize: 11,
  color: "var(--muted-foreground)",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  marginBottom: 6,
};

function LogDetail({
  row,
  onClose,
  onCopyId,
}: {
  row: LogRow;
  onClose: () => void;
  onCopyId: () => void;
}) {
  return (
    <div className="card" style={{ position: "sticky", top: 16 }}>
      <div
        className="card-section"
        style={{ display: "flex", alignItems: "center", gap: 10 }}
      >
        <I.ScrollText size={14} />
        <span style={{ fontSize: 13, fontWeight: 500 }}><Trans>log entry</Trans></span>
        <span
          className="font-mono"
          style={{
            fontSize: 11,
            color: "var(--muted-foreground)",
            wordBreak: "break-all",
          }}
        >
          {row.id}
        </span>
        <div className="spacer" />
        <IconButton icon={I.X} onClick={onClose} />
      </div>
      <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 14 }}>
        <div>
          <div style={sectionLabel}><Trans>summary</Trans></div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginBottom: 6,
              flexWrap: "wrap",
            }}
          >
            <span className={`log-pill log-pill-${row.level}`}>{row.level}</span>
            <span className={`log-method log-method-${row.method.toLowerCase()}`}>
              {row.method}
            </span>
            {row.status != null && (
              <span className={`log-status log-s-${Math.floor(row.status / 100)}`}>
                {row.status}
              </span>
            )}
          </div>
          <div className="font-mono" style={{ fontSize: 12.5, wordBreak: "break-all" }}>
            {row.path}
          </div>
          <div style={{ fontSize: 12.5, marginTop: 6, color: "var(--foreground)" }}>
            {row.msg}
          </div>
        </div>

        <div>
          <div style={sectionLabel}><Trans>context</Trans></div>
          <KV k="id" v={row.id} mono />
          <KV k="time" v={row.ts ? new Date(row.ts).toISOString() : "—"} mono />
          <KV k="duration" v={row.ms != null ? `${row.ms} ms` : "—"} mono />
          <KV k="user" v={row.user} mono />
          <KV k="ip" v={row.ip ?? "—"} mono />
          {row.userAgent && <KV k="user-agent" v={row.userAgent} mono />}
        </div>

        {row.payload != null && (
          <div>
            <div style={sectionLabel}><Trans>payload</Trans></div>
            <pre className="code-block">{JSON.stringify(row.payload, null, 2)}</pre>
          </div>
        )}

        {row.response != null && (
          <div>
            <div style={sectionLabel}><Trans>response</Trans></div>
            <pre className="code-block">{JSON.stringify(row.response, null, 2)}</pre>
          </div>
        )}

        <div style={{ display: "flex", gap: 6 }}>
          <Button variant="outline" size="sm" icon={I.Copy} onClick={onCopyId}>
            <Trans>Copy id</Trans>
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

/* ------------------------------------------------------------------ */
/* Table view                                                          */
/* ------------------------------------------------------------------ */

const ADMIN_TABLE_CLS =
  "[&_td]:px-3.5 [&_td]:text-[13px] [&_th]:h-9 [&_th]:px-3.5 [&_th]:text-[11px] [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-[0.06em] [&_th]:text-muted-foreground";

const actionColor = (a: string): "default" | "secondary" | "destructive" | "outline" =>
  a.startsWith("item.")
    ? "default"
    : a.startsWith("auth.")
      ? "secondary"
      : a.startsWith("schema.")
        ? "destructive"
        : "outline";

/** A short, single-line summary of a row's payload for the Diff column. */
function diffSummary(payload: unknown): string {
  if (payload == null) return "—";
  if (typeof payload === "string") return payload.slice(0, 80);
  try {
    return JSON.stringify(payload).slice(0, 80);
  } catch {
    return "—";
  }
}

function TableView({
  rows,
  q,
  category,
  setCategory,
  openRow,
  setOpenRow,
  totalCount,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
  pushToast,
}: {
  rows: LogRow[];
  q: string;
  category: CategoryChip;
  setCategory: (c: CategoryChip) => void;
  openRow: LogRow | null;
  setOpenRow: (r: LogRow | null) => void;
  totalCount: number | null;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
  pushToast: (m: string, type?: "success" | "error") => void;
}) {
  const { t } = useLingui();
  // The action category is enforced server-side, so `rows` is already scoped.
  // Search is still a client-side text match over the loaded rows.
  const visible = useMemo(() => {
    if (!q) return rows;
    const needle = q.toLowerCase();
    return rows.filter((r) => {
      const hay =
        `${r.action} ${r.path} ${r.collection ?? ""} ${r.user} ${r.ip ?? ""} ${r.msg}`.toLowerCase();
      return hay.includes(needle);
    });
  }, [rows, q]);

  const exportCsv = () => {
    if (visible.length === 0) {
      pushToast(t`Nothing to export — the current view is empty.`, "error");
      return;
    }
    try {
      const rows = visible.map((r) => ({
        time: fmtTableTime(r.ts),
        actor: r.user,
        action: r.action,
        resource: `${r.collection ?? "—"}${r.itemId ? `/${r.itemId}` : ""}`,
        diff: diffSummary(r.payload),
        ip: r.ip ?? "—",
      }));
      exportToCsv(rows, "activity.csv", ["time", "actor", "action", "resource", "diff", "ip"]);
      pushToast(t`Exported ${visible.length} rows as activity.csv.`);
    } catch {
      pushToast(t`Could not export logs.`, "error");
    }
  };

  return (
    <>
      {/* Category chips (server-side action filter) + export */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Tabs
          className="min-w-0"
          value={category}
          onValueChange={(v) => setCategory(v as CategoryChip)}
        >
          <TabsList className="flex-wrap">
            {CATEGORY_CHIPS.map((k) => (
              <TabsTrigger key={k} value={k}>
                {k}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div style={{ flex: 1 }} />
        <Button variant="outline" icon={I.Download} onClick={exportCsv}>
          <Trans>Export CSV</Trans>
        </Button>
      </div>

      <Card className="py-0 gap-0">
        <Table className={ADMIN_TABLE_CLS}>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[160px] whitespace-nowrap"><Trans>Time</Trans></TableHead>
              <TableHead className="w-[90px] text-right"><Trans>Duration</Trans></TableHead>
              <TableHead className="w-[140px]"><Trans>Action</Trans></TableHead>
              <TableHead><Trans>Resource</Trans></TableHead>
              <TableHead><Trans>Diff</Trans></TableHead>
              <TableHead className="w-[130px]"><Trans>IP</Trans></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((r) => (
              <TableRow
                key={r.id}
                onClick={() => setOpenRow(r)}
                className="cursor-pointer"
                title={t`Click for full payload`}
              >
                <TableCell className="whitespace-nowrap font-mono text-[11.5px] tabular-nums text-muted-foreground">
                  {fmtTableTime(r.ts)}
                </TableCell>
                <TableCell className="whitespace-nowrap text-right font-mono text-[11.5px] tabular-nums text-muted-foreground">
                  {formatDuration(r.ms)}
                </TableCell>
                <TableCell>
                  <Badge variant={actionColor(r.action)} mono>
                    {r.action}
                  </Badge>
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {r.collection ?? "—"}
                  {r.itemId ? `/${r.itemId}` : ""}
                </TableCell>
                <TableCell className="font-mono text-[11.5px] text-muted-foreground">
                  {diffSummary(r.payload)}
                </TableCell>
                <TableCell className="font-mono text-[11.5px] text-muted-foreground">
                  {r.ip ?? "—"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <div className="flex items-center justify-between border-t border-border px-3.5 py-2.5">
          <span className="text-xs tabular-nums text-muted-foreground">
            {/* Counts are explicit about loaded-vs-total — chip counts that
             *  reflected only loaded rows were misleading, so they're gone. */}
            {q
              ? t`${visible.length} match · ${rows.length} loaded`
              : t`${rows.length} loaded`}
            {totalCount != null ? t` of ${totalCount}` : ""}
          </span>
          <Button
            variant="outline"
            disabled={!hasNextPage || isFetchingNextPage}
            onClick={onLoadMore}
          >
            {isFetchingNextPage
              ? <Trans>Loading…</Trans>
              : hasNextPage
                ? <Trans>Load more</Trans>
                : <Trans>No more rows</Trans>}
          </Button>
        </div>
      </Card>

      {openRow && (
        <ActivityEventDialog row={openRow} onClose={() => setOpenRow(null)} />
      )}
    </>
  );
}

function ActivityEventDialog({
  row,
  onClose,
}: {
  row: LogRow;
  onClose: () => void;
}) {
  const fullTs = (() => {
    const d = new Date(row.createdAt as string | number);
    return Number.isNaN(d.getTime())
      ? fmtTableTime(row.ts)
      : d.toISOString().replace("T", " ").replace("Z", " UTC");
  })();
  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="flex max-h-[min(86vh,720px)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[720px]">
        <DialogTitle className="sr-only">{`${row.action} activity detail`}</DialogTitle>
        <DialogHeader className="border-b border-border px-5 pb-3.5 pr-12 pt-[18px] text-left">
          <div className="mb-1 flex items-center gap-2">
            <Badge variant={actionColor(row.action)} mono>
              {row.action}
            </Badge>
            <span className="font-mono text-xs text-muted-foreground">
              {row.collection ?? "—"}
              {row.itemId ? `/${row.itemId}` : ""}
            </span>
          </div>
          <h3 className="m-0 text-sm font-medium">{row.user}</h3>
        </DialogHeader>
        <ScrollArea viewportClassName="max-h-[calc(min(86vh,720px)-10rem)]">
        <div className="flex flex-col gap-4 px-5 py-[18px]">
          <div className="grid grid-cols-[140px_1fr] gap-x-3.5 gap-y-2 text-[12.5px]">
            <span className="text-muted-foreground"><Trans>Time</Trans></span>
            <span className="font-mono">{fullTs}</span>
            <span className="text-muted-foreground"><Trans>Actor</Trans></span>
            <span className="font-mono [word-break:break-all]">{row.user}</span>
            <span className="text-muted-foreground"><Trans>Action</Trans></span>
            <span className="font-mono">{row.action}</span>
            <span className="text-muted-foreground"><Trans>Collection</Trans></span>
            <span className="font-mono">{row.collection ?? "—"}</span>
            {row.itemId && (
              <>
                <span className="text-muted-foreground"><Trans>Item ID</Trans></span>
                <span className="font-mono [word-break:break-all]">{row.itemId}</span>
              </>
            )}
            <span className="text-muted-foreground"><Trans>IP</Trans></span>
            <span className="font-mono">{row.ip ?? "—"}</span>
            {row.userAgent && (
              <>
                <span className="text-muted-foreground"><Trans>User-Agent</Trans></span>
                <span className="font-mono text-[11.5px] [word-break:break-all]">
                  {row.userAgent}
                </span>
              </>
            )}
            {row.ms != null && (
              <>
                <span className="text-muted-foreground"><Trans>Duration</Trans></span>
                <span className="font-mono tabular-nums">{row.ms} ms</span>
              </>
            )}
            <span className="text-muted-foreground"><Trans>Activity ID</Trans></span>
            <span className="font-mono text-[11.5px] [word-break:break-all]">
              {row.id}
            </span>
          </div>
          <JsonBlock label="Payload" value={row.payload} />
          {row.response != null && (
            <JsonBlock label="Response" value={row.response} />
          )}
        </div>
        </ScrollArea>
        <DialogFooter className="border-t border-border bg-[color-mix(in_oklch,var(--muted)_30%,var(--card))] px-4 py-3">
          <Button variant="ghost" size="sm" onClick={onClose}>
            <Trans>Close</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Shared                                                              */
/* ------------------------------------------------------------------ */

/** Footer with a loaded-count label and a "Load more" pagination button. */
function LoadMoreBar({
  loadedLabel,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
}: {
  loadedLabel: string;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
}) {
  return (
    <div className="flex items-center justify-between border-t border-border px-3.5 py-2.5">
      <span className="text-xs tabular-nums text-muted-foreground">
        {loadedLabel}
      </span>
      <Button
        variant="outline"
        size="sm"
        disabled={!hasNextPage || isFetchingNextPage}
        onClick={onLoadMore}
      >
        {isFetchingNextPage
          ? <Trans>Loading…</Trans>
          : hasNextPage
            ? <Trans>Load more</Trans>
            : <Trans>No more rows</Trans>}
      </Button>
    </div>
  );
}
