/**
 * `backlex kpis` — the workspace's named KPI definitions and their values.
 *
 * `run` is the interesting one: it evaluates a stored definition over a window
 * AND the window before it, so a script that reports a figure quotes the same
 * number the admin's dashboard shows instead of re-deriving it with its own
 * aggregate.
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

interface KpiRow {
  id: string;
  slug: string;
  name?: string;
  collection?: string;
  agg?: string;
  field?: string | null;
  groupBy?: string | null;
  dateField?: string | null;
}

interface KpiPoint {
  label?: string;
  value: number | null;
  previousValue: number | null;
  delta: number | null;
  deltaPct: number | null;
  currency?: string | null;
}

interface KpiResult {
  slug: string;
  name: string;
  unit?: string | null;
  groupBy?: string | null;
  window: { from: number; to: number } | null;
  point: KpiPoint | null;
  rows: KpiPoint[] | null;
}

const HELP = `backlex kpis <list|get|run|create|update|delete>

  list                          every KPI definition
  get <slug|id>                 one definition (full JSON)
  run <slug|id> [--days <n>]    evaluate it, with the previous period alongside
                [--from <ms>] [--to <ms>]
  create --data <json|@file|->  define a KPI
                                ({ slug, name, collection, agg, field?,
                                   filter?, dateField?, groupBy?, topN?,
                                   format?, unit?, decimals?, direction? })
  update <id> --data <json|@file|->
  delete <id>
`;

const BASE = "/api/admin/kpis";

const die = (e: unknown, what: string): never => {
  const msg = e instanceof BacklexError ? `${e.status} ${e.message}` : (e as Error).message;
  process.stderr.write(`${what}: ${msg}\n`);
  process.exit(1);
};

/** Print a value with its baseline, saying plainly when there is no baseline
 *  rather than showing a zero or a percentage that does not exist. */
const describePoint = (p: KpiPoint): string => {
  const value = p.value === null ? "—" : String(p.value);
  if (p.delta === null) return value;
  const sign = p.delta > 0 ? "+" : "";
  // A null deltaPct means the previous period was zero — quote the absolute
  // change, because there is no proportion to state.
  const change = p.deltaPct === null ? `${sign}${p.delta}` : `${sign}${(p.deltaPct * 100).toFixed(1)}%`;
  return `${value}  (${change} vs previous)`;
};

export const runKpis = async (args: string[]): Promise<void> => {
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
      case "list": {
        const { data } = await client.request<{ data: KpiRow[] }>("GET", BASE);
        if (json) printJson(data);
        else
          printTable(
            data.map((k) => ({
              slug: k.slug,
              name: k.name ?? "—",
              formula:
                k.agg === "count" ? `count(rows)` : `${k.agg}(${k.field ?? "?"})`,
              collection: k.collection ?? "—",
              grouped: k.groupBy ?? "—",
              period: k.dateField ?? "none",
            })),
          );
        return;
      }
      case "get": {
        const ref = rest[0];
        if (!ref) {
          process.stderr.write("kpis get <slug|id>\n");
          process.exit(1);
        }
        const { data } = await client.request<{ data: Record<string, unknown> }>(
          "GET",
          `${BASE}/${encodeURIComponent(ref)}`,
        );
        printJson(data);
        return;
      }
      case "run": {
        const ref = rest[0];
        if (!ref) {
          process.stderr.write("kpis run <slug|id> [--days <n>]\n");
          process.exit(1);
        }
        const qs = new URLSearchParams();
        const days = flag(rest, "--days");
        const from = flag(rest, "--from");
        const to = flag(rest, "--to");
        if (days) qs.set("rangeDays", days);
        if (from) qs.set("from", from);
        if (to) qs.set("to", to);
        const suffix = qs.toString() ? `?${qs}` : "";
        const { data } = await client.request<{ data: KpiResult }>(
          "GET",
          `${BASE}/${encodeURIComponent(ref)}/run${suffix}`,
        );
        if (json) {
          printJson(data);
          return;
        }
        if (data.rows) {
          printTable(
            data.rows.map((r) => ({
              [data.groupBy ?? "group"]: r.label ?? "—",
              value: describePoint(r),
            })),
          );
          return;
        }
        printKeyValues({
          kpi: `${data.name} (${data.slug})`,
          value: data.point ? describePoint(data.point) : "—",
          unit: data.unit ?? "—",
          // Say so out loud: a KPI with no date column reports a running total,
          // and a reader who assumed a period would misread it otherwise.
          period: data.window
            ? `${new Date(data.window.from).toISOString().slice(0, 10)} → ${new Date(data.window.to).toISOString().slice(0, 10)}`
            : "running total (no date column)",
        });
        return;
      }
      case "create": {
        const payload = JSON.parse(await resolvePayload(flag(rest, "--data"))) as Record<
          string,
          unknown
        >;
        const { data } = await client.request<{ data: KpiRow }>("POST", BASE, payload);
        if (json) printJson(data);
        else printKeyValues({ id: data.id, slug: data.slug, name: data.name ?? "—" });
        return;
      }
      case "update": {
        const id = rest[0];
        if (!id) {
          process.stderr.write("kpis update <id> --data <json|@file|->\n");
          process.exit(1);
        }
        const payload = JSON.parse(await resolvePayload(flag(rest, "--data"))) as Record<
          string,
          unknown
        >;
        const { data } = await client.request<{ data: KpiRow }>(
          "PATCH",
          `${BASE}/${encodeURIComponent(id)}`,
          payload,
        );
        if (json) printJson(data);
        else printKeyValues({ id: data.id, slug: data.slug, name: data.name ?? "—" });
        return;
      }
      case "delete": {
        const id = rest[0];
        if (!id) {
          process.stderr.write("kpis delete <id>\n");
          process.exit(1);
        }
        await client.request<{ ok: boolean }>("DELETE", `${BASE}/${encodeURIComponent(id)}`);
        process.stdout.write(`deleted ${id}\n`);
        return;
      }
      default:
        process.stdout.write(HELP);
        process.exit(1);
    }
  } catch (e) {
    die(e, `kpis ${sub}`);
  }
};
