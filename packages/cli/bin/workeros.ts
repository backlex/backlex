#!/usr/bin/env bun
import { runMigrate } from "../src/migrate";
import { runGenTypes } from "../src/gen-types";

const HELP = `workeros — self-hostable backend platform CLI

Usage:
  workeros migrate [db-path]
      Apply SQLite migrations to db-path (default: ./.data/workeros.sqlite,
      or $DATABASE_PATH if set).

  workeros gen-types <api-url> [--out <file>] [--key <pak_...>]
      Fetch /api/collections from the given URL and emit a TypeScript
      module describing every collection. With --out, writes to disk;
      otherwise prints to stdout. Use --key to authenticate via API key.

  workeros help
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
      console.error("workeros gen-types <api-url> — url required");
      process.exit(1);
    }
    await runGenTypes(url, flag("--out"), flag("--key"));
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
