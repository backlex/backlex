/**
 * Reclaim agent worktrees under `.claude/worktrees/`.
 *
 * Parallel agent sessions each get their own git worktree there (a shared tree
 * would let their edits interleave). Nothing removes them when the session
 * ends, so they accumulate — and each carries a full `node_modules`, so the
 * directory reaches tens of gigabytes within a couple of months. Worse, a
 * worktree's `.git` file is an ABSOLUTE path into the main repo's
 * `.git/worktrees/`, so moving or renaming the repo orphans every one of them
 * at once: git can no longer read them, `git worktree list` stops mentioning
 * them, and they become plain directories that only `rm` will clear.
 *
 * Run automatically from lefthook's `post-merge` (so the publish flow's
 * `git merge <feat/...>` sweeps up behind itself) and safe to run by hand:
 *
 *   bun scripts/cleanup-worktrees.ts [--dry-run] [--force]
 *
 * Removal is deliberately conservative. A worktree goes only if it is:
 *   - ORPHANED — its `.git` gitdir target no longer exists, so git cannot read
 *     it and no commit in it is recoverable; or
 *   - MERGED — a live worktree whose HEAD is an ancestor of `main`, whose
 *     working tree is clean, and which has not been touched for
 *     `IDLE_MINUTES`. The idle window is what keeps this from deleting the
 *     tree of an agent that is still working in it just after its branch
 *     landed.
 *
 * Anything else — dirty tree, unmerged commits, recent activity — is reported
 * and kept. `--force` drops only the idle-window check, never the dirty or
 * unmerged ones.
 */
import { readdirSync, rmSync, statSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// `fileURLToPath`, not `URL.pathname` — the latter leaves the path percent-
// encoded, so a repo checked out under a directory with a space in its name
// would resolve to a path that does not exist.
const SCRIPT_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * The MAIN checkout, even when this script is run from inside one of the
 * worktrees it collects.
 *
 * Deriving the root from `import.meta.url` alone is wrong in exactly the case
 * that matters. Every worktree carries its own copy of `scripts/`, so running
 * `bun scripts/cleanup-worktrees.ts` from `.claude/worktrees/foo` resolved the
 * root to `foo` — and `foo/.claude/worktrees` does not exist, so the
 * `existsSync(WORKTREES_DIR)` guard below took its early exit and printed
 * "worktrees: nothing to clean". A sweep that cannot see its subject reported
 * SUCCESS, which is the failure mode this repo keeps re-finding.
 *
 * That path is not hypothetical. CLAUDE.md's publish flow says to run this by
 * hand when the merge happened elsewhere, and a PR merged on GitHub is exactly
 * that — so an agent working in a worktree got a clean all-clear while three
 * collectable trees sat there untouched.
 *
 * `--git-common-dir` is the shared `.git` of every worktree of a repo, so its
 * parent is the main checkout from anywhere inside it. Falls back to the
 * file-relative root when git cannot answer, which is the old behaviour and
 * still correct for the main checkout.
 */
function resolveRepoRoot(): string {
  const r = Bun.spawnSync(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: SCRIPT_ROOT,
    stderr: "pipe",
  });
  if (!r.success) return SCRIPT_ROOT;
  const commonDir = r.stdout.toString().trim();
  // A linked worktree reports the main `.git`; the main checkout reports its
  // own. Either way the parent directory is the checkout to sweep.
  return commonDir ? dirname(commonDir) : SCRIPT_ROOT;
}

const REPO_ROOT = resolveRepoRoot();
const WORKTREES_DIR = join(REPO_ROOT, ".claude", "worktrees");
/** How long a merged worktree must sit untouched before it is collectable. */
const IDLE_MINUTES = 60;

const argv = new Set(process.argv.slice(2));
const dryRun = argv.has("--dry-run");
const force = argv.has("--force");

type Verdict =
  | { action: "remove"; reason: string }
  | { action: "keep"; reason: string };

/** Run a git command inside `cwd`; `null` when git refuses (orphaned tree). */
function git(cwd: string, args: string[]): string | null {
  const r = Bun.spawnSync(["git", ...args], { cwd, stderr: "pipe" });
  if (!r.success) return null;
  return r.stdout.toString().trim();
}

/** An orphan's `.git` points at a `gitdir:` path that no longer exists. */
function isOrphaned(dir: string): boolean {
  const dotGit = join(dir, ".git");
  if (!existsSync(dotGit)) return true;
  let contents: string;
  try {
    contents = readFileSync(dotGit, "utf8");
  } catch {
    return true;
  }
  const target = /^gitdir:\s*(.+)$/m.exec(contents)?.[1]?.trim();
  // A real directory here means this is a normal repo, not a worktree link —
  // that is not something we know how to reason about, so treat it as live.
  if (!target) return false;
  return !existsSync(target);
}

function classify(dir: string): Verdict {
  if (isOrphaned(dir)) {
    return { action: "remove", reason: "orphaned (gitdir target is gone)" };
  }

  const dirty = git(dir, ["status", "--porcelain"]);
  if (dirty === null) {
    return { action: "remove", reason: "orphaned (git cannot read it)" };
  }
  if (dirty.length > 0) {
    const n = dirty.split("\n").length;
    return { action: "keep", reason: `${n} uncommitted change(s)` };
  }

  const head = git(dir, ["rev-parse", "HEAD"]);
  if (!head) return { action: "keep", reason: "no resolvable HEAD" };

  // `merge-base --is-ancestor` exits non-zero (→ null) when HEAD is not yet in
  // main, which is exactly the "still has unmerged work" case.
  const merged = git(dir, ["merge-base", "--is-ancestor", head, "main"]);
  if (merged === null) {
    return { action: "keep", reason: "commits not merged into main" };
  }

  if (!force) {
    const idleMs = Date.now() - statSync(dir).mtimeMs;
    if (idleMs < IDLE_MINUTES * 60_000) {
      const mins = Math.round(idleMs / 60_000);
      return { action: "keep", reason: `active ${mins}m ago` };
    }
  }
  return { action: "remove", reason: "merged into main, clean, idle" };
}

if (!existsSync(WORKTREES_DIR)) {
  // `prune` still earns its keep: it clears metadata for worktrees whose
  // directory was removed by hand.
  git(REPO_ROOT, ["worktree", "prune"]);
  console.log("worktrees: nothing to clean");
  process.exit(0);
}

const entries = readdirSync(WORKTREES_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

let removed = 0;
const kept: string[] = [];

for (const name of entries) {
  const dir = join(WORKTREES_DIR, name);
  const verdict = classify(dir);
  if (verdict.action === "keep") {
    kept.push(`${name} — ${verdict.reason}`);
    continue;
  }
  console.log(`${dryRun ? "would remove" : "removing"} ${name} — ${verdict.reason}`);
  if (!dryRun) {
    // Detach it from git first when git still knows about it, so the main
    // repo's `.git/worktrees/` metadata goes with the directory.
    git(REPO_ROOT, ["worktree", "remove", "--force", dir]);
    rmSync(dir, { recursive: true, force: true });
  }
  removed++;
}

git(REPO_ROOT, ["worktree", "prune"]);

console.log(
  `worktrees: ${removed} ${dryRun ? "collectable" : "removed"}, ${kept.length} kept`,
);
for (const k of kept) console.log(`  kept: ${k}`);
