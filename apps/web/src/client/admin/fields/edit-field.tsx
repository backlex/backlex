// Edit-field dialog: change a user-defined column's settings without
// renaming or retyping it (those need DDL changes the backend doesn't yet
// support). Directus-style tabbed editor (Schema · Relationship · Field ·
// Interface · Validation · Conditions). Covers required/unique flags, the
// interface override (drawn from the interface catalog, filtered to interfaces
// compatible with this column's storage type), display name / note, and the
// per-choice metadata used by selection interfaces — same shape that
// admin/sheet.tsx and admin/items.tsx consume to render Selects + badges.
import { useEffect, useMemo, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { I } from "../icons";
import { Badge, Button, IconButton, Switch } from "../ui";
import { Input } from "@backlex/ui/components/input";
import { Textarea } from "@backlex/ui/components/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@backlex/ui/components/dialog";
import { Select } from "../select";
import { FieldTabLayout, type FieldTabItem } from "./field-editor-tabs";
import { extensionInterfacesForType, getInterface, interfacesForType } from "./interfaces";
import { useEnabledExtensions } from "../queries";
import {
  type GroupNode,
  newGroup,
  objToTree,
  RuleBuilder,
  ruleTreeToObj,
  treeHasRule,
} from "../rule-builder";
import {
  compileValidation,
  emptyValDraft,
  FieldValidationEditor,
  type ValDraft,
  validationToDraft,
} from "./field-validation-editor";
import {
  cleanFormat,
  FieldFormatEditor,
  type FieldFormatDraft,
  formatToDraft,
} from "./field-format-editor";
import { cleanTranslations, FieldTranslationsEditor } from "./field-translations-editor";
import { canLocalize } from "../collections/item-form";
import {
  cleanRollup,
  emptyRollupDraft,
  FieldRollupEditor,
  rollupStorageType,
  rollupToDraft,
  type RollupDraft,
} from "./field-rollup-editor";
import {
  cleanSequence,
  emptySequenceDraft,
  FieldSequenceEditor,
  sequenceToDraft,
  type SequenceDraft,
} from "./field-sequence-editor";
import {
  FieldTransitionsEditor,
  cleanTransitions,
  emptyTransitionsDraft,
  transitionsToDraft,
  type TransitionsDraft,
} from "./field-transitions-editor";
import {
  cleanGeo,
  emptyGeoDraft,
  FieldGeoEditor,
  geoDraftFrom,
  type GeoDraft,
} from "./field-geo-editor";
import {
  cleanMoney,
  emptyMoneyDraft,
  FieldMoneyEditor,
  moneyDraftFrom,
  type MoneyDraft,
} from "./field-money-editor";
import {
  cleanEmail,
  emailDraftFrom,
  emptyEmailDraft,
  FieldEmailEditor,
  type EmailDraft,
} from "./field-email-editor";
import {
  cleanUrl,
  emptyUrlDraft,
  FieldUrlEditor,
  urlDraftFrom,
  type UrlDraft,
} from "./field-url-editor";
import {
  cleanPhone,
  emptyPhoneDraft,
  FieldPhoneEditor,
  phoneDraftFrom,
  type PhoneDraft,
} from "./field-phone-editor";
import {
  cleanRange,
  emptyRangeDraft,
  FieldRangeEditor,
  rangeDraftFrom,
  type RangeDraft,
} from "./field-range-editor";

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
  /** Fold into the collection's embedding text for vector search (text/longtext only). */
  vectorize?: boolean;
  /** Store one value per locale in the `<table>__i18n` sidecar. */
  localized?: boolean;
  interface?: string;
  /** Target collection slug (relation / relation_many). Immutable here. */
  to?: string;
  /** Human display name shown in the item form. */
  label?: string;
  /** Inline help text. */
  description?: string;
  /** Section label — fields sharing one render under a single heading. */
  group?: string;
  /** `"half"` pairs two consecutive fields into a 2-column row. UI only. */
  width?: "full" | "half";
  /** Make this field's section collapsible / start it collapsed. UI only. */
  sectionCollapsible?: boolean;
  sectionCollapsed?: boolean;
  /** Render the grouped form as tabs (form-wide, aggregated). UI only. */
  sectionsAsTabs?: boolean;
  /** Internal column — never returned by the API. */
  private?: boolean;
  /** Server-side auto-fill on insert / update. */
  onCreate?: "uuid" | "now" | "user" | "tenant";
  onUpdate?: "now" | "user" | "tenant";
  /** App-layer ON DELETE action for a relation FK. */
  onDelete?: "set_null" | "cascade" | "no_action";
  /** Aggregate over another collection's rows — see the rollup editor. */
  rollup?: Record<string, unknown>;
  /** Server-issued document number — see the sequence editor. */
  sequence?: Record<string, unknown>;
  /** Location configuration — see the geo editor. */
  geo?: Record<string, unknown>;
  /** Currency configuration — see the money editor. */
  money?: Record<string, unknown>;
  /** Dialling-region configuration — see the phone editor. */
  phone?: Record<string, unknown>;
  /** Address-normalisation configuration — see the email editor. */
  email?: Record<string, unknown>;
  /** Scheme / host rules — see the URL editor. */
  url?: Record<string, unknown>;
  /** Companion end-column that turns this field into a period — see the range editor. */
  range?: Record<string, unknown>;
  /** Which status value may move to which — see the transitions editor. Sent as
   *  `undefined` when the lifecycle is switched off, which REMOVES the stored
   *  graph rather than leaving the old one in force. */
  transitions?: Record<string, unknown>;
  /** Display formatting hint. */
  format?: Record<string, unknown>;
  /** Per-field constraints compiled from the validation editor. */
  validation?: Record<string, unknown>;
  /** Per-locale label overrides. */
  translations?: Record<string, string>;
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
  /** Slug of the collection being edited — the rollup's parent. */
  ownerSlug?: string;
  /** Every collection with its field definitions, for the rollup editor's
   *  source / relation / value pickers. */
  collections?: Array<{
    slug: string;
    fieldDefs?: Array<{ name: string; type: string; to?: string; rollup?: unknown }>;
    /** Adopted tables own no DDL, so the money editor hides the "add a companion
     *  currency column" affordance. Read off the owning collection. */
    adopted?: boolean;
  }>;
  /** Sibling field names, for the condition rule builder's field picker. */
  availableFields?: string[];
  /** Existing section names on this collection — offered as suggestions. */
  groups?: string[];
  onClose: () => void;
  onSave: (next: FieldDraft) => void;
}

export function EditFieldDialog({ open, field, ownerSlug = "", collections = [], availableFields = [], groups = [], onClose, onSave }: EditFieldDialogProps) {
  const { t, i18n } = useLingui();
  const [draft, setDraft] = useState<FieldDraft | null>(field);
  const [conds, setConds] = useState<CondDraft[]>([]);
  const [valDraft, setValDraft] = useState<ValDraft>(emptyValDraft());
  const [formatDraft, setFormatDraft] = useState<FieldFormatDraft>({});
  const [translations, setTranslations] = useState<Record<string, string>>({});
  const [rollupDraft, setRollupDraft] = useState<RollupDraft>(emptyRollupDraft());
  const [seqDraft, setSeqDraft] = useState<SequenceDraft>(() => emptySequenceDraft("UTC"));
  const [transDraft, setTransDraft] = useState<TransitionsDraft>(emptyTransitionsDraft);
  const [geoDraft, setGeoDraft] = useState<GeoDraft>(emptyGeoDraft);
  const [moneyDraft, setMoneyDraft] = useState<MoneyDraft>(emptyMoneyDraft);
  const [phoneDraft, setPhoneDraft] = useState<PhoneDraft>(emptyPhoneDraft);
  const [emailDraft, setEmailDraft] = useState<EmailDraft>(emptyEmailDraft);
  const [urlDraft, setUrlDraft] = useState<UrlDraft>(emptyUrlDraft);
  const [rangeDraft, setRangeDraft] = useState<RangeDraft>(emptyRangeDraft);
  const [tab, setTab] = useState("schema");

  // Re-seed every time the dialog opens with a new target field.
  useEffect(() => {
    if (!open) return;
    if (!field) {
      setDraft(null);
      return;
    }
    setTab("schema");
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
    setFormatDraft(formatToDraft((field as { format?: unknown }).format));
    setTranslations(((field as { translations?: Record<string, string> }).translations) ?? {});
    setRollupDraft(rollupToDraft((field as { rollup?: unknown }).rollup));
    setSeqDraft(sequenceToDraft((field as { sequence?: unknown }).sequence));
    setGeoDraft(geoDraftFrom((field as { geo?: unknown }).geo));
    setMoneyDraft(moneyDraftFrom((field as { money?: unknown }).money));
    setPhoneDraft(phoneDraftFrom((field as { phone?: unknown }).phone));
    setEmailDraft(emailDraftFrom((field as { email?: unknown }).email));
    setUrlDraft(urlDraftFrom((field as { url?: unknown }).url));
    setRangeDraft(rangeDraftFrom((field as { range?: unknown }).range));
    setTransDraft(
      transitionsToDraft(
        (field as { transitions?: unknown }).transitions,
        ((field as { options?: { choices?: { value: string }[] } }).options?.choices ?? []).map(
          (c) => c.value,
        ),
      ),
    );
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
  // Extension-contributed editors join the override list when their `types`
  // restriction (absent = any) admits this column's storage type.
  const extensionsQuery = useEnabledExtensions();
  const interfaceOpts = useMemo(() => {
    if (!draft) return [{ value: "", label: t`Default (auto)` }];
    const compatible = [
      ...interfacesForType(draft.type),
      ...extensionInterfacesForType(extensionsQuery.data?.data ?? [], draft.type),
    ];
    const cur = draft.interface ? getInterface(draft.interface) : undefined;
    const all = cur && !compatible.some((i) => i.id === cur.id) ? [cur, ...compatible] : compatible;
    return [
      { value: "", label: t`Default (auto)` },
      ...all.map((i) => ({
        value: i.id,
        label: `${i.label} — ${i.sub}`,
        ...(i.hasChoices ? { badge: "choices" } : {}),
      })),
    ];
  }, [draft?.type, draft?.interface, extensionsQuery.data]);

  const isRelation = draft?.type === "relation" || draft?.type === "relation_many";
  // A field is a rollup because it already CARRIES one — the aggregate is not
  // something an existing plain column can be converted into here: the applier
  // is additive and would leave the old values sitting in the column until the
  // first child write. Add a new rollup field instead.
  const isRollup = !!draft?.rollup;
  const cleanedRollup = isRollup ? cleanRollup(rollupDraft) : undefined;
  // Same rule as rollup: a field is a sequence because it already carries one.
  // Converting a plain column would leave every existing row's value untouched
  // while the counter started from scratch — two numbering schemes in one
  // column. Add a new sequence field instead.
  const isSequence = !!draft?.sequence;
  const cleanedSequence = isSequence ? cleanSequence(seqDraft) : undefined;
  // Unlike rollup and sequence, this one keys off the column TYPE rather than
  // off the spec already being there: every part of a geo spec is optional, so
  // a location field that has never been configured still has a Location tab
  // to configure — which is the only way to add `geocodeFrom` to one.
  const isGeo = draft?.type === "geo";
  // Same keyed-off-the-type rule as geo, but the spec is mandatory rather than
  // optional — so an incomplete draft marks the tab invalid and blocks Save,
  // exactly as a half-built rollup does.
  const isMoney = draft?.type === "money";
  const cleanedMoney = isMoney ? cleanMoney(moneyDraft) : undefined;
  const isPhone = draft?.type === "phone";
  // Optional, unlike money's — see the note in add-field. It never blocks Save.
  const cleanedPhone = isPhone ? cleanPhone(phoneDraft) : undefined;
  const isEmail = (field?.type ?? "") === "email";
  const isUrl = (field?.type ?? "") === "url";
  const cleanedEmail = isEmail ? cleanEmail(emailDraft) : undefined;
  const cleanedUrl = isUrl ? cleanUrl(urlDraft) : undefined;
  const isRange = draft?.type === "timestamp";
  const cleanedRange = isRange ? cleanRange(rangeDraft) : undefined;
  // Keyed off the INTERFACE, like geo is off the type: a lifecycle is optional
  // on every single-select dropdown, so a field that has never had one still
  // has the tab — turning it on is the whole point of opening this dialog.
  const hasLifecycle = !!getInterface(draft?.interface)?.hasTransitions;

  // Server-side auto-fill options valid for this column's storage type.
  const autoFillOpts = (type: string, withUuid: boolean) => {
    const o: Array<{ value: string; label: string }> = [{ value: "", label: t`Do nothing` }];
    if (withUuid && (type === "uuid" || type === "text")) o.push({ value: "uuid", label: "UUID" });
    if (type === "timestamp") o.push({ value: "now", label: t`Current date/time` });
    if (type === "text" || type === "uuid") {
      o.push({ value: "user", label: t`Current user` });
      o.push({ value: "tenant", label: t`Current tenant` });
    }
    return o;
  };

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
    // choices. Only persist conditions that carry a real rule; compile each
    // tree back to the canonical Condition object the server stores + enforces.
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
      label: draft.label?.trim() ? draft.label.trim() : undefined,
      description: draft.description?.trim() ? draft.description.trim() : undefined,
      group: draft.group?.trim() ? draft.group.trim() : undefined,
      width: draft.width === "half" ? "half" : undefined,
      // Section-collapse flags are meaningless without a section, and
      // "start collapsed" without "collapsible" is a no-op — normalize both.
      sectionCollapsible: draft.group?.trim() && draft.sectionCollapsible ? true : undefined,
      sectionCollapsed:
        draft.group?.trim() && draft.sectionCollapsible && draft.sectionCollapsed ? true : undefined,
      sectionsAsTabs: draft.group?.trim() && draft.sectionsAsTabs ? true : undefined,
      options: wantsChoices
        ? { choices: (draft.options?.choices ?? []).filter((c) => c.value.trim()) }
        : undefined,
      interface: draft.interface || undefined,
      conditions: conditions.length ? (conditions as never) : undefined,
      validation: validation ?? undefined,
      format: cleanFormat(formatDraft, draft.type) ?? undefined,
      translations: cleanTranslations(translations) ?? undefined,
      ...(isRollup
        ? { rollup: cleanedRollup, type: rollupStorageType(rollupDraft.fn) }
        : {}),
      ...(isSequence ? { sequence: cleanedSequence } : {}),
      ...(isGeo ? { geo: cleanGeo(geoDraft) } : {}),
      ...(isMoney ? { money: cleanedMoney } : {}),
      // Sent even when undefined so that clearing every option actually REMOVES
      // the stored spec — omitting the key would leave the old region in place
      // and the dialog would keep re-showing a setting the operator just cleared.
      ...(isPhone ? { phone: cleanedPhone } : {}),
      ...(isEmail ? { email: cleanedEmail } : {}),
      ...(isUrl ? { url: cleanedUrl } : {}),
      // Sent even when undefined so clearing the end column REMOVES the stored
      // period rather than leaving the old one in place.
      ...(isRange ? { range: cleanedRange } : {}),
      // Explicitly `undefined` when the lifecycle is switched off, so saving
      // removes the stored spec rather than leaving the old graph in force.
      transitions: hasLifecycle ? cleanTransitions(transDraft) : undefined,
    };
    onSave(cleaned);
  };

  const tabs: FieldTabItem[] = [
    { key: "schema", label: t`Schema`, icon: "Database" },
    ...(isRelation ? [{ key: "relationship", label: t`Relationship`, icon: "Share" } as FieldTabItem] : []),
    ...(isRollup ? [{ key: "rollup", label: t`Rollup`, icon: "BarChart", invalid: !cleanedRollup } as FieldTabItem] : []),
    ...(isSequence ? [{ key: "sequence", label: t`Numbering`, icon: "Hash", invalid: !cleanedSequence } as FieldTabItem] : []),
    ...(isGeo ? [{ key: "geo", label: t`Location`, icon: "Globe" } as FieldTabItem] : []),
    ...(isMoney ? [{ key: "money", label: t`Currency`, icon: "BarChart", invalid: !cleanedMoney } as FieldTabItem] : []),
    ...(isPhone ? [{ key: "phone", label: t`Phone`, icon: "Phone" } as FieldTabItem] : []),
    ...(isEmail ? [{ key: "email", label: t`Email`, icon: "Mail" } as FieldTabItem] : []),
    ...(isUrl ? [{ key: "url", label: t`URL`, icon: "ExternalLink" } as FieldTabItem] : []),
    ...(isRange ? [{ key: "range", label: t`Period`, icon: "Calendar" } as FieldTabItem] : []),
    ...(hasLifecycle ? [{ key: "transitions", label: t`Lifecycle`, icon: "Share" } as FieldTabItem] : []),
    { key: "field", label: t`Field`, icon: "Pencil" },
    { key: "interface", label: t`Interface`, icon: "Eye" },
    { key: "validation", label: t`Validation`, icon: "Check" },
    { key: "conditions", label: t`Conditions`, icon: "Filter" },
  ];
  const activeTab = tabs.some((x) => x.key === tab) ? tab : "schema";
  // Literal class strings — Tailwind's JIT can't see interpolated class names.
  // Fixed height (not max-h): the centered dialog re-centers when the active
  // tab changes its content height, so the modal jumps on every rail click.
  const vp = "h-[calc(min(86vh,720px)-9rem)] max-[640px]:h-[calc(min(86vh,720px)-16rem)]";

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="flex max-h-[min(86vh,720px)] flex-col gap-0 overflow-hidden p-0 [&>*]:min-w-0 sm:max-w-[720px]">
        <DialogHeader className="shrink-0 border-b border-border px-5 pb-3.5 pr-12 pt-[18px] text-left">
          <DialogTitle className="text-base font-semibold tracking-[-0.01em]">
            <Trans>Edit <span className="font-mono">{draft.name}</span>{" "}
            <Badge variant="outline" mono>{draft.type}</Badge></Trans>
          </DialogTitle>
          <DialogDescription className="text-[12.5px]">
            <Trans>Name and type are immutable — drop &amp; re-add the column to change them.</Trans>
          </DialogDescription>
        </DialogHeader>

        <FieldTabLayout tabs={tabs} active={activeTab} onSelect={setTab} viewportClassName={vp}>
          {activeTab === "schema" && isRollup && (
            <div className="rounded-control bg-muted p-3 text-[12.5px] text-muted-foreground">
              <Trans>Read-only column — backlex writes it from the rows picked in the <span className="font-medium text-foreground">Rollup</span> tab, so it takes no constraints.</Trans>
            </div>
          )}

          {activeTab === "schema" && isSequence && (
            <div className="rounded-control bg-muted p-3 text-[12.5px] text-muted-foreground">
              <Trans>backlex issues this value on create — the shape lives in the <span className="font-medium text-foreground">Numbering</span> tab. Changing it affects the NEXT number issued; rows already numbered keep what they were given.</Trans>
            </div>
          )}

          {activeTab === "schema" && !isRollup && !isSequence && (
            <div className="flex flex-col gap-3.5">
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

              {(() => {
                const localizable = canLocalize(draft);
                return (
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Localized</Trans></div>
                      <div className="text-[11.5px] text-muted-foreground">
                        {localizable ? (
                          <Trans>Store one value per language in the translations sidecar. Turning this on for a field that already has data does not move existing values — backfill them afterwards.</Trans>
                        ) : (
                          <Trans>Localization applies to content fields — not IDs, secrets, raw JSON, or many-to-many relations.</Trans>
                        )}
                      </div>
                    </div>
                    <Switch
                      checked={!!draft.localized}
                      disabled={!localizable}
                      onChange={(v) =>
                        setDraft((d) => (d ? { ...d, localized: v, unique: v ? false : d.unique } : d))
                      }
                    />
                  </div>
                );
              })()}

              {(draft.type === "text" || draft.type === "longtext") && (
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Searchable</Trans></div>
                    <div className="text-[11.5px] text-muted-foreground"><Trans>Fold this field into the collection's full-text-search index (when FTS is enabled). Saving re-indexes existing rows automatically.</Trans></div>
                  </div>
                  <Switch checked={!!draft.searchable} onChange={(v) => setDraft((d) => d ? { ...d, searchable: v } : d)} />
                </div>
              )}

              {/* Not offered on a sequence — the server refuses it. */}
              {(draft.type === "text" || draft.type === "longtext") && !isSequence && (
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Vectorize</Trans></div>
                    <div className="text-[11.5px] text-muted-foreground"><Trans>Fold this field into the text embedded for vector search (when vector search is enabled). Existing rows need an embed backfill from the collection's Settings tab.</Trans></div>
                  </div>
                  <Switch checked={!!draft.vectorize} onChange={(v) => setDraft((d) => d ? { ...d, vectorize: v } : d)} />
                </div>
              )}

              {(() => {
                const createOpts = autoFillOpts(draft.type, true);
                const updateOpts = autoFillOpts(draft.type, false);
                if (createOpts.length <= 1 && updateOpts.length <= 1) return null;
                return (
                  <div className="grid grid-cols-2 gap-3 max-[520px]:grid-cols-1">
                    {createOpts.length > 1 && (
                      <div className="flex min-w-0 flex-col gap-1.5">
                        <label className="text-[12.5px] font-medium text-foreground"><Trans>On create</Trans></label>
                        <Select value={draft.onCreate ?? ""} onChange={(v) => setDraft((d) => d ? { ...d, onCreate: (v || undefined) as never } : d)} options={createOpts} />
                        <span className="text-[11.5px] text-muted-foreground"><Trans>Server fills this on insert; the field becomes read-only.</Trans></span>
                      </div>
                    )}
                    {updateOpts.length > 1 && (
                      <div className="flex min-w-0 flex-col gap-1.5">
                        <label className="text-[12.5px] font-medium text-foreground"><Trans>On update</Trans></label>
                        <Select value={draft.onUpdate ?? ""} onChange={(v) => setDraft((d) => d ? { ...d, onUpdate: (v || undefined) as never } : d)} options={updateOpts} />
                        <span className="text-[11.5px] text-muted-foreground"><Trans>Server refreshes this on every update.</Trans></span>
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
          )}

          {activeTab === "relationship" && isRelation && (
            <div className="flex flex-col gap-3.5">
              <div className="flex flex-col gap-1.5">
                <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>References collection</Trans></label>
                <div className="flex items-center gap-2 rounded-surface border border-border bg-muted px-3 py-2">
                  <I.Database size={14} className="text-muted-foreground" />
                  <span className="font-mono text-[13px] text-foreground">{draft.to || "—"}</span>
                </div>
                <span className="text-[11.5px] text-muted-foreground"><Trans>Stores the target row's <span className="font-mono">id</span>. The target is immutable — drop &amp; re-add to change it.</Trans></span>
              </div>
              {isRelation && (
                <div className="flex flex-col gap-1.5">
                  <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>When the referenced item is deleted</Trans></label>
                  <Select
                    value={draft.onDelete ?? "no_action"}
                    onChange={(v) => setDraft((d) => d ? { ...d, onDelete: v as never } : d)}
                    options={[
                      { value: "no_action", label: t`Do nothing` },
                      { value: "set_null", label: draft.type === "relation_many" ? t`Remove it from the list` : t`Set this field to NULL` },
                      { value: "cascade", label: t`Delete this row too (cascade)` },
                    ]}
                  />
                  <span className="text-[11.5px] text-muted-foreground"><Trans>App-layer trigger — backlex has no DB foreign keys, so it's enforced on delete.</Trans></span>
                </div>
              )}
            </div>
          )}

          {activeTab === "rollup" && isRollup && (
            <FieldRollupEditor
              ownerSlug={ownerSlug}
              collections={collections}
              value={rollupDraft}
              onChange={setRollupDraft}
            />
          )}

          {activeTab === "sequence" && isSequence && (
            <FieldSequenceEditor value={seqDraft} onChange={setSeqDraft} />
          )}

          {activeTab === "transitions" && hasLifecycle && (
            <FieldTransitionsEditor
              value={transDraft}
              onChange={setTransDraft}
              choices={choices}
              candidates={availableFields
                .filter((n) => n !== draft.name)
                .map((n) => ({ name: n }))}
            />
          )}

          {activeTab === "range" && isRange && (
            <FieldRangeEditor
              value={rangeDraft}
              onChange={setRangeDraft}
              candidates={(
                collections.find((c) => c.slug === ownerSlug)?.fieldDefs ?? []
              ).filter((f) => f.name !== draft?.name)}
              interfaceId={draft?.interface}
            />
          )}

          {activeTab === "phone" && isPhone && (
            <FieldPhoneEditor
              value={phoneDraft}
              onChange={setPhoneDraft}
              candidates={(
                collections.find((c) => c.slug === ownerSlug)?.fieldDefs ?? []
              ).filter((f) => f.name !== draft?.name)}
            />
          )}

          {activeTab === "email" && isEmail && (
            <FieldEmailEditor value={emailDraft} onChange={setEmailDraft} />
          )}

          {activeTab === "url" && isUrl && (
            <FieldUrlEditor value={urlDraft} onChange={setUrlDraft} />
          )}

          {activeTab === "money" && isMoney && (
            <FieldMoneyEditor
              value={moneyDraft}
              onChange={setMoneyDraft}
              candidates={(
                collections.find((c) => c.slug === ownerSlug)?.fieldDefs ?? []
              ).filter((f) => f.name !== draft?.name)}
              adopted={Boolean(collections.find((c) => c.slug === ownerSlug)?.adopted)}
              locale={i18n.locale}
            />
          )}

          {activeTab === "geo" && isGeo && (
            <FieldGeoEditor
              value={geoDraft}
              onChange={setGeoDraft}
              // Typed defs, not the bare `availableFields` name list — only
              // text columns can spell an address, and the names alone cannot
              // say which ones those are.
              candidates={(
                collections.find((c) => c.slug === ownerSlug)?.fieldDefs ?? []
              ).filter((f) => f.name !== draft?.name)}
            />
          )}

          {activeTab === "field" && (
            <div className="flex flex-col gap-3.5">
              <div className="flex flex-col gap-1.5">
                <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Display name <span className="text-muted-foreground">(optional)</span></Trans></label>
                <Input value={draft.label ?? ""} onChange={(e) => setDraft((d) => d ? { ...d, label: e.target.value } : d)} placeholder={draft.name} />
                <span className="text-[11.5px] text-muted-foreground"><Trans>Label shown in the item form. Falls back to the column name.</Trans></span>
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Note <span className="text-muted-foreground">(optional)</span></Trans></label>
                <Textarea value={draft.description ?? ""} onChange={(e) => setDraft((d) => d ? { ...d, description: e.target.value } : d)} rows={3} placeholder={t`Add a helpful note for editors…`} />
                <span className="text-[11.5px] text-muted-foreground"><Trans>Inline help text shown beneath the field.</Trans></span>
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Section <span className="text-muted-foreground">(optional)</span></Trans></label>
                <Input
                  value={draft.group ?? ""}
                  onChange={(e) => setDraft((d) => d ? { ...d, group: e.target.value } : d)}
                  placeholder={t`e.g. Content, SEO, Advanced`}
                  list="edit-field-section-suggestions"
                />
                {groups.length > 0 && (
                  <datalist id="edit-field-section-suggestions">
                    {[...new Set(groups)].map((g) => (
                      <option key={g} value={g} />
                    ))}
                  </datalist>
                )}
                <span className="text-[11.5px] text-muted-foreground"><Trans>Fields sharing a section name are grouped under one heading in the item form. Leave blank to keep it ungrouped.</Trans></span>
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Width</Trans></label>
                <Select
                  value={draft.width === "half" ? "half" : "full"}
                  onChange={(v) => setDraft((d) => d ? { ...d, width: v as "full" | "half" } : d)}
                  options={[
                    { value: "full", label: t`Full width` },
                    { value: "half", label: t`Half width` },
                  ]}
                />
                <span className="text-[11.5px] text-muted-foreground"><Trans>Two consecutive half-width fields sit side by side on one row (stacked on mobile).</Trans></span>
              </div>
              {draft.group?.trim() && (
                <div className="flex flex-col gap-2.5 rounded-control bg-muted p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Collapsible section</Trans></div>
                      <div className="text-[11.5px] text-muted-foreground"><Trans>Let editors fold the "{draft.group.trim()}" section. Applies to the whole section.</Trans></div>
                    </div>
                    <Switch checked={!!draft.sectionCollapsible} onChange={(v) => setDraft((d) => d ? { ...d, sectionCollapsible: v, sectionCollapsed: v ? d.sectionCollapsed : false } : d)} />
                  </div>
                  {draft.sectionCollapsible && (
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Start collapsed</Trans></div>
                        <div className="text-[11.5px] text-muted-foreground"><Trans>The section opens folded — useful for advanced or rarely-touched fields.</Trans></div>
                      </div>
                      <Switch checked={!!draft.sectionCollapsed} onChange={(v) => setDraft((d) => d ? { ...d, sectionCollapsed: v } : d)} />
                    </div>
                  )}
                  <div className="flex items-center justify-between gap-3 border-t border-border pt-2.5">
                    <div>
                      <div className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Show sections as tabs</Trans></div>
                      <div className="text-[11.5px] text-muted-foreground"><Trans>Form-wide — every section becomes a tab across the top instead of a stacked heading. Best for large records.</Trans></div>
                    </div>
                    <Switch checked={!!draft.sectionsAsTabs} onChange={(v) => setDraft((d) => d ? { ...d, sectionsAsTabs: v } : d)} />
                  </div>
                </div>
              )}
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Private</Trans></div>
                  <div className="text-[11.5px] text-muted-foreground"><Trans>Internal column — stored and writable, but never returned by the API (REST, GraphQL, CSV, changefeed).</Trans></div>
                </div>
                <Switch checked={!!draft.private} onChange={(v) => setDraft((d) => d ? { ...d, private: v } : d)} />
              </div>
              <FieldTranslationsEditor value={translations} onChange={setTranslations} />
            </div>
          )}

          {activeTab === "interface" && (
            <div className="flex flex-col gap-3.5">
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
                <div className="flex flex-col gap-1.5 rounded-control bg-muted p-3">
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
                          className="relative inline-flex h-8 w-14 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-control border border-border ring-offset-background focus-within:ring-2 focus-within:ring-ring/50"
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

              <FieldFormatEditor type={draft.type} value={formatDraft} onChange={setFormatDraft} />

              {!wantsChoices && draft.type !== "integer" && draft.type !== "number" && draft.type !== "timestamp" && (
                <div className="rounded-control bg-muted p-3 text-[12.5px] text-muted-foreground">
                  <Trans>This interface has no extra options. Selection interfaces (dropdown, radio…) show a choices editor here.</Trans>
                </div>
              )}
            </div>
          )}

          {activeTab === "validation" && (
            <FieldValidationEditor
              type={draft.type}
              fields={availableFields}
              value={valDraft}
              onChange={setValDraft}
            />
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
          )}
        </FieldTabLayout>

        <DialogFooter className="shrink-0 border-t border-border px-[18px] py-3">
          <Button variant="ghost" size="sm" onClick={onClose}><Trans>Cancel</Trans></Button>
          <Button
            variant="primary"
            size="sm"
            onClick={submit}
            // A money field with no resolvable currency is an integer column
            // nobody can interpret — the server refuses it, so say so here
            // rather than after the round trip.
            disabled={isMoney && !cleanedMoney}
          >
            <Trans>Save field</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
