// @ts-nocheck
// workeros admin — main app
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
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
import { CollectionsIndex, NewCollectionDialog } from "./collections-index";
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

  const [activeNav, setActiveNav] = useState(initialNav);
  const [activeTab, setActiveTab] = useState<"items" | "schema" | "permissions">("items");
  const [posts, setPosts] = useState<Post[]>(MOCK.initialPosts);
  // Real-API loaders. When the request fails (typically because the
  // collection/items tables are still empty), we silently fall back to the
  // mock seed so the design keeps demoing well.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await itemsApi.list("posts", { limit: 50, sort: "-updated_at" });
        if (cancelled) return;
        if (Array.isArray(res.data)) {
          setPosts(res.data as unknown as Post[]);
        }
      } catch {
        // network/auth failure → keep mock seed for the offline demo
      }
    })();
    return () => { cancelled = true; };
  }, []);
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
  const [schemaState, setSchemaState] = useState(MOCK.collectionSchema);
  const [collections, setCollections] = useState(MOCK.collectionsList);
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
        // keep mock seed on auth/network failure
      }
    })();
    return () => { cancelled = true; };
  }, []);
  const [activeCollection, setActiveCollection] = useState<string | null>(null);
  const [newCollectionOpen, setNewCollectionOpen] = useState(false);

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

  useEffect(() => {
    if (!tweaks.showRealtime) return;
    let alive = true;
    const seed: RealtimeEvent[] = [
      { event: "updated", itemId: "01HZ7K8Q6XYZ", title: "Drizzle 1.0 in production", field: "word_count", who: "jules", t: "just now", id: "e1" },
      { event: "created", itemId: "01HZ7K8Z4YZA", title: "New post draft", who: "kai", t: "12s ago", id: "e2" },
      { event: "updated", itemId: "01HZ7K8R8ABC", title: "pgvector → Vectorize migration playbook", field: "status", who: "kai", t: "38s ago", id: "e3" },
    ];
    setEvents(seed);
    const tick = () => {
      if (!alive) return;
      const samples: Omit<RealtimeEvent, "t" | "id">[] = [
        { event: "updated", title: "Edge functions are now generally available", field: "view_count", who: "system" },
        { event: "updated", title: "Realtime channels: WebSockets vs SSE on the edge", field: "view_count", who: "system" },
        { event: "created", title: "Fresh draft", who: "priya" },
        { event: "updated", title: "A simpler permissions DSL", field: "tags", who: "rana" },
      ];
      const pick = samples[Math.floor(Math.random() * samples.length)];
      setEvents((arr) => [{ ...pick, t: "just now", id: "e" + Math.random().toString(36).slice(2) }, ...arr.map((e, i) => i === 0 ? { ...e, t: ageBump(e.t) } : { ...e, t: ageBump(e.t) }).slice(0, 30)]);
    };
    const t = setInterval(tick, 5500);
    return () => { alive = false; clearInterval(t); };
  }, [tweaks.showRealtime]);

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
      let nu: Post = {
        id: "01HZ" + Math.random().toString(36).slice(2, 10).toUpperCase(),
        updated_at: new Date().toISOString(),
        view_count: 0,
        word_count: 0,
        published_at: null,
        title: "",
        slug: "",
        status: "draft",
        author: "u_1",
        ...(draft as Post),
      };
      try {
        const res = await itemsApi.create("posts", draft as Record<string, unknown>);
        nu = { ...nu, ...(res.data as unknown as Post) };
      } catch {
        // optimistic insert remains
      }
      setPosts((p) => [nu, ...p]);
      setEvents((e) => [{ event: "created", title: nu.title, who: "rana", t: "just now", id: "e" + Math.random().toString(36).slice(2) }, ...e]);
      pushToast(`Post "${nu.title.slice(0, 38)}${nu.title.length > 38 ? "…" : ""}" created.`);
    } else if (sheetItem) {
      try {
        await itemsApi.patch("posts", sheetItem.id, draft as Record<string, unknown>);
      } catch {
        // optimistic patch
      }
      setPosts((p) => p.map((x) => x.id === sheetItem.id ? { ...x, ...draft, updated_at: new Date().toISOString() } as Post : x));
      setEvents((e) => [{ event: "updated", title: draft.title || sheetItem.title, field: "title", who: "rana", t: "just now", id: "e" + Math.random().toString(36).slice(2) }, ...e]);
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
        const titles = posts.filter((p) => selected.has(p.id)).map((p) => p.title);
        const ids = [...selected];
        await Promise.allSettled(ids.map((id) => itemsApi.remove("posts", id)));
        setPosts((p) => p.filter((x) => !selected.has(x.id)));
        setEvents((e) => [...titles.map((title) => ({ event: "deleted" as const, title, who: "rana", t: "just now", id: "e" + Math.random().toString(36).slice(2) })), ...e]);
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
      <Sidebar activeNav={activeNav} setActiveNav={setActiveNav} adapter={tweaks.adapter} collapsed={tweaks.sidebarCollapsed} pushToast={pushToast} />

      <div className="main">
        <Topbar
          crumbs={
            activeNav === "collections"
              ? (activeCollection ? ["Collections", activeCollection] : ["Collections"])
              : [(MOCK.navItems.concat(MOCK.navSettings).find((n) => n.id === activeNav)?.label) || "Overview"]
          }
          onOpenPalette={() => setPaletteOpen(true)}
          onToggleTheme={() => setTweak("dark", !tweaks.dark)}
          dark={tweaks.dark}
          onToggleSidebar={() => setTweak("sidebarCollapsed", !tweaks.sidebarCollapsed)}
          onSignOut={onSignOut}
        />

        <div className="scrollarea" style={{ flex: 1 }}>
          <div className="page">
            {activeNav === "dashboard" && <OverviewPage adapter={tweaks.adapter} pushToast={pushToast} setActiveNav={setActiveNav} />}
            {activeNav === "database" && <DatabasePage pushToast={pushToast} adapter={tweaks.adapter} />}
            {activeNav === "storage" && <StoragePage pushToast={pushToast} />}
            {activeNav === "flows" && <FlowsPage pushToast={pushToast} />}
            {activeNav === "functions" && <FunctionsPage pushToast={pushToast} />}
            {activeNav === "webhooks" && <WebhooksPage pushToast={pushToast} />}
            {activeNav === "realtime" && <RealtimePage events={events} pushToast={pushToast} />}
            {activeNav === "insights" && <InsightsPage />}
            {activeNav === "activity" && <ActivityPage pushToast={pushToast} />}
            {activeNav === "revisions" && <RevisionsPage />}
            {activeNav === "translations" && <TranslationsPage pushToast={pushToast} />}
            {activeNav === "authsettings" && <AuthSettingsPage pushToast={pushToast} />}
            {activeNav === "users" && <UsersPage pushToast={pushToast} />}
            {activeNav === "api" && <ApiKeysPage pushToast={pushToast} />}
            {activeNav === "email" && <EmailTemplatesPage pushToast={pushToast} />}
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
                  <I.Braces size={13} />Schema <span className="count">{MOCK.collectionSchema.fields.length}</span>
                </button>
                <button className="tab" data-active={activeTab === "permissions"} onClick={() => setActiveTab("permissions")}>
                  <I.Shield size={13} />Permissions <span className="count">3</span>
                </button>
              </div>

              {activeTab === "items" && (
                <div className="split">
                  <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
                    <FilterBar
                      search={search} setSearch={setSearch}
                      filters={filters} setFilters={setFilters}
                      schema={MOCK.collectionSchema}
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
                        <EmptyItems onCreate={openCreate} />
                      ) : (
                        <ItemsTable rows={pageRows} selected={selected} setSelected={setSelected} sort={sort} setSort={setSort} onEdit={openEdit} />
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
                    <RealtimeTail events={events} channel="items:posts" connected />
                  )}
                </div>
              )}

              {activeTab === "schema" && (
                <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  <SchemaView
                    schema={schemaState}
                    onAddField={() => setAddFieldOpen(true)}
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
            </>}
          </div>
        </div>
      </div>

      <ItemSheet open={sheetOpen} mode={sheetMode} initial={sheetItem} schema={MOCK.collectionSchema} onClose={() => setSheetOpen(false)} onSave={onSave} />
      <Palette open={paletteOpen} onClose={() => setPaletteOpen(false)} onNavigate={onPaletteSelect} items={posts} collections={MOCK.collectionsList} />
      <ConfirmDialog open={!!confirm} {...(confirm || {})} onCancel={() => setConfirm(null)} />
      <NewCollectionDialog
        open={newCollectionOpen}
        onClose={() => setNewCollectionOpen(false)}
        existingSlugs={collections.map((c) => c.slug)}
        onCreate={async (c) => {
          // Persist a minimal but valid collection via the API. The design
          // wizard collects extras (group, template) we don't ship to the
          // backend yet; they stay client-side until the server schema grows
          // matching columns.
          try {
            await collectionsApi.create({
              slug: c.slug,
              fields: [
                { name: "title", type: "text", required: true },
                { name: "slug", type: "text", required: true, unique: true },
              ],
              ownerScoped: c.ownerScoped,
            } as any);
            setCollections((arr) => [...arr, c]);
            pushToast(`Collection c_${c.slug} created.`);
          } catch (e) {
            pushToast((e as Error).message, "error");
          }
          setNewCollectionOpen(false);
          setActiveCollection(c.slug);
        }}
      />
      <AddFieldDialog open={addFieldOpen} schema={schemaState} onClose={() => setAddFieldOpen(false)} onCreate={async (field) => {
        const merged = {
          ...schemaState,
          fields: [
            ...schemaState.fields.filter((f) => !f.system || f.name === "id" || f.name === "created_at" || f.name === "updated_at" || f.name === "owner_id"),
            field as never,
          ].sort((a: any, b: any) => (a.system ? 1 : 0) - (b.system ? 1 : 0)),
        };
        try {
          // Slug fallback: design uses 'posts' as the demo collection.
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
  const initialRoles: RoleData[] = [
    { name: "admin", system: true, description: "Full access" },
    { name: "editor", system: false, description: "Content editing" },
    { name: "authenticated", system: true, description: "Default for signed-in" },
    { name: "public", system: true, description: "Anonymous read" },
  ];
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
      {tab === "members" && <MembersPanel roles={initialRoles} pushToast={pushToast} />}
      {tab === "roles" && <PermissionsPanel pushToast={pushToast} />}
    </div>
  );
}

function PermissionsPanel({ pushToast }: { pushToast: (m: string) => void }) {
  const initial: RoleData[] = [
    { name: "admin", system: true, badges: ["bypass"], description: "Full access — bypasses all rules.", matrix: { read: "all", create: "all", update: "all", delete: "all" }, rule: "— all actions on all collections" },
    { name: "authenticated", system: true, badges: ["additive"], description: "Default for signed-in users.", matrix: { read: "auth", create: "auth", update: "owner", delete: "owner" }, rule: '{ owner_id: { _eq: "$user.id" } } on read/update/delete' },
    { name: "public", system: true, badges: [], description: "Anonymous read-only access.", matrix: { read: "published", create: "none", update: "none", delete: "none" }, rule: 'read on { status: { _eq: "published" } }, no fields restriction' },
  ];
  const [roles, setRoles] = useState<RoleData[]>(initial);
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
        // keep seed
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
