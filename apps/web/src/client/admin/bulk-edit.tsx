// Bulk-edit dialog: apply ONE shared patch to many selected rows.
//
// Reuses the exact per-interface inputs from `item-form.tsx` (ItemFields +
// useItemForm) so there is one copy of the field-editing logic. The "only the
// fields you touch get written" semantics fall straight out of
// the form's `touched` map — on apply we send just the touched fields, leaving
// every other column on every selected row untouched.
import { useMemo, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { type CollectionSchema } from "./config";
import { type SchemaField, ItemFields, useItemForm } from "./item-form";
import { Button } from "./ui";
import { ScrollArea } from "@backlex/ui/components/scroll-area";
import { cn } from "@backlex/ui/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@backlex/ui/components/dialog";

// Structured / multi-value / localized types where "set the same value on N
// rows" is ambiguous or destructive — mirrors the server-side bulk guard. Plus
// long-form authored interfaces (richtext/markdown), which are an anti-pattern
// to fan out as a uniform blob. Single-record edit still handles all of these.
const BULK_BLOCKED_TYPES = new Set(["json", "file", "relation_many"]);
const BULK_BLOCKED_IFACES = new Set(["richtext", "markdown"]);

export const isBulkEditable = (f: SchemaField): boolean => {
  if ((f as { computed?: unknown }).computed) return false;
  // Same reason as computed: the server maintains a rollup from another
  // collection's rows and rejects a write to it.
  if ((f as { rollup?: unknown }).rollup) return false;
  if (f.type && BULK_BLOCKED_TYPES.has(f.type)) return false;
  if (f.interface && BULK_BLOCKED_IFACES.has(f.interface)) return false;
  return true;
};

export interface BulkEditDialogProps {
  open: boolean;
  /** Number of rows currently selected. */
  count: number;
  schema: CollectionSchema;
  onClose: () => void;
  /** Apply the shared patch. Resolves when the request settles; the parent owns
   *  closing the dialog + clearing the selection on success. */
  onApply: (data: Record<string, unknown>) => Promise<void>;
}

export function BulkEditDialog({ open, count, schema, onClose, onApply }: BulkEditDialogProps) {
  const { t } = useLingui();
  const [applying, setApplying] = useState(false);

  // The bulk surface is the collection's user fields narrowed to the editable
  // subset. Pass a schema with the filtered field list straight into the shared
  // form hook so every input renders exactly as it does in the single-row sheet.
  const bulkSchema = useMemo<CollectionSchema>(
    () => ({ ...schema, fields: (schema.fields ?? []).filter(isBulkEditable) }),
    [schema],
  );
  const form = useItemForm({ schema: bulkSchema, initial: null, active: open });

  // Only the fields the user actually edited are written. buildPayload covers
  // every field; we keep just the touched ones ("leave untouched" rule).
  const full = form.buildPayload() as Record<string, unknown>;
  const changedKeys = Object.keys(full).filter((k) => form.touched[k]);
  const changedCount = changedKeys.length;

  const apply = async () => {
    if (applying || changedCount === 0) return;
    const data: Record<string, unknown> = {};
    for (const k of changedKeys) data[k] = full[k];
    setApplying(true);
    try {
      await onApply(data);
    } finally {
      setApplying(false);
    }
  };

  if (!open) return null;
  const slug = schema?.slug ?? "";
  const noFields = bulkSchema.fields.length === 0;

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="grid max-h-[85vh] w-[94vw] grid-rows-[auto_auto_1fr_auto] gap-0 overflow-hidden border-border bg-card p-0 sm:max-w-[560px]">
        <DialogHeader className="flex flex-col gap-0.5 px-5 pb-3.5 pr-12 pt-[18px] border-b border-border">
          <DialogTitle className="text-base font-semibold tracking-[-0.01em]">
            <Trans>Bulk edit {count} rows</Trans>
          </DialogTitle>
          <DialogDescription className="text-[12.5px] text-muted-foreground">
            <Trans>
              Only the fields you change are written to all {count} selected rows in{" "}
              <span className="font-mono">c_{slug}</span>; everything else is left untouched.
            </Trans>
          </DialogDescription>
        </DialogHeader>

        <div className="border-b border-border bg-muted px-5 py-2 text-[12px] text-muted-foreground">
          {noFields ? (
            <Trans>No bulk-editable fields on this collection.</Trans>
          ) : changedCount === 0 ? (
            <Trans>Edit a field below to include it in the update.</Trans>
          ) : (
            <Trans>{changedCount} field(s) will change.</Trans>
          )}
        </div>

        <ScrollArea className="min-h-0">
          <div className="flex flex-col gap-8 px-5 py-[18px]">
            {noFields ? (
              <div className="rounded-control bg-muted p-3 text-[13px] text-muted-foreground">
                <Trans>
                  This collection has no fields that support bulk editing. Structured
                  (json / file / relation list / localized) and rich-text fields are edited per
                  record.
                </Trans>
              </div>
            ) : (
              <ItemFields form={form} />
            )}
          </div>
        </ScrollArea>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border bg-card px-5 py-3">
          <Button variant="ghost" size="sm" onClick={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => void apply()}
            disabled={applying || changedCount === 0}
            className={cn(changedCount === 0 && "opacity-60")}
          >
            {applying ? <Trans>Applying…</Trans> : t`Update ${count} rows`}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
