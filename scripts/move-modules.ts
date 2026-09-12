/**
 * Move source files and rewrite every reference to them, in one pass.
 *
 *   bun scripts/move-modules.ts [--dry-run] <old>=<new> [<old>=<new> ...]
 *
 * Paths are repo-relative. A move is a `git mv`, so history follows the file.
 *
 * An import is the easy half. This repo refers to its own files by path in at
 * least four other shapes, and a move that only fixes imports leaves the
 * others pointing at nothing:
 *
 *   - relative strings that are not imports: `mock.module("../src/…")`,
 *     `new URL("../src/…", import.meta.url)`, `resolve(import.meta.dir, "…")`;
 *   - repo- or workspace-rooted strings: guard ledgers keyed by file
 *     (`scripts/scan-tenant-scope.ts`, `tests/list-pagination.test.ts`,
 *     `tests/ai-quota-gate.test.ts`), tests that `readFileSync` a source;
 *   - comments and docs that name a file (`services/x.ts::SYMBOL`);
 *   - a moved file's OWN relative imports, which change depth with it.
 *
 * So there are two rewrites. Relative strings in code are RESOLVED against the
 * tracked tree and re-emitted in the same style (with or without extension,
 * directory form for an `index.ts`) — a string that resolves to nothing moved
 * is left alone, so there is no guessing. Everything else is matched as a path
 * SUFFIX anchored on the last directory the old and new paths share, so
 * `services/tag-conditions` is found inside `apps/web/src/server/services/…`
 * and `src/server/services/…` alike, and `routes/tag-manager.ts` is never
 * mistaken for `services/tag-manager.ts`.
 *
 * A bare file name (`see tag-conditions.ts`) is rewritten only when what it
 * names is not in doubt — see the rule where it is applied.
 *
 * What it cannot see is reported, not assumed away: a moved file's relative
 * strings that resolve to nothing, template-literal paths built with `${}`,
 * and bare mentions it could not attribute to one file. A stale path does not
 * fail every guard loudly, so read that report before trusting a green run.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CODE = /\.(tsx?|mts|cts|m?js|cjs)$/;
const TEXT = /\.(tsx?|mts|cts|m?js|cjs|json|jsonc|md|mdx|ya?ml|toml|sh|astro|html)$/;
const SKIP = new Set(["bun.lock", "deno.lock", "THIRD-PARTY-LICENSES.md"]);

type Style = "exact" | "bare" | "dir" | "js";
type Edit = { start: number; end: number; text: string; kind: "relative" | "path" | "name" };

const git = (...args: string[]) => {
  // A large ls-files would overflow the 1 MB default and come back truncated
  // with an empty stderr — which reads exactly like a smaller tree.
  const r = spawnSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed (${r.status}): ${r.stderr}`);
  return r.stdout;
};

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const pairs = args.filter((a) => a !== "--dry-run");
if (pairs.length === 0) {
  console.error("usage: bun scripts/move-modules.ts [--dry-run] <old>=<new> ...");
  process.exit(2);
}

const tracked = new Set(git("ls-files", "-z").split("\0").filter(Boolean));
const moves = new Map<string, string>();
for (const pair of pairs) {
  const [from, to] = pair.split("=").map((p) => posix.normalize(p ?? ""));
  if (!from || !to || pair.split("=").length !== 2) throw new Error(`not <old>=<new>: ${pair}`);
  if (!tracked.has(from)) throw new Error(`not a tracked file: ${from}`);
  if (tracked.has(to) || [...moves.values()].includes(to)) throw new Error(`destination taken: ${to}`);
  moves.set(from, to);
}
const moved = new Set(moves.values());
const after = new Set([...tracked].filter((f) => !moves.has(f)).concat([...moved]));
const newPath = (f: string) => moves.get(f) ?? f;
const basenames = new Map<string, number>();
for (const f of tracked) basenames.set(posix.basename(f), (basenames.get(posix.basename(f)) ?? 0) + 1);

function resolveSpec(from: string, spec: string, files: Set<string>): { target: string; style: Style } | null {
  const base = posix.normalize(posix.join(posix.dirname(from), spec));
  if (base.startsWith("..")) return null;
  if (files.has(base)) return { target: base, style: "exact" };
  for (const ext of [".ts", ".tsx", ".d.ts", ".mts", ".js", ".mjs"]) {
    if (files.has(base + ext)) return { target: base + ext, style: "bare" };
  }
  if (base.endsWith(".js") && files.has(base.replace(/\.js$/, ".ts"))) {
    return { target: base.replace(/\.js$/, ".ts"), style: "js" };
  }
  for (const index of ["/index.ts", "/index.tsx"]) {
    if (files.has(base + index)) return { target: base + index, style: "dir" };
  }
  return null;
}

function emitSpec(from: string, target: string, style: Style): string {
  let spec = posix.relative(posix.dirname(from), target);
  if (!spec.startsWith(".")) spec = `./${spec}`;
  if (style === "exact") return spec;
  if (style === "js") return spec.replace(/\.tsx?$/, ".js");
  const bare = spec.replace(/(\.d)?\.(tsx?|mts|m?js)$/, "");
  const dir = bare.replace(/\/index$/, "");
  // Directory form only where it is unambiguous: never `.`/`..`, and only if a
  // same-named file beside the directory would not win the resolution.
  if (dir !== bare && dir !== "." && dir !== ".." && resolveSpec(from, dir, after)?.target === target) return dir;
  return bare;
}

const lineOf = (text: string, at: number) => text.slice(0, at).split("\n").length;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** One regex per move, for references that are not resolvable relative strings. */
const suffixRules = [...moves].map(([from, to]) => {
  const a = from.split("/");
  const b = to.split("/");
  let shared = 0;
  while (shared < Math.min(a.length, b.length) - 1 && a[shared] === b[shared]) shared++;
  const anchor = Math.max(0, shared - 1);
  const ext = posix.extname(from);
  const oldTok = a.slice(anchor).join("/").slice(0, -ext.length);
  const newExt = posix.extname(to);
  const newTok = b.slice(anchor).join("/").slice(0, -newExt.length);
  const pattern = new RegExp(`(?<![\\w.-])${escapeRe(oldTok)}(${escapeRe(ext)})?(?![\\w/-]|\\.\\w)`, "g");
  return { from, pattern, replace: (withExt: boolean) => (withExt ? newTok + newExt : newTok.replace(/\/index$/, "")) };
});

const edits = new Map<string, Edit[]>();
const warnings: string[] = [];

for (const file of tracked) {
  if (SKIP.has(file) || !TEXT.test(file)) continue;
  let text: string;
  try {
    text = readFileSync(`${ROOT}/${file}`, "utf8");
  } catch {
    continue; // tracked but deleted in the working tree
  }
  const list: Edit[] = [];
  const claimed: Array<[number, number]> = [];
  const fileMoved = moves.has(file);

  if (CODE.test(file)) {
    for (const m of text.matchAll(/(["'`])(\.\.?\/[^"'`\s]*)\1/g)) {
      const [, , raw = ""] = m;
      const start = (m.index ?? 0) + 1;
      if (raw.includes("${")) {
        // Only a template whose static part lands on a moved file's own
        // directory (or on a name prefix inside it) can be reaching for one.
        // `../${id}` in a storage test is a key, not a path into `apps/web`.
        const stat = raw.slice(0, raw.indexOf("${"));
        const joined = posix.join(posix.dirname(file), stat);
        const [dir, stem] = stat.endsWith("/") ? [posix.normalize(joined), ""] : [posix.dirname(joined), posix.basename(joined)];
        const reaches = [...moves.keys()].some((f) => posix.dirname(f) === dir && posix.basename(f).startsWith(stem));
        if (fileMoved || reaches) warnings.push(`${file}:${lineOf(text, start)} template path \`${raw}\` was not rewritten`);
        continue;
      }
      const [spec = "", query] = raw.split("?");
      const hit = resolveSpec(file, spec, tracked);
      if (!hit) {
        if (fileMoved) warnings.push(`${file}:${lineOf(text, start)} "${raw}" resolves to nothing — check it by hand`);
        continue;
      }
      claimed.push([start, start + raw.length]);
      if (!fileMoved && !moves.has(hit.target)) continue;
      const next = emitSpec(newPath(file), newPath(hit.target), hit.style) + (query === undefined ? "" : `?${query}`);
      if (next !== raw) list.push({ start, end: start + raw.length, text: next, kind: "relative" });
    }
  }

  for (const rule of suffixRules) {
    for (const m of text.matchAll(rule.pattern)) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      if (claimed.some(([s, e]) => start < e && end > s)) continue;
      claimed.push([start, end]);
      const next = rule.replace(m[1] !== undefined);
      if (next !== m[0]) list.push({ start, end, text: next, kind: "path" });
    }
  }

  // A bare file name (`see tag-conditions.ts`) carries no directory to anchor
  // on. It is rewritten only when what it names is not in doubt: the file
  // sits beside the one mentioning it, or no other tracked file has that name.
  // `tag-manager.ts` exists under both routes/ and services/, so a mention of
  // it from anywhere else is reported instead.
  for (const [from, to] of moves) {
    const name = posix.basename(from);
    const sibling = posix.dirname(file) === posix.dirname(from);
    if (!sibling && basenames.get(name) !== 1) continue;
    // Prose, not a specifier: `index.ts` alone says nothing, so it keeps its folder.
    const qualified = `${posix.basename(posix.dirname(to))}/${posix.basename(to)}`;
    const next =
      posix.basename(to) === "index.ts"
        ? qualified
        : sibling
          ? posix.relative(posix.dirname(newPath(file)), to)
          : posix.dirname(to) === posix.dirname(from)
            ? posix.basename(to)
            : qualified;
    for (const m of text.matchAll(new RegExp(`(?<![\\w./-])${escapeRe(name)}(?![\\w-])`, "g"))) {
      const start = m.index ?? 0;
      const end = start + name.length;
      if (claimed.some(([s, e]) => start < e && end > s)) continue;
      if (next !== name) list.push({ start, end, text: next, kind: "name" });
    }
  }

  if (list.length > 0) edits.set(file, list.sort((x, y) => x.start - y.start));
}

const report = (file: string, text: string, list: Edit[]) =>
  list.map((e) => `  ${newPath(file)}:${lineOf(text, e.start)} [${e.kind}] ${text.slice(e.start, e.end)} → ${e.text}`);

const counts = { relative: 0, path: 0, name: 0 };
const output: Array<{ file: string; content: string }> = [];
for (const [file, list] of edits) {
  const text = readFileSync(`${ROOT}/${file}`, "utf8");
  if (dryRun) console.log(report(file, text, list).join("\n"));
  let content = text;
  for (const e of [...list].reverse()) content = content.slice(0, e.start) + e.text + content.slice(e.end);
  for (const e of list) counts[e.kind]++;
  output.push({ file, content });
}

// Mentions of an old file NAME that no rule could anchor to a directory.
const leftovers: string[] = [];
const final = new Map(output.map((o) => [o.file, o.content]));
for (const file of tracked) {
  if (SKIP.has(file) || !TEXT.test(file)) continue;
  let text: string;
  try {
    text = final.get(file) ?? readFileSync(`${ROOT}/${file}`, "utf8");
  } catch {
    continue;
  }
  for (const from of moves.keys()) {
    const name = posix.basename(from);
    for (const m of text.matchAll(new RegExp(`(?<![\\w./-])${escapeRe(name)}(?![\\w-])`, "g"))) {
      leftovers.push(`  ${newPath(file)}:${lineOf(text, m.index ?? 0)} mentions ${name}`);
    }
  }
}

if (!dryRun) {
  for (const [from, to] of moves) {
    mkdirSync(`${ROOT}/${posix.dirname(to)}`, { recursive: true });
    git("mv", from, to);
  }
  for (const { file, content } of output) writeFileSync(`${ROOT}/${newPath(file)}`, content);
}

console.log(
  `${dryRun ? "[dry-run] would move" : "moved"} ${moves.size} file(s); ` +
    `${counts.relative} relative + ${counts.path} path + ${counts.name} name reference(s) in ${output.length} file(s)`,
);
if (warnings.length > 0) console.log(`\nnot rewritten — check by hand:\n  ${warnings.join("\n  ")}`);
if (leftovers.length > 0) console.log(`\nbare mentions of an old file name:\n${leftovers.join("\n")}`);
