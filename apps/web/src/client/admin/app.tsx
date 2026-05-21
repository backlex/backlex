// @ts-nocheck
// workeros admin — main app
import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import "./admin.css";
import "./flow-builder.css";
import { I } from "./icons";
import { Tabs, TabsList, TabsTrigger } from "@workeros/ui/components/tabs";
import {
  ADAPTER_PROFILES,
  NAV_DEVELOPERS,
  NAV_ITEMS,
  NAV_SETTINGS,
  type AdapterId,
  type CollectionListItem,
  type CollectionSchema,
  type Post,
} from "./config";
import {
  Badge,
  Button,
  IconButton,
  PageHeader,
  Sidebar,
  Topbar,
  useToasts,
} from "./ui";
import {
  BulkBar,
  FilterBar,
  FilterDSLPreview,
  ItemsTable,
  evaluateFilter,
  resolveStatusField,
  type FilterCondition,
} from "./items";
import { ConfirmDialog, ItemSheet } from "./sheet";
import { CalendarView, GalleryGrid, ItemsViewToggle, KanbanBoard, type ItemsViewMode } from "./item-views";
import { AlterPreview, EmptyItems, Palette, RealtimeTail, SchemaView, type RealtimeEvent } from "./extras";
import { AddFieldDialog } from "./add-field";
import { loadAuthors } from "./authors-cache";
import { CollectionsIndex, NewCollectionDialog } from "./collections-index";
import { EditFieldDialog } from "./edit-field";
import { CollectionSettings } from "./collection-settings";
import { collectionsApi, itemsApi, settingsApi } from "./api";
import { useQueryClient } from "@tanstack/react-query";
import { useCollections, useMetricsOverview } from "./queries";
import { api } from "@/lib/api";
import { useUrlState, useUrlStateJson } from "@/lib/use-url-state";
import { useTheme } from "@/components/theme-provider";
import { SidebarInset, SidebarProvider } from "@workeros/ui/components/sidebar";
import { StoragePage } from "./storage";
import {
  AppUsersPage,
  AuthSettingsPage,
  DatabasePage,
  EmailTemplatesPage,
  InsightsPage,
  RevisionsPage,
  TranslationsPage,
} from "./parity-pages";
import { RoleEditor, type RoleData } from "./role-editor";
import { MembersPanel } from "./members-panel";
import { PermissionsMatrix } from "./permissions-matrix";
// Each admin page is split into its own chunk so the initial admin bundle
// stays small. The shared `<Suspense>` boundary inside the page switch below
// renders the fallback while the page chunk streams in.
const OverviewPage = lazy(() => import("./pages/overview").then((m) => ({ default: m.OverviewPage })));
const FlowsPage = lazy(() => import("./pages/flows").then((m) => ({ default: m.FlowsPage })));
const FunctionsPage = lazy(() => import("./pages/functions").then((m) => ({ default: m.FunctionsPage })));
const WebhooksPage = lazy(() => import("./pages/webhooks").then((m) => ({ default: m.WebhooksPage })));
const RealtimePage = lazy(() => import("./pages/realtime").then((m) => ({ default: m.RealtimePage })));
const LogsPage = lazy(() => import("./pages/logs").then((m) => ({ default: m.LogsPage })));
const AdvisorPage = lazy(() => import("./pages/advisor").then((m) => ({ default: m.AdvisorPage })));
const SchemaGraphPage = lazy(() => import("./pages/schema-graph").then((m) => ({ default: m.SchemaGraphPage })));
const UsersPage = lazy(() => import("./pages/users").then((m) => ({ default: m.UsersPage })));
const SettingsPage = lazy(() => import("./pages/settings").then((m) => ({ default: m.SettingsPage })));

import { PageSkeleton, CollectionItemsSkeleton } from "./page-skeletons";

const TAB_COUNT_CLS =
  "rounded-sm border border-border bg-muted px-[5px] py-px font-mono text-[11px] text-muted-foreground";
import { AccountPage } from "./account-page";
import { GraphqlPage } from "@/pages/graphql";
import { RestExplorerPage } from "@/pages/rest-explorer";
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
  showRealtime: true,
  populated: true,
};

function ageBump(t: string) {
  if (t === "just now") return "5s ago";
  const m = t.match(/^(\d+)s ago$/);
  if (m) {
    const n = parseInt(m[1], 10) + 5;
    if (n >= 60) return Math.floor(n / 60) + "m ago";
    return n + "s ago";
  }
  const m2 = t.match(/^(\d+)m ago$/);
  if (m2) {
    const n = parseInt(m2[1], 10);
    if (n >= 60) return Math.floor(n / 60) + "h ago";
    return n + "m ago";
  }
  return t;
}

export function AdminApp({ initialNav = "collections", onSignOut }: AdminAppOptions) {
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
  const NAV_IDS = useMemo(
    () =>
      new Set<string>([
        ...NAV_ITEMS.map((n) => n.id),
        ...NAV_DEVELOPERS.map((n) => n.id),
        ...NAV_SETTINGS.map((n) => n.id),
        // Reachable only via the header avatar dropdown — not in the sidebar.
        "account",
      ]),
    [],
  );
  const segs = location.pathname.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
  const activeNav = segs[0] && NAV_IDS.has(segs[0]) ? segs[0] : initialNav;
  const setActiveNav = useCallback((id: string) => { navigate("/" + id); }, [navigate]);

  // The standalone "Activity log" page was merged into "Logs" — keep old
  // `/activity` deep links working by redirecting them to the unified page.
  useEffect(() => {
    if (segs[0] === "activity") navigate("/logs", { replace: true });
  }, [segs[0], navigate]);

  const navTo = useCallback((id: string) => { navigate("/" + id); }, [navigate]);
  const [activeTab, setActiveTab] = useState<"items" | "schema" | "settings">("items");
  const [posts, setPosts] = useState<Post[]>([]);
  // Real items load — see effect after activeCollection is declared.
  const [search, setSearch] = useUrlState("q", "");
  const [filters, setFilters] = useUrlStateJson<FilterCondition[]>("filter", []);
  const [statusTab, setStatusTab] = useState("all");
  const [sort, setSort] = useUrlState("sort", "-updated_at");
  // Per-collection visualisation. Kanban auto-hides when the schema has no
  // status-shaped column (see ItemsViewToggle); the resolved `viewMode` is
  // derived below once schemaState is known.
  const [view, setView] = useUrlState("view", "table");
  const requestedView = (["table", "kanban", "gallery", "calendar"].includes(view) ? view : "table") as ItemsViewMode;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(1);
  const PER_PAGE = 8;

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
  const hasStatusField = useMemo(
    () => !!resolveStatusField(schemaState as unknown as { fields?: Array<Record<string, unknown>> } | null),
    [schemaState],
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
      .filter((c: any) => showArchived
        ? (c.status ?? "active") === "archived"
        : (c.status ?? "active") === "active",
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
          icon: "Database" as const,
          writes24h: stats?.writes24h ?? 0,
          lastWrite: fmtAgo(stats?.lastWrite ?? null),
          singleton: false,
          group: "Content",
        } as CollectionListItem;
      });
  }, [collectionsQuery.data, metricsQuery.data, showArchived]);
  const activeCollection = activeNav === "collections" && segs[1] ? segs[1] : null;
  const setActiveCollection = useCallback(
    (slug: string | null) => { navigate(slug ? "/collections/" + slug : "/collections"); },
    [navigate],
  );
  // Flow detail id lives in segs[1] when activeNav === "flows" — same shape as
  // collections, so deep links / browser back preserve the selected flow.
  const activeFlow = activeNav === "flows" && segs[1] ? segs[1] : null;
  const setActiveFlow = useCallback(
    (id: string | null) => { navigate(id ? "/flows/" + id : "/flows"); },
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

  // Items refetch — keyed off the active collection AND every filter input
  // so typing / chipping / status-tabbing fires a request. Empty / missing
  // / auth-fail falls back to whatever's currently cached.
  useEffect(() => {
    if (!activeCollection) return;
    let cancelled = false;
    void (async () => {
      try {
        const query: Record<string, string | number> = {
          limit: 50,
          sort: sort || "-updated_at",
        };
        if (debouncedSearch.trim()) query.q = debouncedSearch.trim();
        // Build a `$and` filter from chips (each its own clause so duplicate
        // field+op pairs survive) plus the status quick-filter when active.
        const clauses: Record<string, Record<string, unknown>>[] = filters.map(
          (f) => ({ [f.field]: { [f.op]: f.value } }),
        );
        const statusCfg = resolveStatusField(schemaState as unknown as { fields?: Array<Record<string, unknown>> } | null);
        if (statusTab !== "all" && statusCfg) {
          clauses.push({ [statusCfg.name]: { _eq: statusTab } });
        }
        if (clauses.length === 1) {
          query.filter = JSON.stringify(clauses[0]);
        } else if (clauses.length > 1) {
          query.filter = JSON.stringify({ $and: clauses });
        }
        const res = await itemsApi.list(activeCollection, query);
        if (cancelled) return;
        if (Array.isArray(res.data)) {
          setPosts(res.data as unknown as Post[]);
        }
      } catch {
        // keep whatever is currently in `posts`
      }
    })();
    return () => { cancelled = true; };
  }, [activeCollection, debouncedSearch, filters, statusTab, sort, schemaState]);

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
  const [me, setMe] = useState<{ name: string | null; email: string; image: string | null; isAdmin: boolean } | null>(null);
  // Hydrate the header dropdown — name/email/avatar + admin badge. `auth.useSession()`
  // doesn't carry role info, so we hit our own `/api/me` which returns the
  // permission-resolver's view of the current user.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await api<{ data: { name: string | null; email: string; image: string | null; isAdmin: boolean } }>("/api/me");
        if (!cancelled) setMe(r.data);
      } catch {
        // not signed in or endpoint missing — dropdown falls back gracefully
      }
    })();
    return () => { cancelled = true; };
  }, []);

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
        pushToast("Refreshed.");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  useEffect(() => { setPage(1); }, [search, filters.length, statusTab, sort]);

  const total = itemsForView.length;
  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));
  const pageRows = itemsForView.slice((page - 1) * PER_PAGE, page * PER_PAGE);

  const openCreate = () => { setSheetMode("create"); setSheetItem(null); setSheetOpen(true); };
  const openEdit = (it: Post) => { setSheetMode("edit"); setSheetItem(it); setSheetOpen(true); };

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
        const res = await itemsApi.create(activeCollection || "posts", draft as Record<string, unknown>);
        nu = {
          id: "",
          updated_at: new Date().toISOString(),
          view_count: 0,
          word_count: 0,
          published_at: null,
          title: "",
          slug: "",
          status: "draft",
          author: "u_1",
          ...(draft as Post),
          ...(res.data as unknown as Post),
        };
      } catch (e) {
        pushToast((e as Error).message, "error");
        return false;
      }
      setPosts((p) => [nu, ...p]);
      pushToast(`Post "${(nu.title ?? "").slice(0, 38)}${(nu.title ?? "").length > 38 ? "…" : ""}" created.`);
      // Flip the sheet into edit mode on the freshly-created row so subsequent
      // saves PATCH it rather than re-inserting.
      setSheetMode("edit");
      setSheetItem(nu);
    } else if (sheetItem) {
      try {
        await itemsApi.patch(activeCollection || "posts", sheetItem.id, draft as Record<string, unknown>);
      } catch (e) {
        pushToast((e as Error).message, "error");
        return false;
      }
      const updated = { ...sheetItem, ...draft, updated_at: new Date().toISOString() } as Post;
      setPosts((p) => p.map((x) => x.id === sheetItem.id ? updated : x));
      pushToast("Post saved.");
      // Hand the sheet a new object reference so its useEffect re-syncs the
      // draft to the server-confirmed values.
      setSheetItem(updated);
    }
    if (close) setSheetOpen(false);
    return true;
  };

  const onBulkPublish = () => {
    setPosts((p) => p.map((x) => selected.has(x.id) ? { ...x, status: "published", published_at: new Date().toISOString(), updated_at: new Date().toISOString() } : x));
    pushToast(`${selected.size} posts published.`);
    setSelected(new Set());
  };
  const onBulkDelete = () => {
    setConfirm({
      title: `Delete ${selected.size} posts?`,
      description: `These rows will be removed from c_posts. This deletes the underlying records — revisions remain available.`,
      actionLabel: "Delete",
      destructive: true,
      onConfirm: async () => {
        const ids = [...selected];
        await Promise.allSettled(ids.map((id) => itemsApi.remove(activeCollection || "posts", id)));
        setPosts((p) => p.filter((x) => !selected.has(x.id)));
        pushToast(`${selected.size} posts deleted.`);
        setSelected(new Set());
        setConfirm(null);
      },
    });
  };

  const refresh = () => pushToast("Items refreshed.");

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
      setActiveNav("collections");
    }
  };

  return (
    <SidebarProvider
      open={!tweaks.sidebarCollapsed}
      onOpenChange={(o) => setTweak("sidebarCollapsed", !o)}
      className="h-svh"
      data-density={tweaks.density}
    >
      <Sidebar activeNav={activeNav} setActiveNav={navTo} pushToast={pushToast} collectionsCount={collections.length} />

      <SidebarInset className="min-h-0 min-w-0">
        <Topbar
          crumbs={
            activeNav === "collections" && activeCollection
              ? ["collections", activeCollection]
              : activeNav === "flows" && activeFlow
                ? ["flows", activeFlow]
                : [activeNav]
          }
          onOpenPalette={() => setPaletteOpen(true)}
          onToggleTheme={toggleDark}
          dark={dark}
          onSignOut={onSignOut}
          user={me}
          onAccountSettings={() => navigate("/account")}
        />

        <div className="scrollarea" style={{ flex: 1 }}>
          <div className="page">
            <Suspense fallback={<PageSkeleton nav={activeNav} />}>
            {activeNav === "overview" && <OverviewPage adapter={tweaks.adapter} pushToast={pushToast} setActiveNav={setActiveNav} />}
            {activeNav === "database" && <DatabasePage pushToast={pushToast} adapter={tweaks.adapter} />}
            {activeNav === "storage" && <StoragePage pushToast={pushToast} />}
            {activeNav === "flows" && <FlowsPage pushToast={pushToast} activeFlow={activeFlow} setActiveFlow={setActiveFlow} />}
            {activeNav === "functions" && <FunctionsPage pushToast={pushToast} />}
            {activeNav === "webhooks" && <WebhooksPage pushToast={pushToast} />}
            {activeNav === "graphql" && <GraphqlPage />}
            {activeNav === "rest-explorer" && <RestExplorerPage />}
            {activeNav === "openapi" && <OpenApiExportPage />}
            {activeNav === "realtime" && <RealtimePage events={events} active={realtimeChannel} onActiveChange={setRealtimeChannel} pushToast={pushToast} />}
            {activeNav === "logs" && <LogsPage pushToast={pushToast} />}
            {activeNav === "advisor" && <AdvisorPage pushToast={pushToast} />}
            {activeNav === "schema-graph" && <SchemaGraphPage pushToast={pushToast} />}
            {activeNav === "insights" && <InsightsPage pushToast={pushToast} />}
            {activeNav === "revisions" && <RevisionsPage pushToast={pushToast} />}
            {activeNav === "translations" && <TranslationsPage pushToast={pushToast} />}
            {activeNav === "authentication" && <AuthSettingsPage pushToast={pushToast} />}
            {activeNav === "users" && <UsersPage pushToast={pushToast} />}
            {activeNav === "app-users" && <AppUsersPage pushToast={pushToast} />}
            {activeNav === "api-keys" && <ApiKeys />}
            {activeNav === "email-templates" && <EmailTemplatesPage pushToast={pushToast} />}
            {activeNav === "settings" && <SettingsPage adapter={tweaks.adapter} pushToast={pushToast} />}
            {activeNav === "account" && <AccountPage pushToast={pushToast} />}
            {activeNav === "access" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
                <PageHeader title="Roles & permissions" description="System roles ship with the platform; custom roles layer additively." />
                <RolesPageWithMembers pushToast={pushToast} />
              </div>
            )}
            {activeNav === "collections" && !activeCollection && (
              <CollectionsIndex
                collections={collections}
                showArchived={showArchived}
                onToggleArchived={(next) => setShowArchived(next)}
                onOpen={(slug) => { setActiveCollection(slug); setActiveTab("items"); }}
                onOpenApi={(slug) => navigate(slug ? `/rest-explorer?slug=${encodeURIComponent(slug)}` : "/rest-explorer")}
                onNew={() => setNewCollectionOpen(true)}
                onDelete={(slug) => {
                  // Branch by adopted flag — adopted collections soft-delete
                  // (archive, reversible), managed ones hard-DROP the table.
                  const target = (collections as Array<CollectionListItem & { adopted?: boolean }>).find((c) => c.slug === slug);
                  const adopted = !!target?.adopted;
                  setConfirm({
                    title: adopted
                      ? <>Archive collection <span className="font-mono">c_{slug}</span>?</>
                      : <>Delete collection <span className="font-mono">c_{slug}</span>?</>,
                    description: adopted
                      ? <>Workeros stops treating this table as a collection. The underlying table and its rows stay intact; you can restore from the Archived view.</>
                      : <>The physical table and all rows are dropped. This is irreversible. Permissions, revisions, and webhooks tied to this collection are removed too.</>,
                    actionLabel: adopted ? "Archive collection" : "Delete collection",
                    destructive: !adopted,
                    onConfirm: async () => {
                      try {
                        const resp = await collectionsApi.remove(slug);
                        invalidateCollections();
                        if (activeCollection === slug) setActiveCollection(null);
                        pushToast(resp.archived
                          ? `Collection c_${slug} archived. Restore it from the Archived view.`
                          : `Collection c_${slug} dropped.`);
                      } catch (e) {
                        pushToast((e as Error).message, "error");
                      }
                      setConfirm(null);
                    },
                  });
                }}
                onRestore={(slug) => setConfirm({
                  title: <>Restore collection <span className="font-mono">c_{slug}</span>?</>,
                  description: <>Workeros will start treating this table as a collection again. Owner-scoped permissions are re-seeded if they were configured.</>,
                  actionLabel: "Restore collection",
                  destructive: false,
                  onConfirm: async () => {
                    try {
                      await collectionsApi.restore(slug);
                      pushToast(`Collection c_${slug} restored.`);
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
            {activeNav === "collections" && activeCollection && collectionLoading && schemaState.slug !== activeCollection && (
              <CollectionItemsSkeleton />
            )}
            {activeNav === "collections" && activeCollection && !(collectionLoading && schemaState.slug !== activeCollection) && <>
              <Button variant="ghost" size="sm" icon={I.ChevronLeft} onClick={() => setActiveCollection(null)}>All collections</Button>
              <PageHeader
                slug={activeCollection}
                description={<>Dynamic schema. Each collection becomes a physical <span className="font-mono">c_&lt;slug&gt;</span> table at runtime; drop or alter via this UI.</>}
                badges={
                  <span style={{ display: "inline-flex", gap: 6, marginLeft: 4 }}>
                    {schemaState.ownerScoped && <Badge variant="default">owner-scoped</Badge>}
                    <Badge variant="outline" mono>{ADAPTER_PROFILES[tweaks.adapter].db}</Badge>
                  </span>
                }
                actions={
                  <>
                    <Button variant="outline" icon={I.Refresh} onClick={refresh}>Refresh</Button>
                    <Button variant="outline" icon={I.ExternalLink} onClick={() => navigate(`/rest-explorer?slug=${encodeURIComponent(activeCollection)}`)}>API</Button>
                    <Button variant="primary" icon={I.Plus} onClick={openCreate}>New post</Button>
                  </>
                }
              />

              <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as "items" | "schema" | "settings")}>
                <TabsList>
                  <TabsTrigger value="items">
                    <I.Inbox size={13} />Items <span className={TAB_COUNT_CLS}>{posts.length}</span>
                  </TabsTrigger>
                  <TabsTrigger value="schema">
                    <I.Braces size={13} />Schema <span className={TAB_COUNT_CLS}>{schemaState.fields.length}</span>
                  </TabsTrigger>
                  <TabsTrigger value="settings">
                    <I.Settings size={13} />Settings
                  </TabsTrigger>
                </TabsList>
              </Tabs>

              {activeTab === "items" && (
                <div className="grid grid-cols-[1fr_320px] items-start gap-4 max-[1280px]:grid-cols-1">
                  <div className="flex min-w-0 flex-col gap-3">
                    <FilterBar
                      search={search} setSearch={setSearch}
                      filters={filters} setFilters={setFilters}
                      schema={schemaState}
                      status={statusTab} setStatus={setStatusTab}
                      total={tweaks.populated ? posts.length : 0}
                    />
                    <div className="overflow-hidden rounded-2xl border border-border bg-card text-card-foreground">
                      <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
                        <ItemsViewToggle
                          mode={viewMode}
                          setMode={(m) => setView(m)}
                          hasStatus={!!resolveStatusField(schemaState as unknown as { fields?: Array<Record<string, unknown>> } | null)}
                        />
                      </div>
                      <FilterDSLPreview filters={filters} sort={sort} />
                      {viewMode === "table" && (
                        <BulkBar
                          count={selected.size}
                          onClear={() => setSelected(new Set())}
                          onPublish={onBulkPublish}
                          onDelete={onBulkDelete}
                        />
                      )}
                      {viewMode === "table" && (
                        pageRows.length === 0 ? (
                          <EmptyItems onCreate={openCreate} slug={activeCollection ?? undefined} />
                        ) : (
                          <ItemsTable rows={pageRows} selected={selected} setSelected={setSelected} sort={sort} setSort={setSort} onEdit={openEdit} schema={schemaState} />
                        )
                      )}
                      {viewMode === "kanban" && (
                        itemsForView.length === 0 ? (
                          <EmptyItems onCreate={openCreate} slug={activeCollection ?? undefined} />
                        ) : (
                          <KanbanBoard rows={itemsForView} onEdit={openEdit} />
                        )
                      )}
                      {viewMode === "gallery" && (
                        itemsForView.length === 0 ? (
                          <EmptyItems onCreate={openCreate} slug={activeCollection ?? undefined} />
                        ) : (
                          <GalleryGrid rows={itemsForView} onEdit={openEdit} />
                        )
                      )}
                      {viewMode === "calendar" && (
                        <CalendarView rows={itemsForView} onEdit={openEdit} />
                      )}
                      {viewMode === "table" && pageRows.length > 0 && (
                        <div className="flex items-center gap-2 border-t border-border bg-card px-3.5 py-2.5 text-[12.5px] text-muted-foreground">
                          <span className="font-mono text-xs tabular-nums">{(page - 1) * PER_PAGE + 1}-{Math.min(page * PER_PAGE, total)} of {total}</span>
                          <div className="flex-1" />
                          <Button variant="ghost" size="sm" icon={I.ChevronLeft} disabled={page === 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>Prev</Button>
                          <span className="font-mono text-xs tabular-nums">page {page} / {totalPages}</span>
                          <Button variant="ghost" size="sm" iconRight={I.ChevronRight} disabled={page === totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>Next</Button>
                        </div>
                      )}
                    </div>
                  </div>
                  {tweaks.showRealtime && (
                    <RealtimeTail events={events} channel={`items:${activeCollection ?? ""}`} connected />
                  )}
                </div>
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
                      title: `Drop column "${name}"?`,
                      description: <>This <span className="font-mono">ALTER TABLE c_posts DROP COLUMN "{name}"</span> is irreversible. Existing data in the column is lost.</>,
                      actionLabel: "Drop column",
                      destructive: true,
                      onConfirm: async () => {
                        const slug = activeCollection || "posts";
                        const next = schemaState.fields.filter((f) => f.name !== name);
                        try {
                          await collectionsApi.patch(slug, { fields: next as any });
                          setSchemaState((s) => ({ ...s, fields: next }));
                          pushToast(`Column "${name}" dropped.`);
                        } catch (e) {
                          pushToast((e as Error).message);
                        }
                        setConfirm(null);
                      },
                    })}
                  />
                </div>
              )}

              {activeTab === "settings" && (
                <CollectionSettings
                  schema={schemaState}
                  existingSlugs={collections.map((c) => c.slug)}
                  onRename={async (nextSlug) => {
                    const slug = activeCollection || "posts";
                    setConfirm({
                      title: <>Rename <span className="font-mono">c_{slug}</span> → <span className="font-mono">c_{nextSlug}</span>?</>,
                      description: <>Permission rules, webhook patterns, function triggers, flow steps, revisions, comments, and audit log entries that reference <span className="font-mono">{slug}</span> will be updated. The physical table is not renamed.</>,
                      actionLabel: "Rename collection",
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
                          pushToast(`Renamed to c_${nextSlug}${totals ? ` (${totals} updated)` : ""}.`);
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
                      await collectionsApi.patch(slug, patch as any);
                      pushToast(`Collection settings saved.`);
                    } catch (e) {
                      setSchemaState(prev);
                      pushToast((e as Error).message, "error");
                    }
                  }}
                  onDelete={() => {
                    const adopted = !!(schemaState as { adopted?: boolean }).adopted;
                    setConfirm({
                      title: adopted
                        ? <>Archive collection <span className="font-mono">c_{activeCollection}</span>?</>
                        : <>Delete collection <span className="font-mono">c_{activeCollection}</span>?</>,
                      description: adopted
                        ? <>Workeros stops treating this table as a collection. The underlying table and its rows stay intact; you can restore from the Archived view.</>
                        : <>The physical table and all rows are dropped. This is irreversible.</>,
                      actionLabel: adopted ? "Archive collection" : "Delete collection",
                      destructive: !adopted,
                      onConfirm: async () => {
                        const slug = activeCollection || "posts";
                        try {
                          const resp = await collectionsApi.remove(slug);
                          invalidateCollections();
                          setActiveCollection(null);
                          pushToast(resp.archived
                            ? `Collection c_${slug} archived. Restore it from the Archived view.`
                            : `Collection c_${slug} dropped.`);
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

      <ItemSheet open={sheetOpen} mode={sheetMode} initial={sheetItem} schema={schemaState} onClose={() => setSheetOpen(false)} onSave={onSave} />
      <Palette open={paletteOpen} onClose={() => setPaletteOpen(false)} onNavigate={onPaletteSelect} items={posts} collections={collections} />
      <ConfirmDialog open={!!confirm} {...(confirm || {})} onCancel={() => setConfirm(null)} />
      <NewCollectionDialog
        open={newCollectionOpen}
        onClose={() => setNewCollectionOpen(false)}
        existingSlugs={collections.map((c) => c.slug)}
        onCreate={async (c) => {
          // The wizard now passes `templateFields` derived from the chosen
          // preset (Blank → [], Content → title+slug+status+body+published_at,
          // …). System columns (id, owner_id, created_at, updated_at) are
          // added by the backend per the ownerScoped flag.
          let created = false;
          try {
            const tplFields = (c as { templateFields?: Array<{ name: string; type: string; required?: boolean; unique?: boolean }> }).templateFields ?? [];
            await collectionsApi.create({
              slug: c.slug,
              fields: tplFields,
              ownerScoped: c.ownerScoped,
            } as any);
            // Refetch — the new row comes back metrics-enriched from the
            // canonical list rather than the wizard's partial draft.
            invalidateCollections();
            pushToast(`Collection c_${c.slug} created.`);
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
        onClose={() => setEditFieldName(null)}
        onSave={async (next) => {
          const slug = activeCollection || "posts";
          const merged = schemaState.fields.map((f) =>
            (f as { name?: string }).name === editFieldName ? (next as never) : f,
          );
          const prev = schemaState.fields;
          setSchemaState((s) => ({ ...s, fields: merged }));
          try {
            await collectionsApi.patch(slug, { fields: merged as any });
            pushToast(`Field "${(next as { name?: string }).name}" updated.`);
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
          pushToast(`Column "${(field as any).name}" added to c_${slug}.`);
        } catch (e) {
          pushToast((e as Error).message);
        }
        setAddFieldOpen(false);
      }} />
      {toastNode}
    </SidebarProvider>
  );
}

function RolesPageWithMembers({ pushToast }: { pushToast: (m: string) => void }) {
  const [tab, setTab] = useState<"members" | "roles">("members");
  return (
    <div className="flex flex-col gap-3.5">
      <Tabs value={tab} onValueChange={(v) => setTab(v as "members" | "roles")}>
        <TabsList>
          {[
            { id: "members" as const, label: "Members", icon: I.Users },
            { id: "roles" as const, label: "Roles & permissions", icon: I.Shield },
          ].map((t) => (
            <TabsTrigger key={t.id} value={t.id}>
              <t.icon size={13} /><span>{t.label}</span>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {tab === "members" && <MembersPanel roles={[]} pushToast={pushToast} />}
      {tab === "roles" && <PermissionsPanel pushToast={pushToast} />}
    </div>
  );
}

function PermissionsPanel({ pushToast }: { pushToast: (m: string) => void }) {
  const [roles, setRoles] = useState<RoleData[]>([]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await api<{ data: { id: string; name: string; description: string | null; admin: boolean }[] }>(`/api/roles`);
        if (!cancelled && Array.isArray(r.data)) {
          setRoles(
            r.data.map((row) => ({
              name: row.name,
              system: ["admin", "authenticated", "public"].includes(row.name),
              badges: row.admin ? ["bypass"] : [],
              description: row.description ?? "",
              matrix: { read: "all", create: "all", update: "all", delete: "all" } as any,
              rule: row.description ?? "",
            })),
          );
        }
      } catch {
        // leave roles empty
      }
    })();
    return () => { cancelled = true; };
  }, []);
  const [editing, setEditing] = useState<RoleData | null>(null);
  const [isNew, setIsNew] = useState(false);

  const openNew = () => { setEditing(null); setIsNew(true); };
  const openEdit = (r: RoleData) => { setEditing(r); setIsNew(false); };
  const save = async (data: RoleData) => {
    if (isNew) {
      if (roles.find((r) => r.name === data.name)) { pushToast(`Role "${data.name}" already exists.`); return; }
      try {
        await api(`/api/roles`, {
          method: "POST",
          body: JSON.stringify({ name: data.name, description: data.description, admin: false }),
        });
      } catch (e) {
        pushToast((e as Error).message);
      }
      setRoles((arr) => [...arr, { ...data, badges: [] }]);
      pushToast(`Role "${data.name}" created.`);
    } else if (editing) {
      try {
        // Roles are loaded via /api/roles which returns id; the editor only
        // tracks name. Look up id by name from the latest server snapshot.
        const r = await api<{ data: { id: string; name: string }[] }>(`/api/roles`);
        const target = r.data.find((x) => x.name === editing.name);
        if (target) {
          await api(`/api/roles/${target.id}`, {
            method: "PATCH",
            body: JSON.stringify({ name: data.name, description: data.description }),
          });
        }
      } catch (e) {
        pushToast((e as Error).message);
      }
      setRoles((arr) => arr.map((r) => r.name === editing.name ? { ...r, ...data } : r));
      pushToast(`Role "${data.name}" saved.`);
    }
    setEditing(null);
    setIsNew(false);
  };
  const close = () => { setEditing(null); setIsNew(false); };
  return (
    <div className="flex flex-col gap-3.5">
      <div className="overflow-hidden rounded-2xl border border-border bg-card text-card-foreground">
        <div className="flex items-center gap-2.5 border-b border-border px-4 py-3.5">
          <I.Shield size={14} />
          <span className="text-[13px] font-medium">roles</span>
          <span className="font-mono text-xs text-muted-foreground">{roles.filter((r) => r.system).length} system · {roles.filter((r) => !r.system).length} custom</span>
          <div className="flex-1" />
          <Button variant="primary" size="sm" icon={I.Plus} onClick={openNew}>Add role</Button>
        </div>
        {roles.map((r) => (
          <div key={r.name} className="grid grid-cols-[24px_200px_1fr_32px] max-[640px]:grid-cols-[24px_1fr_32px] items-center gap-3 border-b border-border px-3.5 py-[11px] text-[13px] last:border-b-0">
            <span><I.Users size={14} /></span>
            <div className="flex items-center gap-2">
              <span className="font-mono text-[13px]">{r.name}</span>
              {r.system && <Badge variant="secondary">system</Badge>}
              {(r.badges || []).map((b) => <Badge key={b} variant="outline">{b}</Badge>)}
            </div>
            <span className="font-mono text-xs text-muted-foreground max-[640px]:hidden">{r.rule}</span>
            <IconButton icon={I.Pencil} title="Edit" onClick={() => openEdit(r)} />
          </div>
        ))}
      </div>

      <PermissionsMatrix roles={roles} pushToast={pushToast} />
      <RoleEditor open={editing !== null || isNew} role={editing} isNew={isNew} onClose={close} onSave={save} />
    </div>
  );
}
