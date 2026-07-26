import {
  isRouteErrorResponse,
  Links,
  Meta,
  NavLink,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "react-router";
import type { Route } from "./+types/root";
import "./app.css";

const NAV = [
  { to: "/", label: "Overview", end: true },
  { to: "/jobs", label: "Jobs" },
  { to: "/flows", label: "Flows" },
  { to: "/agents", label: "Agents" },
  { to: "/permissions", label: "Permissions" },
];

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>backlex ops console</title>
        <Meta />
        <Links />
      </head>
      <body className="bg-neutral-50 text-neutral-900">
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return (
    <div className="mx-auto min-h-dvh max-w-3xl space-y-6 p-6">
      <header className="space-y-3">
        <div>
          <h1 className="text-xl font-semibold">backlex ops console</h1>
          <p className="text-sm text-neutral-500">
            React Router 8 · every read and write runs in a loader/action, so the admin API key
            stays on the server
          </p>
        </div>
        {/* Nav hugs the right edge on mobile, matching the admin's convention. */}
        <nav className="flex flex-wrap justify-end gap-1 rounded-lg bg-neutral-100 p-1 sm:justify-start">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              className={({ isActive }) =>
                "rounded-md px-3 py-1 text-sm " +
                (isActive ? "bg-white shadow-sm" : "text-neutral-500 hover:text-neutral-800")
              }
            >
              {n.label}
            </NavLink>
          ))}
        </nav>
      </header>
      <Outlet />
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const title = isRouteErrorResponse(error) ? `${error.status} ${error.statusText}` : "Error";
  const detail = isRouteErrorResponse(error)
    ? error.data
    : error instanceof Error
      ? error.message
      : String(error);

  return (
    <main className="mx-auto max-w-3xl space-y-3 p-6">
      <h1 className="text-lg font-semibold">{title}</h1>
      <pre className="overflow-x-auto rounded-lg border border-neutral-200 bg-white p-3 text-xs">
        {String(detail)}
      </pre>
    </main>
  );
}
