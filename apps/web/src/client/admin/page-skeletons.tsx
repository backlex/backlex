// Per-page loading skeletons for the admin SPA.
//
// Each exported component mirrors the coarse layout of the page it stands in
// for — a header strip, then the page's real body shape (card grid, table,
// two-column split, graph canvas …). They are rendered both as the lazy-page
// `<Suspense>` fallback (via `PageSkeleton`, dispatched on the active nav id)
// and as the in-page first-load placeholder, so the chunk-load → data-load →
// content transition is seamless.
//
// Every shimmer block comes from the shadcn `Skeleton` component (or the
// `loading.tsx` primitives that wrap it) — no hand-rolled animate-pulse.
import { Skeleton } from "@workeros/ui/components/skeleton";
import { type ComponentType, useEffect, useState } from "react";

/* ──────────────────────────────────────────────────────────────────────
 * Delayed-skeleton plumbing
 * ────────────────────────────────────────────────────────────────────── */

/**
 * Grace period before a skeleton is allowed to paint. On fast loads the
 * data / lazy chunk resolves inside this window and the skeleton component
 * unmounts before it ever rendered anything — so there is no split-second
 * flash. On slow loads the skeleton appears once the window elapses.
 */
const SKELETON_DELAY_MS = 200;

/**
 * Returns `false` for the first `SKELETON_DELAY_MS` after mount, then `true`.
 * The timer is cleared on unmount, so a component that unmounts early (its
 * `isLoading` flipped false / its Suspense chunk resolved) never flips to
 * `true` — that is what suppresses the fast-load flash.
 */
function useSkeletonDelay(): boolean {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setShow(true), SKELETON_DELAY_MS);
    return () => clearTimeout(id);
  }, []);
  return show;
}

/**
 * Wraps a skeleton component so it renders `null` until the delay elapses.
 * Applied once at every export below, so both the `<Suspense>` fallback and
 * the in-page `isLoading` gates inherit the delay without page edits.
 */
function withSkeletonDelay<P extends object>(Component: ComponentType<P>): ComponentType<P> {
  function Delayed(props: P) {
    if (!useSkeletonDelay()) return null;
    return <Component {...props} />;
  }
  Delayed.displayName = `Delayed(${Component.displayName ?? Component.name})`;
  return Delayed;
}

/* ──────────────────────────────────────────────────────────────────────
 * Shared building blocks
 * ────────────────────────────────────────────────────────────────────── */

/** Page header placeholder — title bar, optional description line, optional
 *  action buttons docked to the right. Matches the `PageHeader` component. */
function HeaderSkeleton({
  description = true,
  actions = 0,
}: {
  description?: boolean;
  actions?: number;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-[18px]">
      <div className="flex min-w-0 flex-col gap-2">
        <Skeleton className="h-7 w-44" />
        {description && <Skeleton className="h-4 w-[420px] max-w-full" />}
      </div>
      {actions > 0 && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {Array.from({ length: actions }).map((_, i) => (
            <Skeleton key={i} className="h-9 w-28" />
          ))}
        </div>
      )}
    </div>
  );
}

/** A rounded-2xl card shell with N body lines — the generic admin card. */
function CardSkeleton({ lines = 3, className = "" }: { lines?: number; className?: string }) {
  return (
    <div className={`flex flex-col gap-3 rounded-2xl border border-border bg-card p-4 ${className}`}>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} className={`h-4 ${i === 0 ? "w-1/2" : "w-full"}`} />
      ))}
    </div>
  );
}

/** A bordered card containing a faux table — header strip + N rows. */
function TableCardSkeleton({ rows = 7, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card">
      <div className="flex items-center gap-3 border-b border-border px-3.5 py-3">
        {Array.from({ length: cols }).map((_, i) => (
          <Skeleton key={i} className="h-3 flex-1" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div
          key={r}
          className="flex items-center gap-3 border-b border-border px-3.5 py-3 last:border-b-0"
        >
          {Array.from({ length: cols }).map((_, c) => (
            <Skeleton key={c} className="h-4 flex-1" style={{ maxWidth: c === 0 ? undefined : "70%" }} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** A tab strip placeholder. */
function TabStripSkeleton({ tabs = 3 }: { tabs?: number }) {
  return (
    <div className="flex gap-1.5">
      {Array.from({ length: tabs }).map((_, i) => (
        <Skeleton key={i} className="h-8 w-24 rounded-md" />
      ))}
    </div>
  );
}

/** A vertical list of rows inside a bordered card — left sidebar lists. */
function ListCardSkeleton({ rows = 6, header = true }: { rows?: number; header?: boolean }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card">
      {header && (
        <div className="border-b border-border px-4 py-3.5">
          <Skeleton className="h-4 w-24" />
        </div>
      )}
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="flex items-center gap-2.5 border-b border-border px-3.5 py-3 last:border-b-0"
        >
          <Skeleton className="size-4 shrink-0 rounded" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Skeleton className="h-3.5 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        </div>
      ))}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────
 * Per-page skeletons
 * ────────────────────────────────────────────────────────────────────── */

/** Ask AI — tab strip, tall prompt + plan card, recent-runs rail. */
function AskAiSkeletonImpl() {
  return (
    <div className="flex flex-col gap-5">
      <HeaderSkeleton actions={0} />
      <TabStripSkeleton tabs={4} />
      <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-[1fr_320px]">
        <div className="flex min-w-0 flex-col gap-5">
          {/* Prompt card */}
          <div className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-5">
            <div className="flex items-center gap-2">
              <Skeleton className="size-4 rounded" />
              <Skeleton className="h-3.5 w-44" />
              <div className="flex-1" />
              <Skeleton className="h-5 w-32 rounded-full" />
            </div>
            <Skeleton className="h-20 w-full" />
            <div className="flex items-center gap-2 pt-2">
              <Skeleton className="h-4 w-32" />
              <div className="flex-1" />
              <Skeleton className="h-8 w-20 rounded-full" />
              <Skeleton className="h-8 w-20 rounded-full" />
            </div>
          </div>
          {/* Plan card */}
          <div className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-5">
            <div className="flex items-center gap-2">
              <Skeleton className="size-6 rounded-full" />
              <Skeleton className="h-4 w-16" />
              <Skeleton className="h-5 w-32 rounded-full" />
            </div>
            <Skeleton className="h-3.5 w-3/4" />
            <Skeleton className="h-32 w-full rounded-xl" />
          </div>
        </div>
        {/* Recent runs rail */}
        <div className="flex flex-col gap-2 rounded-2xl border border-border bg-card p-4">
          <Skeleton className="h-4 w-28" />
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex flex-col gap-1.5 border-b border-border/60 py-2 last:border-b-0">
              <Skeleton className="h-3 w-3/4" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Overview — metric cards, quick actions, stat cards, then a 2-column split. */
function OverviewSkeletonImpl() {
  return (
    <div className="flex flex-col gap-4.5">
      <HeaderSkeleton actions={2} />
      {/* metric cards */}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex flex-col gap-2 rounded-2xl border border-border bg-card p-3.5">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-7 w-20" />
            <Skeleton className="mt-1.5 h-9 w-full" />
          </div>
        ))}
      </div>
      {/* quick actions */}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-2.5">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-[58px] w-full rounded-2xl" />
        ))}
      </div>
      {/* stat cards */}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <CardSkeleton key={i} lines={3} />
        ))}
      </div>
      {/* main split: tables + health */}
      <div className="grid grid-cols-[1fr_320px] items-start gap-4 max-[1280px]:grid-cols-1">
        <div className="flex min-w-0 flex-col gap-3.5">
          <TableCardSkeleton rows={5} cols={5} />
          <TableCardSkeleton rows={4} cols={3} />
        </div>
        <CardSkeleton lines={7} />
      </div>
    </div>
  );
}

/** Logs — the unified log explorer: header with the Stream/Table view switch,
 *  a search + range-filter row, the source-tab + export toolbar, the volume /
 *  level summary card, then the log-row stream. */
function LogsSkeletonImpl() {
  return (
    <div className="flex flex-col gap-[18px]">
      {/* Header — title + the Stream/Table tab switch and the Live button. */}
      <HeaderSkeleton actions={2} />
      {/* Search box + the time-range tab strip. */}
      <div className="flex items-center gap-2">
        <Skeleton className="h-9 flex-1" />
        <Skeleton className="h-8 w-44 rounded-md" />
      </div>
      {/* Source tabs (HTTP / Data / …) + the export button. */}
      <div className="flex items-center gap-2">
        <TabStripSkeleton tabs={5} />
        <div className="flex-1" />
        <Skeleton className="h-8 w-36 rounded-md" />
      </div>
      {/* Volume sparkline + level-filter summary card (info / warn / error). */}
      <div className="flex items-center gap-3.5 rounded-2xl border border-border bg-card p-3.5">
        <Skeleton className="h-11 flex-1" />
        <Skeleton className="h-8 w-20 rounded-md" />
        <Skeleton className="h-8 w-20 rounded-md" />
        <Skeleton className="h-8 w-20 rounded-md" />
      </div>
      {/* Log-row stream. */}
      <div className="overflow-hidden rounded-2xl border border-border bg-card">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="border-b border-border px-3.5 py-2.5 last:border-b-0">
            <Skeleton className="h-4 w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Database — header, tab strip, then a sidebar + editor split. */
function DatabaseSkeletonImpl() {
  return (
    <div className="flex flex-col gap-4.5">
      <HeaderSkeleton actions={0} />
      <TabStripSkeleton tabs={3} />
      <div className="grid grid-cols-[240px_minmax(0,1fr)] items-start gap-3.5 max-[900px]:grid-cols-[minmax(0,1fr)]">
        <div className="flex flex-col gap-2.5">
          <ListCardSkeleton rows={6} />
          <CardSkeleton lines={4} />
        </div>
        <div className="flex min-w-0 flex-col gap-3">
          <Skeleton className="h-[240px] w-full rounded-2xl" />
          <Skeleton className="h-[180px] w-full rounded-2xl" />
        </div>
      </div>
    </div>
  );
}

/** Flows — header, then a left list + a large preview pane. */
function FlowsSkeletonImpl() {
  return (
    <div className="flex flex-col gap-4.5">
      <HeaderSkeleton actions={1} />
      <div className="grid grid-cols-[320px_minmax(0,1fr)] items-start gap-3.5 max-[900px]:grid-cols-[minmax(0,1fr)]">
        <ListCardSkeleton rows={5} header={false} />
        <div className="flex flex-col gap-4.5 rounded-2xl border border-border bg-card p-[22px]">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-[220px] w-full rounded-2xl" />
          <Skeleton className="h-24 w-full rounded-2xl" />
        </div>
      </div>
    </div>
  );
}

/** Functions — header, then a left list + an editor pane. */
function FunctionsSkeletonImpl() {
  return (
    <div className="flex flex-col gap-4.5">
      <HeaderSkeleton actions={1} />
      <div className="grid grid-cols-[280px_minmax(0,1fr)] items-start gap-3.5 max-[900px]:grid-cols-[minmax(0,1fr)]">
        <ListCardSkeleton rows={6} />
        <div className="flex flex-col gap-3">
          <Skeleton className="h-[320px] w-full rounded-2xl" />
          <Skeleton className="h-[140px] w-full rounded-2xl" />
        </div>
      </div>
    </div>
  );
}

/** Webhooks — header, then a full-width webhooks table card stacked above a
 *  full-width "Recent deliveries" table card. */
function WebhooksSkeletonImpl() {
  return (
    <div className="flex flex-col gap-4.5">
      <HeaderSkeleton actions={1} />
      <TableCardSkeleton rows={6} cols={6} />
      <TableCardSkeleton rows={6} cols={6} />
    </div>
  );
}

/** Realtime — header, then a channel list + a tail pane. */
function RealtimeSkeletonImpl() {
  return (
    <div className="flex flex-col gap-4.5">
      <HeaderSkeleton actions={1} />
      <div className="grid grid-cols-[300px_minmax(0,1fr)] items-start gap-3.5 max-[900px]:grid-cols-[minmax(0,1fr)]">
        <ListCardSkeleton rows={5} header={false} />
        <Skeleton className="h-[440px] w-full rounded-2xl" />
      </div>
    </div>
  );
}

/** Advisor — header, the score card (circular score ring + 2 summary
 *  tiles), a 2-tab strip, then the findings list. */
function AdvisorSkeletonImpl() {
  return (
    <div className="flex flex-col gap-4.5">
      <HeaderSkeleton actions={1} />
      {/* Score card: ~140px score ring on the left + Security/Performance
          tiles, then a "Last run" line. */}
      <div className="grid grid-cols-[160px_1fr] items-center gap-[22px] rounded-2xl border border-border bg-card p-5">
        <Skeleton className="size-[140px] rounded-full" />
        <div className="flex flex-col gap-3.5">
          <div className="grid grid-cols-2 gap-3.5">
            {Array.from({ length: 2 }).map((_, i) => (
              <CardSkeleton key={i} lines={2} />
            ))}
          </div>
          <Skeleton className="h-3 w-32" />
        </div>
      </div>
      <TabStripSkeleton tabs={2} />
      <div className="flex flex-col gap-2.5">
        {Array.from({ length: 5 }).map((_, i) => (
          <CardSkeleton key={i} lines={2} />
        ))}
      </div>
    </div>
  );
}

/** Schema graph — header, then the ERD canvas card + a relations table. */
function SchemaGraphSkeletonImpl() {
  return (
    <div className="flex flex-col gap-4.5">
      <HeaderSkeleton actions={2} />
      <div className="overflow-hidden rounded-2xl border border-border bg-card">
        <div className="flex items-center gap-3 border-b border-border px-4 py-3.5">
          <Skeleton className="h-4 w-48" />
        </div>
        <div className="p-6">
          <Skeleton className="h-[360px] w-full rounded-xl" />
        </div>
      </div>
      <TableCardSkeleton rows={4} cols={6} />
    </div>
  );
}

/** Insights — header, then a dashboard grid of panel tiles. */
function InsightsSkeletonImpl() {
  return (
    <div className="flex flex-col gap-4.5">
      <HeaderSkeleton actions={2} />
      <div className="grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-[180px] w-full rounded-2xl" />
        ))}
      </div>
    </div>
  );
}

/** Revisions — header, then a 3-column items / timeline / detail split. */
function RevisionsSkeletonImpl() {
  return (
    <div className="flex flex-col gap-4.5">
      <HeaderSkeleton actions={0} />
      <div className="grid grid-cols-[280px_220px_minmax(0,1fr)] items-start gap-3.5 max-[1024px]:grid-cols-[minmax(0,1fr)]">
        <ListCardSkeleton rows={6} />
        <ListCardSkeleton rows={5} />
        <CardSkeleton lines={8} />
      </div>
    </div>
  );
}

/** Translations — header (3 actions), a locale-completion card, a controls
 *  row (base-locale select + All/Missing tabs + Manage locales), then the
 *  wide matrix table. */
function TranslationsSkeletonImpl() {
  return (
    <div className="flex flex-col gap-4.5">
      <HeaderSkeleton actions={3} />
      {/* Locale-completion card — one small progress tile per locale. */}
      <div className="grid grid-cols-4 gap-3 rounded-2xl border border-border bg-card p-3.5">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex flex-col gap-1.5">
            <Skeleton className="h-3 w-12" />
            <Skeleton className="h-3.5 w-full" />
          </div>
        ))}
      </div>
      {/* Controls row — base-locale select + All/Missing tabs + Manage locales. */}
      <div className="flex flex-wrap items-center gap-2">
        <Skeleton className="h-8 w-32 rounded-md" />
        <TabStripSkeleton tabs={2} />
        <div className="ml-auto">
          <Skeleton className="h-9 w-36" />
        </div>
      </div>
      <TableCardSkeleton rows={8} cols={4} />
    </div>
  );
}

/** Email templates — header, then a list + two editor columns. */
function EmailTemplatesSkeletonImpl() {
  return (
    <div className="flex flex-col gap-4.5">
      <HeaderSkeleton actions={1} />
      <div className="grid grid-cols-[240px_minmax(0,1fr)_minmax(0,1fr)] items-start gap-3.5 max-[1024px]:grid-cols-[minmax(0,1fr)]">
        <ListCardSkeleton rows={6} />
        <Skeleton className="h-[420px] w-full rounded-2xl" />
        <Skeleton className="h-[420px] w-full rounded-2xl" />
      </div>
    </div>
  );
}

/** Authentication — header, a Providers / Policy two-column split, then the
 *  full-width SAML and LDAP cards stacked below. */
function AuthSettingsSkeletonImpl() {
  return (
    <div className="flex flex-col gap-4.5">
      <HeaderSkeleton actions={0} />
      {/* Providers list (left) + Policy settings form (right). */}
      <div className="grid grid-cols-[1fr_320px] items-start gap-4 max-[1280px]:grid-cols-1">
        <ListCardSkeleton rows={5} />
        <CardSkeleton lines={7} />
      </div>
      {/* Full-width SAML 2.0 SSO + LDAP cards. */}
      <ListCardSkeleton rows={3} />
      <ListCardSkeleton rows={3} />
    </div>
  );
}

/** Users — header (1 action), a 4-up stat-card row, a filter bar, then a
 *  wide user table. */
function UsersSkeletonImpl() {
  return (
    <div className="flex flex-col gap-4.5">
      <HeaderSkeleton actions={1} />
      {/* Total users / Active 24h / Pending invites / Admins. */}
      <div className="grid grid-cols-4 gap-2.5 max-[900px]:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex flex-col gap-1 rounded-xl border border-border bg-card px-4 py-3.5">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-7 w-16" />
            <Skeleton className="h-3 w-20" />
          </div>
        ))}
      </div>
      <Skeleton className="h-9 w-full" />
      <TableCardSkeleton rows={8} cols={6} />
    </div>
  );
}

/** App users — header, then a table card whose inner strip carries an
 *  "End-users" title, a count, and a right-aligned filter input. */
function AppUsersSkeletonImpl() {
  return (
    <div className="flex flex-col gap-4.5">
      <HeaderSkeleton actions={0} />
      <div className="overflow-hidden rounded-2xl border border-border bg-card">
        {/* Card header strip — icon + "End-users" + count + filter input. */}
        <div className="flex items-center gap-2 border-b border-border px-4 py-3.5">
          <Skeleton className="size-3.5 shrink-0 rounded" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-3 w-8" />
          <div className="flex-1" />
          <Skeleton className="h-9 w-[240px]" />
        </div>
        {/* Faux table — column header + rows. */}
        <div className="flex items-center gap-3 border-b border-border px-3.5 py-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-3 flex-1" />
          ))}
        </div>
        {Array.from({ length: 7 }).map((_, r) => (
          <div
            key={r}
            className="flex items-center gap-3 border-b border-border px-3.5 py-3 last:border-b-0"
          >
            {Array.from({ length: 6 }).map((_, c) => (
              <Skeleton
                key={c}
                className="h-4 flex-1"
                style={{ maxWidth: c === 0 ? undefined : "70%" }}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/** API keys — header, then a card holding a key list. */
function ApiKeysSkeletonImpl() {
  return (
    <div className="flex flex-col gap-5">
      <HeaderSkeleton actions={1} />
      <div className="rounded-2xl border border-border bg-card p-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div
            key={i}
            className="flex items-start justify-between gap-4 border-b border-border py-3 last:border-b-0"
          >
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-3 w-28" />
            </div>
            <Skeleton className="size-8 rounded-full" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Settings — header, tab strip, then a stack of settings cards. */
function SettingsSkeletonImpl() {
  return (
    <div className="flex flex-col gap-4.5">
      <HeaderSkeleton actions={0} />
      <TabStripSkeleton tabs={6} />
      {Array.from({ length: 3 }).map((_, i) => (
        <CardSkeleton key={i} lines={5} />
      ))}
    </div>
  );
}

/** Account — header, a 4-tab strip (Profile / Security / Sessions /
 *  Connected), then the default tab's `max-w-3xl` card. */
function AccountSkeletonImpl() {
  return (
    <div className="flex flex-col gap-5">
      <HeaderSkeleton actions={0} />
      <TabStripSkeleton tabs={4} />
      <CardSkeleton lines={6} className="max-w-3xl" />
    </div>
  );
}

/** Storage — header (3 actions), the drag-and-drop upload banner, then a
 *  folder sidebar + a file grid. */
function StorageSkeletonImpl() {
  return (
    <div className="flex flex-col gap-[18px]">
      <HeaderSkeleton actions={3} />
      {/* Full-width drag-and-drop upload zone. */}
      <Skeleton className="h-[72px] w-full rounded-2xl" />
      <div className="grid grid-cols-[240px_minmax(0,1fr)] items-start gap-3.5 max-[900px]:grid-cols-[minmax(0,1fr)]">
        <ListCardSkeleton rows={6} />
        <div className="overflow-hidden rounded-2xl border border-border bg-card p-3">
          <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-[140px] w-full rounded-xl" />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Collections index — header (up to 4 actions), a full-width search bar,
 *  then a grid of collection cards. */
function CollectionsSkeletonImpl() {
  return (
    <div className="flex flex-col gap-4.5">
      <HeaderSkeleton actions={4} />
      <Skeleton className="h-9 w-full" />
      <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,280px),1fr))] gap-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-[138px] w-full rounded-2xl" />
        ))}
      </div>
    </div>
  );
}

/** Collection detail — back link, header, tab strip, then an items grid. */
function CollectionItemsSkeletonImpl() {
  return (
    <div className="flex flex-col gap-4.5">
      <Skeleton className="h-8 w-32" />
      <HeaderSkeleton actions={3} />
      <TabStripSkeleton tabs={3} />
      <div className="grid grid-cols-[1fr_320px] items-start gap-4 max-[1024px]:grid-cols-1">
        <div className="flex min-w-0 flex-col gap-3">
          <Skeleton className="h-10 w-full rounded-xl" />
          <TableCardSkeleton rows={8} cols={5} />
        </div>
        <Skeleton className="h-[360px] w-full rounded-2xl" />
      </div>
    </div>
  );
}

/** REST Explorer — header, then an endpoint list + a request pane. */
function RestExplorerSkeletonImpl() {
  return (
    <div className="flex flex-col gap-6">
      <HeaderSkeleton actions={0} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
        <ListCardSkeleton rows={8} />
        <Skeleton className="h-[480px] w-full rounded-2xl" />
      </div>
    </div>
  );
}

/** GraphQL — header, then a schema tree + an editor pane. */
function GraphqlSkeletonImpl() {
  return (
    <div className="flex flex-col gap-6">
      <HeaderSkeleton actions={1} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
        <ListCardSkeleton rows={7} />
        <Skeleton className="h-[480px] w-full rounded-2xl" />
      </div>
    </div>
  );
}

/** OpenAPI — header, then a summary card + a paths card. */
function OpenApiSkeletonImpl() {
  return (
    <div className="flex flex-col gap-6">
      <HeaderSkeleton actions={3} />
      <CardSkeleton lines={4} />
      <CardSkeleton lines={8} />
    </div>
  );
}

/** Access (roles & permissions) — header, a Members / Roles & permissions
 *  tab strip, then the roles + members tables. */
function AccessSkeletonImpl() {
  return (
    <div className="flex flex-col gap-[18px]">
      <HeaderSkeleton actions={0} />
      <TabStripSkeleton tabs={2} />
      <TableCardSkeleton rows={5} cols={4} />
      <TableCardSkeleton rows={6} cols={5} />
    </div>
  );
}

/** Generic fallback — a header + card stack, used when a nav id has no
 *  dedicated skeleton. */
function GenericSkeletonImpl() {
  return (
    <div className="flex flex-col gap-4.5">
      <HeaderSkeleton actions={1} />
      {Array.from({ length: 3 }).map((_, i) => (
        <CardSkeleton key={i} lines={4} />
      ))}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────
 * Delayed exports
 *
 * Every page skeleton is exported through `withSkeletonDelay`, so it renders
 * nothing for the first `SKELETON_DELAY_MS` after it mounts. This covers both
 * use sites without any page edits: the `<Suspense>` fallback (`PageSkeleton`
 * delegates to these) and the in-page `if (isLoading) return <XxxSkeleton/>`
 * gates. A load that resolves inside the window unmounts the skeleton before
 * the timer fires — straight to content, no flash.
 * ────────────────────────────────────────────────────────────────────── */

export const OverviewSkeleton = withSkeletonDelay(OverviewSkeletonImpl);
export const AskAiSkeleton = withSkeletonDelay(AskAiSkeletonImpl);
export const LogsSkeleton = withSkeletonDelay(LogsSkeletonImpl);
export const DatabaseSkeleton = withSkeletonDelay(DatabaseSkeletonImpl);
export const FlowsSkeleton = withSkeletonDelay(FlowsSkeletonImpl);
export const FunctionsSkeleton = withSkeletonDelay(FunctionsSkeletonImpl);
export const WebhooksSkeleton = withSkeletonDelay(WebhooksSkeletonImpl);
export const RealtimeSkeleton = withSkeletonDelay(RealtimeSkeletonImpl);
export const AdvisorSkeleton = withSkeletonDelay(AdvisorSkeletonImpl);
export const SchemaGraphSkeleton = withSkeletonDelay(SchemaGraphSkeletonImpl);
export const InsightsSkeleton = withSkeletonDelay(InsightsSkeletonImpl);
export const RevisionsSkeleton = withSkeletonDelay(RevisionsSkeletonImpl);
export const TranslationsSkeleton = withSkeletonDelay(TranslationsSkeletonImpl);
export const EmailTemplatesSkeleton = withSkeletonDelay(EmailTemplatesSkeletonImpl);
export const AuthSettingsSkeleton = withSkeletonDelay(AuthSettingsSkeletonImpl);
export const UsersSkeleton = withSkeletonDelay(UsersSkeletonImpl);
export const AppUsersSkeleton = withSkeletonDelay(AppUsersSkeletonImpl);
export const ApiKeysSkeleton = withSkeletonDelay(ApiKeysSkeletonImpl);
export const SettingsSkeleton = withSkeletonDelay(SettingsSkeletonImpl);
export const AccountSkeleton = withSkeletonDelay(AccountSkeletonImpl);
export const StorageSkeleton = withSkeletonDelay(StorageSkeletonImpl);
export const CollectionsSkeleton = withSkeletonDelay(CollectionsSkeletonImpl);
export const CollectionItemsSkeleton = withSkeletonDelay(CollectionItemsSkeletonImpl);
export const RestExplorerSkeleton = withSkeletonDelay(RestExplorerSkeletonImpl);
export const GraphqlSkeleton = withSkeletonDelay(GraphqlSkeletonImpl);
export const OpenApiSkeleton = withSkeletonDelay(OpenApiSkeletonImpl);
export const AccessSkeleton = withSkeletonDelay(AccessSkeletonImpl);
const GenericSkeleton = withSkeletonDelay(GenericSkeletonImpl);

/* ──────────────────────────────────────────────────────────────────────
 * Dispatcher
 * ────────────────────────────────────────────────────────────────────── */

/**
 * Resolves a nav id to its matching page skeleton. Used as the lazy-page
 * `<Suspense>` fallback so the chunk-loading placeholder already mirrors the
 * page being opened. Falls back to a generic header + card stack.
 *
 * `PageSkeleton` is intentionally NOT itself wrapped in `withSkeletonDelay` —
 * every branch delegates to an already-delayed component, so wrapping here too
 * would stack the delay to ~400ms.
 */
export function PageSkeleton({ nav }: { nav: string }) {
  switch (nav) {
    case "overview":
      return <OverviewSkeleton />;
    case "ask-ai":
      return <AskAiSkeleton />;
    case "collections":
      return <CollectionsSkeleton />;
    case "access":
      return <AccessSkeleton />;
    case "database":
      return <DatabaseSkeleton />;
    case "storage":
      return <StorageSkeleton />;
    case "flows":
      return <FlowsSkeleton />;
    case "functions":
      return <FunctionsSkeleton />;
    case "webhooks":
      return <WebhooksSkeleton />;
    case "realtime":
      return <RealtimeSkeleton />;
    case "logs":
      return <LogsSkeleton />;
    case "advisor":
      return <AdvisorSkeleton />;
    case "schema-graph":
      return <SchemaGraphSkeleton />;
    case "insights":
      return <InsightsSkeleton />;
    case "revisions":
      return <RevisionsSkeleton />;
    case "translations":
      return <TranslationsSkeleton />;
    case "rest-explorer":
      return <RestExplorerSkeleton />;
    case "graphql":
      return <GraphqlSkeleton />;
    case "openapi":
      return <OpenApiSkeleton />;
    case "authentication":
      return <AuthSettingsSkeleton />;
    case "users":
      return <UsersSkeleton />;
    case "app-users":
      return <AppUsersSkeleton />;
    case "api-keys":
      return <ApiKeysSkeleton />;
    case "email-templates":
      return <EmailTemplatesSkeleton />;
    case "settings":
      return <SettingsSkeleton />;
    case "account":
      return <AccountSkeleton />;
    default:
      return <GenericSkeleton />;
  }
}
