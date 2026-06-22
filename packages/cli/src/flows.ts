/**
 * `backlex flows` — the visual workflow builder over `/api/flows`. The flow
 * definition is a serialized DSL, so `create` takes the whole object as JSON
 * (`--data`), pairing with `get`'s JSON output for export → import round-trips.
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

interface FlowRow {
  id: string;
  name?: string;
  trigger?: string;
  active?: boolean | number;
}

const FLOWS_HELP = `backlex flows <list|get|run|create|delete>

  list                          all flows
  get <id>                      one flow (full JSON definition)
  run <id>                      manually run a flow
  create --data <json|@file|->  create a flow from a definition (e.g. exported get)
  delete <id>
`;

const BASE = "/api/flows";

const die = (e: unknown, what: string): never => {
  const msg = e instanceof BacklexError ? `${e.status} ${e.message}` : (e as Error).message;
  process.stderr.write(`${what}: ${msg}\n`);
  process.exit(1);
};

export const runFlows = async (args: string[]): Promise<void> => {
  const sub = args[0];
  const rest = args.slice(1);
  const json = has(args, "--json");

  if (!sub || sub === "help" || sub === "--help") {
    process.stdout.write(FLOWS_HELP);
    return;
  }

  const client = makeClient(resolveContext(args));
  try {
    switch (sub) {
      case "list": {
        const { data } = await client.request<{ data: FlowRow[] }>("GET", BASE);
        if (json) printJson(data);
        else
          printTable(
            data.map((f) => ({
              id: f.id,
              name: f.name ?? "—",
              trigger: f.trigger ?? "—",
              active: f.active ? "yes" : "no",
            })),
          );
        return;
      }
      case "get": {
        const id = rest[0];
        if (!id) {
          process.stderr.write("flows get <id>\n");
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
          process.stderr.write("flows run <id>\n");
          process.exit(1);
        }
        const res = await client.request<unknown>("POST", `${BASE}/${encodeURIComponent(id)}/run`);
        if (json) printJson(res);
        else process.stderr.write(`Ran flow ${id}.\n`);
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
          process.stderr.write("flows delete <id>\n");
          process.exit(1);
        }
        await client.request("DELETE", `${BASE}/${encodeURIComponent(id)}`);
        process.stderr.write(`Deleted flow ${id}.\n`);
        return;
      }
      default:
        process.stderr.write(`unknown flows subcommand: ${sub}\n\n${FLOWS_HELP}`);
        process.exit(1);
    }
  } catch (e) {
    die(e, `flows ${sub}`);
  }
};
