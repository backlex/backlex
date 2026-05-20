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
import { Input } from "@workeros/ui/components/input";
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
    <div
      className="fixed inset-0 z-[70] grid animate-in place-items-center bg-[oklch(0_0_0/0.45)] backdrop-blur-[2px] fade-in-0 duration-150"
      onClick={onClose}
    >
      <div
        className="relative flex max-h-[min(86vh,720px)] w-[92vw] max-w-[640px] animate-in flex-col overflow-hidden rounded-2xl border border-border bg-card text-foreground shadow-[0_24px_60px_oklch(0_0_0/0.22),0_2px_8px_oklch(0_0_0/0.08)] fade-in-0 zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 border-b border-border px-5 pb-3.5 pt-[18px]">
          <div className="flex flex-1 flex-col gap-1">
            <div className="text-base font-semibold tracking-[-0.01em]">
              Edit <span className="font-mono">{draft.name}</span>{" "}
              <Badge variant="outline" mono>{draft.type}</Badge>
            </div>
            <div className="text-[12.5px] text-muted-foreground">
              Name and type are immutable — drop &amp; re-add the column to change them.
            </div>
          </div>
          <IconButton icon={I.X} onClick={onClose} />
        </div>

        <div className="flex flex-col gap-3.5 p-[18px]">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">Required</div>
              <div className="text-[11.5px] text-muted-foreground">Reject inserts/updates that omit this column.</div>
            </div>
            <Switch checked={!!draft.required} onChange={(v) => setDraft((d) => d ? { ...d, required: v } : d)} />
          </div>

          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">Unique</div>
              <div className="text-[11.5px] text-muted-foreground">No two rows can hold the same value (case-sensitive).</div>
            </div>
            <Switch checked={!!draft.unique} onChange={(v) => setDraft((d) => d ? { ...d, unique: v } : d)} />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">Interface</label>
            <Select
              value={draft.interface ?? ""}
              onChange={(v) => setDraft((d) => d ? { ...d, interface: (v || undefined) } : d)}
              options={interfaceOpts}
              searchable
            />
            <span className="text-[11.5px] text-muted-foreground">
              Changes how the value is edited in the item form. Selection interfaces (dropdown, radio, checkboxes…) also enforce their choices server-side.
            </span>
          </div>

          {wantsChoices && (
            <div className="flex flex-col gap-1.5 rounded-xl bg-muted p-3">
              <div className="mb-2 flex items-center gap-2">
                <span className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">Choices</span>
                <span className="text-[11.5px] text-muted-foreground">
                  value · label · color (CSS)
                </span>
                <div className="flex-1" />
                <Button size="xs" variant="outline" icon={I.Plus} onClick={addChoice}>Add choice</Button>
              </div>

              {choices.length === 0 && (
                <div className="p-2 text-xs text-muted-foreground">
                  No choices yet. Click "Add choice" — value is what the column stores.
                </div>
              )}

              <div className="flex flex-col gap-1.5">
                {choices.map((c, i) => (
                  <div key={i} className="grid grid-cols-[1fr_1fr_90px_32px] items-center gap-1.5">
                    <Input
                      placeholder="value"
                      value={c.value}
                      onChange={(e) => setChoice(i, { value: e.target.value })}
                    />
                    <Input
                      placeholder="label (optional)"
                      value={c.label ?? ""}
                      onChange={(e) => setChoice(i, { label: e.target.value })}
                    />
                    <input
                      type="color"
                      value={c.color ?? "#A1A6B8"}
                      onChange={(e) => setChoice(i, { color: e.target.value })}
                      className="h-8 w-full cursor-pointer rounded-[6px] border border-border bg-card"
                    />
                    <IconButton icon={I.Trash} title="Remove choice" onClick={() => removeChoice(i)} />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-border px-[18px] py-3">
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="sm" onClick={submit}>Save field</Button>
        </div>
      </div>
    </div>
  );
}
