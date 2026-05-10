// @ts-nocheck
// Per-collection settings tab — edit metadata (singular/plural/note/display
// template), toggle owner-scope, and a destructive zone to drop the whole
// collection. Mounted as the 4th tab next to Items / Schema / Permissions.
import { useEffect, useState } from "react";
import { I } from "./icons";
import { Button, Switch } from "./ui";

interface SchemaLike {
  slug: string;
  singular?: string | null;
  plural?: string | null;
  note?: string | null;
  displayTemplate?: string | null;
  ownerScoped?: boolean;
  tenantScoped?: boolean;
  versioned?: boolean;
}

export interface CollectionSettingsProps {
  schema: SchemaLike;
  onPatch: (patch: Partial<SchemaLike>) => void | Promise<void>;
  onDelete: () => void;
}

export function CollectionSettings({ schema, onPatch, onDelete }: CollectionSettingsProps) {
  const [singular, setSingular] = useState(schema.singular ?? "");
  const [plural, setPlural] = useState(schema.plural ?? "");
  const [note, setNote] = useState(schema.note ?? "");
  const [displayTemplate, setDisplayTemplate] = useState(schema.displayTemplate ?? "");

  // Reseed when the user navigates between collections (or hits Refresh).
  useEffect(() => {
    setSingular(schema.singular ?? "");
    setPlural(schema.plural ?? "");
    setNote(schema.note ?? "");
    setDisplayTemplate(schema.displayTemplate ?? "");
  }, [schema.slug]);

  const dirty =
    (schema.singular ?? "") !== singular ||
    (schema.plural ?? "") !== plural ||
    (schema.note ?? "") !== note ||
    (schema.displayTemplate ?? "") !== displayTemplate;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div className="card">
        <div className="card-section" style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <I.Settings size={14} />
          <span style={{ fontSize: 13, fontWeight: 500 }}>display</span>
          <span className="font-mono muted" style={{ fontSize: 12 }}>
            how this collection shows up in nav and lists
          </span>
        </div>
        <div style={{ padding: 16, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div className="field">
            <label className="field-label">Singular</label>
            <input className="input" value={singular} onChange={(e) => setSingular(e.target.value)} placeholder="post" />
            <span className="field-hint">"New post" buttons, etc. Falls back to the slug.</span>
          </div>
          <div className="field">
            <label className="field-label">Plural</label>
            <input className="input" value={plural} onChange={(e) => setPlural(e.target.value)} placeholder="posts" />
            <span className="field-hint">Page titles, badges. Falls back to the slug.</span>
          </div>
          <div className="field" style={{ gridColumn: "1 / -1" }}>
            <label className="field-label">Display template</label>
            <input className="input font-mono" value={displayTemplate} onChange={(e) => setDisplayTemplate(e.target.value)} placeholder="{{ title }} — {{ status }}" />
            <span className="field-hint">Mustache-style template for row display in pickers and references.</span>
          </div>
          <div className="field" style={{ gridColumn: "1 / -1" }}>
            <label className="field-label">Note</label>
            <textarea
              className="textarea"
              rows={3}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Internal description for teammates."
            />
          </div>
        </div>
        <div style={{ padding: "10px 16px", borderTop: "1px solid var(--border)", display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button
            variant="primary"
            size="sm"
            disabled={!dirty}
            onClick={() => onPatch({
              singular: singular || null,
              plural: plural || null,
              displayTemplate: displayTemplate || null,
              note: note || null,
            })}
          >
            Save changes
          </Button>
        </div>
      </div>

      <div className="card">
        <div className="card-section" style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <I.Shield size={14} />
          <span style={{ fontSize: 13, fontWeight: 500 }}>scoping &amp; lifecycle</span>
        </div>
        <div style={{ padding: "10px 16px" }}>
          <div className="field-row" style={{ borderBottom: "1px solid var(--border)", paddingBottom: 10, marginBottom: 10 }}>
            <div>
              <div className="field-label">Owner-scoped</div>
              <div className="field-hint">
                Each row gets an <span className="font-mono">owner_id</span>; the
                <span className="font-mono"> authenticated</span> role can only read/update its own rows.
                Toggling on auto-seeds owner-scoped permissions; toggling off does not remove existing rows
                or rules.
              </div>
            </div>
            <Switch checked={!!schema.ownerScoped} onChange={(v) => onPatch({ ownerScoped: v })} />
          </div>
          <div className="field-row" style={{ borderBottom: "1px solid var(--border)", paddingBottom: 10, marginBottom: 10 }}>
            <div>
              <div className="field-label">Tenant-scoped</div>
              <div className="field-hint">
                Rows carry a <span className="font-mono">tenant_id</span>. Disabling on an existing collection is unsupported.
              </div>
            </div>
            <Switch checked={schema.tenantScoped !== false} onChange={(v) => onPatch({ tenantScoped: v })} />
          </div>
          <div className="field-row" style={{ paddingBottom: 4 }}>
            <div>
              <div className="field-label">Versioned (draft / published)</div>
              <div className="field-hint">
                Adds <span className="font-mono">_status</span> + <span className="font-mono">_published_at</span>.
                Independent of the user-defined "status" field.
              </div>
            </div>
            <Switch checked={!!schema.versioned} onChange={(v) => onPatch({ versioned: v })} />
          </div>
        </div>
      </div>

      <div className="card" style={{ borderColor: "color-mix(in oklch, var(--destructive) 35%, var(--border))" }}>
        <div className="card-section" style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <I.Trash size={14} />
          <span style={{ fontSize: 13, fontWeight: 500, color: "var(--destructive)" }}>danger zone</span>
        </div>
        <div style={{ padding: 16, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16 }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 500 }}>Delete this collection</div>
            <div className="field-hint">
              Drops the physical <span className="font-mono">c_{schema.slug}</span> table and all rows.
              Permissions and revisions tied to the slug are removed too. This is irreversible.
            </div>
          </div>
          <Button variant="primary" size="sm" onClick={onDelete} style={{ background: "var(--destructive)", borderColor: "var(--destructive)" }}>
            Delete collection
          </Button>
        </div>
      </div>
    </div>
  );
}
