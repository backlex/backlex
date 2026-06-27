/**
 * `backlex agents` — manage AI agents and chat with them from the terminal,
 * over `/api/agents`. `run` starts (or continues) a thread and prints the
 * agent's final answer; `--json` surfaces the full step trace for scripting.
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

interface AgentRow {
  id: string;
  name?: string;
  model?: string | null;
  tools?: string[];
  memory?: boolean | number;
}

const AGENTS_HELP = `backlex agents <list|get|create|update|delete|threads|run>

  list                              all agents
  get <id>                          one agent (full JSON definition)
  create --data <json|@file|->      create an agent
  update <id> --data <json|@file|-> patch an agent
  delete <id>
  threads <agentId>                 list threads for an agent
  run <agentId> --message <text>    run one turn (new thread unless --thread <id>)
                                    [--thread <id>] [--json]
`;

const BASE = "/api/agents";

const die = (e: unknown, what: string): never => {
  const msg = e instanceof BacklexError ? `${e.status} ${e.message}` : (e as Error).message;
  process.stderr.write(`${what}: ${msg}\n`);
  process.exit(1);
};

export const runAgents = async (args: string[]): Promise<void> => {
  const sub = args[0];
  const rest = args.slice(1);
  const json = has(args, "--json");

  if (!sub || sub === "help" || sub === "--help") {
    process.stdout.write(AGENTS_HELP);
    return;
  }

  const client = makeClient(resolveContext(args));
  try {
    switch (sub) {
      case "list": {
        const { data } = await client.request<{ data: AgentRow[] }>("GET", BASE);
        if (json) printJson(data);
        else
          printTable(
            data.map((a) => ({
              id: a.id,
              name: a.name ?? "—",
              model: a.model ?? "default",
              tools: (a.tools ?? []).length,
              memory: a.memory ? "yes" : "no",
            })),
          );
        return;
      }
      case "get": {
        const id = rest[0];
        if (!id) {
          process.stderr.write("agents get <id>\n");
          process.exit(1);
        }
        const { data } = await client.request<{ data: Record<string, unknown> }>(
          "GET",
          `${BASE}/${encodeURIComponent(id)}`,
        );
        printJson(data);
        return;
      }
      case "create": {
        const data = JSON.parse(await resolvePayload(flag(rest, "--data"))) as Record<string, unknown>;
        const res = await client.request<{ data: Record<string, unknown> }>("POST", BASE, data);
        if (json) printJson(res.data);
        else printKeyValues({ id: res.data.id as string, name: (res.data.name as string) ?? "—" });
        return;
      }
      case "update": {
        const id = rest[0];
        if (!id) {
          process.stderr.write("agents update <id> --data <json>\n");
          process.exit(1);
        }
        const data = JSON.parse(await resolvePayload(flag(rest, "--data"))) as Record<string, unknown>;
        await client.request("PATCH", `${BASE}/${encodeURIComponent(id)}`, data);
        process.stderr.write(`Updated agent ${id}.\n`);
        return;
      }
      case "delete": {
        const id = rest[0];
        if (!id) {
          process.stderr.write("agents delete <id>\n");
          process.exit(1);
        }
        await client.request("DELETE", `${BASE}/${encodeURIComponent(id)}`);
        process.stderr.write(`Deleted agent ${id}.\n`);
        return;
      }
      case "threads": {
        const agentId = rest[0];
        if (!agentId) {
          process.stderr.write("agents threads <agentId>\n");
          process.exit(1);
        }
        const { data } = await client.request<{ data: Array<Record<string, unknown>> }>(
          "GET",
          `${BASE}/${encodeURIComponent(agentId)}/threads`,
        );
        if (json) printJson(data);
        else
          printTable(
            data.map((t) => ({
              id: t.id as string,
              title: (t.title as string) ?? "—",
              status: t.status as string,
            })),
          );
        return;
      }
      case "run": {
        const agentId = rest[0];
        const message = flag(rest, "--message") ?? flag(rest, "-m");
        if (!agentId || !message) {
          process.stderr.write('agents run <agentId> --message "text" [--thread <id>]\n');
          process.exit(1);
        }
        let threadId = flag(rest, "--thread");
        if (!threadId) {
          const created = await client.request<{ data: { id: string } }>(
            "POST",
            `${BASE}/${encodeURIComponent(agentId)}/threads`,
            {},
          );
          threadId = created.data.id;
        }
        const res = await client.request<{
          data: { answer: string; steps: unknown[]; stoppedReason: string };
        }>("POST", `${BASE}/threads/${encodeURIComponent(threadId)}/messages`, { message });
        if (json) printJson({ ...res.data, threadId });
        else process.stdout.write(`${res.data.answer}\n`);
        return;
      }
      default:
        process.stderr.write(`unknown agents subcommand: ${sub}\n\n${AGENTS_HELP}`);
        process.exit(1);
    }
  } catch (e) {
    die(e, `agents ${sub}`);
  }
};
