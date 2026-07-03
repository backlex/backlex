// @ts-nocheck
// Edit-field dialog: change a user-defined column's settings without
// renaming or retyping it (those need DDL changes the backend doesn't yet
// support). Covers required/unique flags, the interface override (drawn from
// the interface catalog, filtered to interfaces compatible with this
// column's storage type), and the per-choice metadata used by selection
// interfaces — same shape that admin/sheet.tsx and admin/items.tsx consume to
// render Selects + badges.
import { useEffect, useMemo, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { I } from "./icons";
import { Badge, Button, IconButton, Switch } from "./ui";
import { Input } from "@backlex/ui/components/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@backlex/ui/components/dialog";
import { ScrollArea } from "@backlex/ui/components/scroll-area";
import { Select } from "./select";
import { getInterface, interfacesForType } from "./interfaces";
import {
  type GroupNode,
  newGroup,
  objToTree,
  RuleBuilder,
  ruleTreeToObj,
  treeHasRule,
} from "./rule-builder";
import {
  compileValidation,
  emptyValDraft,
  FieldValidationEditor,
  type ValDraft,
  validationToDraft,
} from "./field-validation-editor";

/** One editable condition row: a rule tree + the effects it toggles. */
interface CondDraft {
  name: string;
  tree: GroupNode;
  required: boolean;
  readonly: boolean;
  hidden: boolean;
}

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
  /** Fold into the collection's full-text index (text/longtext only). */
  searchable?: boolean;
  interface?: string;
  options?: { choices?: FieldChoice[]; values?: string[] };
  conditions?: {
    name?: string;
    rule: unknown;
    required?: boolean;
    readonly?: boolean;
    hidden?: boolean;
  }[];
}

export interface EditFieldDialogProps {
  open: boolean;
  field: FieldDraft | null;
  /** Sibling field names, for the condition rule builder's field picker. */
  availableFields?: string[];
  onClose: () => void;
  onSave: (next: FieldDraft) => void;
}

export function EditFieldDialog({ open, field, availableFields = [], onClose, onSave }: EditFieldDialogProps) {
  const { t } = useLingui();
  const [draft, setDraft] = useState<FieldDraft | null>(field);
  const [conds, setConds] = useState<CondDraft[]>([]);
  const [valDraft, setValDraft] = useState<ValDraft>(emptyValDraft());

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
    // Seed the condition rows from the stored `conditions` (rule object → tree).
    setConds(
      ((field as { conditions?: any[] }).conditions ?? []).map((c) => ({
        name: c.name ?? "",
        tree: objToTree(c.rule),
        required: !!c.required,
        readonly: !!c.readonly,
        hidden: !!c.hidden,
      })),
    );
    setValDraft(validationToDraft((field as { validation?: unknown }).validation));
  }, [open, field]);

  const addCond = () =>
    setConds((cs) => [
      ...cs,
      { name: "", tree: newGroup("and"), required: true, readonly: false, hidden: false },
    ]);
  const patchCond = (i: number, patch: Partial<CondDraft>) =>
    setConds((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const removeCond = (i: number) => setConds((cs) => cs.filter((_, j) => j !== i));

  // Interface-override options: "Default (auto)" plus every catalog interface
  // whose storage type matches this column. Always keep the field's current
  // interface available even if it predates the catalog.
  const interfaceOpts = useMemo(() => {
    if (!draft) return [{ value: "", label: t`Default (auto)` }];
    const compatible = interfacesForType(draft.type);
    const cur = draft.interface ? getInterface(draft.interface) : undefined;
    const all = cur && !compatible.some((i) => i.id === cur.id) ? [cur, ...compatible] : compatible;
    return [
      { value: "", label: t`Default (auto)` },
      ...all.map((i) => ({
        value: i.id,
        label: `${i.label} — ${i.sub}`,
        // `secondary` (filled, borderless) — an `outline` badge nests a second
        // rounded border inside the Select trigger's own border.
        ...(i.hasChoices ? { badge: <Badge variant="secondary">choices</Badge> } : {}),
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
    // Only persist conditions that carry a real rule; compile each tree back to
    // the canonical Condition object the server stores + enforces.
    const conditions = conds
      .filter((c) => treeHasRule(c.tree))
      .map((c) => ({
        ...(c.name.trim() ? { name: c.name.trim() } : {}),
        rule: ruleTreeToObj(c.tree),
        ...(c.required ? { required: true } : {}),
        ...(c.readonly ? { readonly: true } : {}),
        ...(c.hidden ? { hidden: true } : {}),
      }));
    const validation = compileValidation(valDraft, draft.type);
    const cleaned: FieldDraft = {
      ...draft,
      options: wantsChoices
        ? { choices: (draft.options?.choices ?? []).filter((c) => c.value.trim()) }
        : undefined,
      interface: draft.interface || undefined,
      conditions: conditions.length ? (conditions as never) : undefined,
      validation: (validation ?? undefined) as never,
    };
    onSave(cleaned);
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="flex max-h-[min(86vh,720px)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[640px]">
        <DialogHeader className="border-b border-border px-5 pb-3.5 pr-12 pt-[18px] text-left">
          <DialogTitle className="text-base font-semibold tracking-[-0.01em]">
            <Trans>Edit <span className="font-mono">{draft.name}</span>{" "}
            <Badge variant="outline" mono>{draft.type}</Badge></Trans>
          </DialogTitle>
          <DialogDescription className="text-[12.5px]">
            <Trans>Name and type are immutable — drop &amp; re-add the column to change them.</Trans>
          </DialogDescription>
        </DialogHeader>

        <ScrollArea viewportClassName="max-h-[calc(min(86vh,720px)-10rem)] max-[640px]:max-h-[calc(min(86vh,720px)-15rem)]">
        <div className="flex flex-col gap-3.5 p-[18px]">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Required</Trans></div>
              <div className="text-[11.5px] text-muted-foreground"><Trans>Reject inserts/updates that omit this column.</Trans></div>
            </div>
            <Switch checked={!!draft.required} onChange={(v) => setDraft((d) => d ? { ...d, required: v } : d)} />
          </div>

          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Unique</Trans></div>
              <div className="text-[11.5px] text-muted-foreground"><Trans>No two rows can hold the same value (case-sensitive).</Trans></div>
            </div>
            <Switch checked={!!draft.unique} onChange={(v) => setDraft((d) => d ? { ...d, unique: v } : d)} />
          </div>

          {(draft.type === "text" || draft.type === "longtext") && (
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Searchable</Trans></div>
                <div className="text-[11.5px] text-muted-foreground"><Trans>Fold this field into the collection's full-text-search index (when FTS is enabled). Re-index after changing.</Trans></div>
              </div>
              <Switch checked={!!draft.searchable} onChange={(v) => setDraft((d) => d ? { ...d, searchable: v } : d)} />
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Interface</Trans></label>
            <Select
              value={draft.interface ?? ""}
              onChange={(v) => setDraft((d) => d ? { ...d, interface: (v || undefined) } : d)}
              options={interfaceOpts}
              searchable
            />
            <span className="text-[11.5px] text-muted-foreground">
              <Trans>Changes how the value is edited in the item form. Selection interfaces (dropdown, radio, checkboxes…) also enforce their choices server-side.</Trans>
            </span>
          </div>

          {wantsChoices && (
            <div className="flex flex-col gap-1.5 rounded-xl bg-muted p-3">
              <div className="mb-2 flex items-center gap-2">
                <span className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Choices</Trans></span>
                <span className="text-[11.5px] text-muted-foreground">
                  <Trans>value · label · color (CSS)</Trans>
                </span>
                <div className="flex-1" />
                <Button size="xs" variant="outline" icon={I.Plus} onClick={addChoice}><Trans>Add choice</Trans></Button>
              </div>

              {choices.length === 0 && (
                <div className="p-2 text-xs text-muted-foreground">
                  <Trans>No choices yet. Click "Add choice" — value is what the column stores.</Trans>
                </div>
              )}

              <div className="flex flex-col gap-1.5">
                {choices.map((c, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-1.5">
                    <Input
                      className="min-w-[7.5rem] flex-1"
                      placeholder={t`value`}
                      value={c.value}
                      onChange={(e) => setChoice(i, { value: e.target.value })}
                    />
                    <Input
                      className="min-w-[7.5rem] flex-1"
                      placeholder={t`label (optional)`}
                      value={c.label ?? ""}
                      onChange={(e) => setChoice(i, { label: e.target.value })}
                    />
                    {/* Clean design-system swatch — the native color input is
                        overlaid invisibly so the control matches the other
                        inputs instead of the browser's chunky default swatch. */}
                    <label
                      className="relative inline-flex h-8 w-14 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-md border border-border ring-offset-background focus-within:ring-2 focus-within:ring-ring/50"
                      title={t`Choice color`}
                      style={{ backgroundColor: c.color ?? "#A1A6B8" }}
                    >
                      <input
                        type="color"
                        value={c.color ?? "#A1A6B8"}
                        onChange={(e) => setChoice(i, { color: e.target.value })}
                        className="absolute inset-0 size-full cursor-pointer opacity-0"
                        aria-label={t`Choice color`}
                      />
                    </label>
                    <IconButton icon={I.Trash} title={t`Remove choice`} onClick={() => removeChoice(i)} />
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="flex flex-col gap-2 rounded-xl bg-muted p-3">
            <div className="flex items-center gap-2">
              <span className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Conditions</Trans></span>
              <div className="flex-1" />
              <Button size="xs" variant="outline" icon={I.Plus} onClick={addCond}><Trans>Add condition</Trans></Button>
            </div>
            <div className="text-[11.5px] text-muted-foreground">
              <Trans>When the rule matches the row, apply the effects. <span className="font-medium text-foreground">Required</span> is enforced on save (422); Readonly/Hidden affect the item form.</Trans>
            </div>

            {conds.length === 0 && (
              <div className="p-2 text-xs text-muted-foreground">
                <Trans>No conditions. Click "Add condition" to make this field required/readonly/hidden based on other fields.</Trans>
              </div>
            )}

            {conds.map((c, i) => (
              <div key={i} className="flex flex-col gap-2 rounded-lg border border-border bg-card p-2.5">
                <div className="flex items-center gap-2">
                  <Input
                    className="h-8 flex-1"
                    placeholder={t`Condition name (optional)`}
                    value={c.name}
                    onChange={(e) => patchCond(i, { name: e.target.value })}
                  />
                  <IconButton icon={I.Trash} title={t`Remove condition`} onClick={() => removeCond(i)} />
                </div>
                <RuleBuilder
                  tree={c.tree}
                  onChange={(tree) => patchCond(i, { tree })}
                  fields={availableFields}
                />
                <div className="flex flex-wrap items-center gap-x-5 gap-y-2 pt-0.5">
                  <label className="flex cursor-pointer items-center gap-2 text-[12.5px] text-foreground">
                    <Switch checked={c.required} onChange={(v) => patchCond(i, { required: v })} />
                    <Trans>Required</Trans>
                  </label>
                  <label className="flex cursor-pointer items-center gap-2 text-[12.5px] text-foreground">
                    <Switch checked={c.readonly} onChange={(v) => patchCond(i, { readonly: v })} />
                    <Trans>Readonly</Trans>
                  </label>
                  <label className="flex cursor-pointer items-center gap-2 text-[12.5px] text-foreground">
                    <Switch checked={c.hidden} onChange={(v) => patchCond(i, { hidden: v })} />
                    <Trans>Hidden</Trans>
                  </label>
                </div>
              </div>
            ))}
          </div>

          <FieldValidationEditor
            type={draft.type}
            fields={availableFields}
            value={valDraft}
            onChange={setValDraft}
          />
        </div>
        </ScrollArea>

        <DialogFooter className="border-t border-border px-[18px] py-3">
          <Button variant="ghost" size="sm" onClick={onClose}><Trans>Cancel</Trans></Button>
          <Button variant="primary" size="sm" onClick={submit}><Trans>Save field</Trans></Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
