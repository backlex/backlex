// @ts-nocheck
// Per-collection settings tab — edit metadata (singular/plural/note/display
// template), toggle owner-scope, and a destructive zone to drop the whole
// collection. Mounted as the 4th tab next to Items / Schema / Permissions.
import { useEffect, useState } from "react";
import { Input } from "@workeros/ui/components/input";
import { Textarea } from "@workeros/ui/components/textarea";
import { I } from "./icons";
import { Select } from "./select";
import { Button, Switch } from "./ui";

interface FieldLike {
  name: string;
  type?: string;
}

interface SchemaLike {
  slug: string;
  singular?: string | null;
  plural?: string | null;
  note?: string | null;
  displayTemplate?: string | null;
  ownerScoped?: boolean;
  tenantScoped?: boolean;
  versioned?: boolean;
  /** True when the collection was adopted from a pre-existing physical table.
   *  Adopted collections soft-delete (archive) rather than hard-drop; managed
   *  collections hard-DROP the underlying `c_<slug>` table on delete. */
  adopted?: boolean;
  fields?: FieldLike[];
  /** Comma-separated default sort, Directus shape (`-field,name`). */
  defaultSort?: string | null;
}

type SortClause = { field: string; dir: "asc" | "desc" };

const parseDefaultSort = (raw?: string | null): SortClause[] => {
  if (!raw) return [];
  return raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => ({
      field: p.replace(/^[-+]/, ""),
      dir: (p.startsWith("-") ? "desc" : "asc") as "asc" | "desc",
    }));
};

const serializeSort = (clauses: SortClause[]): string | null => {
  if (clauses.length === 0) return null;
  return clauses
    .map((c) => (c.dir === "desc" ? "-" : "") + c.field)
    .join(",");
};

export interface CollectionSettingsProps {
  schema: SchemaLike;
  // Existing slugs in the workspace, used to validate the rename target
  // before the PATCH round-trip lights up a 409.
  existingSlugs: string[];
  onPatch: (patch: Partial<SchemaLike>) => void | Promise<void>;
  onRename: (nextSlug: string) => void | Promise<void>;
  onDelete: () => void;
}

export function CollectionSettings({ schema, existingSlugs, onPatch, onRename, onDelete }: CollectionSettingsProps) {
  const [slug, setSlug] = useState(schema.slug);
  const [singular, setSingular] = useState(schema.singular ?? "");
  const [plural, setPlural] = useState(schema.plural ?? "");
  const [note, setNote] = useState(schema.note ?? "");
  const [displayTemplate, setDisplayTemplate] = useState(schema.displayTemplate ?? "");
  const [sortClauses, setSortClauses] = useState<SortClause[]>(
    parseDefaultSort(schema.defaultSort),
  );

  // Reseed when the user navigates between collections (or hits Refresh).
  useEffect(() => {
    setSlug(schema.slug);
    setSingular(schema.singular ?? "");
    setPlural(schema.plural ?? "");
    setNote(schema.note ?? "");
    setDisplayTemplate(schema.displayTemplate ?? "");
    setSortClauses(parseDefaultSort(schema.defaultSort));
  }, [schema.slug]);

  // Field options for the sort dropdown: id + user fields + (created_at,
  // updated_at as system columns) + owner_id when the collection is
  // owner-scoped. Same allow-list parseQuery validates against server-side.
  const sortFieldOptions = (() => {
    const opts: { value: string; label: string; hint?: string }[] = [
      { value: "id", label: "id", hint: "pk" },
      { value: "created_at", label: "created_at", hint: "system" },
      { value: "updated_at", label: "updated_at", hint: "system" },
    ];
    if (schema.ownerScoped) {
      opts.push({ value: "owner_id", label: "owner_id", hint: "system" });
    }
    for (const f of schema.fields ?? []) {
      opts.push({ value: f.name, label: f.name, hint: f.type });
    }
    return opts;
  })();

  const sortDirty =
    serializeSort(sortClauses) !== (schema.defaultSort ?? null);

  const slugClean = slug.trim().toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/^_+|_+$/g, "");
  const slugError =
    slugClean === schema.slug
      ? null
      : !slugClean
        ? "slug is required"
        : !/^[a-z][a-z0-9_]*$/.test(slugClean)
          ? "must start with a letter; snake_case only"
          : existingSlugs.some((s) => s !== schema.slug && s === slugClean)
            ? `${slugClean} already exists`
            : null;
  const slugDirty = slugClean !== schema.slug;

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
        <div className="cols-2" style={{ padding: 16 }}>
          <div className="field" style={{ gridColumn: "1 / -1" }}>
            <label className="field-label">Slug</label>
            <div className={`input-affix ${slugError ? "error" : ""}`}>
              <input
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                placeholder={schema.slug}
                className="font-mono"
              />
              {slugDirty && !slugError && (
                <Button
                  size="xs"
                  variant="primary"
                  onClick={() => onRename(slugClean)}
                >
                  Rename
                </Button>
              )}
            </div>
            <span className="field-hint" style={slugError ? { color: "var(--destructive)" } : undefined}>
              {slugError ??
                (slugDirty
                  ? <>Will rename <span className="font-mono">{schema.slug}</span> → <span className="font-mono">{slugClean}</span> and update permission rules, webhooks, function patterns, flow steps, revisions, comments, and audit log.</>
                  : <>URL identifier and physical table prefix. Renaming cascades through all references.</>)}
            </span>
          </div>
          <div className="field">
            <label className="field-label">Singular</label>
            <Input value={singular} onChange={(e) => setSingular(e.target.value)} placeholder="post" />
            <span className="field-hint">"New post" buttons, etc. Falls back to the slug.</span>
          </div>
          <div className="field">
            <label className="field-label">Plural</label>
            <Input value={plural} onChange={(e) => setPlural(e.target.value)} placeholder="posts" />
            <span className="field-hint">Page titles, badges. Falls back to the slug.</span>
          </div>
          <div className="field" style={{ gridColumn: "1 / -1" }}>
            <label className="field-label">Display template</label>
            <Input className="font-mono" value={displayTemplate} onChange={(e) => setDisplayTemplate(e.target.value)} placeholder="{{ title }} — {{ status }}" />
            <span className="field-hint">Mustache-style template for row display in pickers and references.</span>
          </div>
          <div className="field" style={{ gridColumn: "1 / -1" }}>
            <label className="field-label">Note</label>
            <Textarea
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

      <div className="card">
        <div className="card-section" style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <I.ArrowUpDown size={14} />
          <span style={{ fontSize: 13, fontWeight: 500 }}>list &amp; sort</span>
          <span className="font-mono muted" style={{ fontSize: 12 }}>
            default order when <span style={{ fontFamily: "inherit" }}>?sort=</span> is omitted
          </span>
        </div>
        <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
          {sortClauses.length === 0 ? (
            <div className="field-hint">
              No default sort configured — list responses fall back to
              <span className="font-mono"> -created_at</span> (newest first).
              Add one or more fields below to pin a different order.
            </div>
          ) : (
            sortClauses.map((clause, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{ flex: 1 }}>
                  <Select
                    value={clause.field}
                    onChange={(v) =>
                      setSortClauses((cs) =>
                        cs.map((c, idx) => (idx === i ? { ...c, field: v } : c)),
                      )
                    }
                    options={sortFieldOptions}
                    placeholder="Pick a field…"
                    size="sm"
                  />
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  title={clause.dir === "desc" ? "Descending" : "Ascending"}
                  onClick={() =>
                    setSortClauses((cs) =>
                      cs.map((c, idx) =>
                        idx === i
                          ? { ...c, dir: c.dir === "desc" ? "asc" : "desc" }
                          : c,
                      ),
                    )
                  }
                  style={{ minWidth: 64 }}
                >
                  {clause.dir === "desc" ? (
                    <>
                      <I.ArrowDown size={12} /> desc
                    </>
                  ) : (
                    <>
                      <I.ArrowUp size={12} /> asc
                    </>
                  )}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  title="Move up"
                  disabled={i === 0}
                  onClick={() =>
                    setSortClauses((cs) => {
                      const next = [...cs];
                      [next[i - 1], next[i]] = [next[i], next[i - 1]];
                      return next;
                    })
                  }
                >
                  <I.ChevronUp size={12} />
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  title="Move down"
                  disabled={i === sortClauses.length - 1}
                  onClick={() =>
                    setSortClauses((cs) => {
                      const next = [...cs];
                      [next[i], next[i + 1]] = [next[i + 1], next[i]];
                      return next;
                    })
                  }
                >
                  <I.ChevronDown size={12} />
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  title="Remove"
                  onClick={() =>
                    setSortClauses((cs) => cs.filter((_, idx) => idx !== i))
                  }
                >
                  <I.X size={12} />
                </Button>
              </div>
            ))
          )}
          <div>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                const used = new Set(sortClauses.map((c) => c.field));
                const next = sortFieldOptions.find((o) => !used.has(o.value));
                setSortClauses((cs) => [
                  ...cs,
                  { field: next?.value ?? "created_at", dir: "desc" },
                ]);
              }}
            >
              <I.Plus size={12} /> Add sort
            </Button>
          </div>
        </div>
        <div style={{ padding: "10px 16px", borderTop: "1px solid var(--border)", display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button
            variant="primary"
            size="sm"
            disabled={!sortDirty}
            onClick={() => onPatch({ defaultSort: serializeSort(sortClauses) })}
          >
            Save sort
          </Button>
        </div>
      </div>

      {schema.adopted ? (
        // Adopted collections soft-delete (archive). The physical table stays
        // intact, metadata is retained, and the row can be restored from the
        // Archived view in the collections index.
        <div className="card" style={{ borderColor: "color-mix(in oklch, var(--chart-2, var(--primary)) 35%, var(--border))" }}>
          <div className="card-section" style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <I.Archive size={14} />
            <span style={{ fontSize: 13, fontWeight: 500, color: "color-mix(in oklch, var(--chart-2, var(--primary)) 80%, var(--foreground))" }}>archive zone</span>
          </div>
          <div style={{ padding: 16, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16 }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 500 }}>Archive this collection</div>
              <div className="field-hint">
                Workeros stops treating <span className="font-mono">{schema.slug}</span> as a collection.
                The underlying table and its rows stay intact; you can restore from the Archived view.
              </div>
            </div>
            <Button variant="outline" size="sm" icon={I.Archive} onClick={onDelete}>
              Archive collection
            </Button>
          </div>
        </div>
      ) : (
        <div className="card" style={{ borderColor: "color-mix(in oklch, var(--destructive) 35%, var(--border))" }}>
          <div className="card-section" style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <I.Trash size={14} />
            <span style={{ fontSize: 13, fontWeight: 500, color: "var(--destructive)" }}>danger zone</span>
          </div>
          <div style={{ padding: 16, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16 }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 500 }}>Delete this collection</div>
              <div className="field-hint">
                Drops the physical table and all rows.
                Permissions and revisions tied to the slug are removed too. This is irreversible.
              </div>
            </div>
            <Button variant="primary" size="sm" onClick={onDelete} style={{ background: "var(--destructive)", borderColor: "var(--destructive)" }}>
              Delete collection
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
