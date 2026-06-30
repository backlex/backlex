import { BacklexError } from "backlex";
import { useLiveQuery } from "backlex/react";
import { type FormEvent, useEffect, useState } from "react";
import { backlex, persistToken, type Todo, todos } from "./backlex";
import { SetupCheck } from "./SetupCheck";

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
    <Todos user={user} onSignOut={() => setUser(null)} />
  ) : (
    <AuthForm onAuthed={setUser} />
  );
}

// ── Auth ────────────────────────────────────────────────────────────────────
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
          {mode === "sign-up" ? "Create account" : "Sign in"}
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

// ── Todos ─────────────────────────────────────────────────────────────────
function Todos({ user, onSignOut }: { user: User; onSignOut: () => void }) {
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [activeOnly, setActiveOnly] = useState(false);

  // ONE reactive query replaces the manual list() + subscribe() + reducer the
  // old version hand-rolled. `useLiveQuery` runs the initial page, then keeps
  // `items` consistent as rows change — from this tab, another tab, another
  // client, the SDK, or a flow — pushing a fresh array on every change.
  //
  // Flip `activeOnly` to add a server-side `filter: { done: false }`. The
  // subscription then receives ONLY matching events plus enter/leave
  // transitions, so checking a todo off makes it slide out of the list live
  // (the server tells us it left the result set) with no extra fetch. Toggling
  // it back rebuilds the query (the deep-equal opts key changes).
  const { data: items, loading } = useLiveQuery<Todo>(backlex, "todos", {
    sort: ["-created_at"],
    limit: 100,
    ...(activeOnly ? { filter: { done: { _eq: false } } } : {}),
  });

  // Mutations just call the API — no local state juggling. The live query
  // reflects each change when its event arrives over the realtime stream.
  async function add(e: FormEvent) {
    e.preventDefault();
    const text = title.trim();
    if (!text) return;
    setTitle("");
    try {
      await todos.create({ title: text, done: false });
    } catch (err) {
      setError(err instanceof BacklexError ? err.message : String(err));
    }
  }

  async function toggle(t: Todo) {
    try {
      await todos.update(t.id, { done: !t.done });
    } catch (err) {
      setError(err instanceof BacklexError ? err.message : String(err));
    }
  }

  async function remove(t: Todo) {
    try {
      await todos.delete(t.id);
    } catch (err) {
      setError(err instanceof BacklexError ? err.message : String(err));
    }
  }

  async function signOut() {
    await backlex.auth.signOut().catch(() => {});
    persistToken();
    onSignOut();
  }

  return (
    <Centered>
      <div className="w-full max-w-md space-y-4">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold">Todos</h1>
            <p className="text-sm text-neutral-500">{user.email}</p>
          </div>
          <button
            type="button"
            onClick={signOut}
            className="text-sm text-neutral-500 hover:text-neutral-800"
          >
            Sign out
          </button>
        </header>

        <form onSubmit={add} className="flex gap-2">
          <input
            className={inputCls}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="What needs doing?"
          />
          <button type="submit" className={primaryBtnCls + " w-auto px-4"}>
            Add
          </button>
        </form>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <div className="flex items-center justify-between text-sm">
          <label className="flex items-center gap-2 text-neutral-600">
            <input
              type="checkbox"
              checked={activeOnly}
              onChange={(e) => setActiveOnly(e.target.checked)}
              className="size-4"
            />
            Active only
          </label>
          <span className="text-neutral-400">
            {items.length} {items.length === 1 ? "todo" : "todos"}
          </span>
        </div>

        <ul className="divide-y divide-neutral-200 rounded-xl border border-neutral-200 bg-white">
          {loading ? (
            <li className="p-4 text-sm text-neutral-400">Loading…</li>
          ) : (
            items.length === 0 && (
              <li className="p-4 text-sm text-neutral-400">
                {activeOnly ? "Nothing active — all done!" : "No todos yet."}
              </li>
            )
          )}
          {items.map((t) => (
            <li key={t.id} className="flex items-center gap-3 p-3">
              <input
                type="checkbox"
                checked={!!t.done}
                onChange={() => toggle(t)}
                className="size-4"
              />
              <span
                className={
                  "flex-1 " +
                  (t.done ? "text-neutral-400 line-through" : "text-neutral-800")
                }
              >
                {t.title}
              </span>
              <button
                type="button"
                onClick={() => remove(t)}
                className="text-sm text-neutral-400 hover:text-red-600"
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      </div>
    </Centered>
  );
}

// ── Tiny presentational helpers ─────────────────────────────────────────────
function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-neutral-50 p-6 text-neutral-900">
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-sm font-medium text-neutral-700">{label}</span>
      {children}
    </label>
  );
}

const inputCls =
  "w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-900";
const primaryBtnCls =
  "w-full rounded-lg bg-neutral-900 px-3 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50";
