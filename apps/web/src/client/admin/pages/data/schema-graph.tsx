// Schema graph (ERD) editor — live, interactive view of dynamic collections
// and their relations, built on @xyflow/react.
//
// Nodes come from /api/collections (collectionsApi.list). Each node is a
// table card listing its user-defined fields; relation / relation_many fields
// derive edges to their target collection (the field's `to` slug). Tables are
// arranged by `schema-graph-layout.ts` — one block per admin group, layered by
// reference direction. A position somebody drags is persisted per workspace in
// the `erdLayout` setting and wins over that arrangement. Inline schema
// editing — add / edit / drop a field, and draw a new relation by dragging
// between two nodes — round-trips through the same collection endpoints the
// Schema tab uses.
//
// A large schema is only readable with ways to show less of it, so the canvas
// has four: selecting a table focuses it (it, its neighbours and the relations
// between them stay lit, everything else fades), "Find a table" jumps to one,
// the group filter narrows the canvas to one group and what it relates to, and
// "Relations only" shrinks every card to the rows that draw edges.
import type { PushToast } from "../../types";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  useReactFlow,
  type Node,
  type Edge,
  type Connection,
  type NodeProps,
  type OnSelectionChangeParams,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { I } from "../../icons";
import { Badge, Button, PageHeader } from "../../ui";
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
import { Skeleton } from "@backlex/ui/components/skeleton";
import { Popover, PopoverContent, PopoverTrigger } from "@backlex/ui/components/popover";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@backlex/ui/components/command";
import { useIsMobile } from "@backlex/ui/hooks/use-mobile";
import { collectionsApi, settingsApi, type ApiCollection } from "../../api";
import { AddFieldDialog } from "../../fields/add-field";
import { EditFieldDialog } from "../../fields/edit-field";
import { Select } from "../../select";
import { SchemaGraphSkeleton } from "../../page-skeletons";
import {
  estimateNodeHeight,
  groupOf,
  isRelationType,
  layoutSchemaGraph,
  NODE_HEADER_H,
  NODE_ROW_H,
  NODE_W,
  relationEdges,
  settleOverlaps,
  TARGET_ANCHOR_Y,
  visibleFields,
  type ErdLayout,
} from "./schema-graph-layout";

const ADMIN_TABLE_CLS =
  "[&_td]:px-3.5 [&_td]:text-[13px] [&_th]:h-9 [&_th]:px-3.5 [&_th]:text-[11px] [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-[0.06em] [&_th]:text-muted-foreground";

// Same OKLCH palette the design uses, one colour per admin group — so the
// accent bar says which block a card belongs to, on the canvas and the minimap.
const GROUP_PALETTE = [
  "oklch(0.78 0.16 130)",
  "oklch(0.72 0.16 240)",
  "oklch(0.72 0.18 95)",
  "oklch(0.7 0.16 28)",
  "oklch(0.68 0.06 285)",
  "oklch(0.74 0.16 200)",
  "oklch(0.7 0.18 320)",
  "oklch(0.76 0.14 160)",
  "oklch(0.74 0.15 55)",
];
const UNGROUPED_COLOR = "var(--muted-foreground)";

// Group-filter values that are not group names.
const ALL_GROUPS = "__all__";
const UNGROUPED = "__ungrouped__";

// Past this many tables, full cards are too tall to read side by side, so the
// canvas opens on relations only until the viewer picks a density themselves.
const COMPACT_ABOVE = 24;
const DENSITY_KEY = "backlex.schemaGraph.density";

function readDensity(): "compact" | "full" | null {
  try {
    const v = localStorage.getItem(DENSITY_KEY);
    return v === "compact" || v === "full" ? v : null;
  } catch {
    return null;
  }
}

function writeDensity(v: "compact" | "full"): void {
  try {
    localStorage.setItem(DENSITY_KEY, v);
  } catch {
    // Storage refused (private window): the choice lasts for this visit only.
  }
}

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
  /** Draw only the relation rows — the layout was computed for that height. */
  compact: boolean;
  adopted: boolean;
  validTargets: Set<string>;
  onOpen: (slug: string) => void;
  onAddField: (slug: string) => void;
  onEditField: (slug: string, name: string) => void;
  onDropField: (slug: string, name: string) => void;
  [key: string]: unknown;
}

type CollectionNode = Node<CollectionNodeData, "collection">;

interface RelationEdgeData {
  field: string;
  many: boolean;
  [key: string]: unknown;
}

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
};

function toFieldRows(c: ApiCollection): FieldRow[] {
  return (c.fields ?? []).map((f) => ({
    name: f.name,
    type: f.type,
    required: f.required,
    unique: f.unique,
    to: (f as { to?: string }).to,
    isRelation: isRelationType(f.type),
    many: f.type === "relation_many",
  }));
}

// ---------------------------------------------------------------------------
// Custom node — a table card with one row per user field + relation handles.
// Header and rows are sized from the layout's constants, which is what lets the
// layout promise cards never overlap. Memoised because focus and filter restyle
// the node wrapper without touching `data`, and a hover should not re-render
// every row of every card.
// ---------------------------------------------------------------------------
const CollectionNodeView = memo(function CollectionNodeView({ data: d, selected }: NodeProps<CollectionNode>) {
  const { t } = useLingui();
  const rows = visibleFields(d.fields, d.compact);
  return (
    <div
      className={`overflow-hidden rounded-control border bg-card shadow-sm transition-colors ${selected ? "border-primary ring-1 ring-primary" : "border-border"}`}
      style={{ width: NODE_W }}
    >
      {/* Target handle — incoming relations anchor on the node's left edge. */}
      <Handle
        type="target"
        id="t"
        position={Position.Left}
        className="!h-2.5 !w-2.5 !border-2 !border-background !bg-muted-foreground"
        style={{ top: TARGET_ANCHOR_Y }}
      />
      <div
        className="flex items-center gap-2 border-b border-border px-3"
        style={{ height: NODE_HEADER_H, background: "color-mix(in oklch, var(--muted) 35%, var(--card))" }}
      >
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
          className="nodrag grid size-5 shrink-0 place-items-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
          title={t`Add field`}
          onClick={(e) => { e.stopPropagation(); d.onAddField(d.slug); }}
        >
          <I.Plus size={13} />
        </button>
        <button
          type="button"
          className="nodrag grid size-5 shrink-0 place-items-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
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
        style={{ top: TARGET_ANCHOR_Y }}
        title={t`Drag to another collection to create a relation`}
      />
      <div className="flex flex-col">
        {!d.compact && rows.length === 0 && (
          <div className="flex items-center px-3 text-[11.5px] text-muted-foreground" style={{ height: NODE_ROW_H }}>
            <Trans>No user fields yet.</Trans>
          </div>
        )}
        {rows.map((f) => (
          <div
            key={f.name}
            className="group relative flex items-center gap-2 border-b border-border/60 px-3 last:border-b-0 hover:bg-accent/50"
            style={{ height: NODE_ROW_H }}
          >
            {f.isRelation && <I.Link size={11} className="shrink-0 text-primary" />}
            <span className="truncate font-mono text-[11.5px]">{f.name}</span>
            {f.required && <span className="text-[11px] text-destructive" title={t`required`}>*</span>}
            {f.unique && <span className="text-[10px] uppercase text-muted-foreground" title={t`unique`}>u</span>}
            <span className="ml-auto shrink-0 rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[9.5px] text-muted-foreground">
              {TYPE_ABBR[f.type] ?? f.type}
            </span>
            <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
              <button
                type="button"
                className="nodrag grid size-5 place-items-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
                title={t`Edit field`}
                onClick={(e) => { e.stopPropagation(); d.onEditField(d.slug, f.name); }}
              >
                <I.Pencil size={11} />
              </button>
              {!d.adopted && (
                <button
                  type="button"
                  className="nodrag grid size-5 place-items-center rounded-sm text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
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
});

const nodeTypes = { collection: CollectionNodeView };

// ---------------------------------------------------------------------------
// Find a table — a combobox over every collection; picking one jumps to it.
// ---------------------------------------------------------------------------
function FindTable({
  tables,
  onPick,
  onOpenChange,
  className,
}: {
  tables: { slug: string; group: string; color: string }[];
  onPick: (slug: string) => void;
  onOpenChange: (open: boolean) => void;
  className?: string;
}) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const change = (next: boolean) => {
    setOpen(next);
    onOpenChange(next);
  };
  return (
    <Popover open={open} onOpenChange={change}>
      <PopoverTrigger asChild>
        <Button variant="outline" icon={I.Search} className={`justify-start text-muted-foreground ${className ?? ""}`}>
          <Trans>Find a table…</Trans>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 max-w-[calc(100vw-2rem)] p-0" align="start">
        <Command>
          <CommandInput placeholder={t`Table name or group…`} />
          <CommandList>
            <CommandEmpty><Trans>No table matches.</Trans></CommandEmpty>
            {tables.map((tb) => (
              <CommandItem
                key={tb.slug}
                value={tb.slug}
                keywords={tb.group ? [tb.group] : []}
                onSelect={() => {
                  change(false);
                  onPick(tb.slug);
                }}
              >
                <span className="size-2 shrink-0 rounded-full" style={{ background: tb.color }} />
                <span className="min-w-0 truncate font-mono text-[12px]">c_{tb.slug}</span>
                {tb.group && <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">{tb.group}</span>}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

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
  onConfirm: (confirm: boolean) => void;
}) {
  // Asked on open, so the dialog can say what is at stake instead of warning in
  // the abstract. Until it answers we show a skeleton — never a "Loading…".
  const [impact, setImpact] = useState<{ rows: number; nonNull: number } | null>(null);
  const [typed, setTyped] = useState("");
  const slug = target?.slug;
  const name = target?.name;

  useEffect(() => {
    if (!slug || !name) return;
    let cancelled = false;
    setImpact(null);
    setTyped("");
    collectionsApi
      .dropFieldImpact(slug, name)
      .then((r) => { if (!cancelled) setImpact({ rows: r.rows, nonNull: r.nonNull }); })
      // A failed probe must not block the drop — fall back to treating it as
      // destructive, which is the safe direction.
      .catch(() => { if (!cancelled) setImpact({ rows: -1, nonNull: -1 }); });
    return () => { cancelled = true; };
  }, [slug, name]);

  if (!target) return null;
  const destructive = impact === null || impact.nonNull !== 0;
  // Typing the column name is asked for only when values would actually be
  // lost. Dropping an empty column is a schema edit, not a data decision.
  const needsTyping = impact !== null && impact.nonNull !== 0;
  const canDrop = impact !== null && (!needsTyping || typed === target.name);

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle><Trans>Drop field</Trans></DialogTitle>
          <DialogDescription>
            <Trans>This runs <span className="font-mono">ALTER TABLE … DROP COLUMN {target.name}</span> on <span className="font-mono">c_{target.slug}</span>. The column is removed for good.</Trans>
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3 text-[13px]">
          {impact === null ? (
            <Skeleton className="h-9 w-full" />
          ) : impact.nonNull === 0 ? (
            <p className="text-muted-foreground">
              <Trans>No row has a value in this column, so nothing is lost.</Trans>
            </p>
          ) : (
            <p className="text-muted-foreground">
              <Trans>
                {impact.nonNull} of {impact.rows} rows have a value here. They are
                saved to a backup first, so they can be restored if the field is
                added back.
              </Trans>
            </p>
          )}
          {needsTyping ? (
            <div className="flex flex-col gap-1.5">
              <label className="text-[12px] text-muted-foreground" htmlFor="drop-confirm">
                <Trans>Type the column name to confirm</Trans>
              </label>
              <Input
                id="drop-confirm"
                value={typed}
                autoComplete="off"
                placeholder={target.name}
                onChange={(e) => setTyped(e.target.value)}
              />
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}><Trans>Cancel</Trans></Button>
          <Button
            variant="destructive"
            size="sm"
            icon={I.Trash}
            disabled={!canDrop}
            onClick={() => onConfirm(destructive)}
          >
            <Trans>Drop column</Trans>
          </Button>
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
  groupOrder,
  pushToast,
  onMutated,
}: {
  collections: ApiCollection[];
  layout: ErdLayout;
  groupOrder: string[];
  pushToast: PushToast;
  onMutated: (next: ApiCollection[]) => void;
}) {
  const { t } = useLingui();
  const navigate = useNavigate();
  const { fitView } = useReactFlow();
  const isMobile = useIsMobile();
  const bySlug = useMemo(() => new Map(collections.map((c) => [c.slug, c])), [collections]);
  const validSlugs = useMemo(() => new Set(collections.map((c) => c.slug)), [collections]);
  const relations = useMemo(() => relationEdges(collections), [collections]);

  const [compact, setCompact] = useState(() => {
    const stored = readDensity();
    return stored ? stored === "compact" : collections.length > COMPACT_ABOVE;
  });
  const [groupFilter, setGroupFilter] = useState(ALL_GROUPS);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);

  // Groups in the order the sidebar lists them, then any it does not know.
  const groups = useMemo(() => {
    const present = new Set(collections.map(groupOf).filter(Boolean));
    const known = groupOrder.filter((g) => present.has(g));
    return [...known, ...[...present].filter((g) => !known.includes(g)).sort()];
  }, [collections, groupOrder]);
  const colorOf = useCallback(
    (group: string) =>
      group ? (GROUP_PALETTE[groups.indexOf(group) % GROUP_PALETTE.length] ?? UNGROUPED_COLOR) : UNGROUPED_COLOR,
    [groups],
  );

  // Positions somebody chose — seeded from the saved layout, extended by every
  // drag. Only these are saved: a table nobody moved follows the arrangement,
  // so it can improve (or follow a density switch) without a stale copy of an
  // old arrangement pinning it in place.
  const userPositions = useRef<ErdLayout>({ ...layout });
  // The arrangement is computed once per density and set of tables, then held
  // still: adding a field or a relation inline must not reshuffle the canvas
  // under the person doing it. `settleOverlaps` absorbs the taller card.
  const arrangement = useRef<{ key: string; positions: ErdLayout } | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Serialize layout saves: only one PATCH in flight at a time (concurrent
  // settings writes race and one fails → the spurious "Couldn't save layout").
  // If positions change while a save is in flight, mark dirty and flush after.
  const saveInFlight = useRef(false);
  const saveDirty = useRef(false);
  // True while a node is dragged or a relation is being drawn: a hover preview
  // flickering the canvas under the pointer would fight either gesture.
  const busy = useRef(false);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Inline-edit dialog state.
  const [addFieldSlug, setAddFieldSlug] = useState<string | null>(null);
  const [editField, setEditField] = useState<{ slug: string; name: string } | null>(null);
  const [dropTarget, setDropTarget] = useState<{ slug: string; name: string } | null>(null);
  const [pendingRel, setPendingRel] = useState<{ from: string; to: string } | null>(null);

  const saveLayoutNow = useCallback(async () => {
    if (saveInFlight.current) {
      saveDirty.current = true; // coalesce — flush the latest after the current save
      return;
    }
    saveInFlight.current = true;
    saveDirty.current = false;
    // Positions of tables that no longer exist are dropped rather than carried
    // forward forever in the settings row.
    const erdLayout = Object.fromEntries(
      Object.entries(userPositions.current).filter(([slug]) => validSlugs.has(slug)),
    );
    try {
      await settingsApi.patch({ erdLayout });
    } catch {
      // One retry for transient failures before surfacing the warning.
      try {
        await settingsApi.patch({ erdLayout });
      } catch {
        pushToast(t`Couldn't save layout.`, "error");
      }
    } finally {
      saveInFlight.current = false;
      if (saveDirty.current) void saveLayoutNow();
    }
  }, [pushToast, t, validSlugs]);

  // Debounce drag-stops (600ms); saveLayoutNow serializes the actual PATCH.
  const persistLayout = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void saveLayoutNow();
    }, 600);
  }, [saveLayoutNow]);

  // PATCH a collection's full field set, then re-fetch and bubble up.
  const patchFields = useCallback(
    async (slug: string, fields: ApiCollection["fields"], note: string) => {
      // Optimistic: apply the new field set locally now so the node updates
      // instantly, then reconcile with the server (and roll back on error).
      const prev = collections;
      onMutated(collections.map((c) => (c.slug === slug ? { ...c, fields } : c)));
      try {
        await collectionsApi.patch(slug, { fields });
        // NOTE: do NOT refetch-and-overwrite on success. The optimistic state IS
        // the new truth; an immediate list() can hit a different isolate whose
        // collections cache is still stale (≤TTL) and resurrect the change we
        // just made (the "drops then reappears" bug). Reconcile only on error.
        pushToast(note);
      } catch (e) {
        onMutated(prev);
        pushToast((e as Error).message, "error");
      }
    },
    [collections, onMutated, pushToast],
  );

  const handleOpen = useCallback((slug: string) => navigate(`/collections/${slug}`), [navigate]);
  const handleAddField = useCallback((slug: string) => setAddFieldSlug(slug), []);
  const handleEditField = useCallback((slug: string, name: string) => setEditField({ slug, name }), []);
  const handleDropField = useCallback((slug: string, name: string) => setDropTarget({ slug, name }), []);

  const buildNodes = useCallback((): CollectionNode[] => {
    const key = `${compact ? "compact" : "full"}|${[...validSlugs].sort().join(",")}`;
    if (arrangement.current?.key !== key) {
      arrangement.current = { key, positions: layoutSchemaGraph(collections, { compact, groupOrder }) };
    }
    const auto = arrangement.current.positions;
    const heights: Record<string, number> = {};
    const planned: ErdLayout = {};
    for (const c of collections) {
      heights[c.slug] = estimateNodeHeight(c, compact);
      planned[c.slug] = userPositions.current[c.slug] ?? auto[c.slug] ?? { x: 40, y: 40 };
    }
    const placed = settleOverlaps(
      planned,
      heights,
      new Set(Object.keys(userPositions.current).filter((slug) => validSlugs.has(slug))),
    );
    return collections.map((c) => ({
      id: c.slug,
      type: "collection",
      position: placed[c.slug] ?? { x: 40, y: 40 },
      data: {
        slug: c.slug,
        color: colorOf(groupOf(c)),
        fields: toFieldRows(c),
        compact,
        adopted: Boolean(c.adopted),
        validTargets: validSlugs,
        onOpen: handleOpen,
        onAddField: handleAddField,
        onEditField: handleEditField,
        onDropField: handleDropField,
      },
    }));
  }, [collections, compact, groupOrder, validSlugs, colorOf, handleOpen, handleAddField, handleEditField, handleDropField]);

  const buildEdges = useCallback(
    (): Edge<RelationEdgeData>[] =>
      relations.map((r) => ({
        id: `${r.from}.${r.field}->${r.to}`,
        source: r.from,
        sourceHandle: `f:${r.field}`,
        target: r.to,
        targetHandle: "t",
        animated: r.many,
        markerEnd: { type: MarkerType.ArrowClosed },
        data: { field: r.field, many: r.many },
      })),
    [relations],
  );

  // The first render needs nodes for `fitView`; building them on every render
  // just to discard the result would cost a layout pass per drag frame.
  const initial = useRef<{ nodes: CollectionNode[]; edges: Edge<RelationEdgeData>[] } | null>(null);
  if (initial.current === null) initial.current = { nodes: buildNodes(), edges: buildEdges() };
  const [nodes, setNodes, onNodesChange] = useNodesState<CollectionNode>(initial.current.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge<RelationEdgeData>>(initial.current.edges);

  // Rebuild whenever the collection set or the density changes (add/edit/drop
  // field, refresh). Chosen positions survive via userPositions, and the
  // current selection is carried over so an inline edit keeps its focus.
  useEffect(() => {
    setNodes((prev) => {
      const selected = new Set(prev.filter((n) => n.selected).map((n) => n.id));
      return buildNodes().map((n) => (selected.has(n.id) ? { ...n, selected: true } : n));
    });
    setEdges(buildEdges());
  }, [buildNodes, buildEdges, setNodes, setEdges]);

  const handleNodesChange = useCallback(
    (changes: Parameters<typeof onNodesChange>[0]) => {
      for (const ch of changes) {
        if (ch.type === "position" && ch.position) userPositions.current[ch.id] = ch.position;
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

  // --- Focus -----------------------------------------------------------------
  // Focus IS the selection, so clicking, shift-clicking, box-selecting and
  // clicking the background all keep meaning what they meant.
  const onSelectionChange = useCallback(({ nodes: picked }: OnSelectionChangeParams) => {
    const ids = picked.map((n) => n.id).sort();
    setSelectedIds((prev) => (prev.length === ids.length && prev.every((id, i) => id === ids[i]) ? prev : ids));
  }, []);

  const clearSelection = useCallback(() => {
    setNodes((ns) => ns.map((n) => (n.selected ? { ...n, selected: false } : n)));
    setEdges((es) => es.map((e) => (e.selected ? { ...e, selected: false } : e)));
    setHoverId(null);
  }, [setNodes, setEdges]);

  // Preview on hover only when nothing is selected, and only after the pointer
  // settles: sweeping across the canvas should not strobe it.
  const queueHover = useCallback((id: string | null, delay: number) => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => setHoverId(id), delay);
  }, []);
  // Only the hover timer is cancelled on unmount. A pending layout save is left
  // to fire: refreshing within 600ms of a drag must not lose that drag.
  useEffect(
    () => () => {
      if (hoverTimer.current) clearTimeout(hoverTimer.current);
    },
    [],
  );

  const dialogOpen = addFieldSlug !== null || editField !== null || dropTarget !== null || pendingRel !== null;
  useEffect(() => {
    if ((selectedIds.length === 0 && hoverId === null) || dialogOpen || searchOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") clearSelection();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedIds.length, hoverId, dialogOpen, searchOpen, clearSelection]);

  const neighbours = useMemo(() => {
    const out = new Map<string, Set<string>>();
    const link = (a: string, b: string) => {
      const set = out.get(a);
      if (set) set.add(b);
      else out.set(a, new Set([b]));
    };
    for (const r of relations) {
      link(r.from, r.to);
      link(r.to, r.from);
    }
    return out;
  }, [relations]);

  const focus = useMemo(() => {
    const ids = selectedIds.length > 0 ? selectedIds : hoverId ? [hoverId] : [];
    if (ids.length === 0) return null;
    const lit = new Set(ids);
    for (const id of ids) for (const n of neighbours.get(id) ?? []) lit.add(n);
    return { ids: new Set(ids), lit };
  }, [selectedIds, hoverId, neighbours]);

  // --- Group filter ------------------------------------------------------------
  const filterKeyOf = (c: ApiCollection) => groupOf(c) || UNGROUPED;
  const filter = useMemo(() => {
    if (groupFilter === ALL_GROUPS) return null;
    const members = new Set(collections.filter((c) => filterKeyOf(c) === groupFilter).map((c) => c.slug));
    // The tables a group relates to stay on the canvas, faded: a group drawn
    // without them hides exactly the relations somebody filtered to look at.
    const related = new Set<string>();
    for (const r of relations) {
      if (members.has(r.from) && !members.has(r.to)) related.add(r.to);
      if (members.has(r.to) && !members.has(r.from)) related.add(r.from);
    }
    return { members, related };
  }, [groupFilter, collections, relations]);
  const shown = useCallback(
    (id: string) => !filter || filter.members.has(id) || filter.related.has(id),
    [filter],
  );

  // --- What React Flow draws -----------------------------------------------------
  // Focus and filter restyle nodes without rebuilding them. A node object is
  // replaced only when its own look changes, so a hover does not re-render
  // every card — and during a drag only the dragged card is new each frame.
  const looks = useRef(new WeakMap<CollectionNode, CollectionNode>());
  const displayNodes = useMemo(
    () =>
      nodes.map((n) => {
        const hidden = !shown(n.id);
        const className = hidden
          ? ""
          : focus
            ? focus.lit.has(n.id)
              ? ""
              : "erd-dim"
            : filter?.related.has(n.id)
              ? "erd-context"
              : "";
        if ((n.className ?? "") === className && Boolean(n.hidden) === hidden) return n;
        const cached = looks.current.get(n);
        if (cached && cached.className === className && cached.hidden === hidden) return cached;
        const next = { ...n, className, hidden };
        looks.current.set(n, next);
        return next;
      }),
    [nodes, shown, focus, filter],
  );

  const displayEdges = useMemo(
    () =>
      edges.map((e) => {
        const hot = !!focus && (focus.ids.has(e.source) || focus.ids.has(e.target));
        return {
          ...e,
          // A hidden node does not hide its edges on its own.
          hidden: !shown(e.source) || !shown(e.target),
          className: hot ? "erd-hot" : focus ? "erd-dim" : "",
          // Names only on the relations being looked at: 130 labels at once
          // are the noise this view exists to remove.
          label: hot ? e.data?.field : undefined,
          style: {
            stroke: hot ? "var(--primary)" : "var(--muted-foreground)",
            strokeWidth: hot ? 2 : 1.25,
            strokeDasharray: e.data?.many ? "5 4" : undefined,
          },
          labelStyle: { fontFamily: "Geist Mono, monospace", fontSize: 10, fill: "var(--foreground)" },
          labelBgStyle: { fill: "var(--card)" },
        };
      }),
    [edges, focus, shown],
  );

  // --- Toolbar actions -----------------------------------------------------------
  const tables = useMemo(
    () =>
      [...collections]
        .map((c) => ({ slug: c.slug, group: groupOf(c), color: colorOf(groupOf(c)) }))
        .sort((a, b) => {
          const ga = a.group ? groups.indexOf(a.group) : groups.length;
          const gb = b.group ? groups.indexOf(b.group) : groups.length;
          return ga - gb || (a.slug < b.slug ? -1 : 1);
        }),
    [collections, groups, colorOf],
  );

  const jumpTo = useCallback(
    (slug: string) => {
      // A table the group filter hides cannot be shown; widen the canvas first.
      if (!shown(slug)) setGroupFilter(ALL_GROUPS);
      setNodes((ns) => ns.map((n) => (Boolean(n.selected) === (n.id === slug) ? n : { ...n, selected: n.id === slug })));
      setEdges((es) => es.map((e) => (e.selected ? { ...e, selected: false } : e)));
      void fitView({ nodes: [{ id: slug }], duration: 450, maxZoom: 1, padding: 0.3 });
    },
    [shown, setNodes, setEdges, fitView],
  );

  const onGroupFilter = useCallback(
    (value: string) => {
      setGroupFilter(value);
      clearSelection();
      const members = collections.filter((c) => filterKeyOf(c) === value).map((c) => ({ id: c.slug }));
      // Frame the group itself; its faded neighbours may sit outside the frame.
      void fitView({
        ...(value === ALL_GROUPS ? {} : { nodes: members }),
        duration: 450,
        maxZoom: 1,
        padding: 0.12,
      });
    },
    [collections, clearSelection, fitView],
  );

  const onDensity = useCallback(
    (next: boolean) => {
      if (next === compact) return;
      writeDensity(next ? "compact" : "full");
      setCompact(next);
      // Every card changes height and the arrangement with it, so frame the
      // canvas again — two frames later, once React Flow has measured the
      // cards at their new size.
      const focusOn = selectedIds.map((id) => ({ id }));
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          void fitView({ ...(focusOn.length > 0 ? { nodes: focusOn } : {}), duration: 350, maxZoom: 1, padding: 0.08 });
        }),
      );
    },
    [compact, selectedIds, fitView],
  );

  const groupOptions = [
    { value: ALL_GROUPS, label: t`All groups` },
    ...groups.map((g) => ({
      value: g,
      label: g,
      icon: <span className="size-2 rounded-full" style={{ background: colorOf(g) }} />,
    })),
    ...(collections.some((c) => !groupOf(c))
      ? [{ value: UNGROUPED, label: t`Ungrouped`, icon: <span className="size-2 rounded-full" style={{ background: UNGROUPED_COLOR }} /> }]
      : []),
  ];

  const addSchema = addFieldSlug ? bySlug.get(addFieldSlug) : null;
  const editSrc = editField ? bySlug.get(editField.slug) : null;
  const editFieldDef = editSrc?.fields.find((f) => f.name === editField?.name) ?? null;

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
        {/* On a phone the search takes its own line; the filter and the
            density toggle share the next. Side by side with basis 0, all
            three fit one line and squeeze the two labels to nothing. */}
        <div className="flex w-full min-w-0 flex-wrap items-center gap-2 sm:w-auto">
          <FindTable
            tables={tables}
            onPick={jumpTo}
            onOpenChange={setSearchOpen}
            className="w-full sm:w-52"
          />
          {groups.length > 0 && (
            <Select
              size="sm"
              value={groupFilter}
              onChange={onGroupFilter}
              options={groupOptions}
              className="min-w-0 flex-1 sm:w-48 sm:flex-none"
            />
          )}
          <div
            role="group"
            aria-label={t`Card detail`}
            className="inline-flex shrink-0 items-center gap-[3px] rounded-control border border-border bg-muted/60 p-[3px]"
          >
            {([
              [true, t`Relations only`],
              [false, t`All fields`],
            ] as const).map(([value, label]) => (
              <Button
                key={String(value)}
                size="xs"
                variant="ghost"
                aria-pressed={compact === value}
                onClick={() => onDensity(value)}
                className={
                  compact === value
                    ? "bg-[color-mix(in_oklch,var(--primary)_16%,transparent)] text-foreground hover:bg-[color-mix(in_oklch,var(--primary)_22%,transparent)]"
                    : "text-muted-foreground"
                }
              >
                {label}
              </Button>
            ))}
          </div>
        </div>
        <div className="hidden flex-1 sm:block" />
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-muted-foreground">
          <span className="font-medium text-foreground">
            <Trans>{collections.length} collections · {relations.length} relations</Trans>
          </span>
          <span className="flex items-center gap-[5px]"><span className="h-0.5 w-4 bg-muted-foreground" /> <Trans>relation</Trans></span>
          <span className="flex items-center gap-[5px]"><span className="w-4 border-t-2 border-dashed border-muted-foreground" /> <Trans>relation_many</Trans></span>
        </div>
      </div>
      <div className="h-[min(70vh,640px)] w-full">
        <ReactFlow
          nodes={displayNodes}
          edges={displayEdges}
          nodeTypes={nodeTypes}
          onNodesChange={handleNodesChange}
          onEdgesChange={onEdgesChange}
          onSelectionChange={onSelectionChange}
          onNodeMouseEnter={(_, node) => {
            if (!busy.current && selectedIds.length === 0) queueHover(node.id, 160);
          }}
          onNodeMouseLeave={() => queueHover(null, 90)}
          // A tap raises mouseenter and never mouseleave, so on a touch screen
          // the preview would outlive the selection the background tap cleared.
          onPaneClick={() => queueHover(null, 0)}
          onNodeDragStart={() => {
            busy.current = true;
            queueHover(null, 0);
          }}
          onNodeDragStop={() => {
            busy.current = false;
            persistLayout();
          }}
          onConnectStart={() => {
            busy.current = true;
            queueHover(null, 0);
          }}
          onConnectEnd={() => {
            busy.current = false;
          }}
          onConnect={onConnect}
          // Backspace removed the selected card from the canvas — not from the
          // schema — until the next refresh. With selection now meaning focus,
          // that key is one press away from a phantom deletion.
          deleteKeyCode={null}
          defaultMarkerColor="var(--muted-foreground)"
          fitView
          fitViewOptions={{ padding: 0.08, maxZoom: 1 }}
          // A 69-table template needs about 0.2 to fit on one screen.
          minZoom={0.1}
          maxZoom={2}
          proOptions={{ hideAttribution: true }}
          // Focus and filter fade through these. The underscores in React
          // Flow's class names are escaped on purpose: Tailwind reads `_` in
          // an arbitrary variant as a space, so `react-flow__node` compiles to
          // the selector `.react-flow node` — valid, matching nothing, and no
          // error anywhere to say so.
          className="!bg-[color-mix(in_oklch,var(--muted)_30%,var(--card))] [&_.react-flow\_\_edge.erd-dim]:opacity-[0.07] [&_.react-flow\_\_edge.erd-hot]:opacity-100 [&_.react-flow\_\_edge]:opacity-50 [&_.react-flow\_\_edge]:transition-opacity [&_.react-flow\_\_node.erd-context]:opacity-50 [&_.react-flow\_\_node.erd-dim]:opacity-20 [&_.react-flow\_\_node]:transition-opacity"
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="var(--border)" />
          {/* React Flow ships a light-theme stylesheet; override the controls +
              minimap to match the dark admin so the buttons aren't white blocks
              and the minimap isn't an oversized grey panel. */}
          <Controls
            showInteractive={false}
            className="!shadow-md !overflow-hidden !rounded-surface !border !border-border [&_button]:!border-b [&_button]:!border-border [&_button]:!bg-card [&_button:hover]:!bg-muted [&_button:last-child]:!border-b-0 [&_button_svg]:!fill-foreground"
          />
          <MiniMap
            pannable
            zoomable
            nodeColor={(n) => (n.data as CollectionNodeData)?.color ?? "var(--muted-foreground)"}
            nodeStrokeColor="var(--border)"
            nodeBorderRadius={4}
            bgColor="var(--card)"
            maskColor="color-mix(in oklch, var(--background) 55%, transparent)"
            // Narrower on a phone, where the full size covers half the canvas.
            style={isMobile ? { width: 112, height: 76 } : { width: 168, height: 112 }}
            className="!bottom-3 !right-3 !m-0 overflow-hidden rounded-surface border border-border shadow-md"
          />
        </ReactFlow>
      </div>

      <AddFieldDialog
        open={addFieldSlug !== null}
        schema={(addSchema ? { slug: addSchema.slug, ownerScoped: false, fields: addSchema.fields } : { slug: "", ownerScoped: false, fields: [] }) as never}
        collections={collections.map((c) => ({ slug: c.slug, fieldDefs: c.fields }))}
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
        ownerSlug={editSrc?.slug ?? ""}
        collections={collections.map((c) => ({
          slug: c.slug,
          fieldDefs: c.fields,
          adopted: c.adopted,
        }))}
        availableFields={(editSrc?.fields ?? [])
          .map((f) => f.name)
          .filter((n): n is string => !!n && n !== editField?.name)}
        groups={[
          ...new Set(
            (editSrc?.fields ?? [])
              .map((f) => (f as { group?: string }).group)
              .filter((g): g is string => !!g && g.trim().length > 0),
          ),
        ]}
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
        onConfirm={async (confirm) => {
          if (!dropTarget) return;
          const { slug, name } = dropTarget;
          // Optimistic: remove the column from the node immediately + close the
          // dialog, then run the DROP and reconcile (roll back on error).
          const prev = collections;
          setDropTarget(null);
          onMutated(
            collections.map((c) =>
              c.slug === slug ? { ...c, fields: c.fields.filter((f) => f.name !== name) } : c,
            ),
          );
          try {
            const res = await collectionsApi.dropField(slug, name, { confirm });
            // Keep the optimistic removal — don't refetch-and-overwrite (a
            // stale cross-isolate list() cache would resurrect the dropped
            // column: "drops then reappears"). Reconcile only on error.
            pushToast(
              res.snapshotId
                ? t`Column "${name}" dropped from c_${slug}. ${res.nonNull} value(s) saved to a backup.`
                : t`Column "${name}" dropped from c_${slug}.`,
            );
          } catch (e) {
            onMutated(prev);
            pushToast((e as Error).message, "error");
          }
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
export function SchemaGraphPage({ pushToast }: { pushToast: PushToast }) {
  const { t } = useLingui();
  const [collections, setCollections] = useState<ApiCollection[]>([]);
  const [groupOrder, setGroupOrder] = useState<string[]>([]);
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
        const groupHeaders = cols.meta?.groups;
        if (Array.isArray(groupHeaders)) setGroupOrder(groupHeaders);
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

  const edgeRows = useMemo(() => relationEdges(collections), [collections]);

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
        description={t`Interactive ERD of dynamic collections. Click a table to light up its relations · drag nodes to arrange · drag from a node's right handle onto another to draw a relation · add, edit, or drop fields inline.`}
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
              groupOrder={groupOrder}
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
