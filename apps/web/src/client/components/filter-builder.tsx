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
  splitNestedField,
  type FilterEntry,
  type FilterMode,
} from "@/lib/filter-dsl";

interface SchemaField {
  name: string;
  type: string;
  /**
   * Target collection slug for `relation` / `relation_many` fields. Used by
   * the nested-filter dropdown to fetch the sub-field list. Optional so
   * callers built before nested filtering keep working — without `to` set
   * the relation simply can't be drilled into.
   */
  to?: string;
}

/**
 * Lookup that returns the readable fields of a target collection by slug.
 * The builder uses this when the user picks a `relation` field and wants to
 * filter on a sub-field of the related row (e.g. `customer_id.name`).
 * Returns `undefined` while the parent is still loading, or for collections
 * the caller has no read permission on — the sub dropdown reflects that
 * with a disabled placeholder.
 */
export type RelationTargetFields = (
  slug: string,
) => SchemaField[] | undefined;

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
  relationTargetFields?: RelationTargetFields;
}

const AddFilter = ({
  fields,
  onAdd,
  relationTargetFields,
}: AddFilterProps) => {
  const editable = fields.filter(
    (f) => f.name !== "id" && f.name !== "owner_id",
  );
  const [open, setOpen] = useState(false);
  const [field, setField] = useState(editable[0]?.name ?? "");
  const headDef = editable.find((f) => f.name === field) ?? editable[0];

  // Nested-relation drill-down. Only meaningful when the head is a
  // `relation` (single FK) — `relation_many` is recognised so the disabled
  // hint can render, but no sub can be picked yet.
  const isRelation = headDef?.type === "relation";
  const isRelationMany = headDef?.type === "relation_many";
  const canDrill = isRelation && !!headDef?.to && !!relationTargetFields;
  const targetFields =
    canDrill && headDef?.to ? relationTargetFields!(headDef.to) : undefined;
  // Hide system PK from the sub list; everything else is a fair filter
  // target. The server applies the read-permission allow-list on POST so
  // we don't need to mirror it here.
  const subEditable = (targetFields ?? []).filter((f) => f.name !== "id");
  const [nestedSub, setNestedSub] = useState<string>("");
  const subDef = subEditable.find((f) => f.name === nestedSub);

  // The op list and value shape follow the *leaf* field's type — for a
  // nested filter that's the sub, otherwise the head itself.
  const leafDef: SchemaField | undefined =
    isRelation || isRelationMany ? subDef : headDef;
  const ops = (leafDef && FIELD_OPS[leafDef.type]) ?? ["_eq"];
  const [op, setOp] = useState(ops[0] ?? "_eq");
  const [textValue, setTextValue] = useState("");
  const [multiValue, setMultiValue] = useState<string[]>([]);

  // Reset op + values when the field changes — the available ops depend on
  // the type and the value shape must follow the new op. Also drop the
  // previously-picked sub so the user re-selects after switching heads.
  useEffect(() => {
    setNestedSub("");
  }, [field]);

  useEffect(() => {
    setOp(ops[0] ?? "_eq");
    setTextValue("");
    setMultiValue([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [field, nestedSub]);

  useEffect(() => {
    setTextValue("");
    setMultiValue([]);
  }, [op]);

  // Apply is gated on having a leaf field — for plain heads that's always
  // true, for relations only after a sub is picked.
  const needsSub = isRelation || isRelationMany;
  const canSubmit = !!leafDef && (!needsSub || (isRelation && !!subDef));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit || !leafDef || !headDef) return;
    let value: unknown;
    if (op === "_null") {
      value = true;
    } else if (op === "_in" || op === "_nin") {
      if (multiValue.length === 0) return;
      value = multiValue.map((v) =>
        parseFilterValue("_eq", leafDef.type, v),
      );
    } else {
      if (textValue.trim() === "") return;
      // Timestamps from <input type="datetime-local"> come as `2026-05-13T10:30`
      // (no zone) — round-trip through `Date` to land on an ISO string so PG
      // can parse it and SQLite gets a comparable lexicographic format.
      if (leafDef.type === "timestamp") {
        const d = new Date(textValue);
        value = Number.isFinite(d.getTime())
          ? d.toISOString()
          : textValue;
      } else {
        value = parseFilterValue(op, leafDef.type, textValue);
      }
    }
    // Nested filters serialize to `<head>.<sub>` — the same shape the
    // server's parseQuery / compileCondition expect; flat filters keep the
    // bare head name.
    const fieldKey =
      isRelation && subDef ? `${headDef.name}.${subDef.name}` : headDef.name;
    onAdd({
      field: fieldKey,
      op,
      value,
      ...(isRelation && subDef ? { nestedSub: subDef.name } : {}),
    });
    setTextValue("");
    setMultiValue([]);
    setNestedSub("");
    setOpen(false);
  };

  // Sub-dropdown placeholder — the disabled state has three flavors so the
  // user knows why they can't proceed. `relation_many` is the deferred case
  // (server compiler doesn't JOIN on JSON arrays yet) — keep the field
  // pickable in the head list but block the drill.
  const subPlaceholder = isRelationMany
    ? "Not supported on relation_many"
    : !headDef?.to
      ? "Relation has no target"
      : !relationTargetFields
        ? "Loading target…"
        : targetFields === undefined
          ? "Target unavailable"
          : "Pick a subfield";
  const subDisabled =
    !isRelation || !headDef?.to || !relationTargetFields || !targetFields;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm">
          <FilterIcon /> Filter
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        collisionPadding={8}
        className="w-80 max-w-[calc(100vw-1rem)] p-3"
      >
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
              <Select
                value={op}
                onValueChange={setOp}
                disabled={!leafDef}
              >
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
          {needsSub && (
            <div className="space-y-1.5">
              <Label className="text-xs">Subfield</Label>
              <Select
                value={nestedSub}
                onValueChange={setNestedSub}
                disabled={subDisabled}
              >
                <SelectTrigger
                  title={
                    isRelationMany
                      ? "Nested filter not supported on relation_many yet"
                      : undefined
                  }
                >
                  <SelectValue placeholder={subPlaceholder} />
                </SelectTrigger>
                <SelectContent>
                  {subEditable.map((f) => (
                    <SelectItem key={f.name} value={f.name}>
                      {f.name}{" "}
                      <span className="ml-1 text-xs text-muted-foreground">
                        {f.type}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {isRelationMany && (
                <p className="text-[11px] text-muted-foreground">
                  Nested filter not supported on relation_many yet.
                </p>
              )}
            </div>
          )}
          {op !== "_null" && leafDef && (
            <div className="space-y-1.5">
              <Label className="text-xs">Value</Label>
              <FilterValueInput
                fieldType={leafDef.type}
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
            <Button type="submit" size="sm" disabled={!canSubmit}>
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
  /**
   * Lookup that returns the readable fields of a target collection when the
   * user drills into a `relation` field. Without it the nested sub-dropdown
   * shows a "Loading target…" disabled placeholder and the user can only
   * filter on the FK column itself.
   */
  relationTargetFields?: RelationTargetFields;
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
  relationTargetFields,
  className,
}: FilterBuilderProps) => {
  const knownFields = new Set(fields.map((f) => f.name));
  // A chip with a nested key (`customer_id.name`) is stale only when the
  // head no longer exists — the sub is validated server-side and the local
  // schema doesn't carry target fields.
  const isStaleField = (f: FilterEntry): boolean => {
    const nested = splitNestedField(f.field);
    return nested ? !knownFields.has(nested.head) : !knownFields.has(f.field);
  };
  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      <AddFilter
        fields={fields}
        relationTargetFields={relationTargetFields}
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
          isStale={isStaleField(f)}
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
