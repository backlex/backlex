/**
 * `backlex dashboards` — embedded BI dashboards over `/api/admin/dashboards`.
 * `run` renders every panel; `share`/`revoke` toggle the public embed token.
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

interface DashboardRow {
  id: string;
  name?: string;
  description?: string | null;
  embedEnabled?: boolean;
}

const HELP = `backlex dashboards <list|get|run|create|delete|share|revoke>

  list                          all dashboards
  get <id>                      one dashboard (full JSON)
  run <id>                      render every panel and print results
  create --data <json|@file|->  create a dashboard ({ name, description?, layout? })
  delete <id>
  share <id> [--role <roleId>]  enable the public embed (prints one-time token)
  revoke <id>                   disable the public embed
`;

const BASE = "/api/admin/dashboards";

const die = (e: unknown, what: string): never => {
  const msg = e instanceof BacklexError ? `${e.status} ${e.message}` : (e as Error).message;
  process.stderr.write(`${what}: ${msg}\n`);
  process.exit(1);
};

export const runDashboards = async (args: string[]): Promise<void> => {
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
        const { data } = await client.request<{ data: DashboardRow[] }>("GET", BASE);
        if (json) printJson(data);
        else
          printTable(
            data.map((d) => ({
              id: d.id,
              name: d.name ?? "—",
              embed: d.embedEnabled ? "live" : "off",
            })),
          );
        return;
      }
      case "get": {
        const id = rest[0];
        if (!id) {
          process.stderr.write("dashboards get <id>\n");
          process.exit(1);
        }
        const { data } = await client.request<{ data: Record<string, unknown> }>(
          "GET",
          `${BASE}/${encodeURIComponent(id)}`,
        );
        printJson(data);
        return;
      }
      case "run": {
        const id = rest[0];
        if (!id) {
          process.stderr.write("dashboards run <id>\n");
          process.exit(1);
        }
        const res = await client.request<unknown>("POST", `${BASE}/${encodeURIComponent(id)}/run`);
        printJson(res);
        return;
      }
      case "create": {
        const data = JSON.parse(await resolvePayload(flag(rest, "--data"))) as Record<string, unknown>;
        const res = await client.request<{ data: Record<string, unknown> }>("POST", BASE, data);
        if (json) printJson(res.data);
        else printKeyValues({ id: res.data.id as string, name: (res.data.name as string) ?? "—" });
        return;
      }
      case "delete": {
        const id = rest[0];
        if (!id) {
          process.stderr.write("dashboards delete <id>\n");
          process.exit(1);
        }
        await client.request("DELETE", `${BASE}/${encodeURIComponent(id)}`);
        process.stderr.write(`Deleted dashboard ${id}.\n`);
        return;
      }
      case "share": {
        const id = rest[0];
        if (!id) {
          process.stderr.write("dashboards share <id> [--role <roleId>]\n");
          process.exit(1);
        }
        const roleId = flag(rest, "--role");
        const res = await client.request<{ token: string; url: string }>(
          "POST",
          `${BASE}/${encodeURIComponent(id)}/share`,
          roleId ? { roleId } : {},
        );
        if (json) printJson(res);
        else printKeyValues({ token: res.token, url: res.url });
        return;
      }
      case "revoke": {
        const id = rest[0];
        if (!id) {
          process.stderr.write("dashboards revoke <id>\n");
          process.exit(1);
        }
        await client.request("DELETE", `${BASE}/${encodeURIComponent(id)}/share`);
        process.stderr.write(`Revoked embed for dashboard ${id}.\n`);
        return;
      }
      default:
        process.stderr.write(`unknown dashboards subcommand: ${sub}\n\n${HELP}`);
        process.exit(1);
    }
  } catch (e) {
    die(e, `dashboards ${sub}`);
  }
};
