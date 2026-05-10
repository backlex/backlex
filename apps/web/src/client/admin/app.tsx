// @ts-nocheck
// workeros admin — main app
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import "./admin.css";
import "./flow-builder.css";
import { I } from "./icons";
import { MOCK, type AdapterId, type Post } from "./mock";
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
  type FilterCondition,
} from "./items";
import { ConfirmDialog, ItemSheet } from "./sheet";
import { AlterPreview, EmptyItems, Palette, RealtimeTail, SchemaView, type RealtimeEvent } from "./extras";
import { AddFieldDialog } from "./add-field";
import { loadAuthors } from "./authors-cache";
import { CollectionsIndex, NewCollectionDialog } from "./collections-index";
import { EditFieldDialog } from "./edit-field";
import { CollectionSettings } from "./collection-settings";
import { collectionsApi, itemsApi, settingsApi } from "./api";
import { api } from "@/lib/api";
import { StoragePage } from "./storage";
import {
  ActivityPage,
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
import { ConditionEditor } from "./condition-editor";
import {
  ApiKeysPage,
  FlowsPage,
  FunctionsPage,
  OverviewPage,
  RealtimePage,
  SettingsPage,
  UsersPage,
  WebhooksPage,
} from "./pages";

interface AdminAppOptions {
  initialNav?: string;
  onSignOut?: () => void;
}

const DEFAULTS = {
  dark: false,
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

  // activeNav + activeCollection are URL-driven so the address bar shows the
  // current admin location and deep links work. Nav ids are mapped 1:1 to the
  // first path segment; the collection slug (when on `collections`) lives in
  // the second segment.
  const location = useLocation();
  const navigate = useNavigate();
  const NAV_IDS = useMemo(
    () =>
      new Set<string>([
        ...MOCK.navItems.map((n) => n.id),
        ...MOCK.navSettings.map((n) => n.id),
      ]),
    [],
  );
  const segs = location.pathname.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
  const activeNav = segs[0] && NAV_IDS.has(segs[0]) ? segs[0] : initialNav;
  const setActiveNav = useCallback((id: string) => { navigate("/" + id); }, [navigate]);
  const [activeTab, setActiveTab] = useState<"items" | "schema" | "permissions" | "settings">("items");
  const [posts, setPosts] = useState<Post[]>([]);
  // Real items load — see effect after activeCollection is declared.
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<FilterCondition[]>([]);
  const [statusTab, setStatusTab] = useState("all");
  const [sort, setSort] = useState("-updated_at");
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
  const [schemaState, setSchemaState] = useState<typeof MOCK.collectionSchema>({
    slug: "",
    ownerScoped: false,
    fields: [],
  });
  // No mock seed — empty until /api/collections fills in. The Collections
  // index renders an empty/zero-state path when nothing is loaded yet.
  const [collections, setCollections] = useState<typeof MOCK.collectionsList>([]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await collectionsApi.list();
        if (cancelled) return;
        if (Array.isArray(res.data)) {
          const mapped = res.data.map((c) => ({
            slug: c.slug,
            count: 0,
            ownerScoped: c.ownerScoped,
            fields: Array.isArray(c.fields) ? c.fields.length : 0,
            icon: "Database" as const,
            writes24h: 0,
            lastWrite: "—",
            singleton: false,
            group: "Content",
          }));
          setCollections(mapped);
        }
      } catch {
        // leave collections empty on auth/network failure
      }
    })();
    return () => { cancelled = true; };
  }, []);
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

  // Real items + schema load — both keyed off the active collection so
  // opening c_<anything> fetches that collection's rows + columns. Empty/
  // missing/auth-fail falls back to whatever's currently cached.
  useEffect(() => {
    if (!activeCollection) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await itemsApi.list(activeCollection, { limit: 50, sort: "-updated_at" });
        if (cancelled) return;
        if (Array.isArray(res.data)) {
          setPosts(res.data as unknown as Post[]);
        }
      } catch {
        // keep whatever is currently in `posts`
      }
    })();
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
          fields: fields as any,
        });
      } catch {
        // leave previous schemaState in place
      }
    })();
    return () => { cancelled = true; };
  }, [activeCollection]);

  const [events, setEvents] = useState<RealtimeEvent[]>([]);
  const [toastNode, pushToast] = useToasts();

  useEffect(() => {
    const root = document.documentElement;
    if (tweaks.dark) root.classList.add("dark"); else root.classList.remove("dark");
  }, [tweaks.dark]);

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
      if (e.key.toLowerCase() === "d" && !e.metaKey && !e.ctrlKey) {
        setTweak("dark", !tweaks.dark);
      } else if (e.key.toLowerCase() === "c" && !e.metaKey && !e.ctrlKey) {
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
  }, [tweaks.dark, setTweak, pushToast]);

  // Real-time subscription to the active collection's events channel.
  // - Workers (env.REALTIME bound): WebSocket via Durable Object
  // - Bun: SSE via streamSSE
  // We detect once via settingsApi.runtime() and pick the right transport.
  // Each incoming event is mapped into the design's RealtimeEvent shape so
  // RealtimeTail keeps rendering identically — only the data source changes.
  useEffect(() => {
    if (!tweaks.showRealtime) return;
    if (!activeCollection) { setEvents([]); return; }
    const channel = `items:${activeCollection}`;
    let cleanup: (() => void) | null = null;
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
        };
        setEvents((arr) => [next, ...arr.map((e) => ({ ...e, t: ageBump(e.t) })).slice(0, 30)]);
      } catch {
        // malformed payload — ignore
      }
    };
    void (async () => {
      const adapter = tweaks.adapter;
      if (adapter === "workers") {
        // Workers — WebSocket through the Durable Object.
        const proto = location.protocol === "https:" ? "wss:" : "ws:";
        const url = `${proto}//${location.host}/api/realtime/${encodeURIComponent(channel)}/subscribe`;
        try {
          const ws = new WebSocket(url);
          ws.addEventListener("message", (ev) => onMsg(typeof ev.data === "string" ? ev.data : ""));
          cleanup = () => { try { ws.close(); } catch {} };
        } catch {
          // browser refused — leave events empty
        }
      } else {
        // Bun (or any non-DO runtime) — SSE.
        try {
          const es = new EventSource(`/api/realtime/${encodeURIComponent(channel)}/subscribe`, { withCredentials: true });
          es.addEventListener("message", (ev) => onMsg((ev as MessageEvent).data));
          cleanup = () => es.close();
        } catch {
          // EventSource unsupported — leave events empty
        }
      }
    })();
    return () => {
      alive = false;
      if (cleanup) cleanup();
    };
  }, [tweaks.showRealtime, tweaks.adapter, activeCollection]);

  const itemsForView = useMemo(() => {
    let rows = tweaks.populated ? posts : [];
    if (statusTab !== "all") rows = rows.filter((r) => r.status === statusTab);
    if (search.trim()) {
      const qq = search.toLowerCase();
      rows = rows.filter((r) => r.title.toLowerCase().includes(qq) || r.slug.toLowerCase().includes(qq));
    }
    if (filters.length) {
      const combined: Record<string, Record<string, unknown>> = {};
      for (const f of filters) combined[f.field] = { ...(combined[f.field] || {}), [f.op]: f.value };
      rows = rows.filter((r) => evaluateFilter(r as Record<string, unknown>, combined));
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

  const onSave = async (draft: Partial<Post>) => {
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
        return;
      }
      setPosts((p) => [nu, ...p]);
      pushToast(`Post "${(nu.title ?? "").slice(0, 38)}${(nu.title ?? "").length > 38 ? "…" : ""}" created.`);
    } else if (sheetItem) {
      try {
        await itemsApi.patch(activeCollection || "posts", sheetItem.id, draft as Record<string, unknown>);
      } catch (e) {
        pushToast((e as Error).message, "error");
        return;
      }
      setPosts((p) => p.map((x) => x.id === sheetItem.id ? { ...x, ...draft, updated_at: new Date().toISOString() } as Post : x));
      pushToast("Post saved.");
    }
    setSheetOpen(false);
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
      if (sel.id === "toggle-theme") setTweak("dark", !tweaks.dark);
    } else if (sel.kind === "page") {
      setActiveNav(sel.id);
    } else if (sel.kind === "collection") {
      setActiveNav("collections");
    }
  };

  return (
    <div className="app" data-collapsed={tweaks.sidebarCollapsed} data-density={tweaks.density}>
      <Sidebar activeNav={activeNav} setActiveNav={setActiveNav} adapter={tweaks.adapter} collapsed={tweaks.sidebarCollapsed} pushToast={pushToast} collectionsCount={collections.length} />

      <div className="main">
        <Topbar
          crumbs={
            activeNav === "collections" && activeCollection
              ? ["collections", activeCollection]
              : activeNav === "flows" && activeFlow
                ? ["flows", activeFlow]
                : [activeNav]
          }
          onOpenPalette={() => setPaletteOpen(true)}
          onToggleTheme={() => setTweak("dark", !tweaks.dark)}
          dark={tweaks.dark}
          onToggleSidebar={() => setTweak("sidebarCollapsed", !tweaks.sidebarCollapsed)}
          onSignOut={onSignOut}
        />

        <div className="scrollarea" style={{ flex: 1 }}>
          <div className="page">
            {activeNav === "overview" && <OverviewPage adapter={tweaks.adapter} pushToast={pushToast} setActiveNav={setActiveNav} />}
            {activeNav === "database" && <DatabasePage pushToast={pushToast} adapter={tweaks.adapter} />}
            {activeNav === "storage" && <StoragePage pushToast={pushToast} />}
            {activeNav === "flows" && <FlowsPage pushToast={pushToast} activeFlow={activeFlow} setActiveFlow={setActiveFlow} />}
            {activeNav === "functions" && <FunctionsPage pushToast={pushToast} />}
            {activeNav === "webhooks" && <WebhooksPage pushToast={pushToast} />}
            {activeNav === "realtime" && <RealtimePage events={events} pushToast={pushToast} />}
            {activeNav === "insights" && <InsightsPage pushToast={pushToast} />}
            {activeNav === "activity" && <ActivityPage pushToast={pushToast} />}
            {activeNav === "revisions" && <RevisionsPage />}
            {activeNav === "translations" && <TranslationsPage pushToast={pushToast} />}
            {activeNav === "authentication" && <AuthSettingsPage pushToast={pushToast} />}
            {activeNav === "users" && <UsersPage pushToast={pushToast} />}
            {activeNav === "api-keys" && <ApiKeysPage pushToast={pushToast} />}
            {activeNav === "email-templates" && <EmailTemplatesPage pushToast={pushToast} />}
            {activeNav === "settings" && <SettingsPage adapter={tweaks.adapter} pushToast={pushToast} />}
            {activeNav === "roles" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
                <PageHeader title="Roles & permissions" description="System roles ship with the platform; custom roles layer additively." />
                <RolesPageWithMembers pushToast={pushToast} />
              </div>
            )}
            {activeNav === "collections" && !activeCollection && (
              <CollectionsIndex
                collections={collections}
                onOpen={(slug) => { setActiveCollection(slug); setActiveTab("items"); }}
                onNew={() => setNewCollectionOpen(true)}
                onDelete={(slug) => setConfirm({
                  title: <>Delete collection <span className="font-mono">c_{slug}</span>?</>,
                  description: <>The physical table and all rows are dropped. This is irreversible. Permissions, revisions, and webhooks tied to this collection are removed too.</>,
                  actionLabel: "Delete collection",
                  destructive: true,
                  onConfirm: async () => {
                    try {
                      await collectionsApi.remove(slug);
                      setCollections((arr) => arr.filter((c) => c.slug !== slug));
                      if (activeCollection === slug) setActiveCollection(null);
                      pushToast(`Collection c_${slug} dropped.`);
                    } catch (e) {
                      pushToast((e as Error).message, "error");
                    }
                    setConfirm(null);
                  },
                })}
                pushToast={pushToast}
              />
            )}
            {activeNav === "collections" && activeCollection && <>
              <Button variant="ghost" size="sm" icon={I.ChevronLeft} onClick={() => setActiveCollection(null)}>All collections</Button>
              <PageHeader
                slug={activeCollection}
                description={<>Dynamic schema. Each collection becomes a physical <span className="font-mono">c_&lt;slug&gt;</span> table at runtime; drop or alter via this UI.</>}
                badges={
                  <span style={{ display: "inline-flex", gap: 6, marginLeft: 4 }}>
                    <Badge variant="default">owner-scoped</Badge>
                    <Badge variant="outline" mono>{MOCK.adapterProfiles[tweaks.adapter].db}</Badge>
                  </span>
                }
                actions={
                  <>
                    <Button variant="outline" icon={I.Refresh} onClick={refresh}>Refresh</Button>
                    <Button variant="outline" icon={I.ExternalLink}>API</Button>
                    <Button variant="primary" icon={I.Plus} onClick={openCreate}>New post</Button>
                  </>
                }
              />

              <div className="tabs">
                <button className="tab" data-active={activeTab === "items"} onClick={() => setActiveTab("items")}>
                  <I.Inbox size={13} />Items <span className="count">{posts.length}</span>
                </button>
                <button className="tab" data-active={activeTab === "schema"} onClick={() => setActiveTab("schema")}>
                  <I.Braces size={13} />Schema <span className="count">{schemaState.fields.length}</span>
                </button>
                <button className="tab" data-active={activeTab === "permissions"} onClick={() => setActiveTab("permissions")}>
                  <I.Shield size={13} />Permissions <span className="count">3</span>
                </button>
                <button className="tab" data-active={activeTab === "settings"} onClick={() => setActiveTab("settings")}>
                  <I.Settings size={13} />Settings
                </button>
              </div>

              {activeTab === "items" && (
                <div className="split">
                  <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
                    <FilterBar
                      search={search} setSearch={setSearch}
                      filters={filters} setFilters={setFilters}
                      schema={schemaState}
                      status={statusTab} setStatus={setStatusTab}
                      total={tweaks.populated ? posts.length : 0}
                    />
                    <div className="card">
                      <FilterDSLPreview filters={filters} sort={sort} />
                      <BulkBar
                        count={selected.size}
                        onClear={() => setSelected(new Set())}
                        onPublish={onBulkPublish}
                        onDelete={onBulkDelete}
                      />
                      {pageRows.length === 0 ? (
                        <EmptyItems onCreate={openCreate} slug={activeCollection ?? undefined} />
                      ) : (
                        <ItemsTable rows={pageRows} selected={selected} setSelected={setSelected} sort={sort} setSort={setSort} onEdit={openEdit} schema={schemaState} />
                      )}
                      {pageRows.length > 0 && (
                        <div className="pagination">
                          <span className="meta tabular-nums">{(page - 1) * PER_PAGE + 1}-{Math.min(page * PER_PAGE, total)} of {total}</span>
                          <div className="spacer" />
                          <Button variant="ghost" size="sm" icon={I.ChevronLeft} disabled={page === 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>Prev</Button>
                          <span className="meta tabular-nums">page {page} / {totalPages}</span>
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
                <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
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

              {activeTab === "permissions" && <PermissionsPanel pushToast={pushToast} />}

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
                          // Reload collections + swap active slug + URL.
                          const list = await collectionsApi.list();
                          setCollections((list.data ?? []) as any);
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
                  onDelete={() => setConfirm({
                    title: <>Delete collection <span className="font-mono">c_{activeCollection}</span>?</>,
                    description: <>The physical table and all rows are dropped. This is irreversible.</>,
                    actionLabel: "Delete collection",
                    destructive: true,
                    onConfirm: async () => {
                      const slug = activeCollection || "posts";
                      try {
                        await collectionsApi.remove(slug);
                        setCollections((arr) => arr.filter((c) => c.slug !== slug));
                        setActiveCollection(null);
                        pushToast(`Collection c_${slug} dropped.`);
                      } catch (e) {
                        pushToast((e as Error).message, "error");
                      }
                      setConfirm(null);
                    },
                  })}
                />
              )}
            </>}
          </div>
        </div>
      </div>

      <ItemSheet open={sheetOpen} mode={sheetMode} initial={sheetItem} schema={schemaState} onClose={() => setSheetOpen(false)} onSave={onSave} />
      <Palette open={paletteOpen} onClose={() => setPaletteOpen(false)} onNavigate={onPaletteSelect} items={posts} collections={MOCK.collectionsList} />
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
            setCollections((arr) => [...arr, c]);
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
      <AddFieldDialog open={addFieldOpen} schema={schemaState} onClose={() => setAddFieldOpen(false)} onCreate={async (field) => {
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
    </div>
  );
}

function RolesPageWithMembers({ pushToast }: { pushToast: (m: string) => void }) {
  const [tab, setTab] = useState<"members" | "roles">("members");
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div className="ce-tabs" style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: "var(--radius-xl)", padding: 4 }}>
        {[
          { id: "members" as const, label: "Members", icon: I.Users },
          { id: "roles" as const, label: "Roles & permissions", icon: I.Shield },
        ].map((t) => (
          <button key={t.id} type="button" className={`ce-tab ${tab === t.id ? "on" : ""}`} onClick={() => setTab(t.id)}>
            <t.icon size={13} /><span>{t.label}</span>
          </button>
        ))}
      </div>
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
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div className="card">
        <div className="card-section" style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <I.Shield size={14} />
          <span style={{ fontSize: 13, fontWeight: 500 }}>roles</span>
          <span className="font-mono" style={{ fontSize: 12, color: "var(--muted-foreground)" }}>{roles.filter((r) => r.system).length} system · {roles.filter((r) => !r.system).length} custom</span>
          <div className="spacer" />
          <Button variant="primary" size="sm" icon={I.Plus} onClick={openNew}>Add role</Button>
        </div>
        {roles.map((r) => (
          <div key={r.name} className="schema-row" style={{ gridTemplateColumns: "24px 200px 1fr 32px" }}>
            <span><I.Users size={14} /></span>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span className="font-mono" style={{ fontSize: 13 }}>{r.name}</span>
              {r.system && <Badge variant="secondary">system</Badge>}
              {(r.badges || []).map((b) => <Badge key={b} variant="outline">{b}</Badge>)}
            </div>
            <span className="font-mono" style={{ fontSize: 12, color: "var(--muted-foreground)" }}>{r.rule}</span>
            <IconButton icon={I.Pencil} title="Edit" onClick={() => openEdit(r)} />
          </div>
        ))}
      </div>

      <PermissionsMatrix roles={roles} pushToast={pushToast} />
      <ConditionEditor roles={roles} pushToast={pushToast} />
      <RoleEditor open={editing !== null || isNew} role={editing} isNew={isNew} onClose={close} onSave={save} />
    </div>
  );
}
