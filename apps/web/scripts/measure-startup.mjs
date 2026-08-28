/**
 * What the Cloudflare Worker costs before it can answer anything.
 *
 * Cloudflare rejects a deploy whose script spends too long on startup — error
 * 10021, `Script startup exceeded CPU time limit` — and that budget covers V8
 * compiling the eager module graph plus running every module's top-level code.
 * It is not a soft signal: the deploy fails outright. This worker has been
 * living close enough to the line to fail intermittently, so the number needs
 * to be measurable rather than argued about.
 *
 *     bun run --cwd apps/web build      # or `bun run build` from the root
 *     node apps/web/scripts/measure-startup.mjs
 *
 * Deliberately run on **node, not bun**: workerd is V8, and so is node, so its
 * compile and top-level-eval costs are the ones that transfer. Bun is JSC and
 * would rank the same graph differently. The absolute milliseconds are still
 * this machine's, not Cloudflare's — a deploy there has measured roughly 2-3x
 * this figure. Treat it as the thing you move, not as the thing CF will report.
 *
 * `--profile` writes a `.cpuprofile` next to the bundle and prints self-time by
 * chunk, which is how you find out whether a number is compile (bytes) or
 * top-level execution (what a module DOES when loaded) — the two have opposite
 * fixes. Note the loader-hook frames in that profile (`hooks`, `makeSyncRequest`)
 * are this harness, not the worker; discount them.
 */
import { register } from "node:module";
import { mkdtempSync, readFileSync, statSync, writeFileSync, writeSync } from "node:fs";
import { dirname, resolve as resolvePath, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { Session } from "node:inspector/promises";

const here = dirname(fileURLToPath(import.meta.url));
const ENTRY = resolvePath(here, "../dist/backlex_admin/index.js");
const PROFILE = process.argv.includes("--profile");

try {
  statSync(ENTRY);
} catch {
  console.error(`No worker bundle at ${ENTRY}\nRun \`bun run build\` from the repo root first.`);
  process.exit(1);
}

/**
 * The eager graph: every module reachable from the entry through STATIC imports.
 * `import()` edges are skipped on purpose — that is exactly the line between
 * what the isolate pays for at startup and what it defers to a request.
 */
const eager = () => {
  const seen = new Set();
  let bytes = 0;
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    let src;
    try {
      src = readFileSync(file, "utf8");
    } catch {
      return;
    }
    bytes += statSync(file).size;
    const statics = /(?:^|\n)\s*(?:import|export)[^\n;]*?from\s*"([^"]+)"/g;
    const bare = /(?:^|\n)\s*import\s*"([^"]+)"/g;
    for (const m of [...src.matchAll(statics), ...src.matchAll(bare)]) {
      if (m[1].startsWith(".")) walk(resolvePath(dirname(file), m[1]));
    }
  };
  walk(ENTRY);
  return { modules: seen.size, bytes };
};

register(pathToFileURL(join(here, "startup-hooks.mjs")).href, import.meta.url);

// The bundle installs its own `console` and `process` shims, so capture the
// clock and the writer BEFORE importing it — measuring with a clock the thing
// under test has replaced is how you get a timestamp instead of a duration.
const now = performance.now.bind(performance);
globalThis.WebSocketPair = function () {};
globalThis.caches ??= { default: { match: async () => undefined, put: async () => {} } };

let session;
if (PROFILE) {
  session = new Session();
  session.connect();
  await session.post("Profiler.enable");
  await session.post("Profiler.start");
}

const started = now();
await import(pathToFileURL(ENTRY).href);
const ms = now() - started;

const { modules, bytes } = eager();
const out = [
  `eager graph        ${modules} modules, ${(bytes / 1024).toFixed(0)} KiB`,
  `compile + top-level ${ms.toFixed(1)} ms  (this machine's V8, not Cloudflare's)`,
];

if (session) {
  const { profile } = await session.post("Profiler.stop");
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map();
  for (let i = 0; i < profile.samples.length; i++) {
    const id = profile.samples[i];
    self.set(id, (self.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0));
  }
  const byChunk = new Map();
  for (const [id, us] of self) {
    const node = byId.get(id);
    if (!node) continue;
    const key = (node.callFrame.url || "(engine)").replace(/.*\//, "") || "(engine)";
    byChunk.set(key, (byChunk.get(key) ?? 0) + us);
  }
  out.push("", "self time by chunk (harness frames — hooks/makeSyncRequest — are not the worker):");
  for (const [k, us] of [...byChunk].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    out.push(`  ${(us / 1000).toFixed(1).padStart(7)} ms  ${k}`);
  }
  const file = join(mkdtempSync(join(tmpdir(), "backlex-startup-")), "startup.cpuprofile");
  writeFileSync(file, JSON.stringify(profile));
  out.push("", `full profile: ${file}`);
}

writeSync(1, out.join("\n") + "\n");
