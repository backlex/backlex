import { redirect } from "next/navigation";
import { backlexForRequest, isConfigured, type Note } from "@/lib/backlex";
import { readSessionToken } from "@/lib/session";
import { deleteNoteAction, signOutAction, toggleNoteAction } from "./actions";
import { NewNoteForm } from "./new-note-form";
import { NotConfigured } from "./ui";

/**
 * A Server Component. It runs on the server for every request, so the list is
 * already in the HTML — no loading skeleton, no client fetch, and no session
 * token in the bundle.
 *
 * `dynamic = "force-dynamic"` because the page reads a cookie: without it Next
 * would try to prerender this at build time, where there is no request and no
 * session to read.
 */
export const dynamic = "force-dynamic";

export default async function Home() {
  if (!isConfigured()) return <NotConfigured />;
  if (!(await readSessionToken())) redirect("/sign-in");

  const backlex = await backlexForRequest();

  let notes: Note[] = [];
  try {
    const res = await backlex.from<Note>("notes").list({ sort: ["-created_at"], limit: 100 });
    notes = res.data;
  } catch {
    // An expired or revoked token fails here; bounce to sign-in rather than
    // rendering an empty list that looks like "you have no notes".
    redirect("/sign-in");
  }

  const session = await backlex.auth.getSession().catch(() => ({ user: null }));

  return (
    <main className="mx-auto min-h-dvh max-w-md space-y-4 p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Notes</h1>
          <p className="text-sm text-neutral-500">{session.user?.email ?? "signed in"}</p>
        </div>
        {/* A form posting to a Server Action — no client JS involved. */}
        <form action={signOutAction}>
          <button type="submit" className="text-sm text-neutral-500 hover:text-neutral-800">
            Sign out
          </button>
        </form>
      </header>

      <NewNoteForm />

      <ul className="divide-y divide-neutral-200 rounded-xl border border-neutral-200 bg-white">
        {notes.length === 0 && (
          <li className="p-4 text-sm text-neutral-400">No notes yet.</li>
        )}
        {notes.map((n) => (
          <li key={n.id} className="flex items-center gap-3 p-3">
            <form action={toggleNoteAction} className="flex items-center">
              <input type="hidden" name="id" value={n.id} />
              <input type="hidden" name="done" value={String(!!n.done)} />
              {/* Submitting on change keeps the checkbox working without a
                  Client Component — the action re-renders the page. */}
              <button
                type="submit"
                aria-label={n.done ? "Mark as not done" : "Mark as done"}
                className={
                  "size-4 rounded border " +
                  (n.done ? "border-neutral-900 bg-neutral-900" : "border-neutral-400")
                }
              />
            </form>
            <span
              className={
                "min-w-0 flex-1 break-words " +
                (n.done ? "text-neutral-400 line-through" : "text-neutral-800")
              }
            >
              {n.title}
            </span>
            <form action={deleteNoteAction}>
              <input type="hidden" name="id" value={n.id} />
              <button type="submit" className="text-sm text-neutral-400 hover:text-red-600">
                Delete
              </button>
            </form>
          </li>
        ))}
      </ul>

      <p className="text-xs text-neutral-400">
        Rendered on the server. Every write is a Server Action followed by{" "}
        <code>revalidatePath(&quot;/&quot;)</code>.
      </p>
    </main>
  );
}
