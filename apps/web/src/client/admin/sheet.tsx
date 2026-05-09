// @ts-nocheck
// Sheet form for create/edit, ConfirmAction dialog
import { useEffect, useState, type ReactNode } from "react";
import { I } from "./icons";
import { MOCK, type CollectionSchema, type Post } from "./mock";
import { Badge, Button, IconButton, Switch } from "./ui";
import { Select } from "./select";
import { STATUS_VALUES } from "./items";

export interface ItemSheetProps {
  open: boolean;
  mode: "create" | "edit";
  initial: Post | null;
  schema: CollectionSchema;
  onClose: () => void;
  onSave: (draft: Partial<Post>) => void;
}

export function ItemSheet({ open, mode, initial, onClose, onSave }: ItemSheetProps) {
  const blank = { title: "", slug: "", status: "draft", body: "", author: "u_1", word_count: 0, view_count: 0, tags: "[]", published_at: null as string | null };
  const [draft, setDraft] = useState<Record<string, unknown>>(blank);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [touched, setTouched] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (open) {
      const init = initial
        ? { ...blank, ...initial, tags: typeof initial.tags === "string" ? initial.tags : JSON.stringify(initial.tags || []) }
        : blank;
      setDraft(init);
      setErrors({});
      setTouched({});
    }
  }, [open, initial]);

  const updateTitle = (title: string) => {
    const slugFromTitle = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
    setDraft((d) => ({ ...d, title, slug: !touched.slug ? slugFromTitle : d.slug }));
  };

  const validate = () => {
    const e: Record<string, string> = {};
    if (!String(draft.title || "").trim()) e.title = "title is required";
    if (!String(draft.slug || "").trim()) e.slug = "slug is required";
    else if (!/^[a-z0-9-]+$/.test(String(draft.slug))) e.slug = "lowercase letters, digits, and dashes only";
    if (!draft.status) e.status = "status is required";
    if (draft.tags) {
      try { JSON.parse(String(draft.tags)); } catch { e.tags = "must be valid json"; }
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const submit = () => {
    if (!validate()) return;
    onSave({
      ...(draft as Partial<Post>),
      word_count: Number(draft.word_count) || 0,
      tags: JSON.parse(String(draft.tags || "[]")),
    });
  };

  if (!open) return null;
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="sheet" role="dialog" aria-modal="true">
        <div className="sheet-header">
          <div style={{ flex: 1 }}>
            <h2>{mode === "create" ? "New post" : "Edit post"}</h2>
            <p>
              {mode === "create"
                ? <>Insert into <span className="font-mono">c_posts</span>. Owner is set to <span className="font-mono">$user.id</span>.</>
                : <>id <span className="font-mono">{initial?.id}</span></>}
            </p>
          </div>
          <IconButton icon={I.X} onClick={onClose} title="Close" />
        </div>

        <div className="sheet-body">
          <div className="field">
            <label className="field-label">title <Badge variant="outline" mono>text</Badge> <span style={{ color: "var(--destructive)" }}>*</span></label>
            <input
              className={`input ${errors.title ? "error" : ""}`}
              value={String(draft.title || "")}
              autoFocus
              onChange={(e) => { updateTitle(e.target.value); setTouched((t) => ({ ...t, title: true })); }}
              autoComplete="off"
              placeholder="Edge functions are now generally available"
            />
            {errors.title && <div className="field-error"><I.AlertTriangle size={11} />{errors.title}</div>}
          </div>

          <div className="field">
            <label className="field-label">slug <Badge variant="outline" mono>text · unique</Badge> <span style={{ color: "var(--destructive)" }}>*</span></label>
            <input
              className={`input font-mono ${errors.slug ? "error" : ""}`}
              value={String(draft.slug || "")}
              onChange={(e) => { setDraft({ ...draft, slug: e.target.value }); setTouched((t) => ({ ...t, slug: true })); }}
              autoComplete="off"
            />
            {errors.slug ? <div className="field-error"><I.AlertTriangle size={11} />{errors.slug}</div> : <div className="field-hint">Auto-derived from title until edited.</div>}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <div className="field">
              <label className="field-label">status <Badge variant="outline" mono>text</Badge></label>
              <Select value={String(draft.status)} onChange={(v) => setDraft({ ...draft, status: v })} options={STATUS_VALUES.map((s) => ({ value: s, label: s }))} />
            </div>
            <div className="field">
              <label className="field-label">author <Badge variant="outline" mono>uuid</Badge></label>
              <Select value={String(draft.author)} onChange={(v) => setDraft({ ...draft, author: v })} options={MOCK.POST_AUTHORS.map((a) => ({ value: a.id, label: a.name, hint: a.id.slice(0, 6) + "…" }))} />
            </div>
          </div>

          <div className="field">
            <label className="field-label">body <Badge variant="outline" mono>longtext</Badge></label>
            <textarea
              className="textarea"
              rows={6}
              value={String(draft.body || "")}
              onChange={(e) => setDraft({ ...draft, body: e.target.value, word_count: e.target.value.trim().split(/\s+/).filter(Boolean).length })}
              placeholder="Write the body. Markdown is fine — we render it on the consumer side."
            />
            <div className="field-hint tabular-nums">{(draft.word_count as number) || 0} words</div>
          </div>

          <div className="field">
            <label className="field-label">tags <Badge variant="outline" mono>json</Badge></label>
            <textarea
              className={`textarea ${errors.tags ? "error" : ""}`}
              rows={2}
              value={String(draft.tags || "")}
              onChange={(e) => setDraft({ ...draft, tags: e.target.value })}
            />
            {errors.tags && <div className="field-error"><I.AlertTriangle size={11} />{errors.tags}</div>}
          </div>

          <div className="field">
            <div className="field-row">
              <div>
                <div className="field-label">published_at <Badge variant="outline" mono>timestamp</Badge></div>
                <div className="field-hint">Set automatically when status flips to <span className="font-mono">published</span>.</div>
              </div>
              <Switch
                checked={!!draft.published_at}
                onChange={(on) => setDraft({ ...draft, published_at: on ? new Date().toISOString() : null, status: on ? "published" : draft.status })}
              />
            </div>
          </div>

          <div className="field" style={{ background: "var(--muted)", padding: 12, borderRadius: "var(--radius-xl)" }}>
            <div className="field-label" style={{ marginBottom: 6 }}>system fields</div>
            <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 12, color: "var(--muted-foreground)" }}>
              <div><span className="font-mono">id</span>: {mode === "create" ? <span className="font-mono">gen_uuid()</span> : <span className="font-mono">{initial?.id}</span>}</div>
              <div><span className="font-mono">owner_id</span>: <span className="font-mono">$user.id</span></div>
              <div><span className="font-mono">updated_at</span>: <span className="font-mono">now()</span></div>
            </div>
          </div>
        </div>

        <div className="sheet-footer">
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="sm" onClick={submit}>
            {mode === "create" ? "Create post" : "Save"}
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
