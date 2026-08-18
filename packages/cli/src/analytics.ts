/**
 * `backlex analytics` — product analytics + crash reporting over
 * `/api/admin/analytics` and the public ingest endpoints.
 *
 * The reporting subcommands print a compact table by default and full JSON with
 * `--json`; `track` and `report-error` exist so a CI job or a shell script can
 * mark a deploy, a migration or a failed batch without pulling in the SDK.
 */
import { BacklexError } from "backlex";
import {
  has,
  flag,
  makeClient,
  printJson,
  printKeyValues,
  printTable,
  resolvePayload,
  resolveContext,
} from "./client";

const HELP = `backlex analytics <overview|events|event-names|funnel|retention|errors|error|resolve|ignore|reopen|delete-error|track|report-error|ingest-key|sites|realtime|sessions>

  overview [--days <n>]                headline counters + top breakdowns
  events [--name <n>] [--limit <n>]    recent raw tracked events
  event-names                          distinct event names, by volume
  funnel --steps a,b,c [--window <d>]  ordered conversion funnel
  retention [--event <name>]           cohort retention grid
  errors [--status <s>] [--level <l>]  crash groups (open|resolved|ignored)
  error <id>                           one group + recent stacks
  resolve <id> | ignore <id> | reopen <id>
  delete-error <id>
  track <name> [--props <json|@file|->] [--distinct-id <id>]
  report-error --message <m> [--stack <s>] [--type <t>]
  ingest-key <status|mint|revoke>      publishable client key
  realtime [--site <id>]               who is on the site in the last 30 min
  sessions [--site <id>] [--days <n>]  bounce rate, duration, landing/exit pages
  sites                                websites measured by the drop-in tag
  sites add --name <n> --domain <d>    register one, and print its snippet
  sites rm <id>                        stop accepting that snippet

Common: --days <n> (default 30) sets the reporting window; --json prints raw JSON.
`;

const BASE = "/api/admin/analytics";

const die = (e: unknown, what: string): never => {
  const msg =
    e instanceof BacklexError ? `${e.status} ${e.message}` : (e as Error).message;
  process.stderr.write(`${what}: ${msg}\n`);
  process.exit(1);
};

const need = (value: string | undefined, usage: string): string => {
  if (!value) {
    process.stderr.write(`${usage}\n`);
    process.exit(1);
  }
  return value;
};

/** `--days N` → an inclusive epoch-ms window ending now. Default 30. */
const windowFrom = (args: string[]): { from: number; to: number } => {
  const raw = Number(flag(args, "--days") ?? 30);
  const days = Number.isFinite(raw) ? Math.min(365, Math.max(1, Math.floor(raw))) : 30;
  const to = Date.now();
  return { from: to - days * 86_400_000, to };
};

const iso = (ms: number): string => new Date(ms).toISOString().replace("T", " ").slice(0, 16);
const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;

interface ErrorGroupRow {
  id: string;
  type: string;
  message: string;
  culprit: string | null;
  level: string;
  status: string;
  events: number;
  lastSeen: number;
}

export const runAnalytics = async (args: string[]): Promise<void> => {
  const sub = args[0];
  const rest = args.slice(1);
  const json = has(args, "--json");

  if (!sub || sub === "help" || sub === "--help") {
    process.stdout.write(HELP);
    return;
  }

  const client = makeClient(resolveContext(args));
  /** Shared triage path for resolve / ignore / reopen. */
  const setStatus = async (id: string, status: string, verb: string) => {
    const { data } = await client.request<{ data: ErrorGroupRow }>(
      "PATCH",
      `${BASE}/errors/${encodeURIComponent(id)}`,
      { status },
    );
    if (json) printJson(data);
    else process.stderr.write(`${verb} ${id} (${data.status}).\n`);
  };

  try {
    switch (sub) {
      case "overview": {
        const { from, to } = windowFrom(rest);
        const { data } = await client.request<{ data: any }>(
          "GET",
          `${BASE}/overview?from=${from}&to=${to}`,
        );
        if (json) {
          printJson(data);
          return;
        }
        const totals: Record<string, string> = {
          events: String(data.totals.events),
          visitors: String(data.totals.users),
          sessions: String(data.totals.sessions),
        };
        // Only surface the cookieless caveat when there IS cookieless traffic.
        // Printing "0% cookieless" on every workspace that has none is noise
        // that trains people to skip the line that matters.
        if (data.totals.cookielessShare > 0) {
          totals.cookieless = `${Math.round(data.totals.cookielessShare * 100)}% of events (ids rotate daily)`;
          totals["visitors/day"] = String(data.totals.visitorsPerDay ?? 0);
          totals["visitors (durable ids)"] = String(data.totals.durableUsers);
        }
        printKeyValues(totals);

        process.stderr.write("\nTop events\n");
        printTable(
          data.topEvents.map((e: any) => ({
            event: e.name,
            count: e.count,
            visitors: e.users,
          })),
        );
        const section = (title: string, rows: any[], key: string) => {
          if (!rows?.length) return;
          process.stderr.write(`\n${title}\n`);
          printTable(
            rows.map((r: any) => ({
              [key]: r.value ?? r[key],
              count: r.count,
              visitors: r.users,
            })),
          );
        };
        section("Top paths", data.topPaths, "path");
        section("Top countries", data.topCountries, "country");
        section("Devices", data.topDevices, "device");
        section("Top campaigns", data.topCampaigns, "campaign");
        return;
      }
      case "events": {
        const { from, to } = windowFrom(rest);
        const params = new URLSearchParams({ from: String(from), to: String(to) });
        const name = flag(rest, "--name");
        const distinctId = flag(rest, "--distinct-id");
        const limit = flag(rest, "--limit");
        if (name) params.set("name", name);
        if (distinctId) params.set("distinctId", distinctId);
        if (limit) params.set("limit", limit);
        const { data } = await client.request<{ data: any[] }>(
          "GET",
          `${BASE}/events?${params.toString()}`,
        );
        if (json) printJson(data);
        else
          printTable(
            data.map((e) => ({
              at: iso(e.ts),
              event: e.name,
              visitor: e.distinctId.slice(0, 12),
              path: e.path ?? "—",
            })),
          );
        return;
      }
      case "event-names": {
        const { data } = await client.request<{ data: string[] }>(
          "GET",
          `${BASE}/event-names`,
        );
        if (json) printJson(data);
        else process.stdout.write(`${data.join("\n")}\n`);
        return;
      }
      case "funnel": {
        const steps = need(
          flag(rest, "--steps"),
          "analytics funnel --steps <a,b,c> [--window <days>] [--days <n>]",
        )
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        const { from, to } = windowFrom(rest);
        const windowDays = flag(rest, "--window");
        const { data } = await client.request<{ data: any }>("POST", `${BASE}/funnel`, {
          steps,
          from,
          to,
          ...(windowDays ? { windowDays: Number(windowDays) } : {}),
        });
        if (json) printJson(data);
        else
          printTable(
            data.steps.map((s: any) => ({
              step: s.name,
              visitors: s.count,
              conversion: pct(s.conversion),
              "drop-off": pct(s.dropOff),
            })),
          );
        return;
      }
      case "retention": {
        const { from, to } = windowFrom(rest);
        const event = flag(rest, "--event");
        const { data } = await client.request<{ data: any }>("POST", `${BASE}/retention`, {
          from,
          to,
          ...(event ? { event } : {}),
        });
        if (json) {
          printJson(data);
          return;
        }
        printTable(
          data.cohorts.map((c: any) => {
            const row: Record<string, string | number> = {
              cohort: c.day,
              size: c.size,
            };
            // One column per day-offset, as a share of the cohort — the grid
            // people actually read.
            c.values.forEach((v: number, i: number) => {
              if (i > 0 && i <= 7) row[`d${i}`] = c.size > 0 ? pct(v / c.size) : "—";
            });
            return row;
          }),
        );
        return;
      }
      case "errors": {
        const params = new URLSearchParams();
        const status = flag(rest, "--status");
        const level = flag(rest, "--level");
        const limit = flag(rest, "--limit");
        if (status) params.set("status", status);
        if (level) params.set("level", level);
        if (limit) params.set("limit", limit);
        const q = params.toString();
        const { data } = await client.request<{ data: ErrorGroupRow[] }>(
          "GET",
          `${BASE}/errors${q ? `?${q}` : ""}`,
        );
        if (json) printJson(data);
        else
          printTable(
            data.map((g) => ({
              id: g.id.slice(0, 8),
              type: g.type,
              message: g.message.slice(0, 48),
              count: g.events,
              status: g.status,
              "last seen": iso(g.lastSeen),
            })),
          );
        return;
      }
      case "error": {
        const id = need(rest[0], "analytics error <id>");
        const { data } = await client.request<{ data: any }>(
          "GET",
          `${BASE}/errors/${encodeURIComponent(id)}`,
        );
        if (json) {
          printJson(data);
          return;
        }
        printKeyValues({
          id: data.group.id,
          type: data.group.type,
          message: data.group.message,
          culprit: data.group.culprit ?? "—",
          status: data.group.status,
          occurrences: String(data.group.events),
          visitors: String(data.users),
          "first seen": iso(data.group.firstSeen),
          "last seen": iso(data.group.lastSeen),
        });
        const latest = data.occurrences[0];
        if (latest?.stack) process.stdout.write(`\n${latest.stack}\n`);
        return;
      }
      case "resolve":
        return setStatus(need(rest[0], "analytics resolve <id>"), "resolved", "Resolved");
      case "ignore":
        return setStatus(need(rest[0], "analytics ignore <id>"), "ignored", "Ignored");
      case "reopen":
        return setStatus(need(rest[0], "analytics reopen <id>"), "open", "Reopened");
      case "delete-error": {
        const id = need(rest[0], "analytics delete-error <id>");
        await client.request("DELETE", `${BASE}/errors/${encodeURIComponent(id)}`);
        process.stderr.write(`Deleted error group ${id}.\n`);
        return;
      }
      case "track": {
        const name = need(rest[0], "analytics track <name> [--props <json>]");
        const rawProps = flag(rest, "--props");
        const props = rawProps
          ? (JSON.parse(await resolvePayload(rawProps)) as Record<string, unknown>)
          : undefined;
        const res = await client.request<{ accepted: number; rejected: number }>(
          "POST",
          "/api/analytics/events",
          {
            events: [
              {
                name,
                distinctId: flag(rest, "--distinct-id") ?? "cli",
                source: flag(rest, "--source") ?? "server",
                ...(props ? { props } : {}),
              },
            ],
          },
        );
        if (json) printJson(res);
        else process.stderr.write(`Tracked "${name}" (accepted ${res.accepted}).\n`);
        return;
      }
      case "report-error": {
        const message = need(
          flag(rest, "--message"),
          "analytics report-error --message <m> [--stack <s>] [--type <t>]",
        );
        const res = await client.request<{ accepted: number; groups: string[] }>(
          "POST",
          "/api/analytics/errors",
          {
            errors: [
              {
                message,
                type: flag(rest, "--type") ?? "Error",
                stack: flag(rest, "--stack") ?? null,
                platform: flag(rest, "--platform") ?? "server",
                release: flag(rest, "--release") ?? null,
              },
            ],
          },
        );
        if (json) printJson(res);
        else process.stderr.write(`Reported (group ${res.groups[0] ?? "—"}).\n`);
        return;
      }
      case "sessions": {
        const { from, to } = windowFrom(rest);
        const site = flag(rest, "--site");
        const params = new URLSearchParams({ from: String(from), to: String(to) });
        if (site) params.set("siteId", site);
        const { data } = await client.request<{ data: any }>(
          "GET",
          `${BASE}/sessions?${params}`,
        );
        if (json) {
          printJson(data);
          return;
        }
        printKeyValues({
          sessions: String(data.sessions),
          pageviews: String(data.pageviews),
          "bounce rate": `${Math.round(data.bounceRate * 100)}%`,
          "avg duration": `${Math.round(data.avgDurationMs / 1000)}s`,
          "pages / session": data.pagesPerSession.toFixed(2),
        });
        const section = (title: string, rows: any[]) => {
          if (!rows?.length) return;
          process.stderr.write(`\n${title}\n`);
          printTable(
            rows.map((r: any) => ({
              page: r.value,
              sessions: r.count,
              visitors: r.users,
            })),
          );
        };
        section("Landing pages", data.landingPages);
        section("Exit pages", data.exitPages);
        return;
      }
      case "realtime": {
        const site = flag(rest, "--site");
        const { data } = await client.request<{ data: any }>(
          "GET",
          `${BASE}/realtime${site ? `?siteId=${encodeURIComponent(site)}` : ""}`,
        );
        if (json) {
          printJson(data);
          return;
        }
        printKeyValues({
          "visitors now": String(data.visitorsNow),
          "events (30 min)": String(data.events),
        });
        if (data.truncated) {
          // A clipped realtime figure is a wrong number that still renders, so
          // it is said out loud rather than left to the reader to notice.
          process.stderr.write(
            "\nRow cap reached — these counts are a floor, not a total.\n",
          );
        }
        if (data.topPaths.length) {
          process.stderr.write("\nTop pages\n");
          printTable(
            data.topPaths.map((r: any) => ({
              path: r.value,
              views: r.count,
              visitors: r.users,
            })),
          );
        }
        return;
      }
      case "sites": {
        const action = rest[0] ?? "list";
        if (action === "add") {
          const name = flag(rest, "--name");
          const domain = flag(rest, "--domain");
          if (!name || !domain) {
            throw new Error("sites add needs --name and --domain.");
          }
          const { data } = await client.request<{ data: any }>(
            "POST",
            `${BASE}/sites`,
            { name, domain },
          );
          if (json) {
            printJson(data);
            return;
          }
          printKeyValues({ id: data.id, name: data.name, domain: data.domain });
          // The snippet is the only reason an operator runs this command, so
          // print it rather than making them assemble it from the id.
          const base = resolveContext(args).url.replace(/\/$/, "");
          process.stderr.write(
            `\nAdd this to ${data.domain}:\n\n` +
              `  <script defer src="${base}/api/analytics/script.js" data-site="${data.id}"></script>\n`,
          );
          return;
        }
        if (action === "rm") {
          const id = rest[1];
          if (!id) throw new Error("sites rm needs a site id.");
          await client.request("DELETE", `${BASE}/sites/${encodeURIComponent(id)}`);
          process.stderr.write(`Removed site ${id}.\n`);
          return;
        }
        const { data } = await client.request<{ data: any[] }>("GET", `${BASE}/sites`);
        if (json) {
          printJson(data);
          return;
        }
        if (!data.length) {
          process.stderr.write("No sites yet. Add one with `sites add`.\n");
          return;
        }
        printTable(
          data.map((s) => ({
            id: s.id,
            name: s.name,
            domain: s.domain,
            bots: s.filterBots ? "filtered" : "kept",
          })),
        );
        return;
      }
      case "ingest-key": {
        const action = rest[0] ?? "status";
        if (action === "mint") {
          const { data } = await client.request<{ data: { key: string } }>(
            "POST",
            `${BASE}/ingest-key`,
            {},
          );
          if (json) printJson(data);
          else {
            printKeyValues({ key: data.key });
            process.stderr.write(
              "\nShown once — store it now. Any previous key is now invalid.\n",
            );
          }
          return;
        }
        if (action === "revoke") {
          await client.request("DELETE", `${BASE}/ingest-key`);
          process.stderr.write("Revoked the ingest key.\n");
          return;
        }
        const { data } = await client.request<{ data: { exists: boolean } }>(
          "GET",
          `${BASE}/ingest-key`,
        );
        if (json) printJson(data);
        else printKeyValues({ "ingest key": data.exists ? "set" : "not set" });
        return;
      }
      default:
        process.stderr.write(`unknown analytics subcommand: ${sub}\n\n${HELP}`);
        process.exit(1);
    }
  } catch (e) {
    die(e, `analytics ${sub}`);
  }
};
