/**
 * `backlex cdc` — the changefeed, delivered somewhere. See `docs/cdc.md`.
 *
 * `run` is the command to reach for when a sink looks stuck: it advances one
 * page through the same code the cron does and prints the delivery error,
 * which is the difference between "the destination is refusing it" and "there
 * is nothing to send".
 */
import { BacklexError } from "backlex";
import { flag, has, makeClient, printJson, printKeyValues, printTable, resolveContext } from "./client";

interface SinkRow {
  id: string;
  name: string;
  collection: string;
  destination: string;
  enabled: boolean;
  cursor: string | null;
  lastRunAt: number | null;
  lastError: string | null;
  consecutiveFailures: number;
  disabledReason: string | null;
}

const HELP = `backlex cdc <list|create|update|run|delete>

  list
  create --name <n> --collection <slug>
         (--url <https://…> [--secret <whsec_…>] | --storage [--prefix <p>])
         [--shape '<json filter>'] [--fields a,b] [--batch <n>]
  update <id> [--url …] [--secret …] [--shape …] [--batch <n>]
              [--enable|--disable] [--reset-cursor]
  run <id>                      advance one page now, print what it delivered
  delete <id>

  A sink replays the collection from the beginning and catches up one page per
  cron tick. Delivery is AT-LEAST-ONCE: the cursor advances only after a batch
  is acknowledged, so a retry re-sends it — every record carries a stable
  \`key\` for the destination to deduplicate on.

  A delete arrives as \`op: "delete"\`, not as an absence. That is the whole
  reason this reads the changefeed instead of selecting rows by updated_at.

  --shape narrows what is replicated; it is the ONLY narrowing knob, because a
  sink reads unconditionally rather than through anybody's permissions.

  --reset-cursor replays from the beginning. It is the one flag here that can
  flood a destination.
`;

const BASE = "/api/admin/cdc-sinks";

const die = (e: unknown, what: string): never => {
  const msg = e instanceof BacklexError ? `${e.status} ${e.message}` : (e as Error).message;
  process.stderr.write(`${what}: ${msg}\n`);
  process.exit(1);
};

export const runCdc = async (args: string[]): Promise<void> => {
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
        const { data } = await client.request<{ data: SinkRow[] }>("GET", BASE);
        if (json) printJson(data);
        else
          printTable(
            data.map((s) => ({
              id: s.id,
              name: s.name,
              collection: s.collection,
              to: s.destination,
              "caught up": s.cursor ? "yes" : "from the start",
              status: s.enabled
                ? s.consecutiveFailures
                  ? `on (${s.consecutiveFailures} failing)`
                  : "on"
                : `off (${s.disabledReason ?? "manual"})`,
              "last error": (s.lastError ?? "").slice(0, 40),
            })),
          );
        return;
      }
      case "create": {
        const name = flag(rest, "--name");
        const collection = flag(rest, "--collection");
        if (!name || !collection) {
          process.stderr.write("cdc create --name <n> --collection <slug>\n");
          process.exit(1);
        }
        const storage = has(rest, "--storage");
        const url = flag(rest, "--url");
        if (!storage && !url) {
          process.stderr.write("cdc create needs --url <https://…> or --storage\n");
          process.exit(1);
        }
        const config: Record<string, unknown> = storage
          ? { ...(flag(rest, "--prefix") ? { prefix: flag(rest, "--prefix") } : {}) }
          : { url, ...(flag(rest, "--secret") ? { secret: flag(rest, "--secret") } : {}) };
        const body: Record<string, unknown> = {
          name,
          collection,
          destination: storage ? "storage" : "webhook",
          config,
        };
        const shape = flag(rest, "--shape");
        if (shape) body.shape = shape;
        const fields = flag(rest, "--fields");
        if (fields) body.fields = fields;
        const batch = flag(rest, "--batch");
        if (batch) body.batchSize = Number(batch);
        const res = await client.request<{ data: SinkRow }>("POST", BASE, body);
        if (json) printJson(res.data);
        else
          printKeyValues({
            id: res.data.id,
            collection: res.data.collection,
            to: res.data.destination,
          });
        return;
      }
      case "update": {
        const id = rest[0];
        if (!id) {
          process.stderr.write("cdc update <id> …\n");
          process.exit(1);
        }
        const body: Record<string, unknown> = {};
        const url = flag(rest, "--url");
        const secret = flag(rest, "--secret");
        if (url || secret) {
          body.config = { ...(url ? { url } : {}), ...(secret ? { secret } : {}) };
        }
        const shape = flag(rest, "--shape");
        if (shape) body.shape = shape;
        const batch = flag(rest, "--batch");
        if (batch) body.batchSize = Number(batch);
        if (has(rest, "--enable")) body.enabled = true;
        if (has(rest, "--disable")) body.enabled = false;
        if (has(rest, "--reset-cursor")) body.resetCursor = true;
        const res = await client.request<{ data: SinkRow }>(
          "PATCH",
          `${BASE}/${encodeURIComponent(id)}`,
          body,
        );
        if (json) printJson(res.data);
        else process.stdout.write(`updated ${res.data.name}\n`);
        return;
      }
      case "run": {
        const id = rest[0];
        if (!id) {
          process.stderr.write("cdc run <id>\n");
          process.exit(1);
        }
        const res = await client.request<{
          delivered: number;
          hasMore: boolean;
          error?: string;
        }>("POST", `${BASE}/${encodeURIComponent(id)}/run`, {});
        if (json) {
          printJson(res);
          return;
        }
        if (res.error) {
          // The cursor did NOT advance — the same batch is retried next tick.
          process.stdout.write(`delivery failed: ${res.error}\nthe batch will be retried\n`);
          return;
        }
        process.stdout.write(
          `delivered ${res.delivered}${res.hasMore ? " — more to come" : " — caught up"}\n`,
        );
        return;
      }
      case "delete": {
        const id = rest[0];
        if (!id) {
          process.stderr.write("cdc delete <id>\n");
          process.exit(1);
        }
        await client.request("DELETE", `${BASE}/${encodeURIComponent(id)}`);
        process.stdout.write("deleted\n");
        return;
      }
      default:
        process.stdout.write(HELP);
    }
  } catch (e) {
    die(e, `cdc ${sub}`);
  }
};
