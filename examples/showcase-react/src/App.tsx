import {
  BacklexError,
  type DeviceToken,
  type FlagState,
  memoryStore,
  type PhoneNumber,
} from "backlex";
import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { backlex, type Note, notes, persistToken } from "./backlex";
import { API_URL, VAPID_PUBLIC_KEY } from "./env";
import { SetupCheck } from "./SetupCheck";

// `SyncController` isn't exported by name; derive it from the client method so
// the ref stays fully typed without importing an internal type.
type SyncController = ReturnType<typeof backlex.sync>;

type User = { id: string; email: string; name?: string | null };

export function App() {
  // Gate the whole app behind a config check so a missing/wrong `.env` shows
  // actionable guidance instead of a blank screen.
  return (
    <SetupCheck>
      <AuthGate />
    </SetupCheck>
  );
}

function AuthGate() {
  const [user, setUser] = useState<User | null>(null);
  const [booting, setBooting] = useState(true);

  // Restore an existing session (token persisted in localStorage) on first load.
  useEffect(() => {
    backlex.auth
      .getSession()
      .then((s) => setUser(s.user ?? null))
      .catch(() => setUser(null))
      .finally(() => setBooting(false));
  }, []);

  if (booting) return <Centered>Loading…</Centered>;
  return user ? (
    <Showcase user={user} onSignOut={() => setUser(null)} />
  ) : (
    <AuthForm onAuthed={setUser} />
  );
}

// ── Auth (reused verbatim from the blog example) ─────────────────────────────
function AuthForm({ onAuthed }: { onAuthed: (u: User) => void }) {
  const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res =
        mode === "sign-up"
          ? await backlex.auth.signUp({ email, password, name })
          : await backlex.auth.signIn({ email, password });
      persistToken(); // stash the workspace session token
      onAuthed(res.user);
    } catch (err) {
      setError(err instanceof BacklexError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Centered>
      <form
        onSubmit={submit}
        className="w-full max-w-sm space-y-4 rounded-xl border border-neutral-200 bg-white p-6 shadow-sm"
      >
        <h1 className="text-lg font-semibold">
          {mode === "sign-up" ? "Create account" : "Sign in to the showcase"}
        </h1>
        {mode === "sign-up" && (
          <Field label="Name">
            <input
              className={inputCls}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ada Lovelace"
            />
          </Field>
        )}
        <Field label="Email">
          <input
            className={inputCls}
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
          />
        </Field>
        <Field label="Password">
          <input
            className={inputCls}
            type="password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
          />
        </Field>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button type="submit" disabled={busy} className={primaryBtnCls}>
          {busy ? "…" : mode === "sign-up" ? "Sign up" : "Sign in"}
        </button>
        <button
          type="button"
          className="w-full text-center text-sm text-neutral-500 hover:text-neutral-800"
          onClick={() => {
            setError(null);
            setMode(mode === "sign-up" ? "sign-in" : "sign-up");
          }}
        >
          {mode === "sign-up"
            ? "Already have an account? Sign in"
            : "Need an account? Sign up"}
        </button>
      </form>
    </Centered>
  );
}

// ── Showcase shell ───────────────────────────────────────────────────────────
// One tab per consumer-facing SDK capability. Each panel is self-contained and
// wraps its calls in try/catch so an un-enabled capability (e.g. FTS off, or no
// versioning) shows an inline error instead of white-screening the whole app.
const PANELS = [
  { id: "crud", label: "CRUD + Query" },
  { id: "aggregate", label: "Aggregates" },
  { id: "search", label: "Search" },
  { id: "realtime", label: "Realtime" },
  { id: "publish", label: "Draft / publish" },
  { id: "storage", label: "Storage" },
  { id: "sync", label: "Offline sync" },
  { id: "flags", label: "Feature flags" },
  { id: "messaging", label: "Messaging" },
  { id: "rest", label: "REST (raw)" },
  { id: "graphql", label: "GraphQL" },
] as const;
type PanelId = (typeof PANELS)[number]["id"];

function Showcase({ user, onSignOut }: { user: User; onSignOut: () => void }) {
  const [tab, setTab] = useState<PanelId>("crud");

  async function signOut() {
    await backlex.auth.signOut().catch(() => {});
    persistToken();
    onSignOut();
  }

  return (
    <div className="mx-auto min-h-dvh max-w-3xl space-y-6 p-6 text-neutral-900">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">backlex showcase</h1>
          <p className="text-sm text-neutral-500">
            {user.email} · one <code>notes</code> collection, every SDK surface
          </p>
        </div>
        <button
          type="button"
          onClick={signOut}
          className="text-sm text-neutral-500 hover:text-neutral-800"
        >
          Sign out
        </button>
      </header>

      <Tabs tabs={PANELS} active={tab} onChange={setTab} />

      {/* Each panel mounts only when active so realtime/sync subscriptions are
          cleaned up the moment you switch tabs. */}
      {tab === "crud" && <CrudPanel />}
      {tab === "aggregate" && <AggregatePanel />}
      {tab === "search" && <SearchPanel />}
      {tab === "realtime" && <RealtimePanel />}
      {tab === "publish" && <PublishPanel />}
      {tab === "storage" && <StoragePanel />}
      {tab === "sync" && <SyncPanel />}
      {tab === "flags" && <FlagsPanel />}
      {tab === "messaging" && <MessagingPanel user={user} />}
      {tab === "rest" && <RestPanel />}
      {tab === "graphql" && <GraphqlPanel />}
    </div>
  );
}

// ── Panel: CRUD + fluent query builder ───────────────────────────────────────
// `notes.query().where(...).orderBy(...).limit(...).withMeta("filter_count").list()`
// compiles to the same REST ListQuery the SDK uses under the hood — type-safe
// and chainable. `withMeta("filter_count")` asks the server for the matched-row
// count alongside the page.
function CrudPanel() {
  const [items, setItems] = useState<Note[]>([]);
  const [count, setCount] = useState<number | null>(null);
  const [title, setTitle] = useState("");
  const [onlyOpen, setOnlyOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await notes
        .query()
        // `onlyOpen` filters to undone notes via the fluent FilterBuilder.
        .where((f) => (onlyOpen ? f.eq("done", false) : f.nempty("title")))
        .orderBy("-created_at")
        .limit(50)
        .withMeta("filter_count")
        .list();
      setItems(res.data);
      setCount(res.meta?.filter_count ?? null);
      setError(null);
    } catch (err) {
      setError(errMsg(err));
    }
  }, [onlyOpen]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function create(e: FormEvent) {
    e.preventDefault();
    const t = title.trim();
    if (!t) return;
    setBusy(true);
    try {
      // create() takes a partial row; the server fills id + created_at. On a
      // versioned collection the row is a draft automatically — never write
      // `_status`.
      await notes.create({ title: t, done: false, priority: 1 });
      setTitle("");
      await refresh();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  async function toggleDone(n: Note) {
    try {
      await notes.update(n.id, { done: !n.done }); // PATCH a single field
      await refresh();
    } catch (err) {
      setError(errMsg(err));
    }
  }

  async function remove(id: string) {
    try {
      await notes.delete(id);
      await refresh();
    } catch (err) {
      setError(errMsg(err));
    }
  }

  return (
    <Panel
      title="CRUD + fluent query builder"
      desc="create / update / delete, plus query().where().orderBy().limit().withMeta('filter_count').list()"
    >
      <form onSubmit={create} className="flex gap-2">
        <input
          className={inputCls}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="New note title…"
        />
        <button type="submit" disabled={busy} className={primaryBtnCls + " w-auto px-4"}>
          {busy ? "…" : "Add"}
        </button>
      </form>

      <label className="flex items-center gap-2 text-sm text-neutral-600">
        <input
          type="checkbox"
          checked={onlyOpen}
          onChange={(e) => setOnlyOpen(e.target.checked)}
        />
        Only open notes (filter <code>done = false</code>)
      </label>

      {count !== null && (
        <p className="text-sm text-neutral-500">
          <code>filter_count</code>: {count} matching row(s)
        </p>
      )}
      {error && <ErrorLine msg={error} />}

      <ul className="space-y-2">
        {items.length === 0 && <Empty>No notes yet — add one above.</Empty>}
        {items.map((n) => (
          <li
            key={n.id}
            className="flex items-center gap-3 rounded-lg border border-neutral-200 bg-white p-3"
          >
            <input
              type="checkbox"
              checked={!!n.done}
              onChange={() => toggleDone(n)}
            />
            <span className={"flex-1 text-sm " + (n.done ? "text-neutral-400 line-through" : "")}>
              {n.title}
            </span>
            <button
              type="button"
              className="text-sm text-red-600 hover:underline"
              onClick={() => remove(n.id)}
            >
              Delete
            </button>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

// ── Panel: aggregates ────────────────────────────────────────────────────────
// `aggregate({ agg })` runs a single function server-side — the database counts,
// not the client. `groupBy` returns one `{ label, value }` row per group.
function AggregatePanel() {
  const [total, setTotal] = useState<number | null>(null);
  const [avgPriority, setAvgPriority] = useState<number | null>(null);
  const [byStatus, setByStatus] = useState<{ label: string; value: number }[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const count = await notes.aggregate({ agg: "count" });
        const avg = await notes.aggregate({ agg: "avg", field: "priority" });
        const grouped = await notes.aggregate({ agg: "count", groupBy: "_status" });
        if (cancelled) return;
        setTotal(count.data[0]?.value ?? 0);
        setAvgPriority(avg.data[0]?.value ?? null);
        setByStatus(
          grouped.data.map((r) => ({ label: String(r.label ?? "—"), value: r.value })),
        );
        setError(null);
      } catch (err) {
        if (!cancelled) setError(errMsg(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const max = Math.max(1, ...byStatus.map((r) => r.value));

  return (
    <Panel
      title="Aggregates"
      desc="aggregate({ agg: 'count' }), aggregate({ agg: 'avg', field: 'priority' }), aggregate({ agg: 'count', groupBy: '_status' })"
    >
      {error && <ErrorLine msg={error} />}
      <div className="grid grid-cols-2 gap-3">
        <Stat label="count(*)" value={total ?? "…"} />
        <Stat
          label="avg(priority)"
          value={avgPriority == null ? "—" : avgPriority.toFixed(2)}
        />
      </div>

      <div className="space-y-1">
        <p className="text-sm font-medium text-neutral-700">count grouped by status</p>
        {byStatus.length === 0 ? (
          <Empty>No grouped rows yet.</Empty>
        ) : (
          <ul className="space-y-1">
            {byStatus.map((r) => (
              <li key={r.label} className="flex items-center gap-2 text-sm">
                <span className="w-20 shrink-0 text-neutral-600">{r.label}</span>
                <span
                  className="inline-block h-4 rounded bg-neutral-900"
                  style={{ width: `${(r.value / max) * 100}%`, minWidth: "0.25rem" }}
                />
                <span className="text-neutral-500">{r.value}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
}

// ── Panel: full-text search ──────────────────────────────────────────────────
// `notes.search({ q, mode: "fts" })` hits the keyword index. Requires the
// "Full-text search" capability enabled on the collection (see README) —
// otherwise the backend 4xx's and we surface the error inline.
function SearchPanel() {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Note[]>([]);
  const [ran, setRan] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(e: FormEvent) {
    e.preventDefault();
    const text = q.trim();
    if (!text) return;
    try {
      const res = await notes.search({ q: text, mode: "fts", limit: 20 });
      setResults(res.data);
      setRan(true);
      setError(null);
    } catch (err) {
      setRan(true);
      setResults([]);
      setError(errMsg(err));
    }
  }

  return (
    <Panel
      title="Full-text search"
      desc="notes.search({ q, mode: 'fts' }) — needs Full-text search enabled on the collection"
    >
      <form onSubmit={run} className="flex gap-2">
        <input
          className={inputCls}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search note titles + bodies…"
        />
        <button type="submit" className={ghostBtnCls}>
          Search
        </button>
      </form>
      {error && <ErrorLine msg={error} />}
      {ran && !error && (
        <ul className="space-y-2">
          {results.length === 0 && <Empty>No matches.</Empty>}
          {results.map((n) => (
            <li key={n.id} className="rounded-lg border border-neutral-200 bg-white p-3 text-sm">
              {n.title}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

// ── Panel: realtime (SSE) ────────────────────────────────────────────────────
// `backlex.subscribe("items:notes", cb)` opens an SSE stream that replays every
// create/update/delete the server commits. Make a change in the CRUD tab (or a
// second browser tab) and watch events land here live.
function RealtimePanel() {
  const [log, setLog] = useState<{ at: string; event: string; id: string }[]>([]);
  const [live, setLive] = useState(true);

  useEffect(() => {
    if (!live) return;
    const off = backlex.subscribe<Note>("items:notes", (e) => {
      setLog((cur) =>
        [
          {
            at: new Date().toLocaleTimeString(),
            event: e.event,
            id: String(e.data.id ?? "—"),
          },
          ...cur,
        ].slice(0, 50),
      );
    });
    return off; // unsubscribe (closes the EventSource) on unmount / toggle
  }, [live]);

  return (
    <Panel
      title="Realtime (SSE)"
      desc="backlex.subscribe('items:notes', e => …) — live create/update/delete events"
    >
      <label className="flex items-center gap-2 text-sm text-neutral-600">
        <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} />
        Subscribed {live ? "(streaming)" : "(paused)"}
      </label>
      <ul className="space-y-1">
        {log.length === 0 && <Empty>Waiting for events — add a note in the CRUD tab.</Empty>}
        {log.map((row, i) => (
          <li
            key={`${row.at}-${i}`}
            className="flex items-center gap-3 rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm"
          >
            <span className="text-neutral-400">{row.at}</span>
            <span
              className={
                "rounded-full px-2 py-0.5 text-xs " +
                (row.event === "deleted"
                  ? "bg-red-100 text-red-700"
                  : row.event === "created"
                    ? "bg-emerald-100 text-emerald-700"
                    : "bg-amber-100 text-amber-700")
              }
            >
              {row.event}
            </span>
            <code className="truncate text-neutral-500">{row.id}</code>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

// ── Panel: draft / publish ───────────────────────────────────────────────────
// `publish` / `unpublish` / `schedulePublish` move a versioned row through its
// lifecycle; `list({ status })` filters by draft/published/all. Requires
// "Versioning / draft-publish" enabled on the collection (see README).
function PublishPanel() {
  const [items, setItems] = useState<Note[]>([]);
  const [status, setStatus] = useState<"all" | "draft" | "published">("all");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      // The single-item read endpoint + list both accept the `status` filter on
      // versioned collections.
      const res = await notes.list({ status, sort: ["-created_at"], limit: 50 });
      setItems(res.data);
      setError(null);
    } catch (err) {
      setError(errMsg(err));
    }
  }, [status]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function act(fn: () => Promise<unknown>) {
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(errMsg(err));
    }
  }

  return (
    <Panel
      title="Draft / publish"
      desc="publish / unpublish / schedulePublish + list({ status }) — needs versioning enabled"
    >
      <div className="flex gap-1 rounded-lg bg-neutral-100 p-1">
        {(["all", "draft", "published"] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setStatus(s)}
            className={
              "rounded-md px-3 py-1 text-sm capitalize " +
              (status === s ? "bg-white shadow-sm" : "text-neutral-500 hover:text-neutral-800")
            }
          >
            {s}
          </button>
        ))}
      </div>
      {error && <ErrorLine msg={error} />}
      <ul className="space-y-2">
        {items.length === 0 && <Empty>No notes for this status.</Empty>}
        {items.map((n) => {
          const published = n._status === "published";
          return (
            <li
              key={n.id}
              className="flex items-center gap-3 rounded-lg border border-neutral-200 bg-white p-3"
            >
              <span className="flex-1 truncate text-sm">{n.title}</span>
              <span
                className={
                  "rounded-full px-2 py-0.5 text-xs " +
                  (published
                    ? "bg-emerald-100 text-emerald-700"
                    : "bg-amber-100 text-amber-700")
                }
              >
                {n._status ?? "draft"}
              </span>
              {published ? (
                <button
                  type="button"
                  className={ghostBtnCls}
                  onClick={() => act(() => notes.unpublish(n.id))}
                >
                  Unpublish
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    className={ghostBtnCls}
                    onClick={() => act(() => notes.publish(n.id))}
                  >
                    Publish
                  </button>
                  <button
                    type="button"
                    className={ghostBtnCls}
                    onClick={() =>
                      act(() =>
                        notes.schedulePublish(n.id, new Date(Date.now() + 60 * 60 * 1000)),
                      )
                    }
                  >
                    +1h
                  </button>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

// ── Panel: storage ───────────────────────────────────────────────────────────
// `storage.put` / `storage.list` / `storage.download` / `storage.delete`.
// download() returns a raw Response; we turn it into an object URL for preview.
type StoredObject = {
  key: string;
  size: number;
  contentType?: string;
  ownerId: string | null;
  uploadedAt: string;
};

function StoragePanel() {
  const [objects, setObjects] = useState<StoredObject[]>([]);
  const [preview, setPreview] = useState<{ key: string; url: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      // The showcase namespaces its uploads under a `showcase/` prefix.
      const res = await backlex.storage.list("showcase/");
      setObjects(res.data);
      setError(null);
    } catch (err) {
      setError(errMsg(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    // Revoke any object URL we created when the panel unmounts.
    return () => {
      setPreview((p) => {
        if (p) URL.revokeObjectURL(p.url);
        return null;
      });
    };
  }, [refresh]);

  async function upload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    try {
      const key = `showcase/${Date.now()}-${file.name}`;
      await backlex.storage.put(key, file, file.type || undefined);
      e.target.value = "";
      await refresh();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  async function show(key: string) {
    try {
      const res = await backlex.storage.download(key);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      setPreview((prev) => {
        if (prev) URL.revokeObjectURL(prev.url);
        return { key, url };
      });
    } catch (err) {
      setError(errMsg(err));
    }
  }

  async function remove(key: string) {
    try {
      await backlex.storage.delete(key);
      if (preview?.key === key) {
        URL.revokeObjectURL(preview.url);
        setPreview(null);
      }
      await refresh();
    } catch (err) {
      setError(errMsg(err));
    }
  }

  return (
    <Panel
      title="Storage"
      desc="storage.put / storage.list / storage.download (→ object URL) / storage.delete"
    >
      <label className="block text-sm text-neutral-600">
        <span className="mb-1 block font-medium text-neutral-700">Upload a file</span>
        <input type="file" disabled={busy} onChange={upload} className="text-sm" />
      </label>
      {error && <ErrorLine msg={error} />}
      <ul className="space-y-2">
        {objects.length === 0 && <Empty>No files under <code>showcase/</code> yet.</Empty>}
        {objects.map((o) => (
          <li
            key={o.key}
            className="flex items-center gap-3 rounded-lg border border-neutral-200 bg-white p-3 text-sm"
          >
            <span className="flex-1 truncate">{o.key.replace(/^showcase\//, "")}</span>
            <span className="text-neutral-400">{formatBytes(o.size)}</span>
            <button type="button" className="text-neutral-600 hover:underline" onClick={() => show(o.key)}>
              Preview
            </button>
            <button type="button" className="text-red-600 hover:underline" onClick={() => remove(o.key)}>
              Delete
            </button>
          </li>
        ))}
      </ul>
      {preview && (
        <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-3">
          <p className="mb-2 text-xs text-neutral-500">Preview · {preview.key}</p>
          {/* Images render inline; everything else gets a download link. */}
          {/\.(png|jpe?g|gif|webp|svg)$/i.test(preview.key) ? (
            <img src={preview.url} alt={preview.key} className="max-h-48 rounded" />
          ) : (
            <a className="text-sm text-neutral-700 underline" href={preview.url} download>
              Open downloaded object
            </a>
          )}
        </div>
      )}
    </Panel>
  );
}

// ── Panel: offline-first sync ────────────────────────────────────────────────
// `backlex.sync({ collection, store, onChange })` pulls the changefeed into a
// local store, stays live over SSE, and queues optimistic writes. We use the
// in-memory `memoryStore()` (also exported: `indexedDbStore()` for cross-reload
// persistence). All controller calls are guarded since the collection's
// changefeed/batch endpoints must be reachable.
function SyncPanel() {
  const ctrlRef = useRef<SyncController | null>(null);
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [running, setRunning] = useState(false);
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  // Build the controller once. `onChange` re-reads the local store after any
  // pull / live event / optimistic write.
  if (!ctrlRef.current) {
    ctrlRef.current = backlex.sync({
      collection: "notes",
      store: memoryStore(),
      onChange: () => {
        ctrlRef.current
          ?.getAll()
          .then(setRows)
          .catch(() => {});
      },
    });
  }
  const ctrl = ctrlRef.current;

  useEffect(() => {
    // Stop the live subscription when the panel unmounts.
    return () => {
      try {
        ctrl.stop();
      } catch {
        /* controller may never have started */
      }
    };
  }, [ctrl]);

  async function guarded(label: string, fn: () => Promise<unknown>) {
    setError(null);
    setInfo(null);
    try {
      await fn();
      setInfo(`${label} ✓`);
      setRows(await ctrl.getAll());
    } catch (err) {
      setError(errMsg(err));
    }
  }

  return (
    <Panel
      title="Offline-first sync"
      desc="backlex.sync({ collection, store: memoryStore() }) — start / pull / flush / stop + optimistic writes"
    >
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={ghostBtnCls}
          onClick={() =>
            guarded("start", async () => {
              await ctrl.start();
              setRunning(true);
            })
          }
        >
          start()
        </button>
        <button type="button" className={ghostBtnCls} onClick={() => guarded("pull", () => ctrl.pull())}>
          pull()
        </button>
        <button type="button" className={ghostBtnCls} onClick={() => guarded("flush", () => ctrl.flush())}>
          flush()
        </button>
        <button
          type="button"
          className={ghostBtnCls}
          onClick={() =>
            guarded("stop", async () => {
              ctrl.stop();
              setRunning(false);
            })
          }
        >
          stop()
        </button>
        <span className="self-center text-xs text-neutral-400">
          {running ? "live" : "idle"}
        </span>
      </div>

      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const t = title.trim();
          if (!t) return;
          setTitle("");
          // Optimistic local create — applies to the store immediately and
          // queues the write, which flush()/start() send to the server.
          void guarded("create", () => ctrl.create({ title: t, done: false }));
        }}
      >
        <input
          className={inputCls}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Optimistic local note…"
        />
        <button type="submit" className={primaryBtnCls + " w-auto px-4"}>
          create()
        </button>
      </form>

      {info && <p className="text-sm text-emerald-700">{info}</p>}
      {error && <ErrorLine msg={error} />}

      <ul className="space-y-2">
        {rows.length === 0 && <Empty>Local store is empty — pull() or create() above.</Empty>}
        {rows.map((r) => {
          const id = String(r.id ?? "");
          const pending = r._pending === true;
          return (
            <li
              key={id}
              className="flex items-center gap-3 rounded-lg border border-neutral-200 bg-white p-3 text-sm"
            >
              <span className="flex-1 truncate">{String(r.title ?? "(untitled)")}</span>
              {pending && (
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-700">
                  pending
                </span>
              )}
              <button
                type="button"
                className="text-neutral-600 hover:underline"
                onClick={() => guarded("update", () => ctrl.update(id, { done: true }))}
              >
                update()
              </button>
              <button
                type="button"
                className="text-red-600 hover:underline"
                onClick={() => guarded("remove", () => ctrl.remove(id))}
              >
                remove()
              </button>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

// ── Panel: feature flags / remote config ─────────────────────────────────────
// `flags.all()` returns the evaluated flag map (targeting + rollout already
// applied server-side); `flags.isEnabled(key)` is a quick boolean check.
// Flags are configured in the admin (see README) — an empty map is fine.
function FlagsPanel() {
  const [map, setMap] = useState<Record<string, FlagState>>({});
  const [betaOn, setBetaOn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const all = await backlex.flags.all();
        const beta = await backlex.flags.isEnabled("beta");
        if (cancelled) return;
        setMap(all);
        setBetaOn(beta);
        setError(null);
      } catch (err) {
        if (!cancelled) setError(errMsg(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const entries = Object.entries(map);

  return (
    <Panel
      title="Feature flags / remote config"
      desc="flags.all() + flags.isEnabled('beta') — flags are configured in the admin"
    >
      {betaOn && (
        <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-800">
          🎉 The <code>beta</code> flag is on — this banner is gated by{" "}
          <code>flags.isEnabled("beta")</code>.
        </div>
      )}
      {error && <ErrorLine msg={error} />}
      <ul className="space-y-2">
        {entries.length === 0 && (
          <Empty>No flags evaluated — create one in the admin (Feature flags).</Empty>
        )}
        {entries.map(([key, state]) => (
          <li
            key={key}
            className="flex items-center gap-3 rounded-lg border border-neutral-200 bg-white p-3 text-sm"
          >
            <code className="flex-1">{key}</code>
            <span
              className={
                "rounded-full px-2 py-0.5 text-xs " +
                (state.enabled
                  ? "bg-emerald-100 text-emerald-700"
                  : "bg-neutral-100 text-neutral-500")
              }
            >
              {state.enabled ? "enabled" : "disabled"}
            </span>
            {state.value !== undefined && state.value !== null && (
              <code className="text-neutral-500">{JSON.stringify(state.value)}</code>
            )}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

// ── Panel: messaging (push + SMS) ────────────────────────────────────────────
// The only *end-user* messaging surface: a signed-in user registers their own
// devices/phones and may send to themselves. (`sendPush`/`sendSms` let admins
// target any user; non-admins are restricted to their own id server-side — so
// this panel always passes `user.id`.)
//
// Web Push is a real subscription, not a mock: register a service worker, ask
// for notification permission, `pushManager.subscribe()` with the VAPID public
// key, then hand the endpoint + keys to `messaging.registerDevice`. Delivery
// still needs push credentials configured in the admin; without them the send
// fails with an inline error while registration itself keeps working.
function MessagingPanel({ user }: { user: User }) {
  const [devices, setDevices] = useState<DeviceToken[]>([]);
  const [phones, setPhones] = useState<PhoneNumber[]>([]);
  const [phone, setPhone] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [d, p] = await Promise.all([
        backlex.messaging.listDevices(),
        backlex.messaging.listPhones(),
      ]);
      setDevices(d.data);
      setPhones(p.data);
      setError(null);
    } catch (err) {
      setError(errMsg(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The full browser-push handshake, end to end.
  async function enablePush() {
    setBusy("push");
    setNote(null);
    setError(null);
    try {
      if (!VAPID_PUBLIC_KEY) throw new Error("Set VITE_BACKLEX_VAPID_PUBLIC_KEY to enable push.");
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
        throw new Error("This browser has no Web Push support.");
      }
      const permission = await Notification.requestPermission();
      if (permission !== "granted") throw new Error(`Notification permission: ${permission}`);

      const reg = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
      // Reuse an existing subscription when there is one — re-subscribing with
      // a different key throws, and backlex treats a re-register as a refresh.
      const sub =
        (await reg.pushManager.getSubscription()) ??
        (await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
        }));

      const json = sub.toJSON();
      if (!json.keys?.p256dh || !json.keys?.auth) throw new Error("Subscription is missing keys.");
      await backlex.messaging.registerDevice({
        platform: "web-push",
        token: sub.endpoint,
        keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
        deviceName: "showcase (browser)",
      });
      setNote("Device registered — send yourself a push below.");
      await refresh();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(null);
    }
  }

  async function unregisterDevice(id: string) {
    // Optimistic: drop the row, restore it if the call fails.
    const snapshot = devices;
    setDevices((ds) => ds.filter((d) => d.id !== id));
    try {
      await backlex.messaging.unregister(id);
    } catch (err) {
      setDevices(snapshot);
      setError(errMsg(err));
    }
  }

  async function addPhone(e: FormEvent) {
    e.preventDefault();
    const number = phone.trim();
    if (!number) return;
    setBusy("phone");
    setNote(null);
    setError(null);
    try {
      await backlex.messaging.registerPhone({ phoneNumber: number });
      setPhone("");
      setNote("Phone registered.");
      await refresh();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(null);
    }
  }

  async function unregisterPhone(id: string) {
    const snapshot = phones;
    setPhones((ps) => ps.filter((p) => p.id !== id));
    try {
      await backlex.messaging.unregisterPhone(id);
    } catch (err) {
      setPhones(snapshot);
      setError(errMsg(err));
    }
  }

  async function sendSelf(kind: "push" | "sms") {
    setBusy(kind === "push" ? "send-push" : "send-sms");
    setNote(null);
    setError(null);
    try {
      const res =
        kind === "push"
          ? await backlex.messaging.sendPush({
              userId: user.id,
              title: "Hello from backlex",
              body: "Sent by the showcase Messaging panel.",
              url: "/",
            })
          : await backlex.messaging.sendSms({
              userId: user.id,
              body: "Hello from the backlex showcase.",
            });
      setNote(`Dispatched — sent ${res.sent}, failed ${res.failed}.`);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Panel
      title="Messaging (push + SMS)"
      desc="messaging.registerDevice / registerPhone / listDevices / listPhones / sendPush / sendSms — an end-user may only target themselves"
    >
      {note && <p className="text-sm text-emerald-700">{note}</p>}
      {error && <ErrorLine msg={error} />}

      <div className="grid gap-3 sm:grid-cols-2">
        <Stat label="Devices" value={devices.length} />
        <Stat label="Phones" value={phones.length} />
      </div>

      {/* ── Web Push ── */}
      <div className="space-y-2">
        <h3 className="text-sm font-medium text-neutral-700">Web Push</h3>
        {!VAPID_PUBLIC_KEY && (
          <p className="text-xs text-neutral-500">
            Set <code>VITE_BACKLEX_VAPID_PUBLIC_KEY</code> in <code>.env</code> (admin → Push
            settings) to enable the browser subscription.
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={ghostBtnCls}
            onClick={enablePush}
            disabled={busy === "push" || !VAPID_PUBLIC_KEY}
          >
            {busy === "push" ? "Subscribing…" : "Enable push on this device"}
          </button>
          <button
            type="button"
            className={ghostBtnCls}
            onClick={() => sendSelf("push")}
            disabled={busy === "send-push" || devices.length === 0}
          >
            {busy === "send-push" ? "Sending…" : "Send myself a push"}
          </button>
        </div>
        <ul className="space-y-2">
          {devices.length === 0 && <Empty>No devices registered.</Empty>}
          {devices.map((d) => (
            <li
              key={d.id}
              className="flex items-center gap-3 rounded-lg border border-neutral-200 bg-white p-3 text-sm"
            >
              <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs">{d.platform}</span>
              <span className="min-w-0 flex-1 truncate text-neutral-600">
                {d.deviceName ?? d.token}
              </span>
              {!d.isActive && <span className="text-xs text-neutral-400">inactive</span>}
              <button
                type="button"
                onClick={() => unregisterDevice(d.id)}
                className="text-neutral-400 hover:text-red-600"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      </div>

      {/* ── SMS ── */}
      <div className="space-y-2">
        <h3 className="text-sm font-medium text-neutral-700">SMS</h3>
        <form onSubmit={addPhone} className="flex gap-2">
          <input
            className={inputCls}
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+14155552671"
          />
          <button type="submit" className={ghostBtnCls} disabled={busy === "phone"}>
            {busy === "phone" ? "…" : "Register"}
          </button>
        </form>
        <p className="text-xs text-neutral-500">
          E.164 format. Delivery needs an SMS provider configured in the admin; registration works
          without one.
        </p>
        <button
          type="button"
          className={ghostBtnCls}
          onClick={() => sendSelf("sms")}
          disabled={busy === "send-sms" || phones.length === 0}
        >
          {busy === "send-sms" ? "Sending…" : "Send myself an SMS"}
        </button>
        <ul className="space-y-2">
          {phones.length === 0 && <Empty>No phone numbers registered.</Empty>}
          {phones.map((p) => (
            <li
              key={p.id}
              className="flex items-center gap-3 rounded-lg border border-neutral-200 bg-white p-3 text-sm"
            >
              <code className="flex-1">{p.phoneNumber}</code>
              {!p.isActive && <span className="text-xs text-neutral-400">inactive</span>}
              <button
                type="button"
                onClick={() => unregisterPhone(p.id)}
                className="text-neutral-400 hover:text-red-600"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      </div>
    </Panel>
  );
}

/**
 * VAPID keys travel as base64url; `applicationServerKey` wants raw bytes.
 * Backed by an explicit `ArrayBuffer` so the result is `Uint8Array<ArrayBuffer>`
 * — the plain `new Uint8Array(n)` overload widens to `ArrayBufferLike`, which
 * the DOM's `BufferSource` no longer accepts.
 */
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  const raw = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// ── Raw HTTP helpers (no SDK) ────────────────────────────────────────────────
// The REST + GraphQL panels talk to backlex with plain `fetch` to show the wire
// protocol the SDK wraps. Auth is the workspace session token the SDK captured
// at sign-in (`auth.getToken()`), replayed as a bearer — the token also pins the
// request to the right tenant, so no extra header is needed. Same-origin in dev
// (empty API_URL → relative `/api/...`, proxied by Vite to the backend).
const authHeaders = (): Record<string, string> => {
  const token = backlex.auth.getToken();
  return token ? { authorization: `Bearer ${token}` } : {};
};
const pretty = (v: unknown): string => JSON.stringify(v, null, 2);

// ── Panel: REST (raw fetch) ──────────────────────────────────────────────────
// The same endpoints the SDK calls, hit directly: `GET/POST /api/items/notes`.
// Reach for this from any language/runtime that can speak HTTP + JSON.
function RestPanel() {
  const [title, setTitle] = useState("");
  const [reqLine, setReqLine] = useState<string | null>(null);
  const [result, setResult] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  const run = async (method: string, path: string, body?: unknown) => {
    setError(null);
    setReqLine(`${method} ${path}`);
    try {
      const res = await fetch(`${API_URL}${path}`, {
        method,
        headers: {
          ...authHeaders(),
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const json = await res.json();
      setResult(`HTTP ${res.status}\n\n${pretty(json)}`);
    } catch (err) {
      setError(errMsg(err));
    }
  };

  return (
    <Panel
      title="REST API (raw fetch)"
      desc="GET/POST /api/items/notes with a Bearer token — the wire calls the SDK wraps"
    >
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={ghostBtnCls}
          onClick={() => run("GET", "/api/items/notes?limit=5&sort=-created_at")}
        >
          GET list
        </button>
      </div>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const t = title.trim();
          if (!t) return;
          setTitle("");
          run("POST", "/api/items/notes", { title: t, done: false });
        }}
      >
        <input
          className={inputCls}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="New note title…"
        />
        <button type="submit" className={primaryBtnCls + " w-auto px-4"}>
          POST create
        </button>
      </form>
      {reqLine && <code className="block text-xs text-neutral-500">{reqLine}</code>}
      {error && <ErrorLine msg={error} />}
      {result && (
        <pre className="max-h-72 overflow-auto rounded-lg bg-neutral-900 p-3 text-xs text-neutral-100">
          {result}
        </pre>
      )}
    </Panel>
  );
}

// ── Panel: GraphQL ───────────────────────────────────────────────────────────
// `POST /api/graphql` with `{ query, variables }`. The schema is generated from
// your collection metadata: list query `notes`, mutation `createNotes`, input
// `NotesInput`. Same Bearer-token auth as REST.
const GQL_QUERY = `{
  notes(limit: 5, sort: "-created_at") {
    id
    title
    done
    priority
  }
}`;
const GQL_MUTATION = `mutation Create($data: NotesInput!) {
  createNotes(data: $data) {
    id
    title
  }
}`;

function GraphqlPanel() {
  const [query, setQuery] = useState(GQL_QUERY);
  const [title, setTitle] = useState("");
  const [result, setResult] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  const execute = async (q: string, variables?: Record<string, unknown>) => {
    setError(null);
    try {
      const res = await fetch(`${API_URL}/api/graphql`, {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ query: q, variables }),
      });
      const json = await res.json();
      setResult(`HTTP ${res.status}\n\n${pretty(json)}`);
    } catch (err) {
      setError(errMsg(err));
    }
  };

  return (
    <Panel
      title="GraphQL"
      desc="POST /api/graphql { query, variables } — schema generated from your collections"
    >
      <textarea
        className={inputCls + " min-h-32 font-mono text-xs"}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="flex flex-wrap gap-2">
        <button type="button" className={ghostBtnCls} onClick={() => execute(query)}>
          Run query
        </button>
      </div>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const t = title.trim();
          if (!t) return;
          setTitle("");
          // Pass operations/variables as a variable — the JSON scalar rejects
          // inline literals.
          execute(GQL_MUTATION, { data: { title: t, done: false } });
        }}
      >
        <input
          className={inputCls}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Title for createNotes mutation…"
        />
        <button type="submit" className={primaryBtnCls + " w-auto px-4"}>
          Run mutation
        </button>
      </form>
      {error && <ErrorLine msg={error} />}
      {result && (
        <pre className="max-h-72 overflow-auto rounded-lg bg-neutral-900 p-3 text-xs text-neutral-100">
          {result}
        </pre>
      )}
    </Panel>
  );
}

// ── Shared UI helpers ────────────────────────────────────────────────────────
function Tabs<T extends { id: string; label: string }>({
  tabs,
  active,
  onChange,
}: {
  tabs: readonly T[];
  active: string;
  onChange: (id: T["id"]) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1 rounded-lg bg-neutral-100 p-1">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onChange(t.id as T["id"])}
          className={
            "rounded-md px-3 py-1 text-sm " +
            (active === t.id ? "bg-white shadow-sm" : "text-neutral-500 hover:text-neutral-800")
          }
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

function Panel({ title, desc, children }: { title: string; desc: string; children: ReactNode }) {
  return (
    <section className="space-y-4 rounded-xl border border-neutral-200 bg-white p-4 shadow-sm">
      <div>
        <h2 className="font-semibold">{title}</h2>
        <p className="text-xs text-neutral-500">{desc}</p>
      </div>
      {children}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-lg border border-neutral-200 p-3">
      <p className="text-xs text-neutral-500">{label}</p>
      <p className="text-lg font-semibold">{value}</p>
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <li className="rounded-xl border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-400">
      {children}
    </li>
  );
}

function ErrorLine({ msg }: { msg: string }) {
  // Capabilities the collection may not have enabled (FTS, versioning, …) fail
  // with a backend error — we show it inline so the rest of the app keeps working.
  return <p className="text-sm text-red-600">{msg}</p>;
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-neutral-50 p-6 text-neutral-900">
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-sm font-medium text-neutral-700">{label}</span>
      {children}
    </label>
  );
}

function errMsg(err: unknown): string {
  return err instanceof BacklexError ? err.message : String(err);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const inputCls =
  "w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-900";
const primaryBtnCls =
  "w-full rounded-lg bg-neutral-900 px-3 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50";
const ghostBtnCls =
  "rounded-lg border border-neutral-300 px-3 py-1 text-sm text-neutral-700 hover:bg-neutral-100 disabled:opacity-50";
