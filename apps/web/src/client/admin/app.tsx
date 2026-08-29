// backlex admin — main app
import type { PushToast } from "./types";
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";
import { withViewTransition, supportsViewTransitions, prefersReducedMotion, savePaneScroll, restorePaneScroll, useLinkViewTransitions } from "./lib/nav-transition";
import { prefetchPage } from "./lib/page-prefetch";

// Warm the chunk for an in-page anchor href (first path segment → nav id).
const prefetchHref = (href: string) => prefetchPage(href.replace(/^\/+/, "").split(/[/?]/)[0] ?? "");
import "./admin.css";
import "./flow-builder.css";
import { I } from "./icons";
import { Card } from "@backlex/ui/components/card";
import { Tabs, TabsList, TabsTrigger } from "@backlex/ui/components/tabs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@backlex/ui/components/dropdown-menu";
import {
  ADAPTER_PROFILES,
  NAV_DEVELOPERS,
  NAV_ITEMS,
  NAV_SETTINGS,
  type AdapterId,
  type CollectionListItem,
  type CollectionSchema,
  type MeNav,
  type Post,
  isNavVisible,
  isUnknownRoute,
} from "./config";
import {
  Badge,
  Button,
  EmptyState,
  PageHeader,
  Sidebar,
  Topbar,
  useToasts,
} from "./ui";
import { useUrlTab } from "./use-url-tab";
import {
  BulkBar,
  FilterBar,
  FilterDSLPreview,
  ItemsTable,
  evaluateFilter,
  resolveKanbanGroupField,
  type FilterCondition,
} from "./collections/items";
import { ConfirmDialog, ItemSheet } from "./sheet";
import { BulkEditDialog } from "./collections/bulk-edit";
import { ItemEditorPage } from "./collections/item-editor";
import { CalendarView, GalleryGrid, ItemsViewToggle, KanbanBoard, type ItemsViewMode } from "./collections/item-views";
import { ColumnPicker, useListColumns } from "./collections/list-columns";
import { needsDisplayTemplate } from "./lib/row-label";
import { EmptyItems, Palette, RealtimeTail, SchemaView, type RealtimeEvent } from "./extras";
import { AddFieldDialog } from "./fields/add-field";
import { loadAuthors } from "./lib/authors-cache";
import { liveValueOf, retireFieldOf } from "./lib/retirement";
import { CollectionsIndex, NewCollectionDialog } from "./collections/collections-index";
import { EditFieldDialog } from "./fields/edit-field";
import { CollectionKpisPanel } from "./collections/collection-kpis";
import { CollectionSettings } from "./collections/collection-settings";
import { type ApiExtension, collectionsApi, itemsApi, settingsApi } from "./api";
import { useQueryClient } from "@tanstack/react-query";
import {
  buildItemsParams,
  useCollections,
  useKpis,
  useEnabledExtensions,
  useItemCreate,
  useItemPatch,
  useItemPublish,
  useItems,
  useItemsBulkDelete,
  useItemsBulkPublish,
  useItemsBulkUpdate,
  useLiveCollection,
  useMe,
  useMetricsOverview,
} from "./queries";
import { evaluateTransition } from "@backlex/db/transitions";
import { ExtensionFrame } from "./extension-frame";
import { ExtensionWidgets } from "./extension-widgets";
import { api } from "@/lib/api";
import { useUrlState, useUrlStateJson } from "@/lib/use-url-state";
import { useTheme } from "@/components/theme-provider";
import { CosmosStars } from "@/components/cosmos-stars";
import { DemoBanner } from "@/components/demo-banner";
import { SidebarInset, SidebarProvider } from "@backlex/ui/components/sidebar";
import { TooltipProvider } from "@backlex/ui/components/tooltip";
import { StoragePage } from "./pages/data/storage";
import { AppUsersPage } from "./pages/access/app-users";
import { AppOrgsPage } from "./pages/access/app-orgs";
import { AuthSettingsPage } from "./pages/settings/auth-settings";
import { PlatformSsoSettingsPage } from "./pages/settings/platform-auth-settings";
import { EmailTemplatesPage } from "./pages/settings/email-templates";
import { DocumentsPage } from "./pages/settings/documents";
import { SignaturesPage } from "./pages/settings/signatures";
import { DatabasePage } from "./pages/data/database";
import { BookingPage } from "./pages/data/booking";
import { ApprovalsPage } from "./pages/automation/approvals";
import { InsightsPage } from "./pages/observability/insights";
import { KpisPage } from "./pages/observability/kpis";
import { RevisionsPage } from "./pages/observability/revisions";
import { TranslationsPage } from "./pages/observability/translations";
import { MembersPanel } from "./pages/access/members-panel";
import { RolesPanel } from "./pages/access/roles-panel";
import { PermissionTesterPanel } from "./pages/access/permission-tester";
// Each admin page is split into its own chunk so the initial admin bundle
// stays small. The shared `<Suspense>` boundary inside the page switch below
// renders the fallback while the page chunk streams in.
const OverviewPage = lazy(() => import("./pages/overview").then((m) => ({ default: m.OverviewPage })));
const AskAiPage = lazy(() => import("./pages/ask-ai").then((m) => ({ default: m.AskAiPage })));
const FlowsPage = lazy(() => import("./pages/automation/flows").then((m) => ({ default: m.FlowsPage })));
const AgentsPage = lazy(() => import("./pages/automation/agents").then((m) => ({ default: m.AgentsPage })));
const ChatPage = lazy(() => import("./pages/automation/chat").then((m) => ({ default: m.ChatPage })));
const FunctionsPage = lazy(() => import("./pages/automation/functions").then((m) => ({ default: m.FunctionsPage })));
const JobsPage = lazy(() => import("./pages/automation/jobs").then((m) => ({ default: m.JobsPage })));
const FeatureFlagsPage = lazy(() => import("./pages/automation/feature-flags").then((m) => ({ default: m.FeatureFlagsPage })));
const FormsPage = lazy(() => import("./pages/data/forms").then((m) => ({ default: m.FormsPage })));
const WebhooksPage = lazy(() => import("./pages/automation/webhooks").then((m) => ({ default: m.WebhooksPage })));
const IntegrationsPage = lazy(() => import("./pages/automation/integrations").then((m) => ({ default: m.IntegrationsPage })));
const PaymentsPage = lazy(() => import("./pages/automation/payments").then((m) => ({ default: m.PaymentsPage })));
const RealtimePage = lazy(() => import("./pages/automation/realtime").then((m) => ({ default: m.RealtimePage })));
const LogsPage = lazy(() => import("./pages/observability/logs").then((m) => ({ default: m.LogsPage })));
const TracesPage = lazy(() => import("./pages/observability/traces").then((m) => ({ default: m.TracesPage })));
const UsagePage = lazy(() => import("./pages/observability/usage").then((m) => ({ default: m.UsagePage })));
const AnalyticsPage = lazy(() => import("./pages/observability/analytics").then((m) => ({ default: m.AnalyticsPage })));
const TagManagerPage = lazy(() => import("./pages/observability/tag-manager").then((m) => ({ default: m.TagManagerPage })));
const WebsitesPage = lazy(() => import("./pages/observability/websites").then((m) => ({ default: m.WebsitesPage })));
const ConsentPage = lazy(() => import("./pages/observability/consent").then((m) => ({ default: m.ConsentPage })));
const AdvisorPage = lazy(() => import("./pages/observability/advisor").then((m) => ({ default: m.AdvisorPage })));
const SchemaGraphPage = lazy(() => import("./pages/data/schema-graph").then((m) => ({ default: m.SchemaGraphPage })));
const SearchPlaygroundPage = lazy(() => import("./pages/data/search-playground").then((m) => ({ default: m.SearchPlaygroundPage })));
const SchemaVersionsPage = lazy(() => import("./pages/data/schema-versions").then((m) => ({ default: m.SchemaVersionsPage })));
const DatabaseImportPage = lazy(() => import("./pages/data/database-import").then((m) => ({ default: m.DatabaseImportPage })));
const UsersPage = lazy(() => import("./pages/access/users").then((m) => ({ default: m.UsersPage })));
const SettingsPage = lazy(() => import("./pages/settings").then((m) => ({ default: m.SettingsPage })));
const ExtensionsPage = lazy(() => import("./pages/developers/extensions").then((m) => ({ default: m.ExtensionsPage })));

import { PageSkeleton, CollectionItemsSkeleton } from "./page-skeletons";

const TAB_COUNT_CLS =
  "rounded-sm border border-border bg-muted px-[5px] py-px font-mono text-[11px] text-muted-foreground";

/** The panels an open collection is looked at through. */
const COLLECTION_TABS = ["items", "kpis", "schema", "settings"] as const;
import { AccountPage } from "./pages/account-page";
import { PreferencesProvider } from "./preferences";
import { AdminLocaleSync } from "./i18n";
import { Trans, useLingui } from "@lingui/react/macro";
import { GraphqlPage } from "@/pages/graphql";
const RestExplorerPage = lazy(() =>
  import("@/pages/rest-explorer").then((m) => ({ default: m.RestExplorerPage })),
);
import { OpenApiExportPage } from "@/pages/openapi-export";
import { ApiKeys } from "@/pages/api-keys";

interface AdminAppOptions {
  initialNav?: string;
  onSignOut?: () => void;
}

const DEFAULTS = {
  density: "comfortable" as "compact" | "cozy" | "comfortable",
  sidebarCollapsed: false,
  adapter: "bun" as AdapterId,
  showRealtime: false,
  populated: true,
};

function ageBump(t: string) {
  if (t === "just now") return "5s ago";
  const m = t.match(/^(\d+)s ago$/);
  if (m) {
    const n = parseInt(m[1] ?? "0", 10) + 5;
    if (n >= 60) return Math.floor(n / 60) + "m ago";
    return n + "s ago";
  }
  const m2 = t.match(/^(\d+)m ago$/);
  if (m2) {
    const n = parseInt(m2[1] ?? "0", 10);
    if (n >= 60) return Math.floor(n / 60) + "h ago";
    return n + "m ago";
  }
  return t;
}

export function AdminApp({ initialNav = "overview", onSignOut }: AdminAppOptions) {
  const { t } = useLingui();
  const [tweaks, setTweaks] = useState(DEFAULTS);
  const setTweak = useCallback(<K extends keyof typeof DEFAULTS>(k: K, v: (typeof DEFAULTS)[K]) => {
    setTweaks((t) => ({ ...t, [k]: v }));
  }, []);
  const { theme, setTheme } = useTheme();
  const dark = theme === "dark";
  const toggleDark = useCallback(() => {
    setTheme(dark ? "light" : "dark");
  }, [dark, setTheme]);

  // activeNav + activeCollection are URL-driven so the address bar shows the
  // current admin location and deep links work. Nav ids are mapped 1:1 to the
  // first path segment; the collection slug (when on `collections`) lives in
  // the second segment.
  const location = useLocation();
  const navigate = useNavigate();
  // Shared React Query client — used to invalidate cached server reads
  // (collections list, metrics) after mutations.
  const qc = useQueryClient();
  // Enabled extensions — each contributed panel becomes a dynamic sidebar
  // entry (`ext:<extension>:<panel>`) in the Developers group plus a routed
  // page hosting the sandboxed iframe. Admin-only in v1: the ids aren't in
  // NON_ADMIN_NAV_IDS, so `isNavVisible` hides them and the non-admin
  // redirect below bounces off them, same as every other admin page.
  const extensionsQuery = useEnabledExtensions();
  const extensionPanels = useMemo(() => {
    const out: { id: string; label: string; icon: string; extension: ApiExtension; entry: string }[] = [];
    for (const ext of extensionsQuery.data?.data ?? []) {
      for (const p of ext.manifest?.contributes?.panels ?? []) {
        out.push({
          id: `ext:${ext.name}:${p.id}`,
          label: p.title,
          icon: p.icon && p.icon in I ? p.icon : "Puzzle",
          extension: ext,
          entry: p.entry,
        });
      }
    }
    return out;
  }, [extensionsQuery.data]);
  const NAV_IDS = useMemo(
    () =>
      new Set<string>([
        ...NAV_ITEMS.map((n) => n.id),
        ...NAV_DEVELOPERS.map((n) => n.id),
        ...NAV_SETTINGS.map((n) => n.id),
        // Dynamic extension-panel pages — validated like any other nav id so
        // the URL router accepts deep links once the enabled list resolves.
        ...extensionPanels.map((p) => p.id),
        // Reachable only via the header avatar dropdown — not in the sidebar.
        "account",
      ]),
    [extensionPanels],
  );
  // Decode each segment: browsers percent-encode `:` in the first path
  // segment (scheme ambiguity), so a direct visit to /ext:name:panel arrives
  // as /ext%3Aname%3Apanel and would miss the NAV_IDS check undecoded.
  const segs = location.pathname
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .filter(Boolean)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
  const activeNav = segs[0] && NAV_IDS.has(segs[0]) ? segs[0] : initialNav;
  /**
   * A first segment that is not a nav id used to fall through to `initialNav`
   * with the address bar untouched — so `/roles` (a natural guess, since the
   * REST API has `/api/roles`) rendered Overview and looked like it had worked.
   * Same silent shape the `/analytics/sites` redirect below was added to fix,
   * one level up and for every URL nobody thought to alias.
   *
   * Gated on the extensions query: `NAV_IDS` gains the `ext:*` panel ids only
   * once that resolves, so declaring a route unknown before then would flash
   * "not found" over a perfectly good extension deep link.
   */
  const unknownRoute = isUnknownRoute({
    firstSegment: segs[0],
    navIds: NAV_IDS,
    extensionsPending: extensionsQuery.isPending,
  });
  // Navigate inside a view transition. Warms the target's lazy chunk first (so
  // the transition snapshots the page, not its skeleton), then commits through
  // `withViewTransition` which falls back to a plain navigate when the API is
  // unavailable or reduced-motion is on. `direction` drives the CSS slide.
  // Current location key, kept in a ref so the memoized `vNav` can read it
  // without re-creating on every navigation.
  const locKeyRef = useRef("");
  locKeyRef.current = location.pathname + location.search;
  // Restore the destination's saved scroll (or top) after each navigation
  // commits — runs inside the view-transition's synchronous flush, so the new
  // snapshot reflects the restored offset.
  useLayoutEffect(() => {
    restorePaneScroll(location.pathname + location.search);
  }, [location.pathname, location.search]);
  // App-wide view transitions for in-page anchor nav (breadcrumbs, links, route
  // tabs). The sidebar uses buttons + vNav, so this only adds anchor coverage.
  useLinkViewTransitions(prefetchHref);
  const vNav = useCallback(
    (to: string, direction?: "forward" | "back", opts?: { replace?: boolean }) => {
      // Save where we are before leaving so a later "back" can restore it.
      savePaneScroll(locKeyRef.current);
      const navId = to.replace(/^\/+/, "").split(/[/?]/)[0] ?? "";
      const run = () => withViewTransition(() => navigate(to, opts), direction);
      const pending =
        supportsViewTransitions() && !prefersReducedMotion()
          ? prefetchPage(navId)
          : undefined;
      if (pending) pending.then(run, run);
      else run();
    },
    [navigate],
  );
  const setActiveNav = useCallback((id: string) => { vNav("/" + id); }, [vNav]);

  // The standalone "Activity log" page was merged into "Logs" — keep old
  // `/activity` deep links working by redirecting them to the unified page.
  //
  // Same treatment for the two Analytics TABS that became pages. Without it the
  // failure is silent and reads as deletion: `segs[0]` is still "analytics" so
  // `NAV_IDS.has()` passes, the unknown `segs[1]` falls back to "overview", and
  // the address bar keeps saying `/analytics/sites` while Overview renders.
  useEffect(() => {
    if (segs[0] === "activity") navigate("/logs", { replace: true });
    if (segs[0] === "analytics" && segs[1] === "sites") {
      navigate("/websites", { replace: true });
    }
    if (segs[0] === "analytics" && segs[1] === "consent") {
      navigate("/consent", { replace: true });
    }
  }, [segs[0], segs[1], navigate]);

  const navTo = useCallback((id: string) => { vNav("/" + id); }, [vNav]);
  // `/collections/:slug/:tab` — the tab sits under the open collection, so
  // depth 2. `items` doubles as the item-detail route's own segment, but that
  // route needs an id after it (`/collections/posts/items/abc`), so the two
  // never mean the same URL.
  const [activeTab, setActiveTab] = useUrlTab(COLLECTION_TABS, "items", 2);
  // The item list is React Query state (`itemsQuery` below, derived from
  // `activeCollection` + `itemsParams`). `posts` is just its current rows —
  // mutations patch the cache through the `useItem*` hooks, never a setter.
  const [search, setSearch] = useUrlState("q", "");
  const [filters, setFilters] = useUrlStateJson<FilterCondition[]>("filter", []);
  const [statusTab, setStatusTab] = useState("all");
  /**
   * Which rows the retirement flag lets into the list — and it opens on the
   * ones still in play.
   *
   * A UI default, not an API one: `?retired=` defaults to `all` everywhere
   * else, so no consumer's results move. What this decides is only what the
   * operator is looking at when the page opens, and a list of live products
   * with the discontinued ones mixed in is the thing the feature exists to fix.
   * The segmented control shows which scope is on, so nothing has silently
   * vanished.
   */
  const [retiredTab, setRetiredTab] = useState("in-play");
  // Empty = don't send a sort; the server then applies the collection's
  // `defaultSort` setting, falling back to `-created_at` (stable — rows don't
  // reshuffle every time someone edits one, unlike the old `-updated_at`).
  const [sort, setSort] = useUrlState("sort", "");
  // Per-collection visualisation. Kanban auto-hides when the schema has no
  // status-shaped column (see ItemsViewToggle); the resolved `viewMode` is
  // derived below once schemaState is known.
  const [view, setView] = useUrlState("view", "table");
  const requestedView = (["table", "kanban", "gallery", "calendar"].includes(view) ? view : "table") as ItemsViewMode;
  // Spreadsheet grid mode (table view only, URL-persisted). Cells become
  // selectable/navigable and the page grows — 8 rows is browsing scale,
  // 50 is editing scale.
  const [gridUrl, setGridUrl] = useUrlState("grid", "");
  const gridMode = requestedView === "table" && gridUrl === "1";
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkEditOpen, setBulkEditOpen] = useState(false);
  const [page, setPage] = useState(1);
  const PER_PAGE = gridMode ? 50 : 8;

  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetMode, setSheetMode] = useState<"create" | "edit">("create");
  const [sheetItem, setSheetItem] = useState<Post | null>(null);

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [confirm, setConfirm] = useState<{
    title: ReactNode;
    description: ReactNode;
    actionLabel?: string;
    destructive?: boolean;
    onConfirm?: () => void;
  } | null>(null);
  const [addFieldOpen, setAddFieldOpen] = useState(false);
  const [editFieldName, setEditFieldName] = useState<string | null>(null);
  // Schema is loaded per-collection from /api/collections/:slug. Initial
  // value is an empty placeholder so the UI doesn't crash before activeCollection
  // resolves; the real fields land via the activeCollection effect below.
  const [schemaState, setSchemaState] = useState<CollectionSchema>({
    slug: "",
    ownerScoped: false,
    fields: [],
  });
  // True while the active collection's schema is being fetched for the first
  // time — drives the collection-detail skeleton so the items/schema tabs
  // don't flash an empty state before the real schema lands.
  const [collectionLoading, setCollectionLoading] = useState(false);
  // Kanban needs a status-shaped column to group by. If the URL asks for
  // `?view=kanban` on a collection that has none, fall back to the table view
  // (the toggle already hides the Kanban button in that case).
  const kanbanStatusField = useMemo(
    () => resolveKanbanGroupField(schemaState as unknown as { fields?: Array<Record<string, unknown>>; kanbanGroupBy?: string | null; versioned?: boolean } | null),
    [schemaState],
  );
  const hasStatusField = !!kanbanStatusField;
  /** The collection's retirement flag, if it declares one — what the list's
   *  in-play/out-of-play control and the row action are driven by. */
  const retireField = useMemo(
    () => retireFieldOf(schemaState.fields as Array<{ name: string; label?: string }>),
    [schemaState.fields],
  );
  const viewMode: ItemsViewMode =
    requestedView === "kanban" && !hasStatusField ? "table" : requestedView;
  // Archive lifecycle view — when on, GET /api/collections is called with
  // `?include_archived=true` and we filter the result down to status="archived"
  // rows. Default off → active rows only.
  const [showArchived, setShowArchived] = useState(false);
  // Server state via React Query — the raw collections list (archived-aware)
  // and the metrics overview are two cached reads; `collections` below is the
  // derived, enriched array the rest of the app consumes. Mutations call
  // `invalidateCollections()` instead of poking local state.
  const collectionsQuery = useCollections(showArchived);
  const metricsQuery = useMetricsOverview("24h");
  const invalidateCollections = useCallback(() => {
    // Prefix match — refreshes both the active and archived list entries.
    void qc.invalidateQueries({ queryKey: ["collections"] });
  }, [qc]);
  const collections = useMemo<CollectionListItem[]>(() => {
    const fmtAgo = (ts: number | null | undefined): string => {
      if (!ts) return "—";
      const ms = Date.now() - ts;
      if (ms < 60_000) return "just now";
      if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
      if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
      return `${Math.floor(ms / 86_400_000)}d ago`;
    };
    const listData = collectionsQuery.data?.data;
    if (!Array.isArray(listData)) return [];
    const statsBySlug = new Map(
      (metricsQuery.data?.data?.topCollections ?? []).map((s) => [s.slug, s]),
    );
    return listData
      // `inactive` collections stay in the main view (they're manageable —
      // only their content API is off); the archived panel shows archived only.
      .filter((c: any) => showArchived
        ? (c.status ?? "active") === "archived"
        : (c.status ?? "active") !== "archived",
      )
      .map((c: any) => {
        const stats = statsBySlug.get(c.slug);
        return {
          slug: c.slug,
          count: stats?.rows ?? 0,
          ownerScoped: c.ownerScoped,
          // Pass-through fields the index/danger zone branch on. Loosened
          // on `CollectionListItem` so the parent can stamp them in.
          adopted: !!c.adopted,
          status: c.status ?? "active",
          archivedAt: c.archivedAt ?? null,
          fields: Array.isArray(c.fields) ? c.fields.length : 0,
          fieldDefs: Array.isArray(c.fields) ? c.fields : [],
          icon: (c.icon ?? "Database") as CollectionListItem["icon"],
          color: c.color ?? null,
          hidden: !!c.hidden,
          note: c.note ?? null,
          writes24h: stats?.writes24h ?? 0,
          lastWrite: fmtAgo(stats?.lastWrite ?? null),
          singleton: !!c.singleton,
          group: c.group ?? null,
          sortOrder: c.sortOrder ?? null,
        } as CollectionListItem;
      });
  }, [collectionsQuery.data, metricsQuery.data, showArchived]);
  // Saved group-header order (Edit layout mode). Memoized so the empty
  // fallback doesn't churn CollectionsIndex/Sidebar renders.
  const collectionGroups = useMemo(
    () => collectionsQuery.data?.meta?.groups ?? [],
    [collectionsQuery.data],
  );
  const activeCollection = activeNav === "collections" && segs[1] ? segs[1] : null;
  // One workspace-wide list, cached — so browsing 116 collections costs one
  // request rather than one per collection.
  const { data: kpisData } = useKpis();
  const collectionKpiCount = activeCollection
    ? (kpisData?.data ?? []).filter((k) => k.collection === activeCollection).length
    : 0;
  // The trigger disappears when the count drops to zero (navigating to a
  // collection with no definitions, or deleting the last one), so a tab left
  // selected would render an empty content area. Guarded on `kpisData` so the
  // in-flight state — count 0 because nothing has loaded — doesn't bounce
  // someone off the tab they just opened.
  useEffect(() => {
    if (kpisData && activeTab === "kpis" && collectionKpiCount === 0)
      setActiveTab("items", { replace: true });
  }, [kpisData, activeTab, collectionKpiCount, setActiveTab]);
  const setActiveCollection = useCallback(
    (slug: string | null) => { vNav(slug ? "/collections/" + slug : "/collections", slug ? "forward" : "back"); },
    [vNav],
  );
  // Item-detail route: /collections/:slug/items/:id (and /items/new). When set,
  // the full-page editor renders in place of the items list. Deep-linkable so
  // refresh / back / open-in-new-tab all work.
  const activeItem =
    activeNav === "collections" && activeCollection && segs[2] === "items" && segs[3]
      ? segs[3]
      : null;
  // Schema must be loaded for this collection before the editor can render its
  // fields; until then show the collection skeleton.
  const schemaReady = schemaState.slug === activeCollection;
  // Flow detail id lives in segs[1] when activeNav === "flows" — same shape as
  // collections, so deep links / browser back preserve the selected flow.
  const activeFlow = activeNav === "flows" && segs[1] ? segs[1] : null;
  const setActiveFlow = useCallback(
    (id: string | null) => { navigate(id ? "/flows/" + id : "/flows"); },
    [navigate],
  );
  // Booking + forms both open one record over several tabs, and both are
  // watched rather than only edited: an operator sits on Bookings or
  // Submissions waiting for something to arrive. Holding the open record and
  // the open tab in state alone meant every refresh — the one move that used to
  // be the only way to see what had arrived — closed the record and went back
  // to the first tab. So both live in the path: /booking/:key/:tab, /forms/:id/:tab.
  const activeBooking = activeNav === "booking" && segs[1] ? segs[1] : null;
  const openBooking = useCallback(
    (key: string | null, tab?: string) => {
      navigate(key ? `/booking/${encodeURIComponent(key)}/${tab ?? "hours"}` : "/booking");
    },
    [navigate],
  );
  const activeFormId = activeNav === "forms" && segs[1] ? segs[1] : null;
  const openFormAt = useCallback(
    (id: string | null, tab?: string) => {
      navigate(id ? `/forms/${encodeURIComponent(id)}/${tab ?? "edit"}` : "/forms");
    },
    [navigate],
  );
  const [newCollectionOpen, setNewCollectionOpen] = useState(false);

  // Debounced server-side search. The admin used to filter `posts` purely
  // in memory, which never actually fired a request when the user typed —
  // and silently capped at the first 50 items so anything beyond that
  // window was unreachable. We now push `q` + chip filters + status tab
  // down to /api/items so the server does the work.
  const [debouncedSearch, setDebouncedSearch] = useState(search);
  useEffect(() => {
    if (debouncedSearch === search) return;
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search, debouncedSearch]);

  // Dot-notation list columns (`author.first_name`) need their relation head
  // inlined by the server — collect the heads that are real relation fields
  // so the list request carries `expand=`.
  const { columns: savedListCols } = useListColumns(activeCollection ?? "");
  const expandHeads = useMemo(() => {
    const rels = new Set(
      (schemaState.fields ?? [])
        .filter((f) => (f as { type?: string }).type === "relation")
        .map((f) => f.name),
    );
    return [
      ...new Set(
        savedListCols
          .filter((c) => c.includes("."))
          .map((c) => c.split(".")[0] as string)
          .filter((h) => rels.has(h)),
      ),
    ].sort();
  }, [savedListCols, schemaState.fields]);

  // Items list via React Query. The params memo bakes the resolved status-field
  // name into the `filter` string, so the query key (and refetch) changes
  // exactly when the result set should — without keying on the whole schema.
  const itemsParams = useMemo(
    () =>
      buildItemsParams({
        sort,
        q: debouncedSearch,
        filters,
        statusTab,
        statusFieldName: kanbanStatusField?.name ?? null,
        expandHeads,
        retiredTab,
        hasRetireField: Boolean(retireField),
      }),
    [sort, debouncedSearch, filters, statusTab, kanbanStatusField, expandHeads, retiredTab, retireField],
  );
  const itemsQuery = useItems(activeCollection, itemsParams);
  // Reactive list: subscribe to the collection's realtime feed and refresh on
  // any row change (other tabs/admins, the SDK, flows). `live` drives the dot.
  const { live: itemsLive } = useLiveCollection(activeCollection);
  const posts = useMemo(() => (itemsQuery.data ?? []) as Post[], [itemsQuery.data]);
  // `isPending` is true only while data is undefined — i.e. on the first load
  // of a collection (placeholderData drops to undefined on collection switch),
  // never during an in-collection param refetch. That reproduces the old
  // skeleton-on-switch / no-flash-while-typing behaviour.
  const itemsLoaded = !itemsQuery.isPending;

  // Optimistic mutation hooks — each owns its own snapshot / patch / rollback /
  // reconcile against the shared `["items", collection]` cache prefix.
  // Identity as the API reports it — the header's own `me` state (below) keeps
  // only what the avatar menu needs and drops `roles`, which is what a
  // role-gated transition has to be judged against.
  const identity = useMe();
  const itemPatch = useItemPatch(activeCollection);
  const itemCreate = useItemCreate(activeCollection);
  const itemPublish = useItemPublish(activeCollection);
  const bulkUpdate = useItemsBulkUpdate(activeCollection);
  const bulkPublish = useItemsBulkPublish(activeCollection);
  const bulkDelete = useItemsBulkDelete(activeCollection);
  // Patch the active collection's list cache directly — used by the full-page
  // editor callbacks (which keep their own pessimistic transport).
  const patchItemsCache = useCallback(
    (fn: (rows: Post[]) => Post[]) => {
      qc.setQueriesData<Post[]>({ queryKey: ["items", activeCollection] }, (old) =>
        old ? fn(old) : old,
      );
    },
    [qc, activeCollection],
  );

  // Schema load — only re-runs when the active collection changes.
  useEffect(() => {
    if (!activeCollection) return;
    let cancelled = false;
    setCollectionLoading(true);
    void (async () => {
      try {
        const res = await collectionsApi.get(activeCollection);
        if (cancelled || !res.data) return;
        // Store ONLY user-defined fields in schemaState. SchemaView
        // synthesizes system rows (id / created_at / updated_at /
        // owner_id) for display. System rows must never round-trip
        // through PATCH — validateFields() rejects reserved names with
        // 422 VALIDATION, which is exactly what made earlier edits
        // appear to apply locally but revert on refresh.
        const RESERVED = new Set(["id", "created_at", "updated_at", "owner_id"]);
        const fields = (Array.isArray(res.data.fields) ? res.data.fields : []).filter(
          (f: any) => f && !RESERVED.has(f.name) && !f.system,
        );
        setSchemaState({
          slug: activeCollection,
          ownerScoped: !!res.data.ownerScoped,
          // Pass through `adopted` so CollectionSettings can pick the
          // archive-vs-destroy lifecycle for the danger zone.
          adopted: !!(res.data as any).adopted,
          // Hydrate the Settings-tab metadata. Without these the form reseeds
          // from `undefined` on every load, so a saved display template /
          // singular / plural / note / default-sort silently reverts to empty
          // on refresh even though the PATCH persisted it.
          singular: (res.data as any).singular ?? null,
          plural: (res.data as any).plural ?? null,
          note: (res.data as any).note ?? null,
          displayTemplate: (res.data as any).displayTemplate ?? null,
          defaultSort: (res.data as any).defaultSort ?? null,
          // Presentation metadata + lifecycle status — same reseed rule as
          // above: every SchemaLike key MUST be hydrated here or the Settings
          // tab silently reverts it on refresh.
          icon: (res.data as any).icon ?? null,
          color: (res.data as any).color ?? null,
          hidden: !!(res.data as any).hidden,
          previewUrl: (res.data as any).previewUrl ?? null,
          status: (res.data as any).status ?? "active",
          // Kanban group-by preference — without this the Settings-tab
          // dropdown reseeds from `undefined` and reverts to "Auto" on refresh
          // even though the PATCH persisted the chosen field.
          kanbanGroupBy: (res.data as any).kanbanGroupBy ?? null,
          kanbanActionMap: (res.data as any).kanbanActionMap ?? null,
          tenantScoped: (res.data as any).tenantScoped !== false,
          versioned: !!(res.data as any).versioned,
          stagedEdits: !!(res.data as any).stagedEdits,
          // fts + auditReads were missing here, so the Settings tab rendered
          // both toggles OFF regardless of the stored value — while the
          // search playground (reading the raw list row) showed the truth.
          auditReads: !!(res.data as any).auditReads,
          fts: !!(res.data as any).fts,
          vectorize: !!(res.data as any).vectorize,
          vectorizeModel: (res.data as any).vectorizeModel ?? null,
          fields: fields as any,
        } as any);
      } catch {
        // leave previous schemaState in place
      } finally {
        if (!cancelled) setCollectionLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [activeCollection]);

  const [events, setEvents] = useState<RealtimeEvent[]>([]);
  const [toastNode, pushToast] = useToasts();
  const [me, setMe] = useState<{ name: string | null; email: string; image: string | null; isAdmin: boolean; nav?: MeNav } | null>(null);
  // Hydrate the header dropdown — name/email/avatar + admin badge. `auth.useSession()`
  // doesn't carry role info, so we hit our own `/api/me` which returns the
  // permission-resolver's view of the current user.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await api<{ data: { name: string | null; email: string; image: string | null; isAdmin: boolean; nav?: MeNav } }>("/api/me");
        if (!cancelled) setMe(r.data);
      } catch {
        // not signed in or endpoint missing — dropdown falls back gracefully
      }
    })();
    return () => { cancelled = true; };
  }, []);
  // Landing redirect for non-admins: the default route is `overview`, which is
  // admin-only — once /api/me resolves, bounce off any nav-hidden page to the
  // first page the user can actually see (sidebar order: collections → storage
  // → logs → …; `logs` is always visible so there's always a target). `replace`
  // keeps the hidden page out of history. Cosmetic like the sidebar filter —
  // the API behind every page stays gated server-side.
  useEffect(() => {
    if (!me || me.isAdmin) return;
    const grants = me.nav ?? null;
    if (isNavVisible(activeNav, false, grants)) return;
    const fallback = [...NAV_ITEMS, ...NAV_DEVELOPERS, ...NAV_SETTINGS].find((n) =>
      isNavVisible(n.id, false, grants),
    );
    if (fallback) vNav("/" + fallback.id, undefined, { replace: true });
  }, [me, activeNav, vNav]);

  // Detect the actual runtime profile so the sidebar pill, Health card and
  // Settings page show truth instead of the design's `bun` default.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await settingsApi.runtime();
        if (cancelled) return;
        const adapter = r.data?.adapter;
        if (adapter === "bun" || adapter === "workers" || adapter === "vercel") {
          setTweak("adapter", adapter);
        }
      } catch {
        // keep default
      }
    })();
    // Populate the workspace authors cache so item rows + the ItemSheet
    // author Select show real users instead of the design's mock seed.
    void loadAuthors();
    return () => { cancelled = true; };
  }, [setTweak]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const tag = (target.tagName || "").toLowerCase();
      const inEditable = ["input", "textarea", "select"].includes(tag) || target.isContentEditable;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }
      if (inEditable) return;
      if (e.key.toLowerCase() === "c" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        openCreate();
      } else if (e.key.toLowerCase() === "r" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        pushToast(t`Refreshed.`);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pushToast]);

  // Realtime page selection lifted here so the subscription can follow whichever
  // channel that page has active — otherwise navigating to /realtime never opens
  // a connection (activeCollection is null there) and the tail stays empty.
  const [realtimeChannel, setRealtimeChannel] = useState<string>("collections");

  // Channel actually being subscribed: the Realtime page's selection when that
  // page is visible, otherwise the open collection's items channel.
  const subscriptionChannel: string | null =
    activeNav === "realtime"
      ? realtimeChannel
      : activeNav === "collections" && activeCollection
        ? `items:${activeCollection}`
        : null;

  // Real-time subscription to `subscriptionChannel`. The server route always
  // returns SSE (on Workers it bridges the DO WebSocket into the response), so
  // EventSource is the right transport on both runtimes — opening a raw
  // WebSocket against the same URL was the cause of the silent tail.
  // Each incoming event is mapped into the design's RealtimeEvent shape so
  // RealtimeTail keeps rendering identically.
  useEffect(() => {
    if (!tweaks.showRealtime) return;
    if (!subscriptionChannel) { setEvents([]); return; }
    const channel = subscriptionChannel;
    let alive = true;
    const onMsg = (raw: string) => {
      if (!alive) return;
      try {
        const parsed = JSON.parse(raw) as { event?: string; data?: any };
        const ev = parsed.event ?? "updated";
        const data = parsed.data ?? {};
        const next: RealtimeEvent = {
          event: ev as RealtimeEvent["event"],
          itemId: data.id ?? undefined,
          title: data.title ?? data.name ?? data.slug ?? data.id ?? "(item)",
          field: data._changed ?? undefined,
          who: data.ownerId ?? data.owner_id ?? "system",
          t: "just now",
          id: "e" + Math.random().toString(36).slice(2),
          raw: data,
          receivedAt: Date.now(),
        };
        setEvents((arr) => [next, ...arr.map((e) => ({ ...e, t: ageBump(e.t) })).slice(0, 30)]);
      } catch {
        // malformed payload — ignore
      }
    };
    let es: EventSource | null = null;
    try {
      es = new EventSource(`/api/realtime/${encodeURIComponent(channel)}/subscribe`, { withCredentials: true });
      es.addEventListener("message", (ev) => onMsg((ev as MessageEvent).data));
    } catch {
      // EventSource unsupported — leave events empty
    }
    // Reset the tail whenever the channel changes so stale events from the
    // previous subscription don't sit on top of the new feed.
    setEvents([]);
    return () => {
      alive = false;
      es?.close();
    };
  }, [tweaks.showRealtime, subscriptionChannel]);

  const itemsForView = useMemo(() => {
    let rows = tweaks.populated ? posts : [];
    if (statusTab !== "all") rows = rows.filter((r) => r.status === statusTab);
    if (search.trim()) {
      // Resilient text search: title/slug if present, otherwise every string
      // field on the row. Without the guards `(r.title ?? "").toLowerCase()`
      // throws on collections that don't declare a `title` column — that
      // crashes the whole items view (the parent has no error boundary).
      const qq = search.toLowerCase();
      rows = rows.filter((r) => {
        const t = (r as { title?: unknown }).title;
        const s = (r as { slug?: unknown }).slug;
        if (typeof t === "string" && t.toLowerCase().includes(qq)) return true;
        if (typeof s === "string" && s.toLowerCase().includes(qq)) return true;
        if (typeof t !== "string" && typeof s !== "string") {
          for (const v of Object.values(r as Record<string, unknown>)) {
            if (typeof v === "string" && v.toLowerCase().includes(qq)) return true;
          }
        }
        return false;
      });
    }
    if (filters.length) {
      // AND-combine each chip as its own clause so duplicate field+op pairs
      // (e.g. body _contains "a" AND body _contains "b") survive — the old
      // `combined[field] = {...combined[field], [op]: value}` shape silently
      // overwrote on conflicts.
      rows = rows.filter((r) =>
        filters.every((f) =>
          evaluateFilter(r as Record<string, unknown>, {
            [f.field]: { [f.op]: f.value },
          }),
        ),
      );
    }
    if (sort) {
      const dir = sort.startsWith("-") ? -1 : 1;
      const key = sort.replace("-", "");
      rows = [...rows].sort((a, b) => {
        const av = (a as Record<string, unknown>)[key];
        const bv = (b as Record<string, unknown>)[key];
        if (av == null && bv == null) return 0;
        if (av == null) return 1;
        if (bv == null) return -1;
        if (typeof av === "number") return ((av as number) - (bv as number)) * dir;
        return String(av).localeCompare(String(bv)) * dir;
      });
    }
    return rows;
  }, [posts, search, filters, statusTab, sort, tweaks.populated]);

  useEffect(() => { setPage(1); }, [search, filters.length, statusTab, sort, gridMode]);

  const total = itemsForView.length;
  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));
  const pageRows = itemsForView.slice((page - 1) * PER_PAGE, page * PER_PAGE);

  // Primary edit/create flow is the full-page editor (deep-linkable). The modal
  // (ItemSheet) stays as a fallback for create outside a collection context.
  // Carry the list's query string (view / filters / sort / search) into the
  // item editor and back, so returning via "Back" restores the chosen view
  // (e.g. Kanban) instead of snapping to the default Table.
  // `status` is passed by a Kanban column's "+" — preset the grouped field so a
  // card created in a column lands in that column. Skipped for the `_status`
  // lifecycle board (new items are always drafts).
  const openCreate = (status?: string) => {
    const field = kanbanStatusField?.name;
    // `typeof status === "string"`, not a truthy check. Two call sites wire this
    // straight to `onClick`, which hands it the CLICK EVENT — a truthy object
    // that interpolated to the literal string "[object Object]", preset the
    // grouped field to it, and made every "New post" on a collection with a
    // Kanban status field open a form that 422'd on save naming a field the
    // operator never touched. The guard belongs here rather than at each
    // `onClick`: this is the one place that decides what a preset is.
    const preset =
      typeof status === "string" && status && field && field !== "_status"
        ? { field, value: status }
        : null;
    if (activeCollection) {
      const sp = new URLSearchParams(location.search);
      if (preset) sp.set("new", `${preset.field}:${preset.value}`);
      const qs = sp.toString();
      vNav(`/collections/${activeCollection}/items/new${qs ? `?${qs}` : ""}`, "forward");
    } else {
      setSheetMode("create");
      setSheetItem(preset ? ({ [preset.field]: preset.value } as unknown as Post) : null);
      setSheetOpen(true);
    }
  };
  const openEdit = (it: Post) => {
    if (activeCollection) vNav(`/collections/${activeCollection}/items/${it.id}${location.search}`, "forward");
    else { setSheetMode("edit"); setSheetItem(it); setSheetOpen(true); }
  };
  // Kanban drag-and-drop → patch the row's status field. The hook owns the
  // optimistic move + rollback; we just toast on error.
  const changeItemStatus = (it: Post, status: string) => {
    if (!activeCollection || !kanbanStatusField) return;
    const myRoles = ((identity.data as { roles?: string[] } | undefined)?.roles ?? null) as
      | string[]
      | null;
    const field = kanbanStatusField.name;
    const prev = (it as unknown as Record<string, unknown>)[field];
    if (prev === status) return;
    // Refuse an illegal drop BEFORE mutating. The server would refuse it too
    // and the optimistic move would roll back — but a card that visibly jumps
    // to a column and then springs back reads as a bug, where a card that
    // simply does not move plus a toast reads as a rule.
    const spec = (kanbanStatusField as { transitions?: unknown }).transitions;
    if (spec) {
      const verdict = evaluateTransition(spec as never, {
        from: prev,
        to: status,
        roles: myRoles,
        row: it as unknown as Record<string, unknown>,
      });
      if (!verdict.ok) {
        pushToast(verdict.message, "error");
        return;
      }
    }
    // The lifecycle board (`_status`) is not a plain field — moving a card
    // fires the real publish/unpublish/archive action (permission-gated, stamps
    // `_published_at`, emits a realtime event) instead of a column write.
    if (field === "_status") {
      const action =
        status === "published" ? "publish" : status === "archived" ? "archive" : "unpublish";
      itemPublish.mutate(
        { id: it.id, action },
        { onError: (e) => pushToast((e as Error).message, "error") },
      );
      return;
    }
    itemPatch.mutate(
      { id: it.id, patch: { [field]: status } },
      { onError: (e) => pushToast((e as Error).message, "error") },
    );
    // Custom-status → lifecycle trigger: if this column's value is mapped (e.g.
    // `done` → `publish`) on a versioned collection, also fire the lifecycle
    // action so the card's `_status` follows its board column.
    const actionMap = (schemaState as { kanbanActionMap?: Record<string, string> | null }).kanbanActionMap;
    const mapped = actionMap?.[status];
    if (mapped && (schemaState as { versioned?: boolean }).versioned) {
      itemPublish.mutate(
        { id: it.id, action: mapped as "publish" | "unpublish" | "archive" },
        { onError: (e) => pushToast((e as Error).message, "error") },
      );
    }
  };

  // Per-collection bulk export — streams the file straight from the API (the
  // browser carries the session cookie, so a plain anchor download works).
  const exportItems = (format: "json" | "csv") => {
    if (!activeCollection) return;
    const a = document.createElement("a");
    a.href = `/api/items/${activeCollection}/export?format=${format}`;
    a.download = `${activeCollection}.${format}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };
  // Per-collection bulk import — pick a .json/.csv file, POST it to the import
  // endpoint, surface the per-row outcome, then refresh the list.
  const importItems = () => {
    if (!activeCollection) return;
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,.csv,application/json,text/csv";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const text = await file.text();
      const format = file.name.toLowerCase().endsWith(".csv") ? "csv" : "json";
      try {
        const r = await itemsApi.importItems(activeCollection, text, format);
        pushToast(t`Imported ${r.data.total} rows — ${r.data.inserted} new, ${r.data.updated} updated.`);
        if (r.data.failed) pushToast(t`${r.data.failed} rows failed — see the API response for details.`, "error");
        refresh();
      } catch (err) {
        pushToast((err as Error).message, "error");
      }
    };
    input.click();
  };

  // Split-button save. The primary "Save" action closes the sheet on success
  // (opts.close === true, also the default for `Enter` / `Cmd+Enter` and the
  // create-mode button). The dropdown's "Save and continue" passes
  // `close: false` — we keep the sheet open and hand it a fresh `sheetItem` so
  // its useEffect re-syncs the draft to the server-confirmed values. Returns
  // `false` on failure so the sheet can stay dirty for retries (and won't
  // close).
  const onSave = async (
    draft: Partial<Post>,
    opts?: { close?: boolean },
  ): Promise<boolean> => {
    const close = opts?.close ?? true;
    if (sheetMode === "create") {
      let nu: Post;
      try {
        // The hook prepends an optimistic row (under tempId) and swaps in the
        // server row on success; we use the resolved row for sheet bookkeeping.
        const res = await itemCreate.mutateAsync({
          draft: draft as Record<string, unknown>,
          tempId: `tmp_${crypto.randomUUID()}`,
        });
        // Defaults first as their own object, so the two spreads that follow
        // are plainly the ones that win. Written inline, every default read as
        // "specified more than once, so this usage will be overwritten" —
        // correct, but indistinguishable from the case where that is a mistake.
        const blank: Post = {
          id: "",
          updated_at: new Date().toISOString(),
          view_count: 0,
          word_count: 0,
          published_at: null,
          title: "",
          slug: "",
          status: "draft",
          author: "u_1",
        };
        nu = { ...blank, ...(draft as Post), ...(res.data as unknown as Post) };
      } catch (e) {
        pushToast((e as Error).message, "error");
        return false;
      }
      pushToast(t`Post "${(nu.title ?? "").slice(0, 38)}${(nu.title ?? "").length > 38 ? "…" : ""}" created.`);
      // Flip the sheet into edit mode on the freshly-created row (server id) so
      // subsequent saves PATCH it rather than re-inserting.
      setSheetMode("edit");
      setSheetItem(nu);
    } else if (sheetItem) {
      try {
        await itemPatch.mutateAsync({
          id: sheetItem.id,
          patch: draft as Record<string, unknown>,
        });
      } catch (e) {
        pushToast((e as Error).message, "error");
        return false;
      }
      const updated = { ...sheetItem, ...draft, updated_at: new Date().toISOString() } as Post;
      pushToast(t`Post saved.`);
      // Hand the sheet a new object reference so its useEffect re-syncs the
      // draft to the server-confirmed values.
      setSheetItem(updated);
    }
    if (close) setSheetOpen(false);
    return true;
  };

  // Publish / unpublish / schedule the open versioned item. Updates the row's
  // `_status` / `_publish_at` in place and re-syncs the sheet.
  const onPublish = async (
    action: "publish" | "unpublish" | "schedule",
    publishAt?: string | null,
  ): Promise<void> => {
    if (!sheetItem) return;
    try {
      const res = await itemPublish.mutateAsync({ id: sheetItem.id, action, publishAt });
      const updated = { ...sheetItem, ...(res.data as Partial<Post>) } as Post;
      setSheetItem(updated);
      pushToast(
        action === "publish"
          ? t`Item published.`
          : action === "unpublish"
            ? t`Item reverted to draft.`
            : t`Publish scheduled.`,
      );
    } catch (e) {
      pushToast((e as Error).message, "error");
    }
  };

  const onBulkUpdate = async (data: Record<string, unknown>) => {
    const ids = [...selected];
    try {
      // The hook optimistically patches every id, then reconciles to only the
      // server-confirmed ones; we just toast the resulting counts.
      const res = await bulkUpdate.mutateAsync({ ids, data });
      const r = res.data;
      pushToast(
        r.failed > 0 ? t`${r.updated} updated, ${r.failed} skipped.` : t`${r.updated} updated.`,
      );
      setSelected(new Set());
      setBulkEditOpen(false);
    } catch (e) {
      pushToast((e as Error).message, "error");
    }
  };
  /**
   * Retire (or restore) every selected row.
   *
   * Goes through the existing bulk-update mutation rather than looping the
   * `retire` verb: the verb writes one column through `performUpdate`, and so
   * does bulk-update — the row scope and the field allow-list are enforced the
   * same way either side. A loop of N requests would only add N round trips and
   * a partial-failure story the bulk endpoint already reports.
   */
  const onBulkRetire = async (retire: boolean) => {
    if (!retireField?.retire) return;
    const ids = [...selected];
    const live = liveValueOf(retireField);
    try {
      const res = await bulkUpdate.mutateAsync({
        ids,
        data: { [retireField.name]: retire ? !live : live },
      });
      const r = res.data;
      pushToast(
        r.failed > 0
          ? (retire ? t`${r.updated} taken out of play, ${r.failed} skipped.` : t`${r.updated} put back in play, ${r.failed} skipped.`)
          : (retire ? t`${r.updated} taken out of play.` : t`${r.updated} put back in play.`),
        r.failed > 0 && r.updated === 0 ? "error" : undefined,
      );
      setSelected(new Set());
    } catch (e) {
      pushToast((e as Error).message, "error");
    }
  };
  const onBulkPublish = async () => {
    const ids = [...selected];
    const { okIds, failed } = await bulkPublish.mutateAsync({ ids });
    pushToast(
      failed > 0 ? t`${okIds.length} published, ${failed} failed.` : t`${okIds.length} published.`,
      failed > 0 && okIds.length === 0 ? "error" : undefined,
    );
    setSelected(new Set());
  };
  const onBulkDelete = () => {
    setConfirm({
      title: t`Delete ${selected.size} posts?`,
      description: t`These rows will be removed from c_posts. This deletes the underlying records — revisions remain available.`,
      actionLabel: t`Delete`,
      destructive: true,
      onConfirm: async () => {
        const ids = [...selected];
        // The hook removes all ids optimistically, then re-inserts any the
        // server failed to delete.
        const { okIds, failed } = await bulkDelete.mutateAsync({ ids });
        pushToast(
          failed > 0 ? t`${okIds.length} deleted, ${failed} failed.` : t`${okIds.length} posts deleted.`,
          failed > 0 && okIds.length === 0 ? "error" : undefined,
        );
        setSelected(new Set());
        setConfirm(null);
      },
    });
  };

  // Real refetch now — the old `refresh` only toasted and never reloaded.
  const refresh = () => {
    if (activeCollection) void qc.invalidateQueries({ queryKey: ["items", activeCollection] });
    pushToast(t`Items refreshed.`);
  };

  const onPaletteSelect = (sel: any) => {
    setPaletteOpen(false);
    if (sel.kind === "item") {
      const it = posts.find((p) => p.id === sel.id);
      if (it) openEdit(it);
    } else if (sel.kind === "action") {
      if (sel.id === "new-post") openCreate();
      if (sel.id === "refresh") refresh();
      if (sel.id === "toggle-theme") toggleDark();
    } else if (sel.kind === "page") {
      setActiveNav(sel.id);
    } else if (sel.kind === "collection") {
      setActiveCollection(sel.id);
    }
  };

  // What this collection calls one of its rows. The heading already used it;
  // the create button said "New post" on every collection until now. Bound to a
  // plain identifier because a complex expression inside <Trans> compiles to a
  // positional {0} placeholder, and a stripped compiler has rendered one of
  // those literally in production before.
  const rowLabel = schemaState.singular?.trim() || activeCollection;

  return (
    // `TooltipProvider` is mounted HERE rather than around the whole app in
    // main.tsx, and the reason is measurable: it is the only Radix component in
    // the eager shell, and `radix-vendor` is one pinned chunk — so one provider
    // put all 45 KB gzip of Radix in front of first paint for everybody,
    // including the stranger opening a public booking link, who never sees a
    // tooltip. Inside the lazy admin chunk it costs exactly the people who use
    // one. Nothing outside the admin renders a `<Tooltip>`.
    <TooltipProvider delayDuration={0}>
    <PreferencesProvider>
    <AdminLocaleSync />
    <CosmosStars />
    <SidebarProvider
      open={!tweaks.sidebarCollapsed}
      onOpenChange={(o) => setTweak("sidebarCollapsed", !o)}
      className="relative z-10 h-svh bg-transparent"
      data-density={tweaks.density}
    >
      <Sidebar activeNav={activeNav} setActiveNav={navTo} pushToast={pushToast} collectionsCount={collections.length} activeCollection={activeCollection} isAdmin={me ? me.isAdmin : null} navGrants={me?.nav ?? null} extensionPanels={extensionPanels.map(({ id, label, icon }) => ({ id, label, icon }))} />

      <SidebarInset className="min-h-0 min-w-0 bg-transparent">
        <DemoBanner />
        <Topbar
          crumbs={
            activeNav === "collections" && activeCollection
              ? ["collections", activeCollection]
              : activeNav === "flows" && activeFlow
                ? ["flows", activeFlow]
                : [activeNav]
          }
          onOpenPalette={() => setPaletteOpen(true)}
          onSignOut={onSignOut}
          user={me}
          onAccountSettings={() => navigate("/account")}
        />

        <div className="scrollarea" style={{ flex: 1 }}>
          <div className="page">
            <Suspense fallback={<PageSkeleton nav={activeNav} />}>
            {unknownRoute && (
              <EmptyState
                icon={I.Search}
                title={<Trans>This page does not exist</Trans>}
                description={
                  <Trans>
                    Nothing is routed at <span className="font-mono">{location.pathname}</span>.
                    It may have been renamed, or the link may be out of date.
                  </Trans>
                }
                action={
                  <Button variant="primary" size="sm" onClick={() => vNav("/" + initialNav)}>
                    <Trans>Go to Overview</Trans>
                  </Button>
                }
              />
            )}
            {!unknownRoute && activeNav === "overview" && <OverviewPage adapter={tweaks.adapter} pushToast={pushToast} setActiveNav={setActiveNav} />}
            {activeNav === "ask-ai" && <AskAiPage pushToast={pushToast} />}
            {activeNav === "database" && <DatabasePage pushToast={pushToast} adapter={tweaks.adapter} />}
            {activeNav === "storage" && <StoragePage pushToast={pushToast} />}
            {activeNav === "flows" && <FlowsPage pushToast={pushToast} activeFlow={activeFlow} setActiveFlow={setActiveFlow} />}
            {activeNav === "agents" && <AgentsPage pushToast={pushToast} setActiveNav={setActiveNav} />}
            {activeNav === "chat" && <ChatPage pushToast={pushToast} setActiveNav={setActiveNav} />}
            {activeNav === "functions" && <FunctionsPage pushToast={pushToast} />}
            {activeNav === "jobs" && <JobsPage pushToast={pushToast} />}
            {activeNav === "feature-flags" && <FeatureFlagsPage pushToast={pushToast} />}
            {activeNav === "forms" && <FormsPage pushToast={pushToast} setActiveNav={setActiveNav} activeForm={activeFormId} openFormAt={openFormAt} />}
            {activeNav === "webhooks" && <WebhooksPage pushToast={pushToast} />}
            {activeNav === "integrations" && <IntegrationsPage pushToast={pushToast} />}
            {activeNav === "payments" && <PaymentsPage pushToast={pushToast} />}
            {activeNav === "graphql" && <GraphqlPage />}
            {activeNav === "rest-explorer" && <RestExplorerPage />}
            {activeNav === "openapi" && <OpenApiExportPage />}
            {activeNav === "realtime" && <RealtimePage events={events} active={realtimeChannel} onActiveChange={setRealtimeChannel} pushToast={pushToast} />}
            {activeNav === "logs" && <LogsPage pushToast={pushToast} />}
            {activeNav === "traces" && <TracesPage pushToast={pushToast} />}
            {activeNav === "usage" && <UsagePage pushToast={pushToast} />}
            {activeNav === "analytics" && (
              <AnalyticsPage pushToast={pushToast} setActiveNav={setActiveNav} />
            )}
            {activeNav === "tag-manager" && (
              <TagManagerPage pushToast={pushToast} setActiveNav={setActiveNav} />
            )}
            {activeNav === "websites" && (
              <WebsitesPage pushToast={pushToast} setActiveNav={setActiveNav} />
            )}
            {activeNav === "consent" && (
              <ConsentPage pushToast={pushToast} setActiveNav={setActiveNav} />
            )}
            {activeNav === "advisor" && <AdvisorPage pushToast={pushToast} />}
            {activeNav === "schema-graph" && <SchemaGraphPage pushToast={pushToast} />}
            {activeNav === "search" && <SearchPlaygroundPage pushToast={pushToast} />}
            {activeNav === "schema-versions" && <SchemaVersionsPage pushToast={pushToast} />}
            {activeNav === "database-import" && <DatabaseImportPage pushToast={pushToast} />}
            {activeNav === "insights" && <InsightsPage pushToast={pushToast} />}
            {activeNav === "kpis" && <KpisPage pushToast={pushToast} />}
            {activeNav === "revisions" && <RevisionsPage pushToast={pushToast} />}
            {activeNav === "translations" && <TranslationsPage pushToast={pushToast} />}
            {activeNav === "authentication" && <AuthSettingsPage pushToast={pushToast} />}
            {activeNav === "platform-sso" && <PlatformSsoSettingsPage pushToast={pushToast} />}
            {activeNav === "users" && <UsersPage pushToast={pushToast} />}
            {activeNav === "app-users" && <AppUsersPage pushToast={pushToast} />}
            {activeNav === "app-orgs" && <AppOrgsPage pushToast={pushToast} />}
            {activeNav === "api-keys" && <ApiKeys />}
            {activeNav === "email-templates" && <EmailTemplatesPage pushToast={pushToast} />}
            {activeNav === "documents" && <DocumentsPage pushToast={pushToast} />}
            {activeNav === "approvals" && <ApprovalsPage pushToast={pushToast} />}
            {activeNav === "signatures" && <SignaturesPage pushToast={pushToast} />}
            {activeNav === "booking" && <BookingPage pushToast={pushToast} activeResource={activeBooking} openResourceAt={openBooking} />}
            {activeNav === "settings" && <SettingsPage adapter={tweaks.adapter} pushToast={pushToast} />}
            {activeNav === "extensions" && <ExtensionsPage pushToast={pushToast} />}
            {/* Extension-contributed panel pages — a sandboxed iframe host per
                enabled panel, routed like any static page via NAV_IDS. */}
            {activeNav.startsWith("ext:") && (() => {
              const panel = extensionPanels.find((p) => p.id === activeNav);
              if (!panel) return null;
              return (
                <div className="flex min-h-[calc(100svh-8rem)] flex-col gap-4.5">
                  <PageHeader
                    title={panel.label}
                    description={t`Extension panel · ${panel.extension.name} v${panel.extension.version}`}
                  />
                  <ExtensionFrame
                    extension={panel.extension}
                    entry={panel.entry}
                    mode="panel"
                    className="min-h-[420px] flex-1"
                  />
                </div>
              );
            })()}
            {activeNav === "account" && <AccountPage pushToast={pushToast} />}
            {activeNav === "access" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
                <PageHeader title={t`Roles & permissions`} description={t`System roles ship with the platform; custom roles layer additively.`} />
                <RolesPageWithMembers pushToast={pushToast} />
              </div>
            )}
            {activeNav === "collections" && !activeCollection && (
              <CollectionsIndex
                collections={collections}
                collectionGroups={collectionGroups}
                canManage={me ? me.isAdmin : true}
                showArchived={showArchived}
                onToggleArchived={(next) => setShowArchived(next)}
                onOpen={(slug) => { setActiveCollection(slug); setActiveTab("items"); }}
                onOpenApi={(slug) => navigate(slug ? `/rest-explorer?slug=${encodeURIComponent(slug)}` : "/rest-explorer")}
                onOpenSchema={() => navigate("/schema-graph")}
                onNew={() => setNewCollectionOpen(true)}
                onDelete={async (slug) => {
                  // Branch by adopted flag — adopted collections soft-delete
                  // (archive, reversible), managed ones hard-DROP the table.
                  const target = (collections as Array<CollectionListItem & { adopted?: boolean }>).find((c) => c.slug === slug);
                  const adopted = !!target?.adopted;
                  // Ask what the delete would destroy before describing it. A
                  // managed collection with rows in it is a different decision
                  // from an empty one, and the dialog should say which this is.
                  const rows = adopted
                    ? 0
                    : await collectionsApi
                        .removeImpact(slug)
                        .then((r) => r.rows)
                        // Probe failed — assume the worst, which is the safe
                        // direction for a confirmation.
                        .catch(() => -1);
                  setConfirm({
                    title: adopted
                      ? <Trans>Archive collection <span className="font-mono">c_{slug}</span>?</Trans>
                      : <Trans>Delete collection <span className="font-mono">c_{slug}</span>?</Trans>,
                    description: adopted
                      ? <Trans>Backlex stops treating this table as a collection. The underlying table and its rows stay intact; you can restore from the Archived view.</Trans>
                      : rows === 0
                        ? <Trans>The physical table is dropped. It holds no rows, so no data is lost. Permissions, revisions, and webhooks tied to this collection are removed too.</Trans>
                        : <Trans>The physical table and its {rows} row(s) are dropped. The rows are saved to a backup first, but the collection itself is not restorable. Permissions, revisions, and webhooks tied to it are removed too.</Trans>,
                    actionLabel: adopted ? t`Archive collection` : t`Delete collection`,
                    destructive: !adopted,
                    ...(!adopted && rows !== 0 ? { confirmText: slug, confirmTextLabel: t`Type the collection slug to confirm` } : {}),
                    onConfirm: async () => {
                      try {
                        const resp = await collectionsApi.remove(slug, { confirm: !adopted });
                        invalidateCollections();
                        if (activeCollection === slug) setActiveCollection(null);
                        pushToast(resp.archived
                          ? t`Collection c_${slug} archived. Restore it from the Archived view.`
                          : resp.snapshotId
                            ? t`Collection c_${slug} dropped. ${resp.rows} row(s) saved to a backup.`
                            : t`Collection c_${slug} dropped.`);
                      } catch (e) {
                        pushToast((e as Error).message, "error");
                      }
                      setConfirm(null);
                    },
                  });
                }}
                onRestore={(slug) => setConfirm({
                  title: <Trans>Restore collection <span className="font-mono">c_{slug}</span>?</Trans>,
                  description: <Trans>Backlex will start treating this table as a collection again. Owner-scoped permissions are re-seeded if they were configured.</Trans>,
                  actionLabel: t`Restore collection`,
                  destructive: false,
                  onConfirm: async () => {
                    try {
                      await collectionsApi.restore(slug);
                      pushToast(t`Collection c_${slug} restored.`);
                      // Refresh both list entries — the restored row falls
                      // off the archived list and back onto the active one.
                      invalidateCollections();
                    } catch (e) {
                      pushToast((e as Error).message, "error");
                    }
                    setConfirm(null);
                  },
                })}
                pushToast={pushToast}
              />
            )}
            {/* Full-page item editor — replaces the items list when an item
                (or /new) is selected. Waits only for the schema, not the list. */}
            {activeNav === "collections" && activeCollection && activeItem && (
              schemaReady ? (
                <ItemEditorPage
                  slug={activeCollection}
                  itemId={activeItem}
                  schema={schemaState}
                  initialItem={posts.find((p) => p.id === activeItem) ?? null}
                  createPreset={(() => {
                    const raw = new URLSearchParams(location.search).get("new");
                    const i = raw ? raw.indexOf(":") : -1;
                    return i > 0 ? { [raw!.slice(0, i)]: raw!.slice(i + 1) } : null;
                  })()}
                  siblingIds={itemsForView.map((p) => p.id)}
                  versioned={schemaState.versioned}
                  canPublish
                  pushToast={pushToast}
                  onSaved={(updated) => patchItemsCache((rows) => rows.map((x) => (x.id === updated.id ? updated : x)))}
                  onCreated={(created) => patchItemsCache((rows) => [created, ...rows])}
                  onDeleted={(id) => patchItemsCache((rows) => rows.filter((x) => x.id !== id))}
                  onBack={() => vNav(`/collections/${activeCollection}${location.search}`, "back")}
                  navigateToItem={(id) => vNav(`/collections/${activeCollection}/items/${id}${location.search}`, "forward")}
                />
              ) : (
                <CollectionItemsSkeleton />
              )
            )}
            {activeNav === "collections" && activeCollection && !activeItem && ((collectionLoading && schemaState.slug !== activeCollection) || !itemsLoaded) && (
              <CollectionItemsSkeleton />
            )}
            {activeNav === "collections" && activeCollection && !activeItem && !((collectionLoading && schemaState.slug !== activeCollection) || !itemsLoaded) && <>
              {/* Cosmos console breadcrumb — replaces the old "All collections"
                  back button. "collections" links back to the index; the
                  c_<slug> crumb is the current physical table. */}
              <div className="flex items-center gap-1.5 self-start font-mono text-[12.5px]">
                <button
                  type="button"
                  onClick={() => setActiveCollection(null)}
                  className="cursor-pointer border-0 bg-transparent p-0 text-[#8580A2] transition-colors hover:text-foreground"
                >
                  <Trans>collections</Trans>
                </button>
                <span className="text-white/20">/</span>
                <span className="font-semibold text-foreground">c_{activeCollection}</span>
              </div>
              {/* "Backlex Console" collection header — display-name title +
                  {rows · fields · owner-scoped} subtitle on the left, the
                  preserved action set (Refresh/Import/Export/API) plus the
                  violet-gradient New-item CTA on the right. */}
              <div className="flex flex-wrap items-end justify-between gap-4">
                <div className="flex min-w-0 flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2.5">
                    <h1 className="m-0 text-[26px] font-normal leading-none tracking-[-0.02em] text-foreground">
                      {rowLabel}
                    </h1>
                    <span className="inline-flex flex-wrap gap-1.5">
                      <Badge variant="outline" mono>{ADAPTER_PROFILES[tweaks.adapter].db}</Badge>
                      {itemsLive && (
                        <Badge variant="outline" title={t`This list updates in real time`}>
                          <span className="inline-block size-1.5 rounded-full bg-emerald-500 animate-pulse" />
                          <Trans>Live</Trans>
                        </Badge>
                      )}
                    </span>
                  </div>
                  <p className="m-0 text-[13px] text-muted-foreground">
                    {t`${total} rows · ${schemaState.fields.length} fields`}
                    {schemaState.ownerScoped ? ` · ${t`owner-scoped`}` : ""}
                  </p>
                  {/* A note is what a collection says about itself, and the
                      list is where somebody is about to edit a row — which for
                      a collection something else writes (booking records,
                      payment syncs) is exactly where "this is a record, not a
                      control" has to be legible. It was only ever shown on the
                      index card and in the Settings tab, neither of which is
                      on the way here. */}
                  {schemaState.note ? (
                    <p
                      className="m-0 max-w-prose text-[13px] text-muted-foreground/80"
                      title={schemaState.note}
                    >
                      {schemaState.note}
                    </p>
                  ) : null}
                </div>
                <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
                  {/* Desktop: all secondary actions inline. */}
                  <div className="hidden items-center gap-2 sm:flex">
                    <Button variant="outline" icon={I.Refresh} onClick={refresh}><Trans>Refresh</Trans></Button>
                    <Button variant="outline" icon={I.Upload} onClick={importItems}><Trans>Import</Trans></Button>
                    <Button variant="outline" icon={I.Download} onClick={() => exportItems("csv")}><Trans>Export CSV</Trans></Button>
                    <Button variant="outline" icon={I.ExternalLink} onClick={() => navigate(`/rest-explorer?slug=${encodeURIComponent(activeCollection)}`)}>API</Button>
                  </div>
                  <Button
                    variant="primary"
                    icon={I.Plus}
                    // `onClick={openCreate}` would hand the click event to the
                    // `status` parameter. `openCreate` guards against that
                    // internally (see its comment — it shipped once as a
                    // "[object Object]" preset), but the guard existed because
                    // this callsite was wrong and the compiler could not say so.
                    onClick={() => openCreate()}
                    className="btn-cta h-[34px] gap-1.5 px-3.5 text-[13px] font-semibold"
                  >
                    {/* The collection's own singular, which is what the Settings
                        tab already tells operators this button uses — it said
                        "New post" on invoices, technicians and every other
                        collection, while the heading beside it read correctly. */}
                    <Trans>New {rowLabel}</Trans>
                  </Button>
                  {/* Mobile: collapse the secondary actions into an overflow menu on
                      the right; the create button stays primary. Hidden on desktop (inline above). */}
                  <DropdownMenu modal={false}>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" icon={I.More} aria-label={t`More actions`} className="px-2 sm:hidden" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="z-[70]">
                      <DropdownMenuItem onSelect={refresh}><I.Refresh size={14} /><Trans>Refresh</Trans></DropdownMenuItem>
                      <DropdownMenuItem onSelect={importItems}><I.Upload size={14} /><Trans>Import</Trans></DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => exportItems("csv")}><I.Download size={14} /><Trans>Export CSV</Trans></DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => navigate(`/rest-explorer?slug=${encodeURIComponent(activeCollection)}`)}><I.ExternalLink size={14} />API</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>

              <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as (typeof COLLECTION_TABS)[number])}>
                <TabsList>
                  <TabsTrigger value="items">
                    <I.Inbox size={13} /><Trans>Items</Trans> <span className={TAB_COUNT_CLS}>{posts.length}</span>
                  </TabsTrigger>
                  {/* Only where there is something to show. A tab that
                      exists on all 116 collections and is empty on most of
                      them advertises a dead end; the count carries the "there
                      are numbers here" signal without a click. */}
                  {collectionKpiCount > 0 && (
                    <TabsTrigger value="kpis">
                      <I.Gauge size={13} /><Trans>KPIs</Trans> <span className={TAB_COUNT_CLS}>{collectionKpiCount}</span>
                    </TabsTrigger>
                  )}
                  <TabsTrigger value="schema">
                    <I.Braces size={13} /><Trans>Schema</Trans> <span className={TAB_COUNT_CLS}>{schemaState.fields.length}</span>
                  </TabsTrigger>
                  <TabsTrigger value="settings">
                    <I.Settings size={13} /><Trans>Settings</Trans>
                  </TabsTrigger>
                </TabsList>
              </Tabs>

              {activeTab === "items" && (
                <div className={tweaks.showRealtime ? "grid grid-cols-[1fr_320px] items-start gap-4 max-[1280px]:grid-cols-1" : "grid grid-cols-1"}>
                  <div className="flex min-w-0 flex-col gap-3">
                    <FilterBar
                      search={search} setSearch={setSearch}
                      filters={filters} setFilters={setFilters}
                      schema={schemaState}
                      status={statusTab} setStatus={setStatusTab}
                      retired={retiredTab} setRetired={setRetiredTab}
                      total={tweaks.populated ? posts.length : 0}
                    />
                    {/* Card labels are running on the composed/short-id
                        fallback — nudge toward the permanent fix (a display
                        template) where the big label is what you look at. */}
                    {schemaReady && viewMode !== "table" && needsDisplayTemplate(schemaState) && (
                      <div className="flex items-center gap-2.5 rounded-control border border-border bg-muted/50 px-3.5 py-2 text-[12px] text-muted-foreground">
                        <I.Info size={13} className="shrink-0" />
                        <span className="min-w-0 flex-1">
                          <Trans>No display template set — cards label rows from their first text fields. Define a template in Settings for proper labels.</Trans>
                        </span>
                        <Button variant="outline" size="sm" onClick={() => setActiveTab("settings")}>
                          <Trans>Open settings</Trans>
                        </Button>
                      </div>
                    )}
                    {(schemaState as { status?: string }).status === "inactive" && (
                      <div className="flex flex-wrap items-center gap-2.5 rounded-surface border border-amber-500/30 bg-amber-500/10 px-3.5 py-2.5">
                        <I.AlertTriangle size={14} className="shrink-0 text-amber-500" />
                        <span className="min-w-[200px] flex-1 text-[12.5px] text-muted-foreground">
                          <Trans>This collection is disabled — its content API returns 404, so items can't be listed or edited. Schema and settings stay editable.</Trans>
                        </span>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={async () => {
                            const slug = activeCollection || "posts";
                            const prev = schemaState;
                            setSchemaState((s) => ({ ...s, status: "active" } as typeof s));
                            try {
                              await collectionsApi.patch(slug, { status: "active" } as any);
                              invalidateCollections();
                              pushToast(t`Collection enabled.`);
                            } catch (e) {
                              setSchemaState(prev);
                              pushToast((e as Error).message, "error");
                            }
                          }}
                        >
                          <Trans>Enable</Trans>
                        </Button>
                      </div>
                    )}
                    <Card className="gap-0 overflow-hidden rounded-surface py-0">
                      <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
                        <ItemsViewToggle
                          mode={viewMode}
                          setMode={(m) => setView(m)}
                          hasStatus={!!resolveKanbanGroupField(schemaState as unknown as { fields?: Array<Record<string, unknown>>; kanbanGroupBy?: string | null; versioned?: boolean } | null)}
                        />
                        <div className="flex-1" />
                        {viewMode === "table" && (
                          <button
                            type="button"
                            onClick={() => setGridUrl(gridMode ? "" : "1")}
                            aria-pressed={gridMode}
                            title={t`Grid edit — select cells, type to edit, copy/paste, fill down`}
                            className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-control border px-2.5 text-[12px] font-medium transition-colors ${gridMode ? "border-[color-mix(in_oklch,var(--primary)_45%,transparent)] bg-[color-mix(in_oklch,var(--primary)_14%,transparent)] text-foreground" : "border-border bg-white/[0.03] text-muted-foreground hover:text-foreground"}`}
                          >
                            <I.Grid3 size={13} />
                            <span className="max-sm:hidden">{t`Grid edit`}</span>
                          </button>
                        )}
                        {viewMode === "table" && schemaState.slug && (
                          <ColumnPicker slug={schemaState.slug} fields={schemaState.fields as never} />
                        )}
                        <button
                          type="button"
                          onClick={() => setTweak("showRealtime", !tweaks.showRealtime)}
                          aria-pressed={tweaks.showRealtime}
                          title={t`Live tail`}
                          className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-control border px-2.5 text-[12px] font-medium transition-colors ${tweaks.showRealtime ? "border-[color-mix(in_oklch,var(--primary)_45%,transparent)] bg-[color-mix(in_oklch,var(--primary)_14%,transparent)] text-foreground" : "border-border bg-white/[0.03] text-muted-foreground hover:text-foreground"}`}
                        >
                          <I.Zap size={13} />
                          <span className="max-sm:hidden">{t`Live tail`}</span>
                        </button>
                      </div>
                      <FilterDSLPreview filters={filters} sort={sort} />
                      {viewMode === "table" && (
                        <BulkBar
                          count={selected.size}
                          onClear={() => setSelected(new Set())}
                          onEdit={() => setBulkEditOpen(true)}
                          onPublish={onBulkPublish}
                          onDelete={onBulkDelete}
                          onRetire={retireField ? onBulkRetire : undefined}
                        />
                      )}
                      {viewMode === "table" && gridMode && pageRows.length > 0 && (
                        <div className="flex items-center gap-3 border-b border-border bg-[color-mix(in_oklch,var(--primary)_6%,transparent)] px-3.5 py-1.5 font-mono text-[10.5px] text-muted-foreground max-sm:hidden">
                          <span className="text-foreground"><Trans>Grid edit</Trans></span>
                          <span><Trans>Enter — edit</Trans></span>
                          <span>⌘C / ⌘V — <Trans>copy / paste</Trans></span>
                          <span>⌘D — <Trans>fill down</Trans></span>
                          <span>⌫ — <Trans>clear</Trans></span>
                          <span>⌘Z — <Trans>undo</Trans></span>
                        </div>
                      )}
                      {viewMode === "table" && (
                        pageRows.length === 0 ? (
                          <EmptyItems onCreate={openCreate} slug={activeCollection ?? undefined} />
                        ) : (
                          <ItemsTable rows={pageRows} selected={selected} setSelected={setSelected} sort={sort} setSort={setSort} onEdit={openEdit} schema={schemaState} onCellError={(e) => pushToast((e as Error).message, "error")} gridMode={gridMode} onNotice={(m, k) => pushToast(m, k)} />
                        )
                      )}
                      {viewMode === "kanban" && (
                        itemsForView.length === 0 ? (
                          <EmptyItems onCreate={openCreate} slug={activeCollection ?? undefined} />
                        ) : (
                          <KanbanBoard rows={itemsForView} onEdit={openEdit} displayTemplate={schemaState.displayTemplate} fields={schemaState.fields as never} statusField={kanbanStatusField} onChangeStatus={changeItemStatus} onCreate={openCreate} />
                        )
                      )}
                      {viewMode === "gallery" && (
                        itemsForView.length === 0 ? (
                          <EmptyItems onCreate={openCreate} slug={activeCollection ?? undefined} />
                        ) : (
                          <GalleryGrid rows={itemsForView} onEdit={openEdit} displayTemplate={schemaState.displayTemplate} fields={schemaState.fields as never} />
                        )
                      )}
                      {viewMode === "calendar" && (
                        <CalendarView rows={itemsForView} onEdit={openEdit} displayTemplate={schemaState.displayTemplate} fields={schemaState.fields as never} />
                      )}
                      {viewMode === "table" && pageRows.length > 0 && (
                        <div className="flex flex-wrap items-center gap-2 border-t border-white/5 bg-white/[0.02] px-4 py-2.5">
                          <span className="text-[11.5px] text-muted-foreground">
                            {t`Showing ${(page - 1) * PER_PAGE + 1}–${Math.min(page * PER_PAGE, total)} of ${total} rows`}
                          </span>
                          <div className="flex-1" />
                          <div className="flex flex-wrap items-center gap-1">
                            <button
                              type="button"
                              disabled={page === 1}
                              onClick={() => setPage((p) => Math.max(1, p - 1))}
                              className="inline-flex h-7 items-center gap-1 rounded-control border border-white/10 bg-white/[0.03] px-2.5 text-[11.5px] font-medium text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                            >
                              <I.ChevronLeft size={13} /><Trans>Prev</Trans>
                            </button>
                            {(() => {
                              // Windowed page numbers: show all when there are ≤7
                              // pages, else first/last + a ±1 window around the
                              // current page with "…" gaps. Pure display — the
                              // page/setPage pagination logic is unchanged.
                              const N = totalPages;
                              const nums: number[] = N <= 7
                                ? Array.from({ length: N }, (_, i) => i + 1)
                                : [...new Set([1, page - 1, page, page + 1, N])].filter((p) => p >= 1 && p <= N).sort((a, b) => a - b);
                              const out: React.ReactNode[] = [];
                              let prev = 0;
                              for (const p of nums) {
                                if (p - prev > 1) out.push(<span key={`gap-${p}`} className="px-1 text-[11.5px] text-muted-foreground">…</span>);
                                prev = p;
                                const active = p === page;
                                out.push(
                                  <button
                                    key={p}
                                    type="button"
                                    onClick={() => setPage(p)}
                                    aria-current={active ? "page" : undefined}
                                    className={`grid h-7 min-w-7 place-items-center rounded-control border px-2 text-[11.5px] font-medium tabular-nums transition-colors ${active ? "border-[color-mix(in_oklch,var(--primary)_40%,transparent)] bg-[color-mix(in_oklch,var(--primary)_14%,transparent)] text-foreground" : "border-white/10 bg-white/[0.03] text-muted-foreground hover:text-foreground"}`}
                                  >
                                    {p}
                                  </button>,
                                );
                              }
                              return out;
                            })()}
                            <button
                              type="button"
                              disabled={page === totalPages}
                              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                              className="inline-flex h-7 items-center gap-1 rounded-control border border-white/10 bg-white/[0.03] px-2.5 text-[11.5px] font-medium text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                            >
                              <Trans>Next</Trans><I.ChevronRight size={13} />
                            </button>
                          </div>
                        </div>
                      )}
                    </Card>
                  </div>
                  {/* Extension widgets mounted under the list, told which
                      collection is open and which rows are ticked. Renders
                      nothing when no extension contributes here. */}
                  <ExtensionWidgets
                    mount="item-list"
                    context={{
                      collection: activeCollection ?? undefined,
                      selectedIds: [...selected],
                    }}
                  />
                  {tweaks.showRealtime && (
                    <RealtimeTail events={events} channel={`items:${activeCollection ?? ""}`} connected />
                  )}
                </div>
              )}

              {activeTab === "kpis" && activeCollection && collectionKpiCount > 0 && (
                // Its own tab rather than a band above the items: nothing is
                // fetched or evaluated until someone asks for the numbers.
                <CollectionKpisPanel
                  collection={activeCollection}
                  onOpenKpisPage={() => setActiveNav("kpis")}
                />
              )}

              {activeTab === "schema" && (
                <div className="flex flex-col gap-3.5">
                  <SchemaView
                    schema={schemaState}
                    onAddField={() => setAddFieldOpen(true)}
                    onEditField={(name) => setEditFieldName(name)}
                    onReorderFields={async (from, to) => {
                      const slug = activeCollection || "posts";
                      const next = [...schemaState.fields];
                      const [moved] = next.splice(from, 1);
                      if (!moved) return;
                      next.splice(to, 0, moved);
                      // Optimistic — repaint immediately, then PATCH. Roll
                      // back on error so the row order doesn't lie.
                      const prev = schemaState.fields;
                      setSchemaState((s) => ({ ...s, fields: next }));
                      try {
                        await collectionsApi.patch(slug, { fields: next as any });
                      } catch (e) {
                        setSchemaState((s) => ({ ...s, fields: prev }));
                        pushToast((e as Error).message, "error");
                      }
                    }}
                    onDropField={(name) => setConfirm({
                      title: t`Drop column "${name}"?`,
                      description: <Trans>The column and its values are removed from <span className="font-mono">c_{activeCollection || "posts"}</span>. Any values it holds are saved to a pre-drop backup first.</Trans>,
                      actionLabel: t`Drop column`,
                      destructive: true,
                      onConfirm: async () => {
                        const slug = activeCollection || "posts";
                        // The DEDICATED drop route, not a PATCH with the field
                        // filtered out of `fields`. That PATCH only rewrites
                        // metadata — `applyCollection` is additive and never
                        // drops a column — so this dialog used to promise an
                        // irreversible ALTER TABLE while the column and every
                        // value in it quietly stayed on disk. The real route
                        // drops it and snapshots the values first, which is
                        // what the Schema graph page already called.
                        const prev = schemaState.fields;
                        const next = schemaState.fields.filter((f) => f.name !== name);
                        setSchemaState((s) => ({ ...s, fields: next }));
                        setConfirm(null);
                        try {
                          const res = await collectionsApi.dropField(slug, name, { confirm: true });
                          pushToast(
                            res.snapshotId
                              ? t`Column "${name}" dropped. ${res.nonNull} value(s) saved to a backup.`
                              : t`Column "${name}" dropped.`,
                          );
                        } catch (e) {
                          setSchemaState((s) => ({ ...s, fields: prev }));
                          pushToast((e as Error).message, "error");
                        }
                      },
                    })}
                  />
                </div>
              )}

              {activeTab === "settings" && (
                <CollectionSettings
                  schema={schemaState}
                  existingSlugs={collections.map((c) => c.slug)}
                  collections={(collectionsQuery.data?.data ?? []).map((c: any) => ({ slug: c.slug, fields: c.fields }))}
                  onRename={async (nextSlug) => {
                    const slug = activeCollection || "posts";
                    setConfirm({
                      title: <Trans>Rename <span className="font-mono">c_{slug}</span> → <span className="font-mono">c_{nextSlug}</span>?</Trans>,
                      description: <Trans>Permission rules, webhook patterns, function triggers, flow steps, revisions, comments, and audit log entries that reference <span className="font-mono">{slug}</span> will be updated. The physical table is not renamed.</Trans>,
                      actionLabel: t`Rename collection`,
                      destructive: false,
                      onConfirm: async () => {
                        try {
                          const resp = await collectionsApi.patch(slug, { slug: nextSlug } as any) as { ok?: boolean; slug?: string; renamed?: Record<string, number> };
                          // Refresh the collections cache + swap active slug + URL.
                          invalidateCollections();
                          setActiveCollection(nextSlug);
                          setSchemaState((s) => ({ ...s, slug: nextSlug }));
                          const totals = resp.renamed
                            ? Object.entries(resp.renamed)
                              .filter(([, n]) => n > 0)
                              .map(([k, n]) => `${n} ${k}`)
                              .join(", ")
                            : "";
                          pushToast(t`Renamed to c_${nextSlug}${totals ? ` (${totals} updated)` : ""}.`);
                        } catch (e) {
                          pushToast((e as Error).message, "error");
                        }
                        setConfirm(null);
                      },
                    });
                  }}
                  onPatch={async (patch) => {
                    const slug = activeCollection || "posts";
                    const prev = schemaState;
                    setSchemaState((s) => ({ ...s, ...patch }));
                    try {
                      const resp = await collectionsApi.patch(slug, patch as any);
                      // Presentation metadata (icon/color/hidden/status/note)
                      // renders in the sidebar + Collections index too — bust
                      // the list cache so they don't lag behind the settings.
                      invalidateCollections();
                      pushToast(
                        resp.ftsBackfill
                          ? t`Collection settings saved. Search index rebuilt (${resp.ftsBackfill.processed} of ${resp.ftsBackfill.total} rows indexed).`
                          : t`Collection settings saved.`,
                      );
                    } catch (e) {
                      setSchemaState(prev);
                      pushToast((e as Error).message, "error");
                    }
                  }}
                  onFtsReindex={async () => {
                    const slug = activeCollection || "posts";
                    try {
                      const r = await collectionsApi.ftsReindex(slug);
                      pushToast(t`Search index rebuilt: ${r.processed} indexed, ${r.skipped} empty, ${r.total} total.`);
                    } catch (e) {
                      pushToast((e as Error).message, "error");
                    }
                  }}
                  onVectorizeBackfill={async () => {
                    const slug = activeCollection || "posts";
                    try {
                      const r = await collectionsApi.vectorizeBackfill(slug);
                      pushToast(t`Embedded ${r.processed} of ${r.total} rows into the vector store (${r.skipped} empty).`);
                    } catch (e) {
                      pushToast((e as Error).message, "error");
                    }
                  }}
                  onDelete={async () => {
                    const adopted = !!(schemaState as { adopted?: boolean }).adopted;
                    const slug = activeCollection || "posts";
                    // Same probe as the sidebar's delete — the dialog names what
                    // is at stake instead of warning in the abstract.
                    const rows = adopted
                      ? 0
                      : await collectionsApi
                          .removeImpact(slug)
                          .then((r) => r.rows)
                          .catch(() => -1);
                    setConfirm({
                      title: adopted
                        ? <Trans>Archive collection <span className="font-mono">c_{activeCollection}</span>?</Trans>
                        : <Trans>Delete collection <span className="font-mono">c_{activeCollection}</span>?</Trans>,
                      description: adopted
                        ? <Trans>Backlex stops treating this table as a collection. The underlying table and its rows stay intact; you can restore from the Archived view.</Trans>
                        : rows === 0
                          ? <Trans>The physical table is dropped. It holds no rows, so no data is lost.</Trans>
                          : <Trans>The physical table and its {rows} row(s) are dropped. The rows are saved to a backup first, but the collection itself is not restorable.</Trans>,
                      actionLabel: adopted ? t`Archive collection` : t`Delete collection`,
                      destructive: !adopted,
                      ...(!adopted && rows !== 0 ? { confirmText: slug, confirmTextLabel: t`Type the collection slug to confirm` } : {}),
                      onConfirm: async () => {
                        try {
                          const resp = await collectionsApi.remove(slug, { confirm: !adopted });
                          invalidateCollections();
                          setActiveCollection(null);
                          pushToast(resp.archived
                            ? t`Collection c_${slug} archived. Restore it from the Archived view.`
                            : resp.snapshotId
                              ? t`Collection c_${slug} dropped. ${resp.rows} row(s) saved to a backup.`
                              : t`Collection c_${slug} dropped.`);
                        } catch (e) {
                          pushToast((e as Error).message, "error");
                        }
                        setConfirm(null);
                      },
                    });
                  }}
                />
              )}
            </>}
            </Suspense>
          </div>
        </div>
      </SidebarInset>

      <ItemSheet open={sheetOpen} mode={sheetMode} initial={sheetItem} schema={schemaState} onClose={() => setSheetOpen(false)} onSave={onSave} versioned={schemaState.versioned} canPublish onPublish={onPublish} />
      <Palette open={paletteOpen} onClose={() => setPaletteOpen(false)} onNavigate={onPaletteSelect} items={posts} collections={collections} isAdmin={me ? me.isAdmin : null} navGrants={me?.nav ?? null} />
      <BulkEditDialog
        open={bulkEditOpen}
        count={selected.size}
        schema={schemaState}
        onClose={() => setBulkEditOpen(false)}
        onApply={onBulkUpdate}
      />
      <ConfirmDialog open={!!confirm} {...(confirm || {})} onCancel={() => setConfirm(null)} />
      <NewCollectionDialog
        open={newCollectionOpen}
        onClose={() => setNewCollectionOpen(false)}
        existingSlugs={collections.map((c) => c.slug)}
        groups={collectionGroups}
        onCreate={async (c) => {
          // The wizard now passes `templateFields` derived from the chosen
          // preset (Blank → [], Content → title+slug+status+body+published_at,
          // …). System columns (id, owner_id, created_at, updated_at) are
          // added by the backend per the ownerScoped flag.
          let created = false;
          try {
            const wiz = c as {
              templateFields?: Array<{ name: string; type: string; required?: boolean; unique?: boolean }>;
              tenantScoped?: boolean;
              softDelete?: boolean;
              singleton?: boolean;
              timestamps?: boolean;
            };
            const tplFields = wiz.templateFields ?? [];
            await collectionsApi.create({
              slug: c.slug,
              fields: tplFields,
              // Wizard's group pick — persists now that the API accepts it.
              group: c.group || null,
              ownerScoped: c.ownerScoped,
              tenantScoped: wiz.tenantScoped,
              softDelete: wiz.softDelete,
              singleton: wiz.singleton,
              // "timestamps off" maps to the has_created_at/has_updated_at
              // flags the backend already threads through schema-applier.
              hasCreatedAt: wiz.timestamps,
              hasUpdatedAt: wiz.timestamps,
            } as any);
            // Refetch — the new row comes back metrics-enriched from the
            // canonical list rather than the wizard's partial draft.
            invalidateCollections();
            pushToast(t`Collection c_${c.slug} created.`);
            created = true;
          } catch (e) {
            pushToast((e as Error).message, "error");
          }
          setNewCollectionOpen(false);
          if (created) setActiveCollection(c.slug);
        }}
      />
      <EditFieldDialog
        open={editFieldName !== null}
        field={schemaState.fields.find((f) => (f as { name?: string }).name === editFieldName) ?? null}
        ownerSlug={schemaState.slug}
        collections={collections}
        availableFields={schemaState.fields
          .map((f) => (f as { name?: string }).name)
          .filter((n): n is string => !!n && n !== editFieldName)}
        groups={[
          ...new Set(
            schemaState.fields
              .map((f) => (f as { group?: string }).group)
              .filter((g): g is string => !!g && g.trim().length > 0),
          ),
        ]}
        onClose={() => setEditFieldName(null)}
        onSave={async (next) => {
          const slug = activeCollection || "posts";
          const merged = schemaState.fields.map((f) =>
            (f as { name?: string }).name === editFieldName ? (next as never) : f,
          );
          const prev = schemaState.fields;
          setSchemaState((s) => ({ ...s, fields: merged }));
          try {
            const resp = await collectionsApi.patch(slug, { fields: merged as any });
            pushToast(
              resp.ftsBackfill
                ? t`Field "${(next as { name?: string }).name}" updated. Search index rebuilt (${resp.ftsBackfill.processed} of ${resp.ftsBackfill.total} rows indexed).`
                : t`Field "${(next as { name?: string }).name}" updated.`,
            );
          } catch (e) {
            setSchemaState((s) => ({ ...s, fields: prev }));
            pushToast((e as Error).message, "error");
          }
          setEditFieldName(null);
        }}
      />
      <AddFieldDialog open={addFieldOpen} schema={schemaState} collections={collections} onClose={() => setAddFieldOpen(false)} onCreate={async (field) => {
        // schemaState.fields contains only user-defined columns now, so
        // the merged set is just append-the-new-one. System columns are
        // synthesized for display in SchemaView and must never round-trip
        // through PATCH (validateFields rejects reserved names).
        const merged = {
          ...schemaState,
          fields: [...schemaState.fields, field as never],
        };
        try {
          const slug = activeCollection || "posts";
          await collectionsApi.patch(slug, { fields: merged.fields as any });
          setSchemaState(merged);
          pushToast(t`Column "${(field as any).name}" added to c_${slug}.`);
        } catch (e) {
          pushToast((e as Error).message);
        }
        setAddFieldOpen(false);
      }} />
      {toastNode}
    </SidebarProvider>
    </PreferencesProvider>
    </TooltipProvider>
  );
}

const ACCESS_TABS = ["members", "roles", "tester"] as const;

function RolesPageWithMembers({ pushToast }: { pushToast: PushToast }) {
  const { t } = useLingui();
  const [tab, setTab] = useUrlTab(ACCESS_TABS, "members");
  return (
    <div className="flex flex-col gap-3.5">
      <Tabs value={tab} onValueChange={(v) => setTab(v as (typeof ACCESS_TABS)[number])}>
        <TabsList>
          {[
            { id: "members" as const, label: t`Members`, icon: I.Users },
            { id: "roles" as const, label: t`Roles & permissions`, icon: I.Shield },
            { id: "tester" as const, label: t`Tester`, icon: I.ShieldAlert },
          ].map((t) => (
            <TabsTrigger key={t.id} value={t.id}>
              <t.icon size={13} /><span>{t.label}</span>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {tab === "members" && <MembersPanel roles={[]} pushToast={pushToast} />}
      {tab === "roles" && <RolesPanel pushToast={pushToast} />}
      {tab === "tester" && <PermissionTesterPanel pushToast={pushToast} />}
    </div>
  );
}
