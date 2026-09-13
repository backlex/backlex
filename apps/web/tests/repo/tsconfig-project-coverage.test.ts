/**
 * Every TypeScript file in this repo belongs to a tsconfig project, and the
 * root solution knows about every project.
 *
 * Neither was true when this file was written. 39 files matched no `include`
 * glob anywhere — among them the eight-runtime build matrix, the pre-deploy
 * gate that `bun run build` calls, `vercel.ts` (whose entire reason to exist
 * over `vercel.json` is that it is typed), `apps/web/vite.config.ts`, the
 * Netlify cron entry, and the deployable sandbox exec server. Four of them were
 * dragged in transitively by a test import; the other 35 were checked by
 * nothing at all.
 *
 * The cost was not theoretical. `scripts/build-targets.ts` carried the same
 * `ChildProcess` defect that `tests/smoke/orchestrate.ts` diagnoses and works
 * around in a fifteen-line comment — same idiom, same cause, and the only
 * difference between the copy that got fixed and the copy that did not was
 * whether a tsconfig had ever looked at the file.
 *
 * A coverage hole is invisible by construction: nothing fails, no file is
 * named, and the gate stays green in exactly the way it does when the code is
 * fine. So the guard has to enumerate rather than sample — it derives the file
 * census from `git ls-files` and the project census from the tsconfigs on disk,
 * and neither list is written down here. Adding a workspace, a project, or a
 * stray config file at a repo root all keep working; adding a file that no
 * project covers does not.
 *
 * Related: `typescript-pin-lockfile.test.ts` guards which compiler runs,
 * `vite-pin-lockfile.test.ts` guards a declared-vs-resolved divergence. This
 * one guards what the compiler is pointed AT.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../../../../", import.meta.url));
const repoPath = (rel: string): string => join(REPO, rel);

/**
 * Directories that hold no hand-written source. `.claude/worktrees` matters
 * most: a parallel agent session is a full second checkout of this repo, and
 * walking into one makes every file appear twice under a path no tsconfig
 * covers — a guaranteed false failure that has nothing to do with the tree
 * being tested.
 */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".claude",
  ".codex",
  "dist",
  "build",
  ".next",
  ".astro",
  ".wrangler",
  ".vercel",
  ".netlify",
  ".data",
  ".tmp",
  ".turbo",
  ".cache",
  ".open-next",
  ".react-router",
  "dist-worker-template",
]);

/** Minimal JSONC reader — tsconfigs in this repo carry comments, and several of
 *  them carry the reasoning that keeps the file from being "tidied" away. */
const readJsonc = (path: string): Record<string, unknown> => {
  const src = readFileSync(path, "utf8");
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (c === '"') {
      out += c;
      i++;
      while (i < src.length) {
        if (src[i] === "\\") {
          out += src[i] + (src[i + 1] ?? "");
          i += 2;
          continue;
        }
        out += src[i];
        if (src[i] === '"') {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    // `"@/*": [...]` contains `/*`, so comment stripping has to be
    // string-aware. A naive regex eats the rest of the file from there and the
    // parse failure reads like a malformed tsconfig.
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1")) as Record<string, unknown>;
};

interface Project {
  /** Repo-relative path of the tsconfig. */
  config: string;
  /** Repo-relative directory the include globs are resolved against. */
  dir: string;
  include: string[];
  exclude: string[];
  references: string[];
}

/**
 * A solution-style config builds no program of its own — it only points at
 * others. `apps/web/tsconfig.json` and the repo root are both this shape, but
 * they spell it differently: apps/web writes BOTH `files: []` and
 * `include: []`, the root writes only `files: []`. An earlier version of this
 * required `include` to be an empty array specifically, so the root config fell
 * through and was classified as a project — and then passed the runner check
 * only because that check used to accept "referenced from the root solution",
 * which the root trivially is. Two bugs holding each other up.
 *
 * Either empty marker is enough: TypeScript needs one of them to stop the
 * default `**\/*` glob, and which one is a matter of taste.
 */
const emptyOrAbsent = (v: unknown): boolean =>
  v === undefined || (Array.isArray(v) && v.length === 0);

const isSolution = (c: Record<string, unknown>): boolean =>
  Array.isArray(c.references) &&
  (c.references as unknown[]).length > 0 &&
  emptyOrAbsent(c.include) &&
  emptyOrAbsent(c.files) &&
  !(c.include === undefined && c.files === undefined);

/** A base config exists only to be `extends`ed. It names no inputs and no
 *  references, so treating it as a project would give it TypeScript's default
 *  `**\/*` and make it appear to cover the entire repo. */
const isBase = (c: Record<string, unknown>): boolean =>
  c.include === undefined && c.files === undefined && c.references === undefined;

/** Is the config at this repo-relative path itself a solution? Used to accept
 *  `apps/web/tsconfig.json`, which is a legitimate reference target that never
 *  appears in the project list. */
const isSolutionAt = (config: string): boolean =>
  existsSync(repoPath(config)) && isSolution(readJsonc(repoPath(config)));

const findConfigs = (): string[] => {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(repoPath(dir) || REPO, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(dir ? `${dir}/${e.name}` : e.name);
      } else if (/^tsconfig.*\.json$/.test(e.name)) {
        found.push(dir ? `${dir}/${e.name}` : e.name);
      }
    }
  };
  walk("");
  return found.sort();
};

let projectCache: Project[] | undefined;
const projects = (): Project[] =>
  (projectCache ??= findConfigs()
    .map((config) => {
      const c = readJsonc(repoPath(config));
      const dir = config.includes("/") ? config.slice(0, config.lastIndexOf("/")) : "";
      const refs = ((c.references as { path: string }[] | undefined) ?? []).map((r) => r.path);
      return {
        config,
        dir,
        include: (c.include as string[] | undefined) ?? (c.files ? [] : ["**/*"]),
        exclude: (c.exclude as string[] | undefined) ?? [],
        references: refs,
        skip: isSolution(c) || isBase(c),
      };
    })
    .filter((p) => !p.skip));

/** TypeScript expands a bare directory entry ("src") to "src/**\/*". Anything
 *  with a glob character or an extension is already a pattern. */
const asGlob = (entry: string): string =>
  /\*|\.[cm]?[jt]sx?$|\.json$/.test(entry) ? entry : `${entry.replace(/\/$/, "")}/**/*`;

const matcher = (entry: string): ((rel: string) => boolean) => {
  const g = new Bun.Glob(asGlob(entry));
  return (rel) => g.match(rel);
};

/** Tracked TypeScript sources, which is the set a typecheck is responsible
 *  for. `git ls-files` rather than a walk so generated and ignored trees
 *  (`.react-router/types`, `next-env.d.ts`, build output) never enter. */
let sourceCache: string[] | undefined;
const sourceFiles = (): string[] =>
  (sourceCache ??= (() => {
    const out = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: REPO });
    const files = new TextDecoder().decode(out.stdout).split("\0").filter(Boolean);
    return files.filter(
      (f) => /\.(ts|tsx|mts|cts)$/.test(f) && !f.split("/").some((s) => SKIP_DIRS.has(s)),
    );
  })());

const orphans = (): string[] => {
  const ps = projects().map((p) => ({
    prefix: p.dir === "" ? "" : `${p.dir}/`,
    inc: p.include.map(matcher),
    exc: p.exclude.map(matcher),
  }));
  return sourceFiles().filter((f) => {
    for (const p of ps) {
      if (!f.startsWith(p.prefix)) continue;
      const rel = f.slice(p.prefix.length);
      if (!p.inc.some((m) => m(rel))) continue;
      if (p.exc.some((m) => m(rel))) continue;
      return false;
    }
    return true;
  });
};

/** Every project reachable from the root solution, following references
 *  through nested solutions (`apps/web/tsconfig.json` is one). */
const referencedProjects = (): Set<string> => {
  const seen = new Set<string>();
  const visit = (config: string): void => {
    if (seen.has(config)) return;
    seen.add(config);
    if (!existsSync(repoPath(config))) return;
    const c = readJsonc(repoPath(config));
    const dir = config.includes("/") ? config.slice(0, config.lastIndexOf("/")) : "";
    for (const r of (c.references as { path: string }[] | undefined) ?? []) {
      // A reference may name a directory or a file, exactly as tsc resolves it.
      const raw = join(dir, r.path).replace(/^\.\//, "");
      const target =
        existsSync(repoPath(raw)) && statSync(repoPath(raw)).isDirectory()
          ? `${raw}/tsconfig.json`
          : raw;
      visit(target);
    }
  };
  visit("tsconfig.json");
  return seen;
};

describe("tsconfig project coverage", () => {
  test("the census is not empty, or every rule below is vacuous", () => {
    // Same shape of guard as typescript-pin-lockfile.test.ts. Both lists are
    // derived, so both can silently become empty — a moved workspace root, a
    // `git ls-files` that fails in a sandbox — and every assertion under them
    // would then pass over nothing. The floors sit well below today's numbers
    // (~1900 files, ~24 configs) so growth is never a chore.
    expect(sourceFiles().length).toBeGreaterThan(1200);
    expect(projects().length).toBeGreaterThan(14);
  });

  test("every tracked .ts/.tsx file belongs to a tsconfig project", () => {
    // Reported as the file list, not a count: a failure has to name what to
    // add and where, or the next person re-derives this whole investigation.
    expect(orphans()).toEqual([]);
  });

  test("every project is executed by a runner", () => {
    // The invariant that matters is not "the root solution lists everything" —
    // `apps/docs` and `apps/site` are checked by `astro check` on a pinned 5.9
    // compiler and must NOT be dragged into `tsc -b`, and every `examples/*`
    // runs its own `tsc --noEmit`. It is that no project is dead: a tsconfig
    // nothing invokes is a file that looks like coverage and provides none.
    //
    // A runner is a package.json SCRIPT — `bun run typecheck` fans out to each
    // workspace's own `typecheck` (a bare `tsc --noEmit` means that
    // workspace's `tsconfig.json`), and any script may name a project
    // explicitly with `-p <path>`.
    //
    // Being referenced from the root solution deliberately does NOT count, and
    // that correction is why this comment is long. It DID count here at first,
    // on the reasoning that `tsc -b` walks the solution — but **nothing in this
    // repo ever runs `tsc -b`**; grep says the string appears only in this
    // file's own comments. So the union quietly certified a project no gate
    // compiled: `apps/web/tsconfig.tooling.json` passed this test while
    // `vite.config.ts`, the Netlify cron entry and the sandbox exec server —
    // the exact files it was created for — went on being checked by nothing.
    //
    // A guard that accepts a hypothetical runner is the same defect as the hole
    // it was written to close, one level up.
    const named = new Set<string>();
    const scriptsOf = (pkgDir: string): Record<string, string> => {
      const p = repoPath(pkgDir ? `${pkgDir}/package.json` : "package.json");
      if (!existsSync(p)) return {};
      return (
        (JSON.parse(readFileSync(p, "utf8")) as { scripts?: Record<string, string> }).scripts ?? {}
      );
    };
    const pkgDirs = [
      "",
      ...["apps", "packages", "examples"].flatMap((d) =>
        readdirSync(repoPath(d), { withFileTypes: true })
          .filter((e) => e.isDirectory() && existsSync(repoPath(`${d}/${e.name}/package.json`)))
          .map((e) => `${d}/${e.name}`),
      ),
    ];
    for (const dir of pkgDirs) {
      for (const cmd of Object.values(scriptsOf(dir))) {
        for (const m of cmd.matchAll(/-p\s+(\S+\.json)/g)) {
          named.add(join(dir, m[1] as string).replace(/^\.\//, ""));
        }
        // A bare `tsc --noEmit` / `astro check` checks its own workspace root.
        if (/(^|&&|\|\|)\s*\S*tsc\s+--noEmit\s*($|&&)/.test(cmd) || cmd.includes("astro check")) {
          named.add(dir ? `${dir}/tsconfig.json` : "tsconfig.json");
        }
      }
    }
    const dead = projects()
      .map((p) => p.config)
      .filter((c) => !named.has(c));
    expect(dead).toEqual([]);
  });

  test("every reference in the root solution resolves to a real project", () => {
    // The inverse. A renamed or deleted project leaves a dangling `path` here,
    // and `tsc -b` reports it as a build error nowhere near the rename.
    const projectConfigs = new Set(projects().map((p) => p.config));
    const dangling = [...referencedProjects()].filter(
      (c) => !existsSync(repoPath(c)) || (c !== "tsconfig.json" && !projectConfigs.has(c) && !isSolutionAt(c)),
    );
    expect(dangling).toEqual([]);
  });

  test("no tracked source file contains a raw NUL byte", async () => {
    // Not a style rule — an encoding rule with a tooling consequence. Five
    // files once held a literal 0x00 inside a string literal where `\0` was
    // meant (a composite-key separator, correct in intent). tsc accepts it,
    // biome accepts it, 7.6k tests passed with it. What it broke was every
    // grep-shaped tool: `grep` and `rg` classify those files as binary and
    // return ZERO matches with exit 1 and no warning, so any sweep or audit
    // silently skipped them — one of the five was the permission-grant route.
    // `git grep` and `git diff` were unaffected (git only samples the first
    // 8000 bytes), which is precisely why nobody noticed.
    // Read concurrently. ~1900 files read serially is ~0.5s on an idle box but
    // ran to 5.6s under load, which is past bun's 5s default timeout — a guard
    // that flakes on a busy machine is one people learn to re-run rather than
    // read.
    const offenders = (
      await Promise.all(
        sourceFiles().map(async (f) => {
          const buf = Buffer.from(await Bun.file(repoPath(f)).bytes());
          const at = buf.indexOf(0);
          if (at === -1) return null;
          const line = buf.subarray(0, at).toString("utf8").split("\n").length;
          return `${f}:${line} — write \\0, not a literal 0x00`;
        }),
      )
    ).filter((x): x is string => x !== null);
    expect(offenders).toEqual([]);
  });
});
