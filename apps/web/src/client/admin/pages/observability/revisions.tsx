import type { PushToast } from "../../types";
import { useEffect, useMemo, useRef, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { I } from "../../icons";
import { Badge, Button, EmptyState, PageHeader } from "../../ui";
import { ConfirmDialog } from "../../sheet";
import { Select } from "../../select";
import { orderCollections, useCollections } from "../../queries";
import type { ApiCollection } from "../../api";
import { rowLabel } from "../../lib/row-label";
import { Card } from "@backlex/ui/components/card";
import { Input } from "@backlex/ui/components/input";
import { ScrollArea } from "@backlex/ui/components/scroll-area";
import { Skeleton } from "@backlex/ui/components/skeleton";
import { RevisionsSkeleton } from "../../page-skeletons";

const REV_AUTO_FIELDS = new Set([
  "id",
  "created_at",
  "createdAt",
  "updated_at",
  "updatedAt",
  "owner_id",
  "ownerId",
]);

const stableStringify = (v: unknown): string => {
  try {
    return JSON.stringify(v) ?? "undefined";
  } catch {
    return String(v);
  }
};

const fmtRevValue = (v: unknown): string => {
  if (v === undefined) return "—";
  if (v === null) return "null";
  if (typeof v === "string") return v === "" ? '""' : v;
  if (typeof v === "object") {
    try {
      return JSON.stringify(v, null, 2);
    } catch {
      return String(v);
    }
  }
  return String(v);
};

const fmtRevTs = (v: string | number): string => {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString().slice(0, 16).replace("T", " ");
};

/** How a list of one collection's rows is ordered here: most recently written
 *  first, by whichever timestamp the table actually has. */
const recentFirst = (c: ApiCollection): string | null =>
  c.hasUpdatedAt !== false ? "-updated_at" : c.hasCreatedAt !== false ? "-created_at" : null;

export function RevisionsPage({
  pushToast,
  target,
  onTarget,
}: {
  pushToast?: PushToast;
  /** `/revisions/:collection/:itemId`, when the page is routed. */
  target?: { collection: string | null; itemId: string | null };
  onTarget?: (collection: string | null, itemId: string | null, opts?: { replace?: boolean }) => void;
} = {}) {
  const toast = pushToast ?? (() => {});
  const { t } = useLingui();

  // Revisions are scoped to a (collection, itemId) pair, so we need both to
  // query the API. This page used to take the first collection on mount and
  // offer no way to pick another, so every other collection's history was out
  // of reach from here.
  const collectionsQuery = useCollections();
  const collections = useMemo(
    () =>
      orderCollections(
        (collectionsQuery.data?.data ?? []).filter((c) => (c.status ?? "active") !== "archived"),
        collectionsQuery.data?.meta?.groups ?? [],
      ).flatMap(([group, list]) => list.map((c) => ({ c, group }))),
    [collectionsQuery.data],
  );

  // The selection lives in the URL when the page is routed, so a history can
  // be linked and survives a refresh; standalone it is local state.
  const [local, setLocal] = useState<{ collection: string; itemId: string }>({ collection: "", itemId: "" });
  const requestedCollection = onTarget ? (target?.collection ?? "") : local.collection;
  const activeId = onTarget ? (target?.itemId ?? "") : local.itemId;
  const select = (collection: string, itemId: string, opts?: { replace?: boolean }) => {
    if (onTarget) onTarget(collection || null, itemId || null, opts);
    else setLocal({ collection, itemId });
  };
  // A slug the list does not hold (dropped, not readable, a stale link) falls
  // back to the first collection rather than an empty page.
  const collection =
    collections.find((x) => x.c.slug === requestedCollection)?.c ?? collections[0]?.c ?? null;
  const collectionSlug = collection?.slug ?? "";
  useEffect(() => {
    if (collectionSlug && requestedCollection !== collectionSlug) select(collectionSlug, "", { replace: true });
  }, [collectionSlug, requestedCollection]);

  type RowItem = { id: string; title: string };
  // Rows carry the collection they were read from, so nothing downstream can
  // pair one collection's row id with another collection's slug mid-switch.
  const [loaded, setLoaded] = useState<{ slug: string; rows: RowItem[] } | null>(null);
  const [itemsLoading, setItemsLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [needle, setNeedle] = useState("");
  useEffect(() => {
    const handle = setTimeout(() => setNeedle(search.trim()), 250);
    return () => clearTimeout(handle);
  }, [search]);
  const items = loaded && loaded.slug === collectionSlug ? loaded.rows : [];
  const item = items.find((x) => x.id === activeId);

  // A later request supersedes an earlier one: typing a search fires several,
  // and they need not answer in order.
  const itemsRequest = useRef(0);
  const loadItems = async (c: ApiCollection, q: string) => {
    const request = ++itemsRequest.current;
    setItemsLoading(true);
    try {
      const params = new URLSearchParams({ limit: "50" });
      const sort = recentFirst(c);
      if (sort) params.set("sort", sort);
      if (q) params.set("q", q);
      const ir = await fetch(`/api/items/${encodeURIComponent(c.slug)}?${params}`, { credentials: "include" });
      const ij = ir.ok ? ((await ir.json()) as { data?: Record<string, unknown>[] }) : { data: [] };
      if (request !== itemsRequest.current) return;
      setLoaded({
        slug: c.slug,
        rows: (ij.data ?? []).map((r) => ({
          id: String(r.id),
          title: rowLabel(r, { displayTemplate: c.displayTemplate, fields: c.fields }),
        })),
      });
    } catch {
      if (request === itemsRequest.current) setLoaded({ slug: c.slug, rows: [] });
    } finally {
      if (request === itemsRequest.current) setItemsLoading(false);
    }
  };

  useEffect(() => {
    if (collection) void loadItems(collection, needle);
    else if (collectionsQuery.isFetched) setItemsLoading(false);
  }, [collectionSlug, needle, collectionsQuery.isFetched]);

  // Nothing selected yet: open the most recently written row. A selected item
  // stays selected when a search leaves it out of the list.
  useEffect(() => {
    if (!itemsLoading && !activeId && items[0]) select(collectionSlug, items[0].id, { replace: true });
  }, [itemsLoading, activeId, collectionSlug, items]);

  const pickCollection = (slug: string) => {
    if (slug === collectionSlug) return;
    setSearch("");
    setNeedle("");
    select(slug, "");
  };

  type RawRev = { id: string; createdAt: string | number; createdBy: string | null; snapshot: Record<string, unknown> };
  // Each recorded revision is a *pre-image*: the row state captured right
  // before a write. The live row is the only "current" state — so the
  // timeline is [live] + [revisions, newest-first].
  type Entry =
    | { kind: "live"; snapshot: Record<string, unknown> }
    | { kind: "rev"; id: string; v: number; createdAt: string | number; createdBy: string | null; snapshot: Record<string, unknown> };
  const [revs, setRevs] = useState<RawRev[]>([]);
  const [live, setLive] = useState<Record<string, unknown> | null>(null);
  const [revsLoading, setRevsLoading] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const [showFull, setShowFull] = useState(false);
  const [confirmRev, setConfirmRev] = useState<{ id: string; v: number; createdAt: string | number } | null>(null);
  const [reverting, setReverting] = useState(false);

  const timelineRequest = useRef(0);
  const loadTimeline = async (slug: string, id: string) => {
    const request = ++timelineRequest.current;
    if (!slug || !id) { setRevs([]); setLive(null); setActiveIdx(0); setRevsLoading(false); return; }
    setRevsLoading(true);
    try {
      const [rr, ir] = await Promise.all([
        fetch(`/api/revisions/${encodeURIComponent(slug)}/${encodeURIComponent(id)}`, { credentials: "include" }),
        fetch(`/api/items/${encodeURIComponent(slug)}/${encodeURIComponent(id)}`, { credentials: "include" }),
      ]);
      const rj = rr.ok ? ((await rr.json()) as { data?: RawRev[] }) : { data: [] };
      const ij = ir.ok ? ((await ir.json()) as { data?: Record<string, unknown> }) : { data: null };
      if (request !== timelineRequest.current) return;
      setRevs(Array.isArray(rj.data) ? rj.data : []);
      setLive(ij.data ?? null);
      setActiveIdx(0);
    } catch {
      if (request !== timelineRequest.current) return;
      setRevs([]);
      setLive(null);
    } finally {
      if (request === timelineRequest.current) setRevsLoading(false);
    }
  };

  useEffect(() => {
    void loadTimeline(collectionSlug, activeId);
    setShowFull(false);
  }, [collectionSlug, activeId]);

  const entries = useMemo<Entry[]>(() => {
    const out: Entry[] = [];
    if (live) out.push({ kind: "live", snapshot: live });
    const n = revs.length;
    revs.forEach((r, i) => {
      out.push({ kind: "rev", id: r.id, v: n - i, createdAt: r.createdAt, createdBy: r.createdBy, snapshot: r.snapshot ?? {} });
    });
    return out;
  }, [live, revs]);

  const active = entries[activeIdx] ?? null;
  // The "before" side of the diff is the next-older state in the timeline.
  const prev = active ? entries[activeIdx + 1] ?? null : null;
  const hasPrev = !!prev;

  const diff = useMemo(() => {
    if (!active) return [] as { field: string; before: unknown; after: unknown; changed: boolean }[];
    const cur = active.snapshot ?? {};
    const before = prev?.snapshot ?? null;
    const keys = Array.from(new Set([...Object.keys(cur), ...(before ? Object.keys(before) : [])]));
    return keys.map((k) => {
      const a = before ? before[k] : undefined;
      const b = cur[k];
      return { field: k, before: a, after: b, changed: stableStringify(a) !== stableStringify(b) };
    });
  }, [active, prev]);

  const changedDiff = diff.filter((d) => d.changed);
  // In "full" mode show every field; otherwise only what changed. The very
  // first entry has nothing to diff against — show all of it.
  const visibleDiff = showFull || !hasPrev ? diff : changedDiff;

  const doRevert = async (rev: { id: string }) => {
    setReverting(true);
    try {
      const r = await fetch(`/api/revisions/${encodeURIComponent(rev.id)}/revert`, {
        method: "POST",
        credentials: "include",
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(body?.error?.message ?? `Revert failed (${r.status})`);
      }
      setConfirmRev(null);
      toast(t`Reverted — a new revision was recorded.`);
      if (collection) await loadItems(collection, needle);
      await loadTimeline(collectionSlug, activeId);
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setReverting(false);
    }
  };

  const titleFor = (e: Entry) => (e.kind === "live" ? t`Current` : t`Revision v${e.v}`);
  const subtitleFor = (e: Entry) =>
    e.kind === "live"
      ? t`live · updated ${fmtRevTs(String(e.snapshot.updatedAt ?? e.snapshot.updated_at ?? ""))}`
      : `${fmtRevTs(e.createdAt)} · ${e.createdBy ?? "system"}`;

  // First whole-page fetch — collections + their first items haven't landed
  // yet. Later loads (another collection, a search) keep the page and show
  // skeleton rows inside the list instead.
  if (collectionsQuery.isPending || (collections.length > 0 && loaded === null)) return <RevisionsSkeleton />;

  // The header's item name: from the list, else from the live row a deep link
  // or a search left out of it.
  const activeTitle =
    item?.title ?? (live && collection ? rowLabel(live, { displayTemplate: collection.displayTemplate, fields: collection.fields }) : null);

  return (
    <div className="flex flex-col gap-4.5">
      <PageHeader title={t`Revisions`} description={t`Every write is versioned. Inspect, diff, or revert any prior state.`} />
      <div className="flex flex-wrap items-center gap-2">
        <div className="w-full min-w-0 sm:w-64">
          <Select
            value={collectionSlug}
            onChange={pickCollection}
            options={collections.map(({ c, group }) => ({ value: c.slug, label: c.slug, hint: group ?? undefined }))}
            placeholder={collections.length === 0 ? t`No collections yet` : t`Pick a collection`}
            disabled={collections.length === 0}
          />
        </div>
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t`Search items`}
          aria-label={t`Search items`}
          disabled={!collection}
          className="h-9 w-full min-w-0 sm:w-64"
        />
      </div>
      <div className="grid grid-cols-[280px_220px_minmax(0,1fr)] items-start gap-3.5 max-[1024px]:grid-cols-[minmax(0,1fr)]">
        <Card className="py-0 gap-0">
          <div className="truncate border-b border-border px-4 py-3.5 text-xs font-medium">
            <Trans>Items</Trans>{collectionSlug && <span className="font-mono text-[11px] text-muted-foreground"> · {collectionSlug}</span>}
          </div>
          <ScrollArea className="h-[60vh]">
            {itemsLoading && (
              <div className="flex flex-col gap-2 px-3 py-3">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="flex flex-col gap-1.5">
                    <Skeleton className="h-3.5 w-3/4" />
                    <Skeleton className="h-3 w-1/3" />
                  </div>
                ))}
              </div>
            )}
            {!itemsLoading && items.length === 0 && (
              <EmptyState
                size="sm"
                title={
                  !collection ? <Trans>No collections to show history for.</Trans>
                  : needle ? <Trans>No items match your search.</Trans>
                  : <Trans>No items in this collection yet.</Trans>
                }
              />
            )}
            {!itemsLoading && items.map((it) => (
              <div
                key={it.id}
                onClick={() => select(collectionSlug, it.id)}
                className={`cursor-pointer border-t border-border px-3 py-2 ${activeId === it.id ? "bg-accent" : ""}`}
              >
                <div className="truncate text-[12.5px] font-medium">{it.title}</div>
                <div className="truncate font-mono text-[10.5px] text-muted-foreground">{it.id}</div>
              </div>
            ))}
          </ScrollArea>
        </Card>
        <Card className="py-0 gap-0">
          <div className="truncate border-b border-border px-4 py-3.5 text-xs font-medium"><Trans>Timeline</Trans> · {activeTitle ?? "—"}</div>
          <ScrollArea className="h-[60vh]">
            {revsLoading && (
              <div className="flex flex-col gap-2 px-3 py-3">
                {Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="flex flex-col gap-1.5">
                    <Skeleton className="h-3.5 w-1/2" />
                    <Skeleton className="h-3 w-2/3" />
                  </div>
                ))}
              </div>
            )}
            {!revsLoading && entries.length === 0 && (
              <EmptyState size="sm" title={activeId ? <Trans>No revisions yet for this item.</Trans> : <Trans>Select an item to see its history.</Trans>} />
            )}
            {!revsLoading && entries.length === 1 && entries[0]?.kind === "live" && (
              <div className="border-t border-border px-3 py-2.5 text-[11.5px] text-muted-foreground"><Trans>Only the current state exists — no edits recorded yet.</Trans></div>
            )}
            {entries.map((e, i) => {
              const sel = activeIdx === i;
              return (
                <div
                  key={e.kind === "live" ? "__live" : e.id}
                  onClick={() => setActiveIdx(i)}
                  className={`flex cursor-pointer flex-col gap-0.5 border-t border-border px-3 py-2 ${sel ? "bg-accent" : ""}`}
                >
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-xs font-medium">{e.kind === "live" ? t`live` : `v${e.v}`}</span>
                    <Badge variant={e.kind === "live" ? "default" : "secondary"}>{e.kind === "live" ? <Trans>current</Trans> : i === entries.length - 1 ? <Trans>initial</Trans> : <Trans>edit</Trans>}</Badge>
                  </div>
                  <div className="font-mono text-[10.5px] text-muted-foreground">{subtitleFor(e)}</div>
                </div>
              );
            })}
          </ScrollArea>
        </Card>
        {/* Fixed to the height of the two list cards beside it (their 45px
            header + a 60vh scroll area + borders), with the fields scrolling
            inside. Left to grow, one card per field ran a twelve-field row to
            twice the height of everything next to it. */}
        <Card className="min-w-0 gap-3.5 p-[18px] min-[1025px]:h-[calc(60vh+47px)]">
          {!active ? (
            revsLoading ? (
              <div className="flex flex-col gap-3">
                <Skeleton className="h-5 w-40" />
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-16 w-full rounded-control" />
                ))}
              </div>
            ) : (
              <EmptyState
                bare
                icon={I.History}
                title={<Trans>No revision selected</Trans>}
                description={<Trans>Pick a revision from the timeline to inspect, diff, or revert.</Trans>}
              />
            )
          ) : (
          <>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold">{titleFor(active)}</span>
            <Badge variant={active.kind === "live" ? "default" : "secondary"}>{active.kind === "live" ? <Trans>current</Trans> : !hasPrev ? <Trans>initial</Trans> : <Trans>edit</Trans>}</Badge>
            <span className="font-mono text-xs text-muted-foreground">{subtitleFor(active)}</span>
            <div className="flex-1" />
            {hasPrev && (
              <Button size="sm" variant="outline" icon={I.Eye} onClick={() => setShowFull((s) => !s)}>
                {showFull ? <Trans>Changes only</Trans> : <Trans>View full</Trans>}
              </Button>
            )}
            <Button
              size="sm"
              variant="primary"
              icon={I.History}
              disabled={active.kind === "live" || reverting}
              title={active.kind === "live" ? t`This is already the current state` : t`Restore this snapshot`}
              onClick={() => active.kind === "rev" && setConfirmRev({ id: active.id, v: active.v, createdAt: active.createdAt })}
            >
              {reverting ? <Trans>Reverting…</Trans> : active.kind === "live" ? <Trans>Current state</Trans> : <Trans>Revert to this</Trans>}
            </Button>
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-2">
            {!hasPrev && (
              <div className="text-xs text-muted-foreground">
                {active.kind === "live"
                  ? <Trans>No earlier revisions — showing the current field values.</Trans>
                  : <Trans>Initial revision — the first recorded state of this item.</Trans>}
              </div>
            )}
            {hasPrev && (
              <div className="text-[11.5px] text-muted-foreground">
                {showFull ? <Trans>Showing all fields</Trans> : <Trans>Showing {changedDiff.length} changed field{changedDiff.length === 1 ? "" : "s"}</Trans>} · before = {titleFor(prev)}
              </div>
            )}
            {hasPrev && !showFull && changedDiff.length === 0 && (
              <div className="text-xs text-muted-foreground"><Trans>No field changes from {titleFor(prev)}.</Trans></div>
            )}
            {visibleDiff.length > 0 && (
              // One row per field — name, then the value (or before and after)
              // side by side — instead of a bordered card holding a bordered
              // box per field, which spent ~150px saying `id: …`.
              <ScrollArea
                type="auto"
                className="min-h-0 flex-1 rounded-control border border-border"
                viewportClassName="max-[1024px]:max-h-[60vh]"
              >
                <div className="flex flex-col">
                  {hasPrev && (
                    <div className="grid grid-cols-[minmax(0,170px)_minmax(0,1fr)_minmax(0,1fr)] gap-3 border-b border-border bg-muted/50 px-3 py-1.5 text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground max-[640px]:hidden">
                      <span><Trans>field</Trans></span>
                      <span><Trans>before</Trans></span>
                      <span><Trans>after</Trans></span>
                    </div>
                  )}
                  {visibleDiff.map((d) => {
                    const isAuto = REV_AUTO_FIELDS.has(d.field);
                    return (
                      <div
                        key={d.field}
                        className={`grid items-start gap-x-3 gap-y-1.5 border-b border-border px-3 py-2 last:border-b-0 max-[640px]:grid-cols-1 ${
                          hasPrev ? "grid-cols-[minmax(0,170px)_minmax(0,1fr)_minmax(0,1fr)]" : "grid-cols-[minmax(0,170px)_minmax(0,1fr)]"
                        } ${d.changed || showFull ? "" : "opacity-70"}`}
                      >
                        <div className="flex min-w-0 flex-wrap items-center gap-1.5 pt-1">
                          <span className="min-w-0 truncate font-mono text-xs font-medium" title={d.field}>{d.field}</span>
                          {isAuto && <Badge variant="outline"><Trans>system</Trans></Badge>}
                          {!d.changed && <Badge variant="secondary"><Trans>unchanged</Trans></Badge>}
                        </div>
                        {hasPrev && (
                          <div className={`min-w-0 whitespace-pre-wrap rounded-control border px-2 py-1 font-mono text-[11.5px] [word-break:break-word] ${d.changed ? "border-[color-mix(in_oklch,var(--destructive)_30%,var(--border))] bg-[color-mix(in_oklch,var(--destructive)_8%,var(--card))]" : "border-transparent"}`}>
                            <div className="mb-0.5 text-[10px] text-muted-foreground min-[641px]:hidden"><Trans>before</Trans></div>{fmtRevValue(d.before)}
                          </div>
                        )}
                        <div className={`min-w-0 whitespace-pre-wrap rounded-control border px-2 py-1 font-mono text-[11.5px] [word-break:break-word] ${d.changed && hasPrev ? "border-[color-mix(in_oklch,oklch(0.7_0.18_145)_40%,var(--border))] bg-[color-mix(in_oklch,oklch(0.7_0.18_145)_12%,var(--card))]" : "border-transparent"}`}>
                          {hasPrev && <div className="mb-0.5 text-[10px] text-muted-foreground min-[641px]:hidden"><Trans>after</Trans></div>}
                          {fmtRevValue(d.after)}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </ScrollArea>
            )}
          </div>
          </>
          )}
        </Card>
      </div>
      <ConfirmDialog
        open={!!confirmRev}
        title={confirmRev ? t`Revert to revision v${confirmRev.v}?` : t`Revert?`}
        description={
          confirmRev
            ? t`This rewrites the item to the v${confirmRev.v} snapshot from ${fmtRevTs(confirmRev.createdAt)}. The current state is preserved as a new revision, so this is undoable.`
            : ""
        }
        actionLabel={reverting ? t`Reverting…` : t`Revert`}
        onConfirm={() => confirmRev && void doRevert(confirmRev)}
        onCancel={() => { if (!reverting) setConfirmRev(null); }}
      />
    </div>
  );
}
