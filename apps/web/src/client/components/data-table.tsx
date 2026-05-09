import { type ReactNode, useMemo, useState } from "react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ArrowUpDownIcon,
  ColumnsIcon,
} from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@workeros/ui/components/table";
import { Checkbox } from "@workeros/ui/components/checkbox";
import { Button } from "@workeros/ui/components/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@workeros/ui/components/popover";
import { Skeleton } from "@workeros/ui/components/skeleton";
import { cn } from "@workeros/ui/lib/utils";

export interface DataTableColumn<Row> {
  id: string;
  header: string;
  /** How to render the cell. Defaults to `String(row[id])`. */
  cell?: (row: Row) => ReactNode;
  /** Sort key — when omitted, column isn't sortable. */
  sortKey?: keyof Row | string;
  /** Optional fixed width / min-width hint. */
  width?: string;
  /** Hide by default; user can re-enable via column visibility menu. */
  defaultHidden?: boolean;
  /** Right-align (numbers, etc.). */
  align?: "left" | "right";
}

export interface DataTableProps<Row extends { id: string | number }> {
  columns: DataTableColumn<Row>[];
  rows: Row[];
  loading?: boolean;
  /** Selection — pass props to enable. */
  selectable?: boolean;
  selectedIds?: Set<string | number>;
  onSelectionChange?: (ids: Set<string | number>) => void;
  /** Action bar shown at top when at least one row selected. */
  bulkActions?: (selectedIds: Set<string | number>) => ReactNode;
  /** Per-row click — opens detail view, etc. */
  onRowClick?: (row: Row) => void;
  /** Extra cell on the right of each row (action buttons, etc.). */
  rowActions?: (row: Row) => ReactNode;
  /** Empty state (rendered when `!loading && rows.length === 0`). */
  empty?: ReactNode;
  /** Sort state lifted to parent — controlled. */
  sort?: { key: string; dir: "asc" | "desc" } | null;
  onSortChange?: (sort: { key: string; dir: "asc" | "desc" } | null) => void;
  /** Local-only initial column visibility (controlled-light). */
  initialHidden?: string[];
}

export function DataTable<Row extends { id: string | number }>(
  props: DataTableProps<Row>,
) {
  const {
    columns,
    rows,
    loading = false,
    selectable = false,
    selectedIds,
    onSelectionChange,
    bulkActions,
    onRowClick,
    rowActions,
    empty,
    sort,
    onSortChange,
    initialHidden,
  } = props;

  const [hidden, setHidden] = useState<Set<string>>(
    () =>
      new Set(
        initialHidden ??
          columns.filter((c) => c.defaultHidden).map((c) => c.id),
      ),
  );

  const visibleCols = useMemo(
    () => columns.filter((c) => !hidden.has(c.id)),
    [columns, hidden],
  );

  const allSelected =
    selectable &&
    rows.length > 0 &&
    selectedIds !== undefined &&
    rows.every((r) => selectedIds.has(r.id));
  const someSelected =
    selectable &&
    selectedIds !== undefined &&
    !allSelected &&
    rows.some((r) => selectedIds.has(r.id));

  const toggleAll = () => {
    if (!onSelectionChange) return;
    if (allSelected) {
      const next = new Set(selectedIds ?? []);
      for (const r of rows) next.delete(r.id);
      onSelectionChange(next);
    } else {
      const next = new Set(selectedIds ?? []);
      for (const r of rows) next.add(r.id);
      onSelectionChange(next);
    }
  };

  const toggleRow = (id: string | number) => {
    if (!onSelectionChange) return;
    const next = new Set(selectedIds ?? []);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onSelectionChange(next);
  };

  const handleSort = (key: string | undefined) => {
    if (!key || !onSortChange) return;
    if (!sort || sort.key !== key) onSortChange({ key, dir: "asc" });
    else if (sort.dir === "asc") onSortChange({ key, dir: "desc" });
    else onSortChange(null);
  };

  const selectionCount = selectedIds?.size ?? 0;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex-1">
          {selectionCount > 0 && bulkActions && (
            <div className="flex items-center gap-2 rounded-2xl border border-border bg-muted/40 px-3 py-1.5 text-sm">
              <span className="text-muted-foreground">
                {selectionCount} selected
              </span>
              <div className="flex-1" />
              {bulkActions(selectedIds ?? new Set())}
            </div>
          )}
        </div>
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm">
              <ColumnsIcon /> Columns
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-56">
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">
                Visible columns
              </p>
              {columns.map((col) => (
                <label
                  key={col.id}
                  className="flex items-center gap-2 rounded-md p-1.5 text-sm hover:bg-muted"
                >
                  <Checkbox
                    checked={!hidden.has(col.id)}
                    onCheckedChange={(v) => {
                      const next = new Set(hidden);
                      if (v) next.delete(col.id);
                      else next.add(col.id);
                      setHidden(next);
                    }}
                  />
                  {col.header}
                </label>
              ))}
            </div>
          </PopoverContent>
        </Popover>
      </div>

      <div className="rounded-2xl border border-border overflow-hidden">
        <Table>
          <TableHeader className="bg-muted/40">
            <TableRow>
              {selectable && (
                <TableHead className="w-10">
                  <Checkbox
                    checked={allSelected ? true : someSelected ? "indeterminate" : false}
                    onCheckedChange={toggleAll}
                    aria-label="Select all rows"
                  />
                </TableHead>
              )}
              {visibleCols.map((col) => {
                const sortable = !!col.sortKey && !!onSortChange;
                const active = sort?.key === col.sortKey;
                return (
                  <TableHead
                    key={col.id}
                    style={col.width ? { width: col.width } : undefined}
                    className={cn(col.align === "right" && "text-right")}
                  >
                    {sortable ? (
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 hover:text-foreground"
                        onClick={() => handleSort(String(col.sortKey))}
                      >
                        {col.header}
                        {!active && (
                          <ArrowUpDownIcon className="size-3 text-muted-foreground" />
                        )}
                        {active && sort?.dir === "asc" && (
                          <ArrowUpIcon className="size-3" />
                        )}
                        {active && sort?.dir === "desc" && (
                          <ArrowDownIcon className="size-3" />
                        )}
                      </button>
                    ) : (
                      col.header
                    )}
                  </TableHead>
                );
              })}
              {rowActions && <TableHead className="w-20 text-right" />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading &&
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={`s-${i}`}>
                  {selectable && (
                    <TableCell>
                      <Skeleton className="size-4" />
                    </TableCell>
                  )}
                  {visibleCols.map((col) => (
                    <TableCell key={col.id}>
                      <Skeleton className="h-4 w-3/4" />
                    </TableCell>
                  ))}
                  {rowActions && <TableCell />}
                </TableRow>
              ))}
            {!loading && rows.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={
                    visibleCols.length + (selectable ? 1 : 0) + (rowActions ? 1 : 0)
                  }
                  className="py-12 text-center"
                >
                  {empty ?? (
                    <p className="text-sm text-muted-foreground">No rows.</p>
                  )}
                </TableCell>
              </TableRow>
            )}
            {!loading &&
              rows.map((row) => {
                const isSelected = selectedIds?.has(row.id) ?? false;
                return (
                  <TableRow
                    key={row.id}
                    data-state={isSelected ? "selected" : undefined}
                    className={cn(onRowClick && "cursor-pointer")}
                    onClick={(e) => {
                      // Ignore clicks that originated inside an interactive child.
                      const t = e.target as HTMLElement;
                      if (t.closest("button, a, input, label, [role='checkbox']"))
                        return;
                      onRowClick?.(row);
                    }}
                  >
                    {selectable && (
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <Checkbox
                          checked={isSelected}
                          onCheckedChange={() => toggleRow(row.id)}
                          aria-label="Select row"
                        />
                      </TableCell>
                    )}
                    {visibleCols.map((col) => (
                      <TableCell
                        key={col.id}
                        className={cn(col.align === "right" && "text-right")}
                      >
                        {col.cell
                          ? col.cell(row)
                          : String((row as unknown as Record<string, unknown>)[col.id] ?? "")}
                      </TableCell>
                    ))}
                    {rowActions && (
                      <TableCell
                        className="text-right"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {rowActions(row)}
                      </TableCell>
                    )}
                  </TableRow>
                );
              })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
