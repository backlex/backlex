// Full-page collection item editor.
//
// The deep-linkable replacement for the edit modal: `/collections/:slug/items/:id`
// (and `/new`). Fields render in the main column (shared `ItemFields`); the
// right rail carries status/publish, system fields, collaboration, revision
// history, and record actions. Supports prev/next record navigation, an
// unsaved-changes guard, optional autosave for drafts, and best-effort presence.
import type { PushToast } from "../types";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { I } from "../icons";
import { type CollectionSchema, type Post } from "../config";
import { Badge, Button, IconButton, Switch, relativeTime } from "../ui";
import { authorById } from "./items";
import { rowLabel } from "../lib/row-label";
import { Card } from "@backlex/ui/components/card";
import { ScrollArea } from "@backlex/ui/components/scroll-area";
import { Skeleton } from "@backlex/ui/components/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@backlex/ui/components/dropdown-menu";
import { cn } from "@backlex/ui/lib/utils";
import { DatePicker } from "@/components/date-picker";
import { itemsApi, revisionsApi, type ApiRevision } from "../api";
import { ItemCommentsPanel } from "./item-collaboration";
import { ConfirmDialog } from "../sheet";
import { ItemFields, useItemForm } from "./item-form";
import { collabHandle, useCollab } from "../lib/collab";
import { renderUrlTemplate } from "../lib/display-template";

export interface ItemEditorPageProps {
  slug: string;
  /** `"new"` for the create flow, otherwise the row id. */
  itemId: string;
  schema: CollectionSchema;
  /** Fast-path row from the in-memory list; the page still refetches by id so
   *  direct links / refreshes work. */
  initialItem?: Post | null;
  /** Field values to preset on the create form — set by a Kanban column's "+"
   *  so a new card lands in that column (e.g. `{ status: "done" }`). */
  createPreset?: Record<string, unknown> | null;
  /** Ordered ids of the current filtered list — drives prev/next. */
  siblingIds?: string[];
  versioned?: boolean;
  canPublish?: boolean;
  pushToast: PushToast;
  onSaved: (item: Post) => void;
  onCreated: (item: Post) => void;
  onDeleted: (id: string) => void;
  onBack: () => void;
  navigateToItem: (id: string) => void;
}

import { CollectionKpisPanel } from "./collection-kpis";
import { ExtensionWidgets } from "../extension-widgets";

const SECTION_TITLE_CLS =
  "flex items-center gap-2 border-b border-border px-4 py-3 text-[12.5px] font-medium";

export function ItemEditorPage({
  slug,
  itemId,
  schema,
  initialItem = null,
  createPreset = null,
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

  const [item, setItem] = useState<Post | null>(
    mode === "edit" ? initialItem : createPreset ? (createPreset as unknown as Post) : null,
  );
  const [loading, setLoading] = useState(mode === "edit" && !initialItem);
  const [saving, setSaving] = useState(false);
  const [autosave, setAutosave] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  // Bumped after any write (save / publish) so the revision history reloads
  // without a manual page refresh.
  const [revisionsKey, setRevisionsKey] = useState(0);
  const [scheduleAt, setScheduleAt] = useState("");
  const [unpublishAt, setUnpublishAt] = useState("");
  // Pending guarded navigation — populated when the user tries to leave with
  // unsaved changes; the ConfirmDialog runs it on confirm.
  const [pendingNav, setPendingNav] = useState<(() => void) | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Someone else saved this record after we loaded it (409 on save) — shows
  // the conflict banner until the user reloads or force-overwrites.
  const [conflict, setConflict] = useState(false);

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
      // Keep the create-preset (a Kanban column's "+" seeds the grouped field)
      // instead of wiping the form back to empty.
      setItem(createPreset ? (createPreset as unknown as Post) : null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(!initialItem);
    void (async () => {
      try {
        // Staged-edits collections: seed the form from the merged staged
        // preview so editing continues from the pending changes (the live
        // row is what readers still see).
        const res = await itemsApi.get(
          slug,
          itemId,
          schema.stagedEdits ? { staged: 1 } : undefined,
        );
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
  }, [slug, itemId, mode]);

  // ── Save ────────────────────────────────────────────────────────────────
  const persist = useCallback(
    async (opts?: { close?: boolean; silent?: boolean; force?: boolean }) => {
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
          // Optimistic concurrency: send the updatedAt we loaded so a
          // concurrent save by someone else 409s instead of being overwritten.
          // `force` (the banner's "Save anyway") skips the precondition.
          const rec0 = item as unknown as Record<string, unknown>;
          const baseUpdatedAt = rec0.updatedAt ?? rec0.updated_at;
          const res = await itemsApi.patch(
            slug,
            item.id,
            payload,
            !opts?.force && baseUpdatedAt != null
              ? { ifUnmodifiedSince: String(baseUpdatedAt) }
              : undefined,
          );
          // Merge the server echo last — it carries the authoritative
          // updatedAt the next save's precondition needs.
          const updated = {
            ...item,
            ...(payload as Partial<Post>),
            ...(res.data as unknown as Partial<Post>),
          } as Post;
          setConflict(false);
          setItem(updated);
          onSaved(updated);
          setSavedAt(Date.now());
          setRevisionsKey((k) => k + 1);
          if (!opts?.silent) {
            pushToast(
              (res.data as Record<string, unknown> | undefined)?._staged
                ? t`Changes staged — publish to apply them.`
                : t`Saved.`,
            );
          }
          if (opts?.close) onBack();
          return true;
        }
        return false;
      } catch (e) {
        if ((e as { code?: string }).code === "CONFLICT") {
          setConflict(true);
        } else {
          pushToast((e as Error).message, "error");
        }
        return false;
      } finally {
        setSaving(false);
      }
    },
    [saving, form, mode, slug, item, onCreated, onSaved, onBack, navigateToItem, pushToast, t],
  );

  // Conflict banner "Reload": refetch the latest row — replacing `item`
  // re-seeds the form, discarding this member's local edits.
  const reloadLatest = useCallback(async () => {
    try {
      const res = await itemsApi.get(
        slug,
        itemId,
        schema.stagedEdits ? { staged: 1 } : undefined,
      );
      if (res.data) {
        setItem(res.data as unknown as Post);
        setConflict(false);
        setRevisionsKey((k) => k + 1);
      }
    } catch (e) {
      pushToast((e as Error).message, "error");
    }
  }, [slug, itemId, schema.stagedEdits, pushToast]);

  // ── Autosave (drafts) — debounced, silent, edit-mode only ────────────────
  // Paused while a conflict is unresolved: retrying would just 409 again.
  useEffect(() => {
    if (!autosave || mode !== "edit" || !dirty || saving || conflict) return;
    const id = setTimeout(() => {
      void persist({ close: false, silent: true });
    }, 1500);
    return () => clearTimeout(id);
  }, [autosave, dirty, saving, mode, conflict, form.draft, persist]);

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
  const doPublish = async (
    action: "publish" | "unpublish" | "archive" | "schedule" | "scheduleUnpublish",
    at?: string | null,
  ) => {
    if (!item) return;
    try {
      const res =
        action === "publish"
          ? await itemsApi.publish(slug, item.id)
          : action === "unpublish"
            ? await itemsApi.unpublish(slug, item.id)
            : action === "archive"
              ? await itemsApi.archive(slug, item.id)
              : action === "scheduleUnpublish"
                ? await itemsApi.scheduleUnpublish(slug, item.id, at ?? null)
                : await itemsApi.schedulePublish(slug, item.id, at ?? null);
      const hadStaged = !!(item as unknown as Record<string, unknown>)._staged;
      const updated = { ...item, ...(res.data as Partial<Post>) } as Post;
      // Every state transition applies (and clears) the staged patch server-
      // side; only a bare expiry set leaves it pending. The response row
      // doesn't carry the key, so strip the stale local flag explicitly.
      if (action !== "scheduleUnpublish") {
        delete (updated as unknown as Record<string, unknown>)._staged;
      }
      setItem(updated);
      onSaved(updated);
      setRevisionsKey((k) => k + 1);
      pushToast(
        action === "publish"
          ? hadStaged
            ? t`Staged changes published.`
            : t`Item published.`
          : action === "unpublish"
            ? t`Item reverted to draft.`
            : action === "archive"
              ? t`Item archived.`
              : action === "scheduleUnpublish"
                ? at
                  ? t`Auto-unpublish scheduled.`
                  : t`Expiry cleared.`
                : t`Publish scheduled.`,
      );
    } catch (e) {
      pushToast((e as Error).message, "error");
    }
  };

  // Discard staged changes: drop the flag optimistically, then reseed the form
  // from the live row (the staged values the form currently shows are gone).
  const discardStaged = async () => {
    if (!item) return;
    const snapshot = item;
    const optimistic = { ...item } as unknown as Record<string, unknown>;
    delete optimistic._staged;
    setItem(optimistic as unknown as Post);
    try {
      await itemsApi.discardStaged(slug, item.id);
      const res = await itemsApi.get(slug, itemId);
      if (res.data) {
        setItem(res.data as unknown as Post);
        onSaved(res.data as unknown as Post);
      }
      pushToast(t`Staged changes discarded.`);
    } catch (e) {
      setItem(snapshot);
      pushToast((e as Error).message, "error");
    }
  };

  // ── Record actions ───────────────────────────────────────────────────────
  const duplicate = async () => {
    const payload = form.buildPayload() as Record<string, unknown>;
    // A copy can't reuse the original's unique values (slug/sku/…) or it
    // collides on insert. Suffix every unique string field, and tag the
    // title/name so the copy is recognizable.
    const suffix = Math.random().toString(36).slice(2, 6);
    for (const f of (schema.fields ?? []) as Array<{ name: string; unique?: boolean }>) {
      if (!f.unique) continue;
      const v = payload[f.name];
      if (typeof v === "string" && v) payload[f.name] = `${v}-copy-${suffix}`;
    }
    for (const key of ["title", "name"]) {
      if (typeof payload[key] === "string" && payload[key]) {
        payload[key] = `${payload[key] as string} (Copy)`;
        break;
      }
    }
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

  // ── Live collaboration — who else is here + which field they're editing ──
  const collab = useCollab(mode === "edit" ? slug : null, itemId);

  const title = useMemo(() => {
    if (mode === "create") return t`New ${slug}`;
    // Go through the shared resolver rather than a local title/name/slug scan:
    // it honours the collection's display template and the wider label-field
    // list, so a record keyed by a number (invoice, order, RMA) or by a person's
    // first/last name gets a real heading instead of a raw UUID.
    return rowLabel((item ?? {}) as Record<string, unknown>, {
      displayTemplate: schema?.displayTemplate,
      fields: schema?.fields,
    });
  }, [mode, item, slug, schema, t]);

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
      <div className="sticky top-3 z-20 flex flex-wrap items-center gap-2 rounded-2xl border border-border bg-card px-4 py-3">
        <Button variant="ghost" size="sm" icon={I.ChevronLeft} onClick={() => guarded(onBack)}>
          <Trans>Back</Trans>
        </Button>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-2">
            <span className="truncate text-base font-semibold tracking-[-0.01em]">{title}</span>
            {dirty && (
              <Badge variant="secondary">
                <Trans>Unsaved</Trans>
              </Badge>
            )}
          </div>
          <span className="truncate font-mono text-[11px] text-muted-foreground">
            c_{slug}
            {mode === "edit" ? ` · ${itemId}` : ""}
          </span>
        </div>

        <div className="flex w-full flex-wrap items-center justify-end gap-2 sm:ml-auto sm:w-auto">
          {collab.peers.length > 0 && (
            <span
              className="inline-flex items-center"
              title={t`People viewing this record`}
            >
              {collab.peers.slice(0, 4).map((p, i) => (
                <span
                  key={p.id}
                  className={cn(
                    "flex size-6 items-center justify-center rounded-full border-2 border-card text-[10px] font-semibold text-white",
                    i > 0 && "-ml-1.5",
                  )}
                  style={{ background: p.color }}
                  title={collabHandle(p)}
                >
                  {collabHandle(p).slice(0, 1).toUpperCase()}
                </span>
              ))}
              {collab.peers.length > 4 && (
                <span className="ml-1 text-[11px] text-muted-foreground">
                  +{collab.peers.length - 4}
                </span>
              )}
              {/* With one or two viewers there's room to say WHO — the native
                  title tooltip is invisible on touch and easy to miss. Larger
                  rosters collapse back to avatars + "+N". */}
              {collab.peers.length <= 2 && (
                <span className="ml-1.5 max-w-[160px] truncate text-[11.5px] text-muted-foreground">
                  {collab.peers.map(collabHandle).join(", ")}
                </span>
              )}
            </span>
          )}
          {mode === "edit" && schema.previewUrl && (
            <Button
              variant="outline"
              size="sm"
              icon={I.ExternalLink}
              title={t`Open the live preview for this record`}
              onClick={() => {
                // Freshest values win: unsaved draft edits over the loaded row.
                const url = renderUrlTemplate(schema.previewUrl as string, {
                  ...((item ?? {}) as Record<string, unknown>),
                  ...form.draft,
                });
                if (/^https?:\/\//.test(url)) window.open(url, "_blank", "noopener");
              }}
            >
              <span className="hidden sm:inline"><Trans>Preview</Trans></span>
            </Button>
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
              <span className="hidden sm:inline">
                <Trans>Autosave</Trans>
              </span>
            </label>
          )}
          {mode === "create" ? (
            <Button variant="primary" size="sm" icon={I.Save} disabled={saving} onClick={() => void persist()}>
              <span className="hidden sm:inline">
                {saving ? <Trans>Creating…</Trans> : t`Create ${slug}`}
              </span>
            </Button>
          ) : (
            <div className="inline-flex">
              <Button
                variant="primary"
                size="sm"
                icon={I.Save}
                disabled={saving}
                onClick={() => void persist({ close: false })}
                className={cn("rounded-control rounded-r-none border-r-0")}
              >
                <span className="hidden sm:inline">
                  {saving ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
                </span>
              </Button>
              <DropdownMenu modal={false}>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={saving}
                    aria-label={t`More save options`}
                    className={cn("rounded-control rounded-l-none border-l-0 px-2")}
                  >
                    <I.ChevronDown size={14} />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="z-[70]">
                  <DropdownMenuItem onSelect={() => void persist({ close: true })}>
                    <Trans>Save and close</Trans>
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void duplicate()}>
                    <Trans>Duplicate</Trans>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => setConfirmDelete(true)}
                    className="text-destructive focus:text-destructive"
                  >
                    <Trans>Delete</Trans>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
        </div>
      </div>

      {/* Conflict banner — someone else saved this record after we loaded it. */}
      {conflict && (
        <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-[12.5px]">
          {/* Full-width text row on mobile; the buttons wrap below and hug the
              right edge. On sm+ everything sits on one line. */}
          <div className="flex min-w-0 basis-full items-start gap-2 sm:basis-auto sm:flex-1 sm:items-center">
            <I.AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-500 sm:mt-0" />
            <span className="min-w-0">
              <Trans>
                This record was changed by someone else after you opened it. Reload to get the
                latest version (your edits will be lost), or save anyway to overwrite theirs.
              </Trans>
            </span>
          </div>
          <div className="ml-auto flex gap-1.5">
            <Button variant="outline" size="sm" onClick={() => void reloadLatest()}>
              <Trans>Reload</Trans>
            </Button>
            <Button variant="primary" size="sm" onClick={() => void persist({ force: true })}>
              <Trans>Save anyway</Trans>
            </Button>
          </div>
        </div>
      )}

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
              <div className="flex flex-col gap-5">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="flex flex-col gap-2">
                    <Skeleton className="h-3.5 w-28" />
                    <Skeleton className="h-9 w-full" />
                  </div>
                ))}
              </div>
            ) : (
              <ItemFields
                form={form}
                collab={{
                  peersByField: collab.peersByField,
                  onFieldFocus: collab.onFieldFocus,
                  onFieldBlur: collab.onFieldBlur,
                }}
              />
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
                  unpublishAt={unpublishAt}
                  setUnpublishAt={setUnpublishAt}
                  onPublish={doPublish}
                  onDiscardStaged={discardStaged}
                />
              </div>
            </Card>
          )}

          {/* Figures pinned to THIS collection, narrowed to this record —
              "how is this product doing". Sits in the rail beside the other
              read-only cards rather than above the form, because it is context
              for the record, not part of editing it. Renders nothing at all
              (not even a skeleton) when nothing is pinned here, which is the
              common case; and nothing in `create` mode, where there is no row
              to scope to and a collection-wide total under a new record's
              heading would be a lie. */}
          {mode === "edit" && item && (
            <CollectionKpisPanel collection={slug} pinnedRowId={item.id} />
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

          {/* Extension widgets for this record. Only in edit mode: a widget's
              context is the row's id, and a record being created has none. */}
          {mode === "edit" && item && (
            <ExtensionWidgets
              mount="item-detail"
              context={{ collection: slug, itemId: item.id }}
            />
          )}

          {/* Revision history */}
          {mode === "edit" && item && (
            <RevisionHistory
              slug={slug}
              itemId={item.id}
              current={item as unknown as Record<string, unknown>}
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

const toMs = (v: unknown): number =>
  v == null ? NaN : typeof v === "number" ? v : Date.parse(String(v));

function PublishControls({
  item,
  canPublish,
  scheduleAt,
  setScheduleAt,
  unpublishAt,
  setUnpublishAt,
  onPublish,
  onDiscardStaged,
}: {
  item: Post | null;
  canPublish: boolean;
  scheduleAt: string;
  setScheduleAt: (v: string) => void;
  unpublishAt: string;
  setUnpublishAt: (v: string) => void;
  onPublish: (
    action: "publish" | "unpublish" | "archive" | "schedule" | "scheduleUnpublish",
    at?: string | null,
  ) => void | Promise<void>;
  onDiscardStaged?: () => void | Promise<void>;
}) {
  const rec = (item ?? {}) as Record<string, unknown>;
  const status = String(rec._status ?? "draft");
  const staged = !!rec._staged;
  const publishAtMs = toMs(rec._publish_at);
  const unpublishAtMs = toMs(rec._unpublish_at);
  const publishedAtMs = toMs(rec._published_at);
  const updatedAtMs = toMs(rec.updated_at ?? rec.updatedAt);
  const scheduled = status === "draft" && Number.isFinite(publishAtMs) && publishAtMs > Date.now();
  const published = status === "published";
  const archived = status === "archived";
  const expiresAt = published && Number.isFinite(unpublishAtMs) && unpublishAtMs > Date.now();
  // Single-row model: editing a published row changes what's live immediately.
  // A later `updated_at` than `_published_at` means the live content has drifted
  // from what was reviewed at publish time — surface it so editors notice.
  const editedSincePublish =
    published &&
    Number.isFinite(publishedAtMs) &&
    Number.isFinite(updatedAtMs) &&
    updatedAtMs > publishedAtMs + 1000;

  // One timing panel open at a time — keeps the default view compact.
  const [timing, setTiming] = useState<"schedule" | "expiry" | null>(null);

  const fmtDay = (ms: number) => new Date(ms).toLocaleDateString();

  const stateBadges = (
    <div className="flex flex-wrap items-center gap-1.5">
      {scheduled ? (
        <span title={new Date(publishAtMs).toLocaleString()}>
          <Badge variant="outline">
            <I.Clock size={11} /> <Trans>Scheduled · {fmtDay(publishAtMs)}</Trans>
          </Badge>
        </span>
      ) : published ? (
        <Badge variant="default">
          <Trans>Published</Trans>
        </Badge>
      ) : archived ? (
        <Badge variant="outline">
          <I.Archive size={11} /> <Trans>Archived</Trans>
        </Badge>
      ) : (
        <Badge variant="secondary">
          <Trans>Draft</Trans>
        </Badge>
      )}
      {staged && (
        <Badge variant="outline">
          <I.Pencil size={10} /> <Trans>Staged changes</Trans>
        </Badge>
      )}
      {editedSincePublish && !staged && (
        <span title={publishedAtMs ? new Date(publishedAtMs).toLocaleString() : undefined}>
          <Badge variant="outline">
            <I.Pencil size={10} /> <Trans>Edited since publish</Trans>
          </Badge>
        </span>
      )}
      {expiresAt && (
        <span title={new Date(unpublishAtMs).toLocaleString()}>
          <Badge variant="outline">
            <I.Clock size={10} /> <Trans>Expires {fmtDay(unpublishAtMs)}</Trans>
          </Badge>
        </span>
      )}
    </div>
  );

  if (!canPublish) return stateBadges;

  // Shared timing sub-panel — a labeled, bordered block so the date control
  // never floats loose in the card. Revealed by a single disclosure toggle.
  const timingPanel =
    timing === "schedule" ? (
      <div className="flex flex-col gap-2 rounded-control border border-border bg-card p-2.5">
        <span className="text-[11px] font-medium text-muted-foreground">
          <Trans>Publish on</Trans>
        </span>
        <DatePicker value={scheduleAt || null} onChange={(iso) => setScheduleAt(iso ?? "")} />
        <Button
          variant="primary"
          size="sm"
          className="w-full"
          disabled={!scheduleAt}
          onClick={() => {
            if (!scheduleAt) return;
            void onPublish("schedule", new Date(scheduleAt).toISOString());
            setTiming(null);
          }}
        >
          <Trans>Schedule publish</Trans>
        </Button>
      </div>
    ) : timing === "expiry" ? (
      <div className="flex flex-col gap-2 rounded-control border border-border bg-card p-2.5">
        <span className="text-[11px] font-medium text-muted-foreground">
          <Trans>Unpublish on</Trans>
        </span>
        <DatePicker value={unpublishAt || null} onChange={(iso) => setUnpublishAt(iso ?? "")} />
        <div className="flex gap-2">
          {expiresAt && (
            <Button
              variant="ghost"
              size="sm"
              className="flex-1"
              onClick={() => {
                setUnpublishAt("");
                void onPublish("scheduleUnpublish", null);
                setTiming(null);
              }}
            >
              <Trans>Remove</Trans>
            </Button>
          )}
          <Button
            variant="primary"
            size="sm"
            className="flex-1"
            disabled={!unpublishAt}
            onClick={() => {
              if (!unpublishAt) return;
              void onPublish("scheduleUnpublish", new Date(unpublishAt).toISOString());
              setTiming(null);
            }}
          >
            <Trans>Set expiry</Trans>
          </Button>
        </div>
      </div>
    ) : null;

  return (
    <div className="flex flex-col gap-2.5">
      {stateBadges}
      {archived ? (
        <>
          <Button variant="primary" size="sm" className="w-full" onClick={() => void onPublish("publish")}>
            <Trans>Publish now</Trans>
          </Button>
          <Button variant="outline" size="sm" className="w-full" onClick={() => void onPublish("unpublish")}>
            <Trans>Restore to draft</Trans>
          </Button>
        </>
      ) : published ? (
        <>
          {staged && (
            <Button variant="primary" size="sm" className="w-full" onClick={() => void onPublish("publish")}>
              <Trans>Publish changes</Trans>
            </Button>
          )}
          <div className="flex gap-2">
            {staged && onDiscardStaged ? (
              <Button variant="outline" size="sm" className="flex-1" onClick={() => void onDiscardStaged()}>
                <Trans>Discard changes</Trans>
              </Button>
            ) : (
              <Button variant="outline" size="sm" className="flex-1" onClick={() => void onPublish("unpublish")}>
                <Trans>Unpublish</Trans>
              </Button>
            )}
            <Button variant="ghost" size="sm" className="flex-1" onClick={() => void onPublish("archive")}>
              <I.Archive size={13} /> <Trans>Archive</Trans>
            </Button>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-between text-muted-foreground"
            onClick={() => setTiming((v) => (v === "expiry" ? null : "expiry"))}
          >
            {expiresAt ? <Trans>Change auto-unpublish</Trans> : <Trans>Set auto-unpublish</Trans>}
            <I.ChevronDown size={13} />
          </Button>
          {timingPanel}
        </>
      ) : (
        // draft (optionally already scheduled)
        <>
          <Button variant="primary" size="sm" className="w-full" onClick={() => void onPublish("publish")}>
            <Trans>Publish now</Trans>
          </Button>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              className="flex-1"
              onClick={() => setTiming((v) => (v === "schedule" ? null : "schedule"))}
            >
              {scheduled ? <Trans>Reschedule</Trans> : <Trans>Schedule</Trans>}
            </Button>
            {scheduled ? (
              <Button variant="ghost" size="sm" className="flex-1" onClick={() => void onPublish("unpublish")}>
                <Trans>Cancel</Trans>
              </Button>
            ) : (
              <Button variant="ghost" size="sm" className="flex-1" onClick={() => void onPublish("archive")}>
                <I.Archive size={13} /> <Trans>Archive</Trans>
              </Button>
            )}
          </div>
          {timingPanel}
        </>
      )}
    </div>
  );
}

/** Keys never shown in the revert diff — system/bookkeeping columns. */
const REVISION_DIFF_SKIP = new Set([
  "id", "created_at", "updated_at", "createdAt", "updatedAt",
  "owner_id", "ownerId", "tenant_id", "tenantId", "_status",
]);

const fmtRevVal = (v: unknown): string => {
  if (v == null || v === "") return "—";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return s.length > 26 ? s.slice(0, 24) + "…" : s;
};

function RevisionHistory({
  slug,
  itemId,
  current,
  refreshKey,
  pushToast,
  onReverted,
}: {
  slug: string;
  itemId: string;
  /** The live row — diffed against a revision's snapshot so the confirm
   *  step can show exactly which fields a revert would change. */
  current: Record<string, unknown>;
  /** Changes whenever the parent writes the row, forcing a reload. */
  refreshKey: number;
  pushToast: PushToast;
  onReverted: () => void | Promise<void>;
}) {
  // Revert is gated server-side by `update` permission; if the caller lacks it
  // the API returns FORBIDDEN and we surface the toast.
  const { t } = useLingui();
  const [revisions, setRevisions] = useState<ApiRevision[]>([]);
  const [loading, setLoading] = useState(true);
  const [reverting, setReverting] = useState<string | null>(null);
  // Two-step revert: the first click expands a field-level preview of what
  // would change; only the confirm button inside actually reverts.
  const [expanded, setExpanded] = useState<string | null>(null);

  const diffFor = (rev: ApiRevision): { k: string; from: unknown; to: unknown }[] => {
    const snap = rev.snapshot ?? {};
    const keys = new Set(
      [...Object.keys(snap), ...Object.keys(current ?? {})].filter((k) => !REVISION_DIFF_SKIP.has(k)),
    );
    const out: { k: string; from: unknown; to: unknown }[] = [];
    for (const k of keys) {
      const a = (current ?? {})[k];
      const b = (snap as Record<string, unknown>)[k];
      if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)) out.push({ k, from: a, to: b });
    }
    return out;
  };

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
      setExpanded(null);
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
      {loading ? (
        <div className="flex flex-col gap-2.5 p-3.5 py-4">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-2">
              <Skeleton className="size-6 rounded-full" />
              <Skeleton className="h-3 flex-1" />
            </div>
          ))}
        </div>
      ) : revisions.length === 0 ? (
        <div className="p-3.5 py-4 text-[12.5px] text-muted-foreground">
          <Trans>No revisions recorded yet.</Trans>
        </div>
      ) : (
        <ScrollArea viewportClassName="max-h-[320px]">
          <div className="flex flex-col gap-2 p-3.5">
            {revisions.map((rev) => {
              // Author is secondary and only shown when resolvable — avoids a
              // bare "—" placeholder on snapshots with no recorded user.
              const author = rev.userId ? authorById(rev.userId) : null;
              const isOpen = expanded === rev.id;
              const diff = isOpen ? diffFor(rev) : [];
              return (
                <div key={rev.id} className="border-b border-border pb-2 last:border-b-0 last:pb-0">
                  <div className="flex items-center gap-2">
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
                      onClick={() => setExpanded(isOpen ? null : rev.id)}
                    >
                      <Trans>Revert</Trans>
                    </Button>
                  </div>
                  {isOpen && (
                    <div className="mt-2 rounded-surface border border-border bg-muted/40 p-2.5 text-[11.5px]">
                      {diff.length === 0 ? (
                        <div className="text-muted-foreground"><Trans>Same as the current values — nothing to revert.</Trans></div>
                      ) : (
                        <>
                          <div className="mb-1.5 text-muted-foreground"><Trans>Reverting changes these fields:</Trans></div>
                          <div className="flex flex-col gap-1">
                            {diff.slice(0, 6).map((d) => (
                              <div key={d.k} className="flex min-w-0 items-baseline gap-1.5">
                                <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground">{d.k}</span>
                                <span className="min-w-0 truncate line-through opacity-60">{fmtRevVal(d.from)}</span>
                                <span className="shrink-0 text-muted-foreground">→</span>
                                <span className="min-w-0 truncate">{fmtRevVal(d.to)}</span>
                              </div>
                            ))}
                            {diff.length > 6 && (
                              <span className="text-muted-foreground">+{diff.length - 6}</span>
                            )}
                          </div>
                        </>
                      )}
                      <div className="mt-2 flex justify-end gap-1.5">
                        <Button variant="ghost" size="sm" onClick={() => setExpanded(null)}>
                          <Trans>Cancel</Trans>
                        </Button>
                        <Button
                          variant="primary"
                          size="sm"
                          icon={I.RotateCcw}
                          disabled={reverting === rev.id || diff.length === 0}
                          onClick={() => void revert(rev)}
                        >
                          {reverting === rev.id ? <Trans>Reverting…</Trans> : <Trans>Revert</Trans>}
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </ScrollArea>
      )}
    </Card>
  );
}

