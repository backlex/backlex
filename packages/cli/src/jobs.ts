/**
 * `backlex jobs` — the durable background job queue. Wraps the SDK's
 * `client.jobs` (so it shares the queue/retry/DLQ semantics in `docs/jobs.md`)
 * rather than hand-rolling the endpoints.
 */
import { BacklexError, type JobStatus } from "backlex";
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

const JOBS_HELP = `backlex jobs <list|get|retry|cancel|remove|enqueue>

  list [--queue <q>] [--status <s>] [--limit N]
  get <id> [--watch]            --watch polls until the job finishes, printing progress
  retry <id>                    requeue a failed / dead-lettered job
  cancel <id>                   cancel a pending job
  remove <id>                   delete a job row
  enqueue --type function|webhook.deliver [--payload <json|@file|->] [--queue <q>] [--run-at <iso>]
`;

const die = (e: unknown, what: string): never => {
  const msg = e instanceof BacklexError ? `${e.status} ${e.message}` : (e as Error).message;
  process.stderr.write(`${what}: ${msg}\n`);
  process.exit(1);
};

export const runJobs = async (args: string[]): Promise<void> => {
  const sub = args[0];
  const rest = args.slice(1);
  const json = has(args, "--json");

  if (!sub || sub === "help" || sub === "--help") {
    process.stdout.write(JOBS_HELP);
    return;
  }

  const client = makeClient(resolveContext(args));
  try {
    switch (sub) {
      case "list": {
        const limit = flag(rest, "--limit");
        const { jobs } = await client.jobs.list({
          queue: flag(rest, "--queue"),
          status: flag(rest, "--status") as JobStatus | undefined,
          limit: limit ? Number(limit) : undefined,
        });
        if (json) printJson(jobs);
        else printTable(jobs as unknown as Record<string, unknown>[]);
        return;
      }
      case "get": {
        const id = rest[0];
        if (!id) {
          process.stderr.write("jobs get <id>\n");
          process.exit(1);
        }
        // `--watch` is what makes `?async=1` usable from a script: kick a
        // backup or a reindex off, then block here until it lands. Progress
        // goes to stderr so `--json --watch` still pipes a clean final row.
        const job = has(rest, "--watch")
          ? await client.jobs.waitFor(id, {
              onProgress: (p) => {
                const of = p.total == null ? "" : `/${p.total}`;
                const where = [p.phase, p.note].filter(Boolean).join(" ");
                process.stderr.write(`  ${p.done}${of}${where ? ` — ${where}` : ""}\n`);
              },
            })
          : await client.jobs.get(id);
        if (json) printJson(job);
        else printKeyValues(job as unknown as Record<string, unknown>);
        // A watched job that dead-lettered is a failed command, not a
        // successful report of a failure — a CI step has to be able to tell.
        if (has(rest, "--watch") && job.status !== "succeeded") {
          process.stderr.write(`job ${id} ${job.status}${job.lastError ? `: ${job.lastError}` : ""}\n`);
          process.exit(1);
        }
        return;
      }
      case "retry":
      case "cancel":
      case "remove": {
        const id = rest[0];
        if (!id) {
          process.stderr.write(`jobs ${sub} <id>\n`);
          process.exit(1);
        }
        const fn = sub === "retry" ? client.jobs.retry : sub === "cancel" ? client.jobs.cancel : client.jobs.remove;
        const res = await fn(id);
        if (json) printJson(res);
        else process.stderr.write(`${sub}: ${res.ok ? "ok" : "failed"} (${id})\n`);
        return;
      }
      case "enqueue": {
        const typeRaw = flag(rest, "--type");
        if (typeRaw !== "function" && typeRaw !== "webhook.deliver") {
          process.stderr.write("jobs enqueue --type function|webhook.deliver [--payload <json>]\n");
          process.exit(1);
        }
        const payloadFlag = flag(rest, "--payload");
        const payload = payloadFlag
          ? (JSON.parse(await resolvePayload(payloadFlag)) as Record<string, unknown>)
          : undefined;
        const res = await client.jobs.enqueue({
          type: typeRaw,
          payload,
          queue: flag(rest, "--queue"),
          runAt: flag(rest, "--run-at"),
        });
        if (json) printJson(res);
        else process.stderr.write(`Enqueued job ${res.id}.\n`);
        return;
      }
      default:
        process.stderr.write(`unknown jobs subcommand: ${sub}\n\n${JOBS_HELP}`);
        process.exit(1);
    }
  } catch (e) {
    die(e, `jobs ${sub}`);
  }
};
