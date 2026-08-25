/**
 * Rewrite `published-surface.json` to whatever `createClient()` exposes now,
 * stamped with the version in `package.json`.
 *
 * Run this after bumping the version for a release. The companion test refuses
 * a surface change that arrives without a bump, so this script is the second
 * half of that: the bump records the intent, this records what the intent
 * covers, and the diff shows a reviewer exactly which namespaces the release
 * is for.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "../src/index";

const dir = join(import.meta.dir, "..");
const version = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version as string;
const namespaces = Object.keys(createClient({ url: "" })).sort();

const out = `${JSON.stringify({ version, namespaces }, null, 2)}\n`;
writeFileSync(join(dir, "published-surface.json"), out);
console.log(`[surface] recorded ${namespaces.length} namespaces at ${version}`);
