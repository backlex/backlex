import { useEffect, useState, type FormEvent } from "react";
import { FilterIcon, XIcon } from "lucide-react";
import { Button } from "@workeros/ui/components/button";
import { Input } from "@workeros/ui/components/input";
import { Label } from "@workeros/ui/components/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@workeros/ui/components/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workeros/ui/components/select";
import { cn } from "@workeros/ui/lib/utils";
import {
  FIELD_OPS,
  formatChipValue,
  newFilterId,
  parseFilterValue,
  type FilterEntry,
} from "@/lib/filter-dsl";

interface SchemaField {
  name: string;
  type: string;
}

interface FilterChipProps {
  entry: FilterEntry;
  onRemove: () => void;
}

const FilterChip = ({ entry, onRemove }: FilterChipProps) => (
  <span className="inline-flex h-7 items-center gap-1.5 rounded-3xl border border-primary/40 bg-primary/15 px-2.5 text-xs">
    <span className="text-muted-foreground">{entry.field}</span>
    <span className="font-mono text-[11px] text-muted-foreground">{entry.op}</span>
    <span className="font-mono">{formatChipValue(entry.op, entry.value)}</span>
    <button
      type="button"
      onClick={onRemove}
      className="ml-1 grid size-4 place-items-center rounded-full text-muted-foreground hover:bg-muted/60 hover:text-foreground"
      aria-label="Remove filter"
    >
      <XIcon size={11} />
    </button>
  </span>
);

interface AddFilterProps {
  fields: SchemaField[];
  onAdd: (entry: Omit<FilterEntry, "id">) => void;
}

const AddFilter = ({ fields, onAdd }: AddFilterProps) => {
  const editable = fields.filter(
    (f) => f.name !== "id" && f.name !== "owner_id",
  );
  const [open, setOpen] = useState(false);
  const [field, setField] = useState(editable[0]?.name ?? "");
  const fieldDef = editable.find((f) => f.name === field) ?? editable[0];
  const ops = (fieldDef && FIELD_OPS[fieldDef.type]) ?? ["_eq"];
  const [op, setOp] = useState(ops[0] ?? "_eq");
  const [val, setVal] = useState("");

  // Reset op when the field changes — the available ops depend on the type.
  useEffect(() => {
    setOp(ops[0] ?? "_eq");
  }, [field]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!fieldDef) return;
    if (op !== "_null" && val.trim() === "") return;
    onAdd({
      field: fieldDef.name,
      op,
      value: parseFilterValue(op, fieldDef.type, val),
    });
    setVal("");
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm">
          <FilterIcon /> Filter
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-3">
        <form onSubmit={submit} className="space-y-2">
          <div className="grid grid-cols-[1fr_120px] gap-2">
            <div className="space-y-1.5">
              <Label className="text-xs">Field</Label>
              <Select value={field} onValueChange={setField}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {editable.map((f) => (
                    <SelectItem key={f.name} value={f.name}>
                      {f.name}{" "}
                      <span className="ml-1 text-xs text-muted-foreground">
                        {f.type}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Op</Label>
              <Select value={op} onValueChange={setOp}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ops.map((o) => (
                    <SelectItem key={o} value={o} className="font-mono text-xs">
                      {o}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {op !== "_null" && (
            <div className="space-y-1.5">
              <Label className="text-xs">Value</Label>
              <Input
                autoFocus
                value={val}
                onChange={(e) => setVal(e.target.value)}
                placeholder={
                  op === "_in"
                    ? "a, b, c"
                    : fieldDef?.type === "integer"
                      ? "42"
                      : "value…"
                }
              />
            </div>
          )}
          <div className="flex justify-end gap-1.5 pt-1">
            <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm">
              Add filter
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
};

interface FilterBuilderProps {
  fields: SchemaField[];
  filters: FilterEntry[];
  onChange: (next: FilterEntry[]) => void;
  className?: string;
}

/**
 * Chip-based filter list per the design spec. Each chip is one
 * `{ field, op, value }` triple; together they merge into the workeros
 * filter DSL via `buildFilterDSL`.
 */
export const FilterBuilder = ({
  fields,
  filters,
  onChange,
  className,
}: FilterBuilderProps) => (
  <div className={cn("flex flex-wrap items-center gap-2", className)}>
    <AddFilter
      fields={fields}
      onAdd={(f) => onChange([...filters, { ...f, id: newFilterId() }])}
    />
    {filters.map((f) => (
      <FilterChip
        key={f.id}
        entry={f}
        onRemove={() => onChange(filters.filter((x) => x.id !== f.id))}
      />
    ))}
    {filters.length > 0 && (
      <Button variant="ghost" size="sm" onClick={() => onChange([])}>
        Clear
      </Button>
    )}
  </div>
);
