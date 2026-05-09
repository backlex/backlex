// @ts-nocheck
// Filter DSL builder + Items DataTable for the workeros admin design.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { I } from "./icons";
import { type CollectionSchema, type Post } from "./mock";
import { Badge, Button, Checkbox, IconButton } from "./ui";
import { Select } from "./select";
import { getAuthors, subscribeAuthors } from "./authors-cache";

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
  const valStr = Array.isArray(value) ? `[${(value as unknown[]).join(", ")}]` : op === "_null" ? (value ? "is null" : "is not null") : String(value);
  return (
    <span className="chip active" onClick={onClick}>
      <span className="key">{field}</span>
      <span className="op">{op}</span>
      <span className="val">{valStr}</span>
      <span className="x" onClick={(e) => { e.stopPropagation(); onRemove(); }}><I.X size={11} /></span>
    </span>
  );
}

function AddFilterPopover({ schema, onAdd, onClose }: { schema: CollectionSchema; onAdd: (f: FilterCondition) => void; onClose: () => void }) {
  const editable = schema.fields.filter((f) => !f.system || f.name === "created_at" || f.name === "updated_at");
  const [field, setField] = useState(editable[1]?.name || "title");
  const fieldDef = editable.find((f) => f.name === field) || editable[0];
  const ops = FIELD_OPS[fieldDef.type] || ["_eq"];
  const [op, setOp] = useState(ops[0]);
  const [val, setVal] = useState("");

  useEffect(() => { setOp(ops[0]); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [field]);

  const submit = () => {
    let parsed: unknown = val;
    if (op === "_null") parsed = true;
    else if (["_in", "_nin"].includes(op)) parsed = val.split(",").map((s) => s.trim()).filter(Boolean);
    else if (["integer", "number"].includes(fieldDef.type)) parsed = Number(val);
    onAdd({ field, op, value: parsed });
    onClose();
  };

  return (
    <div className="popover" style={{ top: 44, left: 0 }}>
      <div className="popover-row">
        <Select value={field} onChange={setField} options={editable.map((f) => ({ value: f.name, label: f.name, hint: f.type }))} className="" style={{ flex: 1 }} />
        <Select value={op} onChange={setOp} options={ops} style={{ flex: "0 0 110px" }} />
      </div>
      {op !== "_null" && (
        <input
          className="input"
          autoFocus
          placeholder={fieldDef.type === "integer" ? "42" : op === "_in" ? "a, b, c" : "value…"}
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); if (e.key === "Escape") onClose(); }}
        />
      )}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 6, paddingTop: 4 }}>
        <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
        <Button variant="primary" size="sm" onClick={submit}>Add filter</Button>
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
  const [popOpen, setPopOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setPopOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  return (
    <div className="filter-bar">
      <div className="search-input">
        <I.Search size={14} />
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={`Search ${total} items by title or slug…`} />
        {search && <span className="x" onClick={() => setSearch("")}><I.X size={13} /></span>}
      </div>

      <div className="tabs">
        {[{ id: "all", label: "All", count: total }, { id: "published", label: "Published" }, { id: "review", label: "In review" }, { id: "draft", label: "Drafts" }].map((t) => (
          <button key={t.id} className="tab" data-active={status === t.id} onClick={() => setStatus(t.id)}>
            {t.label}
            {t.count != null && <span className="count">{t.count}</span>}
          </button>
        ))}
      </div>

      <div ref={wrapRef} style={{ position: "relative" }}>
        <Button variant="outline" size="sm" icon={I.Filter} onClick={() => setPopOpen((v) => !v)}>
          Filter
        </Button>
        {popOpen && <AddFilterPopover schema={schema} onAdd={(f) => setFilters([...filters, f])} onClose={() => setPopOpen(false)} />}
      </div>

      {filters.map((f, i) => (
        <FilterChip
          key={i}
          field={f.field}
          op={f.op}
          value={f.value}
          onRemove={() => setFilters(filters.filter((_, j) => j !== i))}
        />
      ))}
      {filters.length > 0 && (
        <Button variant="ghost" size="sm" onClick={() => setFilters([])}>Clear</Button>
      )}
    </div>
  );
}

export function FilterDSLPreview({ filters, sort, fields }: { filters: FilterCondition[]; sort?: string; fields?: string[] }) {
  const dsl = useMemo(() => {
    const out: Record<string, unknown> = {};
    if (filters.length) {
      const f: Record<string, Record<string, unknown>> = {};
      for (const c of filters) {
        f[c.field] = { ...(f[c.field] || {}), [c.op]: c.value };
      }
      out.filter = f;
    }
    if (sort) out.sort = sort;
    if (fields && fields.length) out.fields = fields;
    return out;
  }, [filters, sort, fields]);
  if (!filters.length) return null;
  return (
    <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--border)", fontFamily: "Geist Mono, monospace", fontSize: 11.5, color: "var(--muted-foreground)", background: "color-mix(in oklch, var(--muted) 50%, transparent)" }}>
      <span style={{ color: "var(--foreground)" }}>GET</span>{" "}
      /api/items/posts?filter=
      <span style={{ color: "var(--foreground)" }}>{encodeURIComponent(JSON.stringify((dsl as { filter?: unknown }).filter))}</span>
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
}

export function ItemsTable({ rows, selected, setSelected, sort, setSort, onEdit }: ItemsTableProps) {
  // Subscribe so the table re-renders when authors-cache populates.
  useSyncExternalStore(subscribeAuthors, getAuthors, getAuthors);
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

  const SortHead = ({ id, label, num }: { id: string; label: string; num?: boolean }) => {
    const dir: "asc" | "desc" = sort.startsWith("-") ? "desc" : "asc";
    const isActive = sort.replace("-", "") === id;
    const Arrow = !isActive ? I.ArrowUpDown : dir === "asc" ? I.ArrowUp : I.ArrowDown;
    return (
      <th
        onClick={() => setSort(isActive ? (dir === "asc" ? "-" + id : id) : id)}
        style={{ cursor: "pointer", userSelect: "none", textAlign: num ? "right" : "left" }}
      >
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: isActive ? "var(--foreground)" : "inherit" }}>
          {label}
          <Arrow size={11} stroke={2.2} />
        </span>
      </th>
    );
  };

  // Detect which optional columns are actually present on the rows. Real
  // c_<slug> tables won't have author/word_count/view_count unless the user
  // defined them. We always render Title + Status (synthesized from common
  // fields if absent) and Updated. Optional columns stay rendered so the
  // design layout is preserved, but show "—" when the field is missing.
  const has = {
    author: rows.some((r) => r.author != null),
    words: rows.some((r) => r.word_count != null),
    views: rows.some((r) => r.view_count != null),
  };

  return (
    <table className="table">
      <thead>
        <tr>
          <th style={{ width: 38 }}>
            <Checkbox checked={allSelected} indeterminate={someSelected} onChange={toggleAll} />
          </th>
          <SortHead id="title" label="Title" />
          <SortHead id="status" label="Status" />
          {has.author && <th style={{ width: 110 }}>Author</th>}
          {has.words && <SortHead id="word_count" label="Words" num />}
          {has.views && <SortHead id="view_count" label="Views" num />}
          <SortHead id="updated_at" label="Updated" />
          <th style={{ width: 60, textAlign: "right" }}></th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const a = authorById(r.author);
          // Fall back to slug/name/id for the display label so even
          // collections without a `title` column render readable rows.
          const displayTitle = r.title ?? r.name ?? r.slug ?? r.id ?? "—";
          const displaySlug = r.slug ?? r.id ?? "";
          const displayStatus = r.status ?? "draft";
          return (
            <tr key={r.id} data-selected={selected.has(r.id)} onClick={() => onEdit(r)}>
              <td onClick={(e) => e.stopPropagation()}>
                <Checkbox checked={selected.has(r.id)} onChange={() => toggleRow(r.id)} />
              </td>
              <td>
                <div style={{ display: "flex", flexDirection: "column" }}>
                  <span style={{ fontWeight: 500, color: "var(--foreground)" }}>{String(displayTitle)}</span>
                  {displaySlug && <span className="font-mono" style={{ fontSize: 11, color: "var(--muted-foreground)" }}>/{String(displaySlug).slice(0, 24)}</span>}
                </div>
              </td>
              <td>
                <Badge variant={statusVariant(displayStatus)}>
                  {displayStatus === "published" && <span style={{ width: 6, height: 6, borderRadius: 999, background: "currentColor", display: "inline-block", marginRight: 2 }} />}
                  {displayStatus}
                </Badge>
              </td>
              {has.author && (
                <td>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <div className="avatar" style={{ width: 22, height: 22, fontSize: 10 }}>{a.initials}</div>
                    <span className="font-mono" style={{ fontSize: 12 }}>{a.name}</span>
                  </div>
                </td>
              )}
              {has.words && (
                <td className="tabular-nums" style={{ textAlign: "right" }}>{r.word_count ?? "—"}</td>
              )}
              {has.views && (
                <td className="tabular-nums" style={{ textAlign: "right", color: r.view_count ? "var(--foreground)" : "var(--muted-foreground)" }}>{r.view_count ? Number(r.view_count).toLocaleString() : "—"}</td>
              )}
              <td style={{ color: "var(--muted-foreground)" }} className="font-mono tabular-nums">{fmtDate(r.updated_at ?? r.updatedAt)}</td>
              <td onClick={(e) => e.stopPropagation()} style={{ textAlign: "right" }}>
                <IconButton icon={I.Pencil} onClick={() => onEdit(r)} title="Edit" />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function BulkBar({ count, onClear, onPublish, onDelete }: { count: number; onClear: () => void; onPublish: () => void; onDelete: () => void }) {
  if (!count) return null;
  return (
    <div className="bulkbar">
      <span className="count">{count} selected</span>
      <div className="spacer" />
      <Button variant="outline" size="sm" icon={I.Check} onClick={onPublish}>Publish</Button>
      <Button variant="outline" size="sm" icon={I.Trash} onClick={onDelete}>Delete</Button>
      <Button variant="ghost" size="sm" onClick={onClear}>Clear</Button>
    </div>
  );
}
