/**
 * `backlex functions` — sandboxed JS functions over `/api/functions`.
 *
 * `deploy` is create-or-update by name (the natural CI verb): it reads the code
 * from `--file`, looks for an existing function with that name, and PATCHes it
 * or POSTs a new one. `invoke` posts a JSON input to an `http`-triggered
 * function. See `docs/sandbox.md`.
 */
import { readFileSync } from "node:fs";
import { BacklexError } from "backlex";
import {
  has,
  flag,
  makeClient,
  printJson,
  printTable,
  resolvePayload,
  resolveContext,
} from "./client";

interface FunctionRow {
  id: string;
  name: string;
  trigger: string;
  pattern: string | null;
  active: boolean | number;
}

const FUNCTIONS_HELP = `backlex functions <list|deploy|invoke|delete>

  list                          all functions
  deploy <name> --file <path>   create or update a function from a code file
        [--trigger http|event|cron] [--pattern <p>] [--timeout <ms>] [--inactive]
  invoke <name> [--data <json|@file|->]   run an http-triggered function
  delete <id>
`;

const BASE = "/api/functions";

const die = (e: unknown, what: string): never => {
  const msg = e instanceof BacklexError ? `${e.status} ${e.message}` : (e as Error).message;
  process.stderr.write(`${what}: ${msg}\n`);
  process.exit(1);
};

export const runFunctions = async (args: string[]): Promise<void> => {
  const sub = args[0];
  const rest = args.slice(1);
  const json = has(args, "--json");

  if (!sub || sub === "help" || sub === "--help") {
    process.stdout.write(FUNCTIONS_HELP);
    return;
  }

  const client = makeClient(resolveContext(args));
  try {
    switch (sub) {
      case "list": {
        const { data } = await client.request<{ data: FunctionRow[] }>("GET", BASE);
        if (json) printJson(data);
        else
          printTable(
            data.map((f) => ({
              id: f.id,
              name: f.name,
              trigger: f.trigger,
              pattern: f.pattern ?? "—",
              active: f.active ? "yes" : "no",
            })),
          );
        return;
      }
      case "deploy": {
        const name = rest[0];
        const file = flag(rest, "--file");
        if (!name || name.startsWith("-") || !file) {
          process.stderr.write("functions deploy <name> --file <path> [--trigger http]\n");
          process.exit(1);
        }
        const code = readFileSync(file, "utf8");
        const triggerRaw = flag(rest, "--trigger");
        const trigger =
          triggerRaw === "event" || triggerRaw === "cron" ? triggerRaw : "http";
        const timeout = flag(rest, "--timeout");
        const body: Record<string, unknown> = {
          name,
          trigger,
          code,
          pattern: flag(rest, "--pattern") ?? null,
          active: !has(rest, "--inactive"),
        };
        if (timeout) body.timeoutMs = Number(timeout);

        const { data } = await client.request<{ data: FunctionRow[] }>("GET", BASE);
        const existing = data.find((f) => f.name === name);
        const res = existing
          ? await client.request<{ data: FunctionRow }>("PATCH", `${BASE}/${existing.id}`, body)
          : await client.request<{ data: FunctionRow }>("POST", BASE, body);
        if (json) printJson(res.data);
        else process.stderr.write(`${existing ? "Updated" : "Created"} function "${name}".\n`);
        return;
      }
      case "invoke": {
        const name = rest[0];
        if (!name || name.startsWith("-")) {
          process.stderr.write("functions invoke <name> [--data <json|@file|->]\n");
          process.exit(1);
        }
        const dataFlag = flag(rest, "--data");
        const input =
          dataFlag !== undefined ? JSON.parse(await resolvePayload(dataFlag)) : {};
        const res = await client.request<unknown>(
          "POST",
          `${BASE}/${encodeURIComponent(name)}/invoke`,
          input,
        );
        printJson(res);
        return;
      }
      case "delete": {
        const id = rest[0];
        if (!id) {
          process.stderr.write("functions delete <id>\n");
          process.exit(1);
        }
        await client.request("DELETE", `${BASE}/${encodeURIComponent(id)}`);
        process.stderr.write(`Deleted function ${id}.\n`);
        return;
      }
      default:
        process.stderr.write(`unknown functions subcommand: ${sub}\n\n${FUNCTIONS_HELP}`);
        process.exit(1);
    }
  } catch (e) {
    die(e, `functions ${sub}`);
  }
};
