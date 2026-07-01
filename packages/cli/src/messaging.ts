/**
 * `backlex messaging` — direct push/SMS dispatch over `/api/messaging/*` plus
 * the caller's device/phone registrations. Sends are dispatch-only (no in-app
 * notification row); admins may target any user, non-admins only themselves.
 */
import { BacklexError } from "backlex";
import {
  has,
  flag,
  makeClient,
  printJson,
  printKeyValues,
  printTable,
  resolveContext,
} from "./client";

const MESSAGING_HELP = `backlex messaging <send-push|send-sms|devices|phones>

  send-push --user <id> --title <t> --body <b> [--url <link>]
                                 push to a user's registered devices
  send-sms  --user <id> --body <b>
                                 SMS to a user's registered phone numbers
  devices                        the caller's registered push devices
  phones                         the caller's registered phone numbers
`;

const die = (e: unknown, what: string): never => {
  const msg = e instanceof BacklexError ? `${e.status} ${e.message}` : (e as Error).message;
  process.stderr.write(`${what}: ${msg}\n`);
  process.exit(1);
};

const need = (value: string | undefined, name: string): string => {
  if (!value) {
    process.stderr.write(`missing ${name}\n${MESSAGING_HELP}`);
    process.exit(1);
  }
  return value;
};

export const runMessaging = async (args: string[]): Promise<void> => {
  const sub = args[0];
  const rest = args.slice(1);
  const json = has(args, "--json");

  if (!sub || sub === "help" || sub === "--help") {
    process.stdout.write(MESSAGING_HELP);
    return;
  }

  const client = makeClient(resolveContext(args));
  try {
    switch (sub) {
      case "send-push": {
        const res = await client.messaging.sendPush({
          userId: need(flag(rest, "--user"), "--user"),
          title: need(flag(rest, "--title"), "--title"),
          body: need(flag(rest, "--body"), "--body"),
          url: flag(rest, "--url"),
        });
        if (json) printJson(res);
        else printKeyValues({ sent: String(res.sent), failed: String(res.failed) });
        return;
      }
      case "send-sms": {
        const res = await client.messaging.sendSms({
          userId: need(flag(rest, "--user"), "--user"),
          body: need(flag(rest, "--body"), "--body"),
        });
        if (json) printJson(res);
        else printKeyValues({ sent: String(res.sent), failed: String(res.failed) });
        return;
      }
      case "devices": {
        const { data } = await client.messaging.listDevices();
        if (json) printJson(data);
        else
          printTable(
            data.map((d) => ({
              id: d.id,
              platform: d.platform ?? "—",
              device: d.deviceName ?? "—",
              active: d.isActive ? "yes" : "no",
            })),
          );
        return;
      }
      case "phones": {
        const { data } = await client.messaging.listPhones();
        if (json) printJson(data);
        else
          printTable(
            data.map((p) => ({
              id: p.id,
              number: p.phoneNumber ?? "—",
              active: p.isActive ? "yes" : "no",
            })),
          );
        return;
      }
      default:
        process.stderr.write(`unknown subcommand: ${sub}\n${MESSAGING_HELP}`);
        process.exit(1);
    }
  } catch (e) {
    die(e, `messaging ${sub}`);
  }
};
