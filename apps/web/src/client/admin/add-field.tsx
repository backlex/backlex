// @ts-nocheck
// Add Field dialog — schema editor for a new column.
// Step 1 picks a UI *interface* from a categorized catalog (interfaces.ts);
// each interface maps to one of the physical storage types the backend
// supports. Step 2 is a Directus-style tabbed editor (Schema · Relationship ·
// Field · Interface · Validation · Conditions) capturing the column name,
// interface-specific options, constraints, help text, validation + conditions.
import { useEffect, useMemo, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { I, type IconComponent, type IconKey } from "./icons";
import { type CollectionSchema } from "./config";
import { Badge, Button, IconButton, Switch } from "./ui";
import { Input } from "@backlex/ui/components/input";
import { Textarea } from "@backlex/ui/components/textarea";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@backlex/ui/components/input-group";
import { ScrollArea } from "@backlex/ui/components/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@backlex/ui/components/dialog";
import { Select } from "./select";
import { AlterPreview } from "./extras";
import { FieldTabLayout, type FieldTabItem } from "./field-editor-tabs";
import {
  FIELD_INTERFACES,
  INTERFACE_GROUPS,
  getInterface,
  matchesInterfaceQuery,
} from "./interfaces";
import {
  type GroupNode,
  newGroup,
  RuleBuilder,
  ruleTreeToObj,
  treeHasRule,
} from "./rule-builder";
import {
  compileValidation,
  emptyValDraft,
  FieldValidationEditor,
  type ValDraft,
} from "./field-validation-editor";
import {
  cleanFormat,
  FieldFormatEditor,
  type FieldFormatDraft,
} from "./field-format-editor";
import { cleanTranslations, FieldTranslationsEditor } from "./field-translations-editor";
import { canLocalize } from "./item-form";

/** One editable condition row: a rule tree + the effects it toggles. */
interface CondDraft {
  name: string;
  tree: GroupNode;
  required: boolean;
  readonly: boolean;
  hidden: boolean;
}

// Kept for back-compat with anything that imported the old flat list.
export const FIELD_TYPES = FIELD_INTERFACES;

/** Storage types that accept a literal column DEFAULT (mirrors DEFAULTABLE in
 *  @backlex/db). Others hide the default input — the value wouldn't persist. */
const DEFAULTABLE_TYPES = new Set(["text", "longtext", "integer", "number", "boolean"]);

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
  const { t } = useLingui();
  const [name, setName] = useState("");
  const [interfaceId, setInterfaceId] = useState("input");
  const [query, setQuery] = useState("");
  const [nullable, setNullable] = useState(true);
  const [unique, setUnique] = useState(false);
  const [defaultValue, setDefaultValue] = useState("");
  const [choices, setChoices] = useState(DEFAULT_CHOICES);
  const [relationTarget, setRelationTarget] = useState("");
  const [indexed, setIndexed] = useState(false);
  const [searchable, setSearchable] = useState(false);
  const [vectorize, setVectorize] = useState(false);
  const [localized, setLocalized] = useState(false);
  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");
  const [isPrivate, setIsPrivate] = useState(false);
  const [autoCreate, setAutoCreate] = useState("");
  const [autoUpdate, setAutoUpdate] = useState("");
  const [onDelete, setOnDelete] = useState("no_action");
  const [formatDraft, setFormatDraft] = useState<FieldFormatDraft>({});
  const [translations, setTranslations] = useState<Record<string, string>>({});
  const [step, setStep] = useState(1);
  const [tab, setTab] = useState("schema");
  const [conds, setConds] = useState<CondDraft[]>([]);
  const [valDraft, setValDraft] = useState<ValDraft>(emptyValDraft());

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
      setTab("schema");
      setIndexed(false);
      setSearchable(false);
      setLocalized(false);
      setLabel("");
      setDescription("");
      setIsPrivate(false);
      setAutoCreate("");
      setAutoUpdate("");
      setOnDelete("no_action");
      setFormatDraft({});
      setTranslations({});
      setConds([]);
      setValDraft(emptyValDraft());
    }
  }, [open]);

  const availableFields = useMemo(
    () => (schema?.fields ?? []).map((f) => (f as { name?: string }).name).filter((n): n is string => !!n),
    [schema],
  );
  const addCond = () =>
    setConds((cs) => [...cs, { name: "", tree: newGroup("and"), required: true, readonly: false, hidden: false }]);
  const patchCond = (i: number, patch: Partial<CondDraft>) =>
    setConds((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const removeCond = (i: number) => setConds((cs) => cs.filter((_, j) => j !== i));

  const safeName = useMemo(
    () => name.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, ""),
    [name],
  );
  const nameTaken = schema?.fields?.some((f) => f.name === safeName);

  const def = getInterface(interfaceId) ?? FIELD_INTERFACES[0];
  const Icon = (I as Record<string, IconComponent>)[def.icon as IconKey] || I.Code;
  const defaultable = DEFAULTABLE_TYPES.has(def.type);

  // Server-side auto-fill options valid for this column's storage type.
  const autoFillOpts = (withUuid: boolean) => {
    const o: Array<{ value: string; label: string }> = [{ value: "", label: t`Do nothing` }];
    if (withUuid && (def.type === "uuid" || def.type === "text")) o.push({ value: "uuid", label: "UUID" });
    if (def.type === "timestamp") o.push({ value: "now", label: t`Current date/time` });
    if (def.type === "text" || def.type === "uuid") {
      o.push({ value: "user", label: t`Current user` });
      o.push({ value: "tenant", label: t`Current tenant` });
    }
    return o;
  };
  const createOpts = autoFillOpts(true);
  const updateOpts = autoFillOpts(false);
  const validCreate = createOpts.some((o) => o.value === autoCreate) ? autoCreate : "";
  const validUpdate = updateOpts.some((o) => o.value === autoUpdate) ? autoUpdate : "";

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
  const nameInvalid = !safeName || nameTaken || safeName.length < 2;
  const valid = !nameInvalid && !missingChoices && !missingRelation;

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

  const coerceDefault = (): string | number | boolean | undefined => {
    const s = defaultValue.trim();
    if (!s) return undefined;
    if (def.type === "integer" || def.type === "number") {
      const n = Number(s);
      return Number.isFinite(n) ? n : undefined;
    }
    if (def.type === "boolean") return s === "true" || s === "1";
    return s;
  };

  const submit = () => {
    if (!valid) return;
    const conditions = conds
      .filter((c) => treeHasRule(c.tree))
      .map((c) => ({
        ...(c.name.trim() ? { name: c.name.trim() } : {}),
        rule: ruleTreeToObj(c.tree),
        ...(c.required ? { required: true } : {}),
        ...(c.readonly ? { readonly: true } : {}),
        ...(c.hidden ? { hidden: true } : {}),
      }));
    const validation = compileValidation(valDraft, def.type);
    const defVal = defaultable ? coerceDefault() : undefined;
    onCreate({
      name: safeName,
      type: def.type,
      interface: def.id,
      required: !nullable,
      unique,
      indexed,
      ...(defVal !== undefined ? { default: defVal } : {}),
      ...(label.trim() ? { label: label.trim() } : {}),
      ...(description.trim() ? { description: description.trim() } : {}),
      ...(isPrivate ? { private: true } : {}),
      ...(validCreate ? { onCreate: validCreate } : {}),
      ...(validUpdate ? { onUpdate: validUpdate } : {}),
      ...(searchable && (def.type === "text" || def.type === "longtext") ? { searchable: true } : {}),
      ...(vectorize && (def.type === "text" || def.type === "longtext") ? { vectorize: true } : {}),
      ...(localized && canLocalize({ type: def.type, interface: def.id }) ? { localized: true } : {}),
      ...(def.hasChoices && cleanChoices.length ? { options: { choices: cleanChoices } } : {}),
      ...(def.hasRelation ? { to: relationTarget } : {}),
      ...(def.hasRelation && onDelete !== "no_action" ? { onDelete } : {}),
      ...(conditions.length ? { conditions } : {}),
      ...(validation ? { validation } : {}),
      ...(cleanFormat(formatDraft, def.type) ? { format: cleanFormat(formatDraft, def.type) } : {}),
      ...(cleanTranslations(translations) ? { translations: cleanTranslations(translations) } : {}),
    });
  };

  const tabs: FieldTabItem[] = [
    { key: "schema", label: t`Schema`, icon: "Database", invalid: nameInvalid },
    ...(def.hasRelation
      ? [{ key: "relationship", label: t`Relationship`, icon: "Share", invalid: missingRelation } as FieldTabItem]
      : []),
    { key: "field", label: t`Field`, icon: "Pencil" },
    { key: "interface", label: t`Interface`, icon: "Eye", invalid: missingChoices },
    { key: "validation", label: t`Validation`, icon: "Check" },
    { key: "conditions", label: t`Conditions`, icon: "Filter" },
  ];
  const activeTab = tabs.some((x) => x.key === tab) ? tab : "schema";
  // Fixed height (not max-h): the dialog is vertically centered, so a viewport
  // that grows/shrinks with the active tab makes the whole modal jump on every
  // rail click. Constant height per step keeps it anchored.
  const vp = "h-[calc(92vh-13rem)] max-[640px]:h-[calc(92vh-19rem)]";

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="flex max-h-[92vh] w-[94vw] flex-col gap-0 overflow-hidden p-0 [&>*]:min-w-0 sm:max-w-[820px]">
        <DialogHeader className="shrink-0 border-b border-border px-5 pb-3.5 pr-12 pt-[18px] text-left">
          <DialogTitle className="text-base font-semibold tracking-[-0.01em]">
            <Trans>Add field to <span className="font-mono">c_{schema?.slug || "posts"}</span></Trans>
          </DialogTitle>
          <DialogDescription className="text-[12.5px]">
            <Trans>Pick an interface, name the column — additive ALTER TABLE, no existing rows are rewritten.</Trans>
          </DialogDescription>
        </DialogHeader>

        <div className="flex shrink-0 items-center gap-2.5 border-b border-border bg-[color-mix(in_oklch,var(--muted)_30%,var(--card))] px-5 py-3 text-[12.5px]">
          <div className={`inline-flex items-center gap-2 font-medium ${step >= 1 ? "text-foreground" : "text-muted-foreground"}`}>
            <span className={`grid size-5 place-items-center rounded-full font-mono text-[11px] font-semibold ${step >= 1 ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>1</span> <Trans>Interface</Trans>
          </div>
          <div className="h-px max-w-[60px] flex-1 bg-border" />
          <div className={`inline-flex items-center gap-2 font-medium ${step >= 2 ? "text-foreground" : "text-muted-foreground"}`}>
            <span className={`grid size-5 place-items-center rounded-full font-mono text-[11px] font-semibold ${step >= 2 ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>2</span> <Trans>Settings</Trans>
          </div>
        </div>

        {step === 1 && (
          <ScrollArea viewportClassName="h-[calc(92vh-13rem)] max-[640px]:h-[calc(92vh-14.75rem)]">
            <div className="px-5 py-[18px]">
            <InputGroup className="mb-3.5">
              <InputGroupAddon><I.Search size={14} /></InputGroupAddon>
              <InputGroupInput
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t`Search ${FIELD_INTERFACES.length} interfaces — input, markdown, dropdown, relation…`}
              />
            </InputGroup>
            {groups.length === 0 && (
              <div className="px-1 py-4 text-[12.5px] text-muted-foreground"><Trans>No interface matches "{query}".</Trans></div>
            )}
            {groups.map(({ group, items }) => (
              <div key={group} className="mb-[18px]">
                <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
                  <span>{group}</span>
                  <span className="tabular-nums text-[11px] text-muted-foreground">{items.length}</span>
                  <div className="ml-1 h-px flex-1 bg-border" />
                </div>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(184px,1fr))] gap-2">
                  {items.map((it) => {
                    const Ic = (I as Record<string, IconComponent>)[it.icon as IconKey] || I.Code;
                    const on = interfaceId === it.id;
                    return (
                      <button
                        key={it.id}
                        type="button"
                        className={`flex min-w-0 cursor-pointer flex-col gap-1.5 rounded-control border p-3 text-left text-foreground transition-colors ${on ? "border-[color-mix(in_oklch,var(--primary)_60%,var(--border))] bg-selected-surface" : "border-border bg-card hover:bg-accent"}`}
                        onClick={() => pickInterface(it.id)}
                        title={it.sub}
                      >
                        <span className="flex w-full min-w-0 items-center gap-2.5">
                          <span className={`grid size-7 shrink-0 place-items-center rounded-control text-foreground ${on ? "bg-icon-surface" : "bg-muted"}`}><Ic size={14} /></span>
                          <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{it.label}</span>
                        </span>
                        <span className="line-clamp-2 text-[11.5px] leading-snug text-muted-foreground">{it.sub}</span>
                        <span className="mt-auto max-w-full self-start truncate rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[10.5px] text-muted-foreground">{it.type}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
            </div>
          </ScrollArea>
        )}

        {step === 2 && (
          <FieldTabLayout tabs={tabs} active={activeTab} onSelect={setTab} viewportClassName={vp}>
            {activeTab === "schema" && (
              <div className="flex flex-col gap-3.5">
                <div className="flex flex-col gap-1.5">
                  <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Name</Trans></label>
                  <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="reading_time_minutes" />
                  <span className="font-mono text-[11px] text-muted-foreground">
                    <Trans>column: <span className={nameTaken ? "text-destructive" : "text-foreground"}>{safeName || "—"}</span></Trans>
                    {nameTaken && <span className="text-destructive"><Trans> · already exists</Trans></span>}
                  </span>
                </div>

                {defaultable && (
                  <div className="flex flex-col gap-1.5">
                    <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Default value <span className="text-muted-foreground">(optional)</span></Trans></label>
                    <Input
                      value={defaultValue}
                      onChange={(e) => setDefaultValue(e.target.value)}
                      placeholder={def.type === "integer" || def.type === "number" ? "0" : def.type === "boolean" ? "false" : ""}
                    />
                    <span className="text-[11.5px] text-muted-foreground"><Trans>Used when an insert omits this column. Written into the DDL as a column DEFAULT.</Trans></span>
                  </div>
                )}

                <div className="flex flex-col gap-2.5">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Required</Trans></div>
                      <div className="text-[11.5px] text-muted-foreground"><Trans>NOT NULL — adding to a table that already has rows needs a default.</Trans></div>
                    </div>
                    <Switch checked={!nullable} onChange={(v) => setNullable(!v)} />
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Unique</Trans></div>
                      <div className="text-[11.5px] text-muted-foreground"><Trans>UNIQUE constraint at the column level.</Trans></div>
                    </div>
                    <Switch checked={unique} onChange={setUnique} />
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Indexed</Trans></div>
                      <div className="text-[11.5px] text-muted-foreground"><Trans>B-tree index — speeds up filter/sort by this column.</Trans></div>
                    </div>
                    <Switch checked={indexed} onChange={setIndexed} />
                  </div>
                  {(() => {
                    const localizable = canLocalize({ type: def.type, interface: def.id });
                    return (
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Localized</Trans></div>
                          <div className="text-[11.5px] text-muted-foreground">
                            {localizable ? (
                              <Trans>Store one value per language in the translations sidecar. Read/write a single locale with ?locale=xx.</Trans>
                            ) : (
                              <Trans>Localization applies to text, number, choice, date, and color fields — not relations, files, IDs, or JSON.</Trans>
                            )}
                          </div>
                        </div>
                        <Switch
                          checked={localized && localizable}
                          disabled={!localizable}
                          onChange={(v) => {
                            setLocalized(v);
                            if (v) setUnique(false);
                          }}
                        />
                      </div>
                    );
                  })()}
                  {(def.type === "text" || def.type === "longtext") && (
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Searchable</Trans></div>
                        <div className="text-[11.5px] text-muted-foreground"><Trans>Fold this field into the collection's full-text-search index (when FTS is enabled).</Trans></div>
                      </div>
                      <Switch checked={searchable} onChange={setSearchable} />
                    </div>
                  )}
                  {(def.type === "text" || def.type === "longtext") && (
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Vectorize</Trans></div>
                        <div className="text-[11.5px] text-muted-foreground"><Trans>Fold this field into the text embedded for vector search (when vector search is enabled).</Trans></div>
                      </div>
                      <Switch checked={vectorize} onChange={setVectorize} />
                    </div>
                  )}
                </div>

                {(createOpts.length > 1 || updateOpts.length > 1) && (
                  <div className="grid grid-cols-2 gap-3 max-[520px]:grid-cols-1">
                    {createOpts.length > 1 && (
                      <div className="flex min-w-0 flex-col gap-1.5">
                        <label className="text-[12.5px] font-medium text-foreground"><Trans>On create</Trans></label>
                        <Select value={validCreate} onChange={setAutoCreate} options={createOpts} />
                        <span className="text-[11.5px] text-muted-foreground"><Trans>Server fills this on insert; the field becomes read-only.</Trans></span>
                      </div>
                    )}
                    {updateOpts.length > 1 && (
                      <div className="flex min-w-0 flex-col gap-1.5">
                        <label className="text-[12.5px] font-medium text-foreground"><Trans>On update</Trans></label>
                        <Select value={validUpdate} onChange={setAutoUpdate} options={updateOpts} />
                        <span className="text-[11.5px] text-muted-foreground"><Trans>Server refreshes this on every update.</Trans></span>
                      </div>
                    )}
                  </div>
                )}

                <div className="mt-1.5">
                  <div className="mb-1.5 flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>DDL preview</Trans></div>
                  <AlterPreview table={`c_${schema?.slug || "collection"}`} pendingField={{ name: safeName || "new_field", type: def.type as never, nullable, default: defaultValue }} />
                </div>
              </div>
            )}

            {activeTab === "relationship" && def.hasRelation && (
              <div className="flex flex-col gap-3.5">
                <div className="flex flex-col gap-1.5">
                  <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>References collection</Trans></label>
                  <Select value={relationTarget} onChange={setRelationTarget} options={relationOptions} placeholder={t`Pick a collection…`} />
                  <span className="text-[11.5px] text-muted-foreground">
                    <Trans>Stores the target row's <span className="font-mono">id</span>.</Trans>
                    {missingRelation && <span className="text-destructive"><Trans> Required.</Trans></span>}
                  </span>
                </div>
                {def.hasRelation && (
                  <div className="flex flex-col gap-1.5">
                    <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>When the referenced item is deleted</Trans></label>
                    <Select
                      value={onDelete}
                      onChange={setOnDelete}
                      options={[
                        { value: "no_action", label: t`Do nothing` },
                        { value: "set_null", label: def.type === "relation_many" ? t`Remove it from the list` : t`Set this field to NULL` },
                        { value: "cascade", label: t`Delete this row too (cascade)` },
                      ]}
                    />
                    <span className="text-[11.5px] text-muted-foreground"><Trans>App-layer trigger — backlex has no DB foreign keys, so it's enforced on delete.</Trans></span>
                  </div>
                )}
              </div>
            )}

            {activeTab === "field" && (
              <div className="flex flex-col gap-3.5">
                <div className="flex flex-col gap-1.5">
                  <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Display name <span className="text-muted-foreground">(optional)</span></Trans></label>
                  <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={safeName || t`Reading time`} />
                  <span className="text-[11.5px] text-muted-foreground"><Trans>Label shown in the item form. Falls back to the column name.</Trans></span>
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Note <span className="text-muted-foreground">(optional)</span></Trans></label>
                  <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} placeholder={t`Add a helpful note for editors…`} />
                  <span className="text-[11.5px] text-muted-foreground"><Trans>Inline help text shown beneath the field.</Trans></span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Private</Trans></div>
                    <div className="text-[11.5px] text-muted-foreground"><Trans>Internal column — stored and writable, but never returned by the API (REST, GraphQL, CSV, changefeed).</Trans></div>
                  </div>
                  <Switch checked={isPrivate} onChange={setIsPrivate} />
                </div>
                <FieldTranslationsEditor value={translations} onChange={setTranslations} />
              </div>
            )}

            {activeTab === "interface" && (
              <div className="flex flex-col gap-3.5">
                <div className="flex flex-col gap-1.5">
                  <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Interface</Trans></label>
                  <div className="flex flex-wrap items-center gap-2 rounded-control border border-border bg-card px-3 py-2">
                    <Icon size={14} />
                    <span className="text-[13px] font-medium">{def.label}</span>
                    <Badge variant="outline" mono>{def.type}</Badge>
                    <span className="text-xs text-muted-foreground">· {def.sub}</span>
                    <div className="flex-1" />
                    <Button variant="ghost" size="sm" onClick={() => setStep(1)}><Trans>Change</Trans></Button>
                  </div>
                </div>

                {def.hasChoices && (
                  <div className="flex flex-col gap-1.5 rounded-control bg-muted p-3">
                    <div className="mb-2 flex items-center gap-2">
                      <span className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Choices</Trans></span>
                      <span className="text-[11.5px] text-muted-foreground"><Trans>value · label · color</Trans></span>
                      <div className="flex-1" />
                      <Button size="xs" variant="outline" icon={I.Plus} onClick={addChoice}><Trans>Add</Trans></Button>
                    </div>
                    {choices.length === 0 && (
                      <div className="p-2 text-xs text-muted-foreground"><Trans>No choices yet — click "Add". The value is what the column stores.</Trans></div>
                    )}
                    <div className="flex flex-col gap-1.5">
                      {choices.map((c, i) => (
                        <div key={i} className="flex flex-wrap items-center gap-1.5">
                          <Input className="min-w-[7.5rem] flex-1" placeholder={t`value`} value={c.value} onChange={(e) => setChoice(i, { value: e.target.value })} />
                          <Input className="min-w-[7.5rem] flex-1" placeholder={t`label (optional)`} value={c.label ?? ""} onChange={(e) => setChoice(i, { label: e.target.value })} />
                          <input type="color" value={c.color ?? "#A1A6B8"} onChange={(e) => setChoice(i, { color: e.target.value })} className="h-[30px] w-16 shrink-0 cursor-pointer rounded-control border border-border bg-card" />
                          <IconButton icon={I.Trash} title={t`Remove choice`} onClick={() => removeChoice(i)} />
                        </div>
                      ))}
                    </div>
                    {missingChoices && <span className="text-[11.5px] text-destructive"><Trans>A dropdown needs at least one choice.</Trans></span>}
                  </div>
                )}

                <FieldFormatEditor type={def.type} value={formatDraft} onChange={setFormatDraft} />

                {!def.hasChoices && def.type !== "integer" && def.type !== "number" && def.type !== "timestamp" && (
                  <div className="rounded-control bg-muted p-3 text-[12.5px] text-muted-foreground">
                    <Trans>This interface has no extra options. Selection interfaces (dropdown, radio…) show a choices editor here.</Trans>
                  </div>
                )}
              </div>
            )}

            {activeTab === "validation" && (
              <FieldValidationEditor type={def.type} fields={availableFields} value={valDraft} onChange={setValDraft} />
            )}

            {activeTab === "conditions" && (
              <div className="flex flex-col gap-2 rounded-control bg-muted p-3">
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
                  <div key={i} className="flex flex-col gap-2 rounded-surface border border-border bg-card p-2.5">
                    <div className="flex items-center gap-2">
                      <Input
                        className="h-8 flex-1"
                        placeholder={t`Condition name (optional)`}
                        value={c.name}
                        onChange={(e) => patchCond(i, { name: e.target.value })}
                      />
                      <IconButton icon={I.Trash} title={t`Remove condition`} onClick={() => removeCond(i)} />
                    </div>
                    <RuleBuilder tree={c.tree} onChange={(tree) => patchCond(i, { tree })} fields={availableFields} />
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
            )}
          </FieldTabLayout>
        )}

        <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border bg-[color-mix(in_oklch,var(--muted)_30%,var(--card))] px-4 py-3">
          <span className="text-xs text-muted-foreground">
            {step === 1
              ? <Trans>Pick a UI interface · {FIELD_INTERFACES.length} available across {INTERFACE_GROUPS.length} groups</Trans>
              : valid
                ? <Trans>Will run on save.</Trans>
                : nameTaken
                  ? <Trans>Name conflicts with an existing column.</Trans>
                  : missingChoices
                    ? <Trans>Add at least one dropdown choice.</Trans>
                    : missingRelation
                      ? <Trans>Pick the collection this relation points to.</Trans>
                      : <Trans>Enter a name to continue.</Trans>}
          </span>
          <div className="flex-1" />
          {step === 2 && <Button variant="ghost" size="sm" onClick={() => setStep(1)} icon={I.ChevronLeft}><Trans>Back</Trans></Button>}
          <Button variant="ghost" size="sm" onClick={onClose}><Trans>Cancel</Trans></Button>
          {step === 1 ? (
            <Button variant="primary" size="sm" iconRight={I.ChevronRight} onClick={() => { setStep(2); setTab("schema"); }}><Trans>Next</Trans></Button>
          ) : (
            <Button variant="primary" size="sm" icon={I.Check} disabled={!valid} onClick={submit}><Trans>Add column</Trans></Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
