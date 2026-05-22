// @ts-nocheck
// Add Field dialog — Directus-style schema editor for a new column.
// Step 1 picks a UI *interface* from a categorized catalog (interfaces.ts);
// each interface maps to one of the physical storage types the backend
// supports. Step 2 captures the column name + interface-specific options
// (dropdown choices, relation target) and the NOT NULL / UNIQUE flags.
import { useEffect, useMemo, useState } from "react";
import { I, type IconComponent, type IconKey } from "./icons";
import { type CollectionSchema } from "./config";
import { Badge, Button, IconButton, Switch } from "./ui";
import { Input } from "@workeros/ui/components/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@workeros/ui/components/input-group";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@workeros/ui/components/dialog";
import { Select } from "./select";
import { AlterPreview } from "./extras";
import {
  FIELD_INTERFACES,
  INTERFACE_GROUPS,
  getInterface,
  matchesInterfaceQuery,
} from "./interfaces";

// Kept for back-compat with anything that imported the old flat list.
export const FIELD_TYPES = FIELD_INTERFACES;

const DEFAULT_CHOICES = [
  { value: "option_a", label: "Option A", color: "#A1A6B8" },
  { value: "option_b", label: "Option B", color: "#2ECDA7" },
];

export interface AddFieldDialogProps {
  open: boolean;
  schema: CollectionSchema;
  /** Collections available as relation targets. Falls back to the mock seed. */
  collections?: Array<{ slug: string; count?: number }>;
  onClose: () => void;
  onCreate: (field: Record<string, unknown>) => void;
}

export function AddFieldDialog({ open, schema, collections, onClose, onCreate }: AddFieldDialogProps) {
  const [name, setName] = useState("");
  const [interfaceId, setInterfaceId] = useState("input");
  const [query, setQuery] = useState("");
  const [nullable, setNullable] = useState(true);
  const [unique, setUnique] = useState(false);
  const [defaultValue, setDefaultValue] = useState("");
  const [choices, setChoices] = useState(DEFAULT_CHOICES);
  const [relationTarget, setRelationTarget] = useState("");
  const [indexed, setIndexed] = useState(false);
  const [step, setStep] = useState(1);

  useEffect(() => {
    if (open) {
      setName("");
      setInterfaceId("input");
      setQuery("");
      setNullable(true);
      setUnique(false);
      setDefaultValue("");
      setChoices(DEFAULT_CHOICES);
      setRelationTarget("");
      setStep(1);
      setIndexed(false);
    }
  }, [open]);

  const safeName = useMemo(
    () => name.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, ""),
    [name],
  );
  const nameTaken = schema?.fields?.some((f) => f.name === safeName);

  const def = getInterface(interfaceId) ?? FIELD_INTERFACES[0];
  const Icon = (I as Record<string, IconComponent>)[def.icon as IconKey] || I.Code;

  const relationOptions = useMemo(() => {
    const list = collections ?? [];
    return list.map((c) => ({
      value: c.slug,
      label: c.slug,
      hint: typeof c.count === "number" ? `${c.count} rows` : undefined,
    }));
  }, [collections]);

  const cleanChoices = useMemo(
    () =>
      choices
        .filter((c) => (c.value ?? "").trim())
        .map((c) => ({
          value: c.value.trim(),
          ...(c.label?.trim() ? { label: c.label.trim() } : {}),
          ...(c.color ? { color: c.color } : {}),
        })),
    [choices],
  );

  // dropdown enforces choice membership server-side, so it must ship at least
  // one choice; relation needs a target collection.
  const missingChoices = def.id === "dropdown" && cleanChoices.length === 0;
  const missingRelation = !!def.hasRelation && !relationTarget;
  const valid =
    !!safeName && !nameTaken && safeName.length >= 2 && !missingChoices && !missingRelation;

  const groups = useMemo(() => {
    const filtered = FIELD_INTERFACES.filter((i) => matchesInterfaceQuery(i, query));
    return INTERFACE_GROUPS.map((g) => ({
      group: g,
      items: filtered.filter((i) => i.group === g),
    })).filter((g) => g.items.length > 0);
  }, [query]);

  const setChoice = (i: number, patch: Partial<(typeof choices)[number]>) =>
    setChoices((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const addChoice = () => setChoices((cs) => [...cs, { value: "", label: "", color: "#A1A6B8" }]);
  const removeChoice = (i: number) => setChoices((cs) => cs.filter((_, j) => j !== i));

  const pickInterface = (id: string) => {
    setInterfaceId(id);
    const next = getInterface(id);
    if (next?.hasChoices && choices.length === 0) setChoices(DEFAULT_CHOICES);
  };

  if (!open) return null;

  const submit = () => {
    if (!valid) return;
    onCreate({
      name: safeName,
      type: def.type,
      interface: def.id,
      required: !nullable,
      unique,
      default: defaultValue || null,
      indexed,
      ...(def.hasChoices && cleanChoices.length ? { options: { choices: cleanChoices } } : {}),
      ...(def.hasRelation ? { to: relationTarget } : {}),
    });
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="flex max-h-[92vh] w-[94vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-[760px]">
        <DialogHeader className="border-b border-border px-5 pb-3.5 pr-12 pt-[18px] text-left">
          <DialogTitle className="text-base font-semibold tracking-[-0.01em]">
            Add field to <span className="font-mono">c_{schema?.slug || "posts"}</span>
          </DialogTitle>
          <DialogDescription className="text-[12.5px]">
            Pick an interface, name the column — additive ALTER TABLE, no existing rows are rewritten.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2.5 border-b border-border bg-[color-mix(in_oklch,var(--muted)_30%,var(--card))] px-5 py-3 text-[12.5px]">
          <div className={`inline-flex items-center gap-2 font-medium ${step >= 1 ? "text-foreground" : "text-muted-foreground"}`}>
            <span className={`grid size-5 place-items-center rounded-full font-mono text-[11px] font-semibold ${step >= 1 ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>1</span> Interface
          </div>
          <div className="h-px max-w-[60px] flex-1 bg-border" />
          <div className={`inline-flex items-center gap-2 font-medium ${step >= 2 ? "text-foreground" : "text-muted-foreground"}`}>
            <span className={`grid size-5 place-items-center rounded-full font-mono text-[11px] font-semibold ${step >= 2 ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>2</span> Settings
          </div>
        </div>

        {step === 1 && (
          <div className="flex-1 overflow-auto px-5 py-[18px]">
            <InputGroup className="mb-3.5">
              <InputGroupAddon><I.Search size={14} /></InputGroupAddon>
              <InputGroupInput
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={`Search ${FIELD_INTERFACES.length} interfaces — input, markdown, dropdown, relation…`}
              />
            </InputGroup>
            {groups.length === 0 && (
              <div className="px-1 py-4 text-[12.5px] text-muted-foreground">No interface matches “{query}”.</div>
            )}
            {groups.map(({ group, items }) => (
              <div key={group} className="mb-[18px]">
                <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
                  <span>{group}</span>
                  <span className="tabular-nums text-[11px] text-muted-foreground">{items.length}</span>
                  <div className="ml-1 h-px flex-1 bg-border" />
                </div>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(184px,1fr))] gap-2">
                  {items.map((t) => {
                    const Ic = (I as Record<string, IconComponent>)[t.icon as IconKey] || I.Code;
                    const on = interfaceId === t.id;
                    return (
                      <button
                        key={t.id}
                        type="button"
                        className={`grid cursor-pointer grid-cols-[28px_1fr_auto] grid-rows-[auto_auto] items-center gap-x-2.5 rounded-xl border p-3 text-left text-foreground transition-colors ${on ? "border-[color-mix(in_oklch,var(--primary)_60%,var(--border))] bg-[color-mix(in_oklch,var(--primary)_10%,var(--card))]" : "border-border bg-card hover:bg-accent"}`}
                        onClick={() => pickInterface(t.id)}
                        title={t.sub}
                      >
                        <span className={`row-span-2 grid size-7 place-items-center self-center rounded-[8px] text-foreground ${on ? "bg-[color-mix(in_oklch,var(--primary)_30%,var(--card))]" : "bg-muted"}`}><Ic size={14} /></span>
                        <span className="text-[13px] font-medium">{t.label}</span>
                        <span className="col-start-2 text-[11.5px] text-muted-foreground">{t.sub}</span>
                        <span className="row-span-2 self-center rounded-[6px] bg-muted px-1.5 py-0.5 font-mono text-[10.5px] text-muted-foreground">{t.type}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}

        {step === 2 && (
          <div className="grid flex-1 grid-cols-2 gap-3 overflow-auto px-5 py-[18px] max-[640px]:grid-cols-1">
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">Name</label>
                <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="reading_time_minutes" />
                <span className="font-mono text-[11px] text-muted-foreground">
                  column: <span className={nameTaken ? "text-destructive" : "text-foreground"}>{safeName || "—"}</span>
                  {nameTaken && <span className="text-destructive"> · already exists</span>}
                </span>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">Interface</label>
                <div className="flex items-center gap-2 rounded-3xl border border-border bg-card px-3 py-2">
                  <Icon size={14} />
                  <span className="text-[13px] font-medium">{def.label}</span>
                  <Badge variant="outline" mono>{def.type}</Badge>
                  <span className="text-xs text-muted-foreground">· {def.sub}</span>
                  <div className="flex-1" />
                  <Button variant="ghost" size="sm" onClick={() => setStep(1)}>Change</Button>
                </div>
              </div>

              {def.hasChoices && (
                <div className="flex flex-col gap-1.5 rounded-xl bg-muted p-3">
                  <div className="mb-2 flex items-center gap-2">
                    <span className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">Choices</span>
                    <span className="text-[11.5px] text-muted-foreground">value · label · color</span>
                    <div className="flex-1" />
                    <Button size="xs" variant="outline" icon={I.Plus} onClick={addChoice}>Add</Button>
                  </div>
                  {choices.length === 0 && (
                    <div className="p-2 text-xs text-muted-foreground">No choices yet — click “Add”. The value is what the column stores.</div>
                  )}
                  <div className="flex flex-col gap-1.5">
                    {choices.map((c, i) => (
                      <div key={i} className="flex flex-wrap items-center gap-1.5">
                        <Input className="min-w-[7.5rem] flex-1" placeholder="value" value={c.value} onChange={(e) => setChoice(i, { value: e.target.value })} />
                        <Input className="min-w-[7.5rem] flex-1" placeholder="label (optional)" value={c.label ?? ""} onChange={(e) => setChoice(i, { label: e.target.value })} />
                        <input type="color" value={c.color ?? "#A1A6B8"} onChange={(e) => setChoice(i, { color: e.target.value })} className="h-[30px] w-16 shrink-0 cursor-pointer rounded-[6px] border border-border bg-card" />
                        <IconButton icon={I.Trash} title="Remove choice" onClick={() => removeChoice(i)} />
                      </div>
                    ))}
                  </div>
                  {missingChoices && <span className="text-[11.5px] text-destructive">A dropdown needs at least one choice.</span>}
                </div>
              )}

              {def.hasRelation && (
                <div className="flex flex-col gap-1.5">
                  <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">References collection</label>
                  <Select value={relationTarget} onChange={setRelationTarget} options={relationOptions} placeholder="Pick a collection…" />
                  <span className="text-[11.5px] text-muted-foreground">
                    Stores the target row's <span className="font-mono">id</span>.
                    {missingRelation && <span className="text-destructive"> Required.</span>}
                  </span>
                </div>
              )}

              <div className="flex flex-col gap-1.5">
                <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">Default value <span className="text-muted-foreground">(optional)</span></label>
                <Input
                  value={defaultValue}
                  onChange={(e) => setDefaultValue(e.target.value)}
                  placeholder={def.type === "integer" || def.type === "number" ? "0" : def.type === "boolean" ? "false" : def.type === "timestamp" ? "now()" : ""}
                />
              </div>
            </div>

            <div className="flex flex-col gap-2.5">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">Required</div>
                  <div className="text-[11.5px] text-muted-foreground">NOT NULL — adding to a table that already has rows needs a default.</div>
                </div>
                <Switch checked={!nullable} onChange={(v) => setNullable(!v)} />
              </div>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">Unique</div>
                  <div className="text-[11.5px] text-muted-foreground">UNIQUE constraint at the column level.</div>
                </div>
                <Switch checked={unique} onChange={setUnique} />
              </div>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">Indexed</div>
                  <div className="text-[11.5px] text-muted-foreground">B-tree index — speeds up filter/sort by this column.</div>
                </div>
                <Switch checked={indexed} onChange={setIndexed} />
              </div>

              <div className="mt-1.5">
                <div className="mb-1.5 flex items-center gap-2 text-[12.5px] font-medium text-foreground">DDL preview</div>
                <AlterPreview pendingField={{ name: safeName || "new_field", type: def.type as never, nullable, default: defaultValue }} />
              </div>
            </div>
          </div>
        )}

        <div className="flex items-center gap-2 border-t border-border bg-[color-mix(in_oklch,var(--muted)_30%,var(--card))] px-4 py-3">
          <span className="text-xs text-muted-foreground">
            {step === 1
              ? <>Pick a UI interface · {FIELD_INTERFACES.length} available across {INTERFACE_GROUPS.length} groups</>
              : valid
                ? <>Will run on save.</>
                : nameTaken
                  ? <>Name conflicts with an existing column.</>
                  : missingChoices
                    ? <>Add at least one dropdown choice.</>
                    : missingRelation
                      ? <>Pick the collection this relation points to.</>
                      : <>Enter a name to continue.</>}
          </span>
          <div className="flex-1" />
          {step === 2 && <Button variant="ghost" size="sm" onClick={() => setStep(1)} icon={I.ChevronLeft}>Back</Button>}
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          {step === 1 ? (
            <Button variant="primary" size="sm" iconRight={I.ChevronRight} onClick={() => setStep(2)}>Next</Button>
          ) : (
            <Button variant="primary" size="sm" icon={I.Check} disabled={!valid} onClick={submit}>Add column</Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
