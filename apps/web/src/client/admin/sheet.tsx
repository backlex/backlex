// @ts-nocheck
// Sheet form for create/edit, ConfirmAction dialog
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { I } from "./icons";
import { type CollectionSchema, type Post } from "./mock";
import { Badge, Button, IconButton, Switch } from "./ui";
import { Select } from "./select";

export interface ItemSheetProps {
  open: boolean;
  mode: "create" | "edit";
  initial: Post | null;
  schema: CollectionSchema;
  onClose: () => void;
  onSave: (draft: Partial<Post>) => void;
}

type SchemaField = {
  name: string;
  type?: string;
  required?: boolean;
  nullable?: boolean;
  unique?: boolean;
};

const SYSTEM_FIELDS = new Set(["id", "owner_id", "created_at", "updated_at", "tenant_id", "deleted_at"]);

const blankFor = (type: string | undefined): unknown => {
  switch (type) {
    case "boolean": return false;
    case "json": return "";
    case "integer":
    case "number": return "";
    case "timestamp": return null;
    default: return "";
  }
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
    for (const f of fields) d[f.name] = blankFor(f.type);
    return d;
  };

  const [draft, setDraft] = useState<Record<string, unknown>>(buildDefaults);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [touched, setTouched] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!open) return;
    const base = buildDefaults();
    if (initial) {
      for (const f of fields) {
        const v = (initial as Record<string, unknown>)[f.name];
        if (v === undefined) continue;
        base[f.name] = f.type === "json" && typeof v !== "string" ? JSON.stringify(v) : v;
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
      if (v === undefined || v === null || (typeof v === "string" && !v.trim())) {
        e[f.name] = `${f.name} is required`;
      }
    }
    // slug format check, only if a slug column exists
    const slugVal = draft.slug;
    if (typeof slugVal === "string" && slugVal && !/^[a-z0-9-]+$/.test(slugVal)) {
      e.slug = "lowercase letters, digits, and dashes only";
    }
    // json columns: validate parseable JSON
    for (const f of fields) {
      if (f.type !== "json") continue;
      const raw = draft[f.name];
      if (typeof raw !== "string" || !raw.trim()) continue;
      try { JSON.parse(raw); } catch { e[f.name] = "must be valid json"; }
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const submit = () => {
    if (!validate()) return;
    const payload: Record<string, unknown> = {};
    for (const f of fields) {
      const raw = draft[f.name];
      if (raw === undefined) continue;
      if (f.type === "json") {
        if (typeof raw === "string" && raw.trim()) {
          try { payload[f.name] = JSON.parse(raw); } catch { payload[f.name] = null; }
        } else if (typeof raw === "string") {
          // empty JSON string — leave the column null so PATCH doesn't clobber
          // an existing value with empty content.
          continue;
        } else {
          payload[f.name] = raw;
        }
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
    onSave(payload as Partial<Post>);
  };

  if (!open) return null;

  const renderField = (f: SchemaField) => {
    const val = draft[f.name];
    const err = errors[f.name];
    const typeLabel = (f.type ?? "text") + (f.unique ? " · unique" : "");
    const reqMark = f.required || f.nullable === false ? <span style={{ color: "var(--destructive)" }}>*</span> : null;
    const label = (
      <label className="field-label">
        {f.name} <Badge variant="outline" mono>{typeLabel}</Badge> {reqMark}
      </label>
    );

    if (f.type === "longtext") {
      return (
        <div key={f.name} className="field">
          {label}
          <textarea
            className={`textarea ${err ? "error" : ""}`}
            rows={6}
            value={String(val ?? "")}
            onChange={(e) => { updateField(f.name, e.target.value); setTouched((t) => ({ ...t, [f.name]: true })); }}
          />
          {err && <div className="field-error"><I.AlertTriangle size={11} />{err}</div>}
        </div>
      );
    }
    if (f.type === "json") {
      return (
        <div key={f.name} className="field">
          {label}
          <textarea
            className={`textarea ${err ? "error" : ""}`}
            rows={3}
            value={String(val ?? "")}
            placeholder="[] or {}"
            onChange={(e) => { updateField(f.name, e.target.value); setTouched((t) => ({ ...t, [f.name]: true })); }}
          />
          {err && <div className="field-error"><I.AlertTriangle size={11} />{err}</div>}
        </div>
      );
    }
    if (f.type === "boolean") {
      return (
        <div key={f.name} className="field">
          <div className="field-row">
            <div>{label}</div>
            <Switch checked={!!val} onChange={(on) => updateField(f.name, on)} />
          </div>
        </div>
      );
    }
    if (f.type === "integer" || f.type === "number") {
      return (
        <div key={f.name} className="field">
          {label}
          <input
            className={`input tabular-nums ${err ? "error" : ""}`}
            type="number"
            step={f.type === "integer" ? 1 : "any"}
            value={val === null || val === undefined ? "" : String(val)}
            onChange={(e) => { updateField(f.name, e.target.value); setTouched((t) => ({ ...t, [f.name]: true })); }}
          />
          {err && <div className="field-error"><I.AlertTriangle size={11} />{err}</div>}
        </div>
      );
    }
    if (f.type === "timestamp") {
      const iso = typeof val === "string" ? val : "";
      const localValue = iso ? iso.slice(0, 16) : "";
      return (
        <div key={f.name} className="field">
          {label}
          <input
            className={`input ${err ? "error" : ""}`}
            type="datetime-local"
            value={localValue}
            onChange={(e) => { updateField(f.name, e.target.value ? new Date(e.target.value).toISOString() : null); setTouched((t) => ({ ...t, [f.name]: true })); }}
          />
          {err && <div className="field-error"><I.AlertTriangle size={11} />{err}</div>}
        </div>
      );
    }
    // Directus-style: any field marked interface=dropdown renders a Select.
    // Choices come from f.options.choices (preferred) or legacy f.options.values.
    if (f.interface === "dropdown") {
      const rawChoices = (f.options?.choices?.length
        ? f.options.choices
        : (f.options?.values ?? []).map((v: string) => ({ value: v }))) as Array<{
        value: string;
        label?: string;
        color?: string;
        icon?: string;
      }>;
      const current = String(val ?? "");
      // Preserve a current value that's no longer in the choice list (e.g.
      // imported data) so the user can see and re-pick.
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
        <div key={f.name} className="field">
          {label}
          <Select
            value={current}
            onChange={(v) => { updateField(f.name, v); setTouched((t) => ({ ...t, [f.name]: true })); }}
            options={options}
            placeholder={f.name === "status" ? "Pick a status…" : "Pick…"}
          />
          {err && <div className="field-error"><I.AlertTriangle size={11} />{err}</div>}
        </div>
      );
    }

    // text / uuid (free text fallback)
    const autoSlug = f.name === "slug" && !touched.slug && fields.some((x) => x.name === "title");
    return (
      <div key={f.name} className="field">
        {label}
        <input
          className={`input ${f.name === "slug" ? "font-mono" : ""} ${err ? "error" : ""}`}
          value={String(val ?? "")}
          autoFocus={f.name === "title"}
          onChange={(e) => { updateField(f.name, e.target.value); setTouched((t) => ({ ...t, [f.name]: true })); }}
          autoComplete="off"
        />
        {err
          ? <div className="field-error"><I.AlertTriangle size={11} />{err}</div>
          : autoSlug && <div className="field-hint">Auto-derived from title until edited.</div>}
      </div>
    );
  };

  const slug = schema?.slug ?? "";
  const ownerScoped = !!schema?.ownerScoped;

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="sheet" role="dialog" aria-modal="true">
        <div className="sheet-header">
          <div style={{ flex: 1 }}>
            <h2>{mode === "create" ? `New ${slug || "row"}` : `Edit ${slug || "row"}`}</h2>
            <p>
              {mode === "create"
                ? <>Insert into <span className="font-mono">c_{slug}</span>{ownerScoped ? <>. Owner is set to <span className="font-mono">$user.id</span></> : null}.</>
                : <>id <span className="font-mono">{(initial as { id?: string })?.id}</span></>}
            </p>
          </div>
          <IconButton icon={I.X} onClick={onClose} title="Close" />
        </div>

        <div className="sheet-body">
          {fields.length === 0 && (
            <div className="muted" style={{ fontSize: 13, padding: 12, background: "var(--muted)", borderRadius: "var(--radius-xl)" }}>
              No editable fields. Add columns from the Schema tab to capture data on this collection.
            </div>
          )}
          {fields.map(renderField)}

          <div className="field" style={{ background: "var(--muted)", padding: 12, borderRadius: "var(--radius-xl)" }}>
            <div className="field-label" style={{ marginBottom: 6 }}>system fields</div>
            <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 12, color: "var(--muted-foreground)" }}>
              <div><span className="font-mono">id</span>: {mode === "create" ? <span className="font-mono">gen_uuid()</span> : <span className="font-mono">{(initial as { id?: string })?.id}</span>}</div>
              {ownerScoped && <div><span className="font-mono">owner_id</span>: <span className="font-mono">$user.id</span></div>}
              <div><span className="font-mono">updated_at</span>: <span className="font-mono">now()</span></div>
            </div>
          </div>
        </div>

        <div className="sheet-footer">
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="sm" onClick={submit}>
            {mode === "create" ? `Create ${slug || "row"}` : "Save"}
          </Button>
        </div>
      </div>
    </>
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
  if (!open) return null;
  return (
    <>
      <div className="scrim" onClick={onCancel} />
      <div className="dialog" role="alertdialog">
        <div>
          <h3>{title}</h3>
          <p style={{ marginTop: 8 }}>{description}</p>
        </div>
        <div className="actions">
          <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
          <Button variant={destructive ? "destructive" : "primary"} size="sm" onClick={onConfirm}>{actionLabel}</Button>
        </div>
      </div>
    </>
  );
}
