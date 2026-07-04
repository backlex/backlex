// Per-collection configurable list columns. Which user fields show as table
// columns is stored per-workspace in the `listColumns` app-setting (slug →
// ordered field names), the same no-migration convention as `erdLayout`. The
// values render through `formatFieldValue`, so a field's display `format`
// (currency / percent / date style) takes effect in the list.
import { useState } from "react";
import { Trans } from "@lingui/react/macro";
import { useQueryClient } from "@tanstack/react-query";
import { Popover, PopoverContent, PopoverTrigger } from "@backlex/ui/components/popover";
import { ScrollArea } from "@backlex/ui/components/scroll-area";
import { Button, Checkbox } from "./ui";
import { I } from "./icons";
import { settingsApi } from "./api";
import { queryKeys, useSettings } from "./queries";

type ColumnsMap = Record<string, string[]>;

/** Read + optimistically write the ordered column list for one collection. */
export function useListColumns(slug: string): {
  columns: string[];
  setColumns: (next: string[]) => void;
} {
  const qc = useQueryClient();
  const { data } = useSettings();
  const all = ((data?.data as { listColumns?: ColumnsMap } | undefined)?.listColumns ?? {}) as ColumnsMap;
  const columns = slug ? (all[slug] ?? []) : [];

  const setColumns = (next: string[]) => {
    const nextAll: ColumnsMap = { ...all };
    if (next.length) nextAll[slug] = next;
    else delete nextAll[slug];
    // Optimistic — patch the raw settings queryFn shape ({ data: {...} }).
    qc.setQueryData(queryKeys.settings(), (old: any) =>
      old ? { ...old, data: { ...(old.data ?? {}), listColumns: nextAll } } : old,
    );
    void settingsApi
      .patch({ listColumns: nextAll } as never)
      .catch(() => {})
      .finally(() => qc.invalidateQueries({ queryKey: queryKeys.settings() }));
  };

  return { columns, setColumns };
}

interface SchemaField {
  name: string;
  label?: string;
  system?: boolean;
  type?: string;
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

  const toggle = (name: string) => {
    setColumns(columns.includes(name) ? columns.filter((c) => c !== name) : [...columns, name]);
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
      <PopoverContent align="end" className="w-64 p-0">
        <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
          <span className="text-[12.5px] font-medium text-foreground"><Trans>List columns</Trans></span>
          {columns.length > 0 && (
            <button type="button" className="text-[11.5px] text-muted-foreground hover:text-foreground" onClick={() => setColumns([])}>
              <Trans>Reset</Trans>
            </button>
          )}
        </div>
        <ScrollArea viewportClassName="max-h-[280px]">
          <div className="flex flex-col gap-0.5 p-1.5">
            {pickable.length === 0 && (
              <div className="px-2 py-3 text-[12px] text-muted-foreground"><Trans>No user fields yet.</Trans></div>
            )}
            {pickable.map((f) => (
              <label key={f.name} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[12.5px] text-foreground hover:bg-accent">
                <Checkbox checked={columns.includes(f.name)} onChange={() => toggle(f.name)} />
                <span className="min-w-0 flex-1 truncate">{f.label || f.name}</span>
                {f.type && <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground">{f.type}</span>}
              </label>
            ))}
          </div>
        </ScrollArea>
        <div className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
          <Trans>Empty = the default columns. Formatting comes from each field's Interface tab.</Trans>
        </div>
      </PopoverContent>
    </Popover>
  );
}
