/**
 * The handful of primitives every example screen needs.
 *
 * Deliberately hand-rolled rather than pulled from `@backlex/ui`: these apps
 * are a *customer's* application, and a customer does not get the admin SPA's
 * design system. Anything awkward to build here is a gap in the API or the
 * docs, which is the point of the exercise. What they do share is `theme.css`
 * — the brand tokens, which are public.
 *
 * It lives here, in the shared workspace, because it previously lived TWICE:
 * `ecommerce-admin-react/src/lib/ui.tsx` and `fulfillment-ops/src/lib/ui.tsx`
 * were byte-for-byte identical. Two copies of a design system are two design
 * systems that have not drifted yet.
 *
 * Nothing below names a raw colour. Every surface, line and tone is a semantic
 * token from `theme.css`, so the same component renders correctly on the light
 * storefront palette and on the `.cosmos` dark one with no branch.
 */
import { type ReactNode, useEffect } from "react";

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

/* ── Icons ──────────────────────────────────────────────────────────────────
 * Drawn on a 20px grid at 1.5 stroke, currentColor throughout, so an icon
 * scales and recolours with the text beside it. The navs used to carry
 * geometric dingbats (▦ ◫ ▤ ◍ ▥ ◈ ◆ ➤) — those are glyphs from whatever font
 * happened to resolve, so they neither aligned nor tinted. */
const PATHS: Record<string, ReactNode> = {
  dashboard: (
    <>
      <rect x="2.75" y="2.75" width="6" height="6" rx="1.5" />
      <rect x="11.25" y="2.75" width="6" height="6" rx="1.5" />
      <rect x="2.75" y="11.25" width="6" height="6" rx="1.5" />
      <rect x="11.25" y="11.25" width="6" height="6" rx="1.5" />
    </>
  ),
  products: (
    <>
      <path d="M10 2.5 17 6v8l-7 3.5L3 14V6l7-3.5Z" />
      <path d="m3 6 7 3.5L17 6M10 9.5v8" />
    </>
  ),
  orders: (
    <>
      <path d="M4.5 2.75h11v14.5l-2.75-1.6-2.75 1.6-2.75-1.6L4.5 17.25V2.75Z" />
      <path d="M7.5 7h5M7.5 10.5h5" />
    </>
  ),
  customers: (
    <>
      <circle cx="10" cy="6.5" r="3.25" />
      <path d="M3.75 17c0-3.2 2.8-5 6.25-5s6.25 1.8 6.25 5" />
    </>
  ),
  inventory: (
    <>
      <path d="m10 2.75 7 3.5-7 3.5-7-3.5 7-3.5Z" />
      <path d="m3 10 7 3.5L17 10M3 13.75l7 3.5 7-3.5" />
    </>
  ),
  pricing: (
    <>
      <path d="M10.5 2.75H17v6.5l-7.75 7.75a1.5 1.5 0 0 1-2.12 0l-4.38-4.38a1.5 1.5 0 0 1 0-2.12L10.5 2.75Z" />
      <circle cx="13.5" cy="6.5" r="1.1" />
    </>
  ),
  discounts: (
    <>
      <path d="m5 15 10-10" />
      <circle cx="6.5" cy="6.5" r="2.25" />
      <circle cx="13.5" cy="13.5" r="2.25" />
    </>
  ),
  picking: (
    <>
      <rect x="3" y="4.5" width="14" height="12" rx="1.75" />
      <path d="M3 8.5h14M7.5 4.5v4" />
    </>
  ),
  shipments: (
    <>
      <path d="M2.5 6.5h9v7h-9v-7Z" />
      <path d="M11.5 9h3l3 2.5v2h-6V9Z" />
      <circle cx="5.5" cy="14.5" r="1.6" />
      <circle cx="14" cy="14.5" r="1.6" />
    </>
  ),
  campaigns: (
    <>
      <path d="M4 8.5v3a1.5 1.5 0 0 0 1.5 1.5H7l5 3.5v-13L7 7H5.5A1.5 1.5 0 0 0 4 8.5Z" />
      <path d="M14.5 7.5a3.5 3.5 0 0 1 0 5" />
    </>
  ),
  search: (
    <>
      <circle cx="9" cy="9" r="5.5" />
      <path d="M13.5 13.5 17 17" />
    </>
  ),
  close: <path d="m5.5 5.5 9 9m0-9-9 9" />,
  menu: <path d="M3.5 6h13M3.5 10h13M3.5 14h13" />,
  chevron: <path d="m5.5 8 4.5 4.5L14.5 8" />,
  alert: (
    <>
      <path d="M10 3.5 17.5 16.5h-15L10 3.5Z" />
      <path d="M10 8.5v3.5" />
      <circle cx="10" cy="14" r="0.9" fill="currentColor" stroke="none" />
    </>
  ),
  check: <path d="m4.5 10.5 4 4 7-9" />,
  signOut: (
    <>
      <path d="M12.5 14v1.5a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5v-11A1.5 1.5 0 0 1 5 3h6a1.5 1.5 0 0 1 1.5 1.5V6" />
      <path d="M8.5 10h8m0 0-2.5-2.5M16.5 10 14 12.5" />
    </>
  ),
  empty: (
    <>
      <rect x="3" y="4.5" width="14" height="11" rx="2" />
      <path d="M3 9h14" />
    </>
  ),
};

export type IconName = keyof typeof PATHS;

export function Icon({ name, className, size = 18 }: { name: IconName; className?: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}

/* ── Surfaces ───────────────────────────────────────────────────────────── */

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("rounded-surface border border-line bg-panel p-4 sm:p-5", className)}>{children}</div>;
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
        {subtitle ? <p className="mt-1 text-sm text-ink-muted">{subtitle}</p> : null}
      </div>
      {/* Actions hug the right edge on mobile too — the house convention. */}
      {actions ? <div className="ml-auto flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/* ── Controls ───────────────────────────────────────────────────────────── */

// `pointer-coarse:` — not a width breakpoint. A 36px control is fine under a
// mouse and too small under a thumb, and the two are not the same question: a
// touch laptop at 1440px still needs the 44px target.
const BTN =
  "inline-flex items-center justify-center gap-1.5 rounded-control px-3 py-1.5 text-sm font-medium transition pointer-coarse:min-h-11 disabled:opacity-50 disabled:pointer-events-none";

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
    default: "border border-line-strong bg-raised hover:border-ink-dim",
    primary: "bg-brand text-on-brand hover:opacity-90",
    danger: "border border-bad/40 bg-bad/10 text-bad hover:bg-bad/20",
    ghost: "text-ink-muted hover:text-ink hover:bg-raised",
  }[variant];
  return (
    <button type={type} onClick={onClick} disabled={disabled} title={title} className={cx(BTN, styles, className)}>
      {children}
    </button>
  );
}

/**
 * Everything a text control needs EXCEPT its width.
 *
 * The width is separate because Tailwind emits `w-*` utilities in a canonical
 * order, and `w-full` sits after `w-auto` / `w-24` / `w-40` in it. So the very
 * common `cx(inputCls, "w-40")` did NOT produce a 40-wide control — it produced
 * a full-width one, silently, in nine places across six of these apps. Reach for
 * `controlCls` whenever you are setting your own width.
 */
export const controlCls =
  "min-w-0 rounded-control border border-line-strong bg-surface px-3 py-1.5 text-sm outline-none transition pointer-coarse:min-h-11 focus:border-brand";

/** The common case: a control that fills its container. */
export const inputCls = `w-full ${controlCls}`;

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
      <span className="mb-1 block text-xs font-medium text-ink-muted">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-xs text-ink-dim">{hint}</span> : null}
    </label>
  );
}

/* ── Status ─────────────────────────────────────────────────────────────────
 * One shape, one meaning, both temperatures. The dot is not decoration: a
 * badge must never carry its meaning in colour alone, so every one of these
 * ships a dot AND the word. */
const TONES: Record<string, string> = {
  gray: "bg-raised text-ink-muted",
  slate: "bg-raised text-ink-dim",
  green: "bg-ok/15 text-ok",
  blue: "bg-info/15 text-info",
  amber: "bg-warn/15 text-warn",
  red: "bg-bad/15 text-bad",
  purple: "bg-state-todo/20 text-state-todo",
  teal: "bg-state-done/15 text-state-done",
  // The fulfillment pipeline, in order. These four are the only tones checked
  // for deuteranopia/tritanopia separation against BOTH surfaces, so a stacked
  // bar and a badge can share them. `gray` is deliberately NOT one of them: a
  // stage that has not happened yet is a stage, not an absence, and painting
  // "unfulfilled" in the neutral tone made a live axis look disabled.
  todo: "bg-state-todo/20 text-state-todo",
  doing: "bg-state-doing/18 text-state-doing",
  done: "bg-state-done/15 text-state-done",
  undone: "bg-state-undone/18 text-state-undone",
};

export function Badge({
  children,
  tone = "gray",
  dot = true,
}: {
  children: ReactNode;
  tone?: keyof typeof TONES | string;
  dot?: boolean;
}) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 rounded-pill px-2 py-0.5 text-xs font-medium",
        TONES[tone] ?? TONES.gray,
      )}
    >
      {dot ? <span className="size-1.5 rounded-pill bg-current" /> : null}
      {children}
    </span>
  );
}

/**
 * One axis of a record's state, named — and next to its column.
 *
 * An order carries three independent fields: where it is in its own life
 * (`state`), whether it is paid (`status`), and whether it has shipped
 * (`fulfillment_status`). Rendered as three bare badges in a row they read as
 * one thing in three colours, which is exactly the confusion the model exists
 * to prevent. Naming the axis, and printing the column it comes from, is what
 * makes "paid but unshipped" a sentence somebody can say out loud.
 */
export function StatusAxis({
  label,
  field,
  hint,
  children,
}: {
  label: string;
  field: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded-surface border border-line bg-panel p-3">
      <div className="mb-2 flex items-baseline gap-2">
        <span className="text-[11px] font-medium uppercase tracking-wider text-ink-dim">{label}</span>
        <code className="ml-auto font-mono text-[10.5px] text-ink-dim">{field}</code>
      </div>
      {children}
      {hint ? <p className="mt-2 text-xs leading-relaxed text-ink-dim">{hint}</p> : null}
    </div>
  );
}

/* ── Tables ─────────────────────────────────────────────────────────────── */

/** Wraps a wide table so the PAGE never scrolls sideways — only the table does. */
export function TableScroll({ children }: { children: ReactNode }) {
  return (
    <div className="-mx-4 overflow-x-auto sm:mx-0">
      <div className="inline-block min-w-full px-4 align-middle sm:px-0">{children}</div>
    </div>
  );
}

export function Table({ children }: { children: ReactNode }) {
  return <table className="min-w-full text-sm">{children}</table>;
}

export function Th({ children, className }: { children?: ReactNode; className?: string }) {
  return (
    <th
      className={cx(
        "whitespace-nowrap px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-ink-dim",
        className,
      )}
    >
      {children}
    </th>
  );
}

export function Td({ children, className }: { children?: ReactNode; className?: string }) {
  return <td className={cx("px-3 py-2 align-middle", className)}>{children}</td>;
}

/* ── Loading ────────────────────────────────────────────────────────────────
 * A loading state takes the SHAPE of what is arriving. Never a "Loading…"
 * string, never a bare spinner — a button's busy label ("Saving…") is fine. */

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx("animate-pulse rounded-control bg-ink/10", className)} />;
}

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

/** A list of rows — what a feed, a cart or a todo list resolves into. */
export function ListSkeleton({ rows = 5, className }: { rows?: number; className?: string }) {
  return (
    <div className={cx("divide-y divide-line rounded-surface border border-line bg-panel", className)}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3 p-3">
          <Skeleton className="size-4 shrink-0 rounded-pill" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-4 w-10 shrink-0" />
        </div>
      ))}
    </div>
  );
}

/** A grid of cards — what a catalogue resolves into. */
export function CardGridSkeleton({ count = 6, className }: { count?: number; className?: string }) {
  return (
    <div className={cx("grid grid-cols-2 gap-4 sm:grid-cols-3", className)}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="overflow-hidden rounded-surface border border-line bg-panel">
          <Skeleton className="aspect-square w-full rounded-none" />
          <div className="space-y-2 p-3">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-3 w-1/3" />
            <Skeleton className="mt-3 h-8 w-full" />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * The session gate's first paint, before `useSession()` has answered.
 *
 * It takes the shape of the sign-in card rather than of the app, because that
 * is what an unauthenticated visitor — the common case for a demo — is about
 * to get. Five examples used to render the string "Loading…" here.
 */
export function AuthGateSkeleton() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-surface p-6">
      <div className="w-full max-w-sm space-y-4 rounded-surface border border-line bg-panel p-6">
        <Skeleton className="h-6 w-28" />
        <div className="space-y-1.5">
          <Skeleton className="h-3 w-12" />
          <Skeleton className="h-9 w-full" />
        </div>
        <div className="space-y-1.5">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-9 w-full" />
        </div>
        <Skeleton className="h-9 w-full" />
      </div>
    </div>
  );
}

/** Whole-page first paint, before anything is known — including who you are. */
export function PageSkeleton() {
  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 p-6">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-4 w-64" />
        </div>
        <Skeleton className="h-8 w-20" />
      </div>
      <ListSkeleton rows={4} />
    </div>
  );
}

/* ── Empty + error ──────────────────────────────────────────────────────── */

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="rounded-surface border border-dashed border-line-strong px-6 py-12 text-center">
      <Icon name="empty" size={26} className="mx-auto mb-3 text-ink-dim" />
      <p className="font-medium text-ink">{title}</p>
      {hint ? <p className="mx-auto mt-1 max-w-md text-sm text-ink-muted">{hint}</p> : null}
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <div className="mb-4 flex items-start gap-2 rounded-control border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
      <Icon name="alert" size={16} className="mt-0.5 shrink-0" />
      <span>
        <span className="font-medium">Request failed — </span>
        {msg}
      </span>
    </div>
  );
}

/* ── Modal ──────────────────────────────────────────────────────────────── */

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
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      {/* Header and footer are pinned; only the body scrolls, and its cap is on
          the body itself rather than on a flex-1 that never resolves. */}
      <div className="flex max-h-[92vh] w-full max-w-xl flex-col overflow-hidden rounded-t-surface border border-line bg-panel sm:max-h-[85vh] sm:rounded-surface">
        <div className="flex shrink-0 items-center gap-3 border-b border-line px-5 py-3">
          <h2 className="min-w-0 flex-1 truncate font-semibold">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mr-1 shrink-0 rounded-control p-1.5 text-ink-muted transition hover:bg-raised hover:text-ink"
          >
            <Icon name="close" size={16} />
          </button>
        </div>
        <div className="max-h-[calc(92vh-9rem)] overflow-y-auto px-5 py-4 sm:max-h-[calc(85vh-8rem)]">{children}</div>
        {footer ? (
          <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>
        ) : null}
      </div>
    </div>
  );
}
