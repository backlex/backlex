// @ts-nocheck
// Per-collection settings tab — edit metadata (singular/plural/note/display
// template), toggle owner-scope, and a destructive zone to drop the whole
// collection. Mounted as the 4th tab next to Items / Schema / Permissions.
import { useEffect, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { Card } from "@backlex/ui/components/card";
import { Input } from "@backlex/ui/components/input";
import { Textarea } from "@backlex/ui/components/textarea";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@backlex/ui/components/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@backlex/ui/components/command";
import { vectorApi, type VectorCapabilities } from "./api";
import { I, type IconKey } from "./icons";
import { Select } from "./select";
import { Button, Switch } from "./ui";
import { DisplayTemplateEditor } from "./display-template-editor";
import { COLLECTION_COLORS, resolveCollectionColor } from "./collection-colors";
import { ColorSwatchPicker } from "@/components/color-swatch-picker";

interface FieldLike {
  name: string;
  type?: string;
  /** Editor interface — `"dropdown"` marks a finite-choice select field,
   *  the only shape that can drive the Kanban group-by axis. */
  interface?: string;
  /** Finite choice set for a `dropdown` field — `choices[]` (value+label) or a
   *  bare `values[]`. Powers the per-value action mapper. */
  options?: { choices?: { value: string; label?: string }[]; values?: string[] };
  /** Target collection slug — present on `relation` fields. */
  to?: string;
  /** Contributes to the FTS index when the collection has `fts: true`. */
  searchable?: boolean;
  /** Contributes to the embedded text when the collection has `vectorize: true`. */
  vectorize?: boolean;
}

interface SchemaLike {
  slug: string;
  singular?: string | null;
  plural?: string | null;
  note?: string | null;
  displayTemplate?: string | null;
  /** Admin icon key. Null = the default Database icon. */
  icon?: string | null;
  /** Admin accent color — preset token name or `#rrggbb`. */
  color?: string | null;
  /** Hidden from the sidebar + Collections index (presentational only). */
  hidden?: boolean;
  /** Preview-URL template with `{{field}}` placeholders (absolute http(s)). */
  previewUrl?: string | null;
  /** Lifecycle: `active` | `inactive` (admin-visible, item API blocked). */
  status?: string;
  ownerScoped?: boolean;
  tenantScoped?: boolean;
  versioned?: boolean;
  /** Staged edits (versioned only). When on, editing a *published* item stages
   *  the change (applied by the next publish) instead of changing the live row. */
  stagedEdits?: boolean;
  /** Opt-in sensitive-read auditing. When on, every read of this collection
   *  (list + by-id) records an `access.read` row in the audit log. */
  auditReads?: boolean;
  /** Maintain a keyword full-text-search index from the fields flagged
   *  `searchable`. Powers `?q=` keyword filtering + the `/search` endpoint. */
  fts?: boolean;
  /** Embed the fields flagged `vectorize` on write — powers the `/search`
   *  endpoint's vector + hybrid modes. */
  vectorize?: boolean;
  /** Embedding model key. Null → the deployment's EMBEDDING_DEFAULT_MODEL. */
  vectorizeModel?: string | null;
  /** True when the collection was adopted from a pre-existing physical table.
   *  Adopted collections soft-delete (archive) rather than hard-drop; managed
   *  collections hard-DROP the underlying `c_<slug>` table on delete. */
  adopted?: boolean;
  fields?: FieldLike[];
  /** Comma-separated default sort, `-field,name` shape. */
  defaultSort?: string | null;
  /** Field name the admin Kanban view groups cards by — a dropdown field's
   *  name or `_status` on versioned collections. Null = auto-detect. */
  kanbanGroupBy?: string | null;
  /** Maps group-by dropdown values → lifecycle actions (e.g. `{done:"publish"}`)
   *  so moving a card into that column also fires the transition. */
  kanbanActionMap?: Record<string, "publish" | "unpublish" | "archive"> | null;
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
  // All workspace collections (slug + fields) — powers the display-template
  // editor's relation drill-down (`{{ author.name }}`).
  collections: { slug: string; fields?: FieldLike[] }[];
  onPatch: (patch: Partial<SchemaLike>) => void | Promise<void>;
  onRename: (nextSlug: string) => void | Promise<void>;
  onDelete: () => void;
  /** Rebuild the full-text index for existing rows (manual recovery — the
   *  server auto-backfills when FTS settings change). */
  onFtsReindex?: () => void | Promise<void>;
  /** Embed every existing row into the vector store. Manual by design —
   *  each row costs an embedding-provider call. */
  onVectorizeBackfill?: () => void | Promise<void>;
}

export function CollectionSettings({ schema, existingSlugs, collections, onPatch, onRename, onDelete, onFtsReindex, onVectorizeBackfill }: CollectionSettingsProps) {
  const { t } = useLingui();
  const [slug, setSlug] = useState(schema.slug);
  const [singular, setSingular] = useState(schema.singular ?? "");
  const [plural, setPlural] = useState(schema.plural ?? "");
  const [note, setNote] = useState(schema.note ?? "");
  const [displayTemplate, setDisplayTemplate] = useState(schema.displayTemplate ?? "");
  const [previewUrl, setPreviewUrl] = useState(schema.previewUrl ?? "");
  // Icon picker popover.
  const [iconOpen, setIconOpen] = useState(false);
  const [sortClauses, setSortClauses] = useState<SortClause[]>(
    parseDefaultSort(schema.defaultSort),
  );
  // Kanban group-by axis. `"__auto"` sentinel ↔ null (auto-detect: a field
  // named `status`, else the first dropdown).
  const [kanbanGroupBy, setKanbanGroupBy] = useState<string>(
    schema.kanbanGroupBy ?? "__auto",
  );
  // Per-value lifecycle triggers (custom-status → publish/unpublish/archive).
  const [actionMap, setActionMap] = useState<Record<string, string>>(
    (schema.kanbanActionMap as Record<string, string>) ?? {},
  );
  const [reindexing, setReindexing] = useState(false);
  const [embedding, setEmbedding] = useState(false);
  // Deployment-level vector readiness — fetched once so the model picker can
  // disable models whose provider/store isn't configured instead of letting
  // the first embed call fail.
  const [vectorCaps, setVectorCaps] = useState<VectorCapabilities | null>(null);
  useEffect(() => {
    let cancelled = false;
    vectorApi
      .capabilities()
      .then((r) => {
        if (!cancelled) setVectorCaps(r.data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Reseed when the user navigates between collections (or hits Refresh).
  useEffect(() => {
    setSlug(schema.slug);
    setSingular(schema.singular ?? "");
    setPlural(schema.plural ?? "");
    setNote(schema.note ?? "");
    setDisplayTemplate(schema.displayTemplate ?? "");
    setPreviewUrl(schema.previewUrl ?? "");
    setSortClauses(parseDefaultSort(schema.defaultSort));
    setKanbanGroupBy(schema.kanbanGroupBy ?? "__auto");
    setActionMap((schema.kanbanActionMap as Record<string, string>) ?? {});
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

  // Kanban group-by candidates: the auto sentinel, the `_status` lifecycle
  // column (only when the collection is versioned), and every dropdown field.
  // The card is hidden unless at least one real axis exists (matches the
  // toolbar, which hides the Kanban view mode when there's nothing to group by).
  const kanbanFieldOptions = (() => {
    const opts: { value: string; label: string; hint?: string }[] = [
      { value: "__auto", label: t`Auto`, hint: t`first dropdown` },
    ];
    if (schema.versioned) {
      opts.push({ value: "_status", label: "_status", hint: t`lifecycle` });
    }
    for (const f of schema.fields ?? []) {
      if (f.interface === "dropdown") {
        opts.push({ value: f.name, label: f.name, hint: "dropdown" });
      }
    }
    return opts;
  })();
  const hasKanbanAxis = kanbanFieldOptions.length > 1;

  // Per-value lifecycle triggers apply only when the board groups by a real
  // dropdown field (not Auto / not `_status`) on a versioned collection. The
  // choices come from that field's own option set.
  const triggerField =
    schema.versioned && kanbanGroupBy !== "__auto" && kanbanGroupBy !== "_status"
      ? (schema.fields ?? []).find((f) => f.name === kanbanGroupBy && f.interface === "dropdown")
      : undefined;
  const triggerChoices: string[] = triggerField
    ? triggerField.options?.choices?.length
      ? triggerField.options.choices.map((c) => c.value)
      : (triggerField.options?.values ?? [])
    : [];
  const cleanActionMap = (m: Record<string, string>) =>
    Object.fromEntries(Object.entries(m).filter(([, v]) => v));
  const actionOptions = [
    { value: "", label: t`No action` },
    { value: "publish", label: t`Publish` },
    { value: "unpublish", label: t`Unpublish` },
    { value: "archive", label: t`Archive` },
  ];
  const savedActionMap = (schema.kanbanActionMap as Record<string, string>) ?? {};
  const actionMapDirty =
    JSON.stringify(cleanActionMap(actionMap)) !== JSON.stringify(cleanActionMap(savedActionMap));
  const kanbanDirty =
    (schema.kanbanGroupBy ?? "__auto") !== kanbanGroupBy || actionMapDirty;

  const slugClean = slug.trim().toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/^_+|_+$/g, "");
  const slugError =
    slugClean === schema.slug
      ? null
      : !slugClean
        ? t`slug is required`
        : !/^[a-z][a-z0-9_]*$/.test(slugClean)
          ? t`must start with a letter; snake_case only`
          : existingSlugs.some((s) => s !== schema.slug && s === slugClean)
            ? t`${slugClean} already exists`
            : null;
  const slugDirty = slugClean !== schema.slug;

  const previewUrlError =
    previewUrl.trim() && !/^https?:\/\//.test(previewUrl.trim())
      ? t`Must be an absolute URL (https://…)`
      : null;

  const dirty =
    (schema.singular ?? "") !== singular ||
    (schema.plural ?? "") !== plural ||
    (schema.note ?? "") !== note ||
    (schema.displayTemplate ?? "") !== displayTemplate ||
    (schema.previewUrl ?? "") !== previewUrl.trim();

  const accent = resolveCollectionColor(schema.color);
  const CurrentIcon =
    (I as Record<string, (p: { size?: number }) => JSX.Element>)[
      schema.icon as IconKey
    ] ?? I.Database;
  const iconKeys = Object.keys(I).sort() as IconKey[];

  return (
    <div className="flex flex-col gap-3.5">
      <Card className="py-0 gap-0">
        <div className="flex items-center gap-2.5 border-b border-border px-4 py-3.5">
          <I.Settings size={14} />
          <span className="text-[13px] font-medium"><Trans>display</Trans></span>
          <span className="font-mono text-xs text-muted-foreground">
            <Trans>how this collection shows up in nav and lists</Trans>
          </span>
        </div>
        <div className="grid grid-cols-2 gap-3 p-4 max-[640px]:grid-cols-1">
          <div className="col-span-full flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Slug</Trans></label>
            <div className={`flex h-9 items-stretch overflow-hidden rounded-control border bg-background ${slugError ? "border-destructive focus-within:shadow-[0_0_0_3px_color-mix(in_oklch,var(--destructive)_22%,transparent)]" : "border-border focus-within:border-ring focus-within:shadow-[0_0_0_3px_color-mix(in_oklch,var(--ring)_22%,transparent)]"}`}>
              <input
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                placeholder={schema.slug}
                className="min-w-0 flex-1 border-0 bg-transparent px-3 font-mono text-[13px] outline-0"
              />
              {slugDirty && !slugError && (
                <Button
                  size="xs"
                  variant="primary"
                  onClick={() => onRename(slugClean)}
                >
                  <Trans>Rename</Trans>
                </Button>
              )}
            </div>
            <span className={`text-[11.5px] ${slugError ? "text-destructive" : "text-muted-foreground"}`}>
              {slugError ??
                (slugDirty
                  ? <Trans>Will rename <span className="font-mono">{schema.slug}</span> → <span className="font-mono">{slugClean}</span> and update permission rules, webhooks, function patterns, flow steps, revisions, comments, and audit log.</Trans>
                  : <Trans>URL identifier and physical table prefix. Renaming cascades through all references.</Trans>)}
            </span>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Singular</Trans></label>
            <Input value={singular} onChange={(e) => setSingular(e.target.value)} placeholder="post" />
            <span className="text-[11.5px] text-muted-foreground"><Trans>"New post" buttons, etc. Falls back to the slug.</Trans></span>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Plural</Trans></label>
            <Input value={plural} onChange={(e) => setPlural(e.target.value)} placeholder="posts" />
            <span className="text-[11.5px] text-muted-foreground"><Trans>Page titles, badges. Falls back to the slug.</Trans></span>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Icon</Trans></label>
            <Popover open={iconOpen} onOpenChange={setIconOpen}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className="flex h-9 min-w-0 items-center gap-2 rounded-control border border-border bg-background px-2.5 text-[13px] hover:bg-accent/40"
                >
                  <span
                    className="flex size-6 shrink-0 items-center justify-center rounded-md"
                    style={{ background: `color-mix(in srgb, ${accent} 14%, transparent)`, color: accent }}
                  >
                    <CurrentIcon size={14} />
                  </span>
                  <span className="truncate font-mono text-xs">{schema.icon ?? "Database"}</span>
                  <I.ChevronDown size={12} className="ml-auto shrink-0 text-muted-foreground" />
                </button>
              </PopoverTrigger>
              <PopoverContent className="w-[240px] p-0" align="start">
                <Command>
                  <CommandInput placeholder={t`Search icons…`} />
                  <CommandList className="max-h-56">
                    <CommandEmpty><Trans>No icon found.</Trans></CommandEmpty>
                    <CommandGroup>
                      {iconKeys.map((key) => {
                        const Ic = I[key];
                        return (
                          <CommandItem
                            key={key}
                            value={key}
                            onSelect={() => {
                              onPatch({ icon: key === "Database" ? null : key });
                              setIconOpen(false);
                            }}
                          >
                            <Ic size={14} />
                            <span className="font-mono text-xs">{key}</span>
                            {(schema.icon ?? "Database") === key && (
                              <I.Check size={12} className="ml-auto" />
                            )}
                          </CommandItem>
                        );
                      })}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
            <span className="text-[11.5px] text-muted-foreground"><Trans>Shown in the sidebar and on the Collections page.</Trans></span>
          </div>
          <div className="flex min-w-0 flex-col gap-1.5">
            <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Color</Trans></label>
            <ColorSwatchPicker
              options={COLLECTION_COLORS.map((c) => ({ value: c.token, swatch: c.hex, label: c.token }))}
              value={schema.color ?? "violet"}
              onChange={(v) =>
                onPatch({ color: v === "violet" ? null : v.startsWith("#") ? v.toLowerCase() : v })
              }
            />
            <span className="text-[11.5px] text-muted-foreground"><Trans>Accent for the icon in nav and lists.</Trans></span>
          </div>
          <div className="col-span-full flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Display template</Trans></label>
            <DisplayTemplateEditor
              value={displayTemplate}
              onChange={setDisplayTemplate}
              fields={schema.fields ?? []}
              collections={collections}
            />
          </div>
          <div className="col-span-full flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Preview URL</Trans></label>
            <DisplayTemplateEditor
              value={previewUrl}
              onChange={setPreviewUrl}
              fields={schema.fields ?? []}
              collections={collections}
              placeholder="https://example.com/blog/{{slug}}?preview=1"
              hint={<Trans>Adds an "Open preview" button on items. Use field placeholders for the row's values.</Trans>}
            />
            {previewUrlError && (
              <span className="text-[11.5px] text-destructive">{previewUrlError}</span>
            )}
          </div>
          <div className="col-span-full flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Description</Trans></label>
            <Textarea
              rows={3}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t`What this collection holds — shown on the Collections page.`}
            />
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-4 py-2.5">
          <Button
            variant="primary"
            size="sm"
            disabled={!dirty || !!previewUrlError}
            onClick={() => onPatch({
              singular: singular || null,
              plural: plural || null,
              displayTemplate: displayTemplate || null,
              previewUrl: previewUrl.trim() || null,
              note: note || null,
            })}
          >
            <Trans>Save changes</Trans>
          </Button>
        </div>
      </Card>

      <Card className="py-0 gap-0">
        <div className="flex items-center gap-2.5 border-b border-border px-4 py-3.5">
          <I.Shield size={14} />
          <span className="text-[13px] font-medium"><Trans>scoping &amp; lifecycle</Trans></span>
        </div>
        <div className="px-4 py-2.5">
          <div className="mb-2.5 flex items-center justify-between gap-3 border-b border-border pb-2.5">
            <div>
              <div className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Enabled</Trans></div>
              <div className="text-[11.5px] text-muted-foreground">
                <Trans>Turning this off makes the content API return 404 for this collection
                (REST, GraphQL, SDK, realtime) while it stays editable here. Data is untouched.</Trans>
              </div>
            </div>
            <Switch
              checked={(schema.status ?? "active") !== "inactive"}
              onChange={(v) => onPatch({ status: v ? "active" : "inactive" })}
            />
          </div>
          <div className="mb-2.5 flex items-center justify-between gap-3 border-b border-border pb-2.5">
            <div>
              <div className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Hidden</Trans></div>
              <div className="text-[11.5px] text-muted-foreground">
                <Trans>Hide from the sidebar and the Collections page ("Show hidden" reveals it).
                Purely visual — API access and permissions are unaffected.</Trans>
              </div>
            </div>
            <Switch checked={!!schema.hidden} onChange={(v) => onPatch({ hidden: v })} />
          </div>
          <div className="mb-2.5 flex items-center justify-between gap-3 border-b border-border pb-2.5">
            <div>
              <div className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Owner-scoped</Trans></div>
              <div className="text-[11.5px] text-muted-foreground">
                <Trans>Each row gets an <span className="font-mono">owner_id</span>; the
                <span className="font-mono"> authenticated</span> role can only read/update its own rows.
                Toggling on auto-seeds owner-scoped permissions; toggling off does not remove existing rows
                or rules.</Trans>
              </div>
            </div>
            <Switch checked={!!schema.ownerScoped} onChange={(v) => onPatch({ ownerScoped: v })} />
          </div>
          <div className="mb-2.5 flex items-center justify-between gap-3 border-b border-border pb-2.5">
            <div>
              <div className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Tenant-scoped</Trans></div>
              <div className="text-[11.5px] text-muted-foreground">
                <Trans>Rows carry a <span className="font-mono">tenant_id</span>. Disabling on an existing collection is unsupported.</Trans>
              </div>
            </div>
            <Switch checked={schema.tenantScoped !== false} onChange={(v) => onPatch({ tenantScoped: v })} />
          </div>
          <div className="mb-2.5 flex items-center justify-between gap-3 border-b border-border pb-2.5">
            <div>
              <div className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Versioned (draft / published)</Trans></div>
              <div className="text-[11.5px] text-muted-foreground">
                <Trans>Adds <span className="font-mono">_status</span> + <span className="font-mono">_published_at</span>.
                Independent of the user-defined "status" field.</Trans>
              </div>
            </div>
            <Switch checked={!!schema.versioned} onChange={(v) => onPatch({ versioned: v })} />
          </div>
          {!!schema.versioned && (
            <div className="mb-2.5 flex items-center justify-between gap-3 border-b border-border pb-2.5">
              <div>
                <div className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Staged edits</Trans></div>
                <div className="text-[11.5px] text-muted-foreground">
                  <Trans>Editing a <span className="font-mono">published</span> item stages the change
                  instead of updating what's live — readers keep the current version until you
                  publish again, which applies the staged changes. Drafts still edit directly.</Trans>
                </div>
              </div>
              <Switch checked={!!schema.stagedEdits} onChange={(v) => onPatch({ stagedEdits: v })} />
            </div>
          )}
          <div className="flex items-center justify-between gap-3 pb-1">
            <div>
              <div className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Audit reads</Trans></div>
              <div className="text-[11.5px] text-muted-foreground">
                <Trans>Record every read of this collection (list + by-id) to the audit log
                under the <span className="font-mono">Access</span> lens — a "who viewed this"
                trail for sensitive data. Off by default; reads are otherwise not logged.
                Only request metadata is stored (who, when, query, item ids) — never row values.</Trans>
              </div>
            </div>
            <Switch checked={!!schema.auditReads} onChange={(v) => onPatch({ auditReads: v })} />
          </div>
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Full-text search</Trans></div>
              <div className="text-[11.5px] text-muted-foreground">
                <Trans>Maintain a keyword search index from the fields marked
                <span className="font-mono"> searchable</span>. Upgrades
                <span className="font-mono"> ?q=</span> to ranked keyword matching and enables the
                <span className="font-mono"> /search</span> endpoint (full-text / vector / hybrid).
                Existing rows are indexed automatically when you enable this or change which fields are searchable.</Trans>
              </div>
              {!!schema.fts &&
                !(schema.fields ?? []).some(
                  (f) => f.searchable && (f.type === "text" || f.type === "longtext"),
                ) && (
                  <div className="mt-1 text-[11.5px] text-amber-500">
                    <Trans>No text field is marked <span className="font-mono">searchable</span> yet,
                    so search stays empty — flip it on a text field in the Schema tab.</Trans>
                  </div>
                )}
              {!!schema.fts &&
                !schema.adopted &&
                !!onFtsReindex &&
                (schema.fields ?? []).some(
                  (f) => f.searchable && (f.type === "text" || f.type === "longtext"),
                ) && (
                  <div className="mt-2">
                    <Button
                      variant="outline"
                      size="sm"
                      icon={I.Refresh}
                      disabled={reindexing}
                      onClick={async () => {
                        setReindexing(true);
                        try {
                          await onFtsReindex();
                        } finally {
                          setReindexing(false);
                        }
                      }}
                    >
                      {reindexing ? <Trans>Re-indexing…</Trans> : <Trans>Re-index now</Trans>}
                    </Button>
                  </div>
                )}
            </div>
            <Switch checked={!!schema.fts} onChange={(v) => onPatch({ fts: v })} />
          </div>
          <div className="flex items-center justify-between gap-3 pb-1">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Vector search (semantic)</Trans></div>
              <div className="text-[11.5px] text-muted-foreground">
                <Trans>Embed the fields marked <span className="font-mono">vectorize</span> on
                every write and rank the <span className="font-mono">/search</span> endpoint's
                vector / hybrid modes by meaning. Existing rows are NOT embedded automatically —
                run "Embed all rows" below (each row is one embedding-provider call).</Trans>
              </div>
              {!!schema.vectorize && vectorCaps?.store === "none" && (
                <div className="mt-1 text-[11.5px] text-amber-500">
                  <Trans>This deployment has no vector store — connect a Vectorize binding
                  (Cloudflare), pgvector (Postgres), or libSQL before vector search can run.</Trans>
                </div>
              )}
              {!!schema.vectorize &&
                !(schema.fields ?? []).some(
                  (f) => f.vectorize && (f.type === "text" || f.type === "longtext"),
                ) && (
                  <div className="mt-1 text-[11.5px] text-amber-500">
                    <Trans>No text field is marked <span className="font-mono">vectorize</span> yet,
                    so nothing gets embedded — flip it on a text field in the Schema tab.</Trans>
                  </div>
                )}
              {!!schema.vectorize && vectorCaps && vectorCaps.store !== "none" && (() => {
                const effective = schema.vectorizeModel ?? vectorCaps.defaultModel;
                const chosen = vectorCaps.models.find((m) => m.key === effective);
                if (!effective) {
                  return (
                    <div className="mt-1 text-[11.5px] text-amber-500">
                      <Trans>No embedding model selected and the deployment sets no
                      <span className="font-mono"> EMBEDDING_DEFAULT_MODEL</span> — pick one below.</Trans>
                    </div>
                  );
                }
                if (chosen && !chosen.ready) {
                  return (
                    <div className="mt-1 text-[11.5px] text-amber-500">
                      <Trans>The <span className="font-mono">{chosen.provider}</span> provider behind
                      <span className="font-mono"> {chosen.key}</span> isn't configured on this
                      deployment — embeds will fail until it is (or pick a ready model).</Trans>
                    </div>
                  );
                }
                return null;
              })()}
              {!!schema.vectorize && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <div className="w-[300px] max-w-full min-w-0">
                    <Select
                      value={schema.vectorizeModel ?? "__default"}
                      onChange={(v) =>
                        onPatch({ vectorizeModel: v === "__default" ? null : v })
                      }
                      options={[
                        {
                          value: "__default",
                          label: t`Deployment default`,
                          hint: vectorCaps?.defaultModel ?? t`not set`,
                        },
                        ...(vectorCaps?.models ?? []).map((m) => ({
                          value: m.key,
                          label: m.key,
                          hint: m.ready ? `${m.dimensions}d` : t`not configured`,
                        })),
                      ]}
                    />
                  </div>
                  {!!onVectorizeBackfill && (
                    <Button
                      variant="outline"
                      size="sm"
                      icon={I.Refresh}
                      disabled={embedding}
                      onClick={async () => {
                        setEmbedding(true);
                        try {
                          await onVectorizeBackfill();
                        } finally {
                          setEmbedding(false);
                        }
                      }}
                    >
                      {embedding ? <Trans>Embedding…</Trans> : <Trans>Embed all rows</Trans>}
                    </Button>
                  )}
                </div>
              )}
            </div>
            <Switch checked={!!schema.vectorize} onChange={(v) => onPatch({ vectorize: v })} />
          </div>
        </div>
      </Card>

      <Card className="py-0 gap-0">
        <div className="flex items-center gap-2.5 border-b border-border px-4 py-3.5">
          <I.ArrowUpDown size={14} />
          <span className="text-[13px] font-medium"><Trans>list &amp; sort</Trans></span>
          <span className="font-mono text-xs text-muted-foreground">
            <Trans>default order when <span className="font-sans">?sort=</span> is omitted</Trans>
          </span>
        </div>
        <div className="flex flex-col gap-2.5 p-4">
          {sortClauses.length === 0 ? (
            <div className="text-[11.5px] text-muted-foreground">
              <Trans>No default sort configured — list responses fall back to
              <span className="font-mono"> -created_at</span> (newest first).
              Add one or more fields below to pin a different order.</Trans>
            </div>
          ) : (
            sortClauses.map((clause, i) => (
              <div key={i} className="flex items-center gap-2">
                <div className="flex-1">
                  <Select
                    value={clause.field}
                    onChange={(v) =>
                      setSortClauses((cs) =>
                        cs.map((c, idx) => (idx === i ? { ...c, field: v } : c)),
                      )
                    }
                    options={sortFieldOptions}
                    placeholder={t`Pick a field…`}
                    size="sm"
                  />
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  title={clause.dir === "desc" ? t`Descending` : t`Ascending`}
                  onClick={() =>
                    setSortClauses((cs) =>
                      cs.map((c, idx) =>
                        idx === i
                          ? { ...c, dir: c.dir === "desc" ? "asc" : "desc" }
                          : c,
                      ),
                    )
                  }
                  className="min-w-16"
                >
                  {clause.dir === "desc" ? (
                    <>
                      <I.ArrowDown size={12} /> <Trans>desc</Trans>
                    </>
                  ) : (
                    <>
                      <I.ArrowUp size={12} /> <Trans>asc</Trans>
                    </>
                  )}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  title={t`Move up`}
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
                  title={t`Move down`}
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
                  title={t`Remove`}
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
              <I.Plus size={12} /> <Trans>Add sort</Trans>
            </Button>
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-4 py-2.5">
          <Button
            variant="primary"
            size="sm"
            disabled={!sortDirty}
            onClick={() => onPatch({ defaultSort: serializeSort(sortClauses) })}
          >
            <Trans>Save sort</Trans>
          </Button>
        </div>
      </Card>

      {hasKanbanAxis ? (
        <Card className="py-0 gap-0">
          <div className="flex items-center gap-2.5 border-b border-border px-4 py-3.5">
            <I.LayoutKanban size={14} />
            <span className="text-[13px] font-medium"><Trans>kanban</Trans></span>
            <span className="font-mono text-xs text-muted-foreground">
              <Trans>which field the board groups cards by</Trans>
            </span>
          </div>
          <div className="flex flex-col gap-2.5 p-4">
            <div className="text-[11.5px] text-muted-foreground">
              <Trans>Pick the field whose values become the Kanban columns.
              <span className="font-mono"> Auto</span> uses a field named
              <span className="font-mono"> status</span>, else the first dropdown.</Trans>
              {schema.versioned ? (
                <>
                  {" "}
                  <Trans>Choosing <span className="font-mono">_status</span> tracks
                  the draft/published lifecycle.</Trans>
                </>
              ) : null}
            </div>
            <div className="max-w-xs">
              <Select
                value={kanbanGroupBy}
                onChange={setKanbanGroupBy}
                options={kanbanFieldOptions}
                size="sm"
              />
            </div>
            {triggerChoices.length > 0 && (
              <div className="flex flex-col gap-2 border-t border-border pt-2.5">
                <span className="text-[11.5px] text-muted-foreground">
                  <Trans>Fire a lifecycle action when a card enters a column —
                  e.g. a <span className="font-mono">done</span> column that also
                  publishes.</Trans>
                </span>
                {triggerChoices.map((value) => (
                  <div key={value} className="flex items-center gap-2">
                    <span className="w-1/3 shrink-0 truncate font-mono text-[12px]" title={value}>
                      {value}
                    </span>
                    <div className="flex-1">
                      <Select
                        value={actionMap[value] ?? ""}
                        onChange={(v) =>
                          setActionMap((m) => ({ ...m, [value]: v }))
                        }
                        options={actionOptions}
                        size="sm"
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="flex justify-end gap-2 border-t border-border px-4 py-2.5">
            <Button
              variant="primary"
              size="sm"
              disabled={!kanbanDirty}
              onClick={() =>
                onPatch({
                  kanbanGroupBy: kanbanGroupBy === "__auto" ? null : kanbanGroupBy,
                  kanbanActionMap: (() => {
                    const cleaned = cleanActionMap(actionMap);
                    return Object.keys(cleaned).length ? cleaned : null;
                  })() as SchemaLike["kanbanActionMap"],
                })
              }
            >
              <Trans>Save kanban</Trans>
            </Button>
          </div>
        </Card>
      ) : null}

      {schema.adopted ? (
        // Adopted collections soft-delete (archive). The physical table stays
        // intact, metadata is retained, and the row can be restored from the
        // Archived view in the collections index.
        <div className="overflow-hidden rounded-surface border border-[color-mix(in_oklch,var(--chart-2,var(--primary))_35%,var(--border))] bg-card text-card-foreground">
          <div className="flex items-center gap-2.5 border-b border-border px-4 py-3.5">
            <I.Archive size={14} />
            <span className="text-[13px] font-medium text-[color-mix(in_oklch,var(--chart-2,var(--primary))_80%,var(--foreground))]"><Trans>archive zone</Trans></span>
          </div>
          <div className="flex items-center justify-between gap-4 p-4">
            <div>
              <div className="text-[13px] font-medium"><Trans>Archive this collection</Trans></div>
              <div className="text-[11.5px] text-muted-foreground">
                <Trans>Backlex stops treating <span className="font-mono">{schema.slug}</span> as a collection.
                The underlying table and its rows stay intact; you can restore from the Archived view.</Trans>
              </div>
            </div>
            <Button variant="outline" size="sm" icon={I.Archive} onClick={onDelete}>
              <Trans>Archive collection</Trans>
            </Button>
          </div>
        </div>
      ) : (
        <div className="overflow-hidden rounded-surface border border-[color-mix(in_oklch,var(--destructive)_35%,var(--border))] bg-card text-card-foreground">
          <div className="flex items-center gap-2.5 border-b border-border px-4 py-3.5">
            <I.Trash size={14} />
            <span className="text-[13px] font-medium text-destructive"><Trans>danger zone</Trans></span>
          </div>
          <div className="flex items-center justify-between gap-4 p-4">
            <div>
              <div className="text-[13px] font-medium"><Trans>Delete this collection</Trans></div>
              <div className="text-[11.5px] text-muted-foreground">
                <Trans>Drops the physical table and all rows.
                Permissions and revisions tied to the slug are removed too. This is irreversible.</Trans>
              </div>
            </div>
            <Button variant="primary" size="sm" onClick={onDelete} className="border-destructive bg-destructive">
              <Trans>Delete collection</Trans>
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
