// Filter DSL builder + Items DataTable for the backlex admin design.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useItemPatch, useItemReorder, useItemsGridWrite } from "../queries";
import { useGridEdit, type GridColumn } from "./grid-edit";
import { Trans, useLingui } from "@lingui/react/macro";
import { renderTemplate } from "@backlex/core";
import { I } from "../icons";
import { type CollectionSchema, type Post } from "../config";
import { Button, Checkbox, IconButton } from "../ui";
import { Select } from "../select";
import { Input } from "@backlex/ui/components/input";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@backlex/ui/components/input-group";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@backlex/ui/components/table";
import { Tabs, TabsList, TabsTrigger } from "@backlex/ui/components/tabs";
import { getAuthors, subscribeAuthors } from "../lib/authors-cache";
import { type CollabPeer, collabHandle, useListCollab } from "../lib/collab";
import { i18n } from "@lingui/core";
import { fieldLabel, formatFieldValue } from "../lib/format-value";
import { useListColumns } from "./list-columns";
import { useAppUserLabels, useRelationLabels } from "../lib/relation-labels";
import { shortId } from "../lib/row-label";
import { useCollections, useSettings } from "../queries";

// Cosmos "Backlex Console" data-grid styling. Header cells: mono 10px violet-
// gray, uppercase, subtle padding; body rows: subtle white/5 dividers, 12.5px
// cells. The header background sits on the header <TableRow> (sticky cells keep
// their opaque bg-card so scrolled content can't bleed through them).
const ADMIN_TABLE_CLS =
  "[&_th]:h-auto [&_th]:px-4 [&_th]:py-2.5 [&_th]:font-mono [&_th]:text-[10px] [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-[0.06em] [&_th]:text-[#8580A2] [&_td]:px-4 [&_td]:py-[11px] [&_td]:text-[12.5px] [&_tbody_tr]:border-white/[0.05]";

/** Segmented-control classes shared by the status tabs + the view toggle so
 *  the two strips read as one system. Restyle-only — the Radix Tabs behavior
 *  (keyboard nav, value change) is untouched. */
export const SEG_LIST_CLS =
  "gap-[3px] rounded-control border border-white/[0.07] bg-white/[0.04] p-[3px]";
export const SEG_TRIGGER_CLS =
  "rounded-sm px-3 py-[5px] text-xs font-semibold text-muted-foreground data-active:bg-[color-mix(in_oklch,var(--primary)_16%,transparent)] data-active:text-foreground";

/** Cosmos status chip — mint (published) / coral (review) / gray (draft) /
 *  dim (archived), or a custom-color dot when the schema's choice carries its
 *  own color. Value + label come straight from the schema-driven status field;
 *  this only restyles the presentation. */
function StatusBadge({ value, label, color }: { value: string; label?: string; color?: string }) {
  const base = "inline-flex items-center gap-1 rounded-sm border px-2 py-0.5 font-mono text-[10.5px]";
  if (color) {
    return (
      <span className={`${base} border-white/[0.12] bg-white/5 text-foreground`}>
        <span className="inline-block size-1.5 rounded-full" style={{ background: color }} />
        {label ?? value}
      </span>
    );
  }
  const TONES: Record<string, string> = {
    published:
      "text-accent-mint bg-[color-mix(in_oklch,var(--color-accent-mint)_10%,transparent)] border-[color-mix(in_oklch,var(--color-accent-mint)_22%,transparent)]",
    review:
      "text-accent-coral bg-[color-mix(in_oklch,var(--color-accent-coral)_10%,transparent)] border-[color-mix(in_oklch,var(--color-accent-coral)_25%,transparent)]",
    draft: "text-muted-foreground bg-white/5 border-white/[0.12]",
    archived: "text-[#7E789B] bg-white/[0.03] border-white/[0.09]",
  };
  return <span className={`${base} ${TONES[value] ?? TONES.draft}`}>{label ?? value}</span>;
}

export const FIELD_OPS: Record<string, string[]> = {
  text: ["_eq", "_neq", "_contains", "_starts_with", "_ends_with", "_in", "_null"],
  longtext: ["_contains", "_eq", "_null"],
  integer: ["_eq", "_neq", "_gt", "_gte", "_lt", "_lte", "_in"],
  number: ["_eq", "_gt", "_gte", "_lt", "_lte"],
  uuid: ["_eq", "_neq", "_in", "_null"],
  timestamp: ["_gt", "_gte", "_lt", "_lte", "_null"],
  boolean: ["_eq"],
  json: ["_contains", "_null"],
};

export const STATUS_VALUES = ["draft", "review", "published", "archived"];

export interface FilterCondition {
  field: string;
  op: string;
  value: unknown;
}

interface StatusChoice {
  value: string;
  label?: string;
  color?: string;
  icon?: string;
}

/**
 * Resolves the per-collection status field config. Returns the choices when
 * the schema declares a `status` (or any) field with `interface: dropdown`,
 * else null. The first matching dropdown field wins so the table can hide
 * the column when nothing is configured.
 */
export function resolveStatusField(schema?: { fields?: Array<Record<string, unknown>> } | null): {
  name: string;
  choices: StatusChoice[];
} | null {
  const fields = schema?.fields ?? [];
  const choicesOf = (f?: { options?: { choices?: StatusChoice[]; values?: string[] } }): StatusChoice[] =>
    f?.options?.choices?.length
      ? f.options.choices
      : (f?.options?.values ?? []).map((v) => ({ value: v }));

  // Explicit admin preference wins (Settings → kanban) when it names a real
  // dropdown field — this resolver drives the table's inline-editable status
  // column too, so it must stay a writable user field. The `_status` lifecycle
  // is Kanban-only and handled by `resolveKanbanGroupField`, not here. A
  // stale/renamed value falls through to auto-detect.
  const groupBy = (schema as { kanbanGroupBy?: string | null })?.kanbanGroupBy;
  if (groupBy && groupBy !== "_status") {
    const picked = fields.find(
      (f) => (f as { name?: string }).name === groupBy && (f as { interface?: string }).interface === "dropdown",
    ) as { name?: string; options?: { choices?: StatusChoice[]; values?: string[] } } | undefined;
    const pickedChoices = choicesOf(picked);
    if (picked?.name && pickedChoices.length) return { name: picked.name, choices: pickedChoices };
  }

  // Prefer a field literally named "status" so existing presets light up;
  // fall back to any dropdown-interface field.
  const named = fields.find((f) => (f as { name?: string }).name === "status" && (f as { interface?: string }).interface === "dropdown");
  const fallback = !named ? fields.find((f) => (f as { interface?: string }).interface === "dropdown") : null;
  const f = (named ?? fallback) as
    | { name?: string; options?: { choices?: StatusChoice[]; values?: string[] } }
    | undefined;
  if (!f?.name) return null;
  const choices = choicesOf(f);
  if (!choices.length) return null;
  return { name: f.name, choices };
}

/**
 * Kanban-only group axis. Extends `resolveStatusField` with the versioned
 * `_status` lifecycle: when the admin explicitly picks `_status`, the board
 * groups on the raw system column and drag maps draft↔published through the
 * publish endpoint (see `changeItemStatus`). Kept separate from
 * `resolveStatusField` because that one also drives the table's inline-editable
 * status column, which must stay a writable user field — never `_status`.
 * Columns: draft / published / archived; dragging fires the matching
 * publish / unpublish / archive action (see `changeItemStatus`).
 */
export function resolveKanbanGroupField(
  schema?: { fields?: Array<Record<string, unknown>>; kanbanGroupBy?: string | null; versioned?: boolean } | null,
): { name: string; choices: StatusChoice[] } | null {
  if (schema?.kanbanGroupBy === "_status" && schema?.versioned) {
    return {
      name: "_status",
      choices: [{ value: "draft" }, { value: "published" }, { value: "archived" }],
    };
  }
  return resolveStatusField(schema);
}

export function statusVariant(s: string) {
  if (s === "published") return "default" as const;
  if (s === "archived") return "secondary" as const;
  if (s === "review") return "outline" as const;
  return "outline" as const;
}

export function authorById(id: string | null | undefined) {
  if (!id) return { name: "—", initials: "—" };
  const hit = getAuthors().find((a) => a.id === id);
  if (hit) return { name: hit.name, initials: hit.initials };
  // Fallback: id might be a stale uuid — show first chars rather than crash.
  return {
    name: String(id).slice(0, 8),
    initials: String(id).slice(0, 2).toUpperCase() || "—",
  };
}

export function fmtDate(iso: string | null | undefined) {
  if (!iso) return "—";
  const d = new Date(iso);
  const now = new Date("2026-05-06T12:00:00Z");
  const diffMs = now.getTime() - d.getTime();
  const day = 86400000;
  if (diffMs < day) return `${Math.max(1, Math.floor(diffMs / 3600000))}h ago`;
  if (diffMs < 7 * day) return `${Math.floor(diffMs / day)}d ago`;
  return d.toISOString().slice(0, 10);
}

/** Coerce a cell value to a display string. `localized` fields arrive as a
 *  `{ en, tr }` map when the list isn't locale-collapsed — show one language
 *  (workspace default `prefer`, then English, else the first set locale)
 *  instead of "[object Object]". */
function cellText(v: unknown, prefer?: string): string {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const m = v as Record<string, unknown>;
    const pick = (prefer ? m[prefer] : undefined) ?? m.en ?? Object.values(m).find((x) => x != null);
    return pick != null ? String(pick) : "";
  }
  return String(v ?? "");
}

export function evaluateFilter(row: Record<string, unknown>, filter: Record<string, Record<string, unknown>>) {
  if (!filter || Object.keys(filter).length === 0) return true;
  for (const [k, v] of Object.entries(filter)) {
    const val = row[k];
    if (v && typeof v === "object") {
      for (const [op, opVal] of Object.entries(v)) {
        switch (op) {
          case "_eq": if (val !== opVal) return false; break;
          case "_neq": if (val === opVal) return false; break;
          case "_contains": if (!String(val ?? "").toLowerCase().includes(String(opVal).toLowerCase())) return false; break;
          case "_starts_with": if (!String(val ?? "").toLowerCase().startsWith(String(opVal).toLowerCase())) return false; break;
          case "_ends_with": if (!String(val ?? "").toLowerCase().endsWith(String(opVal).toLowerCase())) return false; break;
          case "_in": if (!Array.isArray(opVal) || !opVal.includes(val)) return false; break;
          case "_gt": if (!(Number(val) > Number(opVal))) return false; break;
          case "_gte": if (!(Number(val) >= Number(opVal))) return false; break;
          case "_lt": if (!(Number(val) < Number(opVal))) return false; break;
          case "_lte": if (!(Number(val) <= Number(opVal))) return false; break;
          case "_null": if ((val == null) !== !!opVal) return false; break;
        }
      }
    }
  }
  return true;
}

function FilterChip({ field, op, value, onRemove, onClick }: { field: string; op: string; value: unknown; onRemove: () => void; onClick?: () => void }) {
  const { t } = useLingui();
  const valStr = Array.isArray(value) ? `[${(value as unknown[]).join(", ")}]` : op === "_null" ? (value ? t`is null` : t`is not null`) : String(value);
  return (
    <span className="inline-flex h-7 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-control border border-chip-border bg-accent px-[11px] text-[12.5px] text-foreground" onClick={onClick}>
      <span className="text-muted-foreground">{field}</span>
      <span className="font-mono text-[11.5px] text-muted-foreground">{op}</span>
      <span className="font-mono">{valStr}</span>
      <span className="grid size-3.5 cursor-pointer place-items-center rounded-full opacity-60 hover:bg-muted hover:opacity-100" onClick={(e) => { e.stopPropagation(); onRemove(); }}><I.X size={11} /></span>
    </span>
  );
}

function AddFilterPopover({ schema, onAdd, onClose }: { schema: CollectionSchema; onAdd: (f: FilterCondition) => void; onClose: () => void }) {
  const { t } = useLingui();
  const editable = schema.fields.filter((f) => !f.system || f.name === "created_at" || f.name === "updated_at");
  const [field, setField] = useState(editable[1]?.name || editable[0]?.name || "title");
  // `fieldDef` is undefined when the collection has no filterable fields (a
  // bare/empty collection). Every access below is null-safe so opening the
  // filter popover never throws — a render throw here blanks the whole SPA
  // (there is no error boundary above the items view).
  const fieldDef = editable.find((f) => f.name === field) ?? editable[0];
  const isRelation = fieldDef?.type === "relation";
  const isRelationMany = fieldDef?.type === "relation_many";

  // Lazy-fetched target collection fields for nested relation filters.
  // We only hit the network when the user actually picks a relation
  // field, and cache the result for the popover's lifetime.
  const [targetFieldsCache, setTargetFieldsCache] = useState<Record<string, Array<{ name: string; type: string }>>>({});
  const [targetLoading, setTargetLoading] = useState(false);
  const [nestedSub, setNestedSub] = useState<string>("");

  // `relation` and `relation_many` heads share the drill-down: both need
  // a target collection slug to lazy-load fields from, and both submit
  // a `<head>.<sub>` filter key. The only server-side difference is the
  // SQL shape (JOIN vs EXISTS) — invisible from this picker.
  const needsTargetDrill = isRelation || isRelationMany;

  useEffect(() => {
    setNestedSub("");
    const to = fieldDef?.to;
    if (!needsTargetDrill || !to) return;
    if (targetFieldsCache[to]) return;
    let cancelled = false;
    setTargetLoading(true);
    fetch(`/api/collections/${to}`, { credentials: "include" })
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        const f = (j?.data?.fields ?? []) as Array<{ name: string; type: string }>;
        setTargetFieldsCache((cache) => ({ ...cache, [to]: f }));
      })
      .catch(() => { /* leave cache empty; sub dropdown will say "Target unavailable" */ })
      .finally(() => { if (!cancelled) setTargetLoading(false); });
    return () => { cancelled = true; };
  }, [field, needsTargetDrill, fieldDef?.to]);

  // Leaf field — the one that actually drives op list + value parsing.
  // For nested filters that's the sub-field on the target collection.
  const targetFields = needsTargetDrill && fieldDef?.to ? targetFieldsCache[fieldDef.to] : null;
  const subDef = nestedSub && targetFields ? targetFields.find((f) => f.name === nestedSub) : null;
  const leafType = subDef?.type ?? fieldDef?.type ?? "";
  // `_eq` is both the universal fallback operator list and the fallback member:
  // FIELD_OPS is keyed by storage type, and an unknown type still needs one op.
  const ops = (leafType ? FIELD_OPS[leafType] : undefined) || ["_eq"];
  const [op, setOp] = useState(ops[0] ?? "_eq");
  const [val, setVal] = useState("");

  useEffect(() => { setOp(ops[0] ?? "_eq"); }, [field, nestedSub]);

  const canSubmit = !!fieldDef && (!needsTargetDrill || !!nestedSub);

  const submit = () => {
    if (!canSubmit) return;
    let parsed: unknown = val;
    if (op === "_null") parsed = true;
    else if (["_in", "_nin"].includes(op)) parsed = val.split(",").map((s) => s.trim()).filter(Boolean);
    else if (["integer", "number"].includes(leafType)) parsed = Number(val);
    const fieldKey = needsTargetDrill && nestedSub ? `${field}.${nestedSub}` : field;
    onAdd({ field: fieldKey, op, value: parsed });
    onClose();
  };

  return (
    <div className="absolute left-0 top-11 z-50 flex w-[320px] max-w-[calc(100vw-16px)] flex-col gap-1.5 rounded-control border border-border bg-popover p-2 shadow-[0_12px_30px_-8px_oklch(0_0_0/0.18),0_2px_8px_oklch(0_0_0/0.06)]">
      {editable.length === 0 && (
        <p className="px-1 py-2 text-center text-[13px] text-muted-foreground">
          <Trans>No filterable fields in this collection.</Trans>
        </p>
      )}
      <div className="flex items-center gap-1.5">
        <Select value={field} onChange={setField} options={editable.map((f) => ({ value: f.name, label: f.name, hint: f.type }))} className="flex-1" />
        <Select value={op} onChange={setOp} options={ops} className="flex-[0_0_110px]" disabled={needsTargetDrill && !nestedSub} />
      </div>
      {/* Nested relation (single FK or array): pick a sub-field on the
          target collection. The server lowers `relation_many` to EXISTS
          and `relation` to a LEFT JOIN — same picker either way. */}
      {needsTargetDrill && (
        <div className="flex items-center gap-1.5">
          <Select
            value={nestedSub}
            onChange={setNestedSub}
            options={
              !fieldDef?.to
                ? [{ value: "", label: t`Relation has no target` }]
                : targetLoading
                  ? [{ value: "", label: t`Fetching subfields…` }]
                  : targetFields
                    ? targetFields.map((f) => ({ value: f.name, label: f.name, hint: f.type }))
                    : [{ value: "", label: t`Target unavailable` }]
            }
            placeholder={fieldDef?.to ? t`Pick a subfield…` : "—"}
            className="flex-1"
            disabled={!fieldDef?.to || targetLoading || !targetFields}
          />
        </div>
      )}
      {op !== "_null" && (
        <Input
          autoFocus
          disabled={!canSubmit}
          placeholder={leafType === "integer" ? "42" : op === "_in" ? "a, b, c" : "value…"}
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); if (e.key === "Escape") onClose(); }}
        />
      )}
      <div className="flex justify-end gap-1.5 pt-1">
        <Button variant="ghost" size="sm" onClick={onClose}><Trans>Cancel</Trans></Button>
        <Button variant="primary" size="sm" onClick={submit} disabled={!canSubmit}><Trans>Add filter</Trans></Button>
      </div>
    </div>
  );
}

export interface FilterBarProps {
  search: string;
  setSearch: (v: string) => void;
  filters: FilterCondition[];
  setFilters: (f: FilterCondition[]) => void;
  schema: CollectionSchema;
  status: string;
  setStatus: (v: string) => void;
  total: number;
}

export function FilterBar({ search, setSearch, filters, setFilters, schema, status, setStatus, total }: FilterBarProps) {
  const { t } = useLingui();
  const [popOpen, setPopOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (!wrapRef.current || wrapRef.current.contains(e.target as Node)) return;
      // Radix Select renders its options into a portal at the body root,
      // so clicking an option counts as "outside" the popover wrapper and
      // would close the filter before the user finishes building the
      // clause. Treat any click inside a Radix popper / listbox / dialog
      // as still-inside.
      const t = e.target as HTMLElement | null;
      if (t && (
        t.closest('[data-radix-popper-content-wrapper]') ||
        t.closest('[role="listbox"]') ||
        t.closest('[role="option"]') ||
        t.closest('[role="dialog"]')
      )) return;
      setPopOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  // Status tabs live on their own top row (design), above the search + filter
  // row. Rendered only for collections that declare a status field.
  const statusCfg = resolveStatusField(schema as any);
  // Annotated on the array, not the first element: with the `as` inline, the
  // mapped entries stayed `{id, label}` and `tb.count` was an error on that
  // arm of the union.
  const statusTabs: { id: string; label: string; count?: number }[] | null = statusCfg
    ? [
        { id: "all", label: "All", count: total },
        ...statusCfg.choices.map((c) => ({ id: c.value, label: c.label ?? c.value })),
      ]
    : null;

  return (
    <div className="flex flex-col gap-2">
      {/* Row 1: search + Filter on the left, status tabs pinned to the right. */}
      <div className="flex flex-wrap items-center gap-2">
        <InputGroup className="h-[34px] min-w-[220px] flex-1 basis-[360px] rounded-control border-white/10 bg-white/[0.03] sm:max-w-[420px]">
          <InputGroupAddon><I.Search size={14} /></InputGroupAddon>
          <InputGroupInput value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t`Search ${total} items by title or slug…`} />
          {search && (
            <InputGroupAddon align="inline-end">
              <InputGroupButton size="icon-xs" onClick={() => setSearch("")}><I.X size={13} /></InputGroupButton>
            </InputGroupAddon>
          )}
        </InputGroup>

        <div ref={wrapRef} className="relative">
          <Button variant="outline" size="sm" icon={I.Filter} className="h-[34px] rounded-control border-white/10 bg-white/[0.03]" onClick={() => setPopOpen((v) => !v)}>
            <Trans>Filter</Trans>
          </Button>
          {popOpen && <AddFilterPopover schema={schema} onAdd={(f) => setFilters([...filters, f])} onClose={() => setPopOpen(false)} />}
        </div>

        {statusTabs && (
          <Tabs value={status} onValueChange={(v) => setStatus(v)} className="ml-auto">
            <TabsList className={SEG_LIST_CLS}>
              {statusTabs.map((tb) => (
                <TabsTrigger key={tb.id} value={tb.id} className={SEG_TRIGGER_CLS}>
                  {tb.label}
                  {tb.count != null && <span className="rounded-sm bg-white/8 px-1.5 py-px font-mono text-[10px] tabular-nums text-current opacity-80">{tb.count}</span>}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        )}
      </div>

      {/* Row 2: active filter chips — a dedicated line so the tabs never jump. */}
      {filters.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {filters.map((f, i) => (
            <FilterChip
              key={i}
              field={f.field}
              op={f.op}
              value={f.value}
              onRemove={() => setFilters(filters.filter((_, j) => j !== i))}
            />
          ))}
          <Button variant="ghost" size="sm" onClick={() => setFilters([])}><Trans>Clear</Trans></Button>
        </div>
      )}
    </div>
  );
}

export function FilterDSLPreview({ filters, sort, fields }: { filters: FilterCondition[]; sort?: string; fields?: string[] }) {
  const dsl = useMemo(() => {
    const out: Record<string, unknown> = {};
    if (filters.length) {
      // Each chip becomes its own clause; `$and` combines them. The previous
      // `{ field: { ...prev, [op]: v } }` shape silently dropped duplicate
      // field+op pairs (two `body _contains` chips collapsed into one).
      const clauses = filters.map((c) => ({ [c.field]: { [c.op]: c.value } }));
      out.filter = clauses.length === 1 ? clauses[0] : { $and: clauses };
    }
    if (sort) out.sort = sort;
    if (fields && fields.length) out.fields = fields;
    return out;
  }, [filters, sort, fields]);
  if (!filters.length) return null;
  return (
    <div className="border-b border-border bg-[color-mix(in_oklch,var(--muted)_50%,transparent)] px-3.5 py-2.5 font-mono text-[11.5px] text-muted-foreground">
      <span className="text-foreground">GET</span>{" "}
      /api/items/posts?filter=
      <span className="text-foreground">{encodeURIComponent(JSON.stringify((dsl as { filter?: unknown }).filter))}</span>
    </div>
  );
}

export interface ItemsTableProps {
  rows: Post[];
  selected: Set<string>;
  setSelected: (s: Set<string>) => void;
  sort: string;
  setSort: (s: string) => void;
  onEdit: (it: Post) => void;
  onDelete?: (it: Post) => void;
  /** Pass the current collection schema to derive the status field config. */
  schema?: CollectionSchema;
  /** Surfaces inline-edit PATCH failures (the cache already rolled back). */
  onCellError?: (e: unknown) => void;
  /** Spreadsheet mode: clicks select cells (row click no longer opens the
   *  editor), keyboard navigates, copy/paste/fill-down write in bulk. */
  gridMode?: boolean;
  /** Grid result toasts ("3 cells skipped…", bulk failures). */
  onNotice?: (msg: string, kind?: "error") => void;
}

/** Drag-to-reorder context threaded into draggable column headers. */
interface HeaderDragCtx {
  dragCol: string | null;
  overCol: string | null;
  setDragCol: (v: string | null) => void;
  setOverCol: (v: string | null) => void;
  /** The saved column order — used to pick which side the drop indicator shows. */
  order: string[];
  move: (from: string, to: string) => void;
}

/** Sortable (and optionally drag-reorderable) column header. Deliberately a
 *  module-level component: defining it inline in ItemsTable gave it a new
 *  component identity every render, so the first drag state update remounted
 *  every <th> — which detaches the drag source mid-drag and kills the native
 *  drag operation. */
function SortHead({ id, label, num, sort, setSort, dragCtx, className }: {
  id: string;
  label: string;
  num?: boolean;
  sort: string;
  setSort: (s: string) => void;
  dragCtx?: HeaderDragCtx;
  className?: string;
}) {
  const dir: "asc" | "desc" = sort.startsWith("-") ? "desc" : "asc";
  const isActive = sort.replace("-", "") === id;
  const Arrow = !isActive ? I.ArrowUpDown : dir === "asc" ? I.ArrowUp : I.ArrowDown;
  const d = dragCtx;
  const isDragging = d ? d.dragCol === id : false;
  const isOver = d ? d.overCol === id && d.dragCol !== null && d.dragCol !== id : false;
  const overFromRight = d?.dragCol && isOver ? d.order.indexOf(d.dragCol) > d.order.indexOf(id) : false;
  return (
    <TableHead
      onClick={() => setSort(isActive ? (dir === "asc" ? "-" + id : id) : id)}
      className={`cursor-pointer select-none ${num ? "text-right" : "text-left"} ${className ?? ""}`}
      draggable={d ? true : undefined}
      // Inset shadow instead of a border so the drop indicator doesn't
      // shift the header row's layout while dragging.
      style={d ? {
        opacity: isDragging ? 0.4 : 1,
        boxShadow: isOver ? `inset ${overFromRight ? "2px" : "-2px"} 0 0 var(--primary)` : undefined,
        transition: "opacity 80ms",
      } : undefined}
      onDragStart={d ? (e) => {
        d.setDragCol(id);
        e.dataTransfer.effectAllowed = "move";
        // Required for Firefox to actually start the drag.
        e.dataTransfer.setData("text/plain", id);
      } : undefined}
      onDragOver={d ? (e) => {
        if (d.dragCol === null || d.dragCol === id) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (d.overCol !== id) d.setOverCol(id);
      } : undefined}
      onDragLeave={d ? () => {
        if (d.overCol === id) d.setOverCol(null);
      } : undefined}
      onDrop={d ? (e) => {
        e.preventDefault();
        if (d.dragCol !== null && d.dragCol !== id) d.move(d.dragCol, id);
        d.setDragCol(null);
        d.setOverCol(null);
      } : undefined}
      onDragEnd={d ? () => {
        d.setDragCol(null);
        d.setOverCol(null);
      } : undefined}
    >
      <span className={`inline-flex items-center gap-1.5 ${isActive ? "text-foreground" : ""}`}>
        {label}
        <Arrow size={11} stroke={2.2} />
      </span>
    </TableHead>
  );
}

/** How a commit happened — the grid steps focus down on Enter and right on
 *  Tab, and stays put on blur / dropdown change. */
export type CommitVia = "enter" | "tab" | "blur" | "change";

/** Inline cell editor — Atlassian inline-edit semantics: Enter or blur
 *  commits, Esc cancels. Dropdowns and booleans commit on change directly.
 *  `seed` replaces the initial text (grid type-to-edit starts from the typed
 *  character, like a spreadsheet). */
function CellEditor({ field, value, choices, seed, onCommit, onCancel }: {
  field: { name: string; type?: string };
  value: unknown;
  choices?: StatusChoice[];
  seed?: string;
  onCommit: (v: unknown, via: CommitVia) => void;
  onCancel: () => void;
}) {
  const [raw, setRaw] = useState(seed ?? (value == null ? "" : String(value)));
  // Guards the Esc→blur double-fire: cancelling unmounts the input, whose
  // blur would otherwise commit the value straight back.
  const done = useRef(false);
  const doneRef = useRef<(fn: () => void) => void>(() => {});
  const finish = (fn: () => void) => {
    if (done.current) return;
    done.current = true;
    fn();
  };
  doneRef.current = finish;
  // Clicking outside the editor closes it: Select/boolean editors dismiss
  // (they have no blur of their own), the text input COMMITS what was typed —
  // in grid mode the next cell's mousedown calls preventDefault (so no blur
  // ever fires) and users expect click-away to keep their edit, not eat it.
  // The root ref wraps EVERY branch (a bare input used to cancel itself when
  // clicked, because the pointerdown listener couldn't tell it was inside).
  // Radix portals the Select listbox to <body>, so clicks inside it count as
  // inside the editor.
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const outsideActRef = useRef<() => void>(() => {});
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      if (rootRef.current?.contains(t)) return;
      if (t.closest('[data-slot="select-content"]')) return;
      doneRef.current(() => outsideActRef.current());
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, []);

  const isNum = field.type === "integer" || field.type === "number";
  const commitText = (via: CommitVia) => {
    if (isNum) {
      const trimmed = raw.trim();
      if (trimmed === "") return onCommit(null, via);
      const n = Number(trimmed);
      if (!Number.isFinite(n)) return onCancel();
      return onCommit(field.type === "integer" ? Math.trunc(n) : n, via);
    }
    onCommit(raw, via);
  };
  const isTextEditor = !choices?.length && field.type !== "boolean";
  outsideActRef.current = isTextEditor ? () => commitText("blur") : () => onCancel();

  if (choices?.length) {
    return (
      <span
        ref={rootRef}
        className="contents"
        onKeyDown={(e) => {
          if (e.key === "Escape") finish(onCancel);
        }}
      >
        <Select
          value={value == null ? undefined : String(value)}
          onChange={(v) => finish(() => onCommit(v, "change"))}
          options={choices.map((c) => ({ value: c.value, label: c.label ?? c.value }))}
          size="sm"
          className="min-w-[110px]"
        />
      </span>
    );
  }
  if (field.type === "boolean") {
    const on = value === true || value === 1 || value === "1" || value === "true";
    return (
      <span
        ref={rootRef}
        className="inline-flex items-center py-1"
        onKeyDown={(e) => {
          if (e.key === "Escape") finish(onCancel);
        }}
      >
        <Checkbox checked={on} onChange={() => finish(() => onCommit(!on, "change"))} />
      </span>
    );
  }
  return (
    <span ref={rootRef} className="contents">
      <Input
        autoFocus
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        // Seeded (type-to-edit) editors keep the caret after the typed char;
        // plain open selects the whole current value for overwrite.
        onFocus={seed === undefined ? (e) => e.currentTarget.select() : undefined}
        inputMode={isNum ? "decimal" : undefined}
        className={`h-7 min-w-[110px] px-2 text-[13px] ${isNum ? "text-right" : ""}`}
        onKeyDown={(e) => {
          if (e.key === "Enter") finish(() => commitText("enter"));
          else if (e.key === "Tab") { e.preventDefault(); finish(() => commitText("tab")); }
          else if (e.key === "Escape") finish(onCancel);
        }}
        onBlur={() => finish(() => commitText("blur"))}
      />
    </span>
  );
}

/** Table cell with hover-pencil inline editing. Jira-style disambiguation:
 *  clicking the row still opens the detail editor; the pencil (kept primary-
 *  tinted — greyed-out pencils get overlooked) or a double-click edits the
 *  single cell in place. Hover-only affordance, so touch devices keep the
 *  row-tap → detail-editor flow. */
/** Selection visuals + mouse handlers the grid layer attaches to a cell. */
export interface GridCellProps {
  style?: React.CSSProperties;
  onMouseDown?: React.MouseEventHandler;
  onMouseEnter?: React.MouseEventHandler;
  "data-grid-selected"?: string;
  "data-grid-focused"?: string;
}

function EditCell({ editable, editing, num, className, field, value, choices, seed, display, grid, onStart, onCommit, onCancel }: {
  editable: boolean;
  editing: boolean;
  num?: boolean;
  className?: string;
  field: { name: string; type?: string };
  value: unknown;
  choices?: StatusChoice[];
  seed?: string;
  display: React.ReactNode;
  /** Grid-mode selection props; never applied while the editor is open (a
   *  preventDefault-ing mousedown would steal focus from the input). */
  grid?: GridCellProps;
  onStart: () => void;
  onCommit: (v: unknown, via: CommitVia) => void;
  onCancel: () => void;
}) {
  const { t } = useLingui();
  return (
    <TableCell
      className={`group/cell ${num ? "text-right tabular-nums" : ""} ${className ?? ""}`}
      {...(editing ? { style: grid?.style } : grid ?? {})}
      onDoubleClick={editable && !editing ? (e) => {
        e.stopPropagation();
        onStart();
      } : undefined}
      onClick={editing ? (e) => e.stopPropagation() : undefined}
    >
      {editing ? (
        <CellEditor field={field} value={value} choices={choices} seed={seed} onCommit={onCommit} onCancel={onCancel} />
      ) : (
        <span className={`flex max-w-full items-center gap-1 ${num ? "justify-end" : ""}`}>
          <span className="min-w-0 truncate">{display}</span>
          {editable && (
            <button
              type="button"
              title={t`Edit`}
              className="shrink-0 cursor-pointer rounded-sm p-0.5 text-primary opacity-0 transition-opacity hover:bg-accent focus-visible:opacity-100 group-hover/cell:opacity-100"
              onClick={(e) => {
                e.stopPropagation();
                onStart();
              }}
            >
              <I.Pencil size={12} />
            </button>
          )}
        </span>
      )}
    </TableCell>
  );
}

/** Field types the in-place editor can handle; everything else (relation,
 *  json, localized, uuid, timestamp…) goes through the full detail editor. */
const INLINE_TYPES = new Set(["text", "longtext", "integer", "number", "boolean"]);

/** Dropdown-interface fields carry their choices in options — those edit via
 *  a Select regardless of storage type. */
function fieldChoices(f: { interface?: string; options?: { choices?: StatusChoice[]; values?: string[] } }): StatusChoice[] | undefined {
  if (f.interface !== "dropdown") return undefined;
  const choices = f.options?.choices?.length
    ? f.options.choices
    : (f.options?.values ?? []).map((v) => ({ value: v }));
  return choices.length ? choices : undefined;
}

/** Row presence — who is on this record right now, straight from the
 *  collection-wide collab channel. Quiet by default: rows with nobody render
 *  nothing. A peer holding a field (actively editing) gets an amber ring;
 *  a single viewer also gets their handle spelled out (desktop only). */
function RowPresence({ peers }: { peers: CollabPeer[] }) {
  const { t } = useLingui();
  const editing = peers.some((p) => p.field);
  return (
    <span
      className="inline-flex items-center"
      title={peers.map((p) => (p.field ? t`${collabHandle(p)} is editing` : collabHandle(p))).join(", ")}
    >
      {peers.slice(0, 3).map((p, i) => (
        <span
          key={p.id}
          className={`flex size-5 items-center justify-center rounded-full border-2 border-card text-[9px] font-semibold text-white ${i > 0 ? "-ml-1.5" : ""} ${p.field ? "outline-2 outline-offset-1 outline-[oklch(0.72_0.15_65)]" : ""}`}
          style={{ background: p.color }}
        >
          {collabHandle(p).slice(0, 1).toUpperCase()}
        </span>
      ))}
      {peers.length > 3 && (
        <span className="ml-1 text-[10.5px] tabular-nums text-muted-foreground">+{peers.length - 3}</span>
      )}
      {peers.length === 1 && peers[0] && (
        <span className={`ml-1.5 max-w-[90px] truncate text-[11px] max-sm:hidden ${editing ? "text-[oklch(0.72_0.15_65)]" : "text-muted-foreground"}`}>
          {collabHandle(peers[0])}
        </span>
      )}
    </span>
  );
}

export function ItemsTable({ rows, selected, setSelected, sort, setSort, onEdit, schema, onCellError, gridMode, onNotice }: ItemsTableProps) {
  const { t } = useLingui();
  // Workspace default content language — `localized` cells collapse to it
  // (then English) instead of always showing English.
  const settings = useSettings();
  const defaultLocale =
    ((settings.data?.data as Record<string, unknown> | undefined)?.i18nDefaultLocale as
      | string
      | undefined) || undefined;
  // Subscribe so the table re-renders when authors-cache populates.
  useSyncExternalStore(subscribeAuthors, getAuthors, getAuthors);
  // Live row presence — one collection-wide subscription; `active` is false
  // on deployments without a collab transport, hiding the column entirely.
  const { byItem: collabByItem, active: collabActive } = useListCollab(schema?.slug ?? null);
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const someSelected = rows.some((r) => selected.has(r.id)) && !allSelected;

  const toggleAll = () => {
    const next = new Set(selected);
    if (allSelected) rows.forEach((r) => next.delete(r.id));
    else rows.forEach((r) => next.add(r.id));
    setSelected(next);
  };
  const toggleRow = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  // Detect which optional columns are actually present on the rows. Real
  // c_<slug> tables won't have author/word_count/view_count unless the user
  // defined them. Status is now schema-driven — only shown when the
  // collection declares a dropdown field (typically named "status").
  const statusField = resolveStatusField(schema as any);
  const choiceByValue = new Map(
    statusField?.choices.map((c) => [c.value, c]) ?? [],
  );
  const has = {
    author: rows.some((r) => r.author != null),
    words: rows.some((r) => r.word_count != null),
    views: rows.some((r) => r.view_count != null),
    status: !!statusField,
  };

  // Identity (leading, sticky) column. NOT a schema field: it renders the
  // collection's display template when one is set, else the first title-ish
  // field. Collections with neither get no synthetic column at all — the
  // table then shows exactly the picked fields (with the first one pinned),
  // instead of pretending a raw UUID is a "Title".
  const identity = useMemo(() => {
    const fields = (schema?.fields ?? []) as Array<{ name: string; system?: boolean; label?: string; translations?: Record<string, string> }>;
    const tmpl = schema?.displayTemplate?.trim();
    if (tmpl) {
      const label = schema?.singular?.trim() || schema?.slug || "";
      return { label, sortId: null as string | null, template: tmpl };
    }
    const f = fields.find((x) => (x.name === "title" || x.name === "name") && !x.system);
    if (f) return { label: fieldLabel(f, i18n.locale), sortId: f.name, template: null as string | null };
    return null;
  }, [schema]);
  // The `/slug` sub-line only when the collection really has a slug field —
  // falling back to the id just repeated the UUID twice. The row is read as
  // `r.slug`, so this stays keyed on the column NAME; what it additionally
  // requires now is that the column actually be a slug, since a `text` field
  // somebody happened to call "slug" is not a URL.
  const hasSlugField = (schema?.fields ?? []).some(
    (f) =>
      (f as { name?: string }).name === "slug" &&
      ((f as { slug?: unknown }).slug !== undefined ||
        (f as { interface?: string }).interface === "slug"),
  );

  // Configurable columns: when the user (or the workspace default) has saved a
  // column list for this collection, render those user fields (formatted per
  // their `format`) instead of the curated author/words/views set. Empty =
  // keep the curated default — unless the collection has no identity column,
  // where the first few fields make a far better default than a UUID.
  const { columns: colNames, setColumns } = useListColumns(schema?.slug ?? "");
  const autoCols = useMemo(() => {
    if (identity || colNames.length) return [];
    return (schema?.fields ?? [])
      .filter((f) => !(f as { system?: boolean }).system)
      .slice(0, 3)
      .map((f) => (f as { name: string }).name);
  }, [schema, identity, colNames.length]);
  const baseCols = colNames.length ? colNames : autoCols;
  // Drag state for reordering saved columns by dragging the table headers.
  // Tracked by field name (not index) so stale names in the saved list —
  // e.g. a since-dropped field — can't skew the splice positions.
  const [dragCol, setDragCol] = useState<string | null>(null);
  const [overCol, setOverCol] = useState<string | null>(null);
  // Works off baseCols (copy-on-write): reordering the auto-default columns
  // persists them as the user's saved list.
  const moveColumn = (from: string, to: string) => {
    const fromIdx = baseCols.indexOf(from);
    const toIdx = baseCols.indexOf(to);
    if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return;
    const next = [...baseCols];
    const moved = next.splice(fromIdx, 1)[0];
    if (moved === undefined) return;
    next.splice(toIdx, 0, moved);
    setColumns(next);
  };
  const dragCtx: HeaderDragCtx = { dragCol, overCol, setDragCol, setOverCol, order: baseCols, move: moveColumn };

  // Inline cell editing — one cell at a time; optimistic PATCH through the
  // shared items cache (rollback + onCellError toast on failure). `seed`
  // carries the grid's type-to-edit character into the editor.
  const [editCell, setEditCell] = useState<{ id: string; field: string; seed?: string } | null>(null);
  const patchItem = useItemPatch(schema?.slug ?? null);
  const isEditing = (rowId: string, name: string) => editCell?.id === rowId && editCell.field === name;

  // --- drag-to-reorder ---------------------------------------------------
  // Offered only when the list is actually IN the order being dragged: the
  // column exists, the table is sorted by it ascending, and we are not in grid
  // mode (there a drag selects a cell range). Dragging a list sorted by
  // `updated_at` would be a gesture with no meaning — the row would appear to
  // move and then jump back on the next render, which reads as a broken save.
  const orderField = (schema?.fields ?? []).find(
    (f) => !!(f as { order?: unknown }).order,
  ) as { name: string } | undefined;
  // An EMPTY `sort` does not mean unsorted — it means "let the server apply the
  // collection's `defaultSort`", which for twenty-five of the templates that
  // carry a position column is that very column. Comparing only the explicit
  // sort would leave dragging switched off in exactly the collections built to
  // be dragged, and the operator would have to first sort by a column the list
  // does not even show. Only the FIRST clause counts, and only ascending: a
  // `-position` list is upside down and dropping into it would move the row the
  // other way.
  const effectiveSort = sort || (schema?.defaultSort ?? "").split(",")[0]?.trim() || "";
  const canReorder = !!orderField && !gridMode && effectiveSort === orderField.name;
  const reorderItem = useItemReorder(schema?.slug ?? null);
  const [dragRow, setDragRow] = useState<string | null>(null);
  const [overRow, setOverRow] = useState<string | null>(null);
  // A SCOPED order field numbers each parent's rows separately, but this list
  // shows every parent's rows together — so dropping a lesson from one module
  // between two lessons of another is not just possible, it is the easy
  // mistake. The server refuses it (a move between lists is a change to the
  // scope column, not a reorder), and without this guard the only thing the
  // operator would see is their drag snapping back. Refused here instead: no
  // drop indicator, no "not-allowed" ambiguity, and no request.
  const orderScope = (schema?.fields ?? []).find(
    (f) => (f as { name?: string }).name === orderField?.name,
  ) as { order?: { scope?: string } } | undefined;
  const scopeCol = orderScope?.order?.scope;
  const scopeOf = (id: string): string => {
    if (!scopeCol) return "";
    const row = rows.find((r) => r.id === id) as Record<string, unknown> | undefined;
    const v = row?.[scopeCol];
    // `null` and `""` are the same list — the same two spellings of "no parent"
    // the server's scope filter has to reconcile.
    return v === null || v === undefined || v === "" ? "" : String(v);
  };
  const sameList = (a: string, b: string) => !scopeCol || scopeOf(a) === scopeOf(b);
  const clearRowDrag = () => {
    setDragRow(null);
    setOverRow(null);
  };
  const dropOnRow = (targetId: string) => {
    if (!canReorder || !orderField || !dragRow || dragRow === targetId) return clearRowDrag();
    if (!sameList(dragRow, targetId)) return clearRowDrag();
    const from = rows.findIndex((r) => r.id === dragRow);
    const to = rows.findIndex((r) => r.id === targetId);
    clearRowDrag();
    if (from < 0 || to < 0) return;
    // Dropping ONTO a row means taking its place: coming from above you land
    // after it, coming from below you land before it. Anything else moves the
    // row one slot short of where the operator aimed.
    reorderItem.mutate(
      { field: orderField.name, id: dragRow, anchorId: targetId, place: from < to ? "after" : "before" },
      { onError: (e) => onCellError?.(e) },
    );
  };

  // Sticky columns: checkbox + Title pin left (desktop only — on a phone the
  // title column would swallow most of the viewport), actions stay pinned
  // right. Sticky cells need an opaque background plus row-state variants,
  // since the row's own hover/selected tint can't show through them.
  // transition-colors matches the row's own hover fade (TableRow has it),
  // otherwise the pinned cells snap to the hover tint a beat before the rest
  // of the row finishes fading in.
  const STICKY_BG = "bg-card transition-colors group-hover/row:bg-[color-mix(in_oklab,var(--muted)_50%,var(--card))] group-data-[selected=true]/row:bg-selected-surface";
  const STICKY_BOX = "sm:sticky sm:z-[1] " + STICKY_BG;
  // Resolve column names to field descriptors. Dot-notation names
  // (`author.first_name`) synthesize one from the relation's target field —
  // the value comes from the server-side `expand` of the head (app.tsx wires
  // `expand=` into the list request from the same saved columns).
  const { data: colsData } = useCollections();
  const allCollections = colsData?.data;
  const dynFields = baseCols
    .map((n) => {
      const direct = (schema?.fields ?? []).find((f) => (f as { name?: string }).name === n);
      if (direct) return direct;
      if (!n.includes(".")) return null;
      const [head, sub] = n.split(".");
      const rel = (schema?.fields ?? []).find(
        (f) => (f as { name?: string; type?: string }).name === head && (f as { type?: string }).type === "relation",
      ) as { name: string; to?: string; label?: string; translations?: Record<string, string> } | undefined;
      if (!rel?.to) return null;
      const target = allCollections?.find((c) => c.slug === rel.to);
      const tf = (target?.fields ?? []).find((f) => (f as { name?: string }).name === sub);
      if (!tf) return null;
      return {
        ...(tf as { type: string }),
        name: n,
        dot: { head, sub },
        dotLabel: `${fieldLabel(rel, i18n.locale)} › ${fieldLabel(tf, i18n.locale)}`,
      };
    })
    .filter(Boolean) as Array<{
      name: string;
      label?: string;
      // Required, not optional: both branches produce a real schema field, and
      // the value formatter needs a `type` to decide how to render a cell.
      // Declared optional, every column fell short of `FormattableField`.
      type: string;
      to?: string;
      interface?: string;
      translations?: Record<string, string>;
      dot?: { head: string; sub: string };
      dotLabel?: string;
    }>;
  const useDynamic = dynFields.length > 0;
  const isNumF = (ty?: string) => ty === "integer" || ty === "number";

  // --- spreadsheet grid layer -------------------------------------------
  // Ordered column model mirroring the rendered data cells exactly (identity,
  // then the dynamic/curated set, then Updated). Read-only columns stay
  // selectable/copyable; writes skip them. Recomputed per render on purpose —
  // it tracks dynFields, which is itself derived fresh each render.
  const gridCols: GridColumn[] = [];
  if (identity) {
    gridCols.push({
      name: "__identity",
      editable: false,
      raw: (r) =>
        identity.template
          ? renderTemplate(identity.template, r).trim()
          : ((r as Record<string, unknown>)[identity.sortId!] ?? null),
    });
  }
  if (useDynamic) {
    for (const f of dynFields) {
      const choices = statusField && f.name === statusField.name ? statusField.choices : fieldChoices(f);
      gridCols.push({
        name: f.name,
        type: f.type,
        // Rollups and sequences (like computed columns) take no write — an
        // editable cell would collect a value the API answers 422 to. An order
        // column does take a write, and that is exactly why it must not be one
        // here: typing 3 into a cell puts the row on a position another row
        // already holds, which is the tie the whole feature exists to prevent.
        // The drag handle is how this column changes.
        editable:
          !f.dot &&
          !(f as { rollup?: unknown }).rollup &&
          !(f as { sequence?: unknown }).sequence &&
          !(f as { order?: unknown }).order &&
          (!!choices || INLINE_TYPES.has(f.type ?? "")),
        choices,
        raw: (r) =>
          f.dot
            ? ((r[f.dot.head] as Record<string, unknown> | null | undefined)?.[f.dot.sub] ?? null)
            : (r[f.name] ?? null),
      });
    }
  } else {
    if (has.status) gridCols.push({ name: statusField!.name, type: "text", editable: true, choices: statusField!.choices, raw: (r) => r[statusField!.name] ?? null });
    if (has.author) gridCols.push({ name: "author", editable: false, raw: (r) => r.author ?? null });
    if (has.words) gridCols.push({ name: "word_count", type: "integer", editable: true, raw: (r) => r.word_count ?? null });
    if (has.views) gridCols.push({ name: "view_count", type: "integer", editable: true, raw: (r) => r.view_count ?? null });
  }
  gridCols.push({ name: "updated_at", editable: false, raw: (r) => r.updated_at ?? r.updatedAt ?? null });
  const colIdx = new Map(gridCols.map((c, i) => [c.name, i]));

  const gridWrite = useItemsGridWrite(schema?.slug ?? null);
  const grid = useGridEdit({
    enabled: !!gridMode,
    rows: rows as unknown as Array<Record<string, unknown>>,
    cols: gridCols,
    editing: !!editCell,
    onStartEdit: (r, c, seed) => {
      const row = rows[r];
      const col = gridCols[c];
      if (!row || !col) return;
      setEditCell({ id: row.id, field: col.name, seed });
    },
    onWrite: (changes) => gridWrite.mutateAsync({ changes }),
    onNotice: (msg, kind) => {
      if (kind === "error" && onCellError) onCellError(new Error(msg));
      else onNotice?.(msg, kind);
    },
  });
  /** Per-cell grid props by (row index, column name) — no-op when off. */
  const gp = (ri: number, name: string): GridCellProps | undefined => {
    if (!gridMode) return undefined;
    const c = colIdx.get(name);
    return c === undefined ? undefined : grid.cellProps(ri, c);
  };

  const commitCell = (rowId: string, name: string, prev: unknown, next: unknown, via: CommitVia) => {
    setEditCell(null);
    if (gridMode) grid.afterEdit(via === "enter" ? "down" : via === "tab" ? "right" : null);
    const same = prev === next || (prev == null && (next == null || next === "")) || String(prev ?? "") === String(next ?? "");
    if (same) return;
    patchItem.mutate(
      { id: rowId, patch: { [name]: next } },
      { onError: (e) => onCellError?.(e) },
    );
  };
  const cancelCell = () => {
    setEditCell(null);
    if (gridMode) grid.afterEdit(null);
  };

  // Relation columns render the target row's display-template label instead
  // of the raw FK id (one `_in` fetch per relation column per page).
  const relLabels = useRelationLabels(
    dynFields.filter((f) => f.type === "relation" && f.to && !f.dot),
    rows as Array<Record<string, unknown>>,
  );
  // `interface: "user"` columns render the end-user's email (+ name) instead
  // of the raw app_users id (one batched `?ids=` fetch per page).
  const appUserLabels = useAppUserLabels(
    dynFields.filter((f) => !f.dot && f.interface === "user").map((f) => f.name),
    rows as Array<Record<string, unknown>>,
  );
  // Sticky classes for the identity slot (title column, or the first data
  // column when the collection has no identity).
  const IDENTITY_TH = "bg-card sm:sticky sm:left-[37px] sm:z-[2]";

  return (
    // Grid mode focus target — keyboard nav + native copy/paste land here.
    <div
      ref={grid.containerRef}
      tabIndex={gridMode ? 0 : undefined}
      onKeyDown={grid.onKeyDown}
      onCopy={grid.onCopy}
      onPaste={grid.onPaste}
      className="outline-none"
    >
    <Table className={ADMIN_TABLE_CLS}>
      <TableHeader>
        <TableRow className="bg-white/[0.02] hover:bg-white/[0.02]">
          {/* The checkbox column needs min-w, not just w — with many columns
              the auto table layout compresses it below 38px, opening a seam
              between it and the Title cell pinned at a fixed offset (scrolled
              content showed through). Title pins 1px early so the two sticky
              cells always overlap instead of under-lapping. */}
          <TableHead className="w-[38px] min-w-[38px] bg-card sm:sticky sm:left-0 sm:z-[2]">
            <Checkbox checked={allSelected} indeterminate={someSelected} onChange={toggleAll} />
          </TableHead>
          {identity && (identity.sortId ? (
            <SortHead id={identity.sortId} label={identity.label} sort={sort} setSort={setSort} className={IDENTITY_TH} />
          ) : (
            // Display-template identity — computed per row, so not sortable.
            <TableHead className={IDENTITY_TH}>{identity.label}</TableHead>
          ))}
          {useDynamic ? (
            dynFields.map((f, idx) => (
              <SortHead
                key={f.name}
                id={f.name}
                label={f.dotLabel ?? fieldLabel(f, i18n.locale)}
                num={isNumF(f.type)}
                sort={sort}
                setSort={setSort}
                dragCtx={dragCtx}
                className={!identity && idx === 0 ? IDENTITY_TH : undefined}
              />
            ))
          ) : (
            <>
              {has.status && <SortHead id={statusField!.name} label={t`Status`} sort={sort} setSort={setSort} />}
              {has.author && <TableHead className="w-[110px]"><Trans>Author</Trans></TableHead>}
              {has.words && <SortHead id="word_count" label={t`Words`} num sort={sort} setSort={setSort} />}
              {has.views && <SortHead id="view_count" label={t`Views`} num sort={sort} setSort={setSort} />}
            </>
          )}
          <SortHead id="updated_at" label={t`Updated`} sort={sort} setSort={setSort} />
          {collabActive && <TableHead className="w-[110px] text-right"><Trans>Live</Trans></TableHead>}
          {/* Room for the drag grip next to the edit button when the list is
              rearrangeable. Pinned right, so the width never disturbs the
              left-hand sticky offsets — and only from `sm:`, since the grip
              itself is desktop-only (see below) and reserving width for an
              affordance that never appears just narrows a phone's title column. */}
          <TableHead className={`sticky right-0 w-[60px] bg-card text-right ${canReorder ? "sm:w-[84px]" : ""}`} />
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r, ri) => {
          const a = authorById(r.author);
          // Identity cell text: the display template (e.g. `{{ city }}`) when
          // set — matching what the Settings tab promises — else the resolved
          // title-ish field. No identity ⇒ no cell (the first picked column
          // is the row's anchor instead).
          // Keep the raw value (don't `String()` it) so `cellText` below can
          // collapse a `localized` field's `{locale: value}` map to one language
          // instead of rendering "[object Object]".
          const displayTitle = identity
            ? identity.template
              ? renderTemplate(identity.template, r).trim() || (r.title ?? r.name ?? r.slug ?? r.id ?? "—")
              : ((r as Record<string, unknown>)[identity.sortId!] ?? "—")
            : "";
          const displaySlug = hasSlugField ? (r.slug ?? "") : "";
          const rawStatus = statusField ? (r as Record<string, unknown>)[statusField.name] : null;
          const displayStatus = rawStatus != null ? String(rawStatus) : null;
          const choice = displayStatus ? choiceByValue.get(displayStatus) : null;
          return (
            <TableRow
              key={r.id}
              data-selected={selected.has(r.id)}
              onClick={gridMode ? undefined : () => onEdit(r)}
              className={`group/row data-[selected=true]:bg-selected-surface ${gridMode ? "" : "cursor-pointer"}`}
              draggable={canReorder || undefined}
              // A border would grow the row and shove the rest of the table
              // down mid-drag; an inset shadow marks the edge without moving
              // anything. Same trick the column headers use.
              style={
                canReorder
                  ? {
                      opacity: dragRow === r.id ? 0.4 : 1,
                      boxShadow:
                        overRow === r.id && dragRow && dragRow !== r.id
                          ? `inset 0 ${
                              rows.findIndex((x) => x.id === dragRow) < ri ? "-2px" : "2px"
                            } 0 var(--primary)`
                          : undefined,
                      transition: "opacity 80ms",
                    }
                  : undefined
              }
              onDragStart={
                canReorder
                  ? (e) => {
                      setDragRow(r.id);
                      e.dataTransfer.effectAllowed = "move";
                      // Firefox refuses to start a drag without payload.
                      e.dataTransfer.setData("text/plain", r.id);
                    }
                  : undefined
              }
              onDragOver={
                canReorder
                  ? (e) => {
                      // Not calling preventDefault is what makes this row an
                      // invalid drop target — the cursor says so, and the drop
                      // never fires.
                      if (!dragRow || dragRow === r.id || !sameList(dragRow, r.id)) return;
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "move";
                      if (overRow !== r.id) setOverRow(r.id);
                    }
                  : undefined
              }
              onDragLeave={canReorder ? () => setOverRow((o) => (o === r.id ? null : o)) : undefined}
              onDrop={
                canReorder
                  ? (e) => {
                      e.preventDefault();
                      dropOnRow(r.id);
                    }
                  : undefined
              }
              onDragEnd={canReorder ? clearRowDrag : undefined}
            >
              <TableCell onClick={(e) => e.stopPropagation()} className={`min-w-[38px] sm:left-0 ${STICKY_BOX}`}>
                <Checkbox checked={selected.has(r.id)} onChange={() => toggleRow(r.id)} />
              </TableCell>
              {identity && (
                <TableCell className={`sm:left-[37px] sm:max-w-[320px] ${STICKY_BOX}`} {...(gp(ri, "__identity") ?? {})}>
                  <div className="flex min-w-0 flex-col">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate font-medium text-foreground">{cellText(displayTitle, defaultLocale)}</span>
                      {!!(r as Record<string, unknown>)._staged && (
                        <span
                          className="shrink-0 rounded-full border border-border px-1.5 py-px text-[10px] leading-4 text-muted-foreground"
                          title={t`Has staged changes — publish to apply them`}
                        >
                          <Trans>Staged</Trans>
                        </span>
                      )}
                    </span>
                    {displaySlug && <span className="truncate font-mono text-[11px] text-muted-foreground">/{String(displaySlug).slice(0, 24)}</span>}
                  </div>
                </TableCell>
              )}
              {useDynamic ? (
                dynFields.map((f, idx) => {
                  // Preserve the status badge when the status field is a column;
                  // everything else renders through the display formatter.
                  // Dot columns read the sub-value off the server-expanded head.
                  const rawV = f.dot
                    ? ((r as Record<string, unknown>)[f.dot.head] as Record<string, unknown> | null | undefined)?.[f.dot.sub]
                    : (r as Record<string, unknown>)[f.name];
                  const anchorCls = !identity && idx === 0 ? `sm:left-[37px] ${STICKY_BOX}` : "";
                  if (statusField && f.name === statusField.name) {
                    const svStr = rawV != null ? String(rawV) : null;
                    const ch = svStr ? choiceByValue.get(svStr) : null;
                    return (
                      <EditCell
                        key={f.name}
                        editable
                        editing={isEditing(r.id, f.name)}
                        className={anchorCls}
                        field={f}
                        value={rawV}
                        choices={statusField.choices}
                        seed={editCell?.seed}
                        grid={gp(ri, f.name)}
                        display={svStr ? (
                          <StatusBadge value={svStr} label={ch?.label} color={ch?.color} />
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                        onStart={() => setEditCell({ id: r.id, field: f.name })}
                        onCommit={(v, via) => commitCell(r.id, f.name, rawV, v, via)}
                        onCancel={cancelCell}
                      />
                    );
                  }
                  // Relation columns: show the target row's resolved label
                  // (display template / title-ish scan) instead of the FK id.
                  // When the head is server-expanded the value is the nested
                  // row itself — its id keys the same label map.
                  const isRel = !f.dot && f.type === "relation";
                  // App-user link cells resolve the id to email (+ name) via
                  // the batched map — same lazy pattern as relation labels.
                  const isUser = !f.dot && f.interface === "user";
                  const fkId = isRel && rawV != null && typeof rawV === "object"
                    ? String((rawV as Record<string, unknown>).id ?? "")
                    : rawV;
                  const txt = isRel
                    ? fkId == null || fkId === ""
                      ? ""
                      : (relLabels[f.name]?.[String(fkId)] ?? shortId(fkId))
                    : isUser
                      ? rawV == null || rawV === ""
                        ? ""
                        : (appUserLabels[String(rawV)] ?? shortId(rawV))
                      : formatFieldValue(rawV, f, i18n.locale, undefined, defaultLocale);
                  const choices = fieldChoices(f);
                  return (
                    <EditCell
                      key={f.name}
                      editable={!f.dot && (!!choices || INLINE_TYPES.has(f.type ?? ""))}
                      editing={isEditing(r.id, f.name)}
                      num={isNumF(f.type)}
                      className={`${isNumF(f.type) ? "" : "max-w-[280px]"} ${anchorCls}`}
                      field={f}
                      value={rawV}
                      choices={choices}
                      seed={editCell?.seed}
                      grid={gp(ri, f.name)}
                      display={txt || <span className="text-muted-foreground">—</span>}
                      onStart={() => setEditCell({ id: r.id, field: f.name })}
                      onCommit={(v, via) => commitCell(r.id, f.name, rawV, v, via)}
                      onCancel={cancelCell}
                    />
                  );
                })
              ) : (
                <>
                  {has.status && (
                    <EditCell
                      editable
                      editing={isEditing(r.id, statusField!.name)}
                      field={{ name: statusField!.name, type: "text" }}
                      value={rawStatus}
                      choices={statusField!.choices}
                      seed={editCell?.seed}
                      grid={gp(ri, statusField!.name)}
                      display={displayStatus ? (
                        <StatusBadge value={displayStatus} label={choice?.label} color={choice?.color} />
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                      onStart={() => setEditCell({ id: r.id, field: statusField!.name })}
                      onCommit={(v, via) => commitCell(r.id, statusField!.name, rawStatus, v, via)}
                      onCancel={cancelCell}
                    />
                  )}
                  {has.author && (
                    <TableCell {...(gp(ri, "author") ?? {})}>
                      <div className="flex items-center gap-2">
                        <div className="grid size-[22px] place-items-center rounded-full bg-[linear-gradient(135deg,oklch(from_var(--primary)_0.78_0.18_h),oklch(from_var(--primary)_0.55_0.18_calc(h+15)))] text-[10px] font-semibold text-[oklch(from_var(--primary)_0.18_0.05_h)]">{a.initials}</div>
                        <span className="font-mono text-xs">{a.name}</span>
                      </div>
                    </TableCell>
                  )}
                  {has.words && (
                    <EditCell
                      editable
                      editing={isEditing(r.id, "word_count")}
                      num
                      field={{ name: "word_count", type: "integer" }}
                      value={r.word_count}
                      seed={editCell?.seed}
                      grid={gp(ri, "word_count")}
                      display={r.word_count ?? "—"}
                      onStart={() => setEditCell({ id: r.id, field: "word_count" })}
                      onCommit={(v, via) => commitCell(r.id, "word_count", r.word_count, v, via)}
                      onCancel={cancelCell}
                    />
                  )}
                  {has.views && (
                    <EditCell
                      editable
                      editing={isEditing(r.id, "view_count")}
                      num
                      className={r.view_count ? "text-foreground" : "text-muted-foreground"}
                      field={{ name: "view_count", type: "integer" }}
                      value={r.view_count}
                      seed={editCell?.seed}
                      grid={gp(ri, "view_count")}
                      display={r.view_count ? Number(r.view_count).toLocaleString() : "—"}
                      onStart={() => setEditCell({ id: r.id, field: "view_count" })}
                      onCommit={(v, via) => commitCell(r.id, "view_count", r.view_count, v, via)}
                      onCancel={cancelCell}
                    />
                  )}
                </>
              )}
              <TableCell className="font-mono tabular-nums text-muted-foreground" {...(gp(ri, "updated_at") ?? {})}>{fmtDate(r.updated_at ?? r.updatedAt)}</TableCell>
              {collabActive && (
                <TableCell className="text-right">
                  {collabByItem[String(r.id)]?.length ? (
                    <RowPresence peers={collabByItem[String(r.id)]!} />
                  ) : null}
                </TableCell>
              )}
              <TableCell className={`sticky right-0 text-right ${STICKY_BG}`} onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center justify-end gap-0.5">
                  {/* Affordance only — the whole ROW is the drag source, so the
                      grip needs no handlers of its own. It lives here rather
                      than beside the checkbox because that cell is pinned at a
                      fixed 38px and the identity column pins against it; one
                      extra icon there opens a seam between the two sticky
                      cells. This column is pinned to the RIGHT, so widening it
                      moves nothing. */}
                  {canReorder && (
                    <span
                      className="hidden cursor-grab text-muted-foreground opacity-0 transition-opacity group-hover/row:opacity-100 active:cursor-grabbing sm:inline"
                      title={t`Drag the row to reorder`}
                      aria-hidden
                    >
                      <I.Grip size={13} />
                    </span>
                  )}
                  <IconButton icon={I.Pencil} onClick={() => onEdit(r)} title={t`Edit`} />
                </div>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
    </div>
  );
}

export function BulkBar({ count, onClear, onEdit, onPublish, onDelete }: { count: number; onClear: () => void; onEdit: () => void; onPublish: () => void; onDelete: () => void }) {
  if (!count) return null;
  return (
    <div className="flex items-center gap-2.5 border-b border-[color-mix(in_oklch,var(--primary)_30%,var(--border))] bg-muted px-3.5 py-2">
      <span className="text-[12.5px] font-medium"><Trans>{count} selected</Trans></span>
      <div className="flex-1" />
      <Button variant="outline" size="sm" icon={I.Pencil} onClick={onEdit}><Trans>Edit</Trans></Button>
      <Button variant="outline" size="sm" icon={I.Check} onClick={onPublish}><Trans>Publish</Trans></Button>
      <Button variant="outline" size="sm" icon={I.Trash} onClick={onDelete}><Trans>Delete</Trans></Button>
      <Button variant="ghost" size="sm" onClick={onClear}><Trans>Clear</Trans></Button>
    </div>
  );
}
