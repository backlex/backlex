#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
/**
 * Assembles a self-contained "worker template" tarball that a downstream
 * provisioner (the private workeros-cloud repo) can fetch as a release
 * asset and upload to a fresh Cloudflare Workers account — D1 + R2 +
 * Worker script in one shot — without re-cloning + re-building this repo.
 *
 * The artifact mirrors what `vite build` already emits under
 * `apps/web/dist/`, plus:
 *   - a templated `wrangler.template.toml` with placeholder tokens
 *     (`__D1_DATABASE_ID__`, `__R2_BUCKET_NAME__`, `__APP_URL__`,
 *     `__R2_PUBLIC_BASE__`) where the maintainer's own account-specific
 *     IDs / URLs lived in the source `wrangler.toml`. The cloud repo
 *     replaces these per customer before `wrangler deploy`.
 *   - a `migrations/sqlite/` mirror of `packages/db/drizzle/sqlite/` so
 *     the cloud repo can also drive `wrangler d1 execute --file` (or the
 *     D1 REST API) on the fresh D1 — even though the SQL is also inlined
 *     into the worker bundle via `with { type: "text" }`, the standalone
 *     files make schema provisioning straightforward and auditable.
 *   - a `meta.json` with version + git SHA + timestamps + tool versions
 *     so the cloud repo can record "customer X is on bundle vN.M.K".
 *
 * Flow:
 *   1. (Skippable with --no-build) Run `bun run build` (vite build) which
 *      writes the SPA into `apps/web/dist/client/` and the worker bundle
 *      into `apps/web/dist/backlex_admin/` (entry `index.js` + chunked
 *      `assets/`, including per-migration `migration-*.sql` chunks).
 *   2. Copy those two trees into a staging dir.
 *   3. Synthesize `wrangler.template.toml`, `meta.json`, and the
 *      `migrations/sqlite/` mirror + manifest.
 *   4. Pack the staging dir into a single `.tar.gz`.
 *
 * Usage:
 *   bun scripts/build-worker-template.ts --version 0.1.0
 *   bun scripts/build-worker-template.ts --version 0.1.0 --output ./tmp/wt
 *   bun scripts/build-worker-template.ts --version 0.1.0 --no-build
 *
 * Exit code: 0 on success; non-zero (with the underlying error) on any
 * step that fails. CI consumes this as a strict release pipeline.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

interface Args {
  version: string;
  output: string;
  build: boolean;
}

const requireValue = (flag: string, value: string | undefined): string => {
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}.`);
  }
  return value;
};

const parseArgs = (argv: string[]): Args => {
  let version: string | undefined;
  let output: string | undefined;
  let build = true;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--version") version = requireValue(flag, argv[++i]);
    else if (flag === "--output") output = requireValue(flag, argv[++i]);
    else if (flag === "--no-build") build = false;
    else if (flag === "--help" || flag === "-h") {
      console.log(
        "Usage: bun scripts/build-worker-template.ts --version <X.Y.Z> [--output <dir>] [--no-build]",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown flag: ${flag}`);
    }
  }
  if (!version) {
    throw new Error(
      "Missing --version. Example: bun scripts/build-worker-template.ts --version 0.1.0",
    );
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(
      `--version must be semver-ish (X.Y.Z, optionally with -pre.N). Got: ${version}`,
    );
  }
  return {
    version,
    output: output ?? join(REPO_ROOT, "dist-worker-template"),
    build,
  };
};

const run = (
  cmd: string,
  cmdArgs: string[],
  cwd = REPO_ROOT,
  extraEnv?: Record<string, string>,
): string => {
  // Pass env EXPLICITLY (not via a `process.env.X = …` mutation before the
  // call): under Bun, spawnSync snapshots the parent env and a late mutation
  // does NOT reach the child — which silently shipped `templateVersion = "dev"`
  // in v0.4.11. Merging into a fresh object guarantees the override propagates.
  const result = spawnSync(cmd, cmdArgs, {
    cwd,
    encoding: "utf8",
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
  });
  if (result.status !== 0) {
    throw new Error(
      `\`${cmd} ${cmdArgs.join(" ")}\` exited with code ${result.status}\n` +
        `stdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  }
  return result.stdout.trim();
};

const sha256OfFile = (path: string): string => {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
};

/**
 * Build a wrangler.template.toml from apps/web/wrangler.toml, replacing
 * the maintainer's account-specific IDs/URLs with placeholders the cloud
 * provisioner substitutes per customer. Keeps every comment intact so the
 * file is still readable as documentation.
 */
const buildWranglerTemplate = (): string => {
  const source = readFileSync(
    join(REPO_ROOT, "apps/web/wrangler.toml"),
    "utf8",
  );
  // Replacements are positional-by-key. We deliberately use a literal
  // line-by-line replace rather than a TOML parse so commented-out blocks
  // (e.g. the vectorize bindings) pass through untouched.
  let out = source;

  // `main` — source `wrangler.toml` points at the TypeScript entry
  // `src/server/entries/worker.ts` because vite + @cloudflare/vite-plugin
  // bundle from there. The tarball already ships the bundled output
  // (`worker/index.js`), so the templated config must point at that
  // pre-bundled file directly.
  out = out.replace(/^main\s*=\s*".*"$/m, 'main = "worker/index.js"');

  // `[assets].directory` — source points at `./dist/client` (relative to
  // wrangler.toml). In the tarball, the SPA lives at `./client`.
  out = out.replace(
    /^directory\s*=\s*"\.\/dist\/client"$/m,
    'directory = "./client"',
  );

  // Source has `[alias]` entries pointing at `./src/server/shims/*` —
  // those source files are NOT shipped in the tarball (only the bundled
  // worker is), and the shims are already baked into `worker/index.js`.
  // Strip the [alias] block + its leading comment so wrangler doesn't
  // try to resolve missing source files at deploy time.
  out = out.replace(
    /# bun:sqlite is imported transitively[\s\S]*?\[alias\][\s\S]*?ldapts" = "\.\/src\/server\/shims\/ldapts-shim\.ts"\n/,
    "# Worker bundle already inlines bun:sqlite / nodemailer / ldapts shims —\n" +
      "# the source [alias] block is stripped by build-worker-template.ts.\n",
  );

  // APP_URL — points at the maintainer's worker subdomain.
  out = out.replace(
    /^APP_URL\s*=\s*".*"$/m,
    'APP_URL = "__APP_URL__"',
  );

  // R2 public base — per-account R2 dev URL.
  out = out.replace(
    /^R2_PUBLIC_BASE\s*=\s*".*"$/m,
    'R2_PUBLIC_BASE = "__R2_PUBLIC_BASE__"',
  );

  // D1 database_id — the only one inside the [[d1_databases]] block we
  // anchor by binding name so we don't accidentally rewrite a comment.
  out = out.replace(
    /(\[\[d1_databases\]\][^[]*?database_id\s*=\s*)"[^"]*"/s,
    '$1"__D1_DATABASE_ID__"',
  );

  // R2 bucket_name — the maintainer's `workeros-files` bucket is
  // account-scoped. Replace inside the [[r2_buckets]] block.
  out = out.replace(
    /(\[\[r2_buckets\]\][^[]*?bucket_name\s*=\s*)"[^"]*"/s,
    '$1"__R2_BUCKET_NAME__"',
  );

  // Banner so the cloud repo (or a curious human) immediately sees this
  // is a templated file, not the source of truth.
  const banner =
    "# AUTO-GENERATED by scripts/build-worker-template.ts.\n" +
    "# This is the wrangler.toml that ships inside the worker-template tarball.\n" +
    "# Tokens (__D1_DATABASE_ID__, __R2_BUCKET_NAME__, __APP_URL__,\n" +
    "# __R2_PUBLIC_BASE__) must be substituted by the provisioner before\n" +
    "# `wrangler deploy`. AUTH_SECRET / OPENAI_API_KEY / RESEND_API_KEY etc.\n" +
    "# remain Worker secrets — set them with `wrangler secret put` per\n" +
    "# customer, never inline them here.\n\n";

  return banner + out;
};

const collectMigrations = (): string[] => {
  const root = join(REPO_ROOT, "packages/db/drizzle/sqlite");
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => {
      const sub = join(root, name);
      if (!statSync(sub).isDirectory()) return false;
      return existsSync(join(sub, "migration.sql"));
    })
    .sort();
};

const copyMigrations = (
  destRoot: string,
): { name: string; path: string; sha256: string; bytes: number }[] => {
  const names = collectMigrations();
  const destDir = join(destRoot, "migrations/sqlite");
  mkdirSync(destDir, { recursive: true });
  const manifest: {
    name: string;
    path: string;
    sha256: string;
    bytes: number;
  }[] = [];
  for (const name of names) {
    const src = join(REPO_ROOT, "packages/db/drizzle/sqlite", name, "migration.sql");
    const destFile = join(destDir, `${name}.sql`);
    cpSync(src, destFile);
    const bytes = statSync(destFile).size;
    manifest.push({
      name,
      path: `migrations/sqlite/${name}.sql`,
      sha256: sha256OfFile(destFile),
      bytes,
    });
  }
  return manifest;
};

const gitSha = (): string => {
  try {
    return run("git", ["rev-parse", "HEAD"]);
  } catch {
    return "unknown";
  }
};

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2));

  console.log(`→ worker-template assembly (v${args.version})`);
  console.log(`  output dir: ${args.output}`);

  // 1. (Optional) build the SPA + worker bundle.
  if (args.build) {
    console.log("→ bun run build (vite)");
    // Bake the version into the bundle (vite.config `define` reads
    // TEMPLATE_VERSION) so the running instance can report it at GET /health.
    // Passed explicitly through `run` — see the env note there.
    run("bun", ["run", "build"], REPO_ROOT, { TEMPLATE_VERSION: args.version });
  } else {
    console.log("↷ skipping build (--no-build)");
  }

  const workerDist = join(REPO_ROOT, "apps/web/dist/backlex_admin");
  const clientDist = join(REPO_ROOT, "apps/web/dist/client");
  if (!existsSync(workerDist) || !existsSync(join(workerDist, "index.js"))) {
    throw new Error(
      `Expected ${relative(REPO_ROOT, workerDist)}/index.js — did the vite build emit the worker bundle? ` +
        `(Pass --no-build only when you've just run \`bun run build\` yourself.)`,
    );
  }
  if (!existsSync(clientDist) || !existsSync(join(clientDist, "index.html"))) {
    throw new Error(
      `Expected ${relative(REPO_ROOT, clientDist)}/index.html — the SPA bundle is missing.`,
    );
  }

  // 2. Stage into a clean directory.
  if (existsSync(args.output)) rmSync(args.output, { recursive: true });
  mkdirSync(args.output, { recursive: true });
  const stageDir = join(args.output, `workeros-app-worker-v${args.version}`);
  mkdirSync(stageDir, { recursive: true });

  // 2a. Worker entry + assets — copy the whole `backlex_admin/` minus the
  //     auto-emitted `wrangler.json` (it embeds the maintainer's IDs and
  //     we ship a clean `wrangler.template.toml` instead).
  console.log("→ copy worker bundle");
  cpSync(workerDist, join(stageDir, "worker"), {
    recursive: true,
    filter: (src) => !src.endsWith("wrangler.json"),
  });

  // 2b. SPA static assets.
  console.log("→ copy SPA client");
  cpSync(clientDist, join(stageDir, "client"), { recursive: true });

  // 3a. Migrations + manifest.
  console.log("→ copy sqlite migrations");
  const migrations = copyMigrations(stageDir);
  writeFileSync(
    join(stageDir, "migrations/manifest.json"),
    `${JSON.stringify(
      {
        dialect: "sqlite",
        count: migrations.length,
        migrations,
      },
      null,
      2,
    )}\n`,
  );

  // 3b. Templated wrangler.toml.
  console.log("→ emit wrangler.template.toml");
  writeFileSync(
    join(stageDir, "wrangler.template.toml"),
    buildWranglerTemplate(),
  );

  // 3c. meta.json.
  const bunVersion = (() => {
    try {
      return run("bun", ["--version"]);
    } catch {
      return "unknown";
    }
  })();
  const nodeVersion =
    typeof process.versions.node === "string"
      ? process.versions.node
      : "unknown";
  const meta = {
    name: "workeros-app-worker",
    version: args.version,
    gitSha: gitSha(),
    builtAt: new Date().toISOString(),
    bunVersion,
    nodeVersion,
    contents: {
      worker: "worker/index.js (+ worker/assets/**)",
      client: "client/**",
      migrations: "migrations/sqlite/*.sql + migrations/manifest.json",
      wranglerTemplate: "wrangler.template.toml",
    },
    placeholders: [
      "__D1_DATABASE_ID__",
      "__R2_BUCKET_NAME__",
      "__APP_URL__",
      "__R2_PUBLIC_BASE__",
    ],
  };
  writeFileSync(
    join(stageDir, "meta.json"),
    `${JSON.stringify(meta, null, 2)}\n`,
  );

  // 4. Tar + gzip. Use the system tar — every reasonable runner (Linux,
  //    macOS, modern Windows) has it, and it preserves mtimes + perms
  //    cleanly. `-C` so the archive root is the stageDir name, not the
  //    parent path.
  const tarball = join(args.output, `workeros-app-worker-v${args.version}.tar.gz`);
  console.log(`→ tar -czf ${relative(REPO_ROOT, tarball)}`);
  run("tar", [
    "-czf",
    tarball,
    "-C",
    args.output,
    `workeros-app-worker-v${args.version}`,
  ]);

  const tarballBytes = statSync(tarball).size;
  const tarballSha = sha256OfFile(tarball);
  console.log(
    `✓ ${relative(REPO_ROOT, tarball)}  (${(tarballBytes / 1024 / 1024).toFixed(2)} MiB)`,
  );
  console.log(`  sha256: ${tarballSha}`);
  console.log(`  migrations: ${migrations.length}`);
};

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
