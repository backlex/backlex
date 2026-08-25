/**
 * Rewrite `published-surface.json` from the CLI's own help text, stamped with
 * the version in `package.json`. Run after bumping for a release — the
 * companion test refuses a command-list change that arrives without a bump.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HELP } from "../src/help";

const dir = join(import.meta.dir, "..");
const version = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version as string;
const commands = [...new Set([...HELP.matchAll(/^ {2}backlex ([a-z][a-z0-9-]*)/gm)].map((m) => m[1]))].sort();

writeFileSync(join(dir, "published-surface.json"), `${JSON.stringify({ version, commands }, null, 2)}\n`);
console.log(`[surface] recorded ${commands.length} commands at ${version}`);
