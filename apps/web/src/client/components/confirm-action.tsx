import { useState, type ReactNode } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@workeros/ui/components/alert-dialog";

interface ConfirmActionProps {
  title: string;
  description?: string;
  actionLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void | Promise<void>;
  children: ReactNode;
}

/**
 * Wraps a trigger element (button, menu item, etc.) with an AlertDialog
 * confirmation step. Replaces the native `window.confirm` everywhere.
 */
export const ConfirmAction = ({
  title,
  description,
  actionLabel,
  cancelLabel,
  destructive = false,
  onConfirm,
  children,
}: ConfirmActionProps) => {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const resolvedActionLabel = actionLabel ?? t`Confirm`;
  const resolvedCancelLabel = cancelLabel ?? t`Cancel`;

  const handle = async () => {
    setBusy(true);
    try {
      await onConfirm();
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>{children}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description && (
            <AlertDialogDescription>{description}</AlertDialogDescription>
          )}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>{resolvedCancelLabel}</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              void handle();
            }}
            className={destructive ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" : undefined}
            disabled={busy}
          >
            {busy ? <Trans>Working…</Trans> : resolvedActionLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
