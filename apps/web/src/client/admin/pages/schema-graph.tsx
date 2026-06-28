// Schema graph (ERD) editor — live, interactive view of dynamic collections
// and their relations, built on @xyflow/react.
//
// Nodes come from /api/collections (collectionsApi.list). Each node is a
// table card listing its user-defined fields; relation / relation_many fields
// derive edges to their target collection (the field's `to` slug). Node
// positions are draggable and persisted per-workspace in the `erdLayout`
// setting. Inline schema editing — add / edit / drop a field, and draw a new
// relation by dragging between two nodes — round-trips through the same
// collection endpoints the Schema tab uses.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { useNavigate } from "react-router";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Handle,
  Position,
  MarkerType,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type Connection,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { I } from "../icons";
import { Badge, Button, PageHeader } from "../ui";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@backlex/ui/components/table";
import { Card } from "@backlex/ui/components/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@backlex/ui/components/dialog";
import { Input } from "@backlex/ui/components/input";
import { collectionsApi, settingsApi, type ApiCollection } from "../api";
import { AddFieldDialog } from "../add-field";
import { EditFieldDialog } from "../edit-field";
import { Select } from "../select";
import { SchemaGraphSkeleton } from "../page-skeletons";

const ADMIN_TABLE_CLS =
  "[&_td]:px-3.5 [&_td]:text-[13px] [&_th]:h-9 [&_th]:px-3.5 [&_th]:text-[11px] [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-[0.06em] [&_th]:text-muted-foreground";

// Same OKLCH palette the design uses, cycled by index.
const NODE_PALETTE = [
  "oklch(0.78 0.16 130)",
  "oklch(0.72 0.16 240)",
  "oklch(0.72 0.18 95)",
  "oklch(0.7 0.16 28)",
  "oklch(0.68 0.06 285)",
  "oklch(0.74 0.16 200)",
  "oklch(0.7 0.18 320)",
  "oklch(0.76 0.14 160)",
];

const NODE_W = 248;
const GRID_COLS = 3;
const GRID_COL_GAP = 130;
const GRID_ROW_GAP = 280;
const GRID_ORIGIN = 40;

type Pos = { x: number; y: number };
type ErdLayout = Record<string, Pos>;

interface FieldRow {
  name: string;
  type: string;
  required?: boolean;
  unique?: boolean;
  to?: string;
  isRelation: boolean;
  many: boolean;
}

interface CollectionNodeData {
  slug: string;
  color: string;
  fields: FieldRow[];
  adopted: boolean;
  validTargets: Set<string>;
  onOpen: (slug: string) => void;
  onAddField: (slug: string) => void;
  onEditField: (slug: string, name: string) => void;
  onDropField: (slug: string, name: string) => void;
  [key: string]: unknown;
}

type CollectionNode = Node<CollectionNodeData, "collection">;

const TYPE_ABBR: Record<string, string> = {
  text: "text",
  longtext: "text",
  integer: "int",
  number: "num",
  boolean: "bool",
  json: "json",
  timestamp: "time",
  uuid: "uuid",
  relation: "rel",
  relation_many: "rel[]",
  i18n_text: "i18n",
};

function gridPos(index: number): Pos {
  const col = index % GRID_COLS;
  const row = Math.floor(index / GRID_COLS);
  return {
    x: GRID_ORIGIN + col * (NODE_W + GRID_COL_GAP),
    y: GRID_ORIGIN + row * GRID_ROW_GAP,
  };
}

function toFieldRows(c: ApiCollection): FieldRow[] {
  return (c.fields ?? []).map((f) => {
    const many = f.type === "relation_many";
    return {
      name: f.name,
      type: f.type,
      required: f.required,
      unique: f.unique,
      to: (f as { to?: string }).to,
      isRelation: f.type === "relation" || many,
      many,
    };
  });
}

// ---------------------------------------------------------------------------
// Custom node — a table card with one row per user field + relation handles.
// ---------------------------------------------------------------------------
function CollectionNodeView({ data, selected }: NodeProps<CollectionNode>) {
  const { t } = useLingui();
  const d = data;
  return (
    <div
      className={`w-[248px] overflow-hidden rounded-xl border bg-card shadow-sm transition-colors ${selected ? "border-primary ring-1 ring-primary" : "border-border"}`}
    >
      {/* Target handle — incoming relations anchor on the node's left edge. */}
      <Handle
        type="target"
        id="t"
        position={Position.Left}
        className="!h-2.5 !w-2.5 !border-2 !border-background !bg-muted-foreground"
        style={{ top: 22 }}
      />
      <div className="flex items-center gap-2 border-b border-border px-3 py-2" style={{ background: "color-mix(in oklch, var(--muted) 35%, var(--card))" }}>
        <span className="h-3.5 w-1 shrink-0 rounded-full" style={{ background: d.color }} />
        <span className="truncate font-mono text-[12.5px] font-medium">c_{d.slug}</span>
        <span
          className="ml-auto shrink-0 text-[10.5px] text-muted-foreground"
          title={t`${d.fields.length} fields`}
        >
          {d.fields.length} <Trans>fields</Trans>
        </span>
        <button
          type="button"
          className="nodrag grid size-5 shrink-0 place-items-center rounded-[5px] text-muted-foreground hover:bg-accent hover:text-foreground"
          title={t`Add field`}
          onClick={(e) => { e.stopPropagation(); d.onAddField(d.slug); }}
        >
          <I.Plus size={13} />
        </button>
        <button
          type="button"
          className="nodrag grid size-5 shrink-0 place-items-center rounded-[5px] text-muted-foreground hover:bg-accent hover:text-foreground"
          title={t`Open collection`}
          onClick={(e) => { e.stopPropagation(); d.onOpen(d.slug); }}
        >
          <I.ExternalLink size={12} />
        </button>
      </div>
      {/* New-relation source handle — drag from here onto another node. */}
      <Handle
        type="source"
        id="new"
        position={Position.Right}
        isConnectableStart
        className="!h-3 !w-3 !border-2 !border-background !bg-primary"
        style={{ top: 22 }}
        title={t`Drag to another collection to create a relation`}
      />
      <div className="flex flex-col">
        {d.fields.length === 0 && (
          <div className="px-3 py-2 text-[11.5px] text-muted-foreground"><Trans>No user fields yet.</Trans></div>
        )}
        {d.fields.map((f) => (
          <div
            key={f.name}
            className="group relative flex items-center gap-2 border-b border-border/60 px-3 py-1.5 last:border-b-0 hover:bg-accent/50"
          >
            {f.isRelation && <I.Link size={11} className="shrink-0 text-primary" />}
            <span className="truncate font-mono text-[11.5px]">{f.name}</span>
            {f.required && <span className="text-[11px] text-destructive" title={t`required`}>*</span>}
            {f.unique && <span className="text-[10px] uppercase text-muted-foreground" title={t`unique`}>u</span>}
            <span className="ml-auto shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[9.5px] text-muted-foreground">
              {TYPE_ABBR[f.type] ?? f.type}
            </span>
            <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
              <button
                type="button"
                className="nodrag grid size-5 place-items-center rounded-[5px] text-muted-foreground hover:bg-accent hover:text-foreground"
                title={t`Edit field`}
                onClick={(e) => { e.stopPropagation(); d.onEditField(d.slug, f.name); }}
              >
                <I.Pencil size={11} />
              </button>
              {!d.adopted && (
                <button
                  type="button"
                  className="nodrag grid size-5 place-items-center rounded-[5px] text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  title={t`Drop field`}
                  onClick={(e) => { e.stopPropagation(); d.onDropField(d.slug, f.name); }}
                >
                  <I.Trash size={11} />
                </button>
              )}
            </span>
            {/* Source handle on relation rows — the edge's tail anchors here. */}
            {f.isRelation && f.to && d.validTargets.has(f.to) && (
              <Handle
                type="source"
                id={`f:${f.name}`}
                position={Position.Right}
                isConnectable={false}
                className="!h-2 !w-2 !border-0 !bg-primary"
                style={{ right: -1 }}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

const nodeTypes = { collection: CollectionNodeView };

// ---------------------------------------------------------------------------
// Create-relation dialog — shown after dragging from one node onto another.
// ---------------------------------------------------------------------------
function CreateRelationDialog({
  open,
  from,
  to,
  existingNames,
  onClose,
  onCreate,
}: {
  open: boolean;
  from: string;
  to: string;
  existingNames: Set<string>;
  onClose: () => void;
  onCreate: (name: string, kind: "relation" | "relation_many") => void;
}) {
  const { t } = useLingui();
  const [kind, setKind] = useState<"relation" | "relation_many">("relation");
  const [name, setName] = useState("");

  useEffect(() => {
    if (open) {
      setKind("relation");
      const singular = to.replace(/s$/, "");
      setName(`${singular}_id`.replace(/[^a-z0-9_]+/gi, "_").toLowerCase());
    }
  }, [open, to]);

  const safeName = name.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  const taken = existingNames.has(safeName);
  const valid = safeName.length >= 2 && !taken;

  if (!open) return null;
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle><Trans>New relation</Trans></DialogTitle>
          <DialogDescription>
            <Trans>Add a relation field on <span className="font-mono">c_{from}</span> pointing to <span className="font-mono">c_{to}</span>.</Trans>
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3 py-1">
          <div className="flex flex-col gap-1.5">
            <label className="text-[12.5px] font-medium"><Trans>Field name</Trans></label>
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="author_id" />
            <span className="font-mono text-[11px] text-muted-foreground">
              <Trans>column: <span className={taken ? "text-destructive" : "text-foreground"}>{safeName || "—"}</span></Trans>
              {taken && <span className="text-destructive"><Trans> · already exists</Trans></span>}
            </span>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-[12.5px] font-medium"><Trans>Cardinality</Trans></label>
            <Select
              value={kind}
              onChange={(v) => setKind(v as "relation" | "relation_many")}
              options={[
                { value: "relation", label: t`Single (relation)`, hint: t`stores one target id` },
                { value: "relation_many", label: t`Many (relation_many)`, hint: t`stores an array of ids` },
              ]}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}><Trans>Cancel</Trans></Button>
          <Button variant="primary" size="sm" icon={I.Check} disabled={!valid} onClick={() => onCreate(safeName, kind)}>
            <Trans>Create relation</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Drop-field confirm dialog.
// ---------------------------------------------------------------------------
function DropFieldDialog({
  target,
  onClose,
  onConfirm,
}: {
  target: { slug: string; name: string } | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  if (!target) return null;
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle><Trans>Drop field</Trans></DialogTitle>
          <DialogDescription>
            <Trans>This runs <span className="font-mono">ALTER TABLE … DROP COLUMN {target.name}</span> on <span className="font-mono">c_{target.slug}</span>. The column and all its data are removed. This cannot be undone.</Trans>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}><Trans>Cancel</Trans></Button>
          <Button variant="destructive" size="sm" icon={I.Trash} onClick={onConfirm}><Trans>Drop column</Trans></Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Inner canvas (needs ReactFlowProvider context for fitView etc.).
// ---------------------------------------------------------------------------
function ErdCanvas({
  collections,
  layout,
  pushToast,
  onMutated,
}: {
  collections: ApiCollection[];
  layout: ErdLayout;
  pushToast: (m: string, type?: "success" | "error") => void;
  onMutated: (next: ApiCollection[]) => void;
}) {
  const { t } = useLingui();
  const navigate = useNavigate();
  const bySlug = useMemo(() => new Map(collections.map((c) => [c.slug, c])), [collections]);
  const validSlugs = useMemo(() => new Set(collections.map((c) => c.slug)), [collections]);

  // Source of truth for positions — seeded from the saved layout, filled in
  // with the deterministic grid for any collection without a saved spot.
  const positionsRef = useRef<ErdLayout>({});
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Inline-edit dialog state.
  const [addFieldSlug, setAddFieldSlug] = useState<string | null>(null);
  const [editField, setEditField] = useState<{ slug: string; name: string } | null>(null);
  const [dropTarget, setDropTarget] = useState<{ slug: string; name: string } | null>(null);
  const [pendingRel, setPendingRel] = useState<{ from: string; to: string } | null>(null);

  const persistLayout = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void settingsApi.patch({ erdLayout: positionsRef.current }).catch(() => {
        pushToast(t`Couldn't save layout.`, "error");
      });
    }, 600);
  }, [pushToast, t]);

  // PATCH a collection's full field set, then re-fetch and bubble up.
  const patchFields = useCallback(
    async (slug: string, fields: ApiCollection["fields"], note: string) => {
      try {
        await collectionsApi.patch(slug, { fields });
        const res = await collectionsApi.list();
        if (Array.isArray(res.data)) onMutated(res.data);
        pushToast(note);
      } catch (e) {
        pushToast((e as Error).message, "error");
      }
    },
    [onMutated, pushToast],
  );

  const handleOpen = useCallback((slug: string) => navigate(`/collections/${slug}`), [navigate]);
  const handleAddField = useCallback((slug: string) => setAddFieldSlug(slug), []);
  const handleEditField = useCallback((slug: string, name: string) => setEditField({ slug, name }), []);
  const handleDropField = useCallback((slug: string, name: string) => setDropTarget({ slug, name }), []);

  const buildNodes = useCallback((): CollectionNode[] => {
    return collections.map((c, i) => {
      const saved = positionsRef.current[c.slug] ?? layout[c.slug] ?? gridPos(i);
      positionsRef.current[c.slug] = saved;
      return {
        id: c.slug,
        type: "collection",
        position: saved,
        data: {
          slug: c.slug,
          color: NODE_PALETTE[i % NODE_PALETTE.length] ?? NODE_PALETTE[0]!,
          fields: toFieldRows(c),
          adopted: Boolean(c.adopted),
          validTargets: validSlugs,
          onOpen: handleOpen,
          onAddField: handleAddField,
          onEditField: handleEditField,
          onDropField: handleDropField,
        },
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collections, layout, validSlugs, handleOpen, handleAddField, handleEditField, handleDropField]);

  const buildEdges = useCallback((): Edge[] => {
    const edges: Edge[] = [];
    for (const c of collections) {
      for (const f of c.fields ?? []) {
        const many = f.type === "relation_many";
        if (f.type !== "relation" && !many) continue;
        const target = (f as { to?: string }).to;
        if (!target || !validSlugs.has(target)) continue;
        edges.push({
          id: `${c.slug}.${f.name}->${target}`,
          source: c.slug,
          sourceHandle: `f:${f.name}`,
          target,
          targetHandle: "t",
          label: f.name,
          animated: many,
          markerEnd: { type: MarkerType.ArrowClosed },
          style: { stroke: "var(--foreground)", strokeWidth: 1.5, strokeDasharray: many ? "5 4" : undefined },
          labelStyle: { fontFamily: "Geist Mono, monospace", fontSize: 10, fill: "var(--muted-foreground)" },
          labelBgStyle: { fill: "var(--card)" },
        });
      }
    }
    return edges;
  }, [collections, validSlugs]);

  const [nodes, setNodes, onNodesChange] = useNodesState<CollectionNode>(buildNodes());
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(buildEdges());

  // Rebuild whenever the collection set changes (add/edit/drop field, refresh).
  // Positions survive via positionsRef, so dragging is preserved across edits.
  useEffect(() => {
    setNodes(buildNodes());
    setEdges(buildEdges());
  }, [buildNodes, buildEdges, setNodes, setEdges]);

  const handleNodesChange = useCallback(
    (changes: Parameters<typeof onNodesChange>[0]) => {
      for (const ch of changes) {
        if (ch.type === "position" && ch.position) positionsRef.current[ch.id] = ch.position;
      }
      onNodesChange(changes);
    },
    [onNodesChange],
  );

  const onConnect = useCallback(
    (conn: Connection) => {
      // Only the header "new" handle initiates relation creation; ignore drags
      // that land back on the same node.
      if (conn.sourceHandle !== "new" || !conn.source || !conn.target || conn.source === conn.target) return;
      setPendingRel({ from: conn.source, to: conn.target });
    },
    [],
  );

  const addSchema = addFieldSlug ? bySlug.get(addFieldSlug) : null;
  const editSrc = editField ? bySlug.get(editField.slug) : null;
  const editFieldDef = editSrc?.fields.find((f) => f.name === editField?.name) ?? null;

  return (
    <>
      <div className="h-[min(70vh,640px)] w-full">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={handleNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeDragStop={persistLayout}
          onConnect={onConnect}
          fitView
          fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
          minZoom={0.25}
          maxZoom={2}
          proOptions={{ hideAttribution: true }}
          className="!bg-[color-mix(in_oklch,var(--muted)_30%,var(--card))]"
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="var(--border)" />
          {/* React Flow ships a light-theme stylesheet; override the controls +
              minimap to match the dark admin so the buttons aren't white blocks
              and the minimap isn't an oversized grey panel. */}
          <Controls
            showInteractive={false}
            className="!shadow-md !overflow-hidden !rounded-lg !border !border-border [&_button]:!border-b [&_button]:!border-border [&_button]:!bg-card [&_button:hover]:!bg-muted [&_button:last-child]:!border-b-0 [&_button_svg]:!fill-foreground"
          />
          <MiniMap
            pannable
            zoomable
            nodeColor={(n) => (n.data as CollectionNodeData)?.color ?? "var(--muted-foreground)"}
            nodeStrokeColor="var(--border)"
            nodeBorderRadius={4}
            bgColor="var(--card)"
            maskColor="color-mix(in oklch, var(--background) 55%, transparent)"
            style={{ width: 168, height: 112 }}
            className="!bottom-3 !right-3 !m-0 overflow-hidden rounded-lg border border-border shadow-md"
          />
        </ReactFlow>
      </div>

      <AddFieldDialog
        open={addFieldSlug !== null}
        schema={(addSchema ? { slug: addSchema.slug, ownerScoped: false, fields: addSchema.fields } : { slug: "", ownerScoped: false, fields: [] }) as never}
        collections={collections.map((c) => ({ slug: c.slug }))}
        onClose={() => setAddFieldSlug(null)}
        onCreate={async (field) => {
          if (!addSchema) return;
          await patchFields(
            addSchema.slug,
            [...addSchema.fields, field as never],
            t`Column "${(field as { name?: string }).name}" added to c_${addSchema.slug}.`,
          );
          setAddFieldSlug(null);
        }}
      />

      <EditFieldDialog
        open={editField !== null}
        field={(editFieldDef ?? null) as never}
        onClose={() => setEditField(null)}
        onSave={async (next) => {
          if (!editSrc || !editField) return;
          const merged = editSrc.fields.map((f) => (f.name === editField.name ? (next as never) : f));
          await patchFields(editSrc.slug, merged, t`Field "${(next as { name?: string }).name}" updated.`);
          setEditField(null);
        }}
      />

      <DropFieldDialog
        target={dropTarget}
        onClose={() => setDropTarget(null)}
        onConfirm={async () => {
          if (!dropTarget) return;
          try {
            await collectionsApi.dropField(dropTarget.slug, dropTarget.name);
            const res = await collectionsApi.list();
            if (Array.isArray(res.data)) onMutated(res.data);
            pushToast(t`Column "${dropTarget.name}" dropped from c_${dropTarget.slug}.`);
          } catch (e) {
            pushToast((e as Error).message, "error");
          }
          setDropTarget(null);
        }}
      />

      <CreateRelationDialog
        open={pendingRel !== null}
        from={pendingRel?.from ?? ""}
        to={pendingRel?.to ?? ""}
        existingNames={new Set((pendingRel ? bySlug.get(pendingRel.from)?.fields : [])?.map((f) => f.name) ?? [])}
        onClose={() => setPendingRel(null)}
        onCreate={async (name, kind) => {
          if (!pendingRel) return;
          const src = bySlug.get(pendingRel.from);
          if (!src) return;
          await patchFields(
            pendingRel.from,
            [...src.fields, { name, type: kind, to: pendingRel.to, required: false } as never],
            t`Relation "${name}" added · c_${pendingRel.from} → c_${pendingRel.to}.`,
          );
          setPendingRel(null);
        }}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Page shell — load + relations summary table + canvas.
// ---------------------------------------------------------------------------
export function SchemaGraphPage({ pushToast }: { pushToast: (m: string, type?: "success" | "error") => void }) {
  const { t } = useLingui();
  const [collections, setCollections] = useState<ApiCollection[]>([]);
  const [layout, setLayout] = useState<ErdLayout>({});
  const [loaded, setLoaded] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [cols, settings] = await Promise.all([
          collectionsApi.list(),
          settingsApi.load().catch(() => null),
        ]);
        if (cancelled) return;
        if (Array.isArray(cols.data)) setCollections(cols.data);
        const erd = (settings?.data as { erdLayout?: ErdLayout } | undefined)?.erdLayout;
        if (erd && typeof erd === "object") setLayout(erd);
      } catch {
        // Auth/network failure — leave empty; the page renders the empty state.
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, [reloadKey]);

  const edgeRows = useMemo(() => {
    const slugs = new Set(collections.map((c) => c.slug));
    const out: { from: string; to: string; field: string; many: boolean }[] = [];
    for (const c of collections) {
      for (const f of c.fields ?? []) {
        const many = f.type === "relation_many";
        if (f.type !== "relation" && !many) continue;
        const to = (f as { to?: string }).to;
        if (!to || !slugs.has(to)) continue;
        out.push({ from: c.slug, to, field: f.name, many });
      }
    }
    return out;
  }, [collections]);

  const onExport = () => {
    try {
      const payload = JSON.stringify(
        {
          collections: collections.map((c) => ({ slug: c.slug, fields: c.fields })),
          relations: edgeRows,
        },
        null,
        2,
      );
      const blob = new Blob([payload], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "schema.json";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      pushToast(t`Schema exported · schema.json`);
    } catch {
      pushToast(t`Export failed.`, "error");
    }
  };

  const onResetLayout = () => {
    void settingsApi.patch({ erdLayout: {} }).then(() => {
      setLayout({});
      setReloadKey((k) => k + 1);
      pushToast(t`Layout reset to auto-arrange.`);
    }).catch(() => pushToast(t`Couldn't reset layout.`, "error"));
  };

  if (!loaded) return <SchemaGraphSkeleton />;

  return (
    <div className="flex flex-col gap-4.5">
      <PageHeader
        title={t`Schema graph`}
        description={t`Interactive ERD of dynamic collections. Drag nodes to arrange · drag from a node's right handle onto another to draw a relation · add, edit, or drop fields inline.`}
        actions={
          <>
            <Button variant="outline" icon={I.Refresh} onClick={onResetLayout}>
              <Trans>Reset layout</Trans>
            </Button>
            <Button variant="outline" icon={I.Download} onClick={onExport}>
              <Trans>Export</Trans>
            </Button>
            <Button
              variant="outline"
              icon={I.Refresh}
              onClick={() => {
                setReloadKey((k) => k + 1);
                pushToast(t`Graph refreshed from collections metadata.`);
              }}
            >
              <Trans>Refresh</Trans>
            </Button>
          </>
        }
      />

      <Card className="gap-0 overflow-hidden py-0">
        <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
          <span className="text-[12.5px] font-medium">
            <Trans>{collections.length} collections · {edgeRows.length} relations</Trans>
          </span>
          <div className="flex-1" />
          <div className="flex gap-2.5 text-[11.5px] text-muted-foreground">
            <span className="flex items-center gap-[5px]"><span className="h-0.5 w-4 bg-foreground" /> <Trans>relation</Trans></span>
            <span className="flex items-center gap-[5px]"><span className="w-4 border-t-2 border-dashed border-foreground" /> <Trans>relation_many</Trans></span>
          </div>
        </div>
        {collections.length === 0 ? (
          <div className="p-10 text-center text-[13px] text-muted-foreground">
            <Trans>No collections to graph — create one to populate the ERD.</Trans>
          </div>
        ) : (
          <ReactFlowProvider>
            {/* Remount on refresh / reset-layout so the canvas re-seeds node
                positions from the freshly-loaded `layout` (the drag-position
                ref inside ErdCanvas is otherwise sticky across re-renders). */}
            <ErdCanvas
              key={reloadKey}
              collections={collections}
              layout={layout}
              pushToast={pushToast}
              onMutated={setCollections}
            />
          </ReactFlowProvider>
        )}
      </Card>

      {/* Relations summary table */}
      <Card className="gap-0 py-0">
        <div className="flex items-center gap-2.5 border-b border-border px-4 py-3.5">
          <I.Network size={14} />
          <span className="text-[13px] font-medium"><Trans>relations</Trans></span>
          <span className="font-mono text-xs text-muted-foreground">{edgeRows.length}</span>
        </div>
        {edgeRows.length === 0 ? (
          <div className="px-4 py-3.5 text-xs text-muted-foreground">
            <Trans>No relation-typed fields detected. Add a field with type{" "}
            <span className="font-mono">relation</span> to draw an edge.</Trans>
          </div>
        ) : (
          <Table className={ADMIN_TABLE_CLS}>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[200px]"><Trans>from</Trans></TableHead>
                <TableHead className="w-10" />
                <TableHead className="w-[200px]"><Trans>to</Trans></TableHead>
                <TableHead className="w-[110px]"><Trans>kind</Trans></TableHead>
                <TableHead><Trans>field</Trans></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {edgeRows.map((e) => (
                <TableRow key={`${e.from}.${e.field}->${e.to}`}>
                  <TableCell className="font-mono">c_{e.from}</TableCell>
                  <TableCell><I.ChevronRight size={12} className="text-muted-foreground" /></TableCell>
                  <TableCell className="font-mono">c_{e.to}</TableCell>
                  <TableCell>
                    <Badge variant={e.many ? "secondary" : "outline"}>{e.many ? "relation_many" : "relation"}</Badge>
                  </TableCell>
                  <TableCell className="font-mono text-muted-foreground">{e.field}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
