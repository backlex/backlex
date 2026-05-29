// @ts-nocheck
// Collections index — grid of all collections + new-collection wizard
import { useEffect, useMemo, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { I, type IconComponent, type IconKey } from "./icons";
import type { CollectionListItem } from "./config";
import { Badge, Button, IconButton, PageHeader, Switch } from "./ui";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@backlex/ui/components/input-group";
import { Input } from "@backlex/ui/components/input";
import { ScrollArea } from "@backlex/ui/components/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@backlex/ui/components/dialog";
import { AdoptWizard } from "./adopt-wizard";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@backlex/ui/components/table";
import { useUrlState } from "@/lib/use-url-state";
import { Skeleton } from "@backlex/ui/components/skeleton";
import { SkeletonRow } from "./loading";
import { useCollections } from "./queries";

const ADMIN_TABLE_CLS =
  "[&_td]:px-3.5 [&_td]:text-[13px] [&_th]:h-9 [&_th]:px-3.5 [&_th]:text-[11px] [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-[0.06em] [&_th]:text-muted-foreground";

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
  const { t } = useLingui();
  const [search, setSearch] = useUrlState("q", "");
  const [view, setView] = useState<"grid" | "table">("grid");
  const [adoptOpen, setAdoptOpen] = useState(false);
  // Single entry-point chooser: the create + adopt flows share one backend
  // path (`POST /api/collections` with optional `adopted: true`), and this
  // chooser is the UI counterpart — one button on the page, two distinct
  // wizards routed by the user's intent.
  const [chooserOpen, setChooserOpen] = useState(false);
  // `collections` arrives enriched (metrics merge + status filter) from the
  // parent. The real fetch lifecycle lives in React Query — observe the same
  // cached query so the skeleton tracks the actual request instead of the
  // old timeout heuristic. Same query key as the parent → cache hit, no
  // duplicate network call.
  const collectionsQuery = useCollections(!!showArchived);
  const loading = collectionsQuery.isLoading;

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
    <div className="flex min-w-0 flex-col gap-4.5">
      <PageHeader
        title={<Trans>Collections</Trans>}
        description={<Trans>Each collection is a physical table created at runtime. Drag fields, set permissions, or expose REST/GraphQL — all without writing migrations.</Trans>}
        badges={<span className="ml-1 inline-flex flex-wrap gap-1.5">
          <Badge variant={showArchived ? "secondary" : "outline"} mono>
            {collections.length} {showArchived ? <Trans>archived</Trans> : <Trans>collections</Trans>}
          </Badge>
          {!showArchived && (
            <Badge variant="outline" mono><Trans>{collections.reduce((a, c) => a + c.count, 0).toLocaleString()} rows</Trans></Badge>
          )}
        </span>}
        actions={<>
          {onToggleArchived && (
            <Button
              variant="outline"
              icon={showArchived ? I.Inbox : I.Archive}
              onClick={() => onToggleArchived(!showArchived)}
              title={showArchived ? t`Show active collections` : t`Show archived collections`}
            >
              {showArchived ? <Trans>View active</Trans> : <Trans>View archived</Trans>}
            </Button>
          )}
          {!showArchived && <>
            <Button variant="outline" icon={I.Code}><Trans>Schema</Trans></Button>
            <Button variant="outline" icon={I.ExternalLink} onClick={() => onOpenApi?.()}><Trans>API docs</Trans></Button>
            <Button variant="primary" icon={I.Plus} onClick={() => setChooserOpen(true)}><Trans>New collection</Trans></Button>
          </>}
        </>}
      />
      <AdoptWizard
        open={adoptOpen}
        onClose={() => setAdoptOpen(false)}
        onComplete={({ slug }) => {
          setAdoptOpen(false);
          pushToast?.(t`Adopted "${slug}". Reloading…`);
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

      <div className="flex flex-wrap items-center gap-2">
        <InputGroup>
          <InputGroupAddon><I.Search size={14} /></InputGroupAddon>
          <InputGroupInput value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t`Search collections by slug or group…`} />
        </InputGroup>
        <div className="flex-1" />
        <Button size="sm" variant={view === "grid" ? "outline" : "ghost"} icon={I.Braces} onClick={() => setView("grid")}><Trans>Grid</Trans></Button>
        <Button size="sm" variant={view === "table" ? "outline" : "ghost"} icon={I.Inbox} onClick={() => setView("table")}><Trans>Table</Trans></Button>
      </div>

      {view === "grid" ? (
        <div className="flex flex-col gap-[22px]">
          {loading && groups.length === 0 && (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,280px),1fr))] gap-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="flex min-h-[138px] flex-col gap-3 overflow-hidden rounded-2xl border border-border bg-card p-4 text-card-foreground">
                  <SkeletonRow cols={3} />
                </div>
              ))}
            </div>
          )}
          {groups.map(([g, list]) => (
            <div key={g} className="flex flex-col gap-2.5">
              <div className="flex items-baseline gap-2">
                <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{g}</span>
                <span className="text-[11px] tabular-nums text-muted-foreground">{list.length}</span>
                <div className="ml-1.5 h-px flex-1 bg-border" />
              </div>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,280px),1fr))] gap-3">
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
                  <button onClick={onNew} className="grid min-h-[138px] cursor-pointer place-items-center gap-1.5 rounded-2xl border-[1.5px] border-dashed border-border bg-transparent text-muted-foreground">
                    <I.Plus size={18} />
                    <span className="text-[12.5px] font-medium"><Trans>New collection</Trans></span>
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-border bg-card text-card-foreground">
          <Table className={ADMIN_TABLE_CLS}>
            <TableHeader>
              <TableRow>
                <TableHead><Trans>Slug</Trans></TableHead>
                <TableHead className="w-[110px]"><Trans>Group</Trans></TableHead>
                <TableHead className="w-[90px] text-right"><Trans>Rows</Trans></TableHead>
                <TableHead className="w-[80px] text-right"><Trans>Fields</Trans></TableHead>
                <TableHead className="w-[110px] text-right"><Trans>Writes 24h</Trans></TableHead>
                <TableHead className="w-[110px]"><Trans>Last write</Trans></TableHead>
                <TableHead className="w-[130px]"><Trans>Permissions</Trans></TableHead>
                <TableHead className="sticky right-0 w-[60px] bg-card" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && filtered.length === 0 &&
                Array.from({ length: 6 }).map((_, i) => (
                  <TableRow key={`sk-${i}`}>
                    {Array.from({ length: 8 }).map((_, c) => (
                      <TableCell key={c}><Skeleton className="h-4 w-3/4" /></TableCell>
                    ))}
                  </TableRow>
                ))}
              {filtered.map((c) => {
                const Ic = (I as Record<string, IconComponent>)[c.icon as IconKey] || I.Database;
                return (
                  <TableRow key={c.slug} onClick={() => onOpen(c.slug)} className="cursor-pointer">
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span className="grid size-6 place-items-center rounded-md bg-muted"><Ic size={12} /></span>
                        <span className="font-mono text-[13px] font-medium">{c.slug}</span>
                        {c.singleton && <Badge variant="outline"><Trans>singleton</Trans></Badge>}
                      </div>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{c.group}</TableCell>
                    <TableCell className="text-right tabular-nums">{c.count.toLocaleString()}</TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">{c.fields}</TableCell>
                    <TableCell className="text-right tabular-nums">{c.writes24h}</TableCell>
                    <TableCell className="font-mono text-[11.5px] text-muted-foreground">{c.lastWrite}</TableCell>
                    <TableCell>
                      {showArchived
                        ? <Badge variant="secondary"><Trans>archived</Trans></Badge>
                        : c.ownerScoped ? <Badge variant="default"><Trans>owner-scoped</Trans></Badge> : <Badge variant="secondary"><Trans>public read</Trans></Badge>}
                    </TableCell>
                    <TableCell className="sticky right-0 bg-card text-right" onClick={(e) => e.stopPropagation()}>
                      {showArchived
                        ? onRestore && (
                            <IconButton icon={I.RotateCcw} title={t`Restore collection`} onClick={() => onRestore(c.slug)} />
                          )
                        : onDelete && (
                            <IconButton icon={I.Trash} title={t`Delete collection`} onClick={() => onDelete(c.slug)} />
                          )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

function CollectionCard({ c, onOpen, archived, onRestore, onOpenApi }: { c: CollectionListItem; onOpen: () => void; archived?: boolean; onRestore?: () => void; onOpenApi?: () => void }) {
  const { t } = useLingui();
  const Ic = (I as Record<string, IconComponent>)[c.icon as IconKey] || I.Database;
  return (
    <div
      className={`flex cursor-pointer flex-col gap-3 overflow-hidden rounded-2xl border border-border bg-card p-4 text-card-foreground transition-colors hover:border-[color-mix(in_oklch,var(--primary)_50%,var(--border))] ${archived ? "opacity-90" : ""}`}
      onClick={onOpen}
    >
      <div className="flex items-center gap-2.5">
        <span className="grid size-8 place-items-center rounded-lg border border-border bg-muted text-muted-foreground"><Ic size={15} /></span>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-mono text-[13.5px] font-semibold">{c.slug}</span>
          <span className="truncate text-[11.5px] text-muted-foreground"><Trans>{c.fields} fields · {c.singleton ? "singleton" : c.ownerScoped ? "owner-scoped" : "public read"}</Trans></span>
        </div>
        {archived && (
          <span className="ml-auto">
            <Badge variant="secondary">
              <I.Archive size={10} />
              <span className="ml-1"><Trans>archived</Trans></span>
            </Badge>
          </span>
        )}
      </div>
      <div className="grid grid-cols-3 gap-2">
        <Stat k="rows" v={c.count.toLocaleString()} />
        <Stat k="writes 24h" v={c.writes24h} />
        <Stat k="last" v={c.lastWrite} mono />
      </div>
      <div className="flex gap-1.5">
        {archived ? (
          <>
            {onRestore && (
              <Button
                size="sm"
                variant="primary"
                icon={I.RotateCcw}
                onClick={(e) => { e.stopPropagation(); onRestore(); }}
              >
                <Trans>Restore</Trans>
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); onOpen(); }}><Trans>Open</Trans></Button>
          </>
        ) : (
          <>
            <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); onOpen(); }}><Trans>Open</Trans></Button>
            <Button size="sm" variant="ghost" iconRight={I.ExternalLink} onClick={(e) => { e.stopPropagation(); onOpenApi?.(); }}>API</Button>
          </>
        )}
      </div>
    </div>
  );
}

function Stat({ k, v, mono }: { k: string; v: string | number; mono?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="truncate text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">{k}</span>
      <span className={`truncate tabular-nums ${mono ? "font-mono text-[11.5px] font-normal" : "text-sm font-semibold"}`}>{v}</span>
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
  const { t } = useLingui();
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
  const slugError = !slugClean ? null : existingSlugs.includes(slugClean) ? t`${slugClean} already exists` : !/^[a-z][a-z0-9_]*$/.test(slugClean) ? t`must start with a letter` : null;

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
    { id: "blank", name: t`Blank`, desc: t`Just system fields. Add your own columns.`, icon: "Braces", fields: [] },
    {
      id: "content",
      name: t`Content`,
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
      name: t`Taxonomy`,
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
      name: t`People`,
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

  const sql = `CREATE TABLE ${slugClean || "<slug>"} (
  id          uuid PRIMARY KEY DEFAULT gen_uuid(),${tenantScoped ? `\n  tenant_id   uuid NOT NULL REFERENCES tenants(id),` : ""}${ownerScoped ? `\n  owner_id    uuid NOT NULL,` : ""}${timestamps ? `\n  created_at  timestamptz NOT NULL DEFAULT now(),\n  updated_at  timestamptz NOT NULL DEFAULT now(),` : ""}${softDelete ? `\n  deleted_at  timestamptz,` : ""}
  -- + template columns
);${tenantScoped ? `\n\n-- RLS auto-injected:\n-- ALTER TABLE ${slugClean || "<slug>"} ENABLE ROW LEVEL SECURITY;\n-- CREATE POLICY tenant_isolation ON ${slugClean || "<slug>"}\n--   USING (tenant_id = current_setting('app.tenant_id')::uuid);` : ""}`;

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
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="flex max-h-[90vh] w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-[640px]">
        <DialogHeader className="flex-row items-center gap-2.5 border-b border-border px-4 py-3.5 pr-12 text-left">
          <I.Database size={14} />
          <DialogTitle className="text-sm font-medium"><Trans>New collection</Trans></DialogTitle>
          <span className="font-mono text-[11.5px] text-muted-foreground"><Trans>step {step + 1} of 2</Trans></span>
        </DialogHeader>

        <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-4 p-[22px]">
          {step === 0 && (
            <>
              <div className="flex flex-col gap-1.5">
                <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Slug</Trans></label>
                <Input value={slug} onChange={(e) => setSlug(e.target.value)} autoFocus placeholder="products" className="font-mono" aria-invalid={slugError ? true : undefined} />
                {slugError && <span className="text-[11.5px] text-destructive">{slugError}</span>}
                {!slugError && !slugClean && <span className="text-[11.5px] text-muted-foreground"><Trans>Enter a slug to continue.</Trans></span>}
                {!slugError && slugClean && <span className="text-[11.5px] text-muted-foreground"><Trans>Slug: <span className="font-mono">{slugClean}</span></Trans></span>}
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Group</Trans></label>
                <div className="flex flex-wrap gap-1.5">
                  {["Content", "Marketing", "System", "Other"].map((g) => (
                    <Button key={g} type="button" size="sm" variant={group === g ? "outline" : "ghost"} onClick={() => setGroup(g)}>{g}</Button>
                  ))}
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Start from</Trans></label>
                <div className="grid grid-cols-2 gap-2">
                  {templates.map((t) => {
                    const Ic = (I as Record<string, IconComponent>)[t.icon as IconKey] || I.Braces;
                    const active = template === t.id;
                    return (
                      <button key={t.id} type="button" onClick={() => setTemplate(t.id)} className={`cursor-pointer rounded-2xl border p-3 text-left ${active ? "border-primary bg-[color-mix(in_oklch,var(--primary)_8%,var(--card))]" : "border-border bg-card"}`}>
                        <div className="mb-1 flex items-center gap-2">
                          <Ic size={13} />
                          <span className="text-[13px] font-medium">{t.name}</span>
                          <div className="flex-1" />
                          <span className="tabular-nums text-[11px] text-muted-foreground"><Trans>{t.fields.length} fields</Trans></span>
                        </div>
                        <span className="text-[11.5px] leading-[1.4] text-muted-foreground">{t.desc}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </>
          )}

          {step === 1 && (
            <>
              <div className="flex items-center justify-between gap-3 border-b border-border pb-3">
                <div>
                  <div className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Tenant-scoped</Trans> <Badge variant="secondary"><Trans>recommended</Trans></Badge></div>
                  <div className="text-[11.5px] text-muted-foreground"><Trans>Auto-add <span className="font-mono">tenant_id</span>; row-level security isolates data per workspace. All read/write rules get <span className="font-mono">tenant_id = $user.tenant_id</span> injected.</Trans></div>
                </div>
                <Switch checked={tenantScoped} onChange={setTenantScoped} />
              </div>
              <div className="flex items-center justify-between gap-3 border-b border-border pb-3">
                <div>
                  <div className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Owner-scoped</Trans></div>
                  <div className="text-[11.5px] text-muted-foreground"><Trans>Auto-add <span className="font-mono">owner_id</span>; the <span className="font-mono">authenticated</span> role can only read/update its own rows.</Trans></div>
                </div>
                <Switch checked={ownerScoped} onChange={setOwnerScoped} />
              </div>
              <div className="flex items-center justify-between gap-3 border-b border-border pb-3">
                <div>
                  <div className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Timestamps</Trans></div>
                  <div className="text-[11.5px] text-muted-foreground"><Trans>Add <span className="font-mono">created_at</span> and <span className="font-mono">updated_at</span>.</Trans></div>
                </div>
                <Switch checked={timestamps} onChange={setTimestamps} />
              </div>
              <div className="flex items-center justify-between gap-3 border-b border-border pb-3">
                <div>
                  <div className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Soft delete</Trans></div>
                  <div className="text-[11.5px] text-muted-foreground"><Trans>Add <span className="font-mono">deleted_at</span>; deletes mark rows instead of removing them.</Trans></div>
                </div>
                <Switch checked={softDelete} onChange={setSoftDelete} />
              </div>
              <div className="flex items-center justify-between gap-3 border-b border-border pb-3">
                <div>
                  <div className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Status field</Trans></div>
                  <div className="text-[11.5px] text-muted-foreground">
                    <Trans>Add a <span className="font-mono">status</span> dropdown with{" "}
                    <span className="font-mono">draft / review / published / archived</span>{" "}
                    + per-option color. List view auto-shows status tabs and badges.</Trans>
                  </div>
                </div>
                <Switch checked={withStatus} onChange={setWithStatus} />
              </div>
              <div className="flex items-center justify-between gap-3 pb-1">
                <div>
                  <div className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Singleton</Trans></div>
                  <div className="text-[11.5px] text-muted-foreground"><Trans>Locked to one row — useful for site settings.</Trans></div>
                </div>
                <Switch checked={singleton} onChange={setSingleton} />
              </div>

              <pre className="mt-1 m-0 whitespace-pre-wrap rounded-xl bg-[oklch(from_var(--primary)_0.18_0.01_h)] p-3.5 font-mono text-[11.5px] leading-[1.55] text-[oklch(from_var(--primary)_0.95_0.02_h)]">{sql}</pre>
            </>
          )}
        </div>
        </ScrollArea>

        <div className="flex items-center gap-2 border-t border-border px-4 py-3.5">
          {step === 1 && <Button variant="ghost" size="sm" icon={I.ChevronLeft} onClick={() => setStep(0)}><Trans>Back</Trans></Button>}
          <div className="flex-1" />
          <Button variant="ghost" size="sm" onClick={onClose}><Trans>Cancel</Trans></Button>
          {step === 0 ? (
            <Button variant="primary" size="sm" iconRight={I.ChevronRight} onClick={() => {
              if (!slugClean || slugError) return;
              setStep(1);
            }} title={!slugClean ? t`Enter a slug first` : slugError || ""}><Trans>Next</Trans></Button>
          ) : (
            <Button variant="primary" size="sm" icon={I.Plus} onClick={submit}><Trans>Create collection</Trans></Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
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
  const { t } = useLingui();
  if (!open) return null;
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="flex max-h-[90vh] w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-[560px]">
        <DialogHeader className="flex-row items-center gap-2.5 border-b border-border px-4 py-3.5 pr-12 text-left">
          <I.Plus size={14} />
          <DialogTitle className="text-sm font-medium"><Trans>New collection</Trans></DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3 p-[22px]">
          <button
            type="button"
            onClick={onPickEmpty}
            className="flex cursor-pointer flex-col gap-2.5 rounded-2xl border border-border bg-card p-[18px] text-left text-card-foreground transition-colors hover:border-[color-mix(in_oklch,var(--primary)_50%,var(--border))]"
          >
            <span className="grid size-9 place-items-center rounded-lg border border-border bg-muted"><I.Braces size={16} /></span>
            <div className="flex flex-col gap-1">
              <span className="text-[13.5px] font-semibold"><Trans>Empty or template</Trans></span>
              <span className="text-xs leading-[1.45] text-muted-foreground">
                <Trans>Create a new physical table from scratch. Pick a preset (Content / Taxonomy / People / Blank) and configure scope toggles.</Trans>
              </span>
            </div>
          </button>
          <button
            type="button"
            onClick={onPickAdopt}
            className="flex cursor-pointer flex-col gap-2.5 rounded-2xl border border-border bg-card p-[18px] text-left text-card-foreground transition-colors hover:border-[color-mix(in_oklch,var(--primary)_50%,var(--border))]"
          >
            <span className="grid size-9 place-items-center rounded-lg border border-border bg-muted"><I.Database size={16} /></span>
            <div className="flex flex-col gap-1">
              <span className="text-[13.5px] font-semibold"><Trans>From existing table</Trans></span>
              <span className="text-xs leading-[1.45] text-muted-foreground">
                <Trans>Register a table that already exists in your database. No DDL is run on the table — backlex only writes its own metadata.</Trans>
              </span>
            </div>
          </button>
        </div>
        <div className="flex items-center gap-2 border-t border-border px-4 py-3.5">
          <div className="flex-1" />
          <Button variant="ghost" size="sm" onClick={onClose}><Trans>Cancel</Trans></Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
