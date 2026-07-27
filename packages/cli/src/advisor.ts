/**
 * `backlex advisor` — run the security / performance rule checks over
 * `/api/admin/advisor`. The `--fail-on` flag makes it a CI gate: exit non-zero
 * when any check at or above the given level is present (e.g. block a deploy on
 * an `error`).
 *
 * Two sub-commands ride the same context:
 *   `backlex advisor insights` — the runtime aggregation the traffic-derived
 *      rules are computed from (slowest endpoints, per-collection traffic).
 *   `backlex advisor --apply <id>` — carry out a finding's remediation. Only
 *      the id goes over the wire; the server re-derives the statement.
 *
 * See `docs/advisor.md`.
 */
import { BacklexError } from "backlex";
import { has, flag, makeClient, printJson, printTable, resolveContext } from "./client";

interface AdvisorAction {
  type: "create-index";
  table: string;
  indexName: string;
  columns: string[];
  sql: string;
}

interface AdvisorCheck {
  id: string;
  kind: "security" | "performance";
  level: "error" | "warn" | "info";
  rule: string;
  title: string;
  resource: string;
  action?: AdvisorAction;
}

interface AdvisorRun {
  data: AdvisorCheck[];
  score: number;
  runtime: {
    windowDays: number;
    spanCount: number;
    sampleRate: number;
    truncated: boolean;
  };
}

interface EndpointStat {
  route: string;
  requests: number;
  p50: number;
  p95: number;
  p99: number;
  errorRate: number;
}

interface CollectionStat {
  collection: string;
  listRequests: number;
  p95: number;
  filters: { column: string; requests: number; share: number }[];
  sorts: { column: string; requests: number; share: number }[];
}

interface AdvisorInsights {
  endpoints: EndpointStat[];
  collections: CollectionStat[];
  window: {
    days: number;
    spanCount: number;
    sampleRate: number;
    truncated: boolean;
  };
}

const ADVISOR_HELP = `backlex advisor [--kind security|performance] [--fail-on error|warn] [--days N] [--json]
backlex advisor insights [--days N] [--limit N] [--json]
backlex advisor --apply <finding-id> [--days N]

  Runs the advisor checks. With --fail-on, exits non-zero when any check at or
  above that level is present — use it as a CI gate.

  --days N    Window for the traffic-derived performance rules (default 7).
  --apply ID  Apply the remediation attached to a finding. Only the id is sent;
              the server re-runs the advisor and executes its own statement.

  insights    Print the runtime aggregation behind those rules: slowest
              endpoints (p50/p95/p99, error rate) and per-collection list
              traffic with the columns it filters / sorts on.
`;

// Higher = more severe. A --fail-on threshold trips on anything >= its rank.
const RANK: Record<AdvisorCheck["level"], number> = { info: 0, warn: 1, error: 2 };

/** `--days` as a query-string fragment, or "" when unset/invalid. */
const daysParam = (args: string[]): string => {
  const raw = flag(args, "--days");
  if (!raw) return "";
  const n = Number(raw);
  if (!Number.isFinite(n)) return "";
  return `days=${Math.min(90, Math.max(1, Math.floor(n)))}`;
};

const pct = (share: number): string => `${(share * 100).toFixed(1)}%`;

/** One line describing what the runtime rules had to work with. Printed on
 *  every human-readable run so "no findings" is never mistaken for "no data". */
const runtimeNote = (r: AdvisorRun["runtime"] | AdvisorInsights["window"]): string => {
  const days = "windowDays" in r ? r.windowDays : r.days;
  if (r.spanCount === 0) {
    return `  (no request spans recorded in the last ${days} day(s) — traffic-derived rules could not run)\n`;
  }
  const sampled =
    r.sampleRate < 1 ? `, sampled at ${pct(r.sampleRate)}` : "";
  const capped = r.truncated ? ", window truncated to the most recent spans" : "";
  return `  (${r.spanCount} span(s) over ${days} day(s)${sampled}${capped})\n`;
};

const runInsights = async (args: string[]): Promise<void> => {
  const json = has(args, "--json");
  const qs = new URLSearchParams();
  const days = daysParam(args);
  if (days) qs.set("days", days.slice("days=".length));
  const limit = flag(args, "--limit");
  if (limit && Number.isFinite(Number(limit)))
    qs.set("limit", String(Math.min(200, Math.max(1, Math.floor(Number(limit))))));
  const suffix = qs.size > 0 ? `?${qs}` : "";

  const client = makeClient(resolveContext(args));
  const insights = await client.request<AdvisorInsights>(
    "GET",
    `/api/admin/advisor/insights${suffix}`,
  );

  if (json) {
    printJson(insights);
    return;
  }

  process.stdout.write("Slowest endpoints\n");
  process.stdout.write(runtimeNote(insights.window));
  if (insights.endpoints.length === 0) {
    process.stdout.write("  none\n");
  } else {
    printTable(
      insights.endpoints.map((e) => ({
        route: e.route,
        requests: e.requests,
        p50: `${e.p50}ms`,
        p95: `${e.p95}ms`,
        p99: `${e.p99}ms`,
        errors: pct(e.errorRate),
      })),
    );
  }

  process.stdout.write("\nCollection list traffic\n");
  if (insights.collections.length === 0) {
    process.stdout.write("  none\n");
  } else {
    printTable(
      insights.collections.map((c) => ({
        collection: c.collection,
        lists: c.listRequests,
        p95: `${c.p95}ms`,
        filters:
          c.filters
            .slice(0, 3)
            .map((f) => `${f.column} (${pct(f.share)})`)
            .join(", ") || "—",
        sorts:
          c.sorts
            .slice(0, 3)
            .map((s) => `${s.column} (${pct(s.share)})`)
            .join(", ") || "—",
      })),
    );
  }
};

const applyFinding = async (args: string[], id: string): Promise<void> => {
  const json = has(args, "--json");
  const days = daysParam(args);
  const body: Record<string, unknown> = { id };
  if (days) body.days = Number(days.slice("days=".length));

  const client = makeClient(resolveContext(args));
  const res = await client.request<{ ok: true; applied: AdvisorAction }>(
    "POST",
    "/api/admin/advisor/apply",
    body,
  );
  if (json) printJson(res);
  else
    process.stdout.write(
      `✓ applied ${res.applied.type} — ${res.applied.sql}\n`,
    );
};

export const runAdvisor = async (args: string[]): Promise<void> => {
  if (has(args, "help") || has(args, "--help")) {
    process.stdout.write(ADVISOR_HELP);
    return;
  }

  try {
    if (args[0] === "insights") {
      await runInsights(args.slice(1));
      return;
    }
    const applyId = flag(args, "--apply");
    if (applyId) {
      await applyFinding(args, applyId);
      return;
    }

    const json = has(args, "--json");
    const kind = flag(args, "--kind");
    const failOn = flag(args, "--fail-on") as AdvisorCheck["level"] | undefined;
    const days = daysParam(args);

    const client = makeClient(resolveContext(args));
    const run = await client.request<AdvisorRun>(
      "GET",
      `/api/admin/advisor${days ? `?${days}` : ""}`,
    );
    const checks = kind ? run.data.filter((c) => c.kind === kind) : run.data;

    if (json) printJson(checks);
    else if (checks.length === 0) {
      process.stdout.write("✓ no advisor findings\n");
      process.stdout.write(runtimeNote(run.runtime));
    } else {
      printTable(
        checks.map((c) => ({
          level: c.level,
          kind: c.kind,
          rule: c.rule,
          resource: c.resource,
          title: c.title,
          // Marks the rows `--apply <id>` accepts.
          fixable: c.action ? "yes" : "",
        })),
      );
      process.stdout.write(runtimeNote(run.runtime));
    }

    if (failOn) {
      const threshold = RANK[failOn] ?? 0;
      const tripped = checks.filter((c) => (RANK[c.level] ?? 0) >= threshold);
      if (tripped.length > 0) {
        process.stderr.write(
          `\n✗ ${tripped.length} finding(s) at or above "${failOn}" — failing.\n`,
        );
        process.exit(1);
      }
    }
  } catch (e) {
    const msg = e instanceof BacklexError ? `${e.status} ${e.message}` : (e as Error).message;
    process.stderr.write(`advisor: ${msg}\n`);
    process.exit(1);
  }
};
