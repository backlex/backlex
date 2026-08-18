/**
 * The parity gate that catches OMISSION.
 *
 * `analytics-surfaces.test.ts` is a hand-written suite with hardcoded name
 * lists, which means it catches a rename or a removal and is blind to a verb
 * that was simply never added to a surface. Across nine phases this feature
 * grew from five read verbs to fifteen across seven surfaces; "remember to
 * update six other files" is not a mechanism.
 *
 * So this spec derives the expectation from the SDK client — the one surface a
 * new verb always lands on first — and asserts every other surface carries it.
 * Adding a method to `AnalyticsClient` and stopping there now fails here,
 * naming exactly which surface is missing.
 *
 * It reads source text rather than importing, because MCP tools and CLI cases
 * are registered as literals and a runtime import would drag the whole app in
 * for a question about whether a string exists.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const SDK = read("packages/client/src/clients/analytics.ts");
const GQL = read("apps/web/src/server/services/graphql/analytics.ts");
const MCP = read("apps/web/src/server/mcp/tools/analytics.ts");
const CLI = read("packages/cli/src/analytics.ts");
const REST = read("apps/web/src/server/routes/analytics.ts");

/**
 * Every analytics verb, and what it is called on each surface.
 *
 * The SDK column is the anchor: `sdk` must be a real member of
 * `AnalyticsClient`, which the first test proves, so this table cannot drift
 * into describing methods that do not exist.
 */
const VERBS: {
  sdk: string;
  gql: string;
  mcp: string;
  cli: string;
  rest: string;
  /** Ingest verbs have no admin REST path of their own. */
  restOptional?: boolean;
}[] = [
  { sdk: "overview", gql: "analyticsOverview", mcp: "analytics.overview", cli: "overview", rest: '"/overview"' },
  { sdk: "eventNames", gql: "analyticsEventNames", mcp: "analytics.event_names", cli: "event-names", rest: '"/event-names"' },
  { sdk: "funnel", gql: "analyticsFunnel", mcp: "analytics.funnel", cli: "funnel", rest: '"/funnel"' },
  { sdk: "retention", gql: "analyticsRetention", mcp: "analytics.retention", cli: "retention", rest: '"/retention"' },
  { sdk: "events", gql: "analyticsEvents", mcp: "analytics.events", cli: "events", rest: '"/events"' },
  { sdk: "realtime", gql: "analyticsRealtime", mcp: "analytics.realtime", cli: "realtime", rest: '"/realtime"' },
  { sdk: "sessions", gql: "analyticsSessions", mcp: "analytics.sessions", cli: "sessions", rest: '"/sessions"' },
  { sdk: "channels", gql: "analyticsChannels", mcp: "analytics.channels", cli: "channels", rest: '"/channels"' },
  { sdk: "revenue", gql: "analyticsRevenue", mcp: "analytics.revenue", cli: "revenue", rest: '"/revenue"' },
  { sdk: "sites", gql: "analyticsSites", mcp: "analytics.sites", cli: "sites", rest: '"/sites"' },
  { sdk: "segments", gql: "analyticsSegments", mcp: "analytics.segments", cli: "segments", rest: '"/segments"' },
];

describe("every analytics verb reaches every surface", () => {
  test("the table describes methods that actually exist on the SDK client", () => {
    // Guards the guard: a typo here would make the whole spec vacuous by
    // checking surfaces for a verb nobody ever asked for.
    const iface = SDK.slice(
      SDK.indexOf("export interface AnalyticsClient"),
      SDK.indexOf("export const makeAnalytics"),
    );
    expect(iface.length).toBeGreaterThan(200);
    for (const v of VERBS) {
      expect(iface).toContain(`${v.sdk}`);
    }
  });

  for (const v of VERBS) {
    test(`${v.sdk} — REST, GraphQL, MCP, CLI`, () => {
      if (!v.restOptional) {
        expect(REST.includes(`path: ${v.rest}`) || REST.includes(`path: ${v.rest.slice(0, -1)}/{id}"`)).toBe(true);
      }
      expect(GQL).toContain(`${v.gql}:`);
      expect(MCP).toContain(`name: "${v.mcp}"`);
      expect(CLI).toContain(`case "${v.cli}"`);
      // The CLI's help text is a second registration point, and a verb missing
      // from it is invisible to anyone who runs `--help` rather than reading
      // the source.
      expect(CLI.slice(CLI.indexOf("const HELP"), CLI.indexOf("const BASE"))).toContain(v.cli);
    });
  }

  test("every MCP analytics tool is registered in the exported list", () => {
    // A tool that is defined but never pushed into `analyticsTools` is dead
    // code that reads as a shipped feature: it exists, it is exported, and no
    // agent can ever call it.
    // `(?!\[)` excludes `analyticsTools: McpTool[]` — the array itself is not
    // one of its own entries.
    const consts = [...MCP.matchAll(/export const (\w+): McpTool(?!\[)/g)].map(
      (m) => m[1] as string,
    );
    expect(consts.length).toBeGreaterThan(10);

    // Anchor on the assignment, not on the first `[` — that one belongs to the
    // `McpTool[]` type annotation.
    const from = MCP.indexOf("export const analyticsTools");
    const open = MCP.indexOf("= [", from) + 2;
    const entries = MCP.slice(open + 1, MCP.indexOf("]", open))
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);

    expect([...entries].sort()).toEqual([...consts].sort());
  });

  test("every analytics panel metric has a branch that can produce rows", () => {
    // A metric offered in the list but with no branch silently falls through to
    // `series`, so a dashboard shows the wrong chart rather than an error.
    const dash = read("apps/web/src/server/services/dashboards.ts");
    const block = dash.slice(
      dash.indexOf("ANALYTICS_PANEL_METRICS = ["),
      dash.indexOf("] as const"),
    );
    const metrics = [...block.matchAll(/"([a-z-]+)"/g)].map((m) => m[1] as string);
    expect(metrics.length).toBeGreaterThan(10);

    const runner = dash.slice(dash.indexOf("export const runAnalyticsPanel"));
    for (const m of metrics) {
      // Either an explicit `if (metric === "x")` or a `case "x":` in the
      // overview switch. `series` is the documented default.
      if (m === "series") continue;
      const handled =
        runner.includes(`metric === "${m}"`) || runner.includes(`case "${m}":`);
      expect(handled).toBe(true);
    }
  });

  test("the admin offers every panel metric it can run", () => {
    // The server has supported `analytics` panels since before the web-analytics
    // work; the admin editor did not offer the kind at all, so every metric was
    // API-only. This keeps the two lists from drifting apart again.
    const insights = read(
      "apps/web/src/client/admin/pages/observability/insights.tsx",
    );
    const dash = read("apps/web/src/server/services/dashboards.ts");
    const serverMetrics = [
      ...dash
        .slice(dash.indexOf("ANALYTICS_PANEL_METRICS = ["), dash.indexOf("] as const"))
        .matchAll(/"([a-z-]+)"/g),
    ].map((m) => m[1] as string);

    const offered = [
      ...insights
        .slice(insights.indexOf("ANALYTICS_METRIC_OPTIONS"))
        .matchAll(/value: "([a-z-]+)"/g),
    ].map((m) => m[1] as string);

    for (const m of serverMetrics) {
      expect(offered).toContain(m);
    }
  });
});
