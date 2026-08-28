/**
 * The handful of primitives every screen here needs.
 *
 * Deliberately hand-rolled rather than pulled from `@backlex/ui`: this app is
 * a customer's application, and a customer does not get the admin SPA's design
 * system. Anything awkward to build here is a gap in the API or the docs, which
 * is the point of the exercise.
 */
import { useEffect, useRef, type ReactNode } from "react";

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("rounded-xl border border-white/10 bg-white/[0.03] p-4 sm:p-5", className)}>{children}</div>;
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="truncate text-xl font-semibold tracking-tight sm:text-2xl">{title}</h1>
        {subtitle ? <p className="mt-1 text-sm text-white/50">{subtitle}</p> : null}
      </div>
      {/* Actions hug the right edge on mobile too — the house convention. */}
      {actions ? <div className="ml-auto flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

const BTN =
  "inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition disabled:opacity-50 disabled:pointer-events-none";

export function Button({
  children,
  onClick,
  variant = "default",
  type = "button",
  disabled,
  title,
  className,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "default" | "primary" | "danger" | "ghost";
  type?: "button" | "submit";
  disabled?: boolean;
  title?: string;
  className?: string;
}) {
  const styles = {
    default: "border border-white/15 bg-white/5 hover:bg-white/10",
    primary: "bg-indigo-500 text-white hover:bg-indigo-400",
    danger: "border border-red-500/30 bg-red-500/10 text-red-300 hover:bg-red-500/20",
    ghost: "text-white/60 hover:text-white hover:bg-white/5",
  }[variant];
  return (
    <button type={type} onClick={onClick} disabled={disabled} title={title} className={cx(BTN, styles, className)}>
      {children}
    </button>
  );
}

const TONES: Record<string, string> = {
  gray: "bg-white/10 text-white/70",
  green: "bg-emerald-500/15 text-emerald-300",
  blue: "bg-sky-500/15 text-sky-300",
  amber: "bg-amber-500/15 text-amber-300",
  red: "bg-red-500/15 text-red-300",
  purple: "bg-violet-500/15 text-violet-300",
  teal: "bg-teal-500/15 text-teal-300",
  slate: "bg-slate-500/20 text-slate-300",
};

export function Badge({ children, tone = "gray" }: { children: ReactNode; tone?: keyof typeof TONES | string }) {
  return (
    <span className={cx("inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium", TONES[tone] ?? TONES.gray)}>
      {children}
    </span>
  );
}

/** Wraps a wide table so the PAGE never scrolls sideways — only the table does. */
export function TableScroll({ children }: { children: ReactNode }) {
  return (
    <div className="-mx-4 overflow-x-auto sm:mx-0">
      <div className="inline-block min-w-full align-middle px-4 sm:px-0">{children}</div>
    </div>
  );
}

export function Table({ children }: { children: ReactNode }) {
  return <table className="min-w-full text-sm">{children}</table>;
}

export function Th({ children, className }: { children?: ReactNode; className?: string }) {
  return (
    <th className={cx("whitespace-nowrap px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-white/40", className)}>
      {children}
    </th>
  );
}

export function Td({ children, className }: { children?: ReactNode; className?: string }) {
  return <td className={cx("px-3 py-2 align-middle", className)}>{children}</td>;
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx("animate-pulse rounded bg-white/10", className)} />;
}

/** A table-shaped skeleton — never a "Loading…" string, never a bare spinner. */
export function TableSkeleton({ rows = 6, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex gap-3">
          {Array.from({ length: cols }, (_, c) => (
            <Skeleton key={c} className={cx("h-8", c === 0 ? "w-1/3" : "flex-1")} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-white/15 px-6 py-12 text-center">
      <p className="font-medium text-white/80">{title}</p>
      {hint ? <p className="mx-auto mt-1 max-w-md text-sm text-white/45">{hint}</p> : null}
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cx("block min-w-0", className)}>
      <span className="mb-1 block text-xs font-medium text-white/60">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-xs text-white/35">{hint}</span> : null}
    </label>
  );
}

export const inputCls =
  "w-full min-w-0 rounded-lg border border-white/15 bg-black/30 px-3 py-1.5 text-sm outline-none focus:border-indigo-400/60";

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      {/* Header and footer are pinned; only the body scrolls, and its cap is on
          the body itself rather than on a flex-1 that never resolves. */}
      <div ref={ref} className="flex max-h-[92vh] w-full max-w-xl flex-col overflow-hidden rounded-t-2xl border border-white/10 bg-[#0e1015] sm:max-h-[85vh] sm:rounded-2xl">
        <div className="shrink-0 border-b border-white/10 px-5 py-3">
          <h2 className="font-semibold">{title}</h2>
        </div>
        <div className="max-h-[calc(92vh-9rem)] overflow-y-auto px-5 py-4 sm:max-h-[calc(85vh-8rem)]">{children}</div>
        {footer ? <div className="shrink-0 flex flex-wrap justify-end gap-2 border-t border-white/10 px-5 py-3">{footer}</div> : null}
      </div>
    </div>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <div className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
      <span className="font-medium">Request failed — </span>
      {msg}
    </div>
  );
}
