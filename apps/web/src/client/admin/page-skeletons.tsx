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

/** Overview — metric cards, quick actions, stat cards, then a 2-column split. */
export function OverviewSkeleton() {
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
export function LogsSkeleton() {
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
      {/* Volume sparkline + level-filter summary card. */}
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
export function DatabaseSkeleton() {
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
export function FlowsSkeleton() {
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
export function FunctionsSkeleton() {
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

/** Webhooks — header, then a list + delivery-log table. */
export function WebhooksSkeleton() {
  return (
    <div className="flex flex-col gap-4.5">
      <HeaderSkeleton actions={1} />
      <div className="grid grid-cols-[320px_minmax(0,1fr)] items-start gap-3.5 max-[900px]:grid-cols-[minmax(0,1fr)]">
        <ListCardSkeleton rows={5} header={false} />
        <div className="flex flex-col gap-3">
          <CardSkeleton lines={4} />
          <TableCardSkeleton rows={6} cols={4} />
        </div>
      </div>
    </div>
  );
}

/** Realtime — header, then a channel list + a tail pane. */
export function RealtimeSkeleton() {
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

/** Advisor — header, score/summary strip, tab strip, then a check list. */
export function AdvisorSkeleton() {
  return (
    <div className="flex flex-col gap-4.5">
      <HeaderSkeleton actions={1} />
      <div className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <CardSkeleton key={i} lines={2} />
        ))}
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
export function SchemaGraphSkeleton() {
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
export function InsightsSkeleton() {
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
export function RevisionsSkeleton() {
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

/** Translations — header, controls row, then a wide matrix table. */
export function TranslationsSkeleton() {
  return (
    <div className="flex flex-col gap-4.5">
      <HeaderSkeleton actions={2} />
      <Skeleton className="h-9 w-full" />
      <TableCardSkeleton rows={8} cols={4} />
    </div>
  );
}

/** Email templates — header, then a list + two editor columns. */
export function EmailTemplatesSkeleton() {
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

/** Authentication — header, then a stack of settings cards. */
export function AuthSettingsSkeleton() {
  return (
    <div className="flex flex-col gap-4.5">
      <HeaderSkeleton actions={0} />
      {Array.from({ length: 4 }).map((_, i) => (
        <CardSkeleton key={i} lines={4} />
      ))}
    </div>
  );
}

/** Users — header, then a wide user table. */
export function UsersSkeleton() {
  return (
    <div className="flex flex-col gap-4.5">
      <HeaderSkeleton actions={2} />
      <Skeleton className="h-9 w-full" />
      <TableCardSkeleton rows={8} cols={6} />
    </div>
  );
}

/** App users — header, then a wide table card. */
export function AppUsersSkeleton() {
  return (
    <div className="flex flex-col gap-4.5">
      <HeaderSkeleton actions={0} />
      <TableCardSkeleton rows={7} cols={6} />
    </div>
  );
}

/** API keys — header, then a card holding a key list. */
export function ApiKeysSkeleton() {
  return (
    <div className="flex flex-col gap-5">
      <HeaderSkeleton actions={1} />
      <div className="rounded-2xl border border-border bg-card p-4">
        {Array.from({ length: 4 }).map((_, i) => (
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
export function SettingsSkeleton() {
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

/** Account — a single column of settings cards. */
export function AccountSkeleton() {
  return (
    <div className="flex max-w-3xl flex-col gap-4">
      {Array.from({ length: 4 }).map((_, i) => (
        <CardSkeleton key={i} lines={4} />
      ))}
    </div>
  );
}

/** Storage — header, then a folder sidebar + a file grid. */
export function StorageSkeleton() {
  return (
    <div className="flex flex-col gap-4.5">
      <HeaderSkeleton actions={2} />
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

/** Collections index — header, search row, then a grid of collection cards. */
export function CollectionsSkeleton() {
  return (
    <div className="flex flex-col gap-4.5">
      <HeaderSkeleton actions={2} />
      <div className="flex flex-wrap items-center gap-2">
        <Skeleton className="h-9 w-[280px]" />
        <div className="flex-1" />
        <Skeleton className="h-8 w-20" />
        <Skeleton className="h-8 w-20" />
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,280px),1fr))] gap-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-[138px] w-full rounded-2xl" />
        ))}
      </div>
    </div>
  );
}

/** Collection detail — back link, header, tab strip, then an items grid. */
export function CollectionItemsSkeleton() {
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
export function RestExplorerSkeleton() {
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
export function GraphqlSkeleton() {
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
export function OpenApiSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <HeaderSkeleton actions={3} />
      <CardSkeleton lines={4} />
      <CardSkeleton lines={8} />
    </div>
  );
}

/** Access (roles & permissions) — header, then roles + members tables. */
export function AccessSkeleton() {
  return (
    <div className="flex flex-col gap-[18px]">
      <HeaderSkeleton actions={0} />
      <TableCardSkeleton rows={5} cols={4} />
      <TableCardSkeleton rows={6} cols={5} />
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────
 * Dispatcher
 * ────────────────────────────────────────────────────────────────────── */

/**
 * Resolves a nav id to its matching page skeleton. Used as the lazy-page
 * `<Suspense>` fallback so the chunk-loading placeholder already mirrors the
 * page being opened. Falls back to a generic header + card stack.
 */
export function PageSkeleton({ nav }: { nav: string }) {
  switch (nav) {
    case "overview":
      return <OverviewSkeleton />;
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
      return (
        <div className="flex flex-col gap-4.5">
          <HeaderSkeleton actions={1} />
          {Array.from({ length: 3 }).map((_, i) => (
            <CardSkeleton key={i} lines={4} />
          ))}
        </div>
      );
  }
}
