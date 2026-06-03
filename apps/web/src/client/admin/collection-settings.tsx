// @ts-nocheck
// Per-collection settings tab — edit metadata (singular/plural/note/display
// template), toggle owner-scope, and a destructive zone to drop the whole
// collection. Mounted as the 4th tab next to Items / Schema / Permissions.
import { useEffect, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { Input } from "@backlex/ui/components/input";
import { Textarea } from "@backlex/ui/components/textarea";
import { I } from "./icons";
import { Select } from "./select";
import { Button, Switch } from "./ui";
import { DisplayTemplateEditor } from "./display-template-editor";

interface FieldLike {
  name: string;
  type?: string;
  /** Target collection slug — present on `relation` fields. */
  to?: string;
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
  // All workspace collections (slug + fields) — powers the display-template
  // editor's relation drill-down (`{{ author.name }}`).
  collections: { slug: string; fields?: FieldLike[] }[];
  onPatch: (patch: Partial<SchemaLike>) => void | Promise<void>;
  onRename: (nextSlug: string) => void | Promise<void>;
  onDelete: () => void;
}

export function CollectionSettings({ schema, existingSlugs, collections, onPatch, onRename, onDelete }: CollectionSettingsProps) {
  const { t } = useLingui();
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
        ? t`slug is required`
        : !/^[a-z][a-z0-9_]*$/.test(slugClean)
          ? t`must start with a letter; snake_case only`
          : existingSlugs.some((s) => s !== schema.slug && s === slugClean)
            ? t`${slugClean} already exists`
            : null;
  const slugDirty = slugClean !== schema.slug;

  const dirty =
    (schema.singular ?? "") !== singular ||
    (schema.plural ?? "") !== plural ||
    (schema.note ?? "") !== note ||
    (schema.displayTemplate ?? "") !== displayTemplate;

  return (
    <div className="flex flex-col gap-3.5">
      <div className="overflow-hidden rounded-2xl border border-border bg-card text-card-foreground">
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
            <div className={`flex h-9 items-stretch overflow-hidden rounded-md border bg-background ${slugError ? "border-destructive focus-within:shadow-[0_0_0_3px_color-mix(in_oklch,var(--destructive)_22%,transparent)]" : "border-border focus-within:border-ring focus-within:shadow-[0_0_0_3px_color-mix(in_oklch,var(--ring)_22%,transparent)]"}`}>
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
            <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Note</Trans></label>
            <Textarea
              rows={3}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t`Internal description for teammates.`}
            />
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-4 py-2.5">
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
            <Trans>Save changes</Trans>
          </Button>
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-border bg-card text-card-foreground">
        <div className="flex items-center gap-2.5 border-b border-border px-4 py-3.5">
          <I.Shield size={14} />
          <span className="text-[13px] font-medium"><Trans>scoping &amp; lifecycle</Trans></span>
        </div>
        <div className="px-4 py-2.5">
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
          <div className="flex items-center justify-between gap-3 pb-1">
            <div>
              <div className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Versioned (draft / published)</Trans></div>
              <div className="text-[11.5px] text-muted-foreground">
                <Trans>Adds <span className="font-mono">_status</span> + <span className="font-mono">_published_at</span>.
                Independent of the user-defined "status" field.</Trans>
              </div>
            </div>
            <Switch checked={!!schema.versioned} onChange={(v) => onPatch({ versioned: v })} />
          </div>
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-border bg-card text-card-foreground">
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
      </div>

      {schema.adopted ? (
        // Adopted collections soft-delete (archive). The physical table stays
        // intact, metadata is retained, and the row can be restored from the
        // Archived view in the collections index.
        <div className="overflow-hidden rounded-2xl border border-[color-mix(in_oklch,var(--chart-2,var(--primary))_35%,var(--border))] bg-card text-card-foreground">
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
        <div className="overflow-hidden rounded-2xl border border-[color-mix(in_oklch,var(--destructive)_35%,var(--border))] bg-card text-card-foreground">
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
