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
import { Card } from "@backlex/ui/components/card";
import { Skeleton } from "@backlex/ui/components/skeleton";
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

/** A rounded-surface card shell with N body lines — the generic admin card. */
function CardSkeleton({ lines = 3, className = "" }: { lines?: number; className?: string }) {
  return (
    <Card className={`gap-3 p-4 ${className}`}>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} className={`h-4 ${i === 0 ? "w-1/2" : "w-full"}`} />
      ))}
    </Card>
  );
}

/** A bordered card containing a faux table — header strip + N rows. */
function TableCardSkeleton({ rows = 7, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <Card className="gap-0 py-0">
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
    </Card>
  );
}

/** A tab strip placeholder. Clips to the column width (`max-w-full
 *  overflow-hidden`) so the fixed-width tab blocks can't spill past the right
 *  edge on narrow viewports — the real tab strips scroll inside their own
 *  width rather than widening the page. */
function TabStripSkeleton({ tabs = 3 }: { tabs?: number }) {
  return (
    <div className="flex max-w-full gap-1.5 overflow-hidden">
      {Array.from({ length: tabs }).map((_, i) => (
        <Skeleton key={i} className="h-8 w-24 shrink-0 rounded-control" />
      ))}
    </div>
  );
}

/** A vertical list of rows inside a bordered card — left sidebar lists. */
function ListCardSkeleton({ rows = 6, header = true }: { rows?: number; header?: boolean }) {
  return (
    <Card className="gap-0 py-0">
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
          <Skeleton className="size-4 shrink-0 rounded-sm" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Skeleton className="h-3.5 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        </div>
      ))}
    </Card>
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
          <Card className="gap-3 p-5">
            <div className="flex items-center gap-2">
              <Skeleton className="size-4 rounded-sm" />
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
          </Card>
          {/* Plan card */}
          <Card className="gap-3 p-5">
            <div className="flex items-center gap-2">
              <Skeleton className="size-6 rounded-full" />
              <Skeleton className="h-4 w-16" />
              <Skeleton className="h-5 w-32 rounded-full" />
            </div>
            <Skeleton className="h-3.5 w-3/4" />
            <Skeleton className="h-32 w-full rounded-control" />
          </Card>
        </div>
        {/* Recent runs rail */}
        <Card className="gap-2 p-4">
          <Skeleton className="h-4 w-28" />
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex flex-col gap-1.5 border-b border-border/60 py-2 last:border-b-0">
              <Skeleton className="h-3 w-3/4" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          ))}
        </Card>
      </div>
    </div>
  );
}

/** Overview — metric cards, quick actions, stat cards, then a 2-column split. */
function OverviewSkeletonImpl() {
  return (
    <div className="flex flex-col gap-4.5">
      <HeaderSkeleton actions={2} />
      {/* metric cards — mirrors the live slider: a single full-width card plus
          slide bullets on mobile, the auto-fit grid on sm+. */}
      <div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[repeat(auto-fit,minmax(220px,1fr))]">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i} className={`gap-2 p-3.5${i > 0 ? " hidden sm:flex" : ""}`}>
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-7 w-20" />
              <Skeleton className="mt-1.5 h-9 w-full" />
            </Card>
          ))}
        </div>
        <div className="mt-2.5 flex justify-center gap-1.5 sm:hidden">
          {Array.from({ length: 4 }).map((_, i) => (
            <span
              key={i}
              className={`h-1.5 rounded-full ${i === 0 ? "w-4 bg-muted-foreground/40" : "w-1.5 bg-muted-foreground/20"}`}
            />
          ))}
        </div>
      </div>
      {/* quick actions */}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-2.5">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-[58px] w-full rounded-surface" />
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
/** Usage page: header (window select + Limits + Refresh), 2×2→4-up stat
 *  tiles with limit bars, the per-day chart card, then the per-key table. */
function UsageSkeletonImpl() {
  return (
    <div className="flex flex-col gap-[18px]">
      <HeaderSkeleton actions={4} />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i} className="gap-2 px-[15px] py-3.5">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-7 w-16" />
            <Skeleton className="h-3 w-20" />
          </Card>
        ))}
      </div>
      <Card className="gap-2 px-4 py-3.5">
        <div className="flex items-center justify-between gap-2">
          <Skeleton className="h-3 w-32" />
          <Skeleton className="h-9 w-[170px]" />
        </div>
        <Skeleton className="h-[120px] w-full" />
      </Card>
      <TableCardSkeleton rows={4} cols={5} />
    </div>
  );
}

function LogsSkeletonImpl() {
  return (
    <div className="flex flex-col gap-[18px]">
      {/* Header — title + the Stream/Table tab switch and the Live button. */}
      <HeaderSkeleton actions={2} />
      {/* Search box + the time-range tab strip. */}
      <div className="flex items-center gap-2">
        <Skeleton className="h-9 flex-1" />
        <Skeleton className="h-8 w-44 rounded-control" />
      </div>
      {/* Source tabs (HTTP / Data / …) + the export button. The lens strip
          claims the row width and clips its own overflow (`min-w-0 flex-1
          overflow-hidden`), so the five fixed-width tab blocks can't push the
          export button off-screen on narrow viewports — mirroring the real
          toolbar, where TabsList scrolls inside a flex-1 strip and the export
          button collapses to an icon-only square under `sm`. */}
      <div className="flex items-center gap-2">
        <div className="flex min-w-0 flex-1 gap-1.5 overflow-hidden">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-8 w-24 shrink-0 rounded-control" />
          ))}
        </div>
        <Skeleton className="h-8 w-9 shrink-0 rounded-control sm:w-36" />
      </div>
      {/* Volume sparkline + level-filter summary card (info / warn / error).
          Stacks vertically on mobile and goes side-by-side at `sm`, matching
          the real summary card. */}
      <Card className="flex flex-col gap-3 p-3.5 sm:flex-row sm:items-center sm:gap-3.5">
        <Skeleton className="h-11 w-full sm:flex-1" />
        <div className="flex flex-wrap justify-end gap-2 sm:justify-start">
          <Skeleton className="h-8 w-20 rounded-control" />
          <Skeleton className="h-8 w-20 rounded-control" />
          <Skeleton className="h-8 w-20 rounded-control" />
        </div>
      </Card>
      {/* Log-row stream. */}
      <Card className="gap-0 py-0">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="border-b border-border px-3.5 py-2.5 last:border-b-0">
            <Skeleton className="h-4 w-full" />
          </div>
        ))}
      </Card>
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
          <Skeleton className="h-[240px] w-full rounded-surface" />
          <Skeleton className="h-[180px] w-full rounded-surface" />
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
        <Card className="gap-4.5 p-[22px]">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-[220px] w-full rounded-surface" />
          <Skeleton className="h-24 w-full rounded-surface" />
        </Card>
      </div>
    </div>
  );
}

/** Agents — header, a left list of definitions, and the summary panel: badges,
 *  a 2-up spec grid, then the tool allow-list and system prompt blocks. */
function AgentsSkeletonImpl() {
  return (
    <div className="flex flex-col gap-4.5">
      <HeaderSkeleton actions={1} />
      <div className="grid grid-cols-[320px_minmax(0,1fr)] items-start gap-3.5 max-[900px]:grid-cols-[minmax(0,1fr)]">
        <ListCardSkeleton rows={4} header={false} />
        <Card className="gap-4.5 p-[22px]">
          <div className="flex flex-wrap items-center gap-2.5">
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-5 w-24 rounded-full" />
            <Skeleton className="h-5 w-20 rounded-full" />
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-3 max-[560px]:grid-cols-1">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="flex flex-col gap-1.5">
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-4 w-16" />
              </div>
            ))}
          </div>
          <Skeleton className="h-[120px] w-full rounded-control" />
          <Skeleton className="h-[140px] w-full rounded-control" />
        </Card>
      </div>
    </div>
  );
}

/** Chat — header, a left room list, and the room pane: title row, agent chips,
 *  the routing selects, then the transcript box. Matches the live heights so
 *  the page doesn't jump when it loads. */
function ChatSkeletonImpl() {
  return (
    <div className="flex flex-col gap-4.5">
      <HeaderSkeleton actions={1} />
      <div className="grid grid-cols-[300px_minmax(0,1fr)] items-start gap-3.5 max-[900px]:grid-cols-[minmax(0,1fr)]">
        <ListCardSkeleton rows={4} header={false} />
        <Card className="gap-4 p-[22px]">
          <div className="flex items-center gap-2.5">
            <Skeleton className="h-6 w-44" />
            <Skeleton className="ml-auto h-8 w-24 rounded-control" />
          </div>
          <div className="flex flex-wrap gap-2">
            <Skeleton className="h-5 w-28 rounded-full" />
            <Skeleton className="h-5 w-24 rounded-full" />
          </div>
          <div className="grid grid-cols-2 gap-3 max-[560px]:grid-cols-1">
            <Skeleton className="h-9 w-full rounded-control" />
            <Skeleton className="h-9 w-full rounded-control" />
          </div>
          <Skeleton className="h-[460px] w-full rounded-control max-[640px]:h-[420px]" />
        </Card>
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
          <Skeleton className="h-[320px] w-full rounded-surface" />
          <Skeleton className="h-[140px] w-full rounded-surface" />
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

/** Payments — header, the three provider cards, then the deliveries table. */
function PaymentsSkeletonImpl() {
  return (
    <div className="flex flex-col gap-4.5">
      <HeaderSkeleton actions={0} />
      <div className="grid grid-cols-3 gap-3 max-[920px]:grid-cols-2 max-[560px]:grid-cols-1">
        {[0, 1, 2].map((i) => (
          <CardSkeleton key={i} lines={2} className="h-[152px]" />
        ))}
      </div>
      <TableCardSkeleton rows={5} cols={4} />
    </div>
  );
}

/** Extensions — header (install), then the extensions table card
 *  (extension / source / contributes / enabled / actions). */
function ExtensionsSkeletonImpl() {
  return (
    <div className="flex flex-col gap-4.5">
      <HeaderSkeleton actions={1} />
      <TableCardSkeleton rows={4} cols={5} />
    </div>
  );
}

/** Forms — header (refresh + new form), then the forms table card
 *  (name / collection / fields / active / actions). */
function FormsSkeletonImpl() {
  return (
    <div className="flex flex-col gap-4.5">
      <HeaderSkeleton actions={2} />
      <TableCardSkeleton rows={5} cols={5} />
    </div>
  );
}

/** Search playground — header, the controls card (collection / query / mode /
 *  button row), then the empty-state area where results land. */
function SearchPlaygroundSkeletonImpl() {
  return (
    <div className="flex flex-col gap-4.5">
      <HeaderSkeleton actions={0} />
      <Card className="p-4">
        <div className="grid grid-cols-[220px_minmax(0,1fr)_170px_auto] items-end gap-2.5 max-[820px]:grid-cols-1">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex flex-col gap-1.5">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-9 w-full rounded-control" />
            </div>
          ))}
          <Skeleton className="h-9 w-24 rounded-control max-[820px]:justify-self-end" />
        </div>
      </Card>
      <Skeleton className="h-[180px] w-full rounded-surface" />
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
        <Skeleton className="h-[440px] w-full rounded-surface" />
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
      <Card className="grid grid-cols-[160px_1fr] items-center gap-[22px] p-5 max-[640px]:grid-cols-1 max-[640px]:justify-items-center">
        <Skeleton className="size-[140px] rounded-full" />
        <div className="flex flex-col gap-3.5">
          <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
            {Array.from({ length: 2 }).map((_, i) => (
              <CardSkeleton key={i} lines={2} />
            ))}
          </div>
          <Skeleton className="h-3 w-32" />
        </div>
      </Card>
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
      <Card className="gap-0 py-0">
        <div className="flex items-center gap-3 border-b border-border px-4 py-3.5">
          <Skeleton className="h-4 w-48" />
        </div>
        <div className="p-6">
          <Skeleton className="h-[360px] w-full rounded-control" />
        </div>
      </Card>
      <TableCardSkeleton rows={4} cols={6} />
    </div>
  );
}

/** Schema versions — header, a tab strip, then the snapshots/branches table. */
function SchemaVersionsSkeletonImpl() {
  return (
    <div className="flex flex-col gap-6">
      <HeaderSkeleton actions={2} />
      <div className="flex items-center gap-4 border-b pb-2">
        <Skeleton className="h-5 w-28" />
        <Skeleton className="h-5 w-24" />
      </div>
      <TableCardSkeleton rows={5} cols={4} />
    </div>
  );
}

/** Database import — header, then the two stacked cards (sources + runs). */
function DatabaseImportSkeletonImpl() {
  return (
    <div className="flex flex-col gap-4.5">
      <HeaderSkeleton actions={3} />
      <TableCardSkeleton rows={2} cols={3} />
      <TableCardSkeleton rows={3} cols={4} />
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
          <Skeleton key={i} className="h-[180px] w-full rounded-surface" />
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
      <Card className="grid grid-cols-4 gap-3 p-3.5">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex flex-col gap-1.5">
            <Skeleton className="h-3 w-12" />
            <Skeleton className="h-3.5 w-full" />
          </div>
        ))}
      </Card>
      {/* Controls row — base-locale select + All/Missing tabs + Manage locales. */}
      <div className="flex flex-wrap items-center gap-2">
        <Skeleton className="h-8 w-32 rounded-control" />
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
        <Skeleton className="h-[420px] w-full rounded-surface" />
        <Skeleton className="h-[420px] w-full rounded-surface" />
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
          <div key={i} className="flex flex-col gap-1 rounded-control border border-border bg-card px-4 py-3.5">
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
      <Card className="gap-0 py-0">
        {/* Card header strip — icon + "End-users" + count + filter input. */}
        <div className="flex items-center gap-2 border-b border-border px-4 py-3.5">
          <Skeleton className="size-3.5 shrink-0 rounded-sm" />
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
      </Card>
    </div>
  );
}

/** API keys — header, then a card holding a key list. */
function ApiKeysSkeletonImpl() {
  return (
    <div className="flex flex-col gap-5">
      <HeaderSkeleton actions={1} />
      <Card className="gap-0 p-4">
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
      </Card>
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
      <Skeleton className="h-[72px] w-full rounded-surface" />
      <div className="grid grid-cols-[240px_minmax(0,1fr)] items-start gap-3.5 max-[900px]:grid-cols-[minmax(0,1fr)]">
        <ListCardSkeleton rows={6} />
        <Card className="gap-0 p-3">
          <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-[140px] w-full rounded-control" />
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}

/** Collections index — header (up to 5 actions: archived toggle, edit layout,
 *  schema, API docs, new), a full-width search bar, then a grid of cards. */
function CollectionsSkeletonImpl() {
  return (
    <div className="flex flex-col gap-4.5">
      <HeaderSkeleton actions={5} />
      <Skeleton className="h-9 w-full" />
      <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,280px),1fr))] gap-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-[138px] w-full rounded-surface" />
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
      {/* Single column: the live-tail widget is hidden by default, so the real
          page renders one column (the 320px right panel only appears when the
          user toggles "Live tail" on). */}
      <div className="flex min-w-0 flex-col gap-3">
        <Skeleton className="h-10 w-full rounded-control" />
        <TableCardSkeleton rows={8} cols={5} />
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
        <Skeleton className="h-[480px] w-full rounded-surface" />
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
        <Skeleton className="h-[480px] w-full rounded-surface" />
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
export const UsageSkeleton = withSkeletonDelay(UsageSkeletonImpl);
export const DatabaseSkeleton = withSkeletonDelay(DatabaseSkeletonImpl);
export const FlowsSkeleton = withSkeletonDelay(FlowsSkeletonImpl);
export const AgentsSkeleton = withSkeletonDelay(AgentsSkeletonImpl);
export const ChatSkeleton = withSkeletonDelay(ChatSkeletonImpl);
export const FunctionsSkeleton = withSkeletonDelay(FunctionsSkeletonImpl);
export const WebhooksSkeleton = withSkeletonDelay(WebhooksSkeletonImpl);
export const ExtensionsSkeleton = withSkeletonDelay(ExtensionsSkeletonImpl);
export const PaymentsSkeleton = withSkeletonDelay(PaymentsSkeletonImpl);
export const FormsSkeleton = withSkeletonDelay(FormsSkeletonImpl);
export const RealtimeSkeleton = withSkeletonDelay(RealtimeSkeletonImpl);
export const SearchPlaygroundSkeleton = withSkeletonDelay(SearchPlaygroundSkeletonImpl);
export const AdvisorSkeleton = withSkeletonDelay(AdvisorSkeletonImpl);
export const SchemaGraphSkeleton = withSkeletonDelay(SchemaGraphSkeletonImpl);
export const SchemaVersionsSkeleton = withSkeletonDelay(SchemaVersionsSkeletonImpl);
export const DatabaseImportSkeleton = withSkeletonDelay(DatabaseImportSkeletonImpl);
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
    case "agents":
      return <AgentsSkeleton />;
    case "chat":
      return <ChatSkeleton />;
    case "functions":
      return <FunctionsSkeleton />;
    case "webhooks":
    case "integrations":
      return <WebhooksSkeleton />;
    case "payments":
      return <PaymentsSkeleton />;
    case "extensions":
      return <ExtensionsSkeleton />;
    case "forms":
      return <FormsSkeleton />;
    case "realtime":
      return <RealtimeSkeleton />;
    case "search":
      return <SearchPlaygroundSkeleton />;
    case "logs":
      return <LogsSkeleton />;
    case "usage":
      return <UsageSkeleton />;
    case "advisor":
      return <AdvisorSkeleton />;
    case "schema-graph":
      return <SchemaGraphSkeleton />;
    case "schema-versions":
      return <SchemaVersionsSkeleton />;
    case "database-import":
      return <DatabaseImportSkeleton />;
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
