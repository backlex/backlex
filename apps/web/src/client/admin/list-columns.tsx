// Per-collection configurable list columns. Which user fields show as table
// columns (and in which order) is per-user: the signed-in user's own map lives
// on the `userListColumns:<userId>` app-setting row (`/api/account/list-columns`),
// falling back to the workspace-level `listColumns` app-setting as the shared
// default when the user hasn't customised a collection. The values render
// through `formatFieldValue`, so a field's display `format` (currency /
// percent / date style) takes effect in the list.
import { useState } from "react";
import { Trans } from "@lingui/react/macro";
import { i18n } from "@lingui/core";
import { useQueryClient } from "@tanstack/react-query";
import { fieldLabel } from "./format-value";
import { Popover, PopoverContent, PopoverScrollBody, PopoverTrigger } from "@backlex/ui/components/popover";
import { Button, Checkbox } from "./ui";
import { I } from "./icons";
import { accountApi } from "./api";
import { queryKeys, useCollections, useMyListColumns, useSettings } from "./queries";

type ColumnsMap = Record<string, string[]>;

/** Read + optimistically write the ordered column list for one collection.
 *  Reads resolve user override → workspace default; writes always land on the
 *  user's own map (so two admins can't clobber each other's view). Clearing
 *  (`setColumns([])`) drops the user entry and falls back to the workspace
 *  default again. */
export function useListColumns(slug: string): {
  columns: string[];
  setColumns: (next: string[]) => void;
} {
  const qc = useQueryClient();
  // Workspace default — admin-only endpoint; for non-admin users the query
  // just errors and the fallback map stays empty.
  const { data } = useSettings();
  const workspaceAll = ((data?.data as { listColumns?: ColumnsMap } | undefined)?.listColumns ?? {}) as ColumnsMap;
  const { data: mine } = useMyListColumns();
  const myAll = (mine?.data ?? {}) as ColumnsMap;
  const columns = slug ? (myAll[slug] ?? workspaceAll[slug] ?? []) : [];

  const setColumns = (next: string[]) => {
    const nextAll: ColumnsMap = { ...myAll };
    if (next.length) nextAll[slug] = next;
    else delete nextAll[slug];
    // Optimistic — patch the raw queryFn shape ({ data: {...} }); seed the
    // cache when the query hasn't resolved yet so the first change still
    // shows instantly.
    qc.setQueryData(queryKeys.myListColumns(), (old: any) =>
      old ? { ...old, data: nextAll } : { data: nextAll },
    );
    void accountApi
      .patchListColumns(nextAll)
      .catch(() => {})
      .finally(() => qc.invalidateQueries({ queryKey: queryKeys.myListColumns() }));
  };

  return { columns, setColumns };
}

interface SchemaField {
  name: string;
  label?: string;
  system?: boolean;
  type?: string;
  /** Relation target collection slug. */
  to?: string;
  translations?: Record<string, string>;
}

/** Toolbar popover to pick which fields appear as list columns. */
export function ColumnPicker({
  slug,
  fields,
}: {
  slug: string;
  fields: SchemaField[];
}) {
  const [open, setOpen] = useState(false);
  const { columns, setColumns } = useListColumns(slug);
  // Offer user-defined fields (system columns like id/created_at stay implicit).
  const pickable = fields.filter((f) => !f.system);
  // Relation fields expand to the target collection's fields as dot-notation
  // columns (`author.first_name`) — resolved from the cached collections list.
  const { data: colsData } = useCollections();
  const allCollections = colsData?.data;
  const [expandedRel, setExpandedRel] = useState<Record<string, boolean>>({});
  const targetFields = (f: SchemaField): SchemaField[] =>
    f.type === "relation" && f.to
      ? (((allCollections?.find((c) => c.slug === f.to)?.fields ?? []) as SchemaField[]).filter((tf) => !tf.system))
      : [];
  /** Resolve a saved column name — plain field or `head.sub` — to a display
   *  descriptor for the selected (draggable) list. */
  const resolveName = (n: string): SchemaField | null => {
    const direct = pickable.find((f) => f.name === n);
    if (direct) return direct;
    if (!n.includes(".")) return null;
    const [head, sub] = n.split(".");
    const rel = pickable.find((f) => f.name === head && f.type === "relation");
    const tf = rel ? targetFields(rel).find((x) => x.name === sub) : undefined;
    if (!rel || !tf) return null;
    // Drop the target field's own translations so the composed
    // "relation › field" label isn't overridden by them in fieldLabel.
    return { ...tf, translations: undefined, name: n, label: `${fieldLabel(rel, i18n.locale)} › ${fieldLabel(tf, i18n.locale)}` };
  };
  // Split into the saved (ordered, draggable) columns and the rest.
  const selected = columns
    .map((n) => resolveName(n))
    .filter(Boolean) as SchemaField[];
  const unselected = pickable.filter((f) => !columns.includes(f.name));

  const toggle = (name: string) => {
    setColumns(columns.includes(name) ? columns.filter((c) => c !== name) : [...columns, name]);
  };

  // Drag state for reordering the selected columns — tracked by name so a
  // stale saved name (dropped field) can't skew the splice positions.
  const [dragCol, setDragCol] = useState<string | null>(null);
  const [overCol, setOverCol] = useState<string | null>(null);
  const moveColumn = (from: string, to: string) => {
    const fromIdx = columns.indexOf(from);
    const toIdx = columns.indexOf(to);
    if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return;
    const next = [...columns];
    const moved = next.splice(fromIdx, 1)[0];
    if (moved === undefined) return;
    next.splice(toIdx, 0, moved);
    setColumns(next);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" icon={I.Sliders}>
          <Trans>Columns</Trans>
          {columns.length > 0 && (
            <span className="ml-1 rounded bg-primary/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-primary">{columns.length}</span>
          )}
        </Button>
      </PopoverTrigger>
      {/* p-0 lets children reach the edges, so clip them to the rounded
          corners — otherwise the square header/footer bars poke out. */}
      <PopoverContent align="end" collisionPadding={12} className="w-64 overflow-hidden p-0">
        {/* Same header anatomy as the editor's Fields card: icon + label +
            muted count, px-4 py-3.5. */}
        <div className="flex items-center gap-2.5 border-b border-border px-4 py-3.5">
          <I.Sliders size={14} />
          <span className="text-[13px] font-medium text-foreground"><Trans>List columns</Trans></span>
          {columns.length > 0 && <span className="font-mono text-xs text-muted-foreground">{columns.length}</span>}
          <div className="flex-1" />
          {columns.length > 0 && (
            <button type="button" className="text-[11.5px] text-muted-foreground hover:text-foreground" onClick={() => setColumns([])}>
              <Trans>Reset</Trans>
            </button>
          )}
        </div>
        {/* reserve = pinned header (~49px) + footer bar (~62px) + slack. */}
        <PopoverScrollBody reserve={120}>
          <div className="flex flex-col gap-0.5 p-1.5">
            {pickable.length === 0 && (
              <div className="px-2 py-3 text-[12px] text-muted-foreground"><Trans>No user fields yet.</Trans></div>
            )}
            {selected.map((f) => {
              const isDragging = dragCol === f.name;
              const isOver = overCol === f.name && dragCol !== null && dragCol !== f.name;
              const fromIdx = dragCol !== null ? columns.indexOf(dragCol) : -1;
              return (
                <label
                  key={f.name}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[12.5px] text-foreground hover:bg-accent"
                  draggable
                  style={{
                    opacity: isDragging ? 0.4 : 1,
                    borderTop: isOver && fromIdx > columns.indexOf(f.name) ? "2px solid var(--primary)" : undefined,
                    borderBottom: isOver && fromIdx >= 0 && fromIdx < columns.indexOf(f.name) ? "2px solid var(--primary)" : undefined,
                    transition: "opacity 80ms",
                  }}
                  onDragStart={(e) => {
                    setDragCol(f.name);
                    e.dataTransfer.effectAllowed = "move";
                    // Required for Firefox to actually start the drag.
                    e.dataTransfer.setData("text/plain", f.name);
                  }}
                  onDragOver={(e) => {
                    if (dragCol === null || dragCol === f.name) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    if (overCol !== f.name) setOverCol(f.name);
                  }}
                  onDragLeave={() => {
                    if (overCol === f.name) setOverCol(null);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (dragCol !== null && dragCol !== f.name) moveColumn(dragCol, f.name);
                    setDragCol(null);
                    setOverCol(null);
                  }}
                  onDragEnd={() => {
                    setDragCol(null);
                    setOverCol(null);
                  }}
                >
                  <span className="shrink-0 cursor-grab text-muted-foreground"><I.Grip size={13} /></span>
                  <Checkbox checked onChange={() => toggle(f.name)} />
                  <span className="min-w-0 flex-1 truncate">{fieldLabel(f, i18n.locale)}</span>
                  {f.type && <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground">{f.type}</span>}
                </label>
              );
            })}
            {selected.length > 0 && unselected.length > 0 && <div className="mx-2 my-1 border-t border-border" />}
            {unselected.map((f) => {
              const subs = targetFields(f);
              const isOpen = !!expandedRel[f.name];
              return (
                <div key={f.name} className="flex flex-col">
                  <label
                    className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[12.5px] text-foreground hover:bg-accent"
                    onClick={subs.length > 0 ? (e) => {
                      // Relation rows: clicking the row expands/collapses the
                      // target-field list; only the checkbox itself selects
                      // the FK column.
                      if ((e.target as HTMLElement).closest('[data-slot="checkbox"]')) return;
                      e.preventDefault();
                      setExpandedRel((m) => ({ ...m, [f.name]: !isOpen }));
                    } : undefined}
                  >
                    <Checkbox checked={false} onChange={() => toggle(f.name)} />
                    <span className="min-w-0 flex-1 truncate">{fieldLabel(f, i18n.locale)}</span>
                    {f.type && <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground">{f.type}</span>}
                    {subs.length > 0 && (
                      <span className="shrink-0 text-muted-foreground">
                        {isOpen ? <I.ChevronDown size={13} /> : <I.ChevronRight size={13} />}
                      </span>
                    )}
                  </label>
                  {isOpen && subs
                    .filter((tf) => !columns.includes(`${f.name}.${tf.name}`))
                    .map((tf) => (
                      <label key={tf.name} className="ml-6 flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[12.5px] text-foreground hover:bg-accent">
                        <Checkbox checked={false} onChange={() => toggle(`${f.name}.${tf.name}`)} />
                        <span className="min-w-0 flex-1 truncate">{fieldLabel(tf, i18n.locale)}</span>
                        {tf.type && <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground">{tf.type}</span>}
                      </label>
                    ))}
                </div>
              );
            })}
          </div>
        </PopoverScrollBody>
        <div className="border-t border-border px-4 py-2.5 text-[11px] text-muted-foreground">
          <Trans>Empty = the default columns. Formatting comes from each field's Interface tab.</Trans>
        </div>
      </PopoverContent>
    </Popover>
  );
}
