import { toast } from "@workeros/ui/components/sonner";

/**
 * Surface an API or runtime error as a toast. Centralizes the
 * `setError(e.message)` pattern that was scattered across pages — each call
 * site now does `notifyError(e, "while saving")` and the user sees a clear
 * destructive toast instead of a buried `<p>` at the bottom of the form.
 */
export const notifyError = (err: unknown, context?: string): void => {
  const message =
    err instanceof Error ? err.message : typeof err === "string" ? err : "Unknown error";
  toast.error(context ? `${context}: ${message}` : message);
};
