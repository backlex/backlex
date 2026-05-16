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
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog dialog-lg" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 760, width: "94vw", display: "flex", flexDirection: "column", maxHeight: "92vh" }}>
        <div className="dialog-head">
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <div style={{ fontSize: 16, fontWeight: 600, letterSpacing: "-0.01em" }}>Add field to <span className="font-mono">c_{schema?.slug || "posts"}</span></div>
            <div className="muted" style={{ fontSize: 12.5 }}>Pick an interface, name the column — additive ALTER TABLE, no existing rows are rewritten.</div>
          </div>
          <IconButton icon={I.X} onClick={onClose} />
        </div>

        <div className="addfield-stepper">
          <div className={`step ${step >= 1 ? "on" : ""}`}><span className="num">1</span> Interface</div>
          <div className="step-line" />
          <div className={`step ${step >= 2 ? "on" : ""}`}><span className="num">2</span> Settings</div>
        </div>

        {step === 1 && (
          <div className="addfield-body">
            <div className="search-input" style={{ marginBottom: 14 }}>
              <I.Search size={14} />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={`Search ${FIELD_INTERFACES.length} interfaces — input, markdown, dropdown, relation…`}
              />
            </div>
            {groups.length === 0 && (
              <div className="muted" style={{ fontSize: 12.5, padding: "16px 4px" }}>No interface matches “{query}”.</div>
            )}
            {groups.map(({ group, items }) => (
              <div key={group} style={{ marginBottom: 18 }}>
                <div className="addfield-group-head">
                  <span>{group}</span>
                  <span className="muted tabular-nums" style={{ fontSize: 11 }}>{items.length}</span>
                  <div className="line" />
                </div>
                <div className="addfield-types">
                  {items.map((t) => {
                    const Ic = (I as Record<string, IconComponent>)[t.icon as IconKey] || I.Code;
                    return (
                      <button key={t.id} type="button" className={`type-card ${interfaceId === t.id ? "active" : ""}`} onClick={() => pickInterface(t.id)} title={t.sub}>
                        <span className="type-icon"><Ic size={14} /></span>
                        <span className="type-label">{t.label}</span>
                        <span className="type-sub">{t.sub}</span>
                        <span className="type-sql font-mono">{t.type}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}

        {step === 2 && (
          <div className="addfield-body cols-2">
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div className="field">
                <label className="field-label">Name</label>
                <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="reading_time_minutes" />
                <span className="field-hint font-mono" style={{ fontSize: 11 }}>
                  column: <span style={{ color: nameTaken ? "var(--destructive)" : "var(--foreground)" }}>{safeName || "—"}</span>
                  {nameTaken && <span style={{ color: "var(--destructive)" }}> · already exists</span>}
                </span>
              </div>

              <div className="field">
                <label className="field-label">Interface</label>
                <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", border: "1px solid var(--border)", borderRadius: "var(--radius-3xl)", background: "var(--card)" }}>
                  <Icon size={14} />
                  <span style={{ fontSize: 13, fontWeight: 500 }}>{def.label}</span>
                  <Badge variant="outline" mono>{def.type}</Badge>
                  <span className="muted" style={{ fontSize: 12 }}>· {def.sub}</span>
                  <div className="spacer" />
                  <Button variant="ghost" size="sm" onClick={() => setStep(1)}>Change</Button>
                </div>
              </div>

              {def.hasChoices && (
                <div className="field" style={{ background: "var(--muted)", padding: 12, borderRadius: "var(--radius-xl)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                    <span className="field-label" style={{ marginBottom: 0 }}>Choices</span>
                    <span className="muted" style={{ fontSize: 11.5 }}>value · label · color</span>
                    <div className="spacer" />
                    <Button size="xs" variant="outline" icon={I.Plus} onClick={addChoice}>Add</Button>
                  </div>
                  {choices.length === 0 && (
                    <div className="muted" style={{ fontSize: 12, padding: 8 }}>No choices yet — click “Add”. The value is what the column stores.</div>
                  )}
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {choices.map((c, i) => (
                      <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 1fr 64px 30px", gap: 6, alignItems: "center" }}>
                        <Input placeholder="value" value={c.value} onChange={(e) => setChoice(i, { value: e.target.value })} />
                        <Input placeholder="label (optional)" value={c.label ?? ""} onChange={(e) => setChoice(i, { label: e.target.value })} />
                        <input type="color" value={c.color ?? "#A1A6B8"} onChange={(e) => setChoice(i, { color: e.target.value })} style={{ height: 30, width: "100%", borderRadius: 6, border: "1px solid var(--border)", background: "var(--card)", cursor: "pointer" }} />
                        <IconButton icon={I.Trash} title="Remove choice" onClick={() => removeChoice(i)} />
                      </div>
                    ))}
                  </div>
                  {missingChoices && <span className="field-hint" style={{ color: "var(--destructive)" }}>A dropdown needs at least one choice.</span>}
                </div>
              )}

              {def.hasRelation && (
                <div className="field">
                  <label className="field-label">References collection</label>
                  <Select value={relationTarget} onChange={setRelationTarget} options={relationOptions} placeholder="Pick a collection…" />
                  <span className="field-hint">
                    Stores the target row's <span className="font-mono">id</span>.
                    {missingRelation && <span style={{ color: "var(--destructive)" }}> Required.</span>}
                  </span>
                </div>
              )}

              <div className="field">
                <label className="field-label">Default value <span className="muted">(optional)</span></label>
                <Input
                  value={defaultValue}
                  onChange={(e) => setDefaultValue(e.target.value)}
                  placeholder={def.type === "integer" || def.type === "number" ? "0" : def.type === "boolean" ? "false" : def.type === "timestamp" ? "now()" : ""}
                />
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div className="field-row">
                <div>
                  <div className="field-label">Required</div>
                  <div className="field-hint">NOT NULL — adding to a table that already has rows needs a default.</div>
                </div>
                <Switch checked={!nullable} onChange={(v) => setNullable(!v)} />
              </div>
              <div className="field-row">
                <div>
                  <div className="field-label">Unique</div>
                  <div className="field-hint">UNIQUE constraint at the column level.</div>
                </div>
                <Switch checked={unique} onChange={setUnique} />
              </div>
              <div className="field-row">
                <div>
                  <div className="field-label">Indexed</div>
                  <div className="field-hint">B-tree index — speeds up filter/sort by this column.</div>
                </div>
                <Switch checked={indexed} onChange={setIndexed} />
              </div>

              <div style={{ marginTop: 6 }}>
                <div className="field-label" style={{ marginBottom: 6 }}>DDL preview</div>
                <AlterPreview pendingField={{ name: safeName || "new_field", type: def.type as never, nullable, default: defaultValue }} />
              </div>
            </div>
          </div>
        )}

        <div className="dialog-foot">
          <span className="muted" style={{ fontSize: 12 }}>
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
          <div className="spacer" />
          {step === 2 && <Button variant="ghost" size="sm" onClick={() => setStep(1)} icon={I.ChevronLeft}>Back</Button>}
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          {step === 1 ? (
            <Button variant="primary" size="sm" iconRight={I.ChevronRight} onClick={() => setStep(2)}>Next</Button>
          ) : (
            <Button variant="primary" size="sm" icon={I.Check} disabled={!valid} onClick={submit}>Add column</Button>
          )}
        </div>
      </div>
    </div>
  );
}
