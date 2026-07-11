// Modal form for quick create/edit, plus the shared ConfirmAction dialog.
//
// The field rendering + form state live in `item-form.tsx` (shared with the
// full-page editor). This file is just the modal chrome: header, Fields/
// Collaboration tabs, the publish controls, and the split Save button.
import { useEffect, useState, type ReactNode } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { I } from "./icons";
import { type CollectionSchema, type Post } from "./config";
import { Badge, Button } from "./ui";
import { Tabs, TabsList, TabsTrigger } from "@backlex/ui/components/tabs";
import { ScrollArea } from "@backlex/ui/components/scroll-area";
import { DatePicker } from "@/components/date-picker";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@backlex/ui/components/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@backlex/ui/components/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@backlex/ui/components/alert-dialog";
import { cn } from "@backlex/ui/lib/utils";
import { ItemCommentsPanel } from "./item-collaboration";
import { ItemFields, useItemForm } from "./item-form";

export interface ItemSheetProps {
  open: boolean;
  mode: "create" | "edit";
  initial: Post | null;
  schema: CollectionSchema;
  onClose: () => void;
  /**
   * Save the current draft. Return value is awaited; if it resolves to `false`
   * the sheet treats it as a validation/API failure and stays dirty (so the
   * user can retry). Anything else (true / undefined / void) is treated as
   * success.
   *
   * `opts.close` is the primary-vs-secondary axis of the split-button:
   *   - `true`  (default, "Save" / `Enter` / `Cmd+Enter` / `Create <slug>`):
   *             on success the parent closes the sheet.
   *   - `false` ("Save and continue" dropdown item): on success the sheet
   *             stays open and the parent is expected to have updated
   *             `initial` so the form re-syncs to the freshly-saved values.
   */
  onSave: (
    draft: Partial<Post>,
    opts?: { close?: boolean },
  ) => void | boolean | Promise<void | boolean>;
  /** Versioned collection — enables the draft/publish controls in edit mode. */
  versioned?: boolean;
  /** Whether the caller holds the `publish` permission (controls are read-only
   *  / hidden otherwise). */
  canPublish?: boolean;
  /** Publish / unpublish / schedule the current item. `publishAt` is an ISO
   *  string for `schedule`, or null to cancel a pending schedule. */
  onPublish?: (
    action: "publish" | "unpublish" | "schedule",
    publishAt?: string | null,
  ) => void | Promise<void>;
}

export function ItemSheet({
  open,
  mode,
  initial,
  schema,
  onClose,
  onSave,
  versioned,
  canPublish,
  onPublish,
}: ItemSheetProps) {
  const { t } = useLingui();
  const [scheduleAt, setScheduleAt] = useState("");
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<"fields" | "collab">("fields");
  useEffect(() => {
    if (open) setActiveTab("fields");
  }, [open]);

  const form = useItemForm({ schema, initial, active: open });

  const submit = async (opts?: { close?: boolean }) => {
    if (saving) return;
    if (!form.validate()) return;
    const close = opts?.close ?? true;
    setSaving(true);
    try {
      await onSave(form.buildPayload(), { close });
    } finally {
      setSaving(false);
    }
  };

  // Enter-to-save handler for the body — Enter and Cmd/Ctrl+Enter both fire the
  // primary "Save" (close on success). Newline-bearing surfaces opt out.
  const onBodyKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Enter") return;
    if (e.defaultPrevented) return;
    const target = e.target as HTMLElement | null;
    const tag = target?.tagName?.toLowerCase();
    const isMeta = e.metaKey || e.ctrlKey;
    if (isMeta) {
      e.preventDefault();
      void submit({ close: true });
      return;
    }
    if (tag === "textarea") return;
    if (target?.isContentEditable) return;
    if (target?.closest('[data-enter-newline="true"]')) return;
    if (e.shiftKey || e.altKey) return;
    e.preventDefault();
    void submit({ close: true });
  };

  if (!open) return null;

  const slug = schema?.slug ?? "";
  const ownerScoped = !!schema?.ownerScoped;
  const itemId = (initial as { id?: string } | null)?.id;

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent
        className={cn(
          "grid max-h-[90vh] w-[94vw] gap-0 overflow-hidden border-border bg-card p-0 sm:max-w-[560px]",
          mode === "edit" ? "grid-rows-[auto_auto_1fr_auto]" : "grid-rows-[auto_1fr_auto]",
        )}
      >
        <DialogHeader
          className={cn(
            "flex flex-col gap-0.5 px-5 pb-3.5 pr-12 pt-[18px]",
            mode === "create" && "border-b border-border",
          )}
        >
          <DialogTitle className="text-base font-semibold tracking-[-0.01em]">
            {mode === "create" ? t`New ${slug || "row"}` : t`Edit ${slug || "row"}`}
          </DialogTitle>
          <DialogDescription className="text-[12.5px] text-muted-foreground">
            {mode === "create" ? (
              <Trans>
                Insert into <span className="font-mono">c_{slug}</span>
                {ownerScoped ? (
                  <>
                    . Owner is set to <span className="font-mono">$user.id</span>
                  </>
                ) : null}
                .
              </Trans>
            ) : (
              <Trans>
                id <span className="font-mono">{itemId}</span>
              </Trans>
            )}
          </DialogDescription>
        </DialogHeader>

        {mode === "edit" && (
          <Tabs
            value={activeTab}
            onValueChange={(v) => setActiveTab(v as "fields" | "collab")}
            className="border-b border-border bg-card px-3.5 py-2.5"
          >
            <TabsList>
              <TabsTrigger value="fields">
                <I.Braces size={12} /> <Trans>Fields</Trans>
                <span className="font-mono text-[10.5px] text-muted-foreground">{form.fields.length}</span>
                {form.errorCount > 0 && (
                  <span className="ml-1 rounded-full bg-destructive px-1.5 text-[10px] font-medium text-destructive-foreground">
                    {form.errorCount}
                  </span>
                )}
              </TabsTrigger>
              <TabsTrigger value="collab">
                <I.MessageSquare size={12} /> <Trans>Collaboration</Trans>
              </TabsTrigger>
            </TabsList>
          </Tabs>
        )}

        <ScrollArea className="min-h-0">
          <div className="flex flex-col gap-8 px-5 py-[18px]" onKeyDown={onBodyKeyDown}>
            {activeTab === "fields" && (
              <>
                <ItemFields form={form} />
                <div className="flex flex-col gap-1.5 rounded-control bg-muted p-3">
                  <div className="mb-1.5 flex items-center gap-2 text-[12.5px] font-medium text-foreground">
                    <Trans>system fields</Trans>
                  </div>
                  <div className="flex flex-wrap gap-3.5 text-xs text-muted-foreground">
                    <div>
                      <span className="font-mono">id</span>:{" "}
                      {mode === "create" ? (
                        <span className="font-mono">gen_uuid()</span>
                      ) : (
                        <span className="font-mono">{itemId}</span>
                      )}
                    </div>
                    {ownerScoped && (
                      <div>
                        <span className="font-mono">owner_id</span>: <span className="font-mono">$user.id</span>
                      </div>
                    )}
                    <div>
                      <span className="font-mono">updated_at</span>: <span className="font-mono">now()</span>
                    </div>
                  </div>
                </div>
              </>
            )}
            {mode === "edit" && activeTab === "collab" && slug && itemId && (
              <ItemCommentsPanel collection={slug} itemId={itemId} />
            )}
          </div>
        </ScrollArea>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border bg-card px-5 py-3">
          {mode === "edit" && versioned && (() => {
            const status = String((initial as Record<string, unknown> | null)?._status ?? "draft");
            const rawPublishAt = (initial as Record<string, unknown> | null)?._publish_at as
              | string
              | number
              | null
              | undefined;
            const publishAtMs = rawPublishAt
              ? typeof rawPublishAt === "number"
                ? rawPublishAt
                : Date.parse(String(rawPublishAt))
              : NaN;
            const scheduled = status === "draft" && Number.isFinite(publishAtMs) && publishAtMs > Date.now();
            const published = status === "published";
            const badge = scheduled ? (
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
            );
            return (
              <div className="mr-auto flex flex-wrap items-center gap-2">
                {badge}
                {canPublish &&
                  onPublish &&
                  (published ? (
                    <Button variant="outline" size="sm" onClick={() => void onPublish("unpublish")}>
                      <Trans>Unpublish</Trans>
                    </Button>
                  ) : (
                    <>
                      <Button variant="primary" size="sm" onClick={() => void onPublish("publish")}>
                        <Trans>Publish</Trans>
                      </Button>
                      <DatePicker value={scheduleAt || null} onChange={(iso) => setScheduleAt(iso ?? "")} />
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!scheduleAt}
                        onClick={() =>
                          scheduleAt && void onPublish("schedule", new Date(scheduleAt).toISOString())
                        }
                      >
                        <Trans>Schedule</Trans>
                      </Button>
                      {scheduled && (
                        <Button variant="ghost" size="sm" onClick={() => void onPublish("unpublish")}>
                          <Trans>Cancel schedule</Trans>
                        </Button>
                      )}
                    </>
                  ))}
              </div>
            );
          })()}
          <Button variant="ghost" size="sm" onClick={onClose}>
            {form.dirty ? <Trans>Cancel</Trans> : <Trans>Close</Trans>}
          </Button>
          {mode === "create" ? (
            <Button variant="primary" size="sm" onClick={() => void submit({ close: true })} disabled={saving}>
              {saving ? <Trans>Saving…</Trans> : t`Create ${slug || "row"}`}
            </Button>
          ) : (
            <div className="inline-flex">
              <Button
                variant="primary"
                size="sm"
                onClick={() => void submit({ close: true })}
                disabled={saving}
                className={cn("rounded-control rounded-r-none border-r-0")}
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
                    className={cn("rounded-control rounded-l-none border-l-0 px-2")}
                  >
                    <I.ChevronDown size={14} />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="z-[70]">
                  <DropdownMenuItem onSelect={() => void submit({ close: false })}>
                    <Trans>Save and continue</Trans>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  title?: ReactNode;
  description?: ReactNode;
  actionLabel?: string;
  destructive?: boolean;
  onConfirm?: () => void;
  onCancel?: () => void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  actionLabel,
  destructive,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const { t } = useLingui();
  const resolvedLabel = actionLabel ?? t`Confirm`;
  return (
    <AlertDialog open={open} onOpenChange={(o) => { if (!o) onCancel?.(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description ? <AlertDialogDescription>{description}</AlertDialogDescription> : null}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>
            <Trans>Cancel</Trans>
          </AlertDialogCancel>
          {/* Use the design-system destructive variant (soft red bg + red
              text) — the same treatment used across the app and cloud. */}
          <AlertDialogAction onClick={onConfirm} variant={destructive ? "destructive" : "default"}>
            {resolvedLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
