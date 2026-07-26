import type { ReactNode } from "react";

export function Centered({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center p-6">{children}</main>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-sm font-medium text-neutral-700">{label}</span>
      {children}
    </label>
  );
}

export function ErrorLine({ msg }: { msg: string }) {
  return <p className="text-sm text-red-600">{msg}</p>;
}

/** Shown when `BACKLEX_WORKSPACE` is unset — the one setup mistake that breaks every page. */
export function NotConfigured() {
  return (
    <Centered>
      <div className="w-full max-w-md space-y-3 rounded-xl border border-neutral-200 bg-white p-6 shadow-sm">
        <h1 className="text-lg font-semibold">Not configured</h1>
        <ol className="list-decimal space-y-2 pl-5 text-sm text-neutral-700">
          <li>
            Start the backend from the repo root: <code>bun run dev</code>.
          </li>
          <li>
            In the admin UI create a <strong>workspace</strong>, enable open signup, and add a{" "}
            <code>notes</code> collection (owner-scoped, fields <code>title</code> +{" "}
            <code>done</code>).
          </li>
          <li>
            <code>cp .env.example .env</code>, set <code>BACKLEX_WORKSPACE</code>, and restart.
          </li>
        </ol>
      </div>
    </Centered>
  );
}

export const inputCls =
  "w-full min-w-0 rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-900";
export const primaryBtnCls =
  "shrink-0 rounded-lg bg-neutral-900 px-3 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50";
