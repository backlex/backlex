/**
 * `backlex auth-hooks` — the app's own code running at four moments in its
 * END-USER authentication, over `/api/admin/auth-hooks`. See
 * `docs/auth-hooks.md`.
 *
 * `test` is the command to reach for first: it says whether a hook is refusing
 * deliberately or is simply unreachable, which the error alone does not — and
 * for `custom-access-token` it names the claims that would be dropped as
 * reserved, which is the usual reason one never reaches the token.
 */
import { BacklexError } from "backlex";
import { has, flag, makeClient, printJson, printKeyValues, printTable, resolveContext } from "./client";

const EVENTS = [
  "before-user-created",
  "custom-access-token",
  "password-verification",
  "send-email",
] as const;

interface HookRow {
  id: string;
  event: string;
  targetType: "url" | "function";
  url: string | null;
  functionName: string | null;
  onError: "allow" | "deny";
  timeoutMs: number;
  enabled: boolean;
  consecutiveFailures: number;
  disabledReason?: string | null;
}

const HELP = `backlex auth-hooks <list|create|update|test|delete>

  list
  create --event <e> --on-error <deny|allow>
         (--url <u> | --function <name>)
         [--secret <whsec_…>] [--timeout <ms>]
  update <id> [--event …] [--url … | --function …] [--on-error …]
              [--secret …] [--timeout <ms>] [--enable|--disable]
  test <id>                     fire one representative call, print the verdict
  delete <id>

  --event is one of:
    before-user-created    veto a new end-user before the row is created
    custom-access-token    add claims to the access token
    password-verification  react to — or refuse — a password sign-in
    send-email             deliver the auth mail through your own transport

  --on-error is REQUIRED on create and has no safe default:
    deny   fail the auth action when your service cannot answer
    allow  proceed without it — for custom-access-token that means a token
           MISSING the claim your authorizer reads
`;

const BASE = "/api/admin/auth-hooks";

const die = (e: unknown, what: string): never => {
  const msg = e instanceof BacklexError ? `${e.status} ${e.message}` : (e as Error).message;
  process.stderr.write(`${what}: ${msg}\n`);
  process.exit(1);
};

const targetOf = (h: HookRow): string =>
  h.targetType === "function" ? `fn:${h.functionName ?? ""}` : (h.url ?? "");

export const runAuthHooks = async (args: string[]): Promise<void> => {
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
              event: h.event,
              target: targetOf(h),
              // The consequential column: `deny` means this hook can stop sign-ins.
              "on error": h.onError,
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
        const event = flag(rest, "--event");
        if (!event || !(EVENTS as readonly string[]).includes(event)) {
          process.stderr.write(`auth-hooks create --event <${EVENTS.join("|")}>\n`);
          process.exit(1);
        }
        const onError = flag(rest, "--on-error");
        if (onError !== "deny" && onError !== "allow") {
          process.stderr.write(
            "auth-hooks create --on-error <deny|allow> is required — there is no safe default.\n",
          );
          process.exit(1);
        }
        const url = flag(rest, "--url");
        const fn = flag(rest, "--function");
        if (!url === !fn) {
          process.stderr.write("auth-hooks create needs exactly one of --url or --function.\n");
          process.exit(1);
        }
        const body: Record<string, unknown> = {
          event,
          onError,
          targetType: url ? "url" : "function",
          ...(url ? { url } : { functionName: fn }),
        };
        const secret = flag(rest, "--secret");
        if (secret) body.secret = secret;
        const timeout = flag(rest, "--timeout");
        if (timeout) body.timeoutMs = Number(timeout);
        const res = await client.request<{ data: HookRow }>("POST", BASE, body);
        if (json) printJson(res.data);
        else
          printKeyValues({
            id: res.data.id,
            event: res.data.event,
            target: targetOf(res.data),
            "on error": res.data.onError,
          });
        return;
      }
      case "update": {
        const id = rest[0];
        if (!id) {
          process.stderr.write("auth-hooks update <id> [flags]\n");
          process.exit(1);
        }
        const body: Record<string, unknown> = {};
        const event = flag(rest, "--event");
        if (event) body.event = event;
        const url = flag(rest, "--url");
        if (url) {
          body.targetType = "url";
          body.url = url;
        }
        const fn = flag(rest, "--function");
        if (fn) {
          body.targetType = "function";
          body.functionName = fn;
        }
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
        else
          printKeyValues({
            id: res.data.id,
            event: res.data.event,
            enabled: String(res.data.enabled),
          });
        return;
      }
      case "test": {
        const id = rest[0];
        if (!id) {
          process.stderr.write("auth-hooks test <id>\n");
          process.exit(1);
        }
        const res = await client.request<{
          ok: boolean;
          ms: number;
          error?: string;
          droppedClaims?: string[];
          verdict?: { allow?: boolean; reason?: string; claims?: Record<string, unknown>; handled?: boolean };
        }>("POST", `${BASE}/${encodeURIComponent(id)}/test`);
        if (json) {
          printJson(res);
          return;
        }
        if (!res.ok) {
          process.stderr.write(`unreachable after ${res.ms}ms: ${res.error ?? "unknown"}\n`);
          process.exit(1);
        }
        if (res.verdict?.allow === false) {
          process.stdout.write(
            `refused in ${res.ms}ms: ${res.verdict.reason ?? "(no reason given)"}\n`,
          );
        } else {
          process.stdout.write(`answered in ${res.ms}ms\n`);
        }
        if (res.verdict?.claims) {
          process.stdout.write(`claims: ${JSON.stringify(res.verdict.claims)}\n`);
        }
        // Named loudly: a dropped claim is silent at sign-in time, and this is
        // the only place it is ever reported.
        if (res.droppedClaims?.length) {
          process.stdout.write(
            `DROPPED as reserved (never reach the token): ${res.droppedClaims.join(", ")}\n`,
          );
        }
        return;
      }
      case "delete": {
        const id = rest[0];
        if (!id) {
          process.stderr.write("auth-hooks delete <id>\n");
          process.exit(1);
        }
        await client.request("DELETE", `${BASE}/${encodeURIComponent(id)}`);
        process.stderr.write(`Deleted auth hook ${id}.\n`);
        return;
      }
      default:
        process.stderr.write(HELP);
        process.exit(1);
    }
  } catch (e) {
    die(e, `auth-hooks ${sub}`);
  }
};
