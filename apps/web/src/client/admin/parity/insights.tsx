// @ts-nocheck
import type { PushToast } from "../types";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { useIsMobile } from "@backlex/ui/hooks/use-mobile";
import { Input } from "@backlex/ui/components/input";
import { ScrollArea } from "@backlex/ui/components/scroll-area";
import { Textarea } from "@backlex/ui/components/textarea";
import { Card } from "@backlex/ui/components/card";
import { Tabs, TabsList, TabsTrigger } from "@backlex/ui/components/tabs";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@backlex/ui/components/dialog";
import { I } from "../icons";
import { Badge, Button, EmptyState, IconButton, PageHeader, Switch } from "../ui";
import { Select } from "../select";
import { ConfirmDialog } from "../sheet";
import { ApiError } from "@/lib/api";
import {
  collectionsApi,
  dashboardsApi,
  dbAdminApi,
  kpisApi,
  panelsApi,
  rolesApi,
  type ApiCollection,
  type ApiDashboard,
  type ApiKpi,
  type ApiPanel,
  type ApiRole,
} from "../api";
import { PanelBody, panelSubtitle } from "../panel-render";
import { detectSeries, MAX_SERIES } from "../panel-series";
import { InsightsSkeleton } from "../page-skeletons";

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
  const { t } = useLingui();
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
    // Vertical compaction — tiles sit at their absolute saved `y`, so deleted
    // or moved panels used to leave permanent empty bands in the grid. Scan
    // top-to-bottom and pull every tile up until it rests on the lowest
    // x-overlapping tile above it (react-grid-layout's "vertical compact").
    // x/w/h stay untouched; saved layouts are not rewritten — this is a
    // display-time collapse, recomputed whenever panels/layouts change.
    const ids = Object.keys(out).sort(
      (a, b) => out[a]!.y - out[b]!.y || out[a]!.x - out[b]!.x,
    );
    const placed: { x: number; y: number; w: number; h: number }[] = [];
    for (const id of ids) {
      const l = out[id]!;
      let y = 0;
      for (const q of placed) {
        if (l.x < q.x + q.w && q.x < l.x + l.w) y = Math.max(y, q.y + q.h);
      }
      const next = { ...l, y };
      out[id] = next;
      placed.push(next);
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
                  title={t`Drag to move`}
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
                  title={t`Drag to resize`}
                />
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function InsightsPage({ pushToast }: { pushToast?: PushToast } = {}) {
  const { t } = useLingui();
  const [panels, setPanels] = useState<ApiPanel[]>([]);
  // First-load gate — drives the page skeleton until panels land.
  const [loaded, setLoaded] = useState(false);
  const [results, setResults] = useState<Record<string, Record<string, unknown>[]>>({});
  const [runErrors, setRunErrors] = useState<Record<string, string>>({});
  const [editor, setEditor] = useState<{ mode: "create" } | { mode: "edit"; panel: ApiPanel } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ApiPanel | null>(null);
  const [editingLayout, setEditingLayout] = useState(false);
  // Dashboards group panels. `selected` drives the picker: "" = All panels,
  // "none" = ungrouped/loose, or a dashboard id. New panels created while a
  // dashboard is selected are bound to it.
  const [dashboards, setDashboards] = useState<ApiDashboard[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [newDashOpen, setNewDashOpen] = useState(false);
  const [shareFor, setShareFor] = useState<ApiDashboard | null>(null);
  const [reportFor, setReportFor] = useState<ApiDashboard | null>(null);
  const [confirmDeleteDash, setConfirmDeleteDash] = useState<ApiDashboard | null>(null);
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
      const [r, dr] = await Promise.all([
        panelsApi.list(),
        dashboardsApi.list().catch(() => ({ data: [] as ApiDashboard[] })),
      ]);
      setDashboards(dr.data ?? []);
      const list = r.data ?? [];
      setPanels(list);
      // Hydrate the local layouts map from the server's authoritative copy.
      // We replace rather than merge so panels deleted server-side fall out.
      const nextLayouts: Record<string, Layout> = {};
      for (const p of list) if (p.layout) nextLayouts[p.id] = p.layout;
      setLayouts(nextLayouts);
      // Run each server-backed panel in parallel; static panels render from
      // their config without a roundtrip. `kpi` belongs here — omitting it
      // would leave those tiles permanently blank with no error to explain it.
      const runs = await Promise.allSettled(
        list.filter((p) => p.kind === "sql" || p.kind === "items-aggregate" || p.kind === "kpi").map(async (p) => {
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
  useEffect(() => { void reload().finally(() => setLoaded(true)); }, []);

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

  // First whole-page fetch — insight panels haven't landed yet.
  if (!loaded) return <InsightsSkeleton />;

  const selectedDash =
    selected && selected !== "none" ? dashboards.find((d) => d.id === selected) ?? null : null;
  const visiblePanels =
    selected === ""
      ? panels
      : selected === "none"
        ? panels.filter((p) => !p.dashboardId)
        : panels.filter((p) => p.dashboardId === selected);

  return (
    <div className="flex flex-col gap-4.5">
      <PageHeader
        title={t`Insights`}
        description={t`Group panels into dashboards, build them from a collection (count / sum / average …) or a saved SQL query, then publish a dashboard to a public embed URL.`}
        actions={
          <div className="flex flex-wrap justify-end gap-2">
            {selectedDash && (
              <>
                <Button icon={I.Download} variant="outline" onClick={() => setReportFor(selectedDash)}>
                  <Trans>Report</Trans>
                </Button>
                <Button
                  variant={selectedDash.embedEnabled ? "primary" : "outline"}
                  icon={I.Link}
                  onClick={() => setShareFor(selectedDash)}
                >
                  {selectedDash.embedEnabled ? <Trans>Embed live</Trans> : <Trans>Share</Trans>}
                </Button>
              </>
            )}
            {!isMobile && (
              <Button
                variant={editing ? "primary" : "outline"}
                icon={editing ? I.Check : I.Pencil}
                onClick={() => setEditingLayout((v) => !v)}
                disabled={visiblePanels.length === 0}
              >
                {editing ? <Trans>Done</Trans> : <Trans>Edit layout</Trans>}
              </Button>
            )}
            <Button variant="primary" icon={I.Plus} onClick={() => setEditor({ mode: "create" })}><Trans>New panel</Trans></Button>
          </div>
        }
      />

      {/* Dashboard picker — All / each dashboard / ungrouped + New. */}
      <div className="flex flex-wrap items-center gap-1.5">
        <Tabs className="min-w-0" value={selected} onValueChange={setSelected}>
          <TabsList className="h-auto! w-full flex-wrap sm:w-fit">
            <TabsTrigger value="">
              <Trans>All</Trans>
              <span className="rounded-sm border border-border bg-muted px-[5px] py-px font-mono text-[11px] text-muted-foreground">
                {panels.length}
              </span>
            </TabsTrigger>
            {dashboards.map((d) => (
              <TabsTrigger key={d.id} value={d.id}>
                {d.name}
                {d.embedEnabled && <I.Link size={11} className="text-primary" />}
              </TabsTrigger>
            ))}
            <TabsTrigger value="none">
              <Trans>Ungrouped</Trans>
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <Button size="sm" variant="ghost" icon={I.Plus} onClick={() => setNewDashOpen(true)}>
          <Trans>New dashboard</Trans>
        </Button>
        {selectedDash && (
          <IconButton
            icon={I.Trash}
            title={t`Delete dashboard`}
            onClick={() => setConfirmDeleteDash(selectedDash)}
          />
        )}
      </div>

      {visiblePanels.length > 0 ? (
        <DashboardGrid
          panels={visiblePanels}
          layouts={layouts}
          editing={editing}
          onLayoutChange={saveLayout}
          renderPanel={renderPanelCard}
        />
      ) : (
        <EmptyState
          icon={I.BarChart}
          title={selectedDash ? <Trans>This dashboard has no panels yet</Trans> : <Trans>No insight panels yet</Trans>}
          description={
            <Trans>Insight panels chart a collection aggregate (count / sum / average …) or a saved SQL query as a counter, sparkline, bars, donut, or table.
            Click <strong>+ New panel</strong> to build your first one — pick a collection, no SQL required.</Trans>
          }
        />
      )}

      {editor && (
        <PanelEditorDialog
          mode={editor.mode}
          panel={editor.mode === "edit" ? editor.panel : null}
          existing={panels.map((p) => p.name)}
          dashboardId={editor.mode === "create" && selected && selected !== "none" ? selected : null}
          onClose={() => setEditor(null)}
          onSaved={async (name, mode) => {
            setEditor(null);
            await reload();
            pushToast?.(mode === "create" ? t`Panel "${name}" created.` : t`Panel "${name}" saved.`);
          }}
        />
      )}

      {newDashOpen && (
        <NewDashboardDialog
          existing={dashboards.map((d) => d.name)}
          onClose={() => setNewDashOpen(false)}
          onCreated={async (id, name) => {
            setNewDashOpen(false);
            await reload();
            setSelected(id);
            pushToast?.(t`Dashboard "${name}" created.`);
          }}
        />
      )}

      {reportFor && (
        <ReportDashboardDialog
          dashboard={reportFor}
          onClose={() => setReportFor(null)}
          pushToast={pushToast}
        />
      )}

      {shareFor && (
        <ShareDashboardDialog
          dashboard={shareFor}
          onClose={() => setShareFor(null)}
          onChanged={async () => {
            await reload();
          }}
          pushToast={pushToast}
        />
      )}

      <ConfirmDialog
        open={!!confirmDeleteDash}
        title={confirmDeleteDash ? t`Delete dashboard "${confirmDeleteDash.name}"?` : ""}
        description={
          <Trans>
            This deletes the dashboard and disables its public embed. Its panels are <strong>not</strong> deleted —
            they become ungrouped. This action can't be undone.
          </Trans>
        }
        actionLabel={t`Delete dashboard`}
        destructive
        onCancel={() => setConfirmDeleteDash(null)}
        onConfirm={async () => {
          if (!confirmDeleteDash) return;
          const name = confirmDeleteDash.name;
          try {
            await dashboardsApi.remove(confirmDeleteDash.id);
            setConfirmDeleteDash(null);
            setSelected("");
            await reload();
            pushToast?.(t`Dashboard "${name}" deleted.`);
          } catch (e) {
            setConfirmDeleteDash(null);
            pushToast?.((e as Error).message);
          }
        }}
      />

      <ConfirmDialog
        open={!!confirmDelete}
        title={confirmDelete ? t`Delete "${confirmDelete.name}"?` : ""}
        description={
          <Trans>
            This removes the panel from <span className="font-mono">saved_panels</span> and any dashboards that reference it.
            The query itself isn't run again. This action can't be undone.
          </Trans>
        }
        actionLabel={t`Delete panel`}
        destructive
        onCancel={() => setConfirmDelete(null)}
        onConfirm={async () => {
          if (!confirmDelete) return;
          const name = confirmDelete.name;
          try {
            await panelsApi.remove(confirmDelete.id);
            setConfirmDelete(null);
            await reload();
            pushToast?.(t`Panel "${name}" deleted.`);
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

type PanelKind = "sql" | "items-aggregate" | "kpi" | "static";
type PanelViz =
  | "counter"
  | "sparkline"
  | "line"
  | "area"
  | "bars"
  | "stacked-bars"
  | "donut"
  | "pie"
  | "radar"
  | "radial"
  | "table";

const VIZ_DESCRIPTIONS: Record<PanelViz, string> = {
  counter: "single number",
  sparkline: "compact filled line, no axes",
  line: "line chart with axis + hover values",
  area: "filled line chart with axis + hover values",
  bars: "vertical bars with axis + hover values",
  "stacked-bars": "stacked bars — one layer per numeric column",
  donut: "donut chart over up to 6 segments",
  pie: "pie chart over up to 6 segments",
  radar: "radar over the label axis — one shape per numeric column",
  radial: "radial bars over up to 6 segments",
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

const _DEFAULT_AGG_STATE: ItemsAggregateState = {
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
  dashboardId,
  onClose,
  onSaved,
}: {
  mode: "create" | "edit";
  panel: ApiPanel | null;
  existing: string[];
  dashboardId?: string | null;
  onClose: () => void;
  onSaved: (name: string, mode: "create" | "edit") => void;
}) {
  const { t } = useLingui();
  const [name, setName] = useState(panel?.name ?? "");
  const [description, setDescription] = useState(panel?.description ?? "");
  const [kind, setKind] = useState<PanelKind>((panel?.kind as PanelKind) ?? "items-aggregate");
  const [viz, setViz] = useState<PanelViz>((panel?.viz as PanelViz) ?? "counter");
  const [sqlText, setSqlText] = useState<string>(panel?.sql ?? SAMPLE_PANEL_SQL);
  // `kpi` panels store only a slug + a window; the formula stays in the KPI.
  const [kpiSlug, setKpiSlug] = useState<string>(
    (panel?.config as { kpi?: string } | null)?.kpi ?? "",
  );
  const [kpiRangeDays, setKpiRangeDays] = useState<string>(
    String((panel?.config as { rangeDays?: number } | null)?.rangeDays ?? 30),
  );
  const [kpiOptions, setKpiOptions] = useState<ApiKpi[]>([]);
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

  // The workspace's KPI definitions, for the `kpi` kind's picker. Loaded on
  // mount alongside collections so switching kind doesn't stall on a fetch.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await kpisApi.list();
        if (!cancelled) setKpiOptions(r.data ?? []);
      } catch { /* leave empty; the field explains there are none */ }
    })();
    return () => { cancelled = true; };
  }, []);

  // Live preview state.
  type PreviewResult = { rows: Record<string, unknown>[]; ms: number };
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  // Gate inline "Required." messages until the user actually attempts to create —
  // otherwise the Collection field screams red the instant the dialog opens.
  const [triedSubmit, setTriedSubmit] = useState(false);

  const trimmedName = name.trim();
  const otherNames = mode === "edit" && panel ? existing.filter((n) => n !== panel.name) : existing;
  const nameError =
    serverErrors.name ??
    (trimmedName.length === 0
      ? t`Required.`
      : trimmedName.length > 80
        ? t`Max 80 characters.`
        : otherNames.includes(trimmedName)
          ? t`A panel with that name already exists.`
          : null);

  const sqlCheck = isReadOnlySelect(sqlText);
  const sqlError =
    serverErrors.sql ??
    (kind === "sql" && !sqlCheck.ok ? sqlCheck.reason ?? t`Invalid SQL.` : null);

  const descError = serverErrors.description ?? (description.length > 500 ? t`Max 500 characters.` : null);

  // items-aggregate validation. Field/groupBy must reference real columns;
  // sum/avg/min/max require a numeric field; filter must parse as JSON.
  const numericFields = (collectionSchema?.fields ?? []).filter((f) => f.type === "integer" || f.type === "number");
  const allFieldsList = (collectionSchema?.fields ?? []).map((f) => f.name);
  const SYSTEM_GROUP_COLUMNS = ["created_at", "updated_at", "owner_id"];
  const groupByOptions = ["", ...allFieldsList, ...SYSTEM_GROUP_COLUMNS];
  let aggError: { collection?: string; agg?: string; field?: string; groupBy?: string; filter?: string; limit?: string } = {};
  if (kind === "items-aggregate") {
    if (!agg.collection) aggError.collection = t`Required.`;
    if (agg.agg !== "count") {
      if (!agg.field) aggError.field = t`Required for sum/avg/min/max.`;
      else if (numericFields.length > 0 && !numericFields.some((f) => f.name === agg.field)) {
        aggError.field = t`Must be an integer or number column.`;
      }
    }
    if (agg.groupBy && !groupByOptions.includes(agg.groupBy)) {
      aggError.groupBy = t`"${agg.groupBy}" is not a column on this collection.`;
    }
    if (agg.filter.trim()) {
      try {
        const parsed = JSON.parse(agg.filter);
        if (typeof parsed !== "object" || parsed === null) {
          aggError.filter = t`Must be a JSON object.`;
        }
      } catch (e) {
        aggError.filter = t`JSON parse error: ${(e as Error).message}`;
      }
    }
    if (agg.limit && (!/^\d+$/.test(agg.limit) || Number(agg.limit) < 1 || Number(agg.limit) > 200)) {
      aggError.limit = t`Integer between 1 and 200.`;
    }
  }
  // Merge server-side aggregate errors back in (server returns flat strings).
  if (serverErrors.config) aggError = { ...aggError, agg: serverErrors.config };

  const valid =
    !nameError &&
    !descError &&
    (kind !== "sql" || !sqlError) &&
    (kind !== "items-aggregate" || Object.keys(aggError).length === 0) &&
    // A `kpi` panel with no slug would save as a tile that can only ever
    // render an error, so the save is blocked instead.
    (kind !== "kpi" || kpiSlug.length > 0);

  // One-line "what feeds the chart" hint shown under the Visualization picker.
  const vizHint =
    kind === "items-aggregate"
      ? agg.groupBy
        ? t`One row per "${agg.groupBy}" — bars / donut / table show the breakdown; counter shows only the first.`
        : t`A single value — counter fits best; sparkline / bars need multiple rows.`
      : kind === "sql"
        ? t`Counter takes the first numeric column of row 1; sparkline / bars plot it across all rows; donut / table pair the first two columns.`
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
        setPreviewError(sqlCheck.reason ?? t`Invalid SQL.`);
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
    if (kind === "kpi") {
      if (!kpiSlug) {
        setPreview(null);
        setPreviewError(t`Pick a KPI first.`);
        return;
      }
      setPreviewBusy(true);
      setPreviewError(null);
      try {
        const r = await panelsApi.preview({
          kind: "kpi",
          config: { kpi: kpiSlug, rangeDays: Number(kpiRangeDays) || 30 },
        });
        setPreview({ rows: r.data ?? [], ms: r.ms ?? 0 });
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
        setPreviewError(first ?? t`Invalid aggregate config.`);
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
    setTriedSubmit(true);
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
        config:
          kind === "items-aggregate"
            ? composeAggregateConfig()
            : kind === "kpi"
              ? { kpi: kpiSlug, rangeDays: Number(kpiRangeDays) || 30 }
              : null,
        layout: null,
      };
      if (mode === "create") {
        await panelsApi.create({ ...body, dashboardId: dashboardId ?? null });
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

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="gap-0 p-0 sm:max-w-[720px]">
        <DialogHeader className="border-b border-border px-5 pb-3.5 pr-12 pt-[18px] text-left">
          <DialogTitle className="text-base font-semibold tracking-[-0.01em]">{mode === "create" ? <Trans>New insight panel</Trans> : <Trans>Edit panel</Trans>}</DialogTitle>
          <DialogDescription className="text-[12.5px]">
            {mode === "create"
              ? <Trans>Saved as a row in <span className="font-mono">saved_panels</span>. Collection panels aggregate one collection (count / sum / average …); SQL panels run a read-only SELECT against the workspace database.</Trans>
              : <Trans>Editing <span className="font-mono">{panel?.id}</span>.</Trans>}
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
        <div className="flex flex-col gap-4 px-5 py-[18px]">
          {topError && (
            <div className="flex items-start gap-2 rounded-surface border border-[color-mix(in_oklch,var(--destructive)_35%,var(--border))] bg-[color-mix(in_oklch,var(--destructive)_8%,var(--card))] p-2.5 text-[12.5px] text-destructive">
              <I.AlertTriangle size={13} className="mt-px shrink-0" />
              <span className="flex-1 [word-break:break-word]">{topError}</span>
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground" htmlFor="panel-name">
              <Trans>Name</Trans> <span className="text-destructive">*</span>
            </label>
            <Input
              id="panel-name"
              aria-invalid={!!(nameError && (name || serverErrors.name))}
              autoFocus
              autoComplete="off"
              placeholder={t`Active users (24h)`}
              value={name}
              onChange={(e) => { setName(e.target.value); clearServerError("name"); }}
            />
            {nameError && (name || serverErrors.name) ? (
              <div className="flex items-center gap-1 text-[11.5px] text-destructive"><I.AlertTriangle size={11} />{nameError}</div>
            ) : (
              <span className="text-[11.5px] text-muted-foreground"><Trans>Shown as the panel title on the dashboard.</Trans></span>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground" htmlFor="panel-desc">
              <Trans>Description</Trans> <span className="font-normal text-muted-foreground"><Trans>· optional</Trans></span>
            </label>
            <Input
              id="panel-desc"
              aria-invalid={!!descError}
              autoComplete="off"
              placeholder={t`Distinct users with a session in the last 24h`}
              value={description}
              onChange={(e) => { setDescription(e.target.value); clearServerError("description"); }}
            />
            {descError && <div className="flex items-center gap-1 text-[11.5px] text-destructive"><I.AlertTriangle size={11} />{descError}</div>}
          </div>

          <div className="grid grid-cols-2 gap-3 max-[640px]:grid-cols-1">
            <div className="flex flex-col gap-1.5">
              <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Kind</Trans></label>
              <Select
                value={kind}
                onChange={(v) => { setKind(v as PanelKind); setPreview(null); setPreviewError(null); clearServerError("kind"); }}
                options={[
                  { value: "items-aggregate", label: "collection", hint: t`count / sum / average over a collection — no SQL` },
                  { value: "kpi", label: "kpi", hint: t`show a defined KPI — same number as Ask AI and reports` },
                  { value: "sql", label: "sql", hint: t`read-only SELECT against the workspace database` },
                  { value: "static", label: "static", hint: t`config-only panel rendered from props` },
                ]}
              />
              {serverErrors.kind
                ? <div className="flex items-center gap-1 text-[11.5px] text-destructive"><I.AlertTriangle size={11} />{serverErrors.kind}</div>
                : <span className="text-[11.5px] text-muted-foreground">{kind === "items-aggregate" ? <Trans>Pick a collection and an aggregate below — no query to write.</Trans> : kind === "kpi" ? <Trans>The formula stays in the KPI, so this tile can never disagree with it.</Trans> : kind === "sql" ? <Trans>Write a read-only SELECT below.</Trans> : <Trans>Set the config object via the API once the panel exists.</Trans>}</span>}
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Visualization</Trans></label>
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
                ? <div className="flex items-center gap-1 text-[11.5px] text-destructive"><I.AlertTriangle size={11} />{serverErrors.viz}</div>
                : <span className="text-[11.5px] text-muted-foreground">{vizHint}</span>}
            </div>
          </div>

          {kind === "kpi" && (
            <div className="grid grid-cols-2 gap-3 max-[640px]:grid-cols-1">
              <div className="flex min-w-0 flex-col gap-1.5">
                <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>KPI</Trans></label>
                <Select
                  value={kpiSlug}
                  onChange={(v) => { setKpiSlug(v); setPreview(null); setPreviewError(null); }}
                  options={kpiOptions.map((k) => ({
                    value: k.slug,
                    label: k.name,
                    hint: k.agg === "count" ? `count over ${k.collection}` : `${k.agg}(${k.field ?? "?"}) over ${k.collection}`,
                  }))}
                  placeholder={kpiOptions.length ? t`Pick a KPI` : t`No KPIs defined yet`}
                  disabled={kpiOptions.length === 0}
                  className="w-full min-w-0"
                />
                <span className="text-[11.5px] text-muted-foreground">
                  {kpiOptions.length === 0
                    ? <Trans>Define one on the KPIs page first.</Trans>
                    : <Trans>Editing the KPI updates this tile and every other surface at once.</Trans>}
                </span>
              </div>
              <div className="flex min-w-0 flex-col gap-1.5">
                <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Window</Trans></label>
                <Select
                  value={kpiRangeDays}
                  onChange={(v) => { setKpiRangeDays(v); setPreview(null); setPreviewError(null); }}
                  options={[
                    { value: "1", label: t`Today` },
                    { value: "7", label: t`7 days` },
                    { value: "30", label: t`30 days` },
                    { value: "90", label: t`90 days` },
                  ]}
                  className="w-full min-w-0"
                />
                <span className="text-[11.5px] text-muted-foreground">
                  <Trans>Ignored by a KPI with no date column — it reports a running total.</Trans>
                </span>
              </div>
              <div className="col-span-2 flex justify-end max-[640px]:col-span-1">
                <Button
                  size="sm"
                  variant="outline"
                  icon={I.Play}
                  onClick={runPreview}
                  disabled={previewBusy || !kpiSlug}
                >
                  {previewBusy ? <Trans>Running…</Trans> : <Trans>Run preview</Trans>}
                </Button>
              </div>
              <div className="col-span-2 max-[640px]:col-span-1">
                <PreviewBlock viz={viz} preview={preview} previewError={previewError} />
              </div>
            </div>
          )}

          {kind === "sql" && (
            <>
              <div className="flex flex-col gap-1.5">
                <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground" htmlFor="panel-sql">
                  <Trans>SQL</Trans> <Badge variant="outline" mono>SELECT only</Badge> <span className="text-destructive">*</span>
                  <div className="flex-1" />
                  <Button
                    size="sm"
                    variant="outline"
                    icon={I.Play}
                    onClick={runPreview}
                    disabled={previewBusy || !sqlCheck.ok}
                    className="ml-auto"
                  >
                    {previewBusy ? <Trans>Running…</Trans> : <Trans>Run preview</Trans>}
                  </Button>
                </label>
                <Textarea
                  id="panel-sql"
                  className="font-mono min-h-[140px] whitespace-pre text-xs"
                  aria-invalid={!!sqlError}
                  spellCheck={false}
                  value={sqlText}
                  onChange={(e) => { setSqlText(e.target.value); clearServerError("sql"); setPreviewError(null); }}
                />
                {sqlError ? (
                  <div className="flex items-center gap-1 text-[11.5px] text-destructive"><I.AlertTriangle size={11} />{sqlError}</div>
                ) : (
                  <span className="text-[11.5px] text-muted-foreground">
                    <Trans>The query runs verbatim. The visualization hint above explains how its columns map to the chart.</Trans>
                  </span>
                )}
              </div>

              <PreviewBlock viz={viz} preview={preview} previewError={previewError} />
            </>
          )}

          {kind === "items-aggregate" && (
            <>
              <div className="grid grid-cols-2 gap-3 max-[640px]:grid-cols-1">
                <div className="flex flex-col gap-1.5">
                  <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Collection</Trans> <span className="text-destructive">*</span></label>
                  <Select
                    value={agg.collection}
                    onChange={(v) => setAgg((s) => ({ ...s, collection: v, field: "", groupBy: "" }))}
                    placeholder={collections.length === 0 ? t`No collections` : t`Pick a collection…`}
                    options={collections.map((c) => ({ value: c.slug, label: c.slug, hint: t`${c.fields.length} fields` }))}
                  />
                  {aggError.collection && (triedSubmit || trimmedName.length > 0) && collections.length > 0 && <div className="flex items-center gap-1 text-[11.5px] text-destructive"><I.AlertTriangle size={11} />{aggError.collection}</div>}
                  {collectionsLoaded && collections.length === 0 && (
                    <span className="text-[11.5px] text-muted-foreground"><Trans>No collections in this workspace yet — create one first, or switch <strong>Kind</strong> to <span className="font-mono">sql</span>.</Trans></span>
                  )}
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Aggregate function</Trans></label>
                  <Select
                    value={agg.agg}
                    onChange={(v) => setAgg((s) => ({ ...s, agg: v as ItemsAggFunc, field: v === "count" ? "" : s.field }))}
                    options={[
                      { value: "count", label: "count", hint: t`row count (no field needed)` },
                      { value: "sum", label: "sum", hint: t`numeric column total` },
                      { value: "avg", label: "avg", hint: t`numeric column average` },
                      { value: "min", label: "min", hint: t`numeric column minimum` },
                      { value: "max", label: "max", hint: t`numeric column maximum` },
                    ]}
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 max-[640px]:grid-cols-1">
                <div className="flex flex-col gap-1.5">
                  <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">
                    <Trans>Field</Trans> {agg.agg !== "count" && <span className="text-destructive">*</span>}
                  </label>
                  <Select
                    value={agg.field}
                    onChange={(v) => setAgg((s) => ({ ...s, field: v }))}
                    placeholder={agg.agg === "count" ? t`Not needed for count` : numericFields.length === 0 ? t`No numeric columns` : t`Pick a numeric field…`}
                    disabled={agg.agg === "count" || !agg.collection || numericFields.length === 0}
                    options={numericFields.map((f) => ({ value: f.name, label: f.name, hint: f.type }))}
                  />
                  {aggError.field && <div className="flex items-center gap-1 text-[11.5px] text-destructive"><I.AlertTriangle size={11} />{aggError.field}</div>}
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Group by</Trans> <span className="font-normal text-muted-foreground"><Trans>· optional</Trans></span></label>
                  <Select
                    value={agg.groupBy}
                    onChange={(v) => setAgg((s) => ({ ...s, groupBy: v }))}
                    placeholder={!agg.collection ? t`Pick a collection first` : t`(none)`}
                    disabled={!agg.collection}
                    options={[
                      { value: "", label: t`(none)`, hint: t`single scalar value` },
                      ...allFieldsList.map((n) => ({ value: n, label: n })),
                      ...SYSTEM_GROUP_COLUMNS.map((n) => ({ value: n, label: n, hint: t`system` })),
                    ]}
                  />
                  {aggError.groupBy && <div className="flex items-center gap-1 text-[11.5px] text-destructive"><I.AlertTriangle size={11} />{aggError.groupBy}</div>}
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">
                  <Trans>Filter</Trans> <Badge variant="outline" mono>JSON DSL</Badge> <span className="font-normal text-muted-foreground"><Trans>· optional</Trans></span>
                </label>
                <Textarea
                  className="font-mono min-h-[80px] whitespace-pre text-xs"
                  aria-invalid={!!aggError.filter}
                  spellCheck={false}
                  placeholder={`{ "status": { "_eq": "published" } }`}
                  value={agg.filter}
                  onChange={(e) => setAgg((s) => ({ ...s, filter: e.target.value }))}
                />
                {aggError.filter ? (
                  <div className="flex items-center gap-1 text-[11.5px] text-destructive"><I.AlertTriangle size={11} />{aggError.filter}</div>
                ) : (
                  <span className="text-[11.5px] text-muted-foreground">
                    <Trans>Same DSL as roles &amp; permissions. Operators: <span className="font-mono">_eq</span>, <span className="font-mono">_in</span>, <span className="font-mono">_gte</span>, … Variables: <span className="font-mono">$user.id</span>, <span className="font-mono">$now</span>, …</Trans>
                  </span>
                )}
              </div>

              {agg.groupBy && (
                <div className="flex flex-col gap-1.5">
                  <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Limit</Trans> <span className="font-normal text-muted-foreground"><Trans>· optional</Trans></span></label>
                  <Input
                    className="tabular-nums"
                    aria-invalid={!!aggError.limit}
                    type="number"
                    min={1}
                    max={200}
                    placeholder="50"
                    value={agg.limit}
                    onChange={(e) => setAgg((s) => ({ ...s, limit: e.target.value }))}
                  />
                  {aggError.limit ? (
                    <div className="flex items-center gap-1 text-[11.5px] text-destructive"><I.AlertTriangle size={11} />{aggError.limit}</div>
                  ) : (
                    <span className="text-[11.5px] text-muted-foreground"><Trans>Caps the number of grouped rows returned (default 50, max 200).</Trans></span>
                  )}
                </div>
              )}

              <div className="flex justify-end">
                <Button
                  size="sm"
                  variant="outline"
                  icon={I.Play}
                  onClick={runPreview}
                  disabled={previewBusy || Object.keys(aggError).length > 0 || !agg.collection}
                >
                  {previewBusy ? <Trans>Running…</Trans> : <Trans>Run preview</Trans>}
                </Button>
              </div>

              <PreviewBlock viz={viz} preview={preview} previewError={previewError} />
            </>
          )}

          {kind === "static" && (
            <div className="flex items-start gap-2 rounded-control bg-muted p-3 text-[12.5px] text-muted-foreground">
              <I.AlertTriangle size={12} className="mt-0.5 shrink-0" />
              <Trans>static panels render their config object verbatim — set it from the API once the panel exists.</Trans>
            </div>
          )}
        </div>
        </DialogBody>

        <DialogFooter className="border-t border-border bg-card px-5 py-3">
          <Button variant="ghost" onClick={onClose} disabled={busy}><Trans>Cancel</Trans></Button>
          <Button variant="primary" icon={mode === "create" ? I.Plus : I.Save} onClick={submit} disabled={!valid || busy}>
            {busy ? (mode === "create" ? <Trans>Creating…</Trans> : <Trans>Saving…</Trans>) : mode === "create" ? <Trans>Create panel</Trans> : <Trans>Save changes</Trans>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PreviewTable({ rows }: { rows: Record<string, unknown>[] }) {
  const cols = Object.keys(rows[0] ?? {}).slice(0, 6);
  const max = 5;
  return (
    <ScrollArea className="rounded-control border border-border bg-card">
      <table className="w-full border-collapse text-[11.5px]">
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c} className="border-b border-border px-2 py-1.5 text-left font-mono font-medium text-muted-foreground">{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, max).map((r, i) => (
            <tr key={i}>
              {cols.map((c) => (
                <td key={c} className={`max-w-[220px] truncate px-2 py-1.5 font-mono ${i === 0 ? "" : "border-t border-border"}`}>
                  {r[c] === null || r[c] === undefined ? <span className="text-muted-foreground">∅</span> : typeof r[c] === "object" ? JSON.stringify(r[c]) : String(r[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > max && <div className="border-t border-border px-2 py-1.5 text-[11px] text-muted-foreground"><Trans>… and {rows.length - max} more</Trans></div>}
    </ScrollArea>
  );
}

/**
 * Concrete "this column drives the chart" line, given the rows a preview/run
 * actually returned. Mirrors the auto-detection in RealPanel so the editor and
 * the dashboard agree on what each viz reads.
 */
const VIZ_LABELS: Record<PanelViz, string> = {
  counter: "Counter",
  sparkline: "Sparkline",
  line: "Line",
  area: "Area",
  bars: "Bars",
  "stacked-bars": "Stacked bars",
  donut: "Donut",
  pie: "Pie",
  radar: "Radar",
  radial: "Radial",
  table: "Table",
};

function describeVizMapping(viz: PanelViz, rows: Record<string, unknown>[]): string {
  const first = rows[0] ?? {};
  const { cols, numericCols } = detectSeries(rows);
  const numericCol = numericCols[0];
  const labelCol = cols.find((c) => !numericCols.includes(c));
  const label = VIZ_LABELS[viz];
  if (viz === "counter") {
    return numericCol
      ? `Counter → "${numericCol}" from the first row (${Number(first[numericCol]).toLocaleString()}).`
      : `Counter → no numeric column, so it shows the row count (${rows.length}).`;
  }
  if (viz === "sparkline" || viz === "line" || viz === "area" || viz === "bars" || viz === "stacked-bars" || viz === "radar") {
    const used = (numericCols.length > 0 ? numericCols : cols.slice(0, 1)).slice(0, MAX_SERIES);
    return used.length > 0
      ? `${label} → ${used.map((c) => `"${c}"`).join(", ")} across all ${rows.length} row${rows.length === 1 ? "" : "s"}.`
      : `${label} → the first numeric column across all rows.`;
  }
  // donut | pie | radial | table
  const lc = labelCol ?? cols[0];
  const vc = numericCol ?? cols[1];
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
    <div className="flex flex-col gap-1.5 rounded-control bg-muted p-2.5">
      <div className="mb-1.5 flex items-center gap-2 text-[12.5px] font-medium text-foreground">
        {previewError
          ? <><I.AlertTriangle size={12} className="text-destructive" /> <Trans>Preview error</Trans></>
          : <><I.Activity size={12} /> <Trans>Preview · {preview?.rows.length ?? 0} rows · {preview?.ms ?? 0}ms</Trans></>}
      </div>
      {previewError ? (
        <div className="whitespace-pre-wrap font-mono text-[11.5px] text-destructive">{previewError}</div>
      ) : preview && preview.rows.length > 0 ? (
        <>
          <PreviewTable rows={preview.rows} />
          <div className="mt-1.5 flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
            <I.BarChart size={11} className="shrink-0" />
            <span>{describeVizMapping(viz, preview.rows)}</span>
          </div>
        </>
      ) : (
        <div className="text-xs text-muted-foreground"><Trans>No rows returned.</Trans></div>
      )}
    </div>
  );
}

/**
 * Renders a saved panel card — the chart body comes from the shared
 * `PanelBody` (also used by the public embed page) so both surfaces agree on
 * how each viz maps its rows.
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
  return (
    <Panel title={panel.name} sub={sub} onEdit={onEdit} onDelete={onDelete}>
      <PanelBody
        viz={panel.viz}
        rows={rows}
        error={error}
        emptyLabel={<Trans>No data yet — run the panel.</Trans>}
      />
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
  const { t } = useLingui();
  return (
    // h-full: inside the dashboard grid the card must fill its (row-span)
    // cell — a natural-height card leaves the rest of the tile as a dead
    // transparent band, which reads as random gaps between panels.
    <Card className="h-full min-h-0 gap-2 p-4">
      <div className="flex items-baseline gap-2">
        <span className="text-[13px] font-medium">{title}</span>
        <span className="flex-1 text-[11.5px] text-muted-foreground">{sub}</span>
        {onEdit && <IconButton icon={I.Pencil} onClick={onEdit} title={t`Edit panel`} />}
        {onDelete && <IconButton icon={I.Trash} onClick={onDelete} title={t`Delete panel`} />}
      </div>
      {children}
    </Card>
  );
}

/** Minimal create-dashboard dialog — just a name. */
function NewDashboardDialog({
  existing,
  onClose,
  onCreated,
}: {
  existing: string[];
  onClose: () => void;
  onCreated: (id: string, name: string) => void;
}) {
  const { t } = useLingui();
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = name.trim();
  const nameError =
    trimmed.length === 0
      ? null
      : trimmed.length > 120
        ? t`Max 120 characters.`
        : existing.includes(trimmed)
          ? t`A dashboard with that name already exists.`
          : null;
  const valid = trimmed.length > 0 && !nameError;

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await dashboardsApi.create({ name: trimmed, description: desc.trim() || null });
      onCreated(res.data.id, res.data.name);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="overflow-hidden sm:max-w-[440px] [&>*]:min-w-0">
        <DialogHeader>
          <DialogTitle><Trans>New dashboard</Trans></DialogTitle>
          <DialogDescription><Trans>Group panels under a named dashboard you can publish to a public embed URL.</Trans></DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3 py-1">
          {error && (
            <div className="flex items-start gap-2 rounded-surface border border-[color-mix(in_oklch,var(--destructive)_35%,var(--border))] bg-[color-mix(in_oklch,var(--destructive)_8%,var(--card))] p-2.5 text-[12.5px] text-destructive">
              <I.AlertTriangle size={13} className="mt-px shrink-0" /><span className="flex-1">{error}</span>
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            <label className="text-[12.5px] font-medium" htmlFor="dash-name"><Trans>Name</Trans> <span className="text-destructive">*</span></label>
            <Input id="dash-name" autoFocus autoComplete="off" placeholder={t`Revenue overview`} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void submit(); }} />
            {nameError && <div className="flex items-center gap-1 text-[11.5px] text-destructive"><I.AlertTriangle size={11} />{nameError}</div>}
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-[12.5px] font-medium" htmlFor="dash-desc"><Trans>Description</Trans> <span className="font-normal text-muted-foreground"><Trans>· optional</Trans></span></label>
            <Input id="dash-desc" autoComplete="off" value={desc} onChange={(e) => setDesc(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}><Trans>Cancel</Trans></Button>
          <Button variant="primary" icon={I.Plus} onClick={submit} disabled={!valid || busy}>
            {busy ? <Trans>Creating…</Trans> : <Trans>Create dashboard</Trans>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Report dialog — print this dashboard, or mail it.
 *
 * Two buttons rather than a mode toggle: downloading and mailing are different
 * intents, and the server refuses a request that asks for both. Recipients are
 * only required by the second, so the field does not gate the first.
 *
 * There is no optimistic path here on purpose. Nothing in the page's state
 * changes — the work IS the round trip, and a PDF that appeared instantly and
 * then failed to render would be a lie. The buttons carry busy labels instead.
 */
function ReportDashboardDialog({
  dashboard,
  onClose,
  pushToast,
}: {
  dashboard: ApiDashboard;
  onClose: () => void;
  pushToast?: PushToast;
}) {
  const { t } = useLingui();
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [format, setFormat] = useState("");
  const [landscape, setLandscape] = useState(false);
  const [busy, setBusy] = useState<"download" | "email" | null>(null);

  const pageOptions =
    format || landscape
      ? { ...(format ? { format } : {}), ...(landscape ? { landscape: true } : {}) }
      : undefined;

  const download = async () => {
    setBusy("download");
    try {
      const blob = await dashboardsApi.reportPdf(dashboard.id, {
        ...(pageOptions ? { pageOptions } : {}),
      });
      // Straight to the browser's own download path — the bytes never round
      // trip through storage a second time.
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${dashboard.name}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
      onClose();
    } catch (e) {
      pushToast?.((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const send = async () => {
    setBusy("email");
    try {
      const res = await dashboardsApi.report(dashboard.id, {
        ...(pageOptions ? { pageOptions } : {}),
        email: { to, ...(subject.trim() ? { subject: subject.trim() } : {}) },
      });
      onClose();
      if (res.attachmentsDropped) {
        // Said plainly rather than reported as a success: the recipient got a
        // mail with nothing attached, which looks like a bug from their end.
        pushToast?.(t`Mail sent, but this deployment's email transport cannot carry attachments — the report was not included.`);
      } else {
        pushToast?.(t`Report sent to ${res.sentTo.length} recipient(s).`);
      }
    } catch (e) {
      pushToast?.((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <DialogContent className="flex max-h-[86vh] flex-col overflow-hidden sm:max-w-[520px] [&>*]:min-w-0">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <I.Download size={15} className="text-muted-foreground" />
            <Trans>Report "{dashboard.name}"</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>Runs every panel and prints the dashboard to a PDF. To send it on a schedule instead, add a "Deliver report" step to a cron flow.</Trans>
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          <div className="flex flex-col gap-3.5 py-1">
            <div className="flex flex-col gap-1.5">
              <label className="text-[12.5px] font-medium"><Trans>Email to</Trans></label>
              <Input
                value={to}
                onChange={(e) => setTo(e.target.value)}
                placeholder="ops@example.com, finance@example.com"
                className="min-w-0"
              />
              <span className="text-[11.5px] text-muted-foreground">
                <Trans>Comma-separated. Only needed to send it — downloading works without one.</Trans>
              </span>
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-[12.5px] font-medium"><Trans>Subject</Trans></label>
              <Input
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder={dashboard.name}
                className="min-w-0"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-[12.5px] font-medium"><Trans>Page</Trans></label>
              <Select
                value={format}
                onChange={(v) => setFormat(v)}
                className="min-w-0"
                options={[
                  { value: "", label: t`A4`, hint: t`the default` },
                  { value: "Letter", label: "Letter" },
                  { value: "Legal", label: "Legal" },
                  { value: "A3", label: "A3" },
                  { value: "A5", label: "A5" },
                ]}
              />
            </div>
            <label className="flex items-center gap-2 text-[12.5px] font-medium">
              <Switch checked={landscape} onChange={setLandscape} />
              <Trans>Landscape</Trans>
            </label>
          </div>
        </DialogBody>

        <DialogFooter className="shrink-0">
          <Button variant="ghost" onClick={onClose} disabled={Boolean(busy)}><Trans>Close</Trans></Button>
          <Button variant="outline" icon={I.Download} onClick={download} disabled={Boolean(busy)}>
            {busy === "download" ? <Trans>Rendering…</Trans> : <Trans>Download PDF</Trans>}
          </Button>
          <Button variant="primary" icon={I.Mail} onClick={send} disabled={Boolean(busy) || !to.trim()}>
            {busy === "email" ? <Trans>Sending…</Trans> : <Trans>Email report</Trans>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Share dialog — enable/disable the public embed and reveal the one-time link.
 * The plaintext token is only returned by `share`, so we show the full URL
 * right after minting; on reopen we show the live/off state + rotate/disable.
 */
function ShareDashboardDialog({
  dashboard,
  onClose,
  onChanged,
  pushToast,
}: {
  dashboard: ApiDashboard;
  onClose: () => void;
  onChanged: () => void | Promise<void>;
  pushToast?: PushToast;
}) {
  const { t } = useLingui();
  const [roles, setRoles] = useState<ApiRole[]>([]);
  const [roleId, setRoleId] = useState<string>(dashboard.embedRoleId ?? "");
  const [token, setToken] = useState<string | null>(null);
  const [enabled, setEnabled] = useState<boolean>(dashboard.embedEnabled);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await rolesApi.list();
        if (!cancelled) setRoles(r.data ?? []);
      } catch { /* leave empty */ }
    })();
    return () => { cancelled = true; };
  }, []);

  const url = token ? `${window.location.origin}/embed/d/${token}` : null;

  const enable = async () => {
    setBusy(true);
    try {
      const res = await dashboardsApi.share(dashboard.id, { roleId: roleId || null });
      setToken(res.token);
      setEnabled(true);
      await onChanged();
      pushToast?.(t`Public embed enabled.`);
    } catch (e) {
      pushToast?.((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    try {
      await dashboardsApi.revoke(dashboard.id);
      setToken(null);
      setEnabled(false);
      await onChanged();
      pushToast?.(t`Public embed disabled.`);
    } catch (e) {
      pushToast?.((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      pushToast?.(t`Link copied.`);
    } catch { /* clipboard may be blocked */ }
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="overflow-hidden sm:max-w-[520px] [&>*]:min-w-0">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <I.Globe size={15} className="text-muted-foreground" />
            <Trans>Share "{dashboard.name}"</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>Publish this dashboard to a public, unauthenticated embed URL. Anyone with the link can view it — embed it in an iframe on your own site.</Trans>
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3.5 py-1">
          <div className="flex flex-col gap-1.5">
            <label className="text-[12.5px] font-medium"><Trans>Data scope</Trans></label>
            <Select
              value={roleId}
              onChange={(v) => setRoleId(v)}
              disabled={enabled}
              options={[
                { value: "", label: t`Public (unscoped)`, hint: t`panels run with full read access — for fully public stats` },
                ...roles.map((r) => ({ value: r.id, label: r.name, hint: t`panel data limited to this role's read permission` })),
              ]}
            />
            <span className="text-[11.5px] text-muted-foreground">
              {enabled
                ? <Trans>Disable the embed to change the scope.</Trans>
                : <Trans>Scope the embed to a role so it only exposes what that role can read.</Trans>}
            </span>
          </div>

          {url && (
            <div className="flex flex-col gap-1.5 rounded-control border border-[color-mix(in_oklch,var(--primary)_30%,var(--border))] bg-[color-mix(in_oklch,var(--primary)_6%,var(--card))] p-2.5">
              <div className="flex items-center gap-1.5 text-[12px] font-medium text-foreground"><I.Link size={12} /><Trans>Embed URL — copy it now</Trans></div>
              <div className="flex items-center gap-1.5">
                <Input readOnly value={url} className="min-w-0 flex-1 font-mono text-[11.5px]" onFocus={(e) => e.currentTarget.select()} />
                <IconButton icon={I.Copy} title={t`Copy`} onClick={copy} />
                <IconButton icon={I.ExternalLink} title={t`Open`} onClick={() => window.open(url, "_blank")} />
              </div>
              <span className="text-[11px] text-muted-foreground"><Trans>This link is shown once. Rotate it to invalidate the old one.</Trans></span>
            </div>
          )}

          {enabled && !url && (
            <div className="flex items-start gap-2 rounded-control bg-muted p-2.5 text-[12.5px] text-muted-foreground">
              <I.Check size={13} className="mt-px shrink-0 text-primary" />
              <Trans>The public embed is live. The link was shown once when it was created — rotate it below if you need the URL again.</Trans>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}><Trans>Close</Trans></Button>
          {enabled ? (
            <>
              <Button variant="outline" icon={I.Link} onClick={enable} disabled={busy}><Trans>Rotate link</Trans></Button>
              <Button variant="destructive" icon={I.X} onClick={disable} disabled={busy}><Trans>Disable embed</Trans></Button>
            </>
          ) : (
            <Button variant="primary" icon={I.Globe} onClick={enable} disabled={busy}>
              {busy ? <Trans>Enabling…</Trans> : <Trans>Enable public embed</Trans>}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

