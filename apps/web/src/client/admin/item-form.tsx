// Shared, layout-agnostic item form.
//
// This is the single source of truth for editing a collection row: the state
// machine (`useItemForm`) and the dynamic field renderer (`ItemFields`). Both
// the modal (`ItemSheet`) and the full-page editor (`ItemEditorPage`) consume
// these so there is exactly one copy of the per-interface input logic.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { i18n } from "@lingui/core";
import { fieldLabel } from "./format-value";
import { I } from "./icons";
import { type CollectionSchema, type Post } from "./config";
import { Badge, Checkbox, Switch } from "./ui";
import { Input } from "@backlex/ui/components/input";
import { Textarea } from "@backlex/ui/components/textarea";
import { Select } from "./select";
import { DatePicker } from "@/components/date-picker";
import { RelationPicker, AppUserPicker, FilePicker, MultiFilePicker } from "./relational-pickers";
import { useEnabledExtensions, useSettings } from "./queries";
import { ExtensionFrame } from "./extension-frame";
import { getInterface } from "./interfaces";
import type { ApiExtension } from "./api";

export type SchemaField = {
  name: string;
  type?: string;
  interface?: string;
  /** Human display name shown in the editor; falls back to `name`. */
  label?: string;
  /** Per-locale label overrides (locale → label). */
  translations?: Record<string, string>;
  /** Inline help text rendered beneath the field. */
  description?: string;
  required?: boolean;
  nullable?: boolean;
  unique?: boolean;
  /** Value is stored per-locale in the translations sidecar — the editor
   *  renders one input per workspace language and sends a `{locale: value}` map. */
  localized?: boolean;
  /** Optional layout group. Fields sharing a group render under one heading;
   *  ungrouped fields render flat. No-op until a collection assigns groups. */
  group?: string;
  /** `"half"` lets two consecutive half fields share a row; else full width. */
  width?: "full" | "half";
  /** Section (group) collapsibility — aggregated across the group's fields. */
  sectionCollapsible?: boolean;
  sectionCollapsed?: boolean;
  /** Render the grouped form as tabs (form-wide, aggregated across fields). */
  sectionsAsTabs?: boolean;
  options?: {
    choices?: Array<{ value: string; label?: string; color?: string }>;
    values?: string[];
    min?: number;
    max?: number;
    step?: number;
    group?: string;
  };
  to?: string;
  /** Field conditions: when `rule` matches the current draft, apply the
   *  effects. `required` also enforced server-side; `readonly` / `hidden` are the
   *  live item-form effects. */
  conditions?: Array<{
    name?: string;
    rule: unknown;
    required?: boolean;
    readonly?: boolean;
    hidden?: boolean;
  }>;
};

// --- Client-side condition evaluation (item-form live effects) -------------
// Compact evaluator for the operators the rule builder emits. Mirrors the
// server's `matchesCondition` semantics but stays drizzle-free so it can run in
// the browser bundle. `$user.*` values aren't resolved client-side (rare in
// field conditions); the server remains the source of truth for `required`.

const evalLeaf = (left: unknown, cmp: Record<string, unknown>): boolean => {
  const s = (v: unknown) => String(v ?? "");
  for (const [op, r] of Object.entries(cmp)) {
    switch (op) {
      case "_eq": if (s(left) !== s(r)) return false; break;
      case "_neq": if (s(left) === s(r)) return false; break;
      case "_in": if (!(Array.isArray(r) ? r : [r]).map(s).includes(s(left))) return false; break;
      case "_nin": if ((Array.isArray(r) ? r : [r]).map(s).includes(s(left))) return false; break;
      case "_gt": if (!(Number(left) > Number(r))) return false; break;
      case "_gte": if (!(Number(left) >= Number(r))) return false; break;
      case "_lt": if (!(Number(left) < Number(r))) return false; break;
      case "_lte": if (!(Number(left) <= Number(r))) return false; break;
      case "_contains": if (!s(left).includes(s(r))) return false; break;
      case "_starts_with": if (!s(left).startsWith(s(r))) return false; break;
      case "_null": if ((left == null || left === "") !== (r === true)) return false; break;
      default: break; // unknown / unsupported op → ignore (never a false block)
    }
  }
  return true;
};

const evalRule = (rule: unknown, values: Record<string, unknown>): boolean => {
  if (!rule || typeof rule !== "object") return true;
  const r = rule as Record<string, unknown>;
  if (Array.isArray(r.$and)) return r.$and.every((c) => evalRule(c, values));
  if (Array.isArray(r.$or)) return r.$or.some((c) => evalRule(c, values));
  if (r.$not !== undefined) return !evalRule(r.$not, values);
  for (const [field, cmp] of Object.entries(r)) {
    if (field.startsWith("$")) continue;
    if (cmp && typeof cmp === "object" && !evalLeaf(values[field], cmp as Record<string, unknown>)) {
      return false;
    }
  }
  return true;
};

/** Resolve the active hidden/readonly/required effects for a field given the
 *  current draft values. Effects OR across a field's matching conditions. */
export const fieldEffects = (
  f: SchemaField,
  values: Record<string, unknown>,
): { hidden: boolean; readonly: boolean; required: boolean } => {
  const eff = { hidden: false, readonly: false, required: false };
  for (const c of f.conditions ?? []) {
    if (evalRule(c.rule, values)) {
      if (c.hidden) eff.hidden = true;
      if (c.readonly) eff.readonly = true;
      if (c.required) eff.required = true;
    }
  }
  return eff;
};

export const SYSTEM_FIELDS = new Set([
  "id",
  "owner_id",
  "created_at",
  "updated_at",
  "tenant_id",
  "deleted_at",
]);

// Interfaces that store a JSON array of strings (and expect array values in the
// draft, not stringified JSON). Everything else with type=json gets the raw
// textarea editor.
const ARRAY_INTERFACES = new Set(["tags", "dropdown_multiple", "checkboxes", "files"]);
const isArrayInterface = (f: SchemaField) =>
  f.type === "json" && !!f.interface && ARRAY_INTERFACES.has(f.interface);

// Long-form interfaces that support a read-only rendered preview alongside the
// editor.
const PREVIEWABLE = new Set(["markdown", "richtext"]);

// A field can be localized when a per-row, per-language value is meaningful AND
// the item editor can render it (see the `control()` renderer). The sidecar
// stores any native type, so text, number, boolean, choice, date, color, file,
// image, user, and to-one relation all localize with their real control per
// language. Only these are excluded: identifiers (`uuid`), write-only secrets
// (`hash`, never read back), raw structured `json`/map, and many-to-many
// (`relation_many`) — translating those is meaningless or needs per-locale JSON
// (de)serialization the editor doesn't do yet.
const NON_LOCALIZABLE_TYPES = new Set(["json", "uuid", "hash", "relation_many"]);
export const canLocalize = (f: { type?: string; interface?: string }): boolean =>
  !!f.type && !NON_LOCALIZABLE_TYPES.has(f.type);

const blankFor = (f: SchemaField): unknown => {
  // Localized fields hold a per-locale `{locale: value}` map regardless of type.
  if (f.localized) return {};
  if (isArrayInterface(f)) return [];
  switch (f.type) {
    case "boolean":
      return false;
    case "json":
      return "";
    case "integer":
    case "number":
      return "";
    case "timestamp":
      return null;
    default:
      return "";
  }
};

const readChoices = (
  f: SchemaField,
): Array<{ value: string; label?: string; color?: string }> => {
  if (f.options?.choices?.length) return f.options.choices;
  if (f.options?.values?.length) return f.options.values.map((v) => ({ value: v }));
  return [];
};

const groupOf = (f: SchemaField): string | null => f.group ?? f.options?.group ?? null;

/** Presentational (non-storage) field types — they render in the form but own
 *  no physical column and carry no value. See @backlex/db `isPresentational`. */
export const PRESENTATIONAL_TYPES = new Set(["divider", "notice"]);
const isPresentational = (f: SchemaField): boolean =>
  PRESENTATIONAL_TYPES.has(f.type ?? "");

/** Minimal, escaped Markdown → HTML for the inline preview. Intentionally
 *  small: headings, bold/italic, inline code, links, and line breaks. Input is
 *  HTML-escaped first so raw markdown can't inject markup. */
function renderMarkdown(src: string): string {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return esc(src)
    .replace(/^###### (.*)$/gm, "<h6>$1</h6>")
    .replace(/^##### (.*)$/gm, "<h5>$1</h5>")
    .replace(/^#### (.*)$/gm, "<h4>$1</h4>")
    .replace(/^### (.*)$/gm, "<h3>$1</h3>")
    .replace(/^## (.*)$/gm, "<h2>$1</h2>")
    .replace(/^# (.*)$/gm, "<h1>$1</h1>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
    .replace(/\n/g, "<br />");
}

export interface ItemForm {
  /** User-defined (non-system) fields for this collection. */
  fields: SchemaField[];
  draft: Record<string, unknown>;
  errors: Record<string, string>;
  touched: Record<string, boolean>;
  /** True once any field has been edited since the last (re)hydration. */
  dirty: boolean;
  /** Number of fields currently failing validation. */
  errorCount: number;
  updateField: (name: string, value: unknown) => void;
  setFieldTouched: (name: string) => void;
  /** Run validation, populate `errors`, and return whether the form is valid. */
  validate: () => boolean;
  /** Serialize the draft into the API payload shape (numbers coerced, JSON
   *  parsed, empty JSON omitted). */
  buildPayload: () => Partial<Post>;
}

/**
 * Form state for one collection row. Re-hydrates whenever `initial`'s identity
 * or the collection slug changes (and only while `active`), so handing the hook
 * a fresh server-confirmed object after save re-syncs the draft.
 */
export function useItemForm({
  schema,
  initial,
  active = true,
}: {
  schema: CollectionSchema;
  initial: Post | null;
  active?: boolean;
}): ItemForm {
  const { t } = useLingui();
  const fields = useMemo(() => {
    const all = (schema?.fields ?? []) as SchemaField[];
    return all.filter((f) => !SYSTEM_FIELDS.has(f.name));
  }, [schema]);

  const buildDefaults = useRef<() => Record<string, unknown>>(() => ({}));
  buildDefaults.current = () => {
    const d: Record<string, unknown> = {};
    // Presentational blocks (divider/notice) carry no value — keep them out of
    // the draft so they never enter validation or the write payload. They still
    // render in the form body (which iterates the full `fields`).
    for (const f of fields) {
      if (isPresentational(f)) continue;
      d[f.name] = blankFor(f);
    }
    return d;
  };

  const [draft, setDraft] = useState<Record<string, unknown>>(() =>
    buildDefaults.current(),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [touched, setTouched] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!active) return;
    const base = buildDefaults.current();
    if (initial) {
      for (const f of fields) {
        const v = (initial as unknown as Record<string, unknown>)[f.name];
        if (v === undefined) continue;
        if (f.localized) {
          // The read returns a `{locale: value}` map (full-map mode); keep it.
          base[f.name] = v && typeof v === "object" && !Array.isArray(v) ? v : {};
        } else if (isArrayInterface(f)) {
          if (Array.isArray(v)) base[f.name] = v;
          else if (typeof v === "string") {
            try {
              const parsed = JSON.parse(v);
              base[f.name] = Array.isArray(parsed) ? parsed : [];
            } catch {
              base[f.name] = [];
            }
          } else base[f.name] = [];
        } else if (f.type === "json" && typeof v !== "string") {
          base[f.name] = JSON.stringify(v, null, 2);
        } else {
          base[f.name] = v;
        }
      }
    }
    setDraft(base);
    setErrors({});
    setTouched({});
  }, [active, initial, schema?.slug]);

  const updateField = (name: string, value: unknown) => {
    setDraft((d) => {
      const next = { ...d, [name]: value };
      // Auto-derive slug from title until the user touches the slug field.
      if (
        name === "title" &&
        !touched.slug &&
        fields.some((f) => f.name === "slug" && f.type === "text") &&
        typeof value === "string"
      ) {
        next.slug = value
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "")
          .slice(0, 60);
      }
      return next;
    });
  };

  const setFieldTouched = (name: string) =>
    setTouched((tch) => ({ ...tch, [name]: true }));

  const validate = () => {
    const e: Record<string, string> = {};
    for (const f of fields) {
      if (!(f.required || f.nullable === false)) continue;
      // A hash field on EDIT reads back blank (the digest is never returned);
      // a blank means "keep the current secret", so don't flag it as missing.
      // On create (`initial` null) it's still enforced.
      if (f.type === "hash" && initial) continue;
      const v = draft[f.name];
      const empty =
        v === undefined ||
        v === null ||
        (typeof v === "string" && !v.trim()) ||
        (Array.isArray(v) && v.length === 0);
      if (empty) e[f.name] = t`${f.name} is required`;
    }
    const slugVal = draft.slug;
    if (typeof slugVal === "string" && slugVal && !/^[a-z0-9-]+$/.test(slugVal)) {
      e.slug = t`lowercase letters, digits, and dashes only`;
    }
    for (const f of fields) {
      if (f.type !== "json" || isArrayInterface(f)) continue;
      const raw = draft[f.name];
      if (typeof raw !== "string" || !raw.trim()) continue;
      try {
        JSON.parse(raw);
      } catch {
        e[f.name] = t`must be valid json`;
      }
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const buildPayload = (): Partial<Post> => {
    const payload: Record<string, unknown> = {};
    for (const f of fields) {
      const raw = draft[f.name];
      if (raw === undefined) continue;
      if (f.localized) {
        // Send the per-locale map (object-of-locales — no `?locale=`), dropping
        // empty languages so a blank input doesn't store an empty value. Values
        // are already native per-locale (number/boolean/string).
        const map = raw && typeof raw === "object" && !Array.isArray(raw)
          ? (raw as Record<string, unknown>)
          : {};
        const out: Record<string, unknown> = {};
        for (const [loc, v] of Object.entries(map)) {
          if (v === "" || v === undefined || v === null) continue;
          out[loc] = v;
        }
        payload[f.name] = out;
      } else if (isArrayInterface(f)) {
        const arr = Array.isArray(raw)
          ? raw.filter((v) => v !== "" && v != null)
          : [];
        payload[f.name] = arr;
      } else if (f.type === "json") {
        if (typeof raw === "string" && raw.trim()) {
          try {
            payload[f.name] = JSON.parse(raw);
          } catch {
            payload[f.name] = null;
          }
        } else if (typeof raw !== "string") {
          payload[f.name] = raw;
        }
        // Empty JSON string: leave the field out so PATCH doesn't clobber.
      } else if (f.type === "integer" || f.type === "number") {
        if (raw === "" || raw === null) continue;
        const n = Number(raw);
        if (!Number.isNaN(n)) payload[f.name] = n;
      } else if (f.type === "timestamp") {
        payload[f.name] = raw || null;
      } else if (f.type === "boolean") {
        payload[f.name] = !!raw;
      } else if (f.type === "hash") {
        // Only send a hash field when the user typed something — a blank value
        // must not be sent (it would clobber the stored digest to null on the
        // server's "empty = skip" path is a no-op, but omitting is clearer).
        if (typeof raw === "string" && raw !== "") payload[f.name] = raw;
      } else {
        payload[f.name] = raw;
      }
    }
    return payload as Partial<Post>;
  };

  return {
    fields,
    draft,
    errors,
    touched,
    dirty: Object.keys(touched).length > 0,
    errorCount: Object.keys(errors).length,
    updateField,
    setFieldTouched,
    validate,
    buildPayload,
  };
}

/** Live-collaboration wiring for `ItemFields` — supplied by the item editor
 *  (from `useCollab`) so field editors surface who else is editing what and
 *  announce this member's own focus. Optional: bulk-edit and the sheet render
 *  the same fields without collab. */
export interface ItemFieldsCollab {
  peersByField: Record<string, { id: string; name: string | null; color: string }[]>;
  onFieldFocus: (field: string) => void;
  onFieldBlur: (field: string) => void;
}

/** Short handle for a collab peer badge — the email's local part. */
const peerHandle = (p: { name: string | null; id: string }): string => {
  if (p.name) {
    const at = p.name.indexOf("@");
    return at > 0 ? p.name.slice(0, at) : p.name;
  }
  return p.id.slice(0, 6);
};

/**
 * Renders every editable field for a collection row from `form`. Groups fields
 * by their optional `group` when any are assigned; otherwise renders flat.
 */
export function ItemFields({ form, collab }: { form: ItemForm; collab?: ItemFieldsCollab }) {
  const { t } = useLingui();
  const { fields, draft, errors, touched } = form;
  const [previews, setPreviews] = useState<Record<string, boolean>>({});
  // Sections (groups) currently folded. Seeded from any field whose
  // `sectionCollapsed` marks its group as starting collapsed; the section
  // header toggles it. Keyed by group label.
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(() => {
    const s = new Set<string>();
    for (const f of fields) {
      const g = f.group ?? f.options?.group;
      if (g && f.sectionCollapsed) s.add(g);
    }
    return s;
  });
  // Active tab when the grouped form renders as tabs (`sectionsAsTabs`). Empty
  // until the body resolves the group order; the body seeds it to the first group.
  const [activeTab, setActiveTab] = useState<string | null>(null);

  // Field editors contributed by enabled extensions, keyed by interface id.
  // When a field's `interface` matches, a sandboxed `ExtensionFrame` replaces
  // the built-in editor (same label/error chrome). Built-in catalog ids are
  // skipped so an extension can never shadow `input`/`dropdown`/etc.; across
  // extensions, first contribution wins on duplicate ids.
  const extensionsQuery = useEnabledExtensions();
  const extFieldEditors = useMemo(() => {
    const map = new Map<string, { extension: ApiExtension; entry: string }>();
    for (const ext of extensionsQuery.data?.data ?? []) {
      for (const ed of ext.manifest?.contributes?.fieldEditors ?? []) {
        if (ed.interface && !getInterface(ed.interface) && !map.has(ed.interface)) {
          map.set(ed.interface, { extension: ext, entry: ed.entry });
        }
      }
    }
    return map;
  }, [extensionsQuery.data]);

  // Workspace languages drive the per-locale inputs for `localized` fields.
  // Falls back to `["en"]` until settings load (or if none are configured).
  const settings = useSettings();
  const i18nLocales = useMemo<string[]>(() => {
    const raw = (settings.data?.data as Record<string, unknown> | undefined)?.i18nLocales;
    return Array.isArray(raw) && raw.length ? (raw as string[]) : ["en"];
  }, [settings.data]);
  // The workspace default is the source language: the value fallbacks read from
  // and the one translators start on. Must be a member of `i18nLocales`.
  const defaultLocale = useMemo<string>(() => {
    const dl = (settings.data?.data as Record<string, unknown> | undefined)?.i18nDefaultLocale;
    return typeof dl === "string" && i18nLocales.includes(dl) ? dl : (i18nLocales[0] ?? "en");
  }, [settings.data, i18nLocales]);

  // Localized-field editing state. Default view edits ONE language at a time
  // (pick via the locale bar); `compare` splits each localized field into a
  // read-only source column and an editable target column.
  const [activeLocale, setActiveLocale] = useState<string>(defaultLocale);
  const [i18nMode, setI18nMode] = useState<"single" | "compare">("single");
  const [cmpSource, setCmpSource] = useState<string>(defaultLocale);
  const [cmpTarget, setCmpTarget] = useState<string>("");
  // Keep the three selections valid as workspace languages load / change.
  useEffect(() => {
    if (!i18nLocales.includes(activeLocale)) setActiveLocale(defaultLocale);
  }, [i18nLocales, activeLocale, defaultLocale]);
  useEffect(() => {
    if (!i18nLocales.includes(cmpSource)) setCmpSource(defaultLocale);
  }, [i18nLocales, cmpSource, defaultLocale]);
  useEffect(() => {
    if (!cmpTarget || !i18nLocales.includes(cmpTarget) || cmpTarget === cmpSource) {
      setCmpTarget(i18nLocales.find((l) => l !== cmpSource) ?? "");
    }
  }, [i18nLocales, cmpTarget, cmpSource]);

  const notEmpty = (v: unknown) => v !== undefined && v !== null && v !== "";
  const localeMap = (name: string): Record<string, unknown> => {
    const v = draft[name];
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  };
  const localizedFields = useMemo(() => fields.filter((f) => f.localized), [fields]);
  const filledForLocale = (loc: string) =>
    localizedFields.filter((f) => notEmpty(localeMap(f.name)[loc])).length;
  // Small conic-gradient completeness ring (0..1 filled) in the brand green.
  const localeRing = (p: number): ReactNode => (
    <span
      aria-hidden
      style={{
        width: 13,
        height: 13,
        borderRadius: 999,
        flex: "none",
        background: `conic-gradient(var(--primary) ${Math.round(p * 360)}deg, color-mix(in oklab, var(--muted-foreground) 45%, transparent) 0)`,
        WebkitMask: "radial-gradient(circle 3px at center, transparent 98%, #000 100%)",
        mask: "radial-gradient(circle 3px at center, transparent 98%, #000 100%)",
      }}
    />
  );

  const renderField = (f: SchemaField, forceRequired = false): ReactNode => {
    // Presentational blocks — no input, no value. A divider is a labeled rule;
    // a notice is an info callout whose text comes from the field's note
    // (`description`), falling back to the display label.
    if (f.type === "divider") {
      const text = fieldLabel(f, i18n.locale) || "";
      return (
        <div key={f.name} className="flex items-center gap-3 pt-1 first:pt-0">
          {text && (
            <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {text}
            </span>
          )}
          <span className="h-px flex-1 bg-border" />
        </div>
      );
    }
    if (f.type === "notice") {
      const text = f.description || fieldLabel(f, i18n.locale) || "";
      return (
        <div
          key={f.name}
          className="flex items-start gap-2.5 rounded-control border border-primary/25 bg-primary/5 p-3 text-[12.5px] text-foreground"
        >
          <I.Info size={15} className="mt-px shrink-0 text-primary" />
          <span className="min-w-0">{text}</span>
        </div>
      );
    }
    const val = draft[f.name];
    const err = errors[f.name];
    const iface = f.interface;
    const setField = (v: unknown) => {
      form.updateField(f.name, v);
      form.setFieldTouched(f.name);
    };
    const errBlock = err ? (
      <div className="flex items-center gap-1 text-[11.5px] text-destructive">
        <I.AlertTriangle size={11} />
        {err}
      </div>
    ) : null;
    const typeLabel = (iface ?? f.type ?? "text") + (f.unique ? " · unique" : "");
    const reqMark =
      f.required || f.nullable === false || forceRequired ? (
        <span style={{ color: "var(--destructive)" }}>*</span>
      ) : null;
    const previewable = !!iface && PREVIEWABLE.has(iface) && !f.localized;
    const showPreview = previewable && !!previews[f.name];
    const label = (
      <>
        <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">
          {fieldLabel(f, i18n.locale)}{" "}
          <Badge variant="outline" mono>
            {typeLabel}
          </Badge>{" "}
          {reqMark}
          {previewable && (
            <button
              type="button"
              onClick={() => setPreviews((p) => ({ ...p, [f.name]: !p[f.name] }))}
              className="ml-auto inline-flex items-center gap-1 rounded-control border border-border bg-card px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
            >
              <I.Eye size={11} />
              {showPreview ? <Trans>Edit</Trans> : <Trans>Preview</Trans>}
            </button>
          )}
        </label>
        {f.description ? (
          <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
            {f.description}
          </p>
        ) : null}
      </>
    );

    // ── Extension-contributed field editors ───────────────────────────────
    // Runs ahead of every built-in interface branch: when the field's
    // persisted `interface` matches an enabled extension's fieldEditors
    // contribution, a sandboxed iframe owns the input. Wrapped in the same
    // label + error chrome as the built-ins so the form layout stays uniform.
    const extEditor = iface ? extFieldEditors.get(iface) : undefined;
    if (extEditor) {
      return (
        <div key={f.name} className="flex flex-col gap-1.5">
          {label}
          <ExtensionFrame
            extension={extEditor.extension}
            entry={extEditor.entry}
            mode="field-editor"
            value={val}
            field={f}
            onValueChange={setField}
          />
          {errBlock}
        </div>
      );
    }

    // ── Localized (sidecar) fields ────────────────────────────────────────
    // Any type can be `localized`; the value is a `{locale: value}` map. Instead
    // of stacking every workspace language under the field, the locale bar picks
    // ONE active language (`single`) — or two to compare — so the form keeps its
    // natural height. See the bar rendered above the fields.
    if (f.localized) {
      const map = val && typeof val === "object" && !Array.isArray(val)
        ? (val as Record<string, unknown>)
        : {};
      const filled = i18nLocales.filter((l) => notEmpty(map[l])).length;
      const isNum = f.type === "integer" || f.type === "number";
      const isBool = f.type === "boolean";
      const isLong =
        f.type === "longtext" || iface === "markdown" || iface === "richtext" || iface === "code";
      const locChoices = readChoices(f);
      const isChoice = (iface === "dropdown" || iface === "radio") && locChoices.length > 0;
      const isDate = iface === "date" || f.type === "timestamp";
      const isColor = iface === "color";
      const write = (loc: string, v: unknown) => setField({ ...map, [loc]: v });
      const coerce = (raw: string): unknown => (isNum ? (raw === "" ? undefined : Number(raw)) : raw);

      // Render the real per-interface editor for ONE locale's value, so a
      // localized choice field stays a dropdown (not free text), a date stays a
      // date picker, etc. Falls back to a text/number input.
      const control = (v: unknown, set: (nv: unknown) => void, ph?: string): ReactNode => {
        if (isBool) {
          return (
            <div className="flex items-center rounded-control border border-border bg-card px-3 py-2">
              <Switch checked={v === true} onChange={set} />
            </div>
          );
        }
        if (isChoice) {
          const cur = String(v ?? "");
          const base = locChoices.map((c) => ({
            value: c.value,
            label: c.label ?? c.value,
            icon: c.color ? (
              <span
                style={{ display: "inline-block", width: 8, height: 8, borderRadius: 999, background: c.color }}
              />
            ) : undefined,
          }));
          const options =
            cur && !locChoices.some((c) => c.value === cur) ? [...base, { value: cur, label: cur }] : base;
          return <Select value={cur} onChange={set} options={options} placeholder={ph ?? t`Pick…`} />;
        }
        if (isDate) {
          const iso = typeof v === "string" ? v : "";
          return (
            <Input
              type="date"
              value={iso ? iso.slice(0, 10) : ""}
              aria-invalid={!!err || undefined}
              onChange={(e) =>
                set(e.target.value ? new Date(`${e.target.value}T00:00:00Z`).toISOString() : undefined)
              }
            />
          );
        }
        if (isColor) {
          const hex = typeof v === "string" ? v : "";
          return (
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                type="color"
                value={/^#[0-9a-fA-F]{6}$/.test(hex) ? hex : "#A1A6B8"}
                onChange={(e) => set(e.target.value)}
                style={{ height: 36, width: 52, borderRadius: 10, border: "1px solid var(--border)", background: "var(--card)", cursor: "pointer", padding: 2 }}
              />
              <Input
                className="font-mono"
                value={hex}
                placeholder="#RRGGBB"
                onChange={(e) => set(e.target.value)}
                style={{ flex: 1 }}
              />
            </div>
          );
        }
        if (iface === "file" || iface === "image") {
          return (
            <FilePicker
              value={String(v ?? "")}
              onChange={set}
              kind={iface === "image" ? "image" : "file"}
              error={!!err}
            />
          );
        }
        if (iface === "user") {
          return <AppUserPicker value={String(v ?? "")} onChange={set} error={!!err} />;
        }
        if (iface === "relation" || f.type === "relation") {
          return f.to ? (
            <RelationPicker value={String(v ?? "")} onChange={set} target={f.to} error={!!err} />
          ) : (
            <Input
              className="font-mono"
              value={String(v ?? "")}
              placeholder="id"
              aria-invalid={!!err || undefined}
              onChange={(e) => set(e.target.value)}
            />
          );
        }
        if (isLong) {
          return (
            <Textarea
              rows={4}
              value={v == null ? "" : String(v)}
              aria-invalid={!!err || undefined}
              placeholder={ph}
              onChange={(e) => set(e.target.value)}
            />
          );
        }
        return (
          <Input
            type={isNum ? "number" : undefined}
            value={v == null ? "" : String(v)}
            aria-invalid={!!err || undefined}
            placeholder={ph}
            onChange={(e) => set(coerce(e.target.value))}
          />
        );
      };

      // Read-only text of a locale's value (compare source column + single-mode
      // source-language context line). Choices resolve to their label.
      const displayText = (v: unknown): string => {
        if (isChoice) return locChoices.find((c) => c.value === String(v))?.label ?? String(v ?? "");
        if (isDate) return typeof v === "string" && v ? v.slice(0, 10) : String(v ?? "");
        if (isBool) return String(v === true);
        return String(v ?? "");
      };

      // A compact header: field label + the `localized` marker + a right slot.
      const header = (right: ReactNode): ReactNode => (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">
              {fieldLabel(f, i18n.locale)}
              <Badge variant="outline" mono>
                {typeLabel}
              </Badge>
              <Badge variant="outline" className="gap-1 border-primary/40 text-primary">
                <I.Globe size={10} />
                i18n
              </Badge>
              {reqMark}
            </label>
            {right ? <div className="ml-auto flex shrink-0 items-center gap-1.5">{right}</div> : null}
          </div>
          {f.description ? (
            <p className="text-[11px] leading-snug text-muted-foreground">{f.description}</p>
          ) : null}
        </div>
      );

      // Compare — read-only source column ↔ editable target column.
      if (i18nMode === "compare") {
        const sv = map[cmpSource];
        const tv = map[cmpTarget];
        const done = notEmpty(tv);
        return (
          <div key={f.name} className="flex flex-col gap-1.5">
            {header(
              <Badge
                variant="outline"
                className={`text-[10px] ${done ? "border-primary/40 text-primary" : "text-muted-foreground"}`}
              >
                {done ? <Trans>translated</Trans> : <Trans>to do</Trans>}
              </Badge>,
            )}
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div className="flex min-h-9 items-center rounded-control border border-border bg-muted/40 px-3 py-2 text-[13px] text-muted-foreground">
                {notEmpty(sv) ? (
                  isColor ? (
                    <span className="flex items-center gap-2">
                      <span
                        style={{ width: 12, height: 12, borderRadius: 4, background: String(sv), border: "1px solid var(--border)" }}
                      />
                      <span className="truncate font-mono">{String(sv)}</span>
                    </span>
                  ) : (
                    <span className="truncate">{displayText(sv)}</span>
                  )
                ) : (
                  <span className="opacity-60">
                    <Trans>empty</Trans>
                  </span>
                )}
              </div>
              {control(tv, (nv) => write(cmpTarget, nv))}
            </div>
            {errBlock}
          </div>
        );
      }

      // Single — one input for the active language, with source context + copy.
      const cur = map[activeLocale];
      const baseVal = map[defaultLocale];
      const isBase = activeLocale === defaultLocale;
      const canCopy = !isBase && !notEmpty(cur) && notEmpty(baseVal) && !isBool;
      return (
        <div key={f.name} className="flex flex-col gap-1.5">
          {header(
            <>
              {canCopy && (
                <button
                  type="button"
                  onClick={() => write(activeLocale, baseVal)}
                  className="inline-flex items-center gap-1 rounded-control border border-border bg-card px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
                >
                  <I.Copy size={11} />
                  {t`Copy from ${defaultLocale.toUpperCase()}`}
                </button>
              )}
              <Badge variant="outline" className="text-[10.5px]">
                {filled}/{i18nLocales.length}
              </Badge>
            </>,
          )}
          {control(
            cur,
            (nv) => write(activeLocale, nv),
            isBase ? undefined : t`Translate to ${activeLocale.toUpperCase()}…`,
          )}
          {!isBase && notEmpty(baseVal) && !isBool && (
            <div className="flex items-baseline gap-2 text-[11.5px] text-muted-foreground">
              <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground/80">
                {defaultLocale}
              </span>
              <span className="truncate">{displayText(baseVal)}</span>
            </div>
          )}
          {errBlock}
        </div>
      );
    }

    // ── Selection: choice-bound interfaces ────────────────────────────────
    if (iface === "dropdown") {
      const rawChoices = readChoices(f);
      const current = String(val ?? "");
      const choices =
        current && !rawChoices.some((c) => c.value === current)
          ? [...rawChoices, { value: current }]
          : rawChoices;
      const options = choices.map((c) => ({
        value: c.value,
        label: c.label ?? c.value,
        icon: c.color ? (
          <span
            style={{
              display: "inline-block",
              width: 8,
              height: 8,
              borderRadius: 999,
              background: c.color,
            }}
          />
        ) : undefined,
      }));
      return (
        <div key={f.name} className="flex flex-col gap-1.5">
          {label}
          <Select
            value={current}
            onChange={setField}
            options={options}
            placeholder={f.name === "status" ? t`Pick a status…` : t`Pick…`}
          />
          {errBlock}
        </div>
      );
    }

    if (iface === "radio") {
      const choices = readChoices(f);
      const current = String(val ?? "");
      return (
        <div key={f.name} className="flex flex-col gap-1.5">
          {label}
          <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "4px 2px" }}>
            {choices.length === 0 && (
              <div className="text-xs text-muted-foreground">
                <Trans>No choices configured.</Trans>
              </div>
            )}
            {choices.map((c) => {
              const on = current === c.value;
              return (
                <button
                  key={c.value}
                  type="button"
                  onClick={() => setField(c.value)}
                  data-on={on}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "8px 12px",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius-xl)",
                    background: on ? "var(--muted)" : "var(--card)",
                    cursor: "pointer",
                    textAlign: "left",
                    color: "var(--foreground)",
                    font: "inherit",
                  }}
                >
                  <span
                    style={{
                      width: 14,
                      height: 14,
                      borderRadius: 999,
                      border: `1px solid ${on ? "var(--primary)" : "var(--border)"}`,
                      background: on ? "var(--primary)" : "transparent",
                      boxShadow: on ? "inset 0 0 0 3px var(--card)" : "none",
                      flex: "none",
                    }}
                  />
                  {c.color && (
                    <span
                      style={{ width: 8, height: 8, borderRadius: 999, background: c.color, flex: "none" }}
                    />
                  )}
                  <span style={{ fontSize: 13 }}>{c.label ?? c.value}</span>
                  <span className="ml-auto font-mono text-[11px] text-muted-foreground">{c.value}</span>
                </button>
              );
            })}
          </div>
          {errBlock}
        </div>
      );
    }

    if (iface === "checkboxes") {
      const choices = readChoices(f);
      const selected: string[] = Array.isArray(val) ? (val as string[]).map(String) : [];
      const toggle = (v: string) => {
        const next = selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v];
        setField(next);
      };
      return (
        <div key={f.name} className="flex flex-col gap-1.5">
          {label}
          <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "4px 2px" }}>
            {choices.length === 0 && (
              <div className="text-xs text-muted-foreground">
                <Trans>No choices configured.</Trans>
              </div>
            )}
            {choices.map((c) => {
              const on = selected.includes(c.value);
              return (
                <div
                  key={c.value}
                  onClick={() => toggle(c.value)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "8px 12px",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius-xl)",
                    background: on ? "var(--muted)" : "var(--card)",
                    cursor: "pointer",
                  }}
                >
                  <Checkbox checked={on} onChange={() => toggle(c.value)} />
                  {c.color && (
                    <span
                      style={{ width: 8, height: 8, borderRadius: 999, background: c.color, flex: "none" }}
                    />
                  )}
                  <span style={{ fontSize: 13 }}>{c.label ?? c.value}</span>
                  <span className="ml-auto font-mono text-[11px] text-muted-foreground">{c.value}</span>
                </div>
              );
            })}
          </div>
          {errBlock}
        </div>
      );
    }

    if (iface === "dropdown_multiple") {
      const choices = readChoices(f);
      const selected: string[] = Array.isArray(val) ? (val as string[]).map(String) : [];
      const toggle = (v: string) => {
        const next = selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v];
        setField(next);
      };
      return (
        <div key={f.name} className="flex flex-col gap-1.5">
          {label}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: "4px 2px" }}>
            {choices.length === 0 && (
              <div className="text-xs text-muted-foreground">
                <Trans>No choices configured.</Trans>
              </div>
            )}
            {choices.map((c) => {
              const on = selected.includes(c.value);
              return (
                <button
                  key={c.value}
                  type="button"
                  onClick={() => toggle(c.value)}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "6px 10px",
                    border: `1px solid ${on ? "var(--primary)" : "var(--border)"}`,
                    borderRadius: 999,
                    background: on ? "var(--color-active-surface)" : "var(--card)",
                    cursor: "pointer",
                    font: "inherit",
                    fontSize: 12.5,
                    color: "var(--foreground)",
                  }}
                >
                  {c.color && (
                    <span style={{ width: 8, height: 8, borderRadius: 999, background: c.color }} />
                  )}
                  {on && <I.Check size={11} />}
                  {c.label ?? c.value}
                </button>
              );
            })}
          </div>
          {errBlock}
        </div>
      );
    }

    if (iface === "tags") {
      const tags: string[] = Array.isArray(val) ? (val as string[]).map(String) : [];
      const input = (draft[`__tag_input::${f.name}`] as string) ?? "";
      const setInput = (v: string) => form.updateField(`__tag_input::${f.name}`, v);
      const add = (raw: string) => {
        const v = raw.trim();
        if (!v) return;
        if (tags.includes(v)) return;
        setField([...tags, v]);
        setInput("");
      };
      return (
        <div key={f.name} className="flex flex-col gap-1.5">
          {label}
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 6,
              alignItems: "center",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-3xl)",
              background: "var(--card)",
              padding: "6px 10px",
              minHeight: 36,
            }}
          >
            {tags.map((tag, i) => (
              <span
                key={`${tag}::${i}`}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  padding: "3px 4px 3px 10px",
                  borderRadius: 999,
                  background: "var(--muted)",
                  fontSize: 12,
                }}
              >
                {tag}
                <button
                  type="button"
                  onClick={() => setField(tags.filter((_, j) => j !== i))}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 18,
                    height: 18,
                    borderRadius: 999,
                    border: "none",
                    background: "transparent",
                    cursor: "pointer",
                    color: "var(--muted-foreground)",
                  }}
                  aria-label={t`Remove ${tag}`}
                >
                  <I.X size={11} />
                </button>
              </span>
            ))}
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === ",") {
                  e.preventDefault();
                  add(input);
                } else if (e.key === "Backspace" && !input && tags.length) {
                  setField(tags.slice(0, -1));
                }
              }}
              onBlur={() => input && add(input)}
              placeholder={tags.length ? "" : t`Type and press Enter…`}
              data-enter-newline="true"
              style={{
                flex: 1,
                minWidth: 100,
                border: "none",
                outline: "none",
                background: "transparent",
                font: "inherit",
                fontSize: 13,
                padding: "2px 0",
                color: "var(--foreground)",
              }}
            />
          </div>
          {errBlock}
        </div>
      );
    }

    if (iface === "toggle" || f.type === "boolean") {
      return (
        <div key={f.name} className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-3">
            <div>{label}</div>
            <Switch checked={!!val} onChange={(on) => setField(on)} />
          </div>
          {errBlock}
        </div>
      );
    }

    // ── Numeric ───────────────────────────────────────────────────────────
    if (iface === "slider") {
      const min = f.options?.min ?? 0;
      const max = f.options?.max ?? 100;
      const step = f.options?.step ?? 1;
      const num = val === "" || val == null ? min : Number(val);
      return (
        <div key={f.name} className="flex flex-col gap-1.5">
          {label}
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <input
              type="range"
              min={min}
              max={max}
              step={step}
              value={Number.isFinite(num) ? num : min}
              onChange={(e) => setField(e.target.value)}
              style={{ flex: 1, accentColor: "var(--primary)" }}
            />
            <span
              className="font-mono tabular-nums"
              style={{ fontSize: 12.5, minWidth: 40, textAlign: "right" }}
            >
              {Number.isFinite(num) ? num : min}
            </span>
          </div>
          {errBlock}
        </div>
      );
    }

    if (iface === "rating") {
      const max = f.options?.max ?? 5;
      const num = Math.max(0, Math.min(max, Number(val) || 0));
      return (
        <div key={f.name} className="flex flex-col gap-1.5">
          {label}
          <div style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            {Array.from({ length: max }, (_, i) => i + 1).map((star) => {
              const on = star <= num;
              return (
                <button
                  key={star}
                  type="button"
                  onClick={() => setField(star === num ? 0 : star)}
                  title={`${star}/${max}`}
                  style={{
                    width: 28,
                    height: 28,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    border: "none",
                    background: "transparent",
                    cursor: "pointer",
                    color: on ? "var(--primary)" : "var(--muted-foreground)",
                  }}
                >
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill={on ? "currentColor" : "none"}
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                  </svg>
                </button>
              );
            })}
            <span className="ml-2 tabular-nums text-xs text-muted-foreground">
              {num}/{max}
            </span>
          </div>
          {errBlock}
        </div>
      );
    }

    if (iface === "integer" || iface === "decimal" || f.type === "integer" || f.type === "number") {
      const isInt = iface === "integer" || f.type === "integer";
      return (
        <div key={f.name} className="flex flex-col gap-1.5">
          {label}
          <Input
            className="tabular-nums"
            type="number"
            step={isInt ? 1 : "any"}
            value={val === null || val === undefined ? "" : String(val)}
            aria-invalid={!!err || undefined}
            onChange={(e) => setField(e.target.value)}
          />
          {errBlock}
        </div>
      );
    }

    // ── Temporal ──────────────────────────────────────────────────────────
    if (iface === "date" && f.type === "timestamp") {
      const iso = typeof val === "string" ? val : "";
      const dateOnly = iso ? iso.slice(0, 10) : "";
      return (
        <div key={f.name} className="flex flex-col gap-1.5">
          {label}
          <Input
            type="date"
            value={dateOnly}
            aria-invalid={!!err || undefined}
            onChange={(e) =>
              setField(e.target.value ? new Date(e.target.value + "T00:00:00Z").toISOString() : null)
            }
          />
          {errBlock}
        </div>
      );
    }
    if (f.type === "timestamp") {
      const iso = typeof val === "string" ? val : "";
      return (
        <div key={f.name} className="flex flex-col gap-1.5">
          {label}
          <DatePicker value={iso || null} onChange={(next) => setField(next)} />
          {errBlock}
        </div>
      );
    }

    // ── Visual / specialty text ──────────────────────────────────────────
    if (iface === "color") {
      const hex = typeof val === "string" ? val : "";
      return (
        <div key={f.name} className="flex flex-col gap-1.5">
          {label}
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="color"
              value={/^#[0-9a-fA-F]{6}$/.test(hex) ? hex : "#A1A6B8"}
              onChange={(e) => setField(e.target.value)}
              style={{
                height: 36,
                width: 52,
                borderRadius: 10,
                border: "1px solid var(--border)",
                background: "var(--card)",
                cursor: "pointer",
                padding: 2,
              }}
            />
            <Input
              className="font-mono"
              value={hex}
              placeholder="#RRGGBB"
              aria-invalid={!!err || undefined}
              onChange={(e) => setField(e.target.value)}
              style={{ flex: 1 }}
            />
          </div>
          {errBlock}
        </div>
      );
    }

    if (iface === "icon") {
      const name = typeof val === "string" ? val : "";
      const Match = (I as Record<string, unknown>)[name] as
        | ((p: { size?: number }) => ReactNode)
        | undefined;
      return (
        <div key={f.name} className="flex flex-col gap-1.5">
          {label}
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <div
              style={{
                width: 36,
                height: 36,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                border: "1px solid var(--border)",
                borderRadius: 10,
                background: "var(--card)",
                color: Match ? "var(--foreground)" : "var(--muted-foreground)",
              }}
            >
              {Match ? <Match size={16} /> : <I.Bolt size={14} />}
            </div>
            <Input
              className="font-mono"
              value={name}
              placeholder="lucide icon name…"
              aria-invalid={!!err || undefined}
              onChange={(e) => setField(e.target.value)}
              style={{ flex: 1 }}
            />
          </div>
          {errBlock}
        </div>
      );
    }

    if (iface === "url") {
      return (
        <div key={f.name} className="flex flex-col gap-1.5">
          {label}
          <Input
            type="url"
            inputMode="url"
            value={String(val ?? "")}
            placeholder="https://…"
            aria-invalid={!!err || undefined}
            onChange={(e) => setField(e.target.value)}
          />
          {errBlock}
        </div>
      );
    }
    if (iface === "email") {
      return (
        <div key={f.name} className="flex flex-col gap-1.5">
          {label}
          <Input
            type="email"
            inputMode="email"
            value={String(val ?? "")}
            placeholder="name@example.com"
            aria-invalid={!!err || undefined}
            onChange={(e) => setField(e.target.value)}
          />
          {errBlock}
        </div>
      );
    }

    if (iface === "slug") {
      return (
        <div key={f.name} className="flex flex-col gap-1.5">
          {label}
          <Input
            className="font-mono"
            value={String(val ?? "")}
            placeholder="my-post-slug"
            aria-invalid={!!err || undefined}
            onChange={(e) => {
              const v = e.target.value.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
              setField(v);
            }}
          />
          {errBlock}
        </div>
      );
    }

    // ── Long-form text variants ───────────────────────────────────────────
    if (iface === "code" || iface === "markdown" || iface === "richtext" || f.type === "longtext") {
      const monoIfaces = iface === "code" || iface === "markdown";
      const raw = String(val ?? "");
      return (
        <div key={f.name} className="flex flex-col gap-1.5">
          {label}
          {showPreview ? (
            <div
              className="prose-preview min-h-[8rem] rounded-control border border-border bg-card px-3.5 py-3 text-[13px] text-foreground"
              // richtext is authored HTML; markdown is escaped then formatted.
              dangerouslySetInnerHTML={{
                __html: iface === "richtext" ? raw : renderMarkdown(raw),
              }}
            />
          ) : (
            <Textarea
              rows={iface === "richtext" ? 8 : 6}
              value={raw}
              placeholder={
                iface === "markdown"
                  ? "# Heading\n\nWrite Markdown…"
                  : iface === "code"
                    ? "// code"
                    : ""
              }
              style={!monoIfaces ? { fontFamily: "inherit" } : undefined}
              aria-invalid={!!err || undefined}
              onChange={(e) => setField(e.target.value)}
            />
          )}
          {iface === "richtext" && !showPreview && (
            <div className="text-[11.5px] text-muted-foreground">
              <Trans>
                Stored as HTML. The full WYSIWYG editor isn't wired yet — paste pre-formatted HTML or
                basic markup, then hit Preview.
              </Trans>
            </div>
          )}
          {errBlock}
        </div>
      );
    }

    // ── Raw JSON / map ────────────────────────────────────────────────────
    if (f.type === "json" && iface !== "files") {
      return (
        <div key={f.name} className="flex flex-col gap-1.5">
          {label}
          <Textarea
            rows={4}
            value={String(val ?? "")}
            placeholder={iface === "map" ? `{ "type":"Point", "coordinates":[0,0] }` : "[] or {}"}
            aria-invalid={!!err || undefined}
            onChange={(e) => setField(e.target.value)}
          />
          {errBlock}
        </div>
      );
    }

    // ── Relational ────────────────────────────────────────────────────────
    if (iface === "relation" || f.type === "relation") {
      const target = f.to || "";
      return (
        <div key={f.name} className="flex flex-col gap-1.5">
          {label}
          {target ? (
            <RelationPicker
              value={String(val ?? "")}
              onChange={setField}
              target={target}
              error={!!err}
            />
          ) : (
            <Input
              className="font-mono"
              value={String(val ?? "")}
              placeholder="id"
              aria-invalid={!!err || undefined}
              onChange={(e) => setField(e.target.value)}
            />
          )}
          <div className="text-[11.5px] text-muted-foreground">
            <Trans>
              Stores a row id from <span className="font-mono">c_{target || "—"}</span>.
            </Trans>
            {!target && <Trans> Set the target collection in the field settings.</Trans>}
          </div>
          {errBlock}
        </div>
      );
    }
    // App-user link — the value is an `app_users.id`; the picker searches the
    // workspace's end-user pool and shows email (+ name) for the current id.
    if (iface === "user") {
      return (
        <div key={f.name} className="flex flex-col gap-1.5">
          {label}
          <AppUserPicker value={String(val ?? "")} onChange={setField} error={!!err} />
          <div className="text-[11.5px] text-muted-foreground">
            <Trans>
              Stores a workspace end-user id from <span className="font-mono">app_users</span>.
            </Trans>
          </div>
          {errBlock}
        </div>
      );
    }
    if (iface === "file" || iface === "image") {
      return (
        <div key={f.name} className="flex flex-col gap-1.5">
          {label}
          <FilePicker
            value={String(val ?? "")}
            onChange={setField}
            kind={iface === "image" ? "image" : "file"}
            error={!!err}
          />
          <div className="text-[11.5px] text-muted-foreground">
            <Trans>
              Stores the storage key. Upload new files on the <span className="font-mono">Storage</span> page.
            </Trans>
          </div>
          {errBlock}
        </div>
      );
    }
    if (iface === "files") {
      const arr: string[] = Array.isArray(val) ? (val as string[]).map(String) : [];
      return (
        <div key={f.name} className="flex flex-col gap-1.5">
          {label}
          <MultiFilePicker value={arr} onChange={setField} error={!!err} />
          <div className="text-[11.5px] text-muted-foreground">
            <Trans>
              Stores a list of storage keys. Upload new files on the{" "}
              <span className="font-mono">Storage</span> page.
            </Trans>
          </div>
          {errBlock}
        </div>
      );
    }

    if (iface === "uuid" || f.type === "uuid") {
      return (
        <div key={f.name} className="flex flex-col gap-1.5">
          {label}
          <Input
            className="font-mono"
            value={String(val ?? "")}
            placeholder="00000000-0000-0000-0000-000000000000"
            aria-invalid={!!err || undefined}
            onChange={(e) => setField(e.target.value)}
            autoComplete="off"
          />
          {errBlock}
        </div>
      );
    }

    // ── Hashed secret (password / PIN / token) — write-only, never read back ──
    if (iface === "hash" || f.type === "hash") {
      return (
        <div key={f.name} className="flex flex-col gap-1.5">
          {label}
          <Input
            type="password"
            value={String(val ?? "")}
            placeholder={t`Enter a value…`}
            aria-invalid={!!err || undefined}
            onChange={(e) => setField(e.target.value)}
            autoComplete="new-password"
          />
          <div className="text-[11.5px] text-muted-foreground">
            <Trans>
              Stored as a one-way hash — it's never shown again. Leave blank to keep the current value.
            </Trans>
          </div>
          {errBlock}
        </div>
      );
    }

    // text / autocomplete / input (free text fallback)
    const autoSlug = f.name === "slug" && !touched.slug && fields.some((x) => x.name === "title");
    return (
      <div key={f.name} className="flex flex-col gap-1.5">
        {label}
        <Input
          className={f.name === "slug" ? "font-mono" : undefined}
          value={String(val ?? "")}
          autoFocus={f.name === "title"}
          aria-invalid={!!err || undefined}
          onChange={(e) => setField(e.target.value)}
          autoComplete="off"
        />
        {err ? (
          <div className="flex items-center gap-1 text-[11.5px] text-destructive">
            <I.AlertTriangle size={11} />
            {err}
          </div>
        ) : (
          autoSlug && (
            <div className="text-[11.5px] text-muted-foreground">
              <Trans>Auto-derived from title until edited.</Trans>
            </div>
          )
        )}
      </div>
    );
  };

  // Apply live field conditions: hidden ⇒ skip, readonly ⇒ non-interactive
  // wrapper, required ⇒ force the `*` marker. Effects recompute on every draft
  // change (renders inside the form).
  const renderFieldWrapped = (f: SchemaField): ReactNode => {
    const eff = fieldEffects(f, draft);
    if (eff.hidden) return null;
    const node = renderField(f, eff.required);
    if (!node) return null;
    const base = !eff.readonly ? (
      node
    ) : (
      <div key={f.name} aria-disabled className="pointer-events-none select-none opacity-60">
        {node}
      </div>
    );
    if (!collab || isPresentational(f)) return base;
    // Field awareness: an outline + name badge when another member holds this
    // field, and focus/blur capture to announce this member's own position.
    // Advisory only — the field stays editable.
    const holders = collab.peersByField[f.name] ?? [];
    const holder = holders[0];
    return (
      <div
        key={f.name}
        className="relative rounded-control"
        style={holder ? { outline: `1.5px solid ${holder.color}`, outlineOffset: 4 } : undefined}
        onFocusCapture={() => collab.onFieldFocus(f.name)}
        onBlurCapture={(e) => {
          // Focus moving within the same field (e.g. input → its clear button)
          // isn't a blur for awareness purposes.
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
          collab.onFieldBlur(f.name);
        }}
      >
        {holder && (
          <span
            className="absolute -top-2.5 right-1 z-10 max-w-[45%] truncate rounded-full px-1.5 text-[10px] font-medium leading-4 text-white"
            style={{ background: holder.color }}
            title={t`Currently editing this field`}
          >
            {peerHandle(holder)}
            {holders.length > 1 ? ` +${holders.length - 1}` : ""}
          </span>
        )}
        {base}
      </div>
    );
  };

  if (fields.length === 0) {
    return (
      <div className="rounded-control bg-muted p-3 text-[13px] text-muted-foreground">
        <Trans>
          No editable fields. Add columns from the Schema tab to capture data on this collection.
        </Trans>
      </div>
    );
  }

  // Pack a field list into rows, pairing two consecutive `width:"half"` fields
  // into a 2-column grid (single column on mobile). Presentational blocks and
  // full-width fields always take their own row and break any half-pair.
  const isHalf = (f: SchemaField) => f.width === "half" && !isPresentational(f);
  const packRows = (list: SchemaField[], keyPrefix: string): ReactNode[] => {
    const rows: ReactNode[] = [];
    let i = 0;
    while (i < list.length) {
      const f = list[i]!;
      const next = list[i + 1];
      if (isHalf(f) && next && isHalf(next)) {
        rows.push(
          <div key={`${keyPrefix}:row:${i}`} className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-5">
            {renderFieldWrapped(f)}
            {renderFieldWrapped(next)}
          </div>,
        );
        i += 2;
      } else {
        rows.push(renderFieldWrapped(f));
        i += 1;
      }
    }
    return rows;
  };

  // Group fields only when at least one declares a group; otherwise flat.
  const grouped = fields.some((f) => groupOf(f));
  const body = !grouped ? (
    <div className="flex flex-col gap-8">{packRows(fields, "flat")}</div>
  ) : (
    (() => {
      const groups = new Map<string, SchemaField[]>();
      for (const f of fields) {
        const g = groupOf(f) ?? t`General`;
        const arr = groups.get(g) ?? [];
        arr.push(f);
        groups.set(g, arr);
      }
      const groupNames = [...groups.keys()];

      // Tabs mode — one tab per group; only the active group's fields show.
      if (fields.some((f) => f.sectionsAsTabs) && groupNames.length > 1) {
        const active = activeTab && groups.has(activeTab) ? activeTab : groupNames[0]!;
        return (
          <div className="flex flex-col gap-5">
            <div className="flex flex-wrap gap-1 border-b border-border">
              {groupNames.map((g) => (
                <button
                  key={g}
                  type="button"
                  aria-selected={active === g}
                  onClick={() => setActiveTab(g)}
                  className={`-mb-px border-b-2 px-3 py-2 text-[12.5px] font-medium transition-colors ${
                    active === g
                      ? "border-primary text-foreground"
                      : "border-transparent text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {g}
                </button>
              ))}
            </div>
            <div className="flex flex-col gap-4">{packRows(groups.get(active)!, active)}</div>
          </div>
        );
      }

      return (
        <div className="flex flex-col gap-7">
          {[...groups.entries()].map(([g, gf]) => {
            const rows = packRows(gf, g);
            // A section folds when ANY of its fields opts in (aggregated).
            const collapsible = gf.some((f) => f.sectionCollapsible || f.sectionCollapsed);
            const collapsed = collapsible && collapsedSections.has(g);
            if (!collapsible) {
              return (
                <section key={g} className="flex flex-col gap-4">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {g}
                  </div>
                  {rows}
                </section>
              );
            }
            return (
              <section key={g} className="flex flex-col gap-4">
                <button
                  type="button"
                  aria-expanded={!collapsed}
                  onClick={() =>
                    setCollapsedSections((s) => {
                      const n = new Set(s);
                      if (n.has(g)) n.delete(g);
                      else n.add(g);
                      return n;
                    })
                  }
                  className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground"
                >
                  <I.ChevronRight size={13} className={`shrink-0 transition-transform ${collapsed ? "" : "rotate-90"}`} />
                  {g}
                </button>
                {!collapsed && rows}
              </section>
            );
          })}
        </div>
      );
    })()
  );

  // Locale bar — the single switcher for every localized field in the form.
  // Hidden unless the collection has localized fields AND the workspace ships
  // more than one language (a single language needs no switcher).
  const showLocaleBar = localizedFields.length > 0 && i18nLocales.length > 1;
  const totalCells = localizedFields.length * i18nLocales.length;
  const filledCells = i18nLocales.reduce((a, l) => a + filledForLocale(l), 0);
  const docPct = totalCells ? Math.round((filledCells / totalCells) * 100) : 0;
  const modeBtn = (m: "single" | "compare", node: ReactNode) => (
    <button
      type="button"
      aria-pressed={i18nMode === m}
      onClick={() => setI18nMode(m)}
      className={`rounded-md px-2.5 py-1 text-[11.5px] font-medium transition-colors ${
        i18nMode === m ? "bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {node}
    </button>
  );

  if (!showLocaleBar) return body;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-control border border-border bg-card/60 p-2.5">
        <div className="inline-flex rounded-lg border border-border bg-card p-0.5">
          {modeBtn("single", <Trans>Single</Trans>)}
          {modeBtn("compare", <Trans>Compare</Trans>)}
        </div>
        {i18nMode === "single" ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {i18nLocales.map((loc) => {
              const n = filledForLocale(loc);
              const on = loc === activeLocale;
              return (
                <button
                  key={loc}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setActiveLocale(loc)}
                  title={`${loc.toUpperCase()} — ${n}/${localizedFields.length}`}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[11.5px] uppercase transition-colors ${
                    on
                      ? "border-primary/60 bg-primary/15 text-foreground"
                      : "border-border bg-card text-foreground/80 hover:border-primary/30 hover:text-foreground"
                  }`}
                >
                  {localeRing(localizedFields.length ? n / localizedFields.length : 0)}
                  {loc}
                  {loc === defaultLocale && (
                    <span className="text-[9px] text-primary" title={t`Source language`}>
                      ◆
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-1.5 font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
            <Trans>Source</Trans>
            <Select
              size="sm"
              value={cmpSource}
              onChange={setCmpSource}
              options={i18nLocales.map((l) => ({ value: l, label: l.toUpperCase() }))}
              className="w-20"
            />
            <span aria-hidden>→</span>
            <Trans>Target</Trans>
            <Select
              size="sm"
              value={cmpTarget}
              onChange={setCmpTarget}
              options={i18nLocales
                .filter((l) => l !== cmpSource)
                .map((l) => ({ value: l, label: l.toUpperCase() }))}
              className="w-20"
            />
          </div>
        )}
        <div
          className="ml-auto flex items-center gap-2"
          title={t`Localized values filled across every language`}
        >
          <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-300"
              style={{ width: `${docPct}%` }}
            />
          </div>
          <span className="font-mono text-[11px] tabular-nums text-muted-foreground">{docPct}%</span>
        </div>
      </div>
      {body}
    </div>
  );
}
