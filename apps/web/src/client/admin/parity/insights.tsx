// @ts-nocheck
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useIsMobile } from "@workeros/ui/hooks/use-mobile";
import { I } from "../icons";
import { Badge, Button, IconButton, PageHeader } from "../ui";
import { Select } from "../select";
import { ConfirmDialog } from "../sheet";
import { ApiError } from "@/lib/api";
import {
  collectionsApi,
  dbAdminApi,
  panelsApi,
  type ApiCollection,
  type ApiPanel,
} from "../api";

/**
 * 12-column drag/resize grid for the Insights dashboard. Pure DOM (no
 * react-grid-layout dep) — each cell is absolute-positioned over a
 * `position: relative` container, sized by `colW` (computed from the
 * container width / 12) and a fixed row height.
 *
 * In edit mode (`editing`):
 *  - The whole tile area becomes a move handle. Mouse drag changes the
 *    tile's grid origin in 1-col / 1-row steps.
 *  - A 14×14 corner square in the bottom-right is a resize handle —
 *    same conversion, but applied to (w, h).
 *  - On mouseup the parent gets `onLayoutChange(id, layout)` and is
 *    expected to PATCH the server. While dragging we keep the active
 *    tile on a local transform so the rest of the page doesn't reflow.
 */
function DashboardGrid({
  panels,
  layouts,
  editing,
  onLayoutChange,
  renderPanel,
}: {
  panels: ApiPanel[];
  layouts: Record<string, { x: number; y: number; w: number; h: number }>;
  editing: boolean;
  onLayoutChange: (id: string, layout: { x: number; y: number; w: number; h: number }) => void;
  renderPanel: (panel: ApiPanel) => ReactNode;
}) {
  const COLS = 12;
  const ROW_H = 84;
  const GAP = 12;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  // On narrow viewports the 12-column drag grid is unusable (cells get a
  // dozen pixels wide and there's no mouse for the drag handles). Fall back
  // to a single full-width column so panels stay readable; layout editing is
  // hidden upstream in that case.
  const stacked = width > 0 && width < 640;

  useLayoutEffect(() => {
    const update = () => setWidth(containerRef.current?.clientWidth ?? 0);
    update();
    if (typeof ResizeObserver === "undefined" || !containerRef.current) return;
    const obs = new ResizeObserver(update);
    obs.observe(containerRef.current);
    return () => obs.disconnect();
  }, [stacked]);

  const colW = width > 0 ? (width - GAP * (COLS - 1)) / COLS : 0;

  // Auto-place panels that don't have a saved layout yet — left-to-right
  // packing in 6×4 tiles. Existing layouts win.
  const finalLayouts = useMemo(() => {
    const out: Record<string, { x: number; y: number; w: number; h: number }> = {};
    let cx = 0;
    let cy = 0;
    for (const p of panels) {
      const saved = layouts[p.id];
      if (saved) {
        out[p.id] = saved;
      } else {
        out[p.id] = { x: cx, y: cy, w: 6, h: 4 };
        cx += 6;
        if (cx >= COLS) { cx = 0; cy += 4; }
      }
    }
    return out;
  }, [panels, layouts]);

  type Drag = {
    panelId: string;
    mode: "move" | "resize";
    startX: number;
    startY: number;
    base: { x: number; y: number; w: number; h: number };
    delta: { dx: number; dy: number };
  };
  const [drag, setDrag] = useState<Drag | null>(null);

  useEffect(() => {
    if (!drag) return;
    const onMove = (e: MouseEvent) => {
      if (colW <= 0) return;
      const dx = Math.round((e.clientX - drag.startX) / (colW + GAP));
      const dy = Math.round((e.clientY - drag.startY) / (ROW_H + GAP));
      setDrag((d) => (d ? { ...d, delta: { dx, dy } } : d));
    };
    const onUp = () => {
      const dx = drag.delta.dx;
      const dy = drag.delta.dy;
      const next = drag.mode === "move"
        ? {
            x: Math.max(0, Math.min(COLS - drag.base.w, drag.base.x + dx)),
            y: Math.max(0, drag.base.y + dy),
            w: drag.base.w,
            h: drag.base.h,
          }
        : {
            x: drag.base.x,
            y: drag.base.y,
            w: Math.max(2, Math.min(COLS - drag.base.x, drag.base.w + dx)),
            h: Math.max(2, drag.base.h + dy),
          };
      const changed =
        next.x !== drag.base.x ||
        next.y !== drag.base.y ||
        next.w !== drag.base.w ||
        next.h !== drag.base.h;
      if (changed) onLayoutChange(drag.panelId, next);
      setDrag(null);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    // colW dependency is intentional — drag conversion uses the current width
    // so the grid stays accurate during a window resize mid-drag.
  }, [drag, colW, onLayoutChange]);

  const totalRows = panels.reduce((max, p) => {
    const l = finalLayouts[p.id]!;
    const isActive = drag?.panelId === p.id;
    const dy = isActive && drag.mode === "move" ? drag.delta.dy : 0;
    const dh = isActive && drag.mode === "resize" ? drag.delta.dy : 0;
    return Math.max(max, l.y + dy + l.h + dh);
  }, 0);
  const containerHeight = totalRows > 0 ? totalRows * ROW_H + (totalRows - 1) * GAP : 200;

  if (stacked) {
    return (
      <div ref={containerRef} style={{ display: "flex", flexDirection: "column", gap: GAP, width: "100%" }}>
        {panels.map((p) => (
          <div key={p.id} style={{ width: "100%", minWidth: 0 }}>
            {renderPanel(p)}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      style={{ position: "relative", width: "100%", height: containerHeight, transition: drag ? "none" : "height 200ms ease" }}
    >
      {panels.map((p) => {
        const base = finalLayouts[p.id]!;
        const isActive = drag?.panelId === p.id;
        const dxApplied = isActive && drag.mode === "move" ? drag.delta.dx : 0;
        const dyApplied = isActive && drag.mode === "move" ? drag.delta.dy : 0;
        const dwApplied = isActive && drag.mode === "resize" ? drag.delta.dx : 0;
        const dhApplied = isActive && drag.mode === "resize" ? drag.delta.dy : 0;
        const xv = Math.max(0, Math.min(COLS - base.w, base.x + dxApplied));
        const yv = Math.max(0, base.y + dyApplied);
        const wv = Math.max(2, Math.min(COLS - xv, base.w + dwApplied));
        const hv = Math.max(2, base.h + dhApplied);
        return (
          <div
            key={p.id}
            style={{
              position: "absolute",
              left: xv * (colW + GAP),
              top: yv * (ROW_H + GAP),
              width: Math.max(0, wv * colW + (wv - 1) * GAP),
              height: hv * ROW_H + (hv - 1) * GAP,
              transition: isActive ? "none" : "left 200ms ease, top 200ms ease, width 200ms ease, height 200ms ease",
              boxShadow: isActive ? "0 8px 24px color-mix(in oklch, var(--primary) 25%, transparent)" : "none",
              zIndex: isActive ? 2 : 1,
            }}
          >
            <div style={{ position: "absolute", inset: 0, overflow: "auto", pointerEvents: editing ? "none" : "auto" }}>
              {renderPanel(p)}
            </div>
            {editing && (
              <>
                <div
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setDrag({ panelId: p.id, mode: "move", startX: e.clientX, startY: e.clientY, base, delta: { dx: 0, dy: 0 } });
                  }}
                  style={{
                    position: "absolute",
                    inset: 0,
                    cursor: "move",
                    background: "color-mix(in oklch, var(--primary) 6%, transparent)",
                    border: "1.5px dashed color-mix(in oklch, var(--primary) 55%, transparent)",
                    borderRadius: "var(--radius-md)",
                    zIndex: 3,
                  }}
                  title="Drag to move"
                >
                  <div style={{ position: "absolute", top: 6, left: 6, fontSize: 10.5, fontWeight: 500, color: "var(--primary)", background: "var(--card)", padding: "2px 6px", borderRadius: 4, display: "flex", alignItems: "center", gap: 4 }}>
                    <I.Pencil size={10} />{xv},{yv} · {wv}×{hv}
                  </div>
                </div>
                <div
                  onMouseDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setDrag({ panelId: p.id, mode: "resize", startX: e.clientX, startY: e.clientY, base, delta: { dx: 0, dy: 0 } });
                  }}
                  style={{
                    position: "absolute",
                    right: 4,
                    bottom: 4,
                    width: 16,
                    height: 16,
                    background: "var(--primary)",
                    borderRadius: 4,
                    cursor: "nwse-resize",
                    zIndex: 4,
                    boxShadow: "0 1px 2px rgba(0,0,0,0.25)",
                  }}
                  title="Drag to resize"
                />
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function InsightsPage({ pushToast }: { pushToast?: (m: string) => void } = {}) {
  const [panels, setPanels] = useState<ApiPanel[]>([]);
  const [results, setResults] = useState<Record<string, Record<string, unknown>[]>>({});
  const [runErrors, setRunErrors] = useState<Record<string, string>>({});
  const [editor, setEditor] = useState<{ mode: "create" } | { mode: "edit"; panel: ApiPanel } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ApiPanel | null>(null);
  const [editingLayout, setEditingLayout] = useState(false);
  const isMobile = useIsMobile();
  // The drag/resize layout editor needs a pointer and a wide grid — neither
  // exists on phones, where DashboardGrid falls back to a stacked column.
  const editing = editingLayout && !isMobile;
  // Local copy of each panel's grid layout. Updated optimistically on drag/
  // resize, then PATCHed back to the server. Falls back to an auto-laid-out
  // default for panels that have never been positioned.
  type Layout = { x: number; y: number; w: number; h: number };
  const [layouts, setLayouts] = useState<Record<string, Layout>>({});

  const reload = async () => {
    try {
      const r = await panelsApi.list();
      const list = r.data ?? [];
      setPanels(list);
      // Hydrate the local layouts map from the server's authoritative copy.
      // We replace rather than merge so panels deleted server-side fall out.
      const nextLayouts: Record<string, Layout> = {};
      for (const p of list) if (p.layout) nextLayouts[p.id] = p.layout;
      setLayouts(nextLayouts);
      // Run each SQL/items-aggregate panel in parallel; static panels render
      // from their config without a server roundtrip.
      const runs = await Promise.allSettled(
        list.filter((p) => p.kind === "sql" || p.kind === "items-aggregate").map(async (p) => {
          try {
            const out = await panelsApi.run(p.id);
            return { id: p.id, data: out.data, error: null as string | null };
          } catch (e) {
            return { id: p.id, data: null, error: (e as Error).message };
          }
        }),
      );
      const data: Record<string, Record<string, unknown>[]> = {};
      const errs: Record<string, string> = {};
      for (const r of runs) {
        if (r.status !== "fulfilled") continue;
        if (r.value.error) errs[r.value.id] = r.value.error;
        else if (r.value.data) data[r.value.id] = r.value.data;
      }
      setResults(data);
      setRunErrors(errs);
    } catch {
      // leave empty
    }
  };
  useEffect(() => { void reload(); }, []);

  const saveLayout = async (id: string, layout: Layout) => {
    // Optimistic — flip the local layout immediately so the drag preview
    // doesn't jump. If the PATCH errors we surface it via toast and reload.
    setLayouts((s) => ({ ...s, [id]: layout }));
    try {
      await panelsApi.update(id, { layout });
    } catch (e) {
      pushToast?.((e as Error).message);
      void reload();
    }
  };

  const renderPanelCard = (p: ApiPanel) => (
    <RealPanel
      panel={p}
      rows={results[p.id] ?? []}
      error={runErrors[p.id] ?? null}
      onEdit={editing ? undefined : () => setEditor({ mode: "edit", panel: p })}
      onDelete={editing ? undefined : () => setConfirmDelete(p)}
    />
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <PageHeader
        title="Insights"
        description="Build a panel from a collection (count / sum / average …) or a saved SQL query. Drag panels to lay out your dashboard."
        actions={
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {!isMobile && (
              <Button
                variant={editing ? "primary" : "outline"}
                icon={editing ? I.Check : I.Pencil}
                onClick={() => setEditingLayout((v) => !v)}
                disabled={panels.length === 0}
              >
                {editing ? "Done" : "Edit layout"}
              </Button>
            )}
            <Button variant="primary" icon={I.Plus} onClick={() => setEditor({ mode: "create" })}>New panel</Button>
          </div>
        }
      />
      {panels.length > 0 ? (
        <DashboardGrid
          panels={panels}
          layouts={layouts}
          editing={editing}
          onLayoutChange={saveLayout}
          renderPanel={renderPanelCard}
        />
      ) : (
        <div className="card" style={{ padding: 48, textAlign: "center", color: "var(--muted-foreground)", display: "flex", flexDirection: "column", gap: 12, alignItems: "center" }}>
          <I.BarChart size={28} className="muted" />
          <div style={{ fontSize: 14, fontWeight: 500, color: "var(--foreground)" }}>No insight panels yet</div>
          <div style={{ fontSize: 12.5, maxWidth: 460, lineHeight: 1.5 }}>
            Insight panels chart a collection aggregate (count / sum / average …) or a saved SQL query as a counter, sparkline, bars, donut, or table.
            Click <strong>+ New panel</strong> to build your first one — pick a collection, no SQL required.
          </div>
        </div>
      )}

      {editor && (
        <PanelEditorDialog
          mode={editor.mode}
          panel={editor.mode === "edit" ? editor.panel : null}
          existing={panels.map((p) => p.name)}
          onClose={() => setEditor(null)}
          onSaved={async (name, mode) => {
            setEditor(null);
            await reload();
            pushToast?.(mode === "create" ? `Panel "${name}" created.` : `Panel "${name}" saved.`);
          }}
        />
      )}

      <ConfirmDialog
        open={!!confirmDelete}
        title={confirmDelete ? `Delete "${confirmDelete.name}"?` : ""}
        description={
          <>
            This removes the panel from <span className="font-mono">saved_panels</span> and any dashboards that reference it.
            The query itself isn't run again. This action can't be undone.
          </>
        }
        actionLabel="Delete panel"
        destructive
        onCancel={() => setConfirmDelete(null)}
        onConfirm={async () => {
          if (!confirmDelete) return;
          const name = confirmDelete.name;
          try {
            await panelsApi.remove(confirmDelete.id);
            setConfirmDelete(null);
            await reload();
            pushToast?.(`Panel "${name}" deleted.`);
          } catch (e) {
            setConfirmDelete(null);
            pushToast?.((e as Error).message);
          }
        }}
      />
    </div>
  );
}

const SAMPLE_PANEL_SQL = "SELECT COUNT(*) AS n FROM user;";

type PanelKind = "sql" | "items-aggregate" | "static";
type PanelViz = "counter" | "sparkline" | "bars" | "donut" | "table";

const VIZ_DESCRIPTIONS: Record<PanelViz, string> = {
  counter: "single number",
  sparkline: "filled line over a numeric series",
  bars: "vertical bars over a numeric series",
  donut: "donut chart over up to 6 segments",
  table: "small key/value table",
};

/** Same SELECT-only check the server uses, kept in sync. */
const isReadOnlySelect = (s: string): { ok: boolean; reason?: string } => {
  const trimmed = s.trim().replace(/;$/, "");
  if (trimmed.length === 0) return { ok: false, reason: "SQL is empty." };
  if (!/^select\b/i.test(trimmed)) return { ok: false, reason: "Must start with SELECT." };
  if (/\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|attach|detach)\b/i.test(trimmed)) {
    return { ok: false, reason: "Writes (INSERT / UPDATE / DELETE / DROP / …) are blocked." };
  }
  return { ok: true };
};

/**
 * Map a Zod-style ApiError details list into per-field error messages keyed by
 * the form field id. The server's PanelInput uses the same field names as the
 * dialog's state, so the path's first segment is the lookup key.
 */
const distributeApiErrors = (
  err: unknown,
): { fieldErrors: Record<string, string>; topLevel: string | null } => {
  if (!(err instanceof ApiError)) {
    return { fieldErrors: {}, topLevel: err instanceof Error ? err.message : String(err) };
  }
  const fieldErrors: Record<string, string> = {};
  let topLevel: string | null = null;
  for (const d of err.details ?? []) {
    const key = d.path?.[0];
    if (typeof key === "string" && d.message) {
      fieldErrors[key] = d.message;
    } else if (d.message) {
      topLevel = topLevel ? `${topLevel} · ${d.message}` : d.message;
    }
  }
  if (Object.keys(fieldErrors).length === 0 && !topLevel) topLevel = err.message;
  return { fieldErrors, topLevel };
};

type ItemsAggFunc = "count" | "sum" | "avg" | "min" | "max";

interface ItemsAggregateState {
  collection: string;
  agg: ItemsAggFunc;
  field: string;
  groupBy: string;
  filter: string; // raw JSON; parsed at submit
  limit: string;  // string for input control; parsed at submit
}

const DEFAULT_AGG_STATE: ItemsAggregateState = {
  collection: "",
  agg: "count",
  field: "",
  groupBy: "",
  filter: "",
  limit: "",
};

function PanelEditorDialog({
  mode,
  panel,
  existing,
  onClose,
  onSaved,
}: {
  mode: "create" | "edit";
  panel: ApiPanel | null;
  existing: string[];
  onClose: () => void;
  onSaved: (name: string, mode: "create" | "edit") => void;
}) {
  const [name, setName] = useState(panel?.name ?? "");
  const [description, setDescription] = useState(panel?.description ?? "");
  const [kind, setKind] = useState<PanelKind>((panel?.kind as PanelKind) ?? "items-aggregate");
  const [viz, setViz] = useState<PanelViz>((panel?.viz as PanelViz) ?? "counter");
  const [sqlText, setSqlText] = useState<string>(panel?.sql ?? SAMPLE_PANEL_SQL);
  const [busy, setBusy] = useState(false);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [topError, setTopError] = useState<string | null>(null);

  // items-aggregate state. Hydrate from panel.config if present.
  const [agg, setAgg] = useState<ItemsAggregateState>(() => {
    const cfg = (panel?.config ?? {}) as Partial<ItemsAggregateState> & { filter?: unknown };
    return {
      collection: cfg.collection ?? "",
      agg: (cfg.agg as ItemsAggFunc) ?? "count",
      field: cfg.field ?? "",
      groupBy: cfg.groupBy ?? "",
      filter: cfg.filter ? JSON.stringify(cfg.filter, null, 2) : "",
      limit: cfg.limit !== undefined ? String(cfg.limit) : "",
    };
  });

  // Collections list for the items-aggregate selectors. Loaded once on mount;
  // per-collection schema is fetched on demand below.
  const [collections, setCollections] = useState<ApiCollection[]>([]);
  const [collectionsLoaded, setCollectionsLoaded] = useState(false);
  const [collectionSchema, setCollectionSchema] = useState<ApiCollection | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await collectionsApi.list();
        if (!cancelled) setCollections(r.data ?? []);
      } catch { /* leave empty; the editor will show a hint */ }
      finally { if (!cancelled) setCollectionsLoaded(true); }
    })();
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (!agg.collection) { setCollectionSchema(null); return; }
    let cancelled = false;
    void (async () => {
      try {
        const r = await collectionsApi.get(agg.collection);
        if (!cancelled) setCollectionSchema(r.data ?? null);
      } catch { setCollectionSchema(null); }
    })();
    return () => { cancelled = true; };
  }, [agg.collection]);

  // Live preview state.
  type PreviewResult = { rows: Record<string, unknown>[]; ms: number };
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);

  const trimmedName = name.trim();
  const otherNames = mode === "edit" && panel ? existing.filter((n) => n !== panel.name) : existing;
  const nameError =
    serverErrors.name ??
    (trimmedName.length === 0
      ? "Required."
      : trimmedName.length > 80
        ? "Max 80 characters."
        : otherNames.includes(trimmedName)
          ? "A panel with that name already exists."
          : null);

  const sqlCheck = isReadOnlySelect(sqlText);
  const sqlError =
    serverErrors.sql ??
    (kind === "sql" && !sqlCheck.ok ? sqlCheck.reason ?? "Invalid SQL." : null);

  const descError = serverErrors.description ?? (description.length > 500 ? "Max 500 characters." : null);

  // items-aggregate validation. Field/groupBy must reference real columns;
  // sum/avg/min/max require a numeric field; filter must parse as JSON.
  const numericFields = (collectionSchema?.fields ?? []).filter((f) => f.type === "integer" || f.type === "number");
  const allFieldsList = (collectionSchema?.fields ?? []).map((f) => f.name);
  const SYSTEM_GROUP_COLUMNS = ["created_at", "updated_at", "owner_id"];
  const groupByOptions = ["", ...allFieldsList, ...SYSTEM_GROUP_COLUMNS];
  let aggError: { collection?: string; agg?: string; field?: string; groupBy?: string; filter?: string; limit?: string } = {};
  if (kind === "items-aggregate") {
    if (!agg.collection) aggError.collection = "Required.";
    if (agg.agg !== "count") {
      if (!agg.field) aggError.field = "Required for sum/avg/min/max.";
      else if (numericFields.length > 0 && !numericFields.some((f) => f.name === agg.field)) {
        aggError.field = "Must be an integer or number column.";
      }
    }
    if (agg.groupBy && !groupByOptions.includes(agg.groupBy)) {
      aggError.groupBy = `"${agg.groupBy}" is not a column on this collection.`;
    }
    if (agg.filter.trim()) {
      try {
        const parsed = JSON.parse(agg.filter);
        if (typeof parsed !== "object" || parsed === null) {
          aggError.filter = "Must be a JSON object.";
        }
      } catch (e) {
        aggError.filter = `JSON parse error: ${(e as Error).message}`;
      }
    }
    if (agg.limit && (!/^\d+$/.test(agg.limit) || Number(agg.limit) < 1 || Number(agg.limit) > 200)) {
      aggError.limit = "Integer between 1 and 200.";
    }
  }
  // Merge server-side aggregate errors back in (server returns flat strings).
  if (serverErrors.config) aggError = { ...aggError, agg: serverErrors.config };

  const valid =
    !nameError &&
    !descError &&
    (kind !== "sql" || !sqlError) &&
    (kind !== "items-aggregate" || Object.keys(aggError).length === 0);

  // One-line "what feeds the chart" hint shown under the Visualization picker.
  const vizHint =
    kind === "items-aggregate"
      ? agg.groupBy
        ? `One row per "${agg.groupBy}" — bars / donut / table show the breakdown; counter shows only the first.`
        : "A single value — counter fits best; sparkline / bars need multiple rows."
      : kind === "sql"
        ? "Counter takes the first numeric column of row 1; sparkline / bars plot it across all rows; donut / table pair the first two columns."
        : `${VIZ_DESCRIPTIONS[viz]}.`;

  /** Compose the items-aggregate config payload. Returns null if not applicable. */
  const composeAggregateConfig = (): Record<string, unknown> | null => {
    if (kind !== "items-aggregate") return null;
    const cfg: Record<string, unknown> = {
      collection: agg.collection,
      agg: agg.agg,
    };
    if (agg.agg !== "count" && agg.field) cfg.field = agg.field;
    if (agg.groupBy) cfg.groupBy = agg.groupBy;
    if (agg.filter.trim()) cfg.filter = JSON.parse(agg.filter);
    if (agg.limit) cfg.limit = Number(agg.limit);
    return cfg;
  };

  const clearServerError = (key: string) => {
    if (!serverErrors[key]) return;
    setServerErrors((s) => {
      const next = { ...s };
      delete next[key];
      return next;
    });
  };

  const runPreview = async () => {
    if (kind === "sql") {
      if (!sqlCheck.ok) {
        setPreview(null);
        setPreviewError(sqlCheck.reason ?? "Invalid SQL.");
        return;
      }
      setPreviewBusy(true);
      setPreviewError(null);
      try {
        const start = performance.now();
        const r = await dbAdminApi.runSql(sqlText);
        const last = r.data?.[r.data.length - 1];
        const rows = (last?.rows ?? []) as Record<string, unknown>[];
        setPreview({ rows, ms: r.ms ?? Math.round(performance.now() - start) });
      } catch (e) {
        setPreview(null);
        setPreviewError((e as Error).message);
      } finally {
        setPreviewBusy(false);
      }
      return;
    }
    if (kind === "items-aggregate") {
      if (Object.keys(aggError).length > 0) {
        setPreview(null);
        const first = Object.values(aggError)[0];
        setPreviewError(first ?? "Invalid aggregate config.");
        return;
      }
      const cfg = composeAggregateConfig();
      if (!cfg) return;
      setPreviewBusy(true);
      setPreviewError(null);
      try {
        const r = await panelsApi.preview({ kind: "items-aggregate", config: cfg });
        setPreview({ rows: r.data ?? [], ms: r.ms ?? 0 });
      } catch (e) {
        setPreview(null);
        setPreviewError((e as Error).message);
      } finally {
        setPreviewBusy(false);
      }
    }
  };

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setServerErrors({});
    setTopError(null);
    try {
      const body = {
        name: trimmedName,
        description: description.trim() || null,
        kind,
        sql: kind === "sql" ? sqlText : null,
        viz,
        config: kind === "items-aggregate" ? composeAggregateConfig() : null,
        layout: null,
      };
      if (mode === "create") {
        await panelsApi.create(body);
      } else if (panel) {
        await panelsApi.update(panel.id, body);
      }
      onSaved(trimmedName, mode);
    } catch (e) {
      const { fieldErrors, topLevel } = distributeApiErrors(e);
      setServerErrors(fieldErrors);
      setTopError(topLevel);
    } finally {
      setBusy(false);
    }
  };

  const titleId = "panel-editor-title";

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        className="dialog-lg"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
        style={{ width: 720, maxWidth: "94vw", maxHeight: "90vh", display: "flex", flexDirection: "column" }}
      >
        <div className="sheet-header" style={{ borderBottom: "1px solid var(--border)" }}>
          <div style={{ flex: 1 }}>
            <h2 id={titleId}>{mode === "create" ? "New insight panel" : `Edit panel`}</h2>
            <p>
              {mode === "create"
                ? <>Saved as a row in <span className="font-mono">saved_panels</span>. Collection panels aggregate one collection (count / sum / average …); SQL panels run a read-only SELECT against the workspace database.</>
                : <>Editing <span className="font-mono">{panel?.id}</span>.</>}
            </p>
          </div>
          <IconButton icon={I.X} onClick={onClose} title="Close" />
        </div>

        <div className="dialog-body" style={{ overflow: "auto" }}>
          {topError && (
            <div className="field" style={{ background: "color-mix(in oklch, var(--destructive) 8%, var(--card))", border: "1px solid color-mix(in oklch, var(--destructive) 35%, var(--border))", padding: 10, borderRadius: "var(--radius-md)", color: "var(--destructive)", fontSize: 12.5, display: "flex", gap: 8, alignItems: "flex-start" }}>
              <I.AlertTriangle size={13} style={{ marginTop: 1, flex: "0 0 auto" }} />
              <span style={{ flex: 1, wordBreak: "break-word" }}>{topError}</span>
            </div>
          )}

          <div className="field">
            <label className="field-label" htmlFor="panel-name">
              Name <span style={{ color: "var(--destructive)" }}>*</span>
            </label>
            <input
              id="panel-name"
              className={`input ${nameError && (name || serverErrors.name) ? "error" : ""}`}
              autoFocus
              autoComplete="off"
              placeholder="Active users (24h)"
              value={name}
              onChange={(e) => { setName(e.target.value); clearServerError("name"); }}
            />
            {nameError && (name || serverErrors.name) ? (
              <div className="field-error"><I.AlertTriangle size={11} />{nameError}</div>
            ) : (
              <span className="field-hint">Shown as the panel title on the dashboard.</span>
            )}
          </div>

          <div className="field">
            <label className="field-label" htmlFor="panel-desc">
              Description <span className="muted" style={{ fontWeight: 400 }}>· optional</span>
            </label>
            <input
              id="panel-desc"
              className={`input ${descError ? "error" : ""}`}
              autoComplete="off"
              placeholder="Distinct users with a session in the last 24h"
              value={description}
              onChange={(e) => { setDescription(e.target.value); clearServerError("description"); }}
            />
            {descError && <div className="field-error"><I.AlertTriangle size={11} />{descError}</div>}
          </div>

          <div className="cols-2">
            <div className="field">
              <label className="field-label">Kind</label>
              <Select
                value={kind}
                onChange={(v) => { setKind(v as PanelKind); setPreview(null); setPreviewError(null); clearServerError("kind"); }}
                options={[
                  { value: "items-aggregate", label: "collection", hint: "count / sum / average over a collection — no SQL" },
                  { value: "sql", label: "sql", hint: "read-only SELECT against the workspace database" },
                  { value: "static", label: "static", hint: "config-only panel rendered from props" },
                ]}
              />
              {serverErrors.kind
                ? <div className="field-error"><I.AlertTriangle size={11} />{serverErrors.kind}</div>
                : <span className="field-hint">{kind === "items-aggregate" ? "Pick a collection and an aggregate below — no query to write." : kind === "sql" ? "Write a read-only SELECT below." : "Set the config object via the API once the panel exists."}</span>}
            </div>
            <div className="field">
              <label className="field-label">Visualization</label>
              <Select
                value={viz}
                onChange={(v) => { setViz(v as PanelViz); clearServerError("viz"); }}
                options={(Object.keys(VIZ_DESCRIPTIONS) as PanelViz[]).map((v) => ({
                  value: v,
                  label: v,
                  hint: VIZ_DESCRIPTIONS[v],
                }))}
              />
              {serverErrors.viz
                ? <div className="field-error"><I.AlertTriangle size={11} />{serverErrors.viz}</div>
                : <span className="field-hint">{vizHint}</span>}
            </div>
          </div>

          {kind === "sql" && (
            <>
              <div className="field">
                <label className="field-label" htmlFor="panel-sql">
                  SQL <Badge variant="outline" mono>SELECT only</Badge> <span style={{ color: "var(--destructive)" }}>*</span>
                  <div style={{ flex: 1 }} />
                  <Button
                    size="sm"
                    variant="outline"
                    icon={I.Play}
                    onClick={runPreview}
                    disabled={previewBusy || !sqlCheck.ok}
                    style={{ marginLeft: "auto", float: "right" }}
                  >
                    {previewBusy ? "Running…" : "Run preview"}
                  </Button>
                </label>
                <textarea
                  id="panel-sql"
                  className={`textarea font-mono ${sqlError ? "error" : ""}`}
                  style={{ minHeight: 140, fontSize: 12, whiteSpace: "pre" }}
                  spellCheck={false}
                  value={sqlText}
                  onChange={(e) => { setSqlText(e.target.value); clearServerError("sql"); setPreviewError(null); }}
                />
                {sqlError ? (
                  <div className="field-error"><I.AlertTriangle size={11} />{sqlError}</div>
                ) : (
                  <span className="field-hint">
                    The query runs verbatim. The visualization hint above explains how its columns map to the chart.
                  </span>
                )}
              </div>

              <PreviewBlock viz={viz} preview={preview} previewError={previewError} />
            </>
          )}

          {kind === "items-aggregate" && (
            <>
              <div className="cols-2">
                <div className="field">
                  <label className="field-label">Collection <span style={{ color: "var(--destructive)" }}>*</span></label>
                  <Select
                    value={agg.collection}
                    onChange={(v) => setAgg((s) => ({ ...s, collection: v, field: "", groupBy: "" }))}
                    placeholder={collections.length === 0 ? "No collections" : "Pick a collection…"}
                    options={collections.map((c) => ({ value: c.slug, label: c.slug, hint: `${c.fields.length} fields` }))}
                  />
                  {aggError.collection && collections.length > 0 && <div className="field-error"><I.AlertTriangle size={11} />{aggError.collection}</div>}
                  {collectionsLoaded && collections.length === 0 && (
                    <span className="field-hint">No collections in this workspace yet — create one first, or switch <strong>Kind</strong> to <span className="font-mono">sql</span>.</span>
                  )}
                </div>
                <div className="field">
                  <label className="field-label">Aggregate function</label>
                  <Select
                    value={agg.agg}
                    onChange={(v) => setAgg((s) => ({ ...s, agg: v as ItemsAggFunc, field: v === "count" ? "" : s.field }))}
                    options={[
                      { value: "count", label: "count", hint: "row count (no field needed)" },
                      { value: "sum", label: "sum", hint: "numeric column total" },
                      { value: "avg", label: "avg", hint: "numeric column average" },
                      { value: "min", label: "min", hint: "numeric column minimum" },
                      { value: "max", label: "max", hint: "numeric column maximum" },
                    ]}
                  />
                </div>
              </div>

              <div className="cols-2">
                <div className="field">
                  <label className="field-label">
                    Field {agg.agg !== "count" && <span style={{ color: "var(--destructive)" }}>*</span>}
                  </label>
                  <Select
                    value={agg.field}
                    onChange={(v) => setAgg((s) => ({ ...s, field: v }))}
                    placeholder={agg.agg === "count" ? "Not needed for count" : numericFields.length === 0 ? "No numeric columns" : "Pick a numeric field…"}
                    disabled={agg.agg === "count" || !agg.collection || numericFields.length === 0}
                    options={numericFields.map((f) => ({ value: f.name, label: f.name, hint: f.type }))}
                  />
                  {aggError.field && <div className="field-error"><I.AlertTriangle size={11} />{aggError.field}</div>}
                </div>
                <div className="field">
                  <label className="field-label">Group by <span className="muted" style={{ fontWeight: 400 }}>· optional</span></label>
                  <Select
                    value={agg.groupBy}
                    onChange={(v) => setAgg((s) => ({ ...s, groupBy: v }))}
                    placeholder={!agg.collection ? "Pick a collection first" : "(none)"}
                    disabled={!agg.collection}
                    options={[
                      { value: "", label: "(none)", hint: "single scalar value" },
                      ...allFieldsList.map((n) => ({ value: n, label: n })),
                      ...SYSTEM_GROUP_COLUMNS.map((n) => ({ value: n, label: n, hint: "system" })),
                    ]}
                  />
                  {aggError.groupBy && <div className="field-error"><I.AlertTriangle size={11} />{aggError.groupBy}</div>}
                </div>
              </div>

              <div className="field">
                <label className="field-label">
                  Filter <Badge variant="outline" mono>JSON DSL</Badge> <span className="muted" style={{ fontWeight: 400 }}>· optional</span>
                </label>
                <textarea
                  className={`textarea font-mono ${aggError.filter ? "error" : ""}`}
                  style={{ minHeight: 80, fontSize: 12, whiteSpace: "pre" }}
                  spellCheck={false}
                  placeholder={`{ "status": { "_eq": "published" } }`}
                  value={agg.filter}
                  onChange={(e) => setAgg((s) => ({ ...s, filter: e.target.value }))}
                />
                {aggError.filter ? (
                  <div className="field-error"><I.AlertTriangle size={11} />{aggError.filter}</div>
                ) : (
                  <span className="field-hint">
                    Same DSL as roles &amp; permissions. Operators: <span className="font-mono">_eq</span>, <span className="font-mono">_in</span>, <span className="font-mono">_gte</span>, … Variables: <span className="font-mono">$user.id</span>, <span className="font-mono">$now</span>, …
                  </span>
                )}
              </div>

              {agg.groupBy && (
                <div className="field">
                  <label className="field-label">Limit <span className="muted" style={{ fontWeight: 400 }}>· optional</span></label>
                  <input
                    className={`input tabular-nums ${aggError.limit ? "error" : ""}`}
                    type="number"
                    min={1}
                    max={200}
                    placeholder="50"
                    value={agg.limit}
                    onChange={(e) => setAgg((s) => ({ ...s, limit: e.target.value }))}
                  />
                  {aggError.limit ? (
                    <div className="field-error"><I.AlertTriangle size={11} />{aggError.limit}</div>
                  ) : (
                    <span className="field-hint">Caps the number of grouped rows returned (default 50, max 200).</span>
                  )}
                </div>
              )}

              <div className="field" style={{ display: "flex", justifyContent: "flex-end" }}>
                <Button
                  size="sm"
                  variant="outline"
                  icon={I.Play}
                  onClick={runPreview}
                  disabled={previewBusy || Object.keys(aggError).length > 0 || !agg.collection}
                >
                  {previewBusy ? "Running…" : "Run preview"}
                </Button>
              </div>

              <PreviewBlock viz={viz} preview={preview} previewError={previewError} />
            </>
          )}

          {kind === "static" && (
            <div className="field" style={{ background: "var(--muted)", padding: 12, borderRadius: "var(--radius-xl)", fontSize: 12.5, color: "var(--muted-foreground)", display: "flex", gap: 8, alignItems: "flex-start" }}>
              <I.AlertTriangle size={12} style={{ marginTop: 2, flex: "0 0 auto" }} />
              <span>static panels render their config object verbatim — set it from the API once the panel exists.</span>
            </div>
          )}
        </div>

        <div className="sheet-footer">
          <div className="spacer" />
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" icon={mode === "create" ? I.Plus : I.Save} onClick={submit} disabled={!valid || busy}>
            {busy ? (mode === "create" ? "Creating…" : "Saving…") : mode === "create" ? "Create panel" : "Save changes"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function PreviewTable({ rows }: { rows: Record<string, unknown>[] }) {
  const cols = Object.keys(rows[0] ?? {}).slice(0, 6);
  const max = 5;
  return (
    <div style={{ overflowX: "auto", border: "1px solid var(--border)", borderRadius: "var(--radius-md)", background: "var(--card)" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11.5 }}>
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c} className="font-mono" style={{ textAlign: "left", padding: "6px 8px", borderBottom: "1px solid var(--border)", color: "var(--muted-foreground)", fontWeight: 500 }}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, max).map((r, i) => (
            <tr key={i}>
              {cols.map((c) => (
                <td key={c} className="font-mono" style={{ padding: "6px 8px", borderTop: i === 0 ? "none" : "1px solid var(--border)", whiteSpace: "nowrap", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis" }}>
                  {r[c] === null || r[c] === undefined ? <span className="muted">∅</span> : typeof r[c] === "object" ? JSON.stringify(r[c]) : String(r[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > max && <div className="muted" style={{ padding: "6px 8px", fontSize: 11, borderTop: "1px solid var(--border)" }}>… and {rows.length - max} more</div>}
    </div>
  );
}

/**
 * Concrete "this column drives the chart" line, given the rows a preview/run
 * actually returned. Mirrors the auto-detection in RealPanel so the editor and
 * the dashboard agree on what each viz reads.
 */
function describeVizMapping(viz: PanelViz, rows: Record<string, unknown>[]): string {
  const first = rows[0] ?? {};
  const cols = Object.keys(first);
  const numericCol = cols.find((c) => typeof first[c] === "number");
  const labelCol = cols.find((c) => c !== numericCol);
  if (viz === "counter") {
    return numericCol
      ? `Counter → "${numericCol}" from the first row (${Number(first[numericCol]).toLocaleString()}).`
      : `Counter → no numeric column, so it shows the row count (${rows.length}).`;
  }
  if (viz === "sparkline" || viz === "bars") {
    const col = numericCol ?? cols[0];
    const label = viz === "bars" ? "Bars" : "Sparkline";
    return col
      ? `${label} → "${col}" across all ${rows.length} row${rows.length === 1 ? "" : "s"}.`
      : `${label} → the first numeric column across all rows.`;
  }
  // donut | table
  const lc = labelCol ?? cols[0];
  const vc = numericCol ?? cols[1];
  const label = viz === "donut" ? "Donut" : "Table";
  return lc && vc
    ? `${label} → "${lc}" (label) paired with "${vc}" (value).`
    : `${label} → the first two columns: label, then value.`;
}

/** Shared preview panel for the editor (SQL + collection kinds use the same UI). */
function PreviewBlock({
  viz,
  preview,
  previewError,
}: {
  viz: PanelViz;
  preview: { rows: Record<string, unknown>[]; ms: number } | null;
  previewError: string | null;
}) {
  if (!preview && !previewError) return null;
  return (
    <div className="field" style={{ background: "var(--muted)", padding: 10, borderRadius: "var(--radius-md)" }}>
      <div className="field-label" style={{ marginBottom: 6 }}>
        {previewError
          ? <><I.AlertTriangle size={12} style={{ color: "var(--destructive)" }} /> Preview error</>
          : <><I.Activity size={12} /> Preview · {preview?.rows.length ?? 0} rows · {preview?.ms ?? 0}ms</>}
      </div>
      {previewError ? (
        <div className="font-mono" style={{ fontSize: 11.5, color: "var(--destructive)", whiteSpace: "pre-wrap" }}>{previewError}</div>
      ) : preview && preview.rows.length > 0 ? (
        <>
          <PreviewTable rows={preview.rows} />
          <div className="muted" style={{ fontSize: 11.5, marginTop: 6, display: "flex", gap: 6, alignItems: "center" }}>
            <I.BarChart size={11} style={{ flex: "0 0 auto" }} />
            <span>{describeVizMapping(viz, preview.rows)}</span>
          </div>
        </>
      ) : (
        <div className="muted" style={{ fontSize: 12 }}>No rows returned.</div>
      )}
    </div>
  );
}

/** One-line summary of what a saved panel shows, used as the card subtitle when
 *  the author didn't write a description. */
function panelSubtitle(panel: ApiPanel, rowCount: number): string {
  if (panel.description) return panel.description;
  if (panel.kind === "items-aggregate") {
    const cfg = (panel.config ?? {}) as { collection?: string; agg?: string; field?: string; groupBy?: string };
    const fn = !cfg.agg || cfg.agg === "count" ? "count" : `${cfg.agg}(${cfg.field ?? "?"})`;
    return `${cfg.collection ?? "collection"} · ${fn}${cfg.groupBy ? ` by ${cfg.groupBy}` : ""}`;
  }
  if (panel.kind === "sql") return `${rowCount} row${rowCount === 1 ? "" : "s"} · sql`;
  return panel.kind;
}

/**
 * Renders a saved panel using its viz config and the rows returned by
 * /api/admin/panels/:id/run. We pick the first numeric column for sparkline
 * /bars/counter, pair the first two columns for table/donut, and fall back
 * to JSON for anything we can't auto-detect.
 */
function RealPanel({
  panel,
  rows,
  error,
  onEdit,
  onDelete,
}: {
  panel: ApiPanel;
  rows: Record<string, unknown>[];
  error?: string | null;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  const sub = panelSubtitle(panel, rows.length);

  if (error) {
    return (
      <Panel title={panel.name} sub={sub} onEdit={onEdit} onDelete={onDelete}>
        <div style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "10px 12px", borderRadius: "var(--radius-md)", background: "color-mix(in oklch, var(--destructive) 8%, var(--card))", border: "1px solid color-mix(in oklch, var(--destructive) 35%, var(--border))", color: "var(--destructive)", fontSize: 12 }}>
          <I.AlertTriangle size={13} style={{ marginTop: 1, flex: "0 0 auto" }} />
          <span style={{ flex: 1, wordBreak: "break-word" }}>{error}</span>
        </div>
      </Panel>
    );
  }

  if (rows.length === 0) {
    return (
      <Panel title={panel.name} sub={sub} onEdit={onEdit} onDelete={onDelete}>
        <div className="muted" style={{ fontSize: 12, padding: "16px 0" }}>No data yet — run the panel.</div>
      </Panel>
    );
  }
  const cols = Object.keys(rows[0] ?? {});
  const numericCol = cols.find((c) => typeof rows[0]![c] === "number");
  const labelCol = cols.find((c) => c !== numericCol);

  if (panel.viz === "counter") {
    const v = numericCol ? Number(rows[0]![numericCol]) : rows.length;
    return (
      <Panel title={panel.name} sub={sub} onEdit={onEdit} onDelete={onDelete}>
        <div className="tabular-nums" style={{ fontSize: 32, fontWeight: 600, padding: "8px 0" }}>
          {v.toLocaleString()}
        </div>
      </Panel>
    );
  }

  if (panel.viz === "sparkline" || panel.viz === "bars") {
    const data = rows.map((r) => Number(r[numericCol ?? cols[0]!]) || 0);
    return (
      <Panel title={panel.name} sub={sub} onEdit={onEdit} onDelete={onDelete}>
        <Sparkline data={data} height={160} fill={panel.viz === "sparkline"} bars={panel.viz === "bars"} />
      </Panel>
    );
  }

  if (panel.viz === "donut") {
    const segs = rows.slice(0, 6).map((r, i) => ({
      v: Number(r[numericCol ?? cols[1]!]) || 0,
      color: ["var(--primary)", "oklch(0.7 0.18 260)", "oklch(0.78 0.16 75)", "oklch(0.6 0 0)", "oklch(0.7 0.18 22)", "oklch(0.7 0.18 320)"][i]!,
    }));
    return (
      <Panel title={panel.name} sub={sub} onEdit={onEdit} onDelete={onDelete}>
        <div style={{ display: "flex", alignItems: "center", gap: 18, padding: "12px 0" }}>
          <Donut segments={segs} />
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6, fontSize: 12.5 }}>
            {rows.slice(0, 6).map((r, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: segs[i]!.color }} />
                <span className="font-mono" style={{ flex: 1 }}>{String(r[labelCol ?? cols[0]!])}</span>
                <span className="tabular-nums">{Number(r[numericCol ?? cols[1]!])}</span>
              </div>
            ))}
          </div>
        </div>
      </Panel>
    );
  }

  // Fallback: small table.
  return (
    <Panel title={panel.name} sub={sub} onEdit={onEdit} onDelete={onDelete}>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
        {rows.slice(0, 8).map((r, i) => (
          <div key={i} className="font-mono" style={{ display: "flex", justifyContent: "space-between", borderBottom: i < Math.min(rows.length, 8) - 1 ? "1px solid var(--border)" : "none", paddingBottom: 4 }}>
            <span>{String(r[labelCol ?? cols[0]!])}</span>
            <span className="tabular-nums">{numericCol ? Number(r[numericCol]).toLocaleString() : ""}</span>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function Panel({
  title,
  sub,
  children,
  onEdit,
  onDelete,
}: {
  title: string;
  sub: string;
  children: ReactNode;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  return (
    <div className="card" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 500 }}>{title}</span>
        <span className="muted" style={{ fontSize: 11.5, flex: 1 }}>{sub}</span>
        {onEdit && <IconButton icon={I.Pencil} onClick={onEdit} title="Edit panel" />}
        {onDelete && <IconButton icon={I.Trash} onClick={onDelete} title="Delete panel" />}
      </div>
      {children}
    </div>
  );
}

function Sparkline({ data, height = 60, fill, bars }: { data: number[]; height?: number; fill?: boolean; bars?: boolean }) {
  const max = Math.max(...data, 1);
  const w = 100, h = height;
  if (bars) {
    return (
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ width: "100%", height }}>
        {data.map((v, i) => (
          <rect key={i} x={i * (w / data.length) + 0.4} y={h - (v / max) * h} width={(w / data.length) - 0.8} height={(v / max) * h} fill="var(--primary)" rx="0.6" />
        ))}
      </svg>
    );
  }
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * w},${h - (v / max) * h}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ width: "100%", height }}>
      {fill && <polyline points={`0,${h} ${pts} ${w},${h}`} fill="color-mix(in oklch, var(--primary) 18%, transparent)" stroke="none" />}
      <polyline points={pts} fill="none" stroke="var(--primary)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Donut({ segments }: { segments: { v: number; color: string }[] }) {
  const total = segments.reduce((a, s) => a + s.v, 0);
  let acc = 0;
  const r = 36, cx = 50, cy = 50;
  return (
    <svg width="120" height="120" viewBox="0 0 100 100">
      {segments.map((s, i) => {
        const a0 = (acc / total) * Math.PI * 2 - Math.PI / 2;
        acc += s.v;
        const a1 = (acc / total) * Math.PI * 2 - Math.PI / 2;
        const x0 = cx + Math.cos(a0) * r, y0 = cy + Math.sin(a0) * r;
        const x1 = cx + Math.cos(a1) * r, y1 = cy + Math.sin(a1) * r;
        const large = s.v / total > 0.5 ? 1 : 0;
        return <path key={i} d={`M${cx},${cy} L${x0},${y0} A${r},${r} 0 ${large} 1 ${x1},${y1} Z`} fill={s.color} />;
      })}
      <circle cx={cx} cy={cy} r="22" fill="var(--card)" />
    </svg>
  );
}
