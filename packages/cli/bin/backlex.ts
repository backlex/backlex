#!/usr/bin/env node
import { HELP } from "../src/help";
import { runMigrate } from "../src/migrate";
import { runGenTypes } from "../src/gen-types";
import { runMcp } from "../src/mcp";
import { runLogin, runLogout, runWhoami, runProfile } from "../src/auth";
import { runCollections } from "../src/collections";
import { runItems } from "../src/items";
import { runBackup } from "../src/backup";
import { runUsers, runRoles, runFlags, runSettings } from "../src/admin";
import { runPermissions } from "../src/permissions";
import { runOrgs } from "../src/orgs";
import { runFunctions } from "../src/functions";
import { runExtensions } from "../src/extensions";
import { runFlows } from "../src/flows";
import { runDashboards } from "../src/dashboards";
import { runKpis } from "../src/kpis";
import { runAnalytics } from "../src/analytics";
import { runConsent } from "../src/consent";
import { runForms } from "../src/forms";
import { runUsage } from "../src/usage";
import { runSchema } from "../src/schema";
import { runAgents } from "../src/agents";
import { runTemplates } from "../src/templates";
import { runPayments } from "../src/payments";
import { runWebhooks } from "../src/webhooks";
import { runIntegrations } from "../src/integrations";
import { runSyncHooks } from "../src/sync-hooks";
import { runAuthHooks } from "../src/auth-hooks";
import { runChannels } from "../src/channels";
import { runRls } from "../src/rls";
import { runS3 } from "../src/s3";
import { runSupport } from "../src/support";
import { runSigningKeys } from "../src/signing-keys";
import { runOAuth } from "../src/oauth";
import { runCdc } from "../src/cdc";
import { runDocuments } from "../src/documents";
import { runApprovals } from "../src/approvals";
import { runSignatures } from "../src/signatures";
import { runBooking } from "../src/booking";
import { runJobs } from "../src/jobs";
import { runMessaging } from "../src/messaging";
import { runAdvisor } from "../src/advisor";
import { runTraces } from "../src/traces";
import { runGenOpenapi } from "../src/gen-openapi";
import { runInit } from "../src/init";
import { runSdk } from "../src/sdk";
import { runImportDb } from "../src/import-db";


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
    case "orgs":
    case "org":
      await runOrgs(rest);
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
    case "extensions":
    case "extension":
    case "ext":
      await runExtensions(rest);
      return;
    case "dashboards":
    case "dashboard":
      await runDashboards(rest);
      return;
    case "kpis":
    case "kpi":
      await runKpis(rest);
      return;
    case "analytics":
      await runAnalytics(rest);
      return;
    case "consent":
      await runConsent(rest);
      return;
    case "forms":
    case "form":
      await runForms(rest);
      return;
    case "usage":
      await runUsage(rest);
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
    case "integrations":
    case "integration":
      await runIntegrations(rest);
      return;
    case "sync-hooks":
    case "sync-hook":
      await runSyncHooks(rest);
      return;
    case "auth-hooks":
    case "auth-hook":
      await runAuthHooks(rest);
      return;
    case "channels":
    case "channel":
      await runChannels(rest);
      return;
    case "rls":
      await runRls(rest);
      return;
    case "s3":
      await runS3(rest);
      return;
    case "support":
      await runSupport(rest);
      return;
    case "signing-keys":
    case "signing-key":
      await runSigningKeys(rest);
      return;
    case "oauth":
      await runOAuth(rest);
      return;
    case "cdc":
      await runCdc(rest);
      return;
    case "documents":
    case "document":
      await runDocuments(rest);
      return;
    case "signatures":
    case "signature":
      await runSignatures(rest);
      return;
    case "approvals":
    case "approval":
      await runApprovals(rest);
      return;
    case "booking":
    case "bookings":
      await runBooking(rest);
      return;
    case "payments":
    case "payment":
      await runPayments(rest);
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
    case "import-db":
      await runImportDb(rest);
      return;
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
