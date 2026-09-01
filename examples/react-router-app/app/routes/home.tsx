import { adminClient, attempt, isConfigured } from "~/backlex.server";
import { ErrorLine, NotConfigured, Panel, Stat } from "~/ui";
import type { Route } from "./+types/home";

/**
 * Loaders run on the server, so this reads the admin plane directly — no
 * browser round-trip, no key in the bundle, and the page arrives fully
 * rendered. `usage.overview()` is admin-only (`/api/admin/usage/overview`),
 * which is exactly why it can't appear in the browser examples.
 */
export async function loader() {
  if (!isConfigured()) return { configured: false as const };

  const backlex = adminClient();
  // Fire both together — they're independent, and a loader that awaits in
  // sequence is the most common needless latency in a framework-mode app.
  const [usage, jobs] = await Promise.all([
    attempt(() => backlex.usage.overview({ days: 7 })),
    attempt(() => backlex.jobs.list({ limit: 100 })),
  ]);

  return {
    configured: true as const,
    usage: usage.ok ? usage.data.data : null,
    usageError: usage.ok ? null : usage.error,
    jobCount: jobs.ok ? jobs.data.jobs.length : null,
    jobsError: jobs.ok ? null : jobs.error,
  };
}

export default function Home({ loaderData }: Route.ComponentProps) {
  if (!loaderData.configured) return <NotConfigured />;
  const { usage, usageError, jobCount, jobsError } = loaderData;

  return (
    <div className="space-y-6">
      <Panel
        title="Usage this month"
        desc="usage.overview({ days: 7 }) — request/error totals, per-key breakdown, and effective limits"
      >
        {usageError && <ErrorLine msg={usageError} />}
        {usage && (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <Stat label="Requests" value={usage.monthTotals.requests.toLocaleString()} />
              <Stat label="Errors" value={usage.monthTotals.errors.toLocaleString()} />
              <Stat label="Month" value={usage.month} />
            </div>

            {usage.over.length > 0 && (
              <p className="rounded-control border border-warn/40 bg-warn/10 p-3 text-sm text-warn">
                Over the effective limit on: {usage.over.join(", ")}.
              </p>
            )}

            <div className="space-y-2">
              <h3 className="text-sm font-medium text-ink-muted">Traffic by key</h3>
              <ul className="space-y-2">
                {usage.byKey.length === 0 && (
                  <li className="text-sm text-ink-dim">No traffic recorded yet.</li>
                )}
                {usage.byKey.map((k) => (
                  <li
                    key={k.id || "session"}
                    className="flex items-center gap-3 rounded-control border border-line p-3 text-sm"
                  >
                    {/* An empty id is the session / no-key bucket. */}
                    <span className="min-w-0 flex-1 truncate">{k.id ? k.name : "sessions"}</span>
                    {k.revoked && <span className="text-xs text-ink-dim">revoked</span>}
                    <span className="text-ink-muted">
                      {k.monthRequests.toLocaleString()} req
                      {k.monthErrors > 0 && ` · ${k.monthErrors} err`}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </>
        )}
      </Panel>

      <Panel title="Queue" desc="jobs.list({ limit: 100 }) — see the Jobs tab to enqueue and retry">
        {jobsError && <ErrorLine msg={jobsError} />}
        {jobCount !== null && <Stat label="Jobs (latest 100)" value={jobCount} />}
      </Panel>
    </div>
  );
}
