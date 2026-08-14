import { BacklexError } from "backlex";
import { useLiveQuery, useSession } from "backlex/react";
import { type FormEvent, useState } from "react";
import { AuthForm, Centered, SetupCheck, type ExampleUser } from "@backlex-examples/shared";
import { backlex, type Todo, todos } from "./backlex";

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
  // the sign-out plumbing four examples each wrote by hand. It reads the
  // session from the client rather than from a copy, so a sign-in ANYWHERE —
  // this form, another component, a plain `backlex.auth` call — moves it.
  const { status, user } = useSession(backlex);

  if (status === "unknown") return <Centered>Loading…</Centered>;
  if (status === "anonymous") return <AuthForm client={backlex} />;
  return <Todos user={user as ExampleUser} />;
}

// ── Todos ─────────────────────────────────────────────────────────────────
function Todos({ user }: { user: ExampleUser }) {
  const { signOut } = useSession(backlex);
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
            onClick={() => void signOut()}
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

// ── Local styling ───────────────────────────────────────────────────────────
const inputCls =
  "w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-900";
const primaryBtnCls =
  "w-full rounded-lg bg-neutral-900 px-3 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50";
