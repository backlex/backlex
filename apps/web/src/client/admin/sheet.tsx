// Sheet form for create/edit, ConfirmAction dialog
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { I } from "./icons";
import { type CollectionSchema, type Post } from "./config";
import { Badge, Button, Checkbox, Switch } from "./ui";
import { Input } from "@workeros/ui/components/input";
import { Tabs, TabsList, TabsTrigger } from "@workeros/ui/components/tabs";
import { Textarea } from "@workeros/ui/components/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@workeros/ui/components/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@workeros/ui/components/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@workeros/ui/components/alert-dialog";
import { cn } from "@workeros/ui/lib/utils";
import { Select } from "./select";
import { RelationPicker, FilePicker, MultiFilePicker } from "./relational-pickers";
import { ItemCommentsPanel } from "./item-collaboration";

export interface ItemSheetProps {
  open: boolean;
  mode: "create" | "edit";
  initial: Post | null;
  schema: CollectionSchema;
  onClose: () => void;
  /**
   * Save the current draft. Return value is awaited; if it resolves to `false`
   * the sheet treats it as a validation/API failure and stays dirty (so the
   * user can retry). Anything else (true / undefined / void) is treated as
   * success.
   *
   * `opts.close` is the primary-vs-secondary axis of the split-button:
   *   - `true`  (default, "Save" / `Enter` / `Cmd+Enter` / `Create <slug>`):
   *             on success the parent closes the sheet.
   *   - `false` ("Save and continue" dropdown item): on success the sheet
   *             stays open and the parent is expected to have updated
   *             `initial` so the form re-syncs to the freshly-saved values.
   */
  onSave: (
    draft: Partial<Post>,
    opts?: { close?: boolean },
  ) => void | boolean | Promise<void | boolean>;
}

type SchemaField = {
  name: string;
  type?: string;
  interface?: string;
  required?: boolean;
  nullable?: boolean;
  unique?: boolean;
  options?: {
    choices?: Array<{ value: string; label?: string; color?: string }>;
    values?: string[];
    min?: number;
    max?: number;
    step?: number;
  };
  to?: string;
};

const SYSTEM_FIELDS = new Set(["id", "owner_id", "created_at", "updated_at", "tenant_id", "deleted_at"]);

// Interfaces that store a JSON array of strings (and expect array values in the
// draft, not stringified JSON). Everything else with type=json gets the raw
// textarea editor.
const ARRAY_INTERFACES = new Set(["tags", "dropdown_multiple", "checkboxes", "files"]);
const isArrayInterface = (f: SchemaField) => f.type === "json" && !!f.interface && ARRAY_INTERFACES.has(f.interface);

const blankFor = (f: SchemaField): unknown => {
  if (isArrayInterface(f)) return [];
  switch (f.type) {
    case "boolean": return false;
    case "json": return "";
    case "integer":
    case "number": return "";
    case "timestamp": return null;
    default: return "";
  }
};

const readChoices = (f: SchemaField): Array<{ value: string; label?: string; color?: string }> => {
  if (f.options?.choices?.length) return f.options.choices;
  if (f.options?.values?.length) return f.options.values.map((v) => ({ value: v }));
  return [];
};

export function ItemSheet({ open, mode, initial, schema, onClose, onSave }: ItemSheetProps) {
  const fields = useMemo(() => {
    const all = (schema?.fields ?? []) as SchemaField[];
    // Only render user-defined columns; system columns are surfaced read-only
    // in the footer.
    return all.filter((f) => !SYSTEM_FIELDS.has(f.name));
  }, [schema]);

  const buildDefaults = () => {
    const d: Record<string, unknown> = {};
    for (const f of fields) d[f.name] = blankFor(f);
    return d;
  };

  const [draft, setDraft] = useState<Record<string, unknown>>(buildDefaults);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  // Collaboration tab only renders in edit mode; create mode keeps the
  // single-section layout. Reset to "fields" every time the sheet opens.
  const [activeTab, setActiveTab] = useState<"fields" | "collab">("fields");
  useEffect(() => { if (open) setActiveTab("fields"); }, [open]);

  useEffect(() => {
    if (!open) return;
    const base = buildDefaults();
    if (initial) {
      for (const f of fields) {
        const v = (initial as unknown as Record<string, unknown>)[f.name];
        if (v === undefined) continue;
        if (isArrayInterface(f)) {
          // Backend stores tags/multi-selects as JSON arrays; keep them as
          // arrays in the draft so chip/checkbox editors can bind directly.
          if (Array.isArray(v)) base[f.name] = v;
          else if (typeof v === "string") {
            try { const parsed = JSON.parse(v); base[f.name] = Array.isArray(parsed) ? parsed : []; }
            catch { base[f.name] = []; }
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initial, schema?.slug]);

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
        next.slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
      }
      return next;
    });
  };

  const validate = () => {
    const e: Record<string, string> = {};
    for (const f of fields) {
      if (!(f.required || f.nullable === false)) continue;
      const v = draft[f.name];
      const empty =
        v === undefined ||
        v === null ||
        (typeof v === "string" && !v.trim()) ||
        (Array.isArray(v) && v.length === 0);
      if (empty) e[f.name] = `${f.name} is required`;
    }
    // slug format check, only if a slug column exists
    const slugVal = draft.slug;
    if (typeof slugVal === "string" && slugVal && !/^[a-z0-9-]+$/.test(slugVal)) {
      e.slug = "lowercase letters, digits, and dashes only";
    }
    // raw JSON editors: validate parseable JSON. Array-shape interfaces
    // (tags/checkboxes/etc.) hold arrays in the draft and skip this check.
    for (const f of fields) {
      if (f.type !== "json" || isArrayInterface(f)) continue;
      const raw = draft[f.name];
      if (typeof raw !== "string" || !raw.trim()) continue;
      try { JSON.parse(raw); } catch { e[f.name] = "must be valid json"; }
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const submit = async (opts?: { close?: boolean }) => {
    if (saving) return;
    if (!validate()) return;
    const close = opts?.close ?? true;
    const payload: Record<string, unknown> = {};
    for (const f of fields) {
      const raw = draft[f.name];
      if (raw === undefined) continue;
      if (isArrayInterface(f)) {
        const arr = Array.isArray(raw) ? raw.filter((v) => v !== "" && v != null) : [];
        payload[f.name] = arr;
      } else if (f.type === "json") {
        if (typeof raw === "string" && raw.trim()) {
          try { payload[f.name] = JSON.parse(raw); } catch { payload[f.name] = null; }
        } else if (typeof raw !== "string") {
          payload[f.name] = raw;
        }
        // Empty JSON string: leave the field out so PATCH doesn't clobber
        // an existing value with empty content.
      } else if (f.type === "integer" || f.type === "number") {
        if (raw === "" || raw === null) continue;
        const n = Number(raw);
        if (!Number.isNaN(n)) payload[f.name] = n;
      } else if (f.type === "timestamp") {
        payload[f.name] = raw || null;
      } else if (f.type === "boolean") {
        payload[f.name] = !!raw;
      } else {
        payload[f.name] = raw;
      }
    }
    setSaving(true);
    try {
      await onSave(payload as Partial<Post>, { close });
    } finally {
      setSaving(false);
    }
  };

  // Enter-to-save handler for the body. Both Enter and Cmd/Ctrl+Enter trigger
  // the primary "Save" action (close on success) — matching the split-button's
  // default. We let Enter pass through inside textareas / rich-text editors
  // (so it keeps inserting a newline), and anywhere the active element opts
  // out via `data-enter-newline="true"` (used by the chip-input inside the
  // tags field, which has its own Enter semantics). Cmd/Ctrl+Enter is the
  // documented escape hatch from inside a textarea.
  const onBodyKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Enter") return;
    // If a child handler already consumed Enter (e.g. the tags chip input
    // calls preventDefault to add a chip, the rich-text editor inserts a
    // newline) leave it alone.
    if (e.defaultPrevented) return;
    const target = e.target as HTMLElement | null;
    const tag = target?.tagName?.toLowerCase();
    const isMeta = e.metaKey || e.ctrlKey;
    if (isMeta) {
      e.preventDefault();
      void submit({ close: true });
      return;
    }
    // Don't intercept Enter inside multi-line editors or contenteditable
    // surfaces — they need it for newlines.
    if (tag === "textarea") return;
    if (target?.isContentEditable) return;
    // Honor explicit opt-outs (e.g. anything that wants raw Enter semantics).
    if (target?.closest("[data-enter-newline=\"true\"]")) return;
    // Shift/Alt+Enter are reserved for newline semantics in some editors;
    // don't submit on those modifiers.
    if (e.shiftKey || e.altKey) return;
    // For everything else (Input, Select, Checkbox, Switch buttons, etc.)
    // treat Enter as "submit the form" (primary: close on success).
    e.preventDefault();
    void submit({ close: true });
  };

  if (!open) return null;

  const renderField = (f: SchemaField) => {
    const val = draft[f.name];
    const err = errors[f.name];
    const iface = f.interface;
    const setField = (v: unknown) => { updateField(f.name, v); setTouched((t) => ({ ...t, [f.name]: true })); };
    const errBlock = err ? <div className="flex items-center gap-1 text-[11.5px] text-destructive"><I.AlertTriangle size={11} />{err}</div> : null;
    const typeLabel = (iface ?? f.type ?? "text") + (f.unique ? " · unique" : "");
    const reqMark = f.required || f.nullable === false ? <span style={{ color: "var(--destructive)" }}>*</span> : null;
    const label = (
      <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">
        {f.name} <Badge variant="outline" mono>{typeLabel}</Badge> {reqMark}
      </label>
    );

    // ── Selection: choice-bound interfaces ────────────────────────────────
    if (iface === "dropdown") {
      const rawChoices = readChoices(f);
      const current = String(val ?? "");
      const choices = current && !rawChoices.some((c) => c.value === current)
        ? [...rawChoices, { value: current }]
        : rawChoices;
      const options = choices.map((c) => ({
        value: c.value,
        label: c.label ?? c.value,
        icon: c.color
          ? <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 999, background: c.color }} />
          : undefined,
      }));
      return (
        <div key={f.name} className="flex flex-col gap-1.5">
          {label}
          <Select
            value={current}
            onChange={setField}
            options={options}
            placeholder={f.name === "status" ? "Pick a status…" : "Pick…"}
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
            {choices.length === 0 && <div className="text-xs text-muted-foreground">No choices configured.</div>}
            {choices.map((c) => {
              const on = current === c.value;
              return (
                <button
                  key={c.value}
                  type="button"
                  onClick={() => setField(c.value)}
                  data-on={on}
                  style={{
                    display: "flex", alignItems: "center", gap: 10,
                    padding: "8px 12px", border: "1px solid var(--border)",
                    borderRadius: "var(--radius-xl)", background: on ? "var(--muted)" : "var(--card)",
                    cursor: "pointer", textAlign: "left", color: "var(--foreground)", font: "inherit",
                  }}
                >
                  <span style={{
                    width: 14, height: 14, borderRadius: 999,
                    border: `1px solid ${on ? "var(--primary)" : "var(--border)"}`,
                    background: on ? "var(--primary)" : "transparent",
                    boxShadow: on ? "inset 0 0 0 3px var(--card)" : "none",
                    flex: "none",
                  }} />
                  {c.color && <span style={{ width: 8, height: 8, borderRadius: 999, background: c.color, flex: "none" }} />}
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
            {choices.length === 0 && <div className="text-xs text-muted-foreground">No choices configured.</div>}
            {choices.map((c) => {
              const on = selected.includes(c.value);
              return (
                <div
                  key={c.value}
                  onClick={() => toggle(c.value)}
                  style={{
                    display: "flex", alignItems: "center", gap: 10,
                    padding: "8px 12px", border: "1px solid var(--border)",
                    borderRadius: "var(--radius-xl)", background: on ? "var(--muted)" : "var(--card)",
                    cursor: "pointer",
                  }}
                >
                  <Checkbox checked={on} onChange={() => toggle(c.value)} />
                  {c.color && <span style={{ width: 8, height: 8, borderRadius: 999, background: c.color, flex: "none" }} />}
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
            {choices.length === 0 && <div className="text-xs text-muted-foreground">No choices configured.</div>}
            {choices.map((c) => {
              const on = selected.includes(c.value);
              return (
                <button
                  key={c.value}
                  type="button"
                  onClick={() => toggle(c.value)}
                  style={{
                    display: "inline-flex", alignItems: "center", gap: 6,
                    padding: "6px 10px",
                    border: `1px solid ${on ? "var(--primary)" : "var(--border)"}`,
                    borderRadius: 999,
                    background: on ? "color-mix(in oklch, var(--primary) 18%, var(--card))" : "var(--card)",
                    cursor: "pointer", font: "inherit", fontSize: 12.5, color: "var(--foreground)",
                  }}
                >
                  {c.color && <span style={{ width: 8, height: 8, borderRadius: 999, background: c.color }} />}
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
      const [input, setInput] = [
        (draft[`__tag_input::${f.name}`] as string) ?? "",
        (v: string) => updateField(`__tag_input::${f.name}`, v),
      ];
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
              display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center",
              border: "1px solid var(--border)", borderRadius: "var(--radius-3xl)",
              background: "var(--card)", padding: "6px 10px", minHeight: 36,
            }}
          >
            {tags.map((t, i) => (
              <span
                key={`${t}::${i}`}
                style={{
                  display: "inline-flex", alignItems: "center", gap: 4,
                  padding: "3px 4px 3px 10px", borderRadius: 999,
                  background: "var(--muted)", fontSize: 12,
                }}
              >
                {t}
                <button
                  type="button"
                  onClick={() => setField(tags.filter((_, j) => j !== i))}
                  style={{
                    display: "inline-flex", alignItems: "center", justifyContent: "center",
                    width: 18, height: 18, borderRadius: 999, border: "none",
                    background: "transparent", cursor: "pointer", color: "var(--muted-foreground)",
                  }}
                  aria-label={`Remove ${t}`}
                >
                  <I.X size={11} />
                </button>
              </span>
            ))}
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(input); }
                else if (e.key === "Backspace" && !input && tags.length) setField(tags.slice(0, -1));
              }}
              onBlur={() => input && add(input)}
              placeholder={tags.length ? "" : "Type and press Enter…"}
              style={{
                flex: 1, minWidth: 100, border: "none", outline: "none",
                background: "transparent", font: "inherit", fontSize: 13, padding: "2px 0",
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
              min={min} max={max} step={step}
              value={Number.isFinite(num) ? num : min}
              onChange={(e) => setField(e.target.value)}
              style={{ flex: 1, accentColor: "var(--primary)" }}
            />
            <span className="font-mono tabular-nums" style={{ fontSize: 12.5, minWidth: 40, textAlign: "right" }}>
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
                    width: 28, height: 28, display: "inline-flex", alignItems: "center", justifyContent: "center",
                    border: "none", background: "transparent", cursor: "pointer",
                    color: on ? "var(--primary)" : "var(--muted-foreground)",
                  }}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill={on ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                  </svg>
                </button>
              );
            })}
            <span className="ml-2 tabular-nums text-xs text-muted-foreground">{num}/{max}</span>
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
            onChange={(e) => setField(e.target.value ? new Date(e.target.value + "T00:00:00Z").toISOString() : null)}
          />
          {errBlock}
        </div>
      );
    }
    if (f.type === "timestamp") {
      const iso = typeof val === "string" ? val : "";
      const localValue = iso ? iso.slice(0, 16) : "";
      return (
        <div key={f.name} className="flex flex-col gap-1.5">
          {label}
          <Input
            type="datetime-local"
            value={localValue}
            aria-invalid={!!err || undefined}
            onChange={(e) => setField(e.target.value ? new Date(e.target.value).toISOString() : null)}
          />
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
              style={{ height: 36, width: 52, borderRadius: 10, border: "1px solid var(--border)", background: "var(--card)", cursor: "pointer", padding: 2 }}
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
      const Match = (I as Record<string, unknown>)[name] as ((p: { size?: number }) => ReactNode) | undefined;
      return (
        <div key={f.name} className="flex flex-col gap-1.5">
          {label}
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <div style={{
              width: 36, height: 36, display: "inline-flex", alignItems: "center", justifyContent: "center",
              border: "1px solid var(--border)", borderRadius: 10, background: "var(--card)",
              color: Match ? "var(--foreground)" : "var(--muted-foreground)",
            }}>
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
      return (
        <div key={f.name} className="flex flex-col gap-1.5">
          {label}
          <Textarea
            rows={iface === "richtext" ? 8 : 6}
            value={String(val ?? "")}
            placeholder={iface === "markdown" ? "# Heading\\n\\nWrite Markdown…" : iface === "code" ? "// code" : ""}
            style={!monoIfaces ? { fontFamily: "inherit" } : undefined}
            aria-invalid={!!err || undefined}
            onChange={(e) => setField(e.target.value)}
          />
          {iface === "richtext" && (
            <div className="text-[11.5px] text-muted-foreground">Stored as HTML. The full WYSIWYG editor isn't wired yet — paste pre-formatted HTML or basic markup.</div>
          )}
          {errBlock}
        </div>
      );
    }

    // ── Raw JSON / map ────────────────────────────────────────────────────
    // `files` is type=json but has its own picker below, so skip the textarea
    // path for it. Other array-shape interfaces (tags/checkboxes/etc.) already
    // exited above through their own renderers.
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
            Stores a row id from <span className="font-mono">c_{target || "—"}</span>.
            {!target && " Set the target collection in the field settings."}
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
            Stores the storage key. Upload new files on the <span className="font-mono">Storage</span> page.
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
            Stores a list of storage keys. Upload new files on the <span className="font-mono">Storage</span> page.
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
        {err
          ? <div className="flex items-center gap-1 text-[11.5px] text-destructive"><I.AlertTriangle size={11} />{err}</div>
          : autoSlug && <div className="text-[11.5px] text-muted-foreground">Auto-derived from title until edited.</div>}
      </div>
    );
  };

  const slug = schema?.slug ?? "";
  const ownerScoped = !!schema?.ownerScoped;

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="flex max-h-[90vh] w-[94vw] flex-col gap-0 overflow-hidden border-border bg-card p-0 sm:max-w-[560px]">
        <DialogHeader className="flex flex-col gap-0.5 border-b border-border px-5 pb-3.5 pr-12 pt-[18px]">
          <DialogTitle className="text-base font-semibold tracking-[-0.01em]">
            {mode === "create" ? `New ${slug || "row"}` : `Edit ${slug || "row"}`}
          </DialogTitle>
          <DialogDescription className="text-[12.5px] text-muted-foreground">
            {mode === "create"
              ? <>Insert into <span className="font-mono">c_{slug}</span>{ownerScoped ? <>. Owner is set to <span className="font-mono">$user.id</span></> : null}.</>
              : <>id <span className="font-mono">{(initial as { id?: string })?.id}</span></>}
          </DialogDescription>
        </DialogHeader>

        {mode === "edit" && (
          <Tabs
            value={activeTab}
            onValueChange={(v) => setActiveTab(v as "fields" | "collab")}
            className="border-b border-border bg-card px-3.5"
          >
            <TabsList>
              <TabsTrigger value="fields">
                <I.Braces size={12} /> Fields
                <span className="font-mono text-[10.5px] text-muted-foreground">
                  {fields.length}
                </span>
              </TabsTrigger>
              <TabsTrigger value="collab">
                <I.MessageSquare size={12} /> Collaboration
              </TabsTrigger>
            </TabsList>
          </Tabs>
        )}

        <div className="flex flex-1 flex-col gap-8 overflow-auto px-5 py-[18px]" onKeyDown={onBodyKeyDown}>
          {activeTab === "fields" && (
            <>
              {fields.length === 0 && (
                <div className="rounded-xl bg-muted p-3 text-[13px] text-muted-foreground">
                  No editable fields. Add columns from the Schema tab to capture data on this collection.
                </div>
              )}
              {fields.map(renderField)}

              <div className="flex flex-col gap-1.5 rounded-xl bg-muted p-3">
                <div className="mb-1.5 flex items-center gap-2 text-[12.5px] font-medium text-foreground">system fields</div>
                <div className="flex flex-wrap gap-3.5 text-xs text-muted-foreground">
                  <div><span className="font-mono">id</span>: {mode === "create" ? <span className="font-mono">gen_uuid()</span> : <span className="font-mono">{(initial as { id?: string })?.id}</span>}</div>
                  {ownerScoped && <div><span className="font-mono">owner_id</span>: <span className="font-mono">$user.id</span></div>}
                  <div><span className="font-mono">updated_at</span>: <span className="font-mono">now()</span></div>
                </div>
              </div>
            </>
          )}
          {mode === "edit" && activeTab === "collab" && slug && (initial as { id?: string })?.id && (
            <ItemCommentsPanel
              collection={slug}
              itemId={(initial as { id: string }).id}
            />
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-border bg-card px-5 py-3">
          {/* "Cancel" reads as "throw away changes" — once the form is clean
              (no touched fields) we relabel to "Close" so the user knows
              dismissing the sheet won't lose anything. */}
          <Button variant="ghost" size="sm" onClick={onClose}>
            {Object.keys(touched).length === 0 ? "Close" : "Cancel"}
          </Button>
          {mode === "create" ? (
            // Create mode has only one save action — no split button needed.
            <Button
              variant="primary"
              size="sm"
              onClick={() => void submit({ close: true })}
              disabled={saving}
            >
              {saving ? "Saving…" : `Create ${slug || "row"}`}
            </Button>
          ) : (
            // Edit mode: split-button. Primary "Save" closes the sheet on
            // success; the chevron dropdown exposes "Save and continue" which
            // saves without closing. The two buttons share a seam — the
            // primary loses its right radius AND right border, the chevron
            // loses its left radius and its left border so the outer rounded
            // corners stay clean and the inner edge has no transparent-border
            // bleed (Button uses `border border-transparent bg-clip-padding`,
            // which would otherwise show the sheet background through that
            // 1px gap). Both halves are pinned to rounded-2xl because the
            // default rounded-4xl (≈36px) gets visibly clamped on an h-8
            // (32px) button — the curves look uneven across the split.
            <div className="inline-flex">
              <Button
                variant="primary"
                size="sm"
                onClick={() => void submit({ close: true })}
                disabled={saving}
                className={cn("rounded-2xl rounded-r-none border-r-0")}
              >
                {saving ? "Saving…" : "Save"}
              </Button>
              {/* `modal={false}` so the menu doesn't try to lock body scroll
                  / focus while the sheet itself already owns the modal stack,
                  and so its trigger pointer events aren't competing with any
                  outer dismiss handler. The real reason the menu looked
                  "broken" before was z-index: the sheet sits at z-index: 61
                  but DropdownMenuContent ships with `z-50`, so the portal
                  rendered *behind* the sheet panel. Bump it above the sheet. */}
              <DropdownMenu modal={false}>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={saving}
                    aria-label="More save options"
                    className={cn("rounded-2xl rounded-l-none border-l-0 px-2")}
                  >
                    <I.ChevronDown size={14} />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="z-[70]">
                  <DropdownMenuItem onSelect={() => void submit({ close: false })}>
                    Save and continue
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  title?: ReactNode;
  description?: ReactNode;
  actionLabel?: string;
  destructive?: boolean;
  onConfirm?: () => void;
  onCancel?: () => void;
}

export function ConfirmDialog({ open, title, description, actionLabel = "Confirm", destructive, onConfirm, onCancel }: ConfirmDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={(o) => { if (!o) onCancel?.(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description ? <AlertDialogDescription>{description}</AlertDialogDescription> : null}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            className={destructive ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" : undefined}
          >
            {actionLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
