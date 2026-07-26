import type { ReactNode } from "react";

export function Panel({
  title,
  desc,
  children,
}: {
  title: string;
  desc: string;
  children: ReactNode;
}) {
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

export function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-lg border border-neutral-200 p-3">
      <p className="text-xs text-neutral-500">{label}</p>
      <p className="text-lg font-semibold">{value}</p>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <li className="rounded-xl border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-400">
      {children}
    </li>
  );
}

export function ErrorLine({ msg }: { msg: string }) {
  return <p className="text-sm text-red-600">{msg}</p>;
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-sm font-medium text-neutral-700">{label}</span>
      {children}
    </label>
  );
}

/**
 * Shown by every route when `BACKLEX_API_KEY` is unset — the one setup mistake
 * that makes all five pages fail identically, so it deserves a real screen
 * rather than five copies of a 401.
 */
export function NotConfigured() {
  return (
    <Panel title="Not configured" desc="This console needs an admin API key to reach backlex">
      <ol className="list-decimal space-y-2 pl-5 text-sm text-neutral-700">
        <li>
          Start the backend from the repo root: <code>bun run dev</code>.
        </li>
        <li>
          In the admin UI (<code>http://localhost:5173</code>) go to <strong>API keys</strong> and
          mint a key with admin scope. Copy the <code>pak_…</code> value — it is shown once.
        </li>
        <li>
          <code>cp .env.example .env</code>, set <code>BACKLEX_API_KEY</code>, and restart{" "}
          <code>bun run dev</code> in this folder.
        </li>
      </ol>
      <p className="text-xs text-neutral-500">
        The key is read in loaders/actions via <code>process.env</code> and is deliberately not
        <code> VITE_</code>-prefixed, so it never reaches the browser bundle.
      </p>
    </Panel>
  );
}

export const inputCls =
  "w-full min-w-0 rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-900";
export const btnCls =
  "shrink-0 rounded-lg border border-neutral-300 px-3 py-2 text-sm text-neutral-700 hover:bg-neutral-100 disabled:opacity-50";
export const primaryBtnCls =
  "shrink-0 rounded-lg bg-neutral-900 px-3 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50";
