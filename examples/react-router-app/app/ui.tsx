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
    <section className="space-y-4 rounded-surface border border-line bg-panel p-4 shadow-sm">
      <div>
        <h2 className="font-semibold">{title}</h2>
        <p className="text-xs text-ink-muted">{desc}</p>
      </div>
      {children}
    </section>
  );
}

export function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-control border border-line p-3">
      <p className="text-xs text-ink-muted">{label}</p>
      <p className="text-lg font-semibold">{value}</p>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <li className="rounded-surface border border-dashed border-line-strong p-6 text-center text-sm text-ink-dim">
      {children}
    </li>
  );
}

export function ErrorLine({ msg }: { msg: string }) {
  return <p className="text-sm text-bad">{msg}</p>;
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-sm font-medium text-ink-muted">{label}</span>
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
      <ol className="list-decimal space-y-2 pl-5 text-sm text-ink-muted">
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
      <p className="text-xs text-ink-muted">
        The key is read in loaders/actions via <code>process.env</code> and is deliberately not
        <code> VITE_</code>-prefixed, so it never reaches the browser bundle.
      </p>
    </Panel>
  );
}

export const inputCls =
  "w-full min-w-0 rounded-control border border-line-strong bg-panel px-3 py-2 text-sm outline-none transition focus:border-brand";
export const btnCls =
  "shrink-0 rounded-control border border-line-strong px-3 py-2 text-sm text-ink-muted transition hover:bg-raised hover:text-ink disabled:opacity-50 pointer-coarse:min-h-11";
export const primaryBtnCls =
  "shrink-0 rounded-control bg-brand px-3 py-2 text-sm font-medium text-on-brand transition hover:opacity-90 disabled:opacity-50 pointer-coarse:min-h-11";
