// @ts-nocheck
// Collections index — grid of all collections + new-collection wizard
import { useEffect, useMemo, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { I, type IconComponent, type IconKey } from "./icons";
import type { CollectionListItem } from "./config";
import { Badge, Button, EmptyState, IconButton, PageHeader, Switch } from "./ui";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@backlex/ui/components/input-group";
import { Input } from "@backlex/ui/components/input";
import { ScrollArea } from "@backlex/ui/components/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@backlex/ui/components/dialog";
import { AdoptWizard } from "./adopt-wizard";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@backlex/ui/components/table";
import { useUrlState } from "@/lib/use-url-state";
import { Skeleton } from "@backlex/ui/components/skeleton";
import { Card } from "@backlex/ui/components/card";
import { useIsMobile } from "@backlex/ui/hooks/use-mobile";
import { SkeletonRow } from "./loading";
import { orderCollections, useCollections, useSaveCollectionsLayout } from "./queries";

const ADMIN_TABLE_CLS =
  "[&_td]:px-3.5 [&_td]:text-[13px] [&_th]:h-9 [&_th]:px-3.5 [&_th]:text-[11px] [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-[0.06em] [&_th]:text-muted-foreground";

export interface CollectionsIndexProps {
  collections: CollectionListItem[];
  /** Saved group-header order (`meta.groups` from the collections list). */
  collectionGroups: string[];
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
  /** Jump to the Schema graph (ERD) page. */
  onOpenSchema?: () => void;
  pushToast: (msg: string) => void;
}

export function CollectionsIndex({ collections, collectionGroups, onOpen, onNew, onDelete, showArchived, onToggleArchived, onRestore, onOpenApi, onOpenSchema, pushToast }: CollectionsIndexProps) {
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

  // --- Edit-layout mode (grouping + manual order) ---------------------------
  // Same posture as the dashboards editor: desktop-only (HTML5 dnd doesn't
  // fire reliably on touch), grid view forced, search cleared on entry. Every
  // committed action recomputes the FULL layout (dense per-group sortOrder)
  // and saves optimistically — the query cache patches first, the props
  // re-derive, and a failed save rolls back.
  const isMobile = useIsMobile();
  const [editingLayout, setEditingLayout] = useState(false);
  const editing = editingLayout && !isMobile && !showArchived;
  useEffect(() => {
    if (isMobile || showArchived) setEditingLayout(false);
  }, [isMobile, showArchived]);
  const layoutMutation = useSaveCollectionsLayout();
  // Drag state: which card / group header is in flight + the hovered target
  // (`card:<slug>` | `group:<name|∅>` | `header:<name>`) for the drop hint.
  const [dragSlug, setDragSlug] = useState<string | null>(null);
  const [dragGroup, setDragGroup] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState<string | null>(null);
  const [renamingGroup, setRenamingGroup] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [addingGroup, setAddingGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return collections;
    return collections.filter((c) => c.slug.toLowerCase().includes(q) || (c.group || "").toLowerCase().includes(q));
  }, [collections, search]);

  // Ordered [group, items] sections. Edit mode ignores the search filter so a
  // drop can't silently reorder rows that are filtered out of view; empty
  // saved groups only render while editing (they're drop targets there).
  const grouped = useMemo(() => {
    const all = orderCollections(editing ? collections : filtered, collectionGroups);
    return editing ? all : all.filter(([, list]) => list.length > 0);
  }, [collections, filtered, collectionGroups, editing]);

  /** Persist a full layout: `lists` is every section's slugs in display
   *  order; per-group `sortOrder` is renumbered dense from it. */
  const commitLayout = (nextGroups: string[], nextLists: [string | null, string[]][]) => {
    const items = nextLists.flatMap(([g, slugs]) =>
      slugs.map((slug, i) => ({ slug, group: g, sortOrder: i })),
    );
    layoutMutation.mutate(
      { groups: nextGroups, items },
      { onError: (e) => pushToast?.((e as Error).message, "error") },
    );
  };

  const currentLists = (): [string | null, string[]][] =>
    grouped.map(([g, list]) => [g, list.map((c) => c.slug)]);

  /** Saved header order + any group names that only exist on rows (shown
   *  appended in the UI) — committing normalizes them into the saved list. */
  const currentGroups = (): string[] => {
    const extras = grouped
      .map(([g]) => g)
      .filter((g): g is string => g !== null && !collectionGroups.includes(g));
    return [...collectionGroups, ...extras];
  };

  const moveCard = (slug: string, target: { group: string | null; beforeSlug?: string }) => {
    const lists: [string | null, string[]][] = currentLists().map(([g, slugs]) => [
      g,
      slugs.filter((s) => s !== slug),
    ]);
    let entry = lists.find(([g]) => g === target.group);
    if (!entry) {
      entry = [target.group, []];
      lists.push(entry);
    }
    const idx = target.beforeSlug ? entry[1].indexOf(target.beforeSlug) : -1;
    if (idx >= 0) entry[1].splice(idx, 0, slug);
    else entry[1].push(slug);
    commitLayout(currentGroups(), lists);
  };

  const moveGroupHeader = (name: string, beforeName: string) => {
    const gs = currentGroups().filter((g) => g !== name);
    const idx = gs.indexOf(beforeName);
    if (idx >= 0) gs.splice(idx, 0, name);
    else gs.push(name);
    commitLayout(gs, currentLists());
  };

  const renameGroup = (from: string, to: string) => {
    setRenamingGroup(null);
    const name = to.trim();
    if (!name || name === from) return;
    const gs = currentGroups().map((g) => (g === from ? name : g));
    // Renaming onto an existing name merges the two sections.
    const dedup = gs.filter((g, i) => gs.indexOf(g) === i);
    const merged = new Map<string | null, string[]>();
    for (const [g, slugs] of currentLists()) {
      const key = g === from ? name : g;
      merged.set(key, [...(merged.get(key) ?? []), ...slugs]);
    }
    commitLayout(dedup, [...merged.entries()]);
  };

  const deleteGroup = (name: string) => {
    const gs = currentGroups().filter((g) => g !== name);
    const lists = currentLists();
    const removed = lists.find(([g]) => g === name)?.[1] ?? [];
    const rest = lists.filter(([g]) => g !== name);
    const nullEntry = rest.find(([g]) => g === null);
    if (nullEntry) nullEntry[1].push(...removed);
    else if (removed.length) rest.push([null, removed]);
    commitLayout(gs, rest);
  };

  const addGroup = () => {
    setAddingGroup(false);
    const name = newGroupName.trim();
    setNewGroupName("");
    if (!name) return;
    const gs = currentGroups();
    if (gs.includes(name)) return;
    commitLayout([...gs, name], currentLists());
  };

  const clearDrag = () => {
    setDragSlug(null);
    setDragGroup(null);
    setDropHint(null);
  };

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
            {!isMobile && (
              <Button
                variant={editing ? "primary" : "outline"}
                icon={editing ? I.Check : I.Pencil}
                onClick={() => {
                  if (!editingLayout) {
                    // Drops reorder what's visible — force the grouped grid
                    // and drop any search filter before enabling dnd.
                    setView("grid");
                    setSearch("");
                  }
                  setEditingLayout((v) => !v);
                }}
                title={editing ? t`Finish arranging collections` : t`Group and reorder collections`}
              >
                {editing ? <Trans>Done</Trans> : <Trans>Edit layout</Trans>}
              </Button>
            )}
            <Button variant="outline" icon={I.Code} onClick={() => onOpenSchema?.()}><Trans>Schema</Trans></Button>
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

      {!loading && filtered.length === 0 ? (
        // Empty state — a fresh workspace, an empty archive, or a search that
        // matched nothing. Without this the grid/table body renders blank.
        <EmptyState
          icon={collections.length === 0 ? I.Database : I.Search}
          title={
            showArchived ? (
              <Trans>No archived collections</Trans>
            ) : collections.length === 0 ? (
              <Trans>No collections yet</Trans>
            ) : (
              <Trans>No collections match your search</Trans>
            )
          }
          description={
            showArchived ? (
              <Trans>Collections you archive will show up here.</Trans>
            ) : collections.length === 0 ? (
              <Trans>
                Collections are physical tables created at runtime. Create one from scratch,
                adopt an existing table, or apply a starter template from the Overview.
              </Trans>
            ) : (
              <Trans>Try a different slug or group.</Trans>
            )
          }
          action={
            !showArchived && collections.length === 0 ? (
              <Button variant="primary" icon={I.Plus} onClick={() => setChooserOpen(true)}>
                <Trans>New collection</Trans>
              </Button>
            ) : !showArchived && search ? (
              <Button variant="outline" onClick={() => setSearch("")}>
                <Trans>Clear search</Trans>
              </Button>
            ) : undefined
          }
        />
      ) : view === "grid" ? (
        <div className="flex flex-col gap-[22px]">
          {loading && grouped.length === 0 && (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,280px),1fr))] gap-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <Card key={i} className="min-h-[138px] gap-3 p-4">
                  <SkeletonRow cols={3} />
                </Card>
              ))}
            </div>
          )}
          {grouped.map(([g, list]) => (
            <div key={g ?? "__ungrouped"} className="flex flex-col gap-2.5">
              <div
                className={`flex items-center gap-2 rounded-md ${editing && g !== null ? "cursor-grab" : ""} ${dropHint === `header:${g}` ? "ring-2 ring-primary" : ""} ${dragGroup === g && g !== null ? "opacity-50" : ""}`}
                draggable={editing && g !== null}
                onDragStart={editing && g !== null ? (e) => {
                  setDragGroup(g);
                  e.dataTransfer.setData("text/plain", g);
                  e.dataTransfer.effectAllowed = "move";
                } : undefined}
                onDragEnd={editing ? clearDrag : undefined}
                onDragOver={editing ? (e) => {
                  // Header row doubles as a drop target: another header lands
                  // before this one; a card appends to this group.
                  if (dragGroup && g !== null && dragGroup !== g) {
                    e.preventDefault();
                    setDropHint(`header:${g}`);
                  } else if (dragSlug) {
                    e.preventDefault();
                    setDropHint(`group:${g ?? ""}`);
                  }
                } : undefined}
                onDrop={editing ? (e) => {
                  e.preventDefault();
                  if (dragGroup && g !== null && dragGroup !== g) moveGroupHeader(dragGroup, g);
                  else if (dragSlug) moveCard(dragSlug, { group: g });
                  clearDrag();
                } : undefined}
              >
                {editing && g !== null && <I.Grip size={12} className="text-muted-foreground" />}
                {renamingGroup === g && g !== null ? (
                  <Input
                    autoFocus
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onBlur={() => renameGroup(g, renameValue)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") renameGroup(g, renameValue);
                      if (e.key === "Escape") setRenamingGroup(null);
                    }}
                    className="h-6 max-w-[220px] text-[11px] font-semibold uppercase tracking-[0.08em]"
                  />
                ) : (
                  <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                    {g ?? <Trans>Ungrouped</Trans>}
                  </span>
                )}
                <span className="text-[11px] tabular-nums text-muted-foreground">{list.length}</span>
                {editing && g !== null && renamingGroup !== g && (
                  <span className="flex items-center gap-0.5">
                    <IconButton icon={I.Pencil} title={t`Rename group`} onClick={() => { setRenamingGroup(g); setRenameValue(g); }} />
                    <IconButton icon={I.X} title={t`Delete group (collections become ungrouped)`} onClick={() => deleteGroup(g)} />
                  </span>
                )}
                <div className="ml-1.5 h-px flex-1 bg-border" />
              </div>
              <div
                className={`grid grid-cols-[repeat(auto-fill,minmax(min(100%,280px),1fr))] gap-3 ${editing && dropHint === `group:${g ?? ""}` ? "rounded-2xl ring-2 ring-primary/50" : ""}`}
                onDragOver={editing && dragSlug ? (e) => {
                  e.preventDefault();
                  setDropHint(`group:${g ?? ""}`);
                } : undefined}
                onDrop={editing ? (e) => {
                  e.preventDefault();
                  if (dragSlug) moveCard(dragSlug, { group: g });
                  clearDrag();
                } : undefined}
              >
                {list.map((c) => (
                  <div
                    key={c.slug}
                    draggable={editing}
                    onDragStart={editing ? (e) => {
                      setDragSlug(c.slug);
                      e.dataTransfer.setData("text/plain", c.slug);
                      e.dataTransfer.effectAllowed = "move";
                    } : undefined}
                    onDragEnd={editing ? clearDrag : undefined}
                    onDragOver={editing ? (e) => {
                      if (dragSlug && dragSlug !== c.slug) {
                        e.preventDefault();
                        e.stopPropagation();
                        setDropHint(`card:${c.slug}`);
                      }
                    } : undefined}
                    onDrop={editing ? (e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      if (dragSlug && dragSlug !== c.slug) moveCard(dragSlug, { group: g, beforeSlug: c.slug });
                      clearDrag();
                    } : undefined}
                    className={editing ? `cursor-grab ${dragSlug === c.slug ? "opacity-50" : ""}` : "contents"}
                  >
                    <CollectionCard
                      c={c}
                      archived={!!showArchived}
                      editing={editing}
                      dropTarget={editing && dropHint === `card:${c.slug}`}
                      onOpen={() => onOpen(c.slug)}
                      onOpenApi={onOpenApi ? () => onOpenApi(c.slug) : undefined}
                      onRestore={onRestore ? () => onRestore(c.slug) : undefined}
                    />
                  </div>
                ))}
                {editing && list.length === 0 && (
                  <div className="grid min-h-[80px] place-items-center rounded-2xl border border-dashed border-border text-[12px] text-muted-foreground">
                    <Trans>Drag collections here</Trans>
                  </div>
                )}
              </div>
            </div>
          ))}
          {editing && (
            <div className="flex items-center gap-2">
              {addingGroup ? (
                <Input
                  autoFocus
                  value={newGroupName}
                  onChange={(e) => setNewGroupName(e.target.value)}
                  onBlur={addGroup}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") addGroup();
                    if (e.key === "Escape") { setAddingGroup(false); setNewGroupName(""); }
                  }}
                  placeholder={t`Group name…`}
                  className="h-8 max-w-[220px]"
                />
              ) : (
                <Button variant="outline" size="sm" icon={I.Plus} onClick={() => setAddingGroup(true)}>
                  <Trans>New group</Trans>
                </Button>
              )}
            </div>
          )}
          {!showArchived && !editing && !loading && (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,280px),1fr))] gap-3">
              <Card asChild variant="dashed" interactive className="min-h-[138px] items-center justify-center gap-2 rounded-4xl p-5 text-muted-foreground hover:text-foreground">
                <button onClick={onNew}>
                  <I.Plus size={20} />
                  <span className="text-[13px] font-medium"><Trans>New collection</Trans></span>
                  <span className="text-[11px]"><Trans>Create or adopt a table</Trans></span>
                </button>
              </Card>
            </div>
          )}
        </div>
      ) : (
        <Card className="gap-0 py-0">
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
                    <TableCell className="text-xs text-muted-foreground">{c.group ?? "—"}</TableCell>
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
        </Card>
      )}
    </div>
  );
}

function CollectionCard({ c, onOpen, archived, editing, dropTarget, onRestore, onOpenApi }: { c: CollectionListItem; onOpen: () => void; archived?: boolean; editing?: boolean; dropTarget?: boolean; onRestore?: () => void; onOpenApi?: () => void }) {
  const Ic = (I as Record<string, IconComponent>)[c.icon as IconKey] || I.Database;
  return (
    <Card
      interactive={!editing}
      // Drop-target highlight lives on the Card itself so it follows the
      // card's own rounded-2xl border — a ring on the drag wrapper drew at a
      // mismatched radius and spilled outside the corners.
      className={`h-full gap-3 p-4 transition-colors ${archived ? "opacity-90" : ""} ${editing ? "select-none" : ""} ${dropTarget ? "border-primary ring-2 ring-primary/50" : ""}`}
      onClick={editing ? undefined : onOpen}
    >
      <div className="flex items-center gap-2.5">
        {editing && <I.Grip size={14} className="shrink-0 text-muted-foreground" />}
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
      <div className={`flex gap-1.5 ${editing ? "pointer-events-none opacity-50" : ""}`}>
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
    </Card>
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
  /** Existing group names offered as one-click picks (saved header order). */
  groups?: string[];
}

export function NewCollectionDialog({ open, onClose, onCreate, existingSlugs, groups }: NewCollectionDialogProps) {
  const { t } = useLingui();
  const [step, setStep] = useState(0);
  const [slug, setSlug] = useState("");
  // Null = ungrouped (the default); `customGroup` wins when non-empty so a
  // fresh workspace can name its first group right from the wizard.
  const [group, setGroup] = useState<string | null>(null);
  const [customGroup, setCustomGroup] = useState("");
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
      setGroup(null);
      setCustomGroup("");
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

  // Default status choices when the wizard injects a status field —
  // value/label/color shaped (value/label/color). Keep these aligned with the badge palette in
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
  id          uuid PRIMARY KEY,${tenantScoped ? `\n  tenant_id   text,` : ""}${ownerScoped ? `\n  owner_id    text,` : ""}${timestamps ? `\n  created_at  timestamptz NOT NULL,\n  updated_at  timestamptz NOT NULL,` : ""}${softDelete ? `\n  deleted_at  timestamptz,` : ""}
  -- + your template columns
);${tenantScoped ? `\n\n-- Tenant isolation is enforced in the app layer: every read/write\n-- adds WHERE tenant_id = <active tenant>. (No Postgres RLS.)` : ""}${softDelete ? `\n-- DELETE soft-deletes (sets deleted_at); reads filter deleted_at IS NULL.` : ""}${singleton ? `\n-- Singleton: inserts are rejected once one row exists.` : ""}
-- Postgres types shown; SQLite/D1 uses TEXT + INTEGER equivalents.`;

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
      group: customGroup.trim() || group,
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
      <DialogContent className="grid max-h-[90vh] w-full grid-rows-[auto_1fr_auto] gap-0 overflow-hidden p-0 sm:max-w-[640px]">
        <DialogHeader className="flex-row items-center gap-2.5 border-b border-border px-4 py-3.5 pr-12 text-left">
          <I.Database size={14} />
          <DialogTitle className="text-sm font-medium"><Trans>New collection</Trans></DialogTitle>
          <span className="font-mono text-[11.5px] text-muted-foreground"><Trans>step {step + 1} of 2</Trans></span>
        </DialogHeader>

        <ScrollArea className="min-h-0">
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
                  <Button type="button" size="sm" variant={group === null && !customGroup.trim() ? "outline" : "ghost"} onClick={() => { setGroup(null); setCustomGroup(""); }}>
                    <Trans>No group</Trans>
                  </Button>
                  {(groups ?? []).map((g) => (
                    <Button key={g} type="button" size="sm" variant={group === g && !customGroup.trim() ? "outline" : "ghost"} onClick={() => { setGroup(g); setCustomGroup(""); }}>{g}</Button>
                  ))}
                </div>
                <Input
                  value={customGroup}
                  onChange={(e) => setCustomGroup(e.target.value)}
                  placeholder={t`Or type a new group name…`}
                  className="max-w-[280px]"
                />
                <span className="text-[11.5px] text-muted-foreground"><Trans>Groups organize the Collections page and the sidebar. Rearrange them anytime with Edit layout.</Trans></span>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Start from</Trans></label>
                <div className="grid grid-cols-2 gap-2">
                  {templates.map((t) => {
                    const Ic = (I as Record<string, IconComponent>)[t.icon as IconKey] || I.Braces;
                    const active = template === t.id;
                    return (
                      <Card key={t.id} asChild interactive className={`gap-0 py-0 p-3 text-left ${active ? "border-primary bg-[color-mix(in_oklch,var(--primary)_8%,var(--card))]" : ""}`}>
                        <button type="button" onClick={() => setTemplate(t.id)}>
                          <div className="mb-1 flex items-center gap-2">
                            <Ic size={13} />
                            <span className="text-[13px] font-medium">{t.name}</span>
                            <div className="flex-1" />
                            <span className="tabular-nums text-[11px] text-muted-foreground"><Trans>{t.fields.length} fields</Trans></span>
                          </div>
                          <span className="text-[11.5px] leading-[1.4] text-muted-foreground">{t.desc}</span>
                        </button>
                      </Card>
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
                  <div className="text-[11.5px] text-muted-foreground"><Trans>Auto-add <span className="font-mono">tenant_id</span>; data is isolated per workspace at the app layer — every read/write gets <span className="font-mono">tenant_id = $user.tenant_id</span> injected.</Trans></div>
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
  if (!open) return null;
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="flex max-h-[90vh] w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-[560px]">
        <DialogHeader className="flex-row items-center gap-2.5 border-b border-border px-4 py-3.5 pr-12 text-left">
          <I.Plus size={14} />
          <DialogTitle className="text-sm font-medium"><Trans>New collection</Trans></DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3 p-[22px]">
          <Card asChild interactive className="gap-2.5 py-0 p-[18px] text-left">
            <button
              type="button"
              onClick={onPickEmpty}
            >
              <span className="grid size-9 place-items-center rounded-lg border border-border bg-muted"><I.Braces size={16} /></span>
              <div className="flex flex-col gap-1">
                <span className="text-[13.5px] font-semibold"><Trans>Empty or template</Trans></span>
                <span className="text-xs leading-[1.45] text-muted-foreground">
                  <Trans>Create a new physical table from scratch. Pick a preset (Content / Taxonomy / People / Blank) and configure scope toggles.</Trans>
                </span>
              </div>
            </button>
          </Card>
          <Card asChild interactive className="gap-2.5 py-0 p-[18px] text-left">
            <button
              type="button"
              onClick={onPickAdopt}
            >
              <span className="grid size-9 place-items-center rounded-lg border border-border bg-muted"><I.Database size={16} /></span>
              <div className="flex flex-col gap-1">
                <span className="text-[13.5px] font-semibold"><Trans>From existing table</Trans></span>
                <span className="text-xs leading-[1.45] text-muted-foreground">
                  <Trans>Register a table that already exists in your database. No DDL is run on the table — backlex only writes its own metadata.</Trans>
                </span>
              </div>
            </button>
          </Card>
        </div>
        <div className="flex items-center gap-2 border-t border-border px-4 py-3.5">
          <div className="flex-1" />
          <Button variant="ghost" size="sm" onClick={onClose}><Trans>Cancel</Trans></Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
