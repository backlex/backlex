/**
 * `backlex init [dir]` — scaffold a TypeScript consumer starter.
 *
 * Drops a self-contained `backlex.ts` (a client built from env vars) plus a
 * `.env.example`, so a new app can talk to a backlex instance immediately. It's
 * non-destructive: existing files are left untouched unless `--force`. The
 * scaffold uses the plain `createClient` so it compiles with zero codegen; the
 * printed next-steps show how to upgrade to the fully-typed client.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { has } from "./client";

const CLIENT_TS = `import { createClient } from "backlex";

/**
 * A backlex client built from environment variables. For server-to-server use
 * or scripts, set BACKLEX_API_KEY; browser apps rely on the cookie / workspace
 * session and should omit apiKey.
 */
export const backlex = createClient({
  url: process.env.BACKLEX_URL ?? "http://localhost:8787",
  apiKey: process.env.BACKLEX_API_KEY,
});

// Example — list rows from a collection:
//   const { data } = await backlex.from("posts").list({ limit: 10 });

// For full type-safety, generate types + a typed client:
//   backlex gen-types $BACKLEX_URL --sdk --out backlex.gen.ts
// then import { createTypedClient } from "./backlex.gen".
`;

const ENV_EXAMPLE = `# Copy to .env and fill in.
BACKLEX_URL=http://localhost:8787
# Server-to-server / scripts only — leave blank for browser (cookie session) apps.
BACKLEX_API_KEY=
`;

const FILES: Record<string, string> = {
  "backlex.ts": CLIENT_TS,
  ".env.example": ENV_EXAMPLE,
};

export const runInit = (args: string[]): void => {
  const dir = args.find((a) => !a.startsWith("-")) ?? ".";
  const force = has(args, "--force");

  mkdirSync(dir, { recursive: true });

  const conflicts = Object.keys(FILES).filter((f) => existsSync(join(dir, f)));
  if (conflicts.length && !force) {
    process.stderr.write(
      `init: refusing to overwrite existing file(s): ${conflicts.join(", ")} (use --force)\n`,
    );
    process.exit(1);
  }

  for (const [name, content] of Object.entries(FILES)) {
    writeFileSync(join(dir, name), content, "utf8");
  }

  process.stderr.write(
    `✓ scaffolded ${Object.keys(FILES).join(", ")} in ${dir}\n\n` +
      "Next:\n" +
      "  1. bun add backlex            # or npm/pnpm/yarn\n" +
      "  2. cp .env.example .env       # set BACKLEX_URL (+ BACKLEX_API_KEY)\n" +
      "  3. backlex login --url $BACKLEX_URL --key $BACKLEX_API_KEY\n" +
      "  4. backlex gen-types $BACKLEX_URL --sdk --out backlex.gen.ts   # typed client\n",
  );
};
