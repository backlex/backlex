// @ts-nocheck
// Collections index — grid of all collections + new-collection wizard
import { useEffect, useMemo, useState } from "react";
import { I, type IconComponent, type IconKey } from "./icons";
import type { CollectionListItem } from "./config";
import { Badge, Button, IconButton, PageHeader, Switch } from "./ui";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@workeros/ui/components/input-group";
import { AdoptWizard } from "./adopt-wizard";

export interface CollectionsIndexProps {
  collections: CollectionListItem[];
  onOpen: (slug: string) => void;
  onNew: () => void;
  onDelete?: (slug: string) => void;
  /** Archive-view toggle: parent re-fetches /api/collections with
   *  `?include_archived=true` and feeds the archived rows back through
   *  `collections`. Default is the active list. */
  showArchived?: boolean;
  onToggleArchived?: (next: boolean) => void;
  /** Restore an archived (adopted) collection. Only shown in archived view. */
  onRestore?: (slug: string) => void;
  /** Jump to the REST Explorer. With a slug, deep-links to that
   *  collection's `/api/items/<slug>` endpoint group. */
  onOpenApi?: (slug?: string) => void;
  pushToast: (msg: string) => void;
}

export function CollectionsIndex({ collections, onOpen, onNew, onDelete, showArchived, onToggleArchived, onRestore, onOpenApi, pushToast }: CollectionsIndexProps) {
  const [search, setSearch] = useState("");
  const [view, setView] = useState<"grid" | "table">("grid");
  const [adoptOpen, setAdoptOpen] = useState(false);
  // Single entry-point chooser: the create + adopt flows share one backend
  // path (`POST /api/collections` with optional `adopted: true`), and this
  // chooser is the UI counterpart — one button on the page, two distinct
  // wizards routed by the user's intent.
  const [chooserOpen, setChooserOpen] = useState(false);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return collections;
    return collections.filter((c) => c.slug.toLowerCase().includes(q) || (c.group || "").toLowerCase().includes(q));
  }, [collections, search]);

  const groups = useMemo(() => {
    const m = new Map<string, CollectionListItem[]>();
    for (const c of filtered) {
      const g = c.group || "Other";
      if (!m.has(g)) m.set(g, []);
      m.get(g)!.push(c);
    }
    return [...m.entries()];
  }, [filtered]);

  return (
    <div className="collections-index" style={{ display: "flex", flexDirection: "column", gap: 18, minWidth: 0 }}>
      <PageHeader
        title="Collections"
        description={<>Each collection is a physical <span className="font-mono">c_&lt;slug&gt;</span> table created at runtime. Drag fields, set permissions, or expose REST/GraphQL — all without writing migrations.</>}
        badges={<span style={{ display: "inline-flex", flexWrap: "wrap", gap: 6, marginLeft: 4 }}>
          <Badge variant={showArchived ? "secondary" : "outline"} mono>
            {collections.length} {showArchived ? "archived" : "collections"}
          </Badge>
          {!showArchived && (
            <Badge variant="outline" mono>{collections.reduce((a, c) => a + c.count, 0).toLocaleString()} rows</Badge>
          )}
        </span>}
        actions={<>
          {onToggleArchived && (
            <Button
              variant="outline"
              icon={showArchived ? I.Inbox : I.Archive}
              onClick={() => onToggleArchived(!showArchived)}
              title={showArchived ? "Show active collections" : "Show archived collections"}
            >
              {showArchived ? "View active" : "View archived"}
            </Button>
          )}
          {!showArchived && <>
            <Button variant="outline" icon={I.Code}>Schema</Button>
            <Button variant="outline" icon={I.ExternalLink} onClick={() => onOpenApi?.()}>API docs</Button>
            <Button variant="primary" icon={I.Plus} onClick={() => setChooserOpen(true)}>New collection</Button>
          </>}
        </>}
      />
      <AdoptWizard
        open={adoptOpen}
        onClose={() => setAdoptOpen(false)}
        onComplete={({ slug }) => {
          setAdoptOpen(false);
          pushToast?.(`Adopted "${slug}". Reloading…`);
          // Easiest reliable refresh — the index reads `collections` from the
          // parent, which fetches once on mount. A reload keeps that contract
          // intact without threading a new "refresh" callback through.
          setTimeout(() => window.location.reload(), 600);
        }}
      />
      <CreateChooserDialog
        open={chooserOpen}
        onClose={() => setChooserOpen(false)}
        onPickEmpty={() => { setChooserOpen(false); onNew(); }}
        onPickAdopt={() => { setChooserOpen(false); setAdoptOpen(true); }}
      />

      <div className="filter-bar">
        <InputGroup>
          <InputGroupAddon><I.Search size={14} /></InputGroupAddon>
          <InputGroupInput value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search collections by slug or group…" />
        </InputGroup>
        <div className="spacer" />
        <button className={`chip ${view === "grid" ? "active" : ""}`} onClick={() => setView("grid")}><I.Braces size={12} /> Grid</button>
        <button className={`chip ${view === "table" ? "active" : ""}`} onClick={() => setView("table")}><I.Inbox size={12} /> Table</button>
      </div>

      {view === "grid" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
          {groups.map(([g, list]) => (
            <div key={g} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                <span style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600, color: "var(--muted-foreground)" }}>{g}</span>
                <span className="muted tabular-nums" style={{ fontSize: 11 }}>{list.length}</span>
                <div style={{ flex: 1, height: 1, background: "var(--border)", marginLeft: 6 }} />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 280px), 1fr))", gap: 12 }}>
                {list.map((c) => (
                  <CollectionCard
                    key={c.slug}
                    c={c}
                    archived={!!showArchived}
                    onOpen={() => onOpen(c.slug)}
                    onOpenApi={onOpenApi ? () => onOpenApi(c.slug) : undefined}
                    onRestore={onRestore ? () => onRestore(c.slug) : undefined}
                  />
                ))}
                {!showArchived && (
                  <button onClick={onNew} className="card" style={{ minHeight: 138, border: "1.5px dashed var(--border)", background: "transparent", cursor: "pointer", display: "grid", placeItems: "center", gap: 6, color: "var(--muted-foreground)" }}>
                    <I.Plus size={18} />
                    <span style={{ fontSize: 12.5, fontWeight: 500 }}>New collection</span>
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="card">
          <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Slug</th>
                <th style={{ width: 110 }}>Group</th>
                <th style={{ width: 90, textAlign: "right" }}>Rows</th>
                <th style={{ width: 80, textAlign: "right" }}>Fields</th>
                <th style={{ width: 110, textAlign: "right" }}>Writes 24h</th>
                <th style={{ width: 110 }}>Last write</th>
                <th style={{ width: 130 }}>Permissions</th>
                <th style={{ width: 60 }}></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => {
                const Ic = (I as Record<string, IconComponent>)[c.icon as IconKey] || I.Database;
                return (
                  <tr key={c.slug} onClick={() => onOpen(c.slug)} style={{ cursor: "pointer" }}>
                    <td>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ width: 24, height: 24, borderRadius: "var(--radius-md)", background: "var(--muted)", display: "grid", placeItems: "center" }}><Ic size={12} /></span>
                        <span className="font-mono" style={{ fontSize: 13, fontWeight: 500 }}>c_{c.slug}</span>
                        {c.singleton && <Badge variant="outline">singleton</Badge>}
                      </div>
                    </td>
                    <td className="muted" style={{ fontSize: 12 }}>{c.group}</td>
                    <td className="tabular-nums" style={{ textAlign: "right" }}>{c.count.toLocaleString()}</td>
                    <td className="tabular-nums muted" style={{ textAlign: "right" }}>{c.fields}</td>
                    <td className="tabular-nums" style={{ textAlign: "right" }}>{c.writes24h}</td>
                    <td className="muted font-mono" style={{ fontSize: 11.5 }}>{c.lastWrite}</td>
                    <td>
                      {showArchived
                        ? <Badge variant="secondary">archived</Badge>
                        : c.ownerScoped ? <Badge variant="default">owner-scoped</Badge> : <Badge variant="secondary">public read</Badge>}
                    </td>
                    <td onClick={(e) => e.stopPropagation()} style={{ textAlign: "right" }}>
                      {showArchived
                        ? onRestore && (
                            <IconButton icon={I.RotateCcw} title="Restore collection" onClick={() => onRestore(c.slug)} />
                          )
                        : onDelete && (
                            <IconButton icon={I.Trash} title="Delete collection" onClick={() => onDelete(c.slug)} />
                          )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        </div>
      )}
    </div>
  );
}

function CollectionCard({ c, onOpen, archived, onRestore, onOpenApi }: { c: CollectionListItem; onOpen: () => void; archived?: boolean; onRestore?: () => void; onOpenApi?: () => void }) {
  const Ic = (I as Record<string, IconComponent>)[c.icon as IconKey] || I.Database;
  return (
    <div
      className="card"
      onClick={onOpen}
      style={{ padding: 16, cursor: "pointer", display: "flex", flexDirection: "column", gap: 12, transition: "border-color 100ms, transform 100ms", opacity: archived ? 0.92 : 1 }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.borderColor = "color-mix(in oklch, var(--primary) 50%, var(--border))"; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.borderColor = "var(--border)"; }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ width: 32, height: 32, borderRadius: "var(--radius-lg)", background: "var(--muted)", border: "1px solid var(--border)", display: "grid", placeItems: "center", color: "var(--muted-foreground)" }}><Ic size={15} /></span>
        <div style={{ display: "flex", flexDirection: "column", minWidth: 0, flex: 1 }}>
          <span className="font-mono" style={{ fontSize: 13.5, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>c_{c.slug}</span>
          <span className="muted" style={{ fontSize: 11.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.fields} fields · {c.singleton ? "singleton" : c.ownerScoped ? "owner-scoped" : "public read"}</span>
        </div>
        {archived && (
          <span style={{ marginLeft: "auto" }}>
            <Badge variant="secondary">
              <I.Archive size={10} />
              <span style={{ marginLeft: 4 }}>archived</span>
            </Badge>
          </span>
        )}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8 }}>
        <Stat k="rows" v={c.count.toLocaleString()} />
        <Stat k="writes 24h" v={c.writes24h} />
        <Stat k="last" v={c.lastWrite} mono />
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        {archived ? (
          <>
            {onRestore && (
              <Button
                size="sm"
                variant="primary"
                icon={I.RotateCcw}
                onClick={(e) => { e.stopPropagation(); onRestore(); }}
              >
                Restore
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); onOpen(); }}>Open</Button>
          </>
        ) : (
          <>
            <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); onOpen(); }}>Open</Button>
            <Button size="sm" variant="ghost" iconRight={I.ExternalLink} onClick={(e) => { e.stopPropagation(); onOpenApi?.(); }}>API</Button>
          </>
        )}
      </div>
    </div>
  );
}

function Stat({ k, v, mono }: { k: string; v: string | number; mono?: boolean }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
      <span className="muted" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{k}</span>
      <span className={`tabular-nums ${mono ? "font-mono" : ""}`} style={{ fontSize: mono ? 11.5 : 14, fontWeight: mono ? 400 : 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{v}</span>
    </div>
  );
}

export interface NewCollectionDialogProps {
  open: boolean;
  onClose: () => void;
  onCreate: (c: CollectionListItem & Record<string, unknown>) => void;
  existingSlugs: string[];
}

export function NewCollectionDialog({ open, onClose, onCreate, existingSlugs }: NewCollectionDialogProps) {
  const [step, setStep] = useState(0);
  const [slug, setSlug] = useState("");
  const [group, setGroup] = useState("Content");
  const [singleton, setSingleton] = useState(false);
  const [ownerScoped, setOwnerScoped] = useState(true);
  const [timestamps, setTimestamps] = useState(true);
  const [softDelete, setSoftDelete] = useState(false);
  const [tenantScoped, setTenantScoped] = useState(true);
  const [template, setTemplate] = useState("blank");
  const [withStatus, setWithStatus] = useState(false);

  useEffect(() => {
    if (open) {
      setStep(0);
      setSlug("");
      setGroup("Content");
      setSingleton(false);
      setOwnerScoped(true);
      setTimestamps(true);
      setSoftDelete(false);
      setTenantScoped(true);
      setTemplate("blank");
      setWithStatus(false);
    }
  }, [open]);

  // "Content" template implies a status field; flip the toggle ON when picked
  // so the user sees what they're getting (still editable in step 2).
  useEffect(() => {
    if (template === "content") setWithStatus(true);
  }, [template]);

  if (!open) return null;

  const slugClean = slug.trim().toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/^_+|_+$/g, "");
  const slugError = !slugClean ? null : existingSlugs.includes(slugClean) ? `c_${slugClean} already exists` : !/^[a-z][a-z0-9_]*$/.test(slugClean) ? "must start with a letter" : null;

  // Default status choices when the wizard injects a status field — Directus-
  // shaped (value/label/color). Keep these aligned with the badge palette in
  // admin/items.tsx so the table cell colors match the editor swatches.
  const DEFAULT_STATUS_CHOICES = [
    { value: "draft", label: "Draft", color: "#A1A6B8" },
    { value: "review", label: "In review", color: "#F5A524" },
    { value: "published", label: "Published", color: "#2ECDA7" },
    { value: "archived", label: "Archived", color: "#E35169" },
  ];
  const STATUS_FIELD_DEF = {
    name: "status",
    type: "text" as const,
    interface: "dropdown" as const,
    options: { choices: DEFAULT_STATUS_CHOICES },
  };

  // Each preset's `fields` are user-defined columns; system columns (id,
  // owner_id, timestamps) are added by the backend per the toggles below.
  // The `Blank` preset is empty on purpose — onCreate maps it to `[]`.
  const templates: Array<{
    id: string;
    name: string;
    desc: string;
    icon: string;
    fields: Array<{
      name: string;
      type: "text" | "longtext" | "boolean" | "timestamp" | "json";
      required?: boolean;
      unique?: boolean;
      interface?: "dropdown";
      options?: { choices?: typeof DEFAULT_STATUS_CHOICES };
    }>;
  }> = [
    { id: "blank", name: "Blank", desc: "Just system fields. Add your own columns.", icon: "Braces", fields: [] },
    {
      id: "content",
      name: "Content",
      desc: "title · slug · status · body · published_at",
      icon: "Inbox",
      fields: [
        { name: "title", type: "text", required: true },
        { name: "slug", type: "text", required: true, unique: true },
        // status is added by the wizard's "Add status field" toggle (auto-on
        // for this template) so the choices stay in one place.
        { name: "body", type: "longtext" },
        { name: "published_at", type: "timestamp" },
      ],
    },
    {
      id: "taxonomy",
      name: "Taxonomy",
      desc: "name · slug · description · parent_id",
      icon: "Hash",
      fields: [
        { name: "name", type: "text", required: true },
        { name: "slug", type: "text", required: true, unique: true },
        { name: "description", type: "longtext" },
        { name: "parent_id", type: "text" },
      ],
    },
    {
      id: "people",
      name: "People",
      desc: "name · email · avatar · bio · links",
      icon: "Users",
      fields: [
        { name: "name", type: "text", required: true },
        { name: "email", type: "text", unique: true },
        { name: "avatar", type: "text" },
        { name: "bio", type: "longtext" },
        { name: "links", type: "json" },
      ],
    },
  ];

  const sql = `CREATE TABLE c_${slugClean || "<slug>"} (
  id          uuid PRIMARY KEY DEFAULT gen_uuid(),${tenantScoped ? `\n  tenant_id   uuid NOT NULL REFERENCES tenants(id),` : ""}${ownerScoped ? `\n  owner_id    uuid NOT NULL,` : ""}${timestamps ? `\n  created_at  timestamptz NOT NULL DEFAULT now(),\n  updated_at  timestamptz NOT NULL DEFAULT now(),` : ""}${softDelete ? `\n  deleted_at  timestamptz,` : ""}
  -- + template columns
);${tenantScoped ? `\n\n-- RLS auto-injected:\n-- ALTER TABLE c_${slugClean || "<slug>"} ENABLE ROW LEVEL SECURITY;\n-- CREATE POLICY tenant_isolation ON c_${slugClean || "<slug>"}\n--   USING (tenant_id = current_setting('app.tenant_id')::uuid);` : ""}`;

  const submit = () => {
    if (!slugClean || slugError) return;
    const tpl = templates.find((t) => t.id === template)!;
    // Inject status with default choices when the toggle is on, unless the
    // template already provides one (defensive — current presets don't).
    const finalFields = withStatus && !tpl.fields.some((f) => f.name === "status")
      ? [...tpl.fields, STATUS_FIELD_DEF]
      : tpl.fields;
    onCreate({
      slug: slugClean,
      group,
      singleton,
      ownerScoped,
      timestamps,
      softDelete,
      tenantScoped,
      template,
      templateFields: finalFields,
      count: 0,
      // Card stat: number of user-defined fields. Real total (incl. system
      // columns) is computed by the backend and surfaced once we re-load.
      fields: finalFields.length,
      writes24h: 0,
      lastWrite: "just now",
      icon: tpl.icon,
    });
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog-lg" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 640, width: "100%", display: "flex", flexDirection: "column", maxHeight: "90vh" }}>
        <div className="card-section" style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <I.Database size={14} />
          <span style={{ fontSize: 14, fontWeight: 500 }}>New collection</span>
          <span className="muted font-mono" style={{ fontSize: 11.5 }}>step {step + 1} of 2</span>
          <div className="spacer" />
          <IconButton icon={I.X} onClick={onClose} />
        </div>

        <div style={{ padding: 22, overflow: "auto", display: "flex", flexDirection: "column", gap: 16 }}>
          {step === 0 && (
            <>
              <div className="field">
                <label className="field-label">Slug</label>
                <div className={`input-affix ${slugError ? "error" : ""}`}>
                  <span className="input-affix-prefix font-mono">c_</span>
                  <input value={slug} onChange={(e) => setSlug(e.target.value)} autoFocus placeholder="products" className="font-mono" />
                </div>
                {slugError && <span className="field-hint" style={{ color: "var(--destructive)" }}>{slugError}</span>}
                {!slugError && !slugClean && <span className="field-hint">Enter a slug to continue.</span>}
                {!slugError && slugClean && <span className="field-hint">Table name: <span className="font-mono">c_{slugClean}</span></span>}
              </div>

              <div className="field">
                <label className="field-label">Group</label>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {["Content", "Marketing", "System", "Other"].map((g) => (
                    <button key={g} type="button" className={`chip ${group === g ? "active" : ""}`} onClick={() => setGroup(g)}>{g}</button>
                  ))}
                </div>
              </div>

              <div className="field">
                <label className="field-label">Start from</label>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 8 }}>
                  {templates.map((t) => {
                    const Ic = (I as Record<string, IconComponent>)[t.icon as IconKey] || I.Braces;
                    const active = template === t.id;
                    return (
                      <button key={t.id} type="button" onClick={() => setTemplate(t.id)} className="card" style={{ padding: 12, textAlign: "left", cursor: "pointer", borderColor: active ? "var(--primary)" : "var(--border)", background: active ? "color-mix(in oklch, var(--primary) 8%, var(--card))" : "var(--card)" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                          <Ic size={13} />
                          <span style={{ fontSize: 13, fontWeight: 500 }}>{t.name}</span>
                          <div className="spacer" />
                          <span className="muted tabular-nums" style={{ fontSize: 11 }}>{t.fields.length} fields</span>
                        </div>
                        <span className="muted" style={{ fontSize: 11.5, lineHeight: 1.4 }}>{t.desc}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </>
          )}

          {step === 1 && (
            <>
              <div className="field-row" style={{ borderBottom: "1px solid var(--border)", paddingBottom: 12 }}>
                <div>
                  <div className="field-label">Tenant-scoped <Badge variant="secondary">recommended</Badge></div>
                  <div className="field-hint">Auto-add <span className="font-mono">tenant_id</span>; row-level security isolates data per workspace. All read/write rules get <span className="font-mono">tenant_id = $user.tenant_id</span> injected.</div>
                </div>
                <Switch checked={tenantScoped} onChange={setTenantScoped} />
              </div>
              <div className="field-row" style={{ borderBottom: "1px solid var(--border)", paddingBottom: 12 }}>
                <div>
                  <div className="field-label">Owner-scoped</div>
                  <div className="field-hint">Auto-add <span className="font-mono">owner_id</span>; the <span className="font-mono">authenticated</span> role can only read/update its own rows.</div>
                </div>
                <Switch checked={ownerScoped} onChange={setOwnerScoped} />
              </div>
              <div className="field-row" style={{ borderBottom: "1px solid var(--border)", paddingBottom: 12 }}>
                <div>
                  <div className="field-label">Timestamps</div>
                  <div className="field-hint">Add <span className="font-mono">created_at</span> and <span className="font-mono">updated_at</span>.</div>
                </div>
                <Switch checked={timestamps} onChange={setTimestamps} />
              </div>
              <div className="field-row" style={{ borderBottom: "1px solid var(--border)", paddingBottom: 12 }}>
                <div>
                  <div className="field-label">Soft delete</div>
                  <div className="field-hint">Add <span className="font-mono">deleted_at</span>; deletes mark rows instead of removing them.</div>
                </div>
                <Switch checked={softDelete} onChange={setSoftDelete} />
              </div>
              <div className="field-row" style={{ borderBottom: "1px solid var(--border)", paddingBottom: 12 }}>
                <div>
                  <div className="field-label">Status field</div>
                  <div className="field-hint">
                    Add a <span className="font-mono">status</span> dropdown with{" "}
                    <span className="font-mono">draft / review / published / archived</span>{" "}
                    + per-option color. List view auto-shows status tabs and badges.
                  </div>
                </div>
                <Switch checked={withStatus} onChange={setWithStatus} />
              </div>
              <div className="field-row" style={{ paddingBottom: 4 }}>
                <div>
                  <div className="field-label">Singleton</div>
                  <div className="field-hint">Locked to one row — useful for site settings.</div>
                </div>
                <Switch checked={singleton} onChange={setSingleton} />
              </div>

              <div className="alter-preview" style={{ fontSize: 11.5, marginTop: 4 }}>
                <pre style={{ margin: 0, fontFamily: "inherit", whiteSpace: "pre-wrap" }}>{sql}</pre>
              </div>
            </>
          )}
        </div>

        <div className="card-section" style={{ borderTop: "1px solid var(--border)", borderBottom: 0, display: "flex", alignItems: "center", gap: 8 }}>
          {step === 1 && <Button variant="ghost" size="sm" icon={I.ChevronLeft} onClick={() => setStep(0)}>Back</Button>}
          <div className="spacer" />
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          {step === 0 ? (
            <Button variant="primary" size="sm" iconRight={I.ChevronRight} onClick={() => {
              if (!slugClean || slugError) return;
              setStep(1);
            }} title={!slugClean ? "Enter a slug first" : slugError || ""}>Next</Button>
          ) : (
            <Button variant="primary" size="sm" icon={I.Plus} onClick={submit}>Create collection</Button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Mode chooser shown before either the managed-create wizard or the adopt
 * wizard opens. The two flows share one backend path (`POST /api/collections`,
 * with `adopted: true` for the adopt branch); this chooser is the visible
 * counterpart of that unification on the admin side. Two cards, one
 * decision — keeps the surface area small without forcing two very
 * different UX flows into a single screen.
 */
interface CreateChooserDialogProps {
  open: boolean;
  onClose: () => void;
  onPickEmpty: () => void;
  onPickAdopt: () => void;
}

function CreateChooserDialog({ open, onClose, onPickEmpty, onPickAdopt }: CreateChooserDialogProps) {
  if (!open) return null;
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog-lg" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 560, width: "100%", display: "flex", flexDirection: "column" }}>
        <div className="card-section" style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <I.Plus size={14} />
          <span style={{ fontSize: 14, fontWeight: 500 }}>New collection</span>
          <div className="spacer" />
          <IconButton icon={I.X} onClick={onClose} />
        </div>
        <div style={{ padding: 22, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <button
            type="button"
            onClick={onPickEmpty}
            className="card"
            style={{ padding: 18, textAlign: "left", cursor: "pointer", display: "flex", flexDirection: "column", gap: 10, background: "var(--card)" }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.borderColor = "color-mix(in oklch, var(--primary) 50%, var(--border))"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--border)"; }}
          >
            <span style={{ width: 36, height: 36, borderRadius: "var(--radius-lg)", background: "var(--muted)", border: "1px solid var(--border)", display: "grid", placeItems: "center" }}><I.Braces size={16} /></span>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 13.5, fontWeight: 600 }}>Empty or template</span>
              <span className="muted" style={{ fontSize: 12, lineHeight: 1.45 }}>
                Create a new physical table from scratch. Pick a preset (Content / Taxonomy / People / Blank) and configure scope toggles.
              </span>
            </div>
          </button>
          <button
            type="button"
            onClick={onPickAdopt}
            className="card"
            style={{ padding: 18, textAlign: "left", cursor: "pointer", display: "flex", flexDirection: "column", gap: 10, background: "var(--card)" }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.borderColor = "color-mix(in oklch, var(--primary) 50%, var(--border))"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--border)"; }}
          >
            <span style={{ width: 36, height: 36, borderRadius: "var(--radius-lg)", background: "var(--muted)", border: "1px solid var(--border)", display: "grid", placeItems: "center" }}><I.Database size={16} /></span>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 13.5, fontWeight: 600 }}>From existing table</span>
              <span className="muted" style={{ fontSize: 12, lineHeight: 1.45 }}>
                Register a table that already exists in your database. No DDL is run on the table — workeros only writes its own metadata.
              </span>
            </div>
          </button>
        </div>
        <div className="card-section" style={{ borderTop: "1px solid var(--border)", borderBottom: 0, display: "flex", alignItems: "center", gap: 8 }}>
          <div className="spacer" />
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
        </div>
      </div>
    </div>
  );
}
