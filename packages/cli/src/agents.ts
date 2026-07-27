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

const AGENTS_HELP = `backlex agents <list|get|create|update|delete|threads|run|rooms|say>

  list                              all agents
  get <id>                          one agent (full JSON definition)
  create --data <json|@file|->      create an agent
  update <id> --data <json|@file|-> patch an agent
  delete <id>
  threads <agentId>                 list threads for an agent
  run <agentId> --message <text>    run one turn (new thread unless --thread <id>)
                                    [--thread <id>] [--json]

  rooms                             list every conversation in the workspace
  rooms new [--title <t>] [--agents <id,id>] [--routing mention|default|auto]
  rooms add <roomId> <agentId>      add an agent to a room
  rooms remove <roomId> <agentId>   remove one
  say <roomId> --message <text>     post in a room; @handle to address an agent
                                    [--json]

  memory <agentId>                  durable facts the agent has learned
                                    [--thread <id>] [--limit <n>] [--json]
  memory add <agentId> --content <text>   teach it one fact [--thread <id>]
  memory forget <agentId> <memoryId>      make it forget one
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
      case "rooms": {
        const action = rest[0] ?? "list";
        if (action === "list") {
          const { data } = await client.request<{ data: Array<Record<string, unknown>> }>(
            "GET",
            `${BASE}/threads`,
          );
          if (json) printJson(data);
          else
            printTable(
              data.map((t) => ({
                id: t.id as string,
                title: (t.title as string) ?? "—",
                agents: ((t.agentIds as string[]) ?? []).length,
                routing: (t.routing as string) ?? "mention",
                status: t.status as string,
              })),
            );
          return;
        }
        if (action === "new") {
          const agentsFlag = flag(rest, "--agents");
          const res = await client.request<{ data: Record<string, unknown> }>(
            "POST",
            `${BASE}/threads`,
            {
              ...(flag(rest, "--title") ? { title: flag(rest, "--title") } : {}),
              ...(agentsFlag
                ? { agentIds: agentsFlag.split(",").map((s) => s.trim()).filter(Boolean) }
                : {}),
              ...(flag(rest, "--routing") ? { routing: flag(rest, "--routing") } : {}),
            },
          );
          if (json) printJson(res.data);
          else printKeyValues({ id: res.data.id as string });
          return;
        }
        if (action === "add" || action === "remove") {
          const roomId = rest[1];
          const agentId = rest[2];
          if (!roomId || !agentId) {
            process.stderr.write(`agents rooms ${action} <roomId> <agentId>\n`);
            process.exit(1);
          }
          if (action === "add") {
            await client.request("POST", `${BASE}/threads/${encodeURIComponent(roomId)}/agents`, {
              agentId,
            });
            process.stderr.write(`Added ${agentId} to room ${roomId}.\n`);
          } else {
            await client.request(
              "DELETE",
              `${BASE}/threads/${encodeURIComponent(roomId)}/agents/${encodeURIComponent(agentId)}`,
            );
            process.stderr.write(`Removed ${agentId} from room ${roomId}.\n`);
          }
          return;
        }
        process.stderr.write(`unknown rooms action: ${action}\n\n${AGENTS_HELP}`);
        process.exit(1);
        return;
      }
      case "memory": {
        // `memory <agentId>` lists; `memory add|forget …` mutate. The verb is
        // optional in the list case so the common read is the short one.
        const action =
          rest[0] === "add" || rest[0] === "forget" ? rest[0] : "list";
        const agentId = action === "list" ? rest[0] : rest[1];
        if (!agentId) {
          process.stderr.write(
            "agents memory <agentId> | agents memory add <agentId> --content <text> | agents memory forget <agentId> <memoryId>\n",
          );
          process.exit(1);
        }
        if (action === "add") {
          const content = flag(rest, "--content") ?? flag(rest, "-c");
          if (!content) {
            process.stderr.write('agents memory add <agentId> --content "text"\n');
            process.exit(1);
          }
          const res = await client.request<{
            data: Record<string, unknown> | null;
            meta?: { deduped?: boolean };
          }>("POST", `${BASE}/${encodeURIComponent(agentId)}/memory`, {
            content,
            ...(flag(rest, "--thread") ? { threadId: flag(rest, "--thread") } : {}),
          });
          if (json) printJson(res);
          else if (res.meta?.deduped)
            process.stderr.write("Already known — nothing stored.\n");
          else printKeyValues({ id: res.data?.id as string, content });
          return;
        }
        if (action === "forget") {
          const memoryId = rest[2];
          if (!memoryId) {
            process.stderr.write("agents memory forget <agentId> <memoryId>\n");
            process.exit(1);
          }
          await client.request(
            "DELETE",
            `${BASE}/${encodeURIComponent(agentId)}/memory/${encodeURIComponent(memoryId)}`,
          );
          process.stderr.write(`Forgot ${memoryId}.\n`);
          return;
        }
        const qs = new URLSearchParams();
        if (flag(rest, "--thread")) qs.set("threadId", flag(rest, "--thread") as string);
        if (flag(rest, "--limit")) qs.set("limit", flag(rest, "--limit") as string);
        const suffix = qs.toString() ? `?${qs}` : "";
        const { data } = await client.request<{ data: Array<Record<string, unknown>> }>(
          "GET",
          `${BASE}/${encodeURIComponent(agentId)}/memory${suffix}`,
        );
        if (json) printJson(data);
        else if (data.length === 0)
          process.stderr.write("No facts learned yet.\n");
        else
          printTable(
            data.map((m) => ({
              id: m.id as string,
              scope: m.scope as string,
              hits: Number(m.hits ?? 0),
              content: String(m.content).slice(0, 80),
            })),
          );
        return;
      }
      case "say": {
        const roomId = rest[0];
        const message = flag(rest, "--message") ?? flag(rest, "-m");
        if (!roomId || !message) {
          process.stderr.write('agents say <roomId> --message "text"\n');
          process.exit(1);
        }
        // Routed by the room: an @handle addresses an agent, otherwise the
        // room's mode decides — possibly nobody, which is a valid outcome.
        const res = await client.request<{
          data: { answer?: string; turns?: Array<{ answer: string }> };
        }>("POST", `${BASE}/threads/${encodeURIComponent(roomId)}/messages`, { message });
        if (json) printJson(res.data);
        else if (res.data.turns?.length)
          process.stdout.write(`${res.data.turns.map((t) => t.answer).join("\n\n")}\n`);
        else process.stderr.write("Message posted — no agent was addressed.\n");
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
        }>("POST", `${BASE}/threads/${encodeURIComponent(threadId)}/messages`, {
          message,
          // `run` names its agent, so it answers regardless of how the thread
          // would otherwise route an unaddressed message.
          agentIds: [agentId],
        });
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
