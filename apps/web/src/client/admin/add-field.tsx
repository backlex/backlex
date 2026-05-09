// @ts-nocheck
// Add Field dialog — schema editor for new column
import { useEffect, useMemo, useState } from "react";
import { I, type IconComponent, type IconKey } from "./icons";
import { MOCK, type CollectionSchema } from "./mock";
import { Button, IconButton, Switch } from "./ui";
import { Select } from "./select";
import { AlterPreview } from "./extras";

export const FIELD_TYPES = [
  { id: "text", label: "Text", sub: "short string", sql: "TEXT", icon: "Pencil" },
  { id: "longtext", label: "Long text", sub: "markdown / body", sql: "TEXT", icon: "Braces" },
  { id: "integer", label: "Integer", sub: "whole number", sql: "INTEGER", icon: "Code" },
  { id: "number", label: "Number", sub: "float / decimal", sql: "REAL", icon: "Code" },
  { id: "boolean", label: "Boolean", sub: "true / false", sql: "INTEGER", icon: "Check" },
  { id: "timestamp", label: "Timestamp", sub: "date + time", sql: "INTEGER", icon: "Activity" },
  { id: "uuid", label: "UUID", sub: "reference / id", sql: "TEXT", icon: "Shield" },
  { id: "json", label: "JSON", sub: "array / object", sql: "TEXT", icon: "Braces" },
  { id: "enum", label: "Enum", sub: "fixed choices", sql: "TEXT", icon: "Filter" },
  { id: "relation", label: "Relation", sub: "foreign collection", sql: "TEXT", icon: "Database" },
];

export interface AddFieldDialogProps {
  open: boolean;
  schema: CollectionSchema;
  onClose: () => void;
  onCreate: (field: Record<string, unknown>) => void;
}

export function AddFieldDialog({ open, schema, onClose, onCreate }: AddFieldDialogProps) {
  const [name, setName] = useState("");
  const [type, setType] = useState("text");
  const [nullable, setNullable] = useState(true);
  const [unique, setUnique] = useState(false);
  const [defaultValue, setDefaultValue] = useState("");
  const [enumValues, setEnumValues] = useState("draft, published, archived");
  const [relationTarget, setRelationTarget] = useState("authors");
  const [indexed, setIndexed] = useState(false);
  const [step, setStep] = useState(1);

  useEffect(() => {
    if (open) {
      setName("");
      setType("text");
      setNullable(true);
      setUnique(false);
      setDefaultValue("");
      setStep(1);
      setIndexed(false);
    }
  }, [open]);

  const safeName = useMemo(() => name.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, ""), [name]);
  const nameTaken = schema?.fields?.some((f) => f.name === safeName);
  const valid = !!safeName && !nameTaken && safeName.length >= 2;

  if (!open) return null;

  const typeMeta = FIELD_TYPES.find((t) => t.id === type)!;
  const Icon = (I as Record<string, IconComponent>)[typeMeta.icon as IconKey] || I.Code;

  const submit = () => {
    if (!valid) return;
    onCreate({
      name: safeName,
      type,
      nullable,
      unique,
      default: defaultValue || null,
      ...(type === "enum" ? { values: enumValues.split(",").map((s) => s.trim()).filter(Boolean) } : {}),
      ...(type === "relation" ? { relation: relationTarget } : {}),
      indexed,
    });
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog dialog-lg" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 720, width: "92vw" }}>
        <div className="dialog-head">
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <div style={{ fontSize: 16, fontWeight: 600, letterSpacing: "-0.01em" }}>Add field to <span className="font-mono">c_{schema?.slug || "posts"}</span></div>
            <div className="muted" style={{ fontSize: 12.5 }}>Additive ALTER TABLE — no existing rows are rewritten.</div>
          </div>
          <IconButton icon={I.X} onClick={onClose} />
        </div>

        <div className="addfield-stepper">
          <div className={`step ${step >= 1 ? "on" : ""}`}><span className="num">1</span> Type</div>
          <div className="step-line" />
          <div className={`step ${step >= 2 ? "on" : ""}`}><span className="num">2</span> Settings</div>
        </div>

        {step === 1 && (
          <div className="addfield-body">
            <div className="addfield-types">
              {FIELD_TYPES.map((t) => {
                const Ic = (I as Record<string, IconComponent>)[t.icon as IconKey] || I.Code;
                return (
                  <button key={t.id} type="button" className={`type-card ${type === t.id ? "active" : ""}`} onClick={() => setType(t.id)}>
                    <span className="type-icon"><Ic size={14} /></span>
                    <span className="type-label">{t.label}</span>
                    <span className="type-sub">{t.sub}</span>
                    <span className="type-sql font-mono">{t.sql}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="addfield-body" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div className="field">
                <label className="field-label">Name</label>
                <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="reading_time_minutes" />
                <span className="field-hint font-mono" style={{ fontSize: 11 }}>
                  column: <span style={{ color: nameTaken ? "var(--destructive)" : "var(--foreground)" }}>{safeName || "—"}</span>
                  {nameTaken && <span style={{ color: "var(--destructive)" }}> · already exists</span>}
                </span>
              </div>

              <div className="field">
                <label className="field-label">Type</label>
                <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", border: "1px solid var(--border)", borderRadius: "var(--radius-3xl)", background: "var(--card)" }}>
                  <Icon size={14} />
                  <span style={{ fontSize: 13, fontWeight: 500 }}>{typeMeta.label}</span>
                  <span className="muted" style={{ fontSize: 12 }}>· {typeMeta.sub}</span>
                  <div className="spacer" />
                  <Button variant="ghost" size="sm" onClick={() => setStep(1)}>Change</Button>
                </div>
              </div>

              {type === "enum" && (
                <div className="field">
                  <label className="field-label">Values</label>
                  <input className="input" value={enumValues} onChange={(e) => setEnumValues(e.target.value)} placeholder="draft, published, archived" />
                  <span className="field-hint">Comma-separated. CHECK constraint will be added.</span>
                </div>
              )}

              {type === "relation" && (
                <div className="field">
                  <label className="field-label">References collection</label>
                  <Select value={relationTarget} onChange={setRelationTarget} options={(MOCK.collectionsList || []).map((c) => ({ value: c.slug, label: c.slug, hint: `${c.count} rows` }))} />
                  <span className="field-hint">Stores the target row's <span className="font-mono">id</span>.</span>
                </div>
              )}

              <div className="field">
                <label className="field-label">Default value <span className="muted">(optional)</span></label>
                <input className="input" value={defaultValue} onChange={(e) => setDefaultValue(e.target.value)} placeholder={type === "integer" || type === "number" ? "0" : type === "boolean" ? "false" : type === "timestamp" ? "now()" : ""} />
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div className="field-row">
                <div>
                  <div className="field-label">Required</div>
                  <div className="field-hint">NOT NULL — needs a default if any rows exist.</div>
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
                <AlterPreview pendingField={{ name: safeName || "new_field", type: type as never, nullable, default: defaultValue }} />
              </div>
            </div>
          </div>
        )}

        <div className="dialog-foot">
          <span className="muted" style={{ fontSize: 12 }}>
            {step === 1 ? `Pick a column type · ${FIELD_TYPES.length} available` : valid ? <>Will run on save.</> : nameTaken ? <>Name conflicts with existing column.</> : <>Enter a name to continue.</>}
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
