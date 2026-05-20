// @ts-nocheck
import { useEffect, useMemo, useState } from "react";
import { I } from "../icons";
import { Badge, Button, PageHeader } from "../ui";
import { ConfirmDialog } from "../sheet";
import { ScrollArea } from "@workeros/ui/components/scroll-area";

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

export function RevisionsPage({ pushToast }: { pushToast?: (m: string, t?: "success" | "error") => void } = {}) {
  const toast = pushToast ?? (() => {});

  // Revisions are scoped to a (collection, itemId) pair, so we need both to
  // query the API. Pick the first existing collection on mount, then its items.
  type RowItem = { id: string; title: string };
  const [items, setItems] = useState<RowItem[]>([]);
  const [collectionSlug, setCollectionSlug] = useState<string>("posts");
  const [activeId, setActiveId] = useState<string>("");
  const [itemsLoading, setItemsLoading] = useState(true);
  const item = items.find((x) => x.id === activeId);

  const loadItems = async (slug: string) => {
    setItemsLoading(true);
    try {
      const ir = await fetch(`/api/items/${encodeURIComponent(slug)}?limit=20&sort=-updated_at`, { credentials: "include" });
      if (!ir.ok) { setItems([]); return; }
      const ij = (await ir.json()) as { data?: any[] };
      const rows = (ij.data ?? []).map((r) => ({
        id: r.id,
        title: String(r.title ?? r.name ?? r.slug ?? r.id ?? "").slice(0, 48) || r.id,
      }));
      setItems(rows);
      setActiveId((cur) => (cur && rows.some((r) => r.id === cur) ? cur : rows[0]?.id ?? ""));
    } catch {
      setItems([]);
    } finally {
      setItemsLoading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const cr = await fetch("/api/collections", { credentials: "include" });
        if (!cr.ok || cancelled) { setItemsLoading(false); return; }
        const cj = (await cr.json()) as { data?: { slug: string }[] };
        const slug = cj.data?.[0]?.slug ?? "posts";
        if (cancelled) return;
        setCollectionSlug(slug);
        await loadItems(slug);
      } catch {
        if (!cancelled) setItemsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

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

  const loadTimeline = async (slug: string, id: string) => {
    if (!id) { setRevs([]); setLive(null); setActiveIdx(0); return; }
    setRevsLoading(true);
    try {
      const [rr, ir] = await Promise.all([
        fetch(`/api/revisions/${encodeURIComponent(slug)}/${encodeURIComponent(id)}`, { credentials: "include" }),
        fetch(`/api/items/${encodeURIComponent(slug)}/${encodeURIComponent(id)}`, { credentials: "include" }),
      ]);
      const rj = rr.ok ? ((await rr.json()) as { data?: RawRev[] }) : { data: [] };
      const ij = ir.ok ? ((await ir.json()) as { data?: Record<string, unknown> }) : { data: null };
      setRevs(Array.isArray(rj.data) ? rj.data : []);
      setLive(ij.data ?? null);
      setActiveIdx(0);
    } catch {
      setRevs([]);
      setLive(null);
    } finally {
      setRevsLoading(false);
    }
  };

  useEffect(() => {
    void loadTimeline(collectionSlug, activeId);
    setShowFull(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        const body = await r.json().catch(() => null);
        throw new Error(body?.error?.message ?? `Revert failed (${r.status})`);
      }
      setConfirmRev(null);
      toast("Reverted — a new revision was recorded.");
      await loadItems(collectionSlug);
      await loadTimeline(collectionSlug, activeId);
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setReverting(false);
    }
  };

  const titleFor = (e: Entry) => (e.kind === "live" ? "Current" : `Revision v${e.v}`);
  const subtitleFor = (e: Entry) =>
    e.kind === "live"
      ? `live · updated ${fmtRevTs(String(e.snapshot.updatedAt ?? e.snapshot.updated_at ?? ""))}`
      : `${fmtRevTs(e.createdAt)} · ${e.createdBy ?? "system"}`;

  return (
    <div className="flex flex-col gap-4.5">
      <PageHeader title="Revisions" description="Every write is versioned. Inspect, diff, or revert any prior state." />
      <div className="grid grid-cols-[280px_220px_minmax(0,1fr)] items-start gap-3.5 max-[1024px]:grid-cols-[minmax(0,1fr)]">
        <div className="overflow-hidden rounded-2xl border border-border bg-card text-card-foreground">
          <div className="border-b border-border px-4 py-3.5 text-xs font-medium">Items <span className="font-mono text-[11px] text-muted-foreground">· c_{collectionSlug}</span></div>
          <ScrollArea className="h-[60vh]">
            {itemsLoading && (
              <div className="px-3 py-4 text-xs text-muted-foreground">Loading…</div>
            )}
            {!itemsLoading && items.length === 0 && (
              <div className="px-3 py-4 text-xs text-muted-foreground">No items in this collection yet.</div>
            )}
            {items.map((it) => (
              <div
                key={it.id}
                onClick={() => setActiveId(it.id)}
                className={`cursor-pointer border-t border-border px-3 py-2 ${activeId === it.id ? "bg-accent" : ""}`}
              >
                <div className="truncate text-[12.5px] font-medium">{it.title}</div>
                <div className="font-mono text-[10.5px] text-muted-foreground">{it.id.slice(0, 14)}…</div>
              </div>
            ))}
          </ScrollArea>
        </div>
        <div className="overflow-hidden rounded-2xl border border-border bg-card text-card-foreground">
          <div className="border-b border-border px-4 py-3.5 text-xs font-medium">Timeline · {item?.title?.slice(0, 18) ?? "—"}{item ? "…" : ""}</div>
          <ScrollArea className="h-[60vh]">
            {revsLoading && (
              <div className="px-3 py-4 text-xs text-muted-foreground">Loading…</div>
            )}
            {!revsLoading && entries.length === 0 && (
              <div className="px-3 py-4 text-xs text-muted-foreground">{activeId ? "No revisions yet for this item." : "Select an item to see its history."}</div>
            )}
            {!revsLoading && entries.length === 1 && entries[0].kind === "live" && (
              <div className="border-t border-border px-3 py-2.5 text-[11.5px] text-muted-foreground">Only the current state exists — no edits recorded yet.</div>
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
                    <span className="font-mono text-xs font-medium">{e.kind === "live" ? "live" : `v${e.v}`}</span>
                    <Badge variant={e.kind === "live" ? "default" : "secondary"}>{e.kind === "live" ? "current" : i === entries.length - 1 ? "initial" : "edit"}</Badge>
                  </div>
                  <div className="font-mono text-[10.5px] text-muted-foreground">{subtitleFor(e)}</div>
                </div>
              );
            })}
          </ScrollArea>
        </div>
        <div className="flex flex-col gap-3.5 overflow-hidden rounded-2xl border border-border bg-card p-[18px] text-card-foreground">
          {!active ? (
            <div className="p-9 text-center text-[13px] text-muted-foreground">
              {revsLoading ? "Loading…" : "Pick a revision from the timeline to inspect, diff, or revert."}
            </div>
          ) : (
          <>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold">{titleFor(active)}</span>
            <Badge variant={active.kind === "live" ? "default" : "secondary"}>{active.kind === "live" ? "current" : !hasPrev ? "initial" : "edit"}</Badge>
            <span className="font-mono text-xs text-muted-foreground">{subtitleFor(active)}</span>
            <div className="flex-1" />
            {hasPrev && (
              <Button size="sm" variant="outline" icon={I.Eye} onClick={() => setShowFull((s) => !s)}>
                {showFull ? "Changes only" : "View full"}
              </Button>
            )}
            <Button
              size="sm"
              variant="primary"
              icon={I.History}
              disabled={active.kind === "live" || reverting}
              title={active.kind === "live" ? "This is already the current state" : "Restore this snapshot"}
              onClick={() => active.kind === "rev" && setConfirmRev({ id: active.id, v: active.v, createdAt: active.createdAt })}
            >
              {reverting ? "Reverting…" : active.kind === "live" ? "Current state" : "Revert to this"}
            </Button>
          </div>
          <div className="flex flex-col gap-2">
            {!hasPrev && (
              <div className="text-xs text-muted-foreground">
                {active.kind === "live"
                  ? "No earlier revisions — showing the current field values."
                  : "Initial revision — the first recorded state of this item."}
              </div>
            )}
            {hasPrev && (
              <div className="text-[11.5px] text-muted-foreground">
                {showFull ? "Showing all fields" : `Showing ${changedDiff.length} changed field${changedDiff.length === 1 ? "" : "s"}`} · before = {titleFor(prev)}
              </div>
            )}
            {hasPrev && !showFull && changedDiff.length === 0 && (
              <div className="text-xs text-muted-foreground">No field changes from {titleFor(prev)}.</div>
            )}
            {visibleDiff.map((d) => {
              const isAuto = REV_AUTO_FIELDS.has(d.field);
              return (
                <div
                  key={d.field}
                  className={`flex flex-col gap-2 overflow-hidden rounded-xl border border-border bg-card p-3 ${d.changed || showFull ? "" : "opacity-70"}`}
                >
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-xs font-medium">{d.field}</span>
                    {isAuto && <Badge variant="outline">system</Badge>}
                    {!d.changed && <Badge variant="secondary">unchanged</Badge>}
                  </div>
                  <div className={`grid gap-2 ${hasPrev ? "grid-cols-2" : "grid-cols-1"}`}>
                    {hasPrev && (
                      <div className={`whitespace-pre-wrap rounded-md border p-2 font-mono text-[11.5px] [word-break:break-word] ${d.changed ? "border-[color-mix(in_oklch,var(--destructive)_30%,var(--border))] bg-[color-mix(in_oklch,var(--destructive)_8%,var(--card))]" : "border-border bg-card"}`}>
                        <div className="mb-1 text-[10px] text-muted-foreground">before</div>{fmtRevValue(d.before)}
                      </div>
                    )}
                    <div className={`whitespace-pre-wrap rounded-md border p-2 font-mono text-[11.5px] [word-break:break-word] ${d.changed && hasPrev ? "border-[color-mix(in_oklch,oklch(0.7_0.18_145)_40%,var(--border))] bg-[color-mix(in_oklch,oklch(0.7_0.18_145)_12%,var(--card))]" : "border-border bg-card"}`}>
                      <div className="mb-1 text-[10px] text-muted-foreground">{hasPrev ? "after" : "value"}</div>{fmtRevValue(d.after)}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          </>
          )}
        </div>
      </div>
      <ConfirmDialog
        open={!!confirmRev}
        title={confirmRev ? `Revert to revision v${confirmRev.v}?` : "Revert?"}
        description={
          confirmRev
            ? `This rewrites the item to the v${confirmRev.v} snapshot from ${fmtRevTs(confirmRev.createdAt)}. The current state is preserved as a new revision, so this is undoable.`
            : ""
        }
        actionLabel={reverting ? "Reverting…" : "Revert"}
        onConfirm={() => confirmRev && void doRevert(confirmRev)}
        onCancel={() => { if (!reverting) setConfirmRev(null); }}
      />
    </div>
  );
}
