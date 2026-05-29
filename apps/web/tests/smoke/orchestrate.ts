/**
 * End-to-end runtime smoke orchestrator.
 *
 *   SMOKE_RUNTIME=bun       → spawns `bun apps/web/src/server/entries/bun.ts`
 *                             with SQLITE_PATH against a temp sqlite db
 *   SMOKE_RUNTIME=vercel    → spawns `node serve-bundle.mjs` against
 *                             .vercel/output/functions/api/index.func/index.mjs
 *                             with DATABASE_URL (Postgres required)
 *   SMOKE_RUNTIME=netlify   → spawns `node serve-bundle.mjs` against
 *                             apps/web/netlify/functions/api.mjs with
 *                             DATABASE_URL
 *
 *   PORT (default 8787), DATABASE_URL (required for vercel/netlify;
 *     ignored for bun), SMOKE_KEEP_OPEN=1 (don't kill the server after
 *     the contract — useful for manual poking).
 *
 * Why one orchestrator instead of inline workflow steps:
 *   - Local + CI run the same code (less drift)
 *   - DB migration step is runtime-aware (sqlite vs pg)
 *   - Server lifecycle (background spawn, /health polling, teardown)
 *     is fiddly enough to deserve a single owner.
 *
 * Exit code: forwards the contract's exit code (0 ok, 1 failure, 2 misuse).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { runSmokeContract } from "./contract";

const RUNTIME = process.env.SMOKE_RUNTIME ?? "bun";
const PORT = Number(process.env.PORT ?? 8787);
const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../../..");
const APP_URL = `http://127.0.0.1:${PORT}`;

interface RuntimeProfile {
  /** Apply DB migrations for this runtime's DB choice. */
  setupDb: () => Promise<{ env: Record<string, string>; cleanup: () => void }>;
  /** Spawn the server child process. Returns the process handle. */
  spawnServer: (env: Record<string, string>) => ChildProcess;
  /** Whether to run the cron-secret gate check in the contract. */
  checkCron: boolean;
}

const sqliteProfile: RuntimeProfile = {
  setupDb: async () => {
    const dir = mkdtempSync(join(tmpdir(), "backlex-smoke-"));
    const dbPath = join(dir, "smoke.sqlite");
    // The sqlite migrator reads the DB path from argv[2] (see
    // packages/db/src/sqlite/migrate.ts), so we invoke it directly
    // rather than going through `db:migrate:sqlite`.
    const r = await runOnce(
      "bun",
      ["run", "packages/db/src/sqlite/migrate.ts", dbPath],
      REPO_ROOT,
      {},
    );
    if (r.code !== 0) {
      throw new Error(`sqlite migration failed (exit ${r.code}):\n${r.output}`);
    }
    return {
      env: { SQLITE_PATH: dbPath },
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
  },
  spawnServer: (env) =>
    spawn("bun", ["apps/web/src/server/entries/bun.ts"], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        ...env,
        PORT: String(PORT),
        APP_URL,
        // CI sets DATABASE_URL at the job level for the bundle runtimes.
        // The bun runtime is the sqlite path on purpose, so override
        // back to empty here — otherwise context.ts picks pg over sqlite
        // and the sqlite migrations we just applied are unused.
        DATABASE_URL: "",
      },
      stdio: "inherit",
    }),
  checkCron: false,
};

const bundleProfile = (bundlePath: string): RuntimeProfile => ({
  setupDb: async () => {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error(
        "DATABASE_URL is required for bundle smoke (vercel/netlify) — point at a Postgres with pgvector",
      );
    }
    const r = await runOnce("bun", ["run", "db:migrate:pg"], REPO_ROOT, {
      DATABASE_URL: url,
    });
    if (r.code !== 0) {
      throw new Error(`pg migration failed (exit ${r.code}):\n${r.output}`);
    }
    return { env: { DATABASE_URL: url }, cleanup: () => {} };
  },
  spawnServer: (env) =>
    spawn(
      "node",
      [resolve(REPO_ROOT, "apps/web/tests/smoke/serve-bundle.mjs")],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          ...env,
          PORT: String(PORT),
          APP_URL,
          BUNDLE_PATH: resolve(REPO_ROOT, bundlePath),
          // Provide CRON_SECRET so vercel/netlify entries register
          // /api/_cron/tick with auth (the contract verifies the
          // gate rejects unauthenticated calls).
          CRON_SECRET: process.env.CRON_SECRET ?? "smoke-cron-secret",
          AUTH_SECRET:
            process.env.AUTH_SECRET ?? "smoke-secret-not-for-prod-stable",
        },
        stdio: "inherit",
      },
    ),
  checkCron: true,
});

// Cloudflare profile — `wrangler dev --local` against wrangler.ci.toml
// (a sibling of wrangler.toml with the [ai] binding removed; that one
// binding is the only thing that needs a real CF login). D1 is the
// canonical dialect on CF Workers, so we apply the same sqlite
// migrations to a temp miniflare state dir via `migrate-d1.ts`. The
// worker entry doesn't register /api/_cron/tick — CF cron is the
// `scheduled(event, env, ctx)` handler instead — so checkCron stays
// off for this profile.
const cloudflareProfile: RuntimeProfile = {
  setupDb: async () => {
    const dir = mkdtempSync(join(tmpdir(), "backlex-smoke-cf-"));
    const r = await runOnce(
      "bun",
      [
        "run",
        "packages/db/src/sqlite/migrate-d1.ts",
        "--config=apps/web/wrangler.ci.toml",
        `--persist-to=${dir}`,
      ],
      REPO_ROOT,
      {},
    );
    if (r.code !== 0) {
      throw new Error(`D1 migration failed (exit ${r.code}):\n${r.output}`);
    }
    return {
      env: { CF_PERSIST_DIR: dir },
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
  },
  spawnServer: (env) =>
    spawn(
      "bunx",
      [
        "wrangler",
        "dev",
        "-c",
        "wrangler.ci.toml",
        "--local",
        "--persist-to",
        env.CF_PERSIST_DIR!,
        "--port",
        String(PORT),
        "--ip",
        "127.0.0.1",
      ],
      {
        // wrangler dev reads [assets] from wrangler.ci.toml's own
        // directory; running from apps/web keeps dist/client resolvable.
        cwd: resolve(REPO_ROOT, "apps/web"),
        env: {
          ...process.env,
          APP_URL,
          // CF's runtime check (isCloudflareWorkers) is keyed off
          // navigator.userAgent === "Cloudflare-Workers", which
          // workerd sets automatically. We don't need to nudge it.
          AUTH_SECRET:
            process.env.AUTH_SECRET ?? "smoke-secret-not-for-prod-stable",
          // Don't leak the job-level DATABASE_URL into the worker — it
          // would force the postgres-js path (which Workers can't run)
          // when D1 is the intended dialect here.
          DATABASE_URL: "",
        },
        stdio: "inherit",
      },
    ),
  checkCron: false,
};

const profiles: Record<string, RuntimeProfile> = {
  bun: sqliteProfile,
  vercel: bundleProfile(".vercel/output/functions/api/index.func/index.mjs"),
  netlify: bundleProfile("apps/web/netlify/functions/api.mjs"),
  cloudflare: cloudflareProfile,
};

const profile = profiles[RUNTIME];
if (!profile) {
  console.error(
    `[smoke] unknown SMOKE_RUNTIME=${RUNTIME}; expected one of: ${Object.keys(profiles).join(", ")}`,
  );
  process.exit(2);
}

const runOnce = (
  cmd: string,
  args: string[],
  cwd: string,
  extraEnv: Record<string, string>,
): Promise<{ code: number; output: string }> =>
  new Promise((resolveStep) => {
    const chunks: string[] = [];
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...extraEnv },
    });
    child.stdout?.on("data", (b: Buffer) => chunks.push(b.toString()));
    child.stderr?.on("data", (b: Buffer) => chunks.push(b.toString()));
    child.on("close", (code) =>
      resolveStep({ code: code ?? 0, output: chunks.join("") }),
    );
  });

const waitForHealth = async (timeoutMs = 30_000): Promise<void> => {
  const start = Date.now();
  let lastErr: unknown = undefined;
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${APP_URL}/health`);
      if (r.ok) return;
      lastErr = `status ${r.status}`;
    } catch (e) {
      lastErr = e;
    }
    await sleep(500);
  }
  throw new Error(
    `[smoke] /health did not respond OK within ${timeoutMs}ms (last: ${String(lastErr)})`,
  );
};

let server: ChildProcess | undefined;
let cleanup: () => void = () => {};

try {
  console.log(`[smoke] runtime=${RUNTIME} port=${PORT}`);
  console.log(`[smoke] applying DB migrations...`);
  const setup = await profile.setupDb();
  cleanup = setup.cleanup;

  console.log(`[smoke] spawning server...`);
  server = profile.spawnServer(setup.env);
  server.on("exit", (code, signal) => {
    if (code !== null && code !== 0) {
      console.error(`[smoke] server exited unexpectedly: code=${code} signal=${signal}`);
    }
  });

  console.log(`[smoke] waiting for /health on ${APP_URL}...`);
  await waitForHealth();
  console.log(`[smoke] server ready, running contract...`);

  const { passes, failures } = await runSmokeContract({
    baseUrl: APP_URL,
    checkCron: profile.checkCron,
  });

  for (const p of passes) console.log(`  ✓ ${p}`);
  for (const f of failures) console.error(`  ✗ ${f}`);

  if (failures.length > 0) {
    console.error(
      `\n[smoke] ✗ ${failures.length} failure(s), ${passes.length} pass(es)`,
    );
    process.exitCode = 1;
  } else {
    console.log(`\n[smoke] ✓ all ${passes.length} checks passed`);
  }
} catch (e) {
  console.error(`[smoke] fatal: ${e instanceof Error ? e.stack : String(e)}`);
  process.exitCode = 1;
} finally {
  if (!process.env.SMOKE_KEEP_OPEN) {
    server?.kill("SIGTERM");
    // Give it a beat to flush before we yank the temp dir.
    await sleep(200);
    cleanup();
  } else {
    console.log(`[smoke] SMOKE_KEEP_OPEN=1 — leaving server alive at ${APP_URL}`);
  }
}
