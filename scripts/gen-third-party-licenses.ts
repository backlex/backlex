/**
 * Generate THIRD-PARTY-LICENSES.md — the production dependency tree and its
 * licences, as `bun.lock` resolves it.
 *
 * backlex ships under Apache-2.0 and had no third-party licence inventory at
 * all, which is the one document anyone doing due diligence asks for first.
 *
 * ## Why this does not just shell out to `bun pm licenses`
 *
 * It did, in the first version, and the result was wrong in a way that only
 * showed up once CI ran it on Linux: `bun pm licenses` reports what is
 * **installed**, and optional dependencies install only for the current host.
 * A Mac resolves `@img/sharp-libvips-darwin-arm64` and `fsevents`; a Linux
 * runner resolves `@img/sharp-libvips-linux-x64` and no `fsevents` at all. The
 * committed file was therefore macOS-flavoured — it listed packages that never
 * ship to production and omitted the ones that do, which for a document whose
 * whole purpose is "what do we distribute" is the wrong way round.
 *
 * Collapsing platform suffixes to `-<platform>` papered over the families that
 * are *named* by platform, but not over `fsevents`, which is simply
 * `{"os":"darwin"}` with an ordinary name.
 *
 * So the package set now comes from `bun.lock`, which records every resolution
 * on every platform and is identical on every machine. There are 410
 * host-conditional packages in the lockfile and only ~15 of them install here;
 * reading the lockfile is the only way to see the other 100-odd that a Linux or
 * Windows install would pull.
 *
 * ## How the production closure is walked
 *
 * Roots are each workspace's `dependencies` (and `optionalDependencies`);
 * `devDependencies` are excluded because they are not distributed. From there
 * it follows each package entry's own `dependencies` + `optionalDependencies`.
 *
 * Lockfile keys are npm-style resolution paths — `ws` is the hoisted copy and
 * `@libsql/isomorphic-ws/ws` is a nested different version — so a dependency is
 * resolved by walking up the importer's path, exactly as Node would. Getting
 * that wrong silently under-reports — and a shorter file still looks
 * plausible — so the walk is anchored against packages that are
 * unambiguously runtime deps (see `PRODUCTION_ANCHORS`).
 *
 * ## Where licences come from
 *
 * Installed packages: `bun pm licenses --prod --json`, which reads the real
 * package.json on disk. Everything else — the platform variants for hosts we
 * are not on — is looked up once from the npm registry. That is a bounded set
 * (roughly a hundred) and a lookup failure is recorded as
 * `Unknown (lookup failed)` rather than guessed from a sibling, because a
 * legal inventory that quietly infers is worse than one that admits a gap.
 *
 * Run:   `bun scripts/gen-third-party-licenses.ts`
 * Check: `bun scripts/gen-third-party-licenses.ts --check`
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const OUT = resolve(ROOT, "THIRD-PARTY-LICENSES.md");
const LOCK = resolve(ROOT, "bun.lock");

type LockEntry = [spec: string, registry: string, meta?: Record<string, unknown>, integrity?: string];
interface Lock {
  workspaces: Record<string, Record<string, unknown>>;
  packages: Record<string, LockEntry>;
}

/** Split a resolution path into package segments, keeping `@scope/name` whole. */
const segments = (key: string): string[] => {
  const parts = key.split("/");
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] as string;
    if (part.startsWith("@") && i + 1 < parts.length) {
      out.push(`${part}/${parts[i + 1]}`);
      i++;
    } else out.push(part);
  }
  return out;
};

/**
 * Resolve `dep` as imported from `importer`, the way Node would: try the
 * nearest node_modules first, then each parent, then the root.
 */
const resolveDep = (packages: Lock["packages"], importer: string, dep: string): string | null => {
  const segs = importer === "" ? [] : segments(importer);
  for (let depth = segs.length; depth >= 0; depth--) {
    const candidate = [...segs.slice(0, depth), dep].join("/");
    if (candidate in packages) return candidate;
  }
  return null;
};

const metaOf = (entry: LockEntry): Record<string, unknown> =>
  (entry.find((el) => el && typeof el === "object" && !Array.isArray(el)) as Record<string, unknown>) ?? {};

/** `name@version` from a lockfile spec, tolerating scoped names. */
const splitSpec = (spec: string): { name: string; version: string } => {
  const at = spec.lastIndexOf("@");
  return at <= 0 ? { name: spec, version: "" } : { name: spec.slice(0, at), version: spec.slice(at + 1) };
};

/**
 * Every package reachable from a workspace's runtime dependencies, on ANY
 * platform. Returns resolution-path -> {name, version}.
 */
const productionClosure = (lock: Lock): Map<string, { name: string; version: string }> => {
  const found = new Map<string, { name: string; version: string }>();
  const queue: Array<{ importer: string; dep: string }> = [];

  const pushDeps = (importer: string, deps: Record<string, string> | undefined) => {
    for (const dep of Object.keys(deps ?? {})) queue.push({ importer, dep });
  };

  for (const ws of Object.values(lock.workspaces)) {
    pushDeps("", ws.dependencies as Record<string, string>);
    pushDeps("", ws.optionalDependencies as Record<string, string>);
  }

  const seen = new Set<string>();
  while (queue.length > 0) {
    const { importer, dep } = queue.shift() as { importer: string; dep: string };
    const key = resolveDep(lock.packages, importer, dep);
    // A dependency with no lockfile entry is a workspace sibling already
    // covered by the workspace loop above, or an unmet optional peer.
    if (!key || seen.has(key)) continue;
    seen.add(key);

    const entry = lock.packages[key] as LockEntry;
    const spec = entry[0];
    // `foo@workspace:packages/foo` is ours, not third-party. Skip listing it,
    // but its own dependencies were already queued from lock.workspaces.
    if (!spec.includes("@workspace:")) found.set(key, splitSpec(spec));

    const meta = metaOf(entry);
    pushDeps(key, meta.dependencies as Record<string, string>);
    pushDeps(key, meta.optionalDependencies as Record<string, string>);
  }
  return found;
};

/** `name@version` -> licence, for everything installed on THIS host. */
const installedLicences = (): Map<string, string> => {
  const r = spawnSync("bun", ["pm", "licenses", "--prod", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
    // Well past spawnSync's 1 MB default. An overflow there is silent in the
    // worst way — status null, truncated stdout, empty stderr. See
    // packages/db/src/sqlite/migrate-d1.ts for the deploy loop that cost us.
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) {
    throw new Error(`bun pm licenses failed (status ${r.status}): ${r.stderr || "(no stderr)"}`);
  }
  const at = r.stdout.indexOf("{");
  if (at < 0) throw new Error(`no JSON in bun pm licenses output: ${r.stdout.slice(0, 200)}`);
  const groups = JSON.parse(r.stdout.slice(at)) as Record<
    string,
    Array<{ name: string; versions: string[] }>
  >;
  const map = new Map<string, string>();
  for (const [licence, entries] of Object.entries(groups)) {
    for (const e of entries) for (const v of e.versions) map.set(`${e.name}@${v}`, licence);
  }
  return map;
};

const normaliseLicence = (raw: unknown): string | null => {
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  if (raw && typeof raw === "object" && typeof (raw as { type?: string }).type === "string") {
    return (raw as { type: string }).type;
  }
  return null;
};

/** Licences for closure members this host did not install. Bounded (~100). */
const registryLicences = async (missing: string[]): Promise<Map<string, string>> => {
  const map = new Map<string, string>();
  const CONCURRENCY = 8;
  let cursor = 0;
  const worker = async () => {
    while (cursor < missing.length) {
      const id = missing[cursor++] as string;
      const { name, version } = splitSpec(id);
      // The name and version go straight into a URL path. They come from our
      // own committed lockfile, but "trusted input" is how path traversal gets
      // written — a name of `../../x` would silently address a different
      // registry path. Anything that is not a well-formed npm identifier is
      // recorded as unknown rather than fetched.
      if (!/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i.test(name) || !/^[\w.+-]+$/.test(version)) {
        map.set(id, "Unknown (unparseable package identifier)");
        continue;
      }
      // One retry: a single flaky lookup would otherwise change the generated
      // file and make `--check` fail for a reason unrelated to dependencies.
      let licence: string | null = null;
      for (let attempt = 0; attempt < 2 && licence === null; attempt++) {
        try {
          const res = await fetch(`https://registry.npmjs.org/${name}/${version}`, {
            headers: { accept: "application/json" },
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const body = (await res.json()) as { license?: unknown; licenses?: unknown };
          licence = normaliseLicence(body.license) ?? normaliseLicence(body.licenses) ?? "Unknown";
        } catch {
          if (attempt === 0) await Bun.sleep(500);
        }
      }
      // Never guess from a sibling. A legal inventory that quietly infers is
      // worse than one that admits a gap.
      map.set(id, licence ?? "Unknown (lookup failed)");
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, missing.length) }, worker));
  return map;
};

/**
 * Anchors the traversal against packages that are unambiguously production
 * dependencies of the server. If the resolution-path walk breaks, these are
 * the first things to vanish and nothing else would notice — the file would
 * simply get shorter and still look plausible.
 *
 * Deliberately NOT cross-checked against `bun pm licenses --prod`: that
 * command reports workspace `devDependencies` too (measured — it lists
 * `@electric-sql/pglite`, `drizzle-kit` and three `typescript` versions, all
 * declared under `devDependencies`), so treating it as ground truth would
 * force dev-only packages into a document about what we distribute. That is
 * exactly the over-reporting the first version of this file shipped.
 */
const PRODUCTION_ANCHORS = [
  "hono",
  "better-auth",
  "drizzle-orm",
  "zod",
  "@libsql/client",
  "sharp",
];

const assertAnchors = (closure: Map<string, { name: string; version: string }>) => {
  const names = new Set([...closure.values()].map((p) => p.name));
  const absent = PRODUCTION_ANCHORS.filter((a) => !names.has(a));
  if (absent.length > 0) {
    throw new Error(
      `production closure is missing known runtime dependencies (${absent.join(", ")}) — ` +
        "the lockfile walk is broken, not the lockfile",
    );
  }
};

const render = (byLicence: Map<string, string[]>, hostOnly: number): string => {
  const licences = [...byLicence.keys()].sort((a, b) => a.localeCompare(b));
  let total = 0;
  const body: string[] = [];
  for (const licence of licences) {
    const packages = (byLicence.get(licence) as string[]).sort((a, b) => a.localeCompare(b));
    total += packages.length;
    body.push(`### ${licence} (${packages.length})\n`);
    for (const p of packages) body.push(`- \`${p}\``);
    body.push("");
  }

  const unknown = licences
    .filter((l) => l.startsWith("Unknown"))
    .reduce((n, l) => n + (byLicence.get(l)?.length ?? 0), 0);
  const warning = unknown
    ? `\n> **${unknown} package${unknown === 1 ? "" : "s"} have no usable licence field.** They are listed under \`Unknown\` below. Treat that as "unreviewed", not "permissive" — someone has to read the actual repository before shipping against it.\n`
    : "";

  return `# Third-party licences

<!-- GENERATED by scripts/gen-third-party-licenses.ts — do not edit by hand. -->

backlex is Apache-2.0. This is the **production** dependency closure as
\`bun.lock\` resolves it, on **every platform** — not just the one this was
generated on. \`devDependencies\` are excluded because they are not
distributed.

It is deliberately read from the lockfile rather than from \`node_modules\`:
optional dependencies install only for the current host, so an installed-only
inventory lists a Mac's \`@img/sharp-libvips-darwin-arm64\` and \`fsevents\`
while omitting the \`linux-x64\` variants that actually ship. ${hostOnly} of the
entries below are not installed on any single machine at once.

Regenerate with \`bun scripts/gen-third-party-licenses.ts\`.

**${total} resolved package versions across ${licences.length} distinct licences.**
${warning}
${body.join("\n")}`;
};

const main = async () => {
  const lock = Bun.JSONC.parse(readFileSync(LOCK, "utf8")) as unknown as Lock;
  const closure = productionClosure(lock);
  const installed = installedLicences();
  assertAnchors(closure);

  const ids = [...new Set([...closure.values()].map((p) => `${p.name}@${p.version}`))];
  const missing = ids.filter((id) => !installed.has(id));
  const fetched = missing.length > 0 ? await registryLicences(missing) : new Map<string, string>();

  const byLicence = new Map<string, string[]>();
  for (const id of ids) {
    const licence = installed.get(id) ?? fetched.get(id) ?? "Unknown";
    const list = byLicence.get(licence) ?? [];
    list.push(id);
    byLicence.set(licence, list);
  }

  const next = render(byLicence, missing.length);

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
    console.log(`THIRD-PARTY-LICENSES.md is up to date (${ids.length} packages).`);
    return;
  }

  writeFileSync(OUT, next);
  console.log(`wrote ${OUT} — ${ids.length} packages, ${missing.length} resolved via the registry`);
};

await main();
