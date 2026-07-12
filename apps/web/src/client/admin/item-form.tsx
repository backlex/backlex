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
import { useSettings } from "./queries";

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
  /** Optional layout group. Fields sharing a group render under one heading;
   *  ungrouped fields render flat. No-op until a collection assigns groups. */
  group?: string;
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

const blankFor = (f: SchemaField): unknown => {
  if (isArrayInterface(f)) return [];
  switch (f.type) {
    case "boolean":
      return false;
    // i18n_text holds a per-locale map `{ en, tr, … }`; start empty.
    case "i18n_text":
      return {};
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
    for (const f of fields) d[f.name] = blankFor(f);
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
        if (isArrayInterface(f)) {
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
        } else if (f.type === "i18n_text") {
          // Keep the per-locale map; wrap a bare legacy string (from a column
          // converted text→i18n_text) under `en` so it stays editable.
          base[f.name] =
            v && typeof v === "object" && !Array.isArray(v)
              ? v
              : typeof v === "string" && v
                ? { en: v }
                : {};
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
      if (isArrayInterface(f)) {
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
      } else if (f.type === "i18n_text") {
        // Send the per-locale map, dropping empty languages so we don't store
        // `{ tr: "" }`. The API accepts the object form for i18n_text.
        const map = raw && typeof raw === "object" && !Array.isArray(raw)
          ? (raw as Record<string, unknown>)
          : {};
        const out: Record<string, string> = {};
        for (const [loc, v] of Object.entries(map)) {
          if (typeof v === "string" && v.trim()) out[loc] = v;
        }
        payload[f.name] = out;
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

/**
 * Renders every editable field for a collection row from `form`. Groups fields
 * by their optional `group` when any are assigned; otherwise renders flat.
 */
export function ItemFields({ form }: { form: ItemForm }) {
  const { t } = useLingui();
  const { fields, draft, errors, touched } = form;
  const [previews, setPreviews] = useState<Record<string, boolean>>({});

  // Workspace languages drive the per-locale inputs for `i18n_text` fields.
  // Falls back to `["en"]` until settings load (or if none are configured).
  const settings = useSettings();
  const i18nLocales = useMemo<string[]>(() => {
    const raw = (settings.data?.data as Record<string, unknown> | undefined)?.i18nLocales;
    return Array.isArray(raw) && raw.length ? (raw as string[]) : ["en"];
  }, [settings.data]);

  const renderField = (f: SchemaField, forceRequired = false): ReactNode => {
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
    const previewable = !!iface && PREVIEWABLE.has(iface);
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

    // ── Translatable text (i18n_text) — one input per workspace language ──
    if (f.type === "i18n_text") {
      const map =
        val && typeof val === "object" && !Array.isArray(val)
          ? (val as Record<string, string>)
          : {};
      // Configured languages first, then any extra locales already on the row
      // (so existing data is never hidden).
      const locales = [
        ...i18nLocales,
        ...Object.keys(map).filter((l) => !i18nLocales.includes(l)),
      ];
      return (
        <div key={f.name} className="flex flex-col gap-1.5">
          {label}
          <div className="flex flex-col gap-2 rounded-control border border-border bg-card p-2.5">
            {locales.map((loc) => (
              <div key={loc} className="flex items-center gap-2">
                <Badge variant="outline" mono className="min-w-12 justify-center uppercase">
                  {loc}
                </Badge>
                <Input
                  value={map[loc] ?? ""}
                  aria-invalid={!!err || undefined}
                  onChange={(e) => setField({ ...map, [loc]: e.target.value })}
                />
              </div>
            ))}
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
    if (!node || !eff.readonly) return node;
    return (
      <div key={f.name} aria-disabled className="pointer-events-none select-none opacity-60">
        {node}
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

  // Group fields only when at least one declares a group; otherwise flat.
  const grouped = fields.some((f) => groupOf(f));
  if (!grouped) {
    return <div className="flex flex-col gap-8">{fields.map(renderFieldWrapped)}</div>;
  }
  const groups = new Map<string, SchemaField[]>();
  for (const f of fields) {
    const g = groupOf(f) ?? t`General`;
    const arr = groups.get(g) ?? [];
    arr.push(f);
    groups.set(g, arr);
  }
  return (
    <div className="flex flex-col gap-7">
      {[...groups.entries()].map(([g, gf]) => (
        <section key={g} className="flex flex-col gap-4">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {g}
          </div>
          {gf.map(renderFieldWrapped)}
        </section>
      ))}
    </div>
  );
}
