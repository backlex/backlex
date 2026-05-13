import { useEffect, useState, type FormEvent, type KeyboardEvent } from "react";
import { AlertTriangleIcon, FilterIcon, XIcon } from "lucide-react";
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
import {
  Tabs,
  TabsList,
  TabsTrigger,
} from "@workeros/ui/components/tabs";
import { cn } from "@workeros/ui/lib/utils";
import {
  FIELD_OPS,
  formatChipValue,
  newFilterId,
  parseFilterValue,
  type FilterEntry,
  type FilterMode,
} from "@/lib/filter-dsl";

interface SchemaField {
  name: string;
  type: string;
}

interface FilterChipProps {
  entry: FilterEntry;
  isStale?: boolean;
  onRemove: () => void;
}

const FilterChip = ({ entry, isStale, onRemove }: FilterChipProps) => (
  <span
    className={cn(
      "inline-flex h-7 items-center gap-1.5 rounded-3xl border px-2.5 text-xs",
      isStale
        ? "border-destructive/40 bg-destructive/10 text-destructive"
        : "border-primary/40 bg-primary/15",
    )}
    title={isStale ? `Field "${entry.field}" no longer exists` : undefined}
  >
    {isStale && <AlertTriangleIcon size={11} />}
    <span className={isStale ? "" : "text-muted-foreground"}>{entry.field}</span>
    <span className="font-mono text-[11px] opacity-80">{entry.op}</span>
    <span className="font-mono">{formatChipValue(entry.op, entry.value)}</span>
    <button
      type="button"
      onClick={onRemove}
      className="ml-1 grid size-4 place-items-center rounded-full opacity-70 hover:bg-muted/60 hover:opacity-100"
      aria-label="Remove filter"
    >
      <XIcon size={11} />
    </button>
  </span>
);

interface MultiValueInputProps {
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
}

/** Chip-style tag input used for `_in` / `_nin`. Enter or comma commits a tag;
 *  Backspace on an empty input removes the last tag. */
const MultiValueInput = ({
  value,
  onChange,
  placeholder,
}: MultiValueInputProps) => {
  const [draft, setDraft] = useState("");

  const commit = (raw: string) => {
    const v = raw.trim();
    if (!v) return;
    if (value.includes(v)) {
      setDraft("");
      return;
    }
    onChange([...value, v]);
    setDraft("");
  };

  const handleKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      commit(draft);
    } else if (e.key === "Backspace" && draft === "" && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-1 rounded-md border border-input bg-transparent px-2 py-1.5 text-sm focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30">
      {value.map((v) => (
        <span
          key={v}
          className="inline-flex h-5 items-center gap-1 rounded-md bg-muted px-1.5 text-xs"
        >
          {v}
          <button
            type="button"
            onClick={() => onChange(value.filter((x) => x !== v))}
            className="opacity-60 hover:opacity-100"
            aria-label={`Remove ${v}`}
          >
            <XIcon size={10} />
          </button>
        </span>
      ))}
      <input
        autoFocus
        className="min-w-[80px] flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={handleKey}
        onBlur={() => commit(draft)}
        placeholder={value.length === 0 ? (placeholder ?? "a, b, c") : ""}
      />
    </div>
  );
};

interface FilterValueInputProps {
  fieldType: string;
  op: string;
  textValue: string;
  multiValue: string[];
  onTextChange: (v: string) => void;
  onMultiChange: (v: string[]) => void;
}

const FilterValueInput = ({
  fieldType,
  op,
  textValue,
  multiValue,
  onTextChange,
  onMultiChange,
}: FilterValueInputProps) => {
  if (op === "_in" || op === "_nin") {
    return <MultiValueInput value={multiValue} onChange={onMultiChange} />;
  }
  if (fieldType === "boolean") {
    return (
      <Select value={textValue || "true"} onValueChange={onTextChange}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="true">true</SelectItem>
          <SelectItem value="false">false</SelectItem>
        </SelectContent>
      </Select>
    );
  }
  if (fieldType === "timestamp") {
    return (
      <Input
        type="datetime-local"
        autoFocus
        value={textValue}
        onChange={(e) => onTextChange(e.target.value)}
      />
    );
  }
  return (
    <Input
      autoFocus
      value={textValue}
      onChange={(e) => onTextChange(e.target.value)}
      placeholder={fieldType === "integer" ? "42" : "value…"}
    />
  );
};

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
  const [textValue, setTextValue] = useState("");
  const [multiValue, setMultiValue] = useState<string[]>([]);

  // Reset op + values when the field changes — the available ops depend on the
  // type and the value shape must follow the new op.
  useEffect(() => {
    setOp(ops[0] ?? "_eq");
    setTextValue("");
    setMultiValue([]);
  }, [field]);

  useEffect(() => {
    setTextValue("");
    setMultiValue([]);
  }, [op]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!fieldDef) return;
    let value: unknown;
    if (op === "_null") {
      value = true;
    } else if (op === "_in" || op === "_nin") {
      if (multiValue.length === 0) return;
      value = multiValue.map((v) =>
        parseFilterValue("_eq", fieldDef.type, v),
      );
    } else {
      if (textValue.trim() === "") return;
      // Timestamps from <input type="datetime-local"> come as `2026-05-13T10:30`
      // (no zone) — round-trip through `Date` to land on an ISO string so PG
      // can parse it and SQLite gets a comparable lexicographic format.
      if (fieldDef.type === "timestamp") {
        const d = new Date(textValue);
        value = Number.isFinite(d.getTime())
          ? d.toISOString()
          : textValue;
      } else {
        value = parseFilterValue(op, fieldDef.type, textValue);
      }
    }
    onAdd({ field: fieldDef.name, op, value });
    setTextValue("");
    setMultiValue([]);
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
          {op !== "_null" && fieldDef && (
            <div className="space-y-1.5">
              <Label className="text-xs">Value</Label>
              <FilterValueInput
                fieldType={fieldDef.type}
                op={op}
                textValue={textValue}
                multiValue={multiValue}
                onTextChange={setTextValue}
                onMultiChange={setMultiValue}
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
  /** Match mode — AND combines all chips, OR matches any. Defaults to "and". */
  mode?: FilterMode;
  onModeChange?: (mode: FilterMode) => void;
  className?: string;
}

/**
 * Chip-based filter list. Each chip is one `{ field, op, value }` triple;
 * together they compile into the workeros filter DSL. When `onModeChange` is
 * provided a top-level AND/OR toggle is rendered next to the chips.
 */
export const FilterBuilder = ({
  fields,
  filters,
  onChange,
  mode = "and",
  onModeChange,
  className,
}: FilterBuilderProps) => {
  const knownFields = new Set(fields.map((f) => f.name));
  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      <AddFilter
        fields={fields}
        onAdd={(f) => onChange([...filters, { ...f, id: newFilterId() }])}
      />
      {onModeChange && filters.length > 1 && (
        <Tabs
          value={mode}
          onValueChange={(v) => onModeChange(v as FilterMode)}
        >
          <TabsList className="h-7">
            <TabsTrigger value="and" className="text-xs">
              Match all
            </TabsTrigger>
            <TabsTrigger value="or" className="text-xs">
              Match any
            </TabsTrigger>
          </TabsList>
        </Tabs>
      )}
      {filters.map((f) => (
        <FilterChip
          key={f.id}
          entry={f}
          isStale={!knownFields.has(f.field)}
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
};
