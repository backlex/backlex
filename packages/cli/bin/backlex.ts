#!/usr/bin/env bun
import { runMigrate } from "../src/migrate";
import { runGenTypes } from "../src/gen-types";
import { runMcp } from "../src/mcp";

const HELP = `backlex — self-hostable backend platform CLI

Usage:
  backlex migrate [db-path]
      Apply SQLite migrations to db-path (default: ./.data/workeros.sqlite,
      or $DATABASE_PATH if set).

  backlex gen-types <api-url> [--out <file>] [--key <pak_...>]
      Fetch /api/collections from the given URL and emit a TypeScript
      module describing every collection. With --out, writes to disk;
      otherwise prints to stdout. Use --key to authenticate via API key.

  backlex mcp --url <mcp-url> --key <pak_...> [--tenant <tenant-id>]
      Run an MCP (Model Context Protocol) server over stdio that proxies
      to a remote backlex /mcp HTTP endpoint. Wire into Claude Desktop /
      Cursor as a stdio command. URL defaults to http://localhost:8787/mcp;
      key falls back to WORKEROS_API_KEY env var.

  backlex help
      Show this message.
`;

const args = process.argv.slice(2);
const cmd = args[0];

const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

const run = async () => {
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    process.stdout.write(HELP);
    return;
  }
  if (cmd === "migrate") {
    const dbPath = args[1] && !args[1].startsWith("-") ? args[1] : undefined;
    await runMigrate(dbPath);
    return;
  }
  if (cmd === "gen-types") {
    const url = args[1];
    if (!url) {
      console.error("backlex gen-types <api-url> — url required");
      process.exit(1);
    }
    await runGenTypes(url, flag("--out"), flag("--key"));
    return;
  }
  if (cmd === "mcp") {
    await runMcp({
      url: flag("--url"),
      key: flag("--key"),
      tenant: flag("--tenant"),
    });
    return;
  }
  console.error(`unknown command: ${cmd}`);
  console.error(HELP);
  process.exit(1);
};

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
