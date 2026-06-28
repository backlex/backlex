/**
 * `backlex traces` — inspect distributed-tracing spans over
 * `/api/admin/traces`. `list` shows recent traces (one row per logical
 * operation); `get <traceId>` shows the waterfall of spans in one trace.
 * Admin-only on the server. See `docs/tracing.md`.
 */
import { flag, has, makeClient, printJson, printTable, resolveContext } from "./client";

interface TraceSummary {
  traceId: string;
  name: string;
  rootStatus: number | null;
  spanCount: number;
  durationMs: number;
  startedAt: number;
  hasError: boolean;
}

interface SpanRow {
  spanId: string;
  parentSpanId: string | null;
  name: string;
  status: number | null;
  durationMs: number | null;
  startedAt: number;
}

const TRACES_HELP = `backlex traces <list|get> [options]

  list [--path <substr>] [--min-status <code>] [--limit <n>] [--json]
      Recent traces, newest first. --min-status 400 shows only failures.

  get <traceId> [--json]
      Every span in one trace, ordered for a waterfall.
`;

const fmtTime = (ms: number): string => new Date(ms).toISOString();

export const runTraces = async (args: string[]): Promise<void> => {
  if (args.length === 0 || has(args, "help") || has(args, "--help")) {
    process.stdout.write(TRACES_HELP);
    return;
  }
  const [sub, ...rest] = args;
  const json = has(rest, "--json");
  const client = makeClient(resolveContext(rest));

  if (sub === "list") {
    const qs = new URLSearchParams();
    const path = flag(rest, "--path");
    const minStatus = flag(rest, "--min-status");
    const limit = flag(rest, "--limit");
    if (path) qs.set("path", path);
    if (minStatus) qs.set("minStatus", minStatus);
    if (limit) qs.set("limit", limit);
    const tail = qs.toString();
    const { data } = await client.request<{ data: TraceSummary[] }>(
      "GET",
      `/api/admin/traces${tail ? `?${tail}` : ""}`,
    );
    if (json) return printJson(data);
    if (data.length === 0) {
      process.stdout.write("no traces\n");
      return;
    }
    printTable(
      data.map((t) => ({
        started: fmtTime(t.startedAt),
        name: t.name,
        status: t.rootStatus ?? "",
        spans: t.spanCount,
        ms: t.durationMs,
        error: t.hasError ? "✗" : "",
        traceId: t.traceId,
      })),
    );
    return;
  }

  if (sub === "get") {
    const traceId = rest.find((a) => !a.startsWith("--"));
    if (!traceId) {
      process.stderr.write("usage: backlex traces get <traceId>\n");
      process.exitCode = 1;
      return;
    }
    const res = await client.request<{ traceId: string; spans: SpanRow[] }>(
      "GET",
      `/api/admin/traces/${encodeURIComponent(traceId)}`,
    );
    if (json) return printJson(res);
    if (res.spans.length === 0) {
      process.stdout.write(`no spans for trace ${traceId}\n`);
      return;
    }
    printTable(
      res.spans.map((s) => ({
        started: fmtTime(s.startedAt),
        span: s.spanId,
        parent: s.parentSpanId ?? "(root)",
        name: s.name,
        status: s.status ?? "",
        ms: s.durationMs ?? "",
      })),
    );
    return;
  }

  process.stderr.write(`unknown traces subcommand: ${sub}\n${TRACES_HELP}`);
  process.exitCode = 1;
};
