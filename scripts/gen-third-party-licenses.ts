/**
 * Generate THIRD-PARTY-LICENSES.md from the resolved lockfile.
 *
 * backlex ships under Apache-2.0 and had no third-party licence inventory at
 * all, which is the one document anyone doing due diligence asks for first.
 *
 * Source of truth is `bun pm licenses --prod --json`, i.e. what the lockfile
 * actually RESOLVED, not what a package.json asked for — the same distinction
 * that `apps/web/tests/vite-pin-lockfile.test.ts` exists to enforce elsewhere.
 * `--prod` because devDependencies are not distributed.
 *
 * Two things are deliberately dropped from Bun's JSON before it is written:
 *
 *  - `paths`, which are absolute and machine-local
 *    (`/Users/<someone>/Projects/...`). Committing those would make the file
 *    differ per developer and leak a local directory layout for no benefit.
 *  - author/description/homepage, which add churn without adding legal signal.
 *
 * What remains is licence -> package@version, sorted and de-duplicated, so a
 * real dependency change is the only ordinary reason for the diff to move.
 * (The one remaining source of host variance is optional platform packages —
 * see `collapsePlatform` and the note on `--check` below.)
 *
 * Run: `bun scripts/gen-third-party-licenses.ts`
 * Check: `bun scripts/gen-third-party-licenses.ts --check`
 *
 * `--check` is deliberately NOT a blocking CI step. `bun pm licenses` reports
 * what is *installed*, and optional platform packages install only for the
 * host — a Linux runner resolves a different set of `@img/sharp-*` and
 * `@rolldown/binding-*` entries than a Mac does. Collapsing the platform
 * suffix (below) removes most of that, but not the possibility that one host
 * simply installs a different NUMBER of optional packages. A gate that fails
 * for a reason unrelated to what it guards trains people to ignore it, so the
 * supply-chain workflow runs this advisorily and reports the diff instead.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

interface Entry {
  name: string;
  versions: string[];
  license: string;
}

const ROOT = resolve(import.meta.dir, "..");
const OUT = resolve(ROOT, "THIRD-PARTY-LICENSES.md");

/** `bun pm licenses` prints an env-loading trace line before its payload, so
 *  the JSON never starts at byte 0. Slice from the first brace rather than
 *  trying to predict how many lines of preamble there are. */
const jsonTail = (raw: string): string => {
  const at = raw.indexOf("{");
  if (at < 0) throw new Error(`no JSON in output: ${raw.slice(0, 200)}`);
  return raw.slice(at);
};

const collect = (): Record<string, Entry[]> => {
  const r = spawnSync("bun", ["pm", "licenses", "--prod", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
    // The full production tree is well past spawnSync's 1 MB default, and an
    // overflow there is silent in the worst way — `status: null`, truncated
    // stdout, empty stderr. See packages/db/src/sqlite/migrate-d1.ts for the
    // deploy loop that cost us.
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) {
    throw new Error(`bun pm licenses failed (status ${r.status}): ${r.stderr || "(no stderr)"}`);
  }
  return JSON.parse(jsonTail(r.stdout)) as Record<string, Entry[]>;
};

/**
 * Collapse a prebuilt-binary package's platform suffix.
 *
 * `bun pm licenses` reports what is INSTALLED, and optional platform packages
 * only install for the current host — so this machine sees
 * `@img/sharp-libvips-darwin-arm64` where a Linux CI runner sees
 * `@img/sharp-libvips-linux-x64`. Left alone, the generated file would differ
 * per developer and `--check` would fail on every runner that is not a Mac.
 *
 * The licence of a prebuilt binary does not vary by architecture, so folding
 * the variants into one `…-<platform>` entry keeps the legal signal intact and
 * makes the output host-independent. Anything that is not a recognised
 * platform triple is left exactly as it is — this must not quietly rewrite a
 * real package name that happens to end in `-arm64`.
 */
const PLATFORM_SUFFIX =
  /-(darwin|linux|linuxmusl|win32|freebsd|android|wasm32)-(x64|arm64|arm|ia32|riscv64|s390x|ppc64|wasm32)(-(musl|gnu|gnueabihf|glibc|msvc))?$/;
const collapsePlatform = (name: string): string =>
  PLATFORM_SUFFIX.test(name) ? `${name.replace(PLATFORM_SUFFIX, "")}-<platform>` : name;

const render = (groups: Record<string, Entry[]>): string => {
  const licenses = Object.keys(groups).sort((a, b) => a.localeCompare(b));
  let total = 0;
  const body: string[] = [];

  for (const license of licenses) {
    const packages = [
      ...new Set(
        (groups[license] ?? []).flatMap((e) =>
          e.versions.map((v) => `${collapsePlatform(e.name)}@${v}`),
        ),
      ),
    ].sort((a, b) => a.localeCompare(b));
    total += packages.length;
    body.push(`### ${license} (${packages.length})\n`);
    for (const p of packages) body.push(`- \`${p}\``);
    body.push("");
  }

  const unknown = (groups.Unknown ?? []).length;
  const warning = unknown
    ? `\n> **${unknown} package${unknown === 1 ? "" : "s"} declare no licence field.** They are listed under \`Unknown\` below. Treat that as "unreviewed", not "permissive" — someone has to read the actual repository before shipping against it.\n`
    : "";

  return `# Third-party licences

<!-- GENERATED by scripts/gen-third-party-licenses.ts — do not edit by hand. -->

backlex is Apache-2.0. This lists the licences of the **production** dependency
tree as the lockfile resolves it (\`bun pm licenses --prod\`), which is not the
same as what any package.json asks for. devDependencies are excluded because
they are not distributed.

Regenerate with \`bun scripts/gen-third-party-licenses.ts\`.

**${total} resolved package versions across ${licenses.length} distinct licences.**
${warning}
${body.join("\n")}`;
};

const next = render(collect());

if (process.argv.includes("--check")) {
  const current = (() => {
    try {
      return readFileSync(OUT, "utf8");
    } catch {
      return "";
    }
  })();
  if (current !== next) {
    console.error(
      "THIRD-PARTY-LICENSES.md is out of date — run `bun scripts/gen-third-party-licenses.ts` and commit the result.",
    );
    process.exit(1);
  }
  console.log("THIRD-PARTY-LICENSES.md is up to date.");
} else {
  writeFileSync(OUT, next);
  console.log(`wrote ${OUT}`);
}
