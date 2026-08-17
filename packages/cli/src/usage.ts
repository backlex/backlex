/**
 * `backlex usage` — workspace usage metering over `/api/admin/usage`.
 * `overview` prints the month totals + per-key table; `series` the per-day
 * counts; `limits` shows the effective limits; `set-limits` persists them.
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

interface UsageOverviewData {
  month: string;
  days: number;
  series: { day: string; requests: number; errors: number }[];
  keySeries: { day: string; apiKeyId: string; requests: number; errors: number }[];
  monthTotals: { requests: number; errors: number };
  byKey: {
    id: string;
    name: string;
    prefix: string | null;
    revoked: boolean;
    rateLimitPerMinute: number | null;
    monthlyQuota: number | null;
    monthRequests: number;
    monthErrors: number;
  }[];
  gauges: { storageBytes: number | null; dbRows: number | null; measuredAt: number | null };
  limits: {
    mode: string;
    maxRequestsPerMonth: number | null;
    maxStorageBytes: number | null;
    maxDbRows: number | null;
    maxAiCallsPerMonth: number | null;
  };
  envPinned: string[];
  over: string[];
}

const HELP = `backlex usage <overview|series|export|limits|set-limits>

  overview [--days N]             month totals, per-key usage, gauges (default 30d window)
  series [--days N]               per-day request/error counts
  export [--from D] [--to D]      raw billing ledger — one row per (day, key);
                                  CSV on stdout (--json for JSON), defaults to
                                  the current UTC month-to-date, D = YYYY-MM-DD
  limits                          effective workspace limits (env pins marked)
  set-limits --data <json|@file|->  persist limits, e.g.
                                  '{"mode":"hard","maxRequestsPerMonth":100000,
                                    "maxStorageBytes":null,"maxDbRows":null,
                                    "maxAiCallsPerMonth":null}'
`;

const BASE = "/api/admin/usage";

const die = (e: unknown, what: string): never => {
  const msg = e instanceof BacklexError ? `${e.status} ${e.message}` : (e as Error).message;
  process.stderr.write(`${what}: ${msg}\n`);
  process.exit(1);
};

const fmtBytes = (n: number | null): string => {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
};

const fetchOverview = async (
  client: ReturnType<typeof makeClient>,
  args: string[],
): Promise<UsageOverviewData> => {
  const days = flag(args, "--days");
  const qs = days ? `?days=${Number(days)}` : "";
  const { data } = await client.request<{ data: UsageOverviewData }>(
    "GET",
    `${BASE}/overview${qs}`,
  );
  return data;
};

export const runUsage = async (args: string[]): Promise<void> => {
  const sub = args[0];
  const rest = args.slice(1);
  const json = has(args, "--json");

  if (!sub || sub === "help" || sub === "--help") {
    process.stdout.write(HELP);
    return;
  }

  const client = makeClient(resolveContext(args));
  try {
    switch (sub) {
      case "overview": {
        const data = await fetchOverview(client, rest);
        if (json) {
          printJson(data);
          break;
        }
        printKeyValues({
          month: data.month,
          requests: String(data.monthTotals.requests),
          errors: String(data.monthTotals.errors),
          storage: fmtBytes(data.gauges.storageBytes),
          rows: data.gauges.dbRows == null ? "—" : String(data.gauges.dbRows),
          over: data.over.length ? data.over.join(", ") : "none",
        });
        printTable(
          data.byKey.map((k) => ({
            key: k.id === "" ? "(sessions)" : k.name,
            prefix: k.prefix ?? "—",
            requests: String(k.monthRequests),
            errors: String(k.monthErrors),
            "rate/min": k.rateLimitPerMinute == null ? "—" : String(k.rateLimitPerMinute),
            quota: k.monthlyQuota == null ? "—" : String(k.monthlyQuota),
            revoked: k.revoked ? "yes" : "",
          })),
        );
        break;
      }
      case "series": {
        const data = await fetchOverview(client, rest);
        if (json) printJson(data.series);
        else
          printTable(
            data.series.map((p) => ({
              day: p.day,
              requests: String(p.requests),
              errors: String(p.errors),
            })),
          );
        break;
      }
      case "export": {
        const qs = new URLSearchParams();
        const from = flag(rest, "--from");
        const to = flag(rest, "--to");
        if (from) qs.set("from", from);
        if (to) qs.set("to", to);
        const { data } = await client.request<{
          data: {
            from: string;
            to: string;
            rows: {
              day: string;
              apiKeyId: string;
              keyName: string;
              keyPrefix: string | null;
              requests: number;
              errors: number;
              storageBytes: number | null;
              dbRows: number | null;
            }[];
          };
        }>("GET", `${BASE}/export${qs.size > 0 ? `?${qs}` : ""}`);
        if (json) {
          printJson(data);
          break;
        }
        // RFC 4180 CSV to stdout — pipe into a file / billing pipeline.
        const cols = [
          "day",
          "apiKeyId",
          "keyName",
          "keyPrefix",
          "requests",
          "errors",
          "storageBytes",
          "dbRows",
        ] as const;
        const cell = (v: unknown): string => `"${String(v ?? "").replace(/"/g, '""')}"`;
        process.stdout.write(`${cols.map(cell).join(",")}\r\n`);
        for (const r of data.rows)
          process.stdout.write(`${cols.map((c) => cell(r[c])).join(",")}\r\n`);
        break;
      }
      case "limits": {
        const data = await fetchOverview(client, rest);
        if (json) {
          printJson({ limits: data.limits, envPinned: data.envPinned, over: data.over });
          break;
        }
        printKeyValues({
          mode: data.limits.mode,
          "requests/month":
            data.limits.maxRequestsPerMonth == null
              ? "unlimited"
              : String(data.limits.maxRequestsPerMonth),
          storage: data.limits.maxStorageBytes == null ? "unlimited" : fmtBytes(data.limits.maxStorageBytes),
          rows: data.limits.maxDbRows == null ? "unlimited" : String(data.limits.maxDbRows),
          "env-pinned": data.envPinned.length ? data.envPinned.join(", ") : "none",
          over: data.over.length ? data.over.join(", ") : "none",
        });
        break;
      }
      case "set-limits": {
        const payload = JSON.parse(await resolvePayload(flag(rest, "--data"))) as Record<
          string,
          unknown
        >;
        await client.request("PUT", `${BASE}/limits`, payload);
        process.stdout.write("limits saved\n");
        break;
      }
      default:
        process.stderr.write(`unknown subcommand: ${sub}\n${HELP}`);
        process.exit(1);
    }
  } catch (e) {
    die(e, `usage ${sub}`);
  }
};
