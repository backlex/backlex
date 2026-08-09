/**
 * `backlex webhooks` — outbound webhook config + delivery ops over
 * `/api/webhooks`. `resume` re-enables a hook the auto-disable circuit breaker
 * turned off (15 consecutive failures) by PATCHing `active: true`. See
 * `docs/webhooks.md`.
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

interface WebhookRow {
  id: string;
  name: string;
  url: string;
  events: string[];
  active: boolean;
  disabledReason?: string | null;
}

const WEBHOOKS_HELP = `backlex webhooks <list|create|test|deliveries|retry|resume|delete>

  list                          all webhooks
  create --name <n> --url <u> --events a,b [--secret <s>] [--inactive]
                                [--fields id,status]  send only these keys
  create --data <json|@file|->  full payload (for headers etc.)
  test <id>                     fire a test delivery
  deliveries [--limit N]        recent deliveries
  retry <deliveryId>            retry a failed delivery
  resume <id>                   re-enable an auto-disabled webhook
  delete <id>
`;

const BASE = "/api/webhooks";

const die = (e: unknown, what: string): never => {
  const msg = e instanceof BacklexError ? `${e.status} ${e.message}` : (e as Error).message;
  process.stderr.write(`${what}: ${msg}\n`);
  process.exit(1);
};

const csv = (v: string | undefined): string[] =>
  (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

export const runWebhooks = async (args: string[]): Promise<void> => {
  const sub = args[0];
  const rest = args.slice(1);
  const json = has(args, "--json");

  if (!sub || sub === "help" || sub === "--help") {
    process.stdout.write(WEBHOOKS_HELP);
    return;
  }

  const client = makeClient(resolveContext(args));
  try {
    switch (sub) {
      case "list": {
        const { data } = await client.request<{ data: WebhookRow[] }>("GET", BASE);
        if (json) printJson(data);
        else
          printTable(
            data.map((w) => ({
              id: w.id,
              name: w.name,
              url: w.url,
              events: w.events.join(", "),
              active: w.active ? "yes" : `no (${w.disabledReason ?? "manual"})`,
            })),
          );
        return;
      }
      case "create": {
        const dataFlag = flag(rest, "--data");
        const body = dataFlag
          ? (JSON.parse(await resolvePayload(dataFlag)) as Record<string, unknown>)
          : {
              name: flag(rest, "--name"),
              url: flag(rest, "--url"),
              events: csv(flag(rest, "--events")),
              // Omitted entirely when the flag is absent, so the server keeps
              // its "whole row" default rather than being handed an empty
              // allow-list that would send nothing.
              ...(flag(rest, "--fields")
                ? { payloadFields: csv(flag(rest, "--fields")) }
                : {}),
              secret: flag(rest, "--secret"),
              active: !has(rest, "--inactive"),
            };
        if (!body.name || !body.url) {
          process.stderr.write("webhooks create --name <n> --url <u> --events a,b\n");
          process.exit(1);
        }
        const res = await client.request<{ data: WebhookRow }>("POST", BASE, body);
        if (json) printJson(res.data);
        else printKeyValues({ id: res.data.id, name: res.data.name, url: res.data.url });
        return;
      }
      case "test": {
        const id = rest[0];
        if (!id) {
          process.stderr.write("webhooks test <id>\n");
          process.exit(1);
        }
        const res = await client.request<unknown>("POST", `${BASE}/${encodeURIComponent(id)}/test`);
        printJson(res);
        return;
      }
      case "deliveries": {
        const limit = flag(rest, "--limit");
        const path = `${BASE}/_deliveries${limit ? `?limit=${Number(limit)}` : ""}`;
        const { data } = await client.request<{ data: Record<string, unknown>[] }>("GET", path);
        if (json) printJson(data);
        else printTable(data);
        return;
      }
      case "retry": {
        const id = rest[0];
        if (!id) {
          process.stderr.write("webhooks retry <deliveryId>\n");
          process.exit(1);
        }
        await client.request("POST", `${BASE}/_deliveries/${encodeURIComponent(id)}/retry`);
        process.stderr.write(`Retried delivery ${id}.\n`);
        return;
      }
      case "resume": {
        const id = rest[0];
        if (!id) {
          process.stderr.write("webhooks resume <id>\n");
          process.exit(1);
        }
        await client.request("PATCH", `${BASE}/${encodeURIComponent(id)}`, { active: true });
        process.stderr.write(`Resumed webhook ${id}.\n`);
        return;
      }
      case "delete": {
        const id = rest[0];
        if (!id) {
          process.stderr.write("webhooks delete <id>\n");
          process.exit(1);
        }
        await client.request("DELETE", `${BASE}/${encodeURIComponent(id)}`);
        process.stderr.write(`Deleted webhook ${id}.\n`);
        return;
      }
      default:
        process.stderr.write(`unknown webhooks subcommand: ${sub}\n\n${WEBHOOKS_HELP}`);
        process.exit(1);
    }
  } catch (e) {
    die(e, `webhooks ${sub}`);
  }
};
