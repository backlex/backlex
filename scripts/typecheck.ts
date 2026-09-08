/**
 * Run the repo typecheck under a machine-wide lock.
 *
 * `lefthook.yml`'s pre-push gate is deliberately SERIAL, and the comment there
 * has the measurement: run typecheck beside the test suite and the box spends
 * 707s in the kernel instead of 292s — 2.4× more paging for no wall-clock win,
 * because `apps/web`'s server project needs a >4 GB live working set on an 8 GB
 * machine. Serial is not slower; it is the same wait on a usable machine.
 *
 * That reasoning was only ever applied INSIDE one gate run. It cannot see the
 * other half of the problem: this repo is worked by several agent sessions at
 * once, each in its own worktree, each free to start its own `tsc`. Observed
 * 2026-08-29 — four concurrent checker processes, 16% free memory, 559k
 * pageouts, and a 7-minute job that had not finished at 22 minutes. Nothing was
 * wrong with any one of them.
 *
 * So the same rule is applied across processes: one typecheck at a time per
 * repo, everyone else waits. Waiting is strictly cheaper than thrashing —
 * N serial runs finish in the sum of their times, N paging runs finish in
 * considerably more than that, if at all.
 *
 * **The lock lives in the COMMON git dir**, which every worktree of this repo
 * resolves to the same absolute path (verified: the main tree and
 * `.claude/worktrees/*` both answer
 * `/…/backlex/.git` for `git rev-parse --git-common-dir`). That scopes it
 * exactly right — every worktree of this repo shares it, and an unrelated
 * checkout on the same machine is unaffected.
 *
 * Escape hatch: `BACKLEX_TYPECHECK_NO_LOCK=1` skips the lock entirely. CI never
 * contends, so it costs one file create there and nothing else.
 *
 * **Lock here and ONLY here.** Do not add this to a workspace's own `typecheck`
 * script: the root holds the lock while it spawns them, so a second acquire
 * inside a child would wait on a lock its own parent owns and never return.
 * A caller that runs `tsc` by hand also bypasses this — that is a documented
 * gap, not a bug to fix by locking deeper. `bun run typecheck:raw` is the
 * supported way to opt out.
 *
 * It also keeps `--checkers 2` honest. That value is tuned for a machine with
 * this project's ~9.8 GB peak footprint to itself (see `docs/performance.md`);
 * the advice to drop it to `1` exists precisely for the case this lock now
 * prevents. One at a time means the tuned value is the right one again.
 */
import { spawnSync } from "node:child_process";
import { closeSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const NO_LOCK = process.env.BACKLEX_TYPECHECK_NO_LOCK === "1";
/**
 * `--tests` runs ONLY `apps/web`'s tests project, under this same lock.
 *
 * It used to be a bare `bun run --cwd apps/web typecheck:tests` in the root
 * package.json, which took no lock at all — so the single most expensive
 * program in the repo (645 spec files plus both halves of the app) could run
 * beside another session's `bun run typecheck` and starve it. Observed while
 * writing this: two checkers at 14% CPU each on an 8 GB box, both crawling.
 *
 * This is NOT the case the "lock here and ONLY here" warning above is about.
 * That warns against locking inside a workspace script that this file SPAWNS —
 * a child would then wait on its own parent's lock forever. `--tests` is a
 * sibling entry point: nothing above it holds the lock when it runs.
 */
const TESTS_ONLY = process.argv.includes("--tests");
const PASSTHROUGH = process.argv.slice(2).filter((a) => a !== "--tests");
const POLL_MS = 2_000;
/** How often to remind the user who they are waiting for. */
const REPORT_EVERY_MS = 30_000;

interface Holder {
  pid: number;
  startedAt: number;
  cwd: string;
}

const gitCommonDir = (): string => {
  const r = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    encoding: "utf8",
  });
  const out = r.status === 0 ? r.stdout.trim() : "";
  // No git dir (a tarball checkout, a sandbox) — fall back to the cwd, which
  // still serialises the common case of two runs in the same directory.
  return out || process.cwd();
};

const LOCK = join(gitCommonDir(), "backlex-typecheck.lock");

const readHolder = (): Holder | null => {
  try {
    return JSON.parse(readFileSync(LOCK, "utf8")) as Holder;
  } catch {
    return null;
  }
};

/** A lock whose owner is gone is not a lock. `kill(pid, 0)` throws ESRCH for a
 *  dead process and EPERM for one we may not signal — EPERM still means alive,
 *  so only ESRCH clears it. */
const holderIsAlive = (h: Holder | null): boolean => {
  if (!h?.pid) return false;
  try {
    process.kill(h.pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

const acquire = (): boolean => {
  try {
    const fd = openSync(LOCK, "wx");
    writeSync(
      fd,
      JSON.stringify({ pid: process.pid, startedAt: Date.now(), cwd: process.cwd() }),
    );
    closeSync(fd);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    return false;
  }
};

const release = (): void => {
  const h = readHolder();
  // Only ever remove our OWN lock: a stale-steal by another process could
  // otherwise be undone by this one exiting late.
  if (h?.pid === process.pid) {
    try {
      rmSync(LOCK, { force: true });
    } catch {
      /* nothing useful to do while exiting */
    }
  }
};

const waitForLock = async (): Promise<void> => {
  let announced = false;
  let lastReport = 0;
  const waitingSince = Date.now();
  for (;;) {
    if (acquire()) return;
    const h = readHolder();
    if (!holderIsAlive(h)) {
      // Stale: the owner died (a kill -9, a crashed gate). Clear and retry
      // rather than waiting forever on a process that will never release.
      console.warn(`[typecheck] clearing a stale lock left by pid ${h?.pid ?? "?"}`);
      try {
        rmSync(LOCK, { force: true });
      } catch {
        /* someone else got there first, which is fine */
      }
      continue;
    }
    const now = Date.now();
    if (!announced || now - lastReport > REPORT_EVERY_MS) {
      const held = h ? Math.round((now - h.startedAt) / 1000) : 0;
      const mine = Math.round((now - waitingSince) / 1000);
      console.log(
        `[typecheck] waiting — pid ${h?.pid} has been checking for ${held}s in ${h?.cwd}` +
          (announced ? ` (waiting ${mine}s)` : "") +
          (announced ? "" : "\n[typecheck] one at a time is deliberate: two on this box page rather than compile."),
      );
      announced = true;
      lastReport = now;
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
};

/**
 * The repo root is not a workspace, so `--filter '*'` below cannot reach it —
 * which is exactly why `scripts/` and `vercel.ts` went unchecked for as long as
 * they have existed. `tsconfig.scripts.json` covers them; this is the only
 * place that can run it, because this is the only entry both the pre-push hook
 * and `test.yml` call.
 *
 * It runs FIRST and short-circuits, on the same reasoning as `lefthook.yml`'s
 * job order: 18 files cost about a second, so a broken build script fails here
 * instead of after the ~7 minutes `apps/web` takes. `--checkers 1` because
 * fanning the Go checker across cores for 18 files is pure setup cost.
 */
const checkRootScripts = (): number => {
  // Resolved from this file, not from the cwd. The lock above already proves
  // this script gets run from more than one place (every agent worktree is its
  // own checkout), and a relative `./node_modules/...` would silently become
  // "tsc: not found" — an exit code this function would then report as a type
  // error.
  const root = fileURLToPath(new URL("..", import.meta.url));
  const r = spawnSync(
    join(root, "node_modules/.bin/tsc"),
    ["--noEmit", "-p", join(root, "tsconfig.scripts.json"), "--checkers", "1"],
    { stdio: "inherit", cwd: root },
  );
  return r.status ?? 1;
};

const main = async (): Promise<never> => {
  if (!NO_LOCK) {
    await waitForLock();
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      process.on(sig, () => {
        release();
        process.exit(130);
      });
    }
    process.on("exit", release);
  }

  const started = Date.now();
  if (TESTS_ONLY) {
    const t = spawnSync("bun", ["run", "--cwd", "apps/web", "typecheck:tests", ...PASSTHROUGH], {
      stdio: "inherit",
      cwd: fileURLToPath(new URL("..", import.meta.url)),
    });
    if (!NO_LOCK) {
      console.log(`[typecheck:tests] done in ${Math.round((Date.now() - started) / 1000)}s`);
    }
    process.exit(t.status ?? 1);
  }

  const rootStatus = checkRootScripts();
  if (rootStatus !== 0) process.exit(rootStatus);

  const r = spawnSync(
    "bun",
    ["run", "--filter", "*", "typecheck", ...PASSTHROUGH],
    { stdio: "inherit" },
  );
  if (!NO_LOCK) {
    console.log(`[typecheck] done in ${Math.round((Date.now() - started) / 1000)}s`);
  }
  process.exit(r.status ?? 1);
};

await main();
