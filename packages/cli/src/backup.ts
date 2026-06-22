/**
 * `backlex backup` — logical backups + restore + schedule, over `/api/admin/db`.
 *
 * Backups are JSONL dumps (see `docs/backup-restore.md`). `restore` is
 * confirm-gated server-side (`X-Backlex-Confirm: yes`), so the CLI demands an
 * explicit `--confirm` before sending it — restore is additive but still writes
 * data, and a fat-fingered id shouldn't run silently.
 */
import { writeFileSync } from "node:fs";
import { BacklexError } from "backlex";
import {
  has,
  flag,
  authedFetch,
  makeClient,
  printJson,
  printKeyValues,
  printTable,
  resolveContext,
} from "./client";

const BACKUP_HELP = `backlex backup <list|now|download|restore|config>

  list                         all backups (newest first)
  now [--label <text>]         run a manual backup now
  download <id> [--out <file>] download a backup (JSONL); stdout if no --out
  restore <id> --confirm       restore a backup (additive; requires --confirm)
  config                       show the auto-backup schedule
  config --schedule <off|daily|weekly> [--retain <n>]   set the schedule
`;

const BASE = "/api/admin/db";

const die = (e: unknown, what: string): never => {
  const msg = e instanceof BacklexError ? `${e.status} ${e.message}` : (e as Error).message;
  process.stderr.write(`${what}: ${msg}\n`);
  process.exit(1);
};

export const runBackup = async (args: string[]): Promise<void> => {
  const sub = args[0];
  const rest = args.slice(1);
  const json = has(args, "--json");

  if (!sub || sub === "help" || sub === "--help") {
    process.stdout.write(BACKUP_HELP);
    return;
  }

  const ctx = resolveContext(args);
  const client = makeClient(ctx);

  try {
    switch (sub) {
      case "list": {
        const res = await client.request<{ data: Record<string, unknown>[] }>(
          "GET",
          `${BASE}/backups`,
        );
        if (json) printJson(res.data);
        else printTable(res.data);
        return;
      }
      case "now": {
        const label = flag(rest, "--label");
        const res = await client.request<{ data: Record<string, unknown> }>(
          "POST",
          `${BASE}/backups/now`,
          label ? { label } : {},
        );
        if (json) printJson(res.data);
        else printKeyValues(res.data);
        return;
      }
      case "download": {
        const id = rest[0];
        if (!id || id.startsWith("-")) {
          process.stderr.write("backup download <id> [--out <file>]\n");
          process.exit(1);
        }
        const r = await authedFetch(ctx, "GET", `${BASE}/backups/${encodeURIComponent(id)}/download`);
        if (!r.ok) throw new BacklexError(r.status, undefined);
        const body = await r.text();
        const outPath = flag(rest, "--out");
        if (outPath) {
          writeFileSync(outPath, body, "utf8");
          process.stderr.write(`✓ wrote backup ${id} → ${outPath}\n`);
        } else {
          process.stdout.write(body.endsWith("\n") ? body : `${body}\n`);
        }
        return;
      }
      case "restore": {
        const id = rest[0];
        if (!id || id.startsWith("-")) {
          process.stderr.write("backup restore <id> --confirm\n");
          process.exit(1);
        }
        if (!has(rest, "--confirm")) {
          process.stderr.write(
            `Refusing to restore ${id} without --confirm (this writes data).\n`,
          );
          process.exit(1);
        }
        const res = await client.request<{ data: Record<string, unknown> }>(
          "POST",
          `${BASE}/backups/${encodeURIComponent(id)}/restore`,
          undefined,
          { "x-backlex-confirm": "yes" },
        );
        if (json) printJson(res.data);
        else printKeyValues(res.data);
        return;
      }
      case "config": {
        const schedule = flag(rest, "--schedule");
        const retain = flag(rest, "--retain");
        if (schedule || retain) {
          const patch: Record<string, unknown> = {};
          if (schedule) patch.schedule = schedule;
          if (retain) patch.retain = Number(retain);
          const res = await client.request<{ data: Record<string, unknown> }>(
            "PUT",
            `${BASE}/backups/config`,
            patch,
          );
          if (json) printJson(res.data);
          else printKeyValues(res.data);
          return;
        }
        const res = await client.request<{ data: Record<string, unknown> }>(
          "GET",
          `${BASE}/backups/config`,
        );
        if (json) printJson(res.data);
        else printKeyValues(res.data);
        return;
      }
      default:
        process.stderr.write(`unknown backup subcommand: ${sub}\n\n${BACKUP_HELP}`);
        process.exit(1);
    }
  } catch (e) {
    die(e, `backup ${sub}`);
  }
};
