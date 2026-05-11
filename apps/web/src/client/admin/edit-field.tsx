// @ts-nocheck
// Edit-field dialog: change a user-defined column's settings without
// renaming or retyping it (those need DDL changes the backend doesn't yet
// support). Covers required/unique flags, the interface override (drawn from
// the Directus-style catalog, filtered to interfaces compatible with this
// column's storage type), and the per-choice metadata used by selection
// interfaces — same shape that admin/sheet.tsx and admin/items.tsx consume to
// render Selects + badges.
import { useEffect, useMemo, useState } from "react";
import { I } from "./icons";
import { Badge, Button, IconButton, Switch } from "./ui";
import { Select } from "./select";
import { getInterface, interfacesForType } from "./interfaces";

interface FieldChoice {
  value: string;
  label?: string;
  color?: string;
}

interface FieldDraft {
  name: string;
  type: string;
  required?: boolean;
  unique?: boolean;
  interface?: string;
  options?: { choices?: FieldChoice[]; values?: string[] };
}

export interface EditFieldDialogProps {
  open: boolean;
  field: FieldDraft | null;
  onClose: () => void;
  onSave: (next: FieldDraft) => void;
}

export function EditFieldDialog({ open, field, onClose, onSave }: EditFieldDialogProps) {
  const [draft, setDraft] = useState<FieldDraft | null>(field);

  // Re-seed every time the dialog opens with a new target field.
  useEffect(() => {
    if (!open) return;
    if (!field) {
      setDraft(null);
      return;
    }
    // Coerce legacy options.values into the choices shape so the editor
    // doesn't lose data when re-saving an old field.
    const seeded: FieldDraft = {
      ...field,
      options: field.options?.choices?.length
        ? field.options
        : field.options?.values?.length
          ? { choices: field.options.values.map((v) => ({ value: v })) }
          : field.options,
    };
    setDraft(seeded);
  }, [open, field]);

  // Interface-override options: "Default (auto)" plus every catalog interface
  // whose storage type matches this column. Always keep the field's current
  // interface available even if it predates the catalog.
  const interfaceOpts = useMemo(() => {
    if (!draft) return [{ value: "", label: "Default (auto)" }];
    const compatible = interfacesForType(draft.type);
    const cur = draft.interface ? getInterface(draft.interface) : undefined;
    const all = cur && !compatible.some((i) => i.id === cur.id) ? [cur, ...compatible] : compatible;
    return [
      { value: "", label: "Default (auto)" },
      ...all.map((i) => ({
        value: i.id,
        label: `${i.label} — ${i.sub}`,
        ...(i.hasChoices ? { badge: <Badge variant="outline">choices</Badge> } : {}),
      })),
    ];
  }, [draft?.type, draft?.interface]);

  if (!open || !draft) return null;

  const wantsChoices = !!getInterface(draft.interface)?.hasChoices;
  const choices = draft.options?.choices ?? [];

  const setChoice = (i: number, patch: Partial<FieldChoice>) => {
    setDraft((d) => {
      if (!d) return d;
      const next = [...(d.options?.choices ?? [])];
      next[i] = { ...next[i], ...patch } as FieldChoice;
      return { ...d, options: { ...(d.options ?? {}), choices: next } };
    });
  };
  const addChoice = () => {
    setDraft((d) => d ? { ...d, options: { ...(d.options ?? {}), choices: [...(d.options?.choices ?? []), { value: "" }] } } : d);
  };
  const removeChoice = (i: number) => {
    setDraft((d) => {
      if (!d) return d;
      const next = [...(d.options?.choices ?? [])];
      next.splice(i, 1);
      return { ...d, options: { ...(d.options ?? {}), choices: next } };
    });
  };

  const submit = () => {
    if (!draft) return;
    // Strip empty-value choices on save so a half-typed row doesn't fail the
    // server validator; drop options entirely for interfaces that don't use
    // choices.
    const cleaned: FieldDraft = {
      ...draft,
      options: wantsChoices
        ? { choices: (draft.options?.choices ?? []).filter((c) => c.value.trim()) }
        : undefined,
      interface: draft.interface || undefined,
    };
    onSave(cleaned);
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog dialog-lg" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 640, width: "92vw" }}>
        <div className="dialog-head">
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <div style={{ fontSize: 16, fontWeight: 600, letterSpacing: "-0.01em" }}>
              Edit <span className="font-mono">{draft.name}</span>{" "}
              <Badge variant="outline" mono>{draft.type}</Badge>
            </div>
            <div className="muted" style={{ fontSize: 12.5 }}>
              Name and type are immutable — drop &amp; re-add the column to change them.
            </div>
          </div>
          <IconButton icon={I.X} onClick={onClose} />
        </div>

        <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 14 }}>
          <div className="field-row">
            <div>
              <div className="field-label">Required</div>
              <div className="field-hint">Reject inserts/updates that omit this column.</div>
            </div>
            <Switch checked={!!draft.required} onChange={(v) => setDraft((d) => d ? { ...d, required: v } : d)} />
          </div>

          <div className="field-row">
            <div>
              <div className="field-label">Unique</div>
              <div className="field-hint">No two rows can hold the same value (case-sensitive).</div>
            </div>
            <Switch checked={!!draft.unique} onChange={(v) => setDraft((d) => d ? { ...d, unique: v } : d)} />
          </div>

          <div className="field">
            <label className="field-label">Interface</label>
            <Select
              value={draft.interface ?? ""}
              onChange={(v) => setDraft((d) => d ? { ...d, interface: (v || undefined) } : d)}
              options={interfaceOpts}
              searchable
            />
            <span className="field-hint">
              Changes how the value is edited in the item form. Selection interfaces (dropdown, radio, checkboxes…) also enforce their choices server-side.
            </span>
          </div>

          {wantsChoices && (
            <div className="field" style={{ background: "var(--muted)", padding: 12, borderRadius: "var(--radius-xl)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <span className="field-label" style={{ marginBottom: 0 }}>Choices</span>
                <span className="muted" style={{ fontSize: 11.5 }}>
                  value · label · color (CSS)
                </span>
                <div className="spacer" />
                <Button size="xs" variant="outline" icon={I.Plus} onClick={addChoice}>Add choice</Button>
              </div>

              {choices.length === 0 && (
                <div className="muted" style={{ fontSize: 12, padding: 8 }}>
                  No choices yet. Click "Add choice" — value is what the column stores.
                </div>
              )}

              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {choices.map((c, i) => (
                  <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 1fr 90px 32px", gap: 6, alignItems: "center" }}>
                    <input
                      className="input"
                      placeholder="value"
                      value={c.value}
                      onChange={(e) => setChoice(i, { value: e.target.value })}
                    />
                    <input
                      className="input"
                      placeholder="label (optional)"
                      value={c.label ?? ""}
                      onChange={(e) => setChoice(i, { label: e.target.value })}
                    />
                    <input
                      type="color"
                      value={c.color ?? "#A1A6B8"}
                      onChange={(e) => setChoice(i, { color: e.target.value })}
                      style={{ height: 32, width: "100%", borderRadius: 6, border: "1px solid var(--border)", background: "var(--card)", cursor: "pointer" }}
                    />
                    <IconButton icon={I.Trash} title="Remove choice" onClick={() => removeChoice(i)} />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "12px 18px", borderTop: "1px solid var(--border)" }}>
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="sm" onClick={submit}>Save field</Button>
        </div>
      </div>
    </div>
  );
}
