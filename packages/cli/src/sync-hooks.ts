/**
 * `backlex sync-hooks` — external services that run BEFORE a write and decide
 * whether it happens, over `/api/admin/sync-hooks`. See `docs/sync-hooks.md`.
 *
 * `test` is the command to reach for first: it says whether a hook is rejecting
 * writes deliberately or is simply unreachable, which the error alone does not.
 */
import { BacklexError } from "backlex";
import { has, flag, makeClient, printJson, printKeyValues, printTable, resolveContext } from "./client";

interface HookRow {
  id: string;
  name: string;
  url: string;
  events: string[];
  onError: "allow" | "deny";
  canMutate: boolean;
  timeoutMs: number;
  enabled: boolean;
  consecutiveFailures: number;
  disabledReason?: string | null;
}

const HELP = `backlex sync-hooks <list|create|update|test|delete>

  list
  create --name <n> --url <u> --events a,b --on-error <deny|allow>
         [--secret <s>] [--timeout <ms>] [--can-mutate] [--priority <n>]
  update <id> [--name …] [--url …] [--events a,b] [--on-error …]
              [--secret …] [--timeout <ms>] [--enable|--disable]
  test <id>                     fire one synthetic call, print the verdict
  delete <id>

  --on-error is REQUIRED on create and has no safe default:
    deny   block the write when your service cannot answer
    allow  let it through, dropping the guarantee the hook provides
`;

const BASE = "/api/admin/sync-hooks";

const die = (e: unknown, what: string): never => {
  const msg = e instanceof BacklexError ? `${e.status} ${e.message}` : (e as Error).message;
  process.stderr.write(`${what}: ${msg}\n`);
  process.exit(1);
};

const csv = (v: string | undefined): string[] =>
  (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

export const runSyncHooks = async (args: string[]): Promise<void> => {
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
        const { data } = await client.request<{ data: HookRow[] }>("GET", BASE);
        if (json) printJson(data);
        else
          printTable(
            data.map((h) => ({
              id: h.id,
              name: h.name,
              events: h.events.join(", "),
              // The consequential column: `deny` means this hook can stop writes.
              "on error": h.onError,
              patches: h.canMutate ? "yes" : "",
              timeout: `${h.timeoutMs}ms`,
              status: h.enabled
                ? h.consecutiveFailures
                  ? `on (${h.consecutiveFailures} failing)`
                  : "on"
                : `off (${h.disabledReason ?? "manual"})`,
            })),
          );
        return;
      }
      case "create": {
        const onError = flag(rest, "--on-error");
        if (onError !== "deny" && onError !== "allow") {
          process.stderr.write(
            "sync-hooks create --on-error <deny|allow> is required — there is no safe default.\n",
          );
          process.exit(1);
        }
        const body: Record<string, unknown> = {
          name: flag(rest, "--name"),
          url: flag(rest, "--url"),
          events: csv(flag(rest, "--events")),
          onError,
          canMutate: has(rest, "--can-mutate"),
        };
        const secret = flag(rest, "--secret");
        if (secret) body.secret = secret;
        const timeout = flag(rest, "--timeout");
        if (timeout) body.timeoutMs = Number(timeout);
        const priority = flag(rest, "--priority");
        if (priority) body.priority = Number(priority);
        if (!body.name || !body.url || !(body.events as string[]).length) {
          process.stderr.write("sync-hooks create --name <n> --url <u> --events a,b\n");
          process.exit(1);
        }
        const res = await client.request<{ data: HookRow }>("POST", BASE, body);
        if (json) printJson(res.data);
        else printKeyValues({ id: res.data.id, name: res.data.name, "on error": res.data.onError });
        return;
      }
      case "update": {
        const id = rest[0];
        if (!id) {
          process.stderr.write("sync-hooks update <id> [flags]\n");
          process.exit(1);
        }
        const body: Record<string, unknown> = {};
        const name = flag(rest, "--name");
        if (name) body.name = name;
        const url = flag(rest, "--url");
        if (url) body.url = url;
        const events = flag(rest, "--events");
        if (events) body.events = csv(events);
        const onError = flag(rest, "--on-error");
        if (onError) body.onError = onError;
        // Only send a secret when one was given: an empty value would blank the
        // stored credential, which cannot be read back.
        const secret = flag(rest, "--secret");
        if (secret) body.secret = secret;
        const timeout = flag(rest, "--timeout");
        if (timeout) body.timeoutMs = Number(timeout);
        if (has(rest, "--enable")) body.enabled = true;
        if (has(rest, "--disable")) body.enabled = false;
        const res = await client.request<{ data: HookRow }>(
          "PATCH",
          `${BASE}/${encodeURIComponent(id)}`,
          body,
        );
        if (json) printJson(res.data);
        else printKeyValues({ id: res.data.id, name: res.data.name, enabled: String(res.data.enabled) });
        return;
      }
      case "test": {
        const id = rest[0];
        if (!id) {
          process.stderr.write("sync-hooks test <id>\n");
          process.exit(1);
        }
        const res = await client.request<{
          ok: boolean;
          ms: number;
          error?: string;
          verdict?: { allow: boolean; reason?: string };
        }>("POST", `${BASE}/${encodeURIComponent(id)}/test`);
        if (json) {
          printJson(res);
          return;
        }
        if (!res.ok) {
          process.stderr.write(`unreachable after ${res.ms}ms: ${res.error ?? "unknown"}\n`);
          process.exit(1);
        }
        process.stdout.write(
          res.verdict?.allow
            ? `allowed in ${res.ms}ms\n`
            : `rejected in ${res.ms}ms: ${res.verdict?.reason ?? "(no reason given)"}\n`,
        );
        return;
      }
      case "delete": {
        const id = rest[0];
        if (!id) {
          process.stderr.write("sync-hooks delete <id>\n");
          process.exit(1);
        }
        await client.request("DELETE", `${BASE}/${encodeURIComponent(id)}`);
        process.stderr.write(`Deleted sync hook ${id}.\n`);
        return;
      }
      default:
        process.stderr.write(HELP);
        process.exit(1);
    }
  } catch (e) {
    die(e, `sync-hooks ${sub}`);
  }
};
