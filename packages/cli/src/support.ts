/**
 * `backlex support` — the captcha in front of your public auth endpoints, and
 * audited impersonation of an end-user. See `docs/captcha.md` and
 * `docs/impersonation.md`.
 *
 * `impersonate` prints a working credential for somebody else's account. It is
 * read-only unless asked otherwise, expires on its own, and is recorded with
 * the reason you give — which is the part that makes it reviewable.
 */
import { BacklexError } from "backlex";
import { has, flag, makeClient, printJson, printKeyValues, printTable, resolveContext } from "./client";

const HELP = `backlex support <captcha|impersonate|impersonations|end>

  captcha show
  captcha set --provider <turnstile|hcaptcha|recaptcha>
              --site-key <k> [--secret <k>]
              --protect <sign-up,sign-in,password-reset,forms>
              --on-error <deny|allow>
  captcha remove

  impersonate <appUserId> --reason "<why>" [--write] [--minutes <n>]
  impersonations [--active]
  end <impersonationId>

  --on-error is REQUIRED and has no safe default:
    deny   refuse the request when the captcha provider cannot answer
    allow  let it through unverified — the gate then stops working exactly
           when the provider is having a bad day, which an attacker can arrange

  An impersonation is READ-ONLY unless you pass --write, capped at 60 minutes,
  and every request its token authenticates re-reads the audit row — so \`end\`
  takes effect immediately rather than when the token would have expired.
`;

const CAPTCHA = "/api/admin/captcha";
const IMP = "/api/admin/impersonation";

const die = (e: unknown, what: string): never => {
  const msg = e instanceof BacklexError ? `${e.status} ${e.message}` : (e as Error).message;
  process.stderr.write(`${what}: ${msg}\n`);
  process.exit(1);
};

export const runSupport = async (args: string[]): Promise<void> => {
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
      case "captcha": {
        const verb = rest[0] ?? "show";
        if (verb === "show") {
          const res = await client.request<{ data: Record<string, unknown> }>("GET", CAPTCHA);
          if (json) printJson(res.data);
          else printKeyValues(res.data as Record<string, unknown>);
          return;
        }
        if (verb === "remove") {
          await client.request("DELETE", CAPTCHA);
          process.stdout.write("removed\n");
          return;
        }
        if (verb !== "set") {
          process.stdout.write(HELP);
          return;
        }
        const provider = flag(rest, "--provider");
        const siteKey = flag(rest, "--site-key");
        const onError = flag(rest, "--on-error");
        if (!provider || !siteKey) {
          process.stderr.write("support captcha set --provider <p> --site-key <k>\n");
          process.exit(1);
        }
        if (onError !== "deny" && onError !== "allow") {
          process.stderr.write(
            "support captcha set --on-error <deny|allow> is required — neither answer is safe to assume.\n",
          );
          process.exit(1);
        }
        const protect = (flag(rest, "--protect") ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        const body: Record<string, unknown> = { provider, siteKey, protect, onError };
        const secret = flag(rest, "--secret");
        if (secret) body.secretKey = secret;
        const res = await client.request<{ data: Record<string, unknown> }>("PUT", CAPTCHA, body);
        if (json) printJson(res.data);
        else printKeyValues(res.data as Record<string, unknown>);
        return;
      }
      case "impersonate": {
        const subjectUserId = rest[0];
        const reason = flag(rest, "--reason");
        if (!subjectUserId || !reason) {
          process.stderr.write('support impersonate <appUserId> --reason "<why>"\n');
          process.exit(1);
        }
        const body: Record<string, unknown> = { subjectUserId, reason };
        if (has(rest, "--write")) body.readOnly = false;
        const minutes = flag(rest, "--minutes");
        if (minutes) body.minutes = Number(minutes);
        const res = await client.request<{
          data: { id: string; subjectEmail: string | null; readOnly: boolean; expiresAt: number };
          token: string;
        }>("POST", IMP, body);
        if (json) {
          printJson(res);
          return;
        }
        printKeyValues({
          id: res.data.id,
          "acting as": res.data.subjectEmail ?? subjectUserId,
          mode: res.data.readOnly ? "read-only" : "read-write",
          expires: new Date(res.data.expiresAt).toISOString(),
          token: res.token,
        });
        process.stdout.write(
          "\nSend it as `Authorization: Bearer …`. It is a working credential for\n" +
            "somebody else's account — `backlex support end <id>` stops it immediately.\n",
        );
        return;
      }
      case "impersonations": {
        const q = has(rest, "--active") ? "?activeOnly=true" : "";
        const { data } = await client.request<{
          data: Array<{
            id: string;
            actorEmail: string | null;
            subjectEmail: string | null;
            reason: string;
            readOnly: boolean;
            active: boolean;
            createdAt: number | null;
          }>;
        }>("GET", `${IMP}${q}`);
        if (json) printJson(data);
        else
          printTable(
            data.map((r) => ({
              id: r.id,
              operator: r.actorEmail ?? "—",
              "acting as": r.subjectEmail ?? "—",
              mode: r.readOnly ? "read-only" : "read-write",
              status: r.active ? "live" : "ended",
              when: r.createdAt ? new Date(r.createdAt).toISOString() : "—",
              why: r.reason,
            })),
          );
        return;
      }
      case "end": {
        const id = rest[0];
        if (!id) {
          process.stderr.write("support end <impersonationId>\n");
          process.exit(1);
        }
        await client.request("POST", `${IMP}/${encodeURIComponent(id)}/end`, {});
        process.stdout.write("ended\n");
        return;
      }
      default:
        process.stdout.write(HELP);
    }
  } catch (e) {
    die(e, `support ${sub}`);
  }
};
