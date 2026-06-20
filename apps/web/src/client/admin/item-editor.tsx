// Full-page collection item editor.
//
// The deep-linkable replacement for the edit modal: `/collections/:slug/items/:id`
// (and `/new`). Fields render in the main column (shared `ItemFields`); the
// right rail carries status/publish, system fields, collaboration, revision
// history, and record actions. Supports prev/next record navigation, an
// unsaved-changes guard, optional autosave for drafts, and best-effort presence.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { I } from "./icons";
import { type CollectionSchema, type Post } from "./config";
import { Badge, Button, IconButton, Switch, relativeTime } from "./ui";
import { authorById } from "./items";
import { Card } from "@backlex/ui/components/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@backlex/ui/components/dropdown-menu";
import { cn } from "@backlex/ui/lib/utils";
import { itemsApi, revisionsApi, type ApiRevision } from "./api";
import { ItemCommentsPanel } from "./item-collaboration";
import { ConfirmDialog } from "./sheet";
import { ItemFields, useItemForm } from "./item-form";

export interface ItemEditorPageProps {
  slug: string;
  /** `"new"` for the create flow, otherwise the row id. */
  itemId: string;
  schema: CollectionSchema;
  /** Fast-path row from the in-memory list; the page still refetches by id so
   *  direct links / refreshes work. */
  initialItem?: Post | null;
  /** Ordered ids of the current filtered list — drives prev/next. */
  siblingIds?: string[];
  versioned?: boolean;
  canPublish?: boolean;
  pushToast: (m: string, type?: "success" | "error") => void;
  onSaved: (item: Post) => void;
  onCreated: (item: Post) => void;
  onDeleted: (id: string) => void;
  onBack: () => void;
  navigateToItem: (id: string) => void;
}

const SECTION_TITLE_CLS =
  "flex items-center gap-2 border-b border-border px-4 py-3 text-[12.5px] font-medium";

export function ItemEditorPage({
  slug,
  itemId,
  schema,
  initialItem = null,
  siblingIds = [],
  versioned,
  canPublish,
  pushToast,
  onSaved,
  onCreated,
  onDeleted,
  onBack,
  navigateToItem,
}: ItemEditorPageProps) {
  const { t } = useLingui();
  const mode: "create" | "edit" = itemId === "new" ? "create" : "edit";

  const [item, setItem] = useState<Post | null>(mode === "edit" ? initialItem : null);
  const [loading, setLoading] = useState(mode === "edit" && !initialItem);
  const [saving, setSaving] = useState(false);
  const [autosave, setAutosave] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  // Bumped after any write (save / publish) so the revision history reloads
  // without a manual page refresh.
  const [revisionsKey, setRevisionsKey] = useState(0);
  const [scheduleAt, setScheduleAt] = useState("");
  // Pending guarded navigation — populated when the user tries to leave with
  // unsaved changes; the ConfirmDialog runs it on confirm.
  const [pendingNav, setPendingNav] = useState<(() => void) | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const form = useItemForm({ schema, initial: item, active: mode === "create" || !loading });
  const dirty = form.dirty;

  // Open each record (and prev/next) at the top — the list scroll position
  // shouldn't carry into the detail page.
  useEffect(() => {
    const scroller = document.querySelector(".scrollarea");
    if (scroller) scroller.scrollTop = 0;
    window.scrollTo?.(0, 0);
  }, [itemId]);

  // Refetch the row by id so the editor is correct on a hard refresh / deep
  // link, not only when reached via the in-memory list.
  useEffect(() => {
    if (mode !== "edit") {
      setItem(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(!initialItem);
    void (async () => {
      try {
        const res = await itemsApi.get(slug, itemId);
        if (!cancelled && res.data) setItem(res.data as unknown as Post);
      } catch {
        // keep the fast-path row if the fetch fails
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, itemId, mode]);

  // ── Save ────────────────────────────────────────────────────────────────
  const persist = useCallback(
    async (opts?: { close?: boolean; silent?: boolean }) => {
      if (saving) return false;
      if (!form.validate()) {
        if (!opts?.silent) pushToast(t`Fix the highlighted fields before saving.`, "error");
        return false;
      }
      const payload = form.buildPayload() as Record<string, unknown>;
      setSaving(true);
      try {
        if (mode === "create") {
          const res = await itemsApi.create(slug, payload);
          const created = { ...(payload as unknown as Post), ...(res.data as unknown as Post) };
          onCreated(created);
          pushToast(t`Item created.`);
          // Switch the URL onto the freshly-created row (now in edit mode).
          if (created.id) navigateToItem(created.id);
          return true;
        }
        if (item) {
          await itemsApi.patch(slug, item.id, payload);
          const updated = {
            ...item,
            ...(payload as Partial<Post>),
            updated_at: new Date().toISOString(),
          } as Post;
          setItem(updated);
          onSaved(updated);
          setSavedAt(Date.now());
          setRevisionsKey((k) => k + 1);
          if (!opts?.silent) pushToast(t`Saved.`);
          if (opts?.close) onBack();
          return true;
        }
        return false;
      } catch (e) {
        pushToast((e as Error).message, "error");
        return false;
      } finally {
        setSaving(false);
      }
    },
    [saving, form, mode, slug, item, onCreated, onSaved, onBack, navigateToItem, pushToast, t],
  );

  // ── Autosave (drafts) — debounced, silent, edit-mode only ────────────────
  useEffect(() => {
    if (!autosave || mode !== "edit" || !dirty || saving) return;
    const id = setTimeout(() => {
      void persist({ close: false, silent: true });
    }, 1500);
    return () => clearTimeout(id);
  }, [autosave, dirty, saving, mode, form.draft, persist]);

  // ── Unsaved-changes guard ────────────────────────────────────────────────
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  const guarded = useCallback(
    (fn: () => void) => {
      if (dirty) setPendingNav(() => fn);
      else fn();
    },
    [dirty],
  );

  // ── Publish / unpublish / schedule ───────────────────────────────────────
  const doPublish = async (action: "publish" | "unpublish" | "schedule", publishAt?: string | null) => {
    if (!item) return;
    try {
      const res =
        action === "publish"
          ? await itemsApi.publish(slug, item.id)
          : action === "unpublish"
            ? await itemsApi.unpublish(slug, item.id)
            : await itemsApi.schedulePublish(slug, item.id, publishAt ?? null);
      const updated = { ...item, ...(res.data as Partial<Post>) } as Post;
      setItem(updated);
      onSaved(updated);
      setRevisionsKey((k) => k + 1);
      pushToast(
        action === "publish"
          ? t`Item published.`
          : action === "unpublish"
            ? t`Item reverted to draft.`
            : t`Publish scheduled.`,
      );
    } catch (e) {
      pushToast((e as Error).message, "error");
    }
  };

  // ── Record actions ───────────────────────────────────────────────────────
  const duplicate = async () => {
    const payload = form.buildPayload() as Record<string, unknown>;
    try {
      const res = await itemsApi.create(slug, payload);
      const created = { ...(payload as unknown as Post), ...(res.data as unknown as Post) };
      onCreated(created);
      pushToast(t`Item duplicated.`);
      if (created.id) navigateToItem(created.id);
    } catch (e) {
      pushToast((e as Error).message, "error");
    }
  };

  const remove = async () => {
    if (!item) return;
    try {
      await itemsApi.remove(slug, item.id);
      onDeleted(item.id);
      pushToast(t`Item deleted.`);
      onBack();
    } catch (e) {
      pushToast((e as Error).message, "error");
    } finally {
      setConfirmDelete(false);
    }
  };

  // ── Prev / next within the current filtered list ─────────────────────────
  const { prevId, nextId, position } = useMemo(() => {
    if (mode !== "edit" || siblingIds.length === 0) {
      return { prevId: null as string | null, nextId: null as string | null, position: "" };
    }
    const idx = siblingIds.indexOf(itemId);
    if (idx < 0) return { prevId: null, nextId: null, position: "" };
    return {
      prevId: idx > 0 ? siblingIds[idx - 1]! : null,
      nextId: idx < siblingIds.length - 1 ? siblingIds[idx + 1]! : null,
      position: `${idx + 1} / ${siblingIds.length}`,
    };
  }, [mode, siblingIds, itemId]);

  // ── Presence — best-effort "who else is viewing" ─────────────────────────
  const viewers = usePresence(mode === "edit" ? slug : null, itemId);

  const title = useMemo(() => {
    if (mode === "create") return t`New ${slug}`;
    const rec = (item ?? {}) as Record<string, unknown>;
    const display = rec.title ?? rec.name ?? rec.slug;
    return typeof display === "string" && display.trim() ? display : itemId;
  }, [mode, item, slug, itemId, t]);

  const ownerScoped = !!schema?.ownerScoped;
  const rec = (item ?? {}) as Record<string, unknown>;
  // The items API serializes timestamps as camelCase (createdAt/updatedAt);
  // fall back to snake_case for any adapter that emits it.
  const createdAtVal = rec.createdAt ?? rec.created_at ?? null;
  const updatedAtVal = rec.updatedAt ?? rec.updated_at ?? null;

  return (
    <div className="flex flex-col gap-4 pb-4">
      {/* Header bar — sticky so Save / prev-next stay reachable while the form
          scrolls with the page. */}
      <div className="sticky top-0 z-20 flex flex-wrap items-center gap-2 border-b border-border bg-background pb-3">
        <Button variant="ghost" size="sm" icon={I.ChevronLeft} onClick={() => guarded(onBack)}>
          <Trans>Back</Trans>
        </Button>
        <div className="flex min-w-0 flex-col">
          <div className="flex items-center gap-2">
            <span className="truncate text-base font-semibold tracking-[-0.01em]">{title}</span>
            {dirty && (
              <Badge variant="secondary">
                <Trans>Unsaved</Trans>
              </Badge>
            )}
          </div>
          <span className="font-mono text-[11px] text-muted-foreground">
            c_{slug}
            {mode === "edit" ? ` · ${itemId}` : ""}
          </span>
        </div>

        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          {viewers.length > 0 && (
            <span
              className="inline-flex items-center gap-1 rounded-full border border-border bg-card px-2 py-1 text-[11px] text-muted-foreground"
              title={t`People viewing this record`}
            >
              <I.Users size={11} /> {viewers.length}
            </span>
          )}
          {mode === "edit" && (prevId || nextId) && (
            <div className="flex items-center gap-1">
              <IconButton
                icon={I.ChevronLeft}
                title={t`Previous record`}
                disabled={!prevId}
                onClick={() => prevId && guarded(() => navigateToItem(prevId))}
              />
              {position && <span className="font-mono text-[11px] text-muted-foreground">{position}</span>}
              <IconButton
                icon={I.ChevronRight}
                title={t`Next record`}
                disabled={!nextId}
                onClick={() => nextId && guarded(() => navigateToItem(nextId))}
              />
            </div>
          )}
          {mode === "edit" && (
            <label className="flex items-center gap-1.5 text-[12px] text-muted-foreground" title={t`Autosave drafts as you type`}>
              <Switch checked={autosave} onChange={setAutosave} />
              <Trans>Autosave</Trans>
            </label>
          )}
          {mode === "create" ? (
            <Button variant="primary" size="sm" icon={I.Save} disabled={saving} onClick={() => void persist()}>
              {saving ? <Trans>Creating…</Trans> : t`Create ${slug}`}
            </Button>
          ) : (
            <div className="inline-flex">
              <Button
                variant="primary"
                size="sm"
                icon={I.Save}
                disabled={saving}
                onClick={() => void persist({ close: false })}
                className={cn("rounded-2xl rounded-r-none border-r-0")}
              >
                {saving ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
              </Button>
              <DropdownMenu modal={false}>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={saving}
                    aria-label={t`More save options`}
                    className={cn("rounded-2xl rounded-l-none border-l-0 px-2")}
                  >
                    <I.ChevronDown size={14} />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="z-[70]">
                  <DropdownMenuItem onSelect={() => void persist({ close: true })}>
                    <Trans>Save and close</Trans>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
        </div>
      </div>

      {/* Body: fields + sidebar */}
      <div className="grid grid-cols-[1fr_340px] items-start gap-4 max-[1100px]:grid-cols-1">
        {/* Main: fields */}
        <Card className="min-w-0 gap-0 py-0">
          <div className={SECTION_TITLE_CLS}>
            <I.Braces size={13} />
            <Trans>Fields</Trans>
            <span className="font-mono text-[11px] text-muted-foreground">{form.fields.length}</span>
            {form.errorCount > 0 && (
              <span className="ml-auto inline-flex items-center gap-1 text-[11.5px] text-destructive">
                <I.AlertTriangle size={11} />
                <Trans>{form.errorCount} to fix</Trans>
              </span>
            )}
          </div>
          <div className="p-5">
            {loading ? (
              <div className="py-10 text-center text-[13px] text-muted-foreground">
                <Trans>Loading…</Trans>
              </div>
            ) : (
              <ItemFields form={form} />
            )}
          </div>
        </Card>

        {/* Sidebar — sticky on wide screens so it stays in view as the field
            column scrolls with the page. */}
        <div className="flex flex-col gap-4 self-start min-[1100px]:sticky min-[1100px]:top-16">
          {/* Status / publish */}
          {mode === "edit" && versioned && (
            <Card className="gap-0 py-0">
              <div className={SECTION_TITLE_CLS}>
                <I.Clock size={13} />
                <Trans>Status</Trans>
              </div>
              <div className="flex flex-col gap-2.5 p-3.5">
                <PublishControls
                  item={item}
                  canPublish={!!canPublish}
                  scheduleAt={scheduleAt}
                  setScheduleAt={setScheduleAt}
                  onPublish={doPublish}
                />
              </div>
            </Card>
          )}

          {/* System fields */}
          {mode === "edit" && (
            <Card className="gap-0 py-0">
              <div className={SECTION_TITLE_CLS}>
                <I.Layers size={13} />
                <Trans>System fields</Trans>
              </div>
              <div className="flex flex-col gap-2 p-3.5 text-xs text-muted-foreground">
                <SysRow label="id" value={itemId} mono />
                {ownerScoped && (
                  <SysRow label="owner_id" value={String(rec.ownerId ?? rec.owner_id ?? rec.author ?? "—")} mono />
                )}
                {createdAtVal != null && (
                  <SysRow label="created_at" value={relativeTime(createdAtVal) || "—"} />
                )}
                <SysRow
                  label="updated_at"
                  value={savedAt ? relativeTime(savedAt) : relativeTime(updatedAtVal) || "—"}
                />
              </div>
            </Card>
          )}

          {/* Record actions */}
          {mode === "edit" && item && (
            <Card className="gap-0 py-0">
              <div className={SECTION_TITLE_CLS}>
                <I.Copy size={13} />
                <Trans>Actions</Trans>
              </div>
              <div className="flex flex-wrap gap-2 p-3.5">
                <Button variant="outline" size="sm" icon={I.Copy} onClick={() => void duplicate()}>
                  <Trans>Duplicate</Trans>
                </Button>
                <Button variant="outline" size="sm" icon={I.Trash} onClick={() => setConfirmDelete(true)}>
                  <Trans>Delete</Trans>
                </Button>
              </div>
            </Card>
          )}

          {/* Revision history */}
          {mode === "edit" && item && (
            <RevisionHistory
              slug={slug}
              itemId={item.id}
              refreshKey={revisionsKey}
              pushToast={pushToast}
              onReverted={async () => {
                try {
                  const res = await itemsApi.get(slug, item.id);
                  if (res.data) {
                    const updated = res.data as unknown as Post;
                    setItem(updated);
                    onSaved(updated);
                  }
                } catch {
                  /* ignore */
                }
              }}
            />
          )}

          {/* Collaboration: share + comments */}
          {mode === "edit" && item && (
            <ItemCommentsPanel collection={slug} itemId={item.id} pushToast={pushToast} />
          )}
        </div>
      </div>

      <ConfirmDialog
        open={!!pendingNav}
        title={<Trans>Discard unsaved changes?</Trans>}
        description={<Trans>You have edits that haven't been saved. Leaving will lose them.</Trans>}
        actionLabel={t`Discard`}
        destructive
        onCancel={() => setPendingNav(null)}
        onConfirm={() => {
          const fn = pendingNav;
          setPendingNav(null);
          fn?.();
        }}
      />
      <ConfirmDialog
        open={confirmDelete}
        title={<Trans>Delete this item?</Trans>}
        description={
          <Trans>
            This removes the row from <span className="font-mono">c_{slug}</span>. Revisions remain available.
          </Trans>
        }
        actionLabel={t`Delete`}
        destructive
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => void remove()}
      />
    </div>
  );
}

function SysRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="font-mono">{label}</span>
      <span className={cn("truncate text-right", mono && "font-mono")} title={value}>
        {value}
      </span>
    </div>
  );
}

function PublishControls({
  item,
  canPublish,
  scheduleAt,
  setScheduleAt,
  onPublish,
}: {
  item: Post | null;
  canPublish: boolean;
  scheduleAt: string;
  setScheduleAt: (v: string) => void;
  onPublish: (action: "publish" | "unpublish" | "schedule", publishAt?: string | null) => void | Promise<void>;
}) {
  const { t } = useLingui();
  const rec = (item ?? {}) as Record<string, unknown>;
  const status = String(rec._status ?? "draft");
  const rawPublishAt = rec._publish_at as string | number | null | undefined;
  const publishAtMs = rawPublishAt
    ? typeof rawPublishAt === "number"
      ? rawPublishAt
      : Date.parse(String(rawPublishAt))
    : NaN;
  const scheduled = status === "draft" && Number.isFinite(publishAtMs) && publishAtMs > Date.now();
  const published = status === "published";

  return (
    <>
      <div>
        {scheduled ? (
          <span title={new Date(publishAtMs).toLocaleString()}>
            <Badge variant="outline">
              <I.Clock size={11} /> <Trans>Scheduled</Trans>
            </Badge>
          </span>
        ) : published ? (
          <Badge variant="default">
            <Trans>Published</Trans>
          </Badge>
        ) : (
          <Badge variant="secondary">
            <Trans>Draft</Trans>
          </Badge>
        )}
      </div>
      {canPublish &&
        (published ? (
          <Button variant="outline" size="sm" onClick={() => void onPublish("unpublish")}>
            <Trans>Unpublish</Trans>
          </Button>
        ) : (
          <div className="flex flex-col gap-2">
            <Button variant="primary" size="sm" onClick={() => void onPublish("publish")}>
              <Trans>Publish now</Trans>
            </Button>
            <input
              type="datetime-local"
              value={scheduleAt}
              onChange={(e) => setScheduleAt(e.target.value)}
              className="h-8 rounded-xl border border-border bg-background px-2 text-xs"
              aria-label={t`Schedule publish time`}
            />
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={!scheduleAt}
                onClick={() => scheduleAt && void onPublish("schedule", new Date(scheduleAt).toISOString())}
              >
                <Trans>Schedule</Trans>
              </Button>
              {scheduled && (
                <Button variant="ghost" size="sm" onClick={() => void onPublish("unpublish")}>
                  <Trans>Cancel</Trans>
                </Button>
              )}
            </div>
          </div>
        ))}
    </>
  );
}

function RevisionHistory({
  slug,
  itemId,
  refreshKey,
  pushToast,
  onReverted,
}: {
  slug: string;
  itemId: string;
  /** Changes whenever the parent writes the row, forcing a reload. */
  refreshKey: number;
  pushToast: (m: string, type?: "success" | "error") => void;
  onReverted: () => void | Promise<void>;
}) {
  // Revert is gated server-side by `update` permission; if the caller lacks it
  // the API returns FORBIDDEN and we surface the toast.
  const { t } = useLingui();
  const [revisions, setRevisions] = useState<ApiRevision[]>([]);
  const [loading, setLoading] = useState(true);
  const [reverting, setReverting] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await revisionsApi.list(slug, itemId);
      setRevisions(Array.isArray(res.data) ? res.data : []);
    } catch {
      setRevisions([]);
    } finally {
      setLoading(false);
    }
  }, [slug, itemId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const revert = async (rev: ApiRevision) => {
    setReverting(rev.id);
    try {
      await revisionsApi.revert(rev.id);
      pushToast(t`Reverted to earlier revision.`);
      await onReverted();
      await load();
    } catch (e) {
      pushToast((e as Error).message, "error");
    } finally {
      setReverting(null);
    }
  };

  return (
    <Card className="gap-0 py-0">
      <div className={SECTION_TITLE_CLS}>
        <I.History size={13} />
        <Trans>History</Trans>
        {!loading && (
          <span className="font-mono text-[11px] text-muted-foreground">{revisions.length}</span>
        )}
      </div>
      <div className="flex flex-col gap-2 p-3.5">
        {loading ? (
          <div className="py-2 text-[12.5px] text-muted-foreground">
            <Trans>Loading…</Trans>
          </div>
        ) : revisions.length === 0 ? (
          <div className="py-2 text-[12.5px] text-muted-foreground">
            <Trans>No revisions recorded yet.</Trans>
          </div>
        ) : (
          revisions.map((rev) => {
            // Author is secondary and only shown when resolvable — avoids a
            // bare "—" placeholder on snapshots with no recorded user.
            const author = rev.userId ? authorById(rev.userId) : null;
            return (
              <div
                key={rev.id}
                className="flex items-center gap-2 border-b border-border pb-2 last:border-b-0 last:pb-0"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-[12.5px]">{relativeTime(rev.createdAt) || t`Snapshot`}</div>
                  {author && (
                    <div className="text-[10.5px] text-muted-foreground">{author.name}</div>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={I.RotateCcw}
                  disabled={reverting === rev.id}
                  onClick={() => void revert(rev)}
                >
                  {reverting === rev.id ? <Trans>Reverting…</Trans> : <Trans>Revert</Trans>}
                </Button>
              </div>
            );
          })
        )}
      </div>
    </Card>
  );
}

/** Best-effort presence: subscribe to the item's `presence:*` channel and
 *  surface a viewer count. Defensive — unknown payload shapes simply yield an
 *  empty roster rather than throwing. */
function usePresence(slug: string | null, itemId: string): { id: string }[] {
  const [viewers, setViewers] = useState<{ id: string }[]>([]);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    setViewers([]);
    if (!slug || itemId === "new") return;
    const channel = `presence:item:${slug}:${itemId}`;
    let es: EventSource | null = null;
    try {
      es = new EventSource(`/api/realtime/${encodeURIComponent(channel)}/subscribe`, {
        withCredentials: true,
      });
      esRef.current = es;
      es.addEventListener("message", (ev) => {
        try {
          const parsed = JSON.parse((ev as MessageEvent).data) as Record<string, unknown>;
          const data = (parsed.data ?? parsed) as Record<string, unknown>;
          const members =
            (data.members as unknown[]) ?? (data.presence as unknown[]) ?? (data.roster as unknown[]);
          if (Array.isArray(members)) {
            setViewers(
              members.map((m, i) => {
                const mm = (m ?? {}) as Record<string, unknown>;
                return { id: String(mm.userId ?? mm.id ?? i) };
              }),
            );
          }
        } catch {
          // ignore malformed presence frames
        }
      });
    } catch {
      // EventSource unsupported — no presence
    }
    return () => {
      es?.close();
      esRef.current = null;
    };
  }, [slug, itemId]);

  return viewers;
}
