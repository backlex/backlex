import { BacklexError } from "backlex";
import { useSession } from "backlex/react";
import {
  AuthForm,
  AuthGateSkeleton,
  controlCls,
  SetupCheck,
  type ExampleUser,
} from "@backlex-examples/shared";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import {
  backlex,
  type I18nText,
  type Locale,
  LOCALE_LABEL,
  LOCALES,
  type Post,
  type PostWrite,
  posts,
} from "./backlex";

export function App() {
  // Gate the whole app behind a config check so a missing/wrong `.env` shows
  // actionable guidance instead of a blank screen.
  return (
    <SetupCheck client={backlex}>
      <AuthGate />
    </SetupCheck>
  );
}

function AuthGate() {
  // One hook replaces the `booting` flag, the session probe, the user state and
  // the sign-out plumbing this file used to hand-roll. It reads the session
  // from the client rather than from a copy, so a sign-in ANYWHERE — this
  // form, another component, a plain `backlex.auth` call — moves it.
  const { status, user } = useSession(backlex);

  if (status === "unknown") return <AuthGateSkeleton />;
  if (status === "anonymous") return <AuthForm client={backlex} />;
  return <Blog user={user as ExampleUser} />;
}

// ── Blog ──────────────────────────────────────────────────────────────────
type Tab = "all" | "published" | "draft";
type Stats = { published: number; draft: number };

function Blog({ user }: { user: ExampleUser }) {
  const { signOut } = useSession(backlex);
  const [items, setItems] = useState<Post[]>([]);
  const [tab, setTab] = useState<Tab>("all");
  const [locale, setLocale] = useState<Locale>("en");
  const [stats, setStats] = useState<Stats>({ published: 0, draft: 0 });
  const [search, setSearch] = useState("");
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Aggregate: one grouped count() call powers the header stats. Demonstrates
  // `aggregate({ agg, groupBy })` — the server counts, not the client. Versioned
  // collections expose the lifecycle state as `_status`.
  const refreshStats = useCallback(async () => {
    try {
      const { data } = await posts.aggregate({ agg: "count", groupBy: "_status" });
      const next: Stats = { published: 0, draft: 0 };
      for (const row of data) {
        if (row.label === "published") next.published = row.value;
        else if (row.label === "draft") next.draft = row.value;
      }
      setStats(next);
    } catch {
      // Aggregate may be unavailable until the first publish — non-fatal.
    }
  }, []);

  // List via the fluent query builder. `.query()` is type-safe and chainable,
  // and `.toQuery()` compiles it to a plain `ListQuery` — the exact JSON the
  // REST API takes — so we can spread it and add the versioned-collection
  // `status` switch (draft / published / all) the builder doesn't model.
  const refresh = useCallback(async () => {
    setSearching(false);
    try {
      const base = posts
        .query()
        .orderBy("-created_at")
        .limit(100)
        .withMeta("filter_count")
        .toQuery();
      // `locale` collapses the localized `title` / `body` to one language.
      const res = await posts.list({ ...base, status: tab, locale });
      setItems(res.data);
      setError(null);
    } catch (err) {
      setError(err instanceof BacklexError ? err.message : String(err));
    }
  }, [tab, locale]);

  useEffect(() => {
    refresh();
    refreshStats();
  }, [refresh, refreshStats]);

  useEffect(() => {
    // Realtime: the SSE stream replays the same create/update/delete events the
    // server applies, so a second tab (or another author) stays in sync. Live
    // payloads carry the *raw* per-locale maps (no locale collapse over SSE), so
    // we just re-list — that re-applies the active `locale` and keeps the
    // rendered strings correct.
    const off = backlex.subscribe<Post>("items:posts", () => {
      refresh();
      refreshStats();
    });
    return off;
  }, [refresh, refreshStats]);

  // Full-text search — `search({ q, mode: "fts" })` hits the keyword index
  // (enable "Full-text search" on the collection; see README). Falls back to
  // the tab list when the box is cleared.
  async function runSearch(e: FormEvent) {
    e.preventDefault();
    const q = search.trim();
    if (!q) return refresh();
    try {
      const res = await posts.search({ q, mode: "fts", limit: 50, locale });
      setItems(res.data);
      setSearching(true);
      setError(null);
    } catch (err) {
      setError(err instanceof BacklexError ? err.message : String(err));
    }
  }

  async function refreshAll() {
    await Promise.all([refresh(), refreshStats()]);
  }

  return (
    <div className="mx-auto min-h-dvh max-w-3xl space-y-6 p-6 text-ink">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Your blog</h1>
          <p className="text-sm text-ink-muted">
            {user.email} · {stats.published} published · {stats.draft} draft
          </p>
        </div>
        <div className="flex items-center gap-3">
          {/* Locale switcher — re-lists with `locale`, collapsing the
              localized fields to the chosen language. */}
          <div className="flex gap-1 rounded-control bg-raised p-1">
            {LOCALES.map((l) => (
              <button
                key={l}
                type="button"
                onClick={() => setLocale(l)}
                title={LOCALE_LABEL[l]}
                className={
                  "rounded-md px-2 py-1 text-xs font-medium uppercase " +
                  (locale === l ? "bg-panel shadow-sm" : "text-ink-muted hover:text-ink")
                }
              >
                {l}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => void signOut()}
            className="text-sm text-ink-muted hover:text-ink"
          >
            Sign out
          </button>
        </div>
      </header>

      <Composer onCreated={refreshAll} onError={setError} />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1 rounded-control bg-raised p-1">
          {(["all", "published", "draft"] as Tab[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => {
                setSearch("");
                setTab(t);
              }}
              className={
                "rounded-md px-3 py-1 text-sm capitalize " +
                (tab === t && !searching
                  ? "bg-panel shadow-sm"
                  : "text-ink-muted hover:text-ink")
              }
            >
              {t}
            </button>
          ))}
        </div>

        <form onSubmit={runSearch} className="flex gap-2">
          <input
            className={controlCls + " w-56"}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search posts…"
          />
          <button type="submit" className={ghostBtnCls}>
            Search
          </button>
        </form>
      </div>

      {searching && (
        <p className="text-sm text-ink-muted">
          Full-text results for “{search}”.{" "}
          <button type="button" className="underline" onClick={refresh}>
            Clear
          </button>
        </p>
      )}

      {error && <p className="text-sm text-bad">{error}</p>}

      <ul className="space-y-3">
        {items.length === 0 && (
          <li className="rounded-surface border border-dashed border-line-strong p-8 text-center text-sm text-ink-dim">
            {searching ? "No matching posts." : "No posts yet — write one above."}
          </li>
        )}
        {items.map((p) => (
          <PostCard key={p.id} post={p} onChanged={refreshAll} onError={setError} />
        ))}
      </ul>
    </div>
  );
}

// ── Composer ────────────────────────────────────────────────────────────────
const emptyI18n = (): Record<Locale, string> =>
  Object.fromEntries(LOCALES.map((l) => [l, ""])) as Record<Locale, string>;

/** Drop empty locales so we don't store `{ tr: "" }`. */
const trimI18n = (m: Record<Locale, string>): I18nText => {
  const out: I18nText = {};
  for (const l of LOCALES) {
    const v = m[l].trim();
    if (v) out[l] = v;
  }
  return out;
};

function Composer({
  onCreated,
  onError,
}: {
  onCreated: () => void;
  onError: (m: string) => void;
}) {
  const [title, setTitle] = useState<Record<Locale, string>>(emptyI18n);
  const [body, setBody] = useState<Record<Locale, string>>(emptyI18n);
  const [excerpt, setExcerpt] = useState("");
  const [busy, setBusy] = useState(false);

  async function create(e: FormEvent) {
    e.preventDefault();
    const titleMap = trimI18n(title);
    // Require at least one language for the title.
    if (Object.keys(titleMap).length === 0) return;
    setBusy(true);
    try {
      // localized fields are written as a `{ locale: value }` map. New rows in a
      // versioned collection are drafts automatically — you never write
      // `_status`; publishing is a separate step (`publish()`). The `as
      // PostWrite` payload is cast to the SDK's read-shaped `Partial<Post>`.
      const payload: PostWrite = {
        title: titleMap,
        body: trimI18n(body),
        slug: slugify(titleMap.en ?? Object.values(titleMap)[0] ?? ""),
        excerpt: excerpt.trim() || undefined,
      };
      await posts.create(payload as unknown as Partial<Post>);
      setTitle(emptyI18n());
      setBody(emptyI18n());
      setExcerpt("");
      onCreated();
    } catch (err) {
      onError(err instanceof BacklexError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={create}
      className="space-y-3 rounded-surface border border-line bg-panel p-4 shadow-sm"
    >
      {LOCALES.map((l) => (
        <div key={l} className="space-y-2 rounded-control border border-line p-3">
          <p className="text-xs font-medium uppercase text-ink-dim">{LOCALE_LABEL[l]}</p>
          <input
            className={inputCls + " text-base font-medium"}
            value={title[l]}
            onChange={(e) => setTitle((t) => ({ ...t, [l]: e.target.value }))}
            placeholder={`Post title (${l})`}
          />
          <textarea
            className={inputCls + " min-h-20"}
            value={body[l]}
            onChange={(e) => setBody((b) => ({ ...b, [l]: e.target.value }))}
            placeholder={`Write your post… (${l})`}
          />
        </div>
      ))}
      <input
        className={inputCls}
        value={excerpt}
        onChange={(e) => setExcerpt(e.target.value)}
        placeholder="Short excerpt — searchable (optional)"
      />
      <div className="flex justify-end">
        <button type="submit" disabled={busy} className={primaryBtnCls + " w-auto px-4"}>
          {busy ? "Saving…" : "Save draft"}
        </button>
      </div>
    </form>
  );
}

// ── Post card ───────────────────────────────────────────────────────────────
function PostCard({
  post,
  onChanged,
  onError,
}: {
  post: Post;
  onChanged: () => void;
  onError: (m: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const isPublished = post._status === "published";

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      onChanged();
    } catch (err) {
      onError(err instanceof BacklexError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="rounded-surface border border-line bg-panel p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="truncate font-medium">{post.title}</h2>
            <span
              className={
                "rounded-full px-2 py-0.5 text-xs " +
                (isPublished
                  ? "bg-ok/15 text-ok"
                  : "bg-warn/15 text-warn")
              }
            >
              {post._status ?? "draft"}
            </span>
          </div>
          {post.excerpt && (
            <p className="mt-1 line-clamp-2 text-sm text-ink-muted">{post.excerpt}</p>
          )}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {isPublished ? (
          // unpublish() flips a published post back to draft.
          <button
            type="button"
            disabled={busy}
            className={ghostBtnCls}
            onClick={() => run(() => posts.unpublish(post.id))}
          >
            Unpublish
          </button>
        ) : (
          <>
            {/* publish() makes the current draft live immediately. */}
            <button
              type="button"
              disabled={busy}
              className={primaryBtnCls + " w-auto px-3 py-1 text-xs"}
              onClick={() => run(() => posts.publish(post.id))}
            >
              Publish now
            </button>
            {/* schedulePublish(id, at) queues a future go-live. */}
            <button
              type="button"
              disabled={busy}
              className={ghostBtnCls}
              onClick={() =>
                run(() =>
                  posts.schedulePublish(
                    post.id,
                    new Date(Date.now() + 60 * 60 * 1000),
                  ),
                )
              }
            >
              Schedule +1h
            </button>
          </>
        )}
        <button
          type="button"
          disabled={busy}
          className={ghostBtnCls + " ml-auto text-bad hover:bg-bad/10"}
          onClick={() => run(() => posts.delete(post.id))}
        >
          Delete
        </button>
      </div>
    </li>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 64);
}

const inputCls = `w-full ${controlCls}`;
const primaryBtnCls =
  "w-full rounded-control bg-brand px-3 py-2 text-sm font-medium text-on-brand transition hover:opacity-90 disabled:opacity-50 pointer-coarse:min-h-11";
const ghostBtnCls =
  "rounded-control border border-line-strong px-3 py-1 text-sm text-ink-muted transition hover:bg-raised hover:text-ink disabled:opacity-50 pointer-coarse:min-h-11";
