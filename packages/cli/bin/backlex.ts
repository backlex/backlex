#!/usr/bin/env node
import { runMigrate } from "../src/migrate";
import { runGenTypes } from "../src/gen-types";
import { runMcp } from "../src/mcp";
import { runLogin, runLogout, runWhoami, runProfile } from "../src/auth";
import { runCollections } from "../src/collections";
import { runItems } from "../src/items";
import { runBackup } from "../src/backup";
import { runUsers, runRoles, runFlags, runSettings } from "../src/admin";
import { runPermissions } from "../src/permissions";
import { runFunctions } from "../src/functions";
import { runFlows } from "../src/flows";
import { runDashboards } from "../src/dashboards";
import { runSchema } from "../src/schema";
import { runAgents } from "../src/agents";
import { runTemplates } from "../src/templates";
import { runWebhooks } from "../src/webhooks";
import { runJobs } from "../src/jobs";
import { runMessaging } from "../src/messaging";
import { runAdvisor } from "../src/advisor";
import { runTraces } from "../src/traces";
import { runGenOpenapi } from "../src/gen-openapi";
import { runInit } from "../src/init";
import { runSdk } from "../src/sdk";

const HELP = `backlex — self-hostable backend platform CLI

Connection (most commands; precedence: flag > env > saved profile):
  --url <url>        API base (default http://localhost:8787, env BACKLEX_URL)
  --key <pak_…>      API key (env BACKLEX_API_KEY); '-' reads from stdin
  --tenant <id>      scope to a tenant (slug or id), env BACKLEX_TENANT
  --profile <name>   use a named saved profile instead of the active one
  --json             machine-readable JSON output

Usage:
  backlex login [--url <url>] [--key <pak_…>|-] [--tenant <id>] [--profile <name>]
      Verify the key against /api/me and save it as a profile (default: "default").
      With no --key on a TTY, prompts without echoing.

  backlex logout [--profile <name>] [--all]
      Clear the saved credentials for a profile (--all removes the profile).

  backlex whoami [--profile <name>] [--json]
      Show the identity (user, roles, tenant) behind the resolved key.

  backlex profile <list|use|add|remove>
      list                              show all profiles (* = active)
      use <name>                        set the active profile
      add <name> --url <url> [--key …] [--tenant …]   add/replace a profile
      remove <name>                     delete a profile

  backlex collections <list|get|export-schema>
      Inspect the schema of the connected instance. \`list\` shows everything
      the key can reach. Run \`backlex collections\` for details.

  backlex items <list|get|create|update|delete|export|import|search> <slug>
      Data-plane CRUD + bulk export/import + search. Run \`backlex items\`
      for the per-command flags.

  backlex backup <list|now|download|restore|config>
      Logical backups + restore + schedule. \`restore\` requires --confirm.

  backlex users <list|grant|revoke>
      Workspace users + role assignment. \`grant <userId> admin\` replaces the
      manual user_roles SQL.

  backlex roles list
      Roles in the active workspace (ids to use with \`users grant\`).

  backlex permissions simulate --collection <slug> --action <action>
      Dry-run the permission resolver and explain the allow/deny decision.
      Test a real user (\`--user <id>\`) or ad-hoc roles (\`--roles a,b\`).

  backlex flags <list|set|delete>
      Feature flags / remote config. \`--global\` targets the global scope.

  backlex settings <get|set>
      Workspace settings (whitelisted keys).

  backlex functions <list|deploy|invoke|delete>
      Sandboxed JS functions. \`deploy <name> --file <path>\` is create-or-update.

  backlex flows <list|get|run|create|delete>
      Visual workflow builder (definitions as JSON).

  backlex dashboards <list|get|run|create|delete|share|revoke>
      Embedded BI dashboards. \`share <id>\` mints a public embed token.

  backlex schema <snapshots|capture|import|branches|create-branch|diff|apply|…>
      Migration diffing / schema branching. \`diff\`/\`apply\` take refs:
      live, snapshot:<id>, branch:<id>. \`apply --confirm-destructive\` for drops.

  backlex agents <list|get|create|update|delete|threads|run>
      AI agents. \`run <id> --message "…"\` runs a turn and prints the answer.

  backlex templates <list|apply>
      Schema-template catalog. \`apply <id>\` seeds collections + sample data.

  backlex webhooks <list|create|test|deliveries|retry|resume|delete>
      Outbound webhooks + delivery ops. \`resume\` re-enables an auto-disabled hook.

  backlex jobs <list|get|retry|cancel|remove|enqueue>
      Durable background job queue.

  backlex messaging <send-push|send-sms|devices|phones>
      Direct push/SMS dispatch + the caller's device/phone registrations.

  backlex advisor [--kind …] [--fail-on error|warn]
      Run security/performance checks. \`--fail-on\` makes it a CI gate.

  backlex traces <list|get>
      Inspect distributed-tracing spans (request traces + waterfalls).

  backlex init [dir] [--force]
      Scaffold a TypeScript consumer starter (backlex.ts + .env.example).

  backlex sdk [lang]
      Discover the official native client SDKs (install + quickstart).

  backlex migrate [db-path]
      Apply SQLite migrations to db-path (default: ./.data/backlex.sqlite,
      or $DATABASE_PATH if set).

  backlex gen-types <api-url> [--out <file>] [--key <pak_…>] [--sdk]
      Fetch /api/collections and emit a TypeScript module describing every
      collection. With --out, writes to disk; otherwise prints to stdout. Use
      --key to authenticate via API key. Add --sdk to also emit a typed client
      factory (createTypedClient), so db.collections.<slug>.list() is typed.

  backlex gen-openapi [--out <file>]
      Fetch the live OpenAPI spec (/api/openapi.json) for codegen / Postman.

  backlex mcp --url <mcp-url> --key <pak_…> [--tenant <id>]
      Run an MCP (Model Context Protocol) server over stdio that proxies to a
      remote backlex /mcp HTTP endpoint. Wire into Claude Desktop / Cursor as a
      stdio command. URL defaults to http://localhost:8787/mcp; key falls back
      to BACKLEX_API_KEY.

  backlex help
      Show this message.
`;

const args = process.argv.slice(2);
const cmd = args[0];
const rest = args.slice(1);

const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

const has = (name: string): boolean => args.includes(name);

const run = async () => {
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    process.stdout.write(HELP);
    return;
  }
  switch (cmd) {
    case "login":
      await runLogin(rest);
      return;
    case "logout":
      runLogout(rest);
      return;
    case "whoami":
      await runWhoami(rest);
      return;
    case "profile":
      runProfile(rest);
      return;
    case "collections":
    case "collection":
      await runCollections(rest);
      return;
    case "items":
    case "item":
      await runItems(rest);
      return;
    case "backup":
    case "backups":
      await runBackup(rest);
      return;
    case "users":
    case "user":
      await runUsers(rest);
      return;
    case "roles":
    case "role":
      await runRoles(rest);
      return;
    case "permissions":
    case "permission":
    case "perms":
      await runPermissions(rest);
      return;
    case "flags":
    case "flag":
      await runFlags(rest);
      return;
    case "settings":
      await runSettings(rest);
      return;
    case "functions":
    case "function":
    case "fn":
      await runFunctions(rest);
      return;
    case "flows":
    case "flow":
      await runFlows(rest);
      return;
    case "dashboards":
    case "dashboard":
      await runDashboards(rest);
      return;
    case "schema":
      await runSchema(rest);
      return;
    case "agents":
    case "agent":
      await runAgents(rest);
      return;
    case "templates":
    case "template":
      await runTemplates(rest);
      return;
    case "webhooks":
    case "webhook":
      await runWebhooks(rest);
      return;
    case "jobs":
    case "job":
      await runJobs(rest);
      return;
    case "messaging":
    case "msg":
      await runMessaging(rest);
      return;
    case "advisor":
      await runAdvisor(rest);
      return;
    case "traces":
    case "trace":
      await runTraces(rest);
      return;
    case "init":
      runInit(rest);
      return;
    case "sdk":
    case "sdks":
      runSdk(rest);
      return;
    case "gen-openapi":
      await runGenOpenapi(rest);
      return;
    case "migrate": {
      const dbPath = rest[0] && !rest[0].startsWith("-") ? rest[0] : undefined;
      await runMigrate(dbPath);
      return;
    }
    case "gen-types": {
      const url = rest[0];
      if (!url) {
        console.error("backlex gen-types <api-url> — url required");
        process.exit(1);
      }
      await runGenTypes(url, flag("--out"), flag("--key"), has("--sdk"));
      return;
    }
    case "mcp":
      await runMcp({ url: flag("--url"), key: flag("--key"), tenant: flag("--tenant") });
      return;
    default:
      console.error(`unknown command: ${cmd}`);
      console.error(HELP);
      process.exit(1);
  }
};

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
