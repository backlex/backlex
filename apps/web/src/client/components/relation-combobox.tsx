import { useEffect, useMemo, useRef, useState } from "react";
import { CheckIcon, ChevronsUpDownIcon, XIcon } from "lucide-react";
import { Button } from "@workeros/ui/components/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@workeros/ui/components/command";
import { Popover, PopoverContent, PopoverTrigger } from "@workeros/ui/components/popover";
import { cn } from "@workeros/ui/lib/utils";
import { api } from "@/lib/api";

interface RelationComboboxProps {
  /** Target collection slug (the relation field's `to`). */
  to: string;
  /** Current foreign id (or null). */
  value: string | null;
  onChange: (next: string | null) => void;
}

interface RemoteCollection {
  slug: string;
  fields: { name: string; type: string }[];
}

interface Item {
  id: string;
  [k: string]: unknown;
}

/**
 * Searchable picker for `relation` fields. Loads the target collection's
 * schema once to pick a sensible display field (first text-ish), then
 * searches via `?filter={ <displayField>: { _contains: <query> } }`.
 *
 * Falls back to id-only display when the target is empty or schema load
 * fails.
 */
export const RelationCombobox = ({ to, value, onChange }: RelationComboboxProps) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<Item[]>([]);
  const [selected, setSelected] = useState<Item | null>(null);
  const [displayField, setDisplayField] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 1) On mount or `to` change: fetch target schema, pick display field,
  //    and resolve the current value's row (if any).
  useEffect(() => {
    if (!to) return;
    let cancelled = false;
    (async () => {
      try {
        const c = await api<{ data: RemoteCollection }>(`/api/collections/${to}`);
        if (cancelled) return;
        const text = c.data.fields.find(
          (f) => f.type === "text" || f.type === "longtext",
        );
        setDisplayField(text?.name ?? null);
        if (value) {
          const r = await api<{ data: Item }>(`/api/items/${to}/${value}`);
          if (!cancelled) setSelected(r.data);
        } else {
          setSelected(null);
        }
      } catch {
        // Permissions or missing collection — degrade to id-only.
        setDisplayField(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [to, value]);

  // 2) Search debounce: when the popover is open and the query changes,
  //    fetch a fresh page from the target collection.
  useEffect(() => {
    if (!open || !to) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams();
        params.set("limit", "20");
        if (displayField) params.set("fields", `id,${displayField}`);
        if (query.trim() && displayField) {
          params.set(
            "filter",
            JSON.stringify({ [displayField]: { _contains: query.trim() } }),
          );
        }
        const r = await api<{ data: Item[] }>(`/api/items/${to}?${params}`);
        setRows(r.data);
      } catch {
        setRows([]);
      } finally {
        setLoading(false);
      }
    }, 200);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [open, query, to, displayField]);

  const label = useMemo(() => {
    if (!value) return "";
    if (selected && displayField && selected[displayField]) {
      return String(selected[displayField]);
    }
    return value;
  }, [value, selected, displayField]);

  return (
    <div className="flex items-center gap-1">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className="w-full justify-between"
          >
            <span className={cn("truncate", !value && "text-muted-foreground")}>
              {value ? label : `Select from ${to}…`}
            </span>
            <ChevronsUpDownIcon className="ml-2 size-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
          <Command shouldFilter={false}>
            <CommandInput
              placeholder={`Search ${to}…`}
              value={query}
              onValueChange={setQuery}
            />
            <CommandList>
              {loading ? (
                <div className="px-2 py-3 text-xs text-muted-foreground">
                  Searching…
                </div>
              ) : (
                <>
                  <CommandEmpty>No matches.</CommandEmpty>
                  <CommandGroup>
                    {rows.map((row) => {
                      const text = displayField && row[displayField]
                        ? String(row[displayField])
                        : row.id;
                      const isSel = row.id === value;
                      return (
                        <CommandItem
                          key={row.id}
                          value={row.id}
                          onSelect={() => {
                            onChange(row.id);
                            setSelected(row);
                            setOpen(false);
                          }}
                        >
                          <CheckIcon
                            className={cn(
                              "mr-2 size-4",
                              isSel ? "opacity-100" : "opacity-0",
                            )}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="truncate">{text}</div>
                            {displayField && row[displayField] != null ? (
                              <div className="font-mono text-[10px] text-muted-foreground">
                                {row.id.slice(0, 8)}…
                              </div>
                            ) : null}
                          </div>
                        </CommandItem>
                      );
                    })}
                  </CommandGroup>
                </>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {value && (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          title="Clear"
          onClick={() => {
            onChange(null);
            setSelected(null);
          }}
        >
          <XIcon />
        </Button>
      )}
    </div>
  );
};
