// @ts-nocheck
// Filter DSL builder + Items DataTable for the workeros admin design.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { I } from "./icons";
import { type CollectionSchema, type Post } from "./config";
import { Badge, Button, Checkbox, IconButton } from "./ui";
import { Select } from "./select";
import { Input } from "@backlex/ui/components/input";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@backlex/ui/components/input-group";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@backlex/ui/components/table";
import { Tabs, TabsList, TabsTrigger } from "@backlex/ui/components/tabs";
import { getAuthors, subscribeAuthors } from "./authors-cache";

const ADMIN_TABLE_CLS =
  "[&_td]:px-3.5 [&_td]:text-[13px] [&_th]:h-9 [&_th]:px-3.5 [&_th]:text-[11px] [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-[0.06em] [&_th]:text-muted-foreground";

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
  // Prefer a field literally named "status" so existing presets light up;
  // fall back to any dropdown-interface field.
  const named = fields.find((f) => (f as { name?: string }).name === "status" && (f as { interface?: string }).interface === "dropdown");
  const fallback = !named ? fields.find((f) => (f as { interface?: string }).interface === "dropdown") : null;
  const f = (named ?? fallback) as
    | { name?: string; options?: { choices?: StatusChoice[]; values?: string[] } }
    | undefined;
  if (!f?.name) return null;
  const choices: StatusChoice[] = f.options?.choices?.length
    ? f.options.choices
    : (f.options?.values ?? []).map((v) => ({ value: v }));
  if (!choices.length) return null;
  return { name: f.name, choices };
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
  const { t } = useLingui();
  const valStr = Array.isArray(value) ? `[${(value as unknown[]).join(", ")}]` : op === "_null" ? (value ? t`is null` : t`is not null`) : String(value);
  return (
    <span className="inline-flex h-7 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-3xl border border-[color-mix(in_oklch,var(--foreground)_22%,var(--border))] bg-accent px-[11px] text-[12.5px] text-foreground" onClick={onClick}>
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
  const [field, setField] = useState(editable[1]?.name || "title");
  const fieldDef = editable.find((f) => f.name === field) || editable[0];
  const isRelation = fieldDef.type === "relation";
  const isRelationMany = fieldDef.type === "relation_many";

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
    if (!needsTargetDrill || !fieldDef.to) return;
    if (targetFieldsCache[fieldDef.to]) return;
    let cancelled = false;
    setTargetLoading(true);
    fetch(`/api/collections/${fieldDef.to}`, { credentials: "include" })
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        const f = (j?.data?.fields ?? []) as Array<{ name: string; type: string }>;
        setTargetFieldsCache((cache) => ({ ...cache, [fieldDef.to as string]: f }));
      })
      .catch(() => { /* leave cache empty; sub dropdown will say "Target unavailable" */ })
      .finally(() => { if (!cancelled) setTargetLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [field, needsTargetDrill, fieldDef.to]);

  // Leaf field — the one that actually drives op list + value parsing.
  // For nested filters that's the sub-field on the target collection.
  const targetFields = needsTargetDrill && fieldDef.to ? targetFieldsCache[fieldDef.to] : null;
  const subDef = nestedSub && targetFields ? targetFields.find((f) => f.name === nestedSub) : null;
  const leafType = subDef?.type ?? fieldDef.type;
  const ops = FIELD_OPS[leafType] || ["_eq"];
  const [op, setOp] = useState(ops[0]);
  const [val, setVal] = useState("");

  useEffect(() => { setOp(ops[0]); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [field, nestedSub]);

  const canSubmit = !needsTargetDrill || !!nestedSub;

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
    <div className="absolute left-0 top-11 z-50 flex w-[320px] max-w-[calc(100vw-16px)] flex-col gap-1.5 rounded-xl border border-border bg-popover p-2 shadow-[0_12px_30px_-8px_oklch(0_0_0/0.18),0_2px_8px_oklch(0_0_0/0.06)]">
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
              !fieldDef.to
                ? [{ value: "", label: t`Relation has no target` }]
                : targetLoading
                  ? [{ value: "", label: t`Fetching subfields…` }]
                  : targetFields
                    ? targetFields.map((f) => ({ value: f.name, label: f.name, hint: f.type }))
                    : [{ value: "", label: t`Target unavailable` }]
            }
            placeholder={fieldDef.to ? t`Pick a subfield…` : "—"}
            className="flex-1"
            disabled={!fieldDef.to || targetLoading || !targetFields}
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

  return (
    <div className="flex flex-wrap items-center gap-2">
      <InputGroup>
        <InputGroupAddon><I.Search size={14} /></InputGroupAddon>
        <InputGroupInput value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t`Search ${total} items by title or slug…`} />
        {search && (
          <InputGroupAddon align="inline-end">
            <InputGroupButton size="icon-xs" onClick={() => setSearch("")}><I.X size={13} /></InputGroupButton>
          </InputGroupAddon>
        )}
      </InputGroup>

      {(() => {
        const cfg = resolveStatusField(schema as any);
        // Skip the tabs row entirely when the collection has no status field
        // — Directus parity: don't surface status UI on schemas that don't
        // declare it.
        if (!cfg) return null;
        const tabs = [
          { id: "all", label: "All", count: total } as { id: string; label: string; count?: number },
          ...cfg.choices.map((c) => ({ id: c.value, label: c.label ?? c.value })),
        ];
        return (
          <Tabs value={status} onValueChange={(v) => setStatus(v)}>
            <TabsList>
              {tabs.map((t) => (
                <TabsTrigger key={t.id} value={t.id}>
                  {t.label}
                  {t.count != null && <span className="rounded-sm border border-border bg-muted px-[5px] py-px font-mono text-[11px] text-muted-foreground">{t.count}</span>}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        );
      })()}

      <div ref={wrapRef} className="relative">
        <Button variant="outline" size="sm" icon={I.Filter} onClick={() => setPopOpen((v) => !v)}>
          <Trans>Filter</Trans>
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
        <Button variant="ghost" size="sm" onClick={() => setFilters([])}><Trans>Clear</Trans></Button>
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
}

export function ItemsTable({ rows, selected, setSelected, sort, setSort, onEdit, schema }: ItemsTableProps) {
  const { t } = useLingui();
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
      <TableHead
        onClick={() => setSort(isActive ? (dir === "asc" ? "-" + id : id) : id)}
        className={`cursor-pointer select-none ${num ? "text-right" : "text-left"}`}
      >
        <span className={`inline-flex items-center gap-1.5 ${isActive ? "text-foreground" : ""}`}>
          {label}
          <Arrow size={11} stroke={2.2} />
        </span>
      </TableHead>
    );
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

  return (
    <Table className={ADMIN_TABLE_CLS}>
      <TableHeader>
        <TableRow>
          <TableHead className="w-[38px]">
            <Checkbox checked={allSelected} indeterminate={someSelected} onChange={toggleAll} />
          </TableHead>
          <SortHead id="title" label={t`Title`} />
          {has.status && <SortHead id={statusField!.name} label={t`Status`} />}
          {has.author && <TableHead className="w-[110px]"><Trans>Author</Trans></TableHead>}
          {has.words && <SortHead id="word_count" label={t`Words`} num />}
          {has.views && <SortHead id="view_count" label={t`Views`} num />}
          <SortHead id="updated_at" label={t`Updated`} />
          <TableHead className="sticky right-0 w-[60px] bg-card text-right" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => {
          const a = authorById(r.author);
          // Fall back to slug/name/id for the display label so even
          // collections without a `title` column render readable rows.
          const displayTitle = r.title ?? r.name ?? r.slug ?? r.id ?? "—";
          const displaySlug = r.slug ?? r.id ?? "";
          const rawStatus = statusField ? (r as Record<string, unknown>)[statusField.name] : null;
          const displayStatus = rawStatus != null ? String(rawStatus) : null;
          const choice = displayStatus ? choiceByValue.get(displayStatus) : null;
          return (
            <TableRow key={r.id} data-selected={selected.has(r.id)} onClick={() => onEdit(r)} className="cursor-pointer data-[selected=true]:bg-[color-mix(in_oklch,var(--primary)_10%,var(--card))]">
              <TableCell onClick={(e) => e.stopPropagation()}>
                <Checkbox checked={selected.has(r.id)} onChange={() => toggleRow(r.id)} />
              </TableCell>
              <TableCell>
                <div className="flex flex-col">
                  <span className="font-medium text-foreground">{String(displayTitle)}</span>
                  {displaySlug && <span className="font-mono text-[11px] text-muted-foreground">/{String(displaySlug).slice(0, 24)}</span>}
                </div>
              </TableCell>
              {has.status && (
                <TableCell>
                  {displayStatus ? (
                    <Badge variant={choice?.color ? "outline" : statusVariant(displayStatus)}>
                      {choice?.color && (
                        <span
                          className="mr-1 inline-block size-1.5 rounded-full"
                          style={{ background: choice.color }}
                        />
                      )}
                      {choice?.label ?? displayStatus}
                    </Badge>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
              )}
              {has.author && (
                <TableCell>
                  <div className="flex items-center gap-2">
                    <div className="grid size-[22px] place-items-center rounded-full bg-[linear-gradient(135deg,oklch(from_var(--primary)_0.78_0.18_h),oklch(from_var(--primary)_0.55_0.18_calc(h+15)))] text-[10px] font-semibold text-[oklch(from_var(--primary)_0.18_0.05_h)]">{a.initials}</div>
                    <span className="font-mono text-xs">{a.name}</span>
                  </div>
                </TableCell>
              )}
              {has.words && (
                <TableCell className="text-right tabular-nums">{r.word_count ?? "—"}</TableCell>
              )}
              {has.views && (
                <TableCell className={`text-right tabular-nums ${r.view_count ? "text-foreground" : "text-muted-foreground"}`}>{r.view_count ? Number(r.view_count).toLocaleString() : "—"}</TableCell>
              )}
              <TableCell className="font-mono tabular-nums text-muted-foreground">{fmtDate(r.updated_at ?? r.updatedAt)}</TableCell>
              <TableCell className="sticky right-0 bg-card text-right" onClick={(e) => e.stopPropagation()}>
                <IconButton icon={I.Pencil} onClick={() => onEdit(r)} title={t`Edit`} />
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

export function BulkBar({ count, onClear, onPublish, onDelete }: { count: number; onClear: () => void; onPublish: () => void; onDelete: () => void }) {
  if (!count) return null;
  return (
    <div className="flex items-center gap-2.5 border-b border-[color-mix(in_oklch,var(--primary)_30%,var(--border))] bg-muted px-3.5 py-2">
      <span className="text-[12.5px] font-medium"><Trans>{count} selected</Trans></span>
      <div className="flex-1" />
      <Button variant="outline" size="sm" icon={I.Check} onClick={onPublish}><Trans>Publish</Trans></Button>
      <Button variant="outline" size="sm" icon={I.Trash} onClick={onDelete}><Trans>Delete</Trans></Button>
      <Button variant="ghost" size="sm" onClick={onClear}><Trans>Clear</Trans></Button>
    </div>
  );
}
