/**
 * `backlex permissions` — permission tooling over `/api/permissions`. The
 * `simulate` subcommand dry-runs the resolver for a subject against a
 * (collection, action) and prints the allow/deny decision plus the reasoning
 * trace. `--json` surfaces the full machine-readable result for scripting.
 */
import { BacklexError } from "backlex";
import type { PermissionSimulation } from "backlex";
import {
  flag,
  has,
  makeClient,
  printJson,
  printKeyValues,
  printTable,
  resolveContext,
  resolvePayload,
} from "./client";

const PERMISSIONS_HELP = `backlex permissions <simulate>

  simulate    dry-run the permission resolver and explain the decision
    --collection <slug>     collection slug or '*'           (required)
    --action <action>       read|create|update|delete|publish (required)
    --user <id>             existing user id to test as
    --roles <a,b,c>         ad-hoc role names (ignored with --user)
    --email <email>         override email for $user.email
    --plane <platform|app>  identity plane (default platform)
    --row <json|@file|->    sample row to test against the condition
    --json                  full JSON result
`;

const die = (e: unknown, what: string): never => {
  const msg = e instanceof BacklexError ? `${e.status} ${e.message}` : (e as Error).message;
  process.stderr.write(`${what}: ${msg}\n`);
  process.exit(1);
};

export const runPermissions = async (args: string[]): Promise<void> => {
  const sub = args[0];
  const rest = args.slice(1);
  const json = has(args, "--json");

  if (!sub || sub === "help" || sub === "--help") {
    process.stdout.write(PERMISSIONS_HELP);
    return;
  }

  if (sub !== "simulate") {
    process.stderr.write(`unknown subcommand: ${sub}\n${PERMISSIONS_HELP}`);
    process.exit(1);
  }

  const collection = flag(rest, "--collection");
  const action = flag(rest, "--action");
  if (!collection || !action) {
    process.stderr.write("permissions simulate --collection <slug> --action <action>\n");
    process.exit(1);
  }

  const rolesRaw = flag(rest, "--roles");
  const roles = rolesRaw
    ? rolesRaw.split(",").map((r) => r.trim()).filter(Boolean)
    : undefined;
  const rowRaw = flag(rest, "--row");
  let sampleRow: Record<string, unknown> | undefined;
  if (rowRaw) {
    try {
      sampleRow = JSON.parse(await resolvePayload(rowRaw)) as Record<string, unknown>;
    } catch (e) {
      die(e, "permissions simulate --row");
    }
  }

  const body = {
    collection,
    action,
    ...(flag(rest, "--user") ? { userId: flag(rest, "--user") } : {}),
    ...(roles ? { roles } : {}),
    ...(flag(rest, "--email") ? { email: flag(rest, "--email") } : {}),
    ...(flag(rest, "--plane") ? { plane: flag(rest, "--plane") } : {}),
    ...(sampleRow ? { sampleRow } : {}),
  };

  const client = makeClient(resolveContext(args));
  try {
    const { data } = await client.request<{ data: PermissionSimulation }>(
      "POST",
      "/api/permissions/simulate",
      body,
    );
    if (json) {
      printJson(data);
      return;
    }
    printKeyValues({
      decision: data.allowed ? "ALLOW" : "DENY",
      ...(data.isAdmin ? { admin: "yes (bypass)" } : {}),
      reason: data.reason,
      subject:
        data.subject.userId ?? (data.subject.roles.length ? data.subject.roles.join(", ") : "anonymous"),
      roles: data.roles.map((r) => r.name).join(", ") || "—",
      fields: data.fields ? data.fields.join(", ") : "all",
      ...(data.whereSql ? { where: data.whereSql.sql } : {}),
      ...(data.rowMatch === undefined ? {} : { rowMatch: data.rowMatch ? "yes" : "no" }),
    });
    if (data.matchedRules.length) {
      process.stdout.write("\nmatched rules:\n");
      printTable(
        data.matchedRules.map((r) => ({
          role: r.roleName,
          collection: r.collection,
          condition: r.condition ? JSON.stringify(r.condition) : "(none)",
          fields: r.fields ? r.fields.join(",") : "all",
          ...(r.rowMatch === undefined ? {} : { rowMatch: r.rowMatch ? "✓" : "✗" }),
        })),
      );
    }
  } catch (e) {
    die(e, "permissions simulate");
  }
};
