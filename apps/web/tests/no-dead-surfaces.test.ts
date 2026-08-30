/**
 * Dead surface is unaudited surface.
 *
 * Every isolation break this branch fixed lived in code that was shipped and
 * then never looked at again — an endpoint nobody calls is an endpoint nobody
 * reviews, and the audit that eventually finds it is a security audit rather
 * than a code review. Two earlier phases found the same shape from the other
 * side: an admin screen that displayed a full permission matrix and saved none
 * of it, and an SDK/GraphQL/MCP/CLI operation with no admin affordance at all.
 *
 * So this file asks two questions the type-checker cannot:
 *
 *   1. Is every module under `apps/web/src` REACHED by something that runs?
 *   2. Is every `/api` endpoint the app registers NAMED by something that
 *      calls it — the admin SPA, the SDK, the CLI, an MCP tool, a doc, a test?
 *
 * ── What kind of check this is ──────────────────────────────────────────────
 *
 * The endpoint inventory is EXACT: it comes from `h.app.routes`, the table the
 * real Hono app built at mount time, so it cannot drift from what is actually
 * served. `route-plane-registry.test.ts` reads the same table for the same
 * reason.
 *
 * The consumer side is a SOURCE SCAN, and says so. A caller composes its URL
 * from a helper and an interpolation — `tm(`/sites/${id}/tags`)` in the admin
 * client, `${BASE}/import` in the CLI — so no literal anywhere in the repo ever
 * spells a mounted path out in full. The scan therefore matches a path's
 * SUFFIX with parameters treated as wildcards. That is deliberately generous:
 * this file is tuned to report an endpoint dead only when it really is, and it
 * will miss one whose tail collides with a live route. A guard nobody can keep
 * green gets disabled, which is worse than one that under-reports.
 *
 * Where the scan is known to be blind, that is written down in
 * SCAN_BLIND_SPOTS with the caller and a probe string — so the claim decays
 * loudly instead of quietly.
 *
 * ── Why matching nothing is a FAILURE here ──────────────────────────────────
 *
 * The house bug in this repo is a matcher that matches nothing and reports
 * success. Both halves are armed against it three ways: the inventories must
 * be large (a route table that failed to build, or a corpus that failed to
 * read, fails the spec rather than passing it vacuously); a path that IS
 * consumed must be seen as consumed; and a fabricated path that exists nowhere
 * must be reported dead by the same matcher that clears the real ones. If the
 * matcher ever degrades into "everything matches", that last control fails.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { makeHarness, type TestHarness } from "./setup";

const ROOT = resolve(import.meta.dir, "../../..");
const WEB = join(ROOT, "apps/web");
const SRC = join(WEB, "src");

/** Files, recursively, filtered by extension. `node_modules` never enters. */
const walk = (dir: string, match: RegExp, out: string[] = []): string[] => {
  let entries: { name: string; isDirectory(): boolean }[];
  try {
    entries = readdirSync(dir, { withFileTypes: true }) as never;
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      walk(p, match, out);
    } else if (match.test(e.name)) out.push(p);
  }
  return out;
};

const read = (f: string): string => {
  try {
    return readFileSync(f, "utf8");
  } catch {
    return "";
  }
};

const rel = (f: string): string => f.slice(ROOT.length + 1);

// ───────────────────────────────────────────────────────────────────────────
// 1. Module reachability
// ───────────────────────────────────────────────────────────────────────────

const CODE = /\.(ts|tsx)$/;

/**
 * Ambient declarations are excluded: nothing imports a `.d.ts`, and what pulls
 * one in is tsconfig `include` — a compiler input, not a call.
 */
const srcFiles = walk(SRC, CODE).filter(
  (f) => !f.endsWith(".d.ts") && !f.includes("/locales/"),
);

/**
 * Everything that can name a source file, not only things that `import` one.
 *
 * Three mechanisms in this repo reach a module without an import statement,
 * and treating any of them as an allowlist entry rather than as a graph edge
 * would let the next orphan hide behind the same excuse:
 *
 *  - `vite.config.ts` aliases a bare package specifier at a shim under
 *    `src/server/shims/` (the lazy-native-dependency pattern), naming it with
 *    `new URL("./src/server/shims/x.ts", import.meta.url)`.
 *  - `services/sandbox/providers/bun-worker.ts` boots its guest with
 *    `new URL("../worker-entry.ts", import.meta.url)` — a Worker entry, which
 *    is never imported by anything.
 *  - `scripts/gen-consent-banner.ts` compiles `src/client/consent-banner/`
 *    into a checked-in bundle, naming the entry by a repo-relative string.
 */
const rootFiles = [
  ...walk(join(SRC, "server/entries"), CODE),
  join(SRC, "client/main.tsx"),
  ...walk(join(WEB, "tests"), CODE),
  join(WEB, "vite.config.ts"),
  ...walk(join(ROOT, "scripts"), CODE),
];

const EXT = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];
const resolveTo = (candidate: string): string | null => {
  for (const e of EXT) {
    const c = candidate + e;
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
};

/** Marks a specifier that is repo-root-relative rather than module-relative. */
const REPO_REL = "repo-relative:";

/** Every specifier one file names, resolved to a file under `apps/web/src`. */
const edgesFrom = (file: string, src: string): string[] => {
  const specs: string[] = [];
  try {
    specs.push(...new Bun.Transpiler({ loader: "tsx" }).scanImports(src).map((i) => i.path));
  } catch {
    // A file Bun cannot parse still gets the regex sweep below.
  }
  for (const m of src.matchAll(/(?:from|import\(|require\()\s*["'`]([^"'`]+)["'`]/g)) {
    specs.push(m[1] as string);
  }
  // `new URL("./x.ts", import.meta.url)` — Workers and worker entries.
  for (const m of src.matchAll(/new URL\(\s*["'`]([^"'`]+)["'`]/g)) specs.push(m[1] as string);
  // A repo-root-relative path named as a plain string, which is how the build
  // scripts and `vite.config.ts` point at sources.
  for (const m of src.matchAll(/["'`](?:\.\/)?(apps\/web\/src\/[^"'`]+)["'`]/g)) {
    specs.push(REPO_REL + (m[1] as string));
  }
  for (const m of src.matchAll(/["'`]\.\/(src\/[^"'`]+)["'`]/g)) {
    specs.push(`${REPO_REL}apps/web/${m[1] as string}`);
  }

  const out: string[] = [];
  for (const spec of specs) {
    let base: string | null = null;
    if (spec.startsWith(REPO_REL)) base = join(ROOT, spec.slice(REPO_REL.length));
    else if (spec.startsWith(".")) base = resolve(dirname(file), spec);
    else if (spec.startsWith("@/")) base = join(SRC, "client", spec.slice(2));
    if (!base) continue;
    const hit = resolveTo(base);
    if (hit?.startsWith(`${SRC}/`)) out.push(hit);
  }
  return out;
};

/**
 * Modules that are genuinely unreachable and deliberately kept.
 *
 * Empty on purpose. An entry here is a promise that something calls the module
 * in a way this graph cannot see; write down WHAT, or delete the module.
 */
const KEPT_UNREACHABLE: Record<string, string> = {};

describe("dead surfaces — modules", () => {
  const cache = new Map<string, string>();
  const srcOf = (f: string): string => {
    let s = cache.get(f);
    if (s === undefined) {
      s = read(f);
      cache.set(f, s);
    }
    return s;
  };

  const seen = new Set<string>();
  const stack = rootFiles.filter((f) => existsSync(f));
  while (stack.length) {
    const f = stack.pop() as string;
    if (seen.has(f)) continue;
    seen.add(f);
    for (const d of edgesFrom(f, srcOf(f))) if (!seen.has(d)) stack.push(d);
  }

  const unreachable = srcFiles.filter((f) => !seen.has(f)).map(rel).sort();

  test("the graph actually walked the app (a vacuous pass would look identical)", () => {
    // Every assertion below is trivially true over an empty graph, which is
    // exactly how a source scan reports success while checking nothing.
    expect(srcFiles.length).toBeGreaterThan(700);
    expect(seen.size).toBeGreaterThan(700);
    expect(rootFiles.filter((f) => existsSync(f)).length).toBeGreaterThan(400);
    // And it must have walked THROUGH imports, not merely listed the roots.
    expect(seen.has(join(SRC, "server/app.ts"))).toBe(true);
    expect(seen.has(join(SRC, "server/context.ts"))).toBe(true);
    expect(seen.has(join(SRC, "client/admin/queries.ts"))).toBe(true);
  });

  test("the non-import reach mechanisms are edges, not excuses", () => {
    // Each of these is reached only by `new URL(...)` or by a build script
    // naming a path. If the graph stopped following those, this file would
    // start reporting live modules as dead and someone would delete one.
    expect(seen.has(join(SRC, "server/shims/pg-shim.ts"))).toBe(true);
    expect(seen.has(join(SRC, "server/services/sandbox/worker-entry.ts"))).toBe(true);
    expect(seen.has(join(SRC, "client/consent-banner/render.ts"))).toBe(true);
  });

  test("a module nothing names is NOT reachable (positive control)", () => {
    // The control this repo's own failure mode demands: prove the walk can
    // still say no. A path that exists nowhere must never come back reachable.
    expect(seen.has(join(SRC, "server/this-module-does-not-exist.ts"))).toBe(false);
  });

  test("every module under apps/web/src is reached by something that runs", () => {
    const orphans = unreachable.filter((f) => !(f in KEPT_UNREACHABLE));
    expect(
      orphans,
      "these modules are shipped but nothing reaches them.\n" +
        "Delete them, or — if something does reach them in a way this graph cannot see —\n" +
        `add that mechanism as an EDGE in edgesFrom(), not as an allowlist entry:\n${orphans.join("\n")}`,
    ).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 2. Endpoint reachability
// ───────────────────────────────────────────────────────────────────────────

/**
 * Everything that could name an endpoint: the admin SPA, the suite, the
 * published SDK and CLI, the MCP tools, the server's own internal callers, the
 * docs, and the example apps.
 */
const affordanceFiles = (): string[] =>
  [
    ...walk(join(SRC, "client"), /\.(ts|tsx)$/),
    ...walk(join(ROOT, "packages"), /\.(ts|tsx|md)$/),
    ...walk(join(ROOT, "docs"), /\.mdx?$/),
    ...walk(join(ROOT, "examples"), /\.(ts|tsx|md)$/),
    ...walk(join(SRC, "server/mcp"), /\.ts$/),
    ...walk(join(SRC, "server/services"), /\.ts$/),
    ...walk(join(SRC, "server/middleware"), /\.ts$/),
    ...walk(join(SRC, "server/lib"), /\.ts$/),
  ].filter((f) => !f.includes("/locales/"));

const specFiles = (): string[] =>
  walk(join(WEB, "tests"), /\.(ts|tsx)$/).filter(
    // This file is not a consumer. Its ledgers below spell the dead paths out
    // in full, so counting it would let every entry justify itself.
    (f) => f !== import.meta.path,
  );

const joinAll = (files: string[]): string => files.map(read).join("\n");

/**
 * A path segment, as a regex over source text: one segment of anything, which
 * also matches a `${...}` interpolation.
 */
const PARAM_SEG = "(?:\\$\\{[^}]*\\}|[^/\"'\\s`?#]+)";

/** Hono spells parameters `:id`, `:key{.+}`, `{siteId}` and `*`. All wildcard. */
const isParam = (seg: string): boolean =>
  seg.startsWith(":") || seg.startsWith("*") || seg.startsWith("{");

const suffixRe = (segs: string[]): RegExp =>
  new RegExp(
    `/${segs
      .map((s) => (isParam(s) ? PARAM_SEG : s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
      .join("/")}(?![\\w-])`,
  );

/**
 * Is this path named anywhere?
 *
 * Tried longest-first: the whole path, then every shorter suffix, down to two
 * segments and never starting on a parameter. Both floors matter, and for the
 * same reason — a matcher that matches everything is the same bug as one that
 * matches nothing, it just wears a green tick. A one-segment suffix like
 * `/list` matches half the repo; a suffix that OPENS on a wildcard, like
 * `/:siteId/variables`, matches every `/anything/variables` in it.
 */
const namedIn = (blob: string, path: string): boolean => {
  const segs = path.split("/").filter(Boolean);
  for (let i = 0; i + 2 <= segs.length; i++) {
    if (isParam(segs[i] as string)) continue;
    if (suffixRe(segs.slice(i)).test(blob)) return true;
  }
  return false;
};

/**
 * Endpoints this scan cannot see a caller for, where a caller DOES exist.
 *
 * Not an excuse list: each entry names the consumer and a `probe` that must
 * still be present in the corpus, so an entry cannot outlive the thing it
 * claims. The probes are checked below.
 */
const SCAN_BLIND_SPOTS: Record<string, { consumer: string; probe: string }> = {
  "GET /api/scim/v2/Schemas": {
    consumer:
      "scim-routes.test.ts drives it by its route-local one-segment path, which is " +
      "below this scan's two-segment floor.",
    probe: '["/ResourceTypes", "/Schemas"]',
  },
  "POST /api/admin/signing-keys/import": {
    consumer: `packages/cli — \`backlex signing-keys import\`, built as \`\${BASE}/import\`.`,
    probe: "signing-keys import --file",
  },
  "POST /api/vector/upsert": {
    consumer: `packages/client — \`vector.upsert()\`, built as \`\${base}/upsert\`.`,
    probe: `\`\${base}/upsert\``,
  },
  "POST /api/vector/delete": {
    consumer: `packages/client — \`vector.delete()\`, built as \`\${base}/delete\`.`,
    probe: `\`\${base}/delete\``,
  },
};

/** One reason, shared by the four routes of the same unreachable resource. */
const TAG_VARIABLES =
  "Tag-manager VARIABLES: a whole admin-gated CRUD resource with no reader. The tag-manager " +
  "admin page never mentions the word, `tagManagerApi` has no method for it, and no SDK, CLI " +
  "or MCP surface covers it — while docs/tag-manager.md tells operators triggers can test " +
  "variables and that a site may hold 200 of them. The compiler and the service ARE covered " +
  "(`tag-manager.test.ts` calls `createVariable` directly), so the feature works; only the " +
  "way a human reaches it is missing — the same shape Phase 7 found in the role editor. " +
  "Deleting these routes would remove a documented capability outright, so they are kept: " +
  "the fix is an affordance on the tag-manager page, and it belongs to that feature's owner.";

/**
 * Endpoints that really have no consumer, kept rather than deleted, each with
 * the reason and what would resolve it. Reported out of Phase 9 of the
 * identity-containment branch; none is a defect this file can fix on its own.
 */
const KEPT_UNCONSUMED: Record<string, string> = {
  "GET /api/admin/erasure/surfaces":
    "No admin affordance, no SDK method, no CLI verb, no MCP tool — the only thing that " +
    "names it at all is the route table in docs/erasure.md. It answers three constant lists " +
    "describing what an erasure run reaches and what it cannot, so the risk here is a stale " +
    "promise about a legal obligation rather than a write. Kept because it is a documented, " +
    "admin-gated OpenAPI operation an external caller may already depend on; showing those " +
    "limits on the erasure screen is the fix, not deletion.",
  "POST /api/storage/_backfill-folders":
    "No caller of any kind. A one-shot admin sweep that walks every NULL-folder file in the " +
    "workspace in one unbounded synchronous pass and writes to all of them — the sibling " +
    "`_split-buckets` route's own comment cites it as the shape not to imitate. Kept because " +
    "it is a documented OpenAPI operation an operator runbook may invoke by hand; it needs a " +
    "cursor and a dry run like its sibling has, or removal by its owner.",
  "GET /api/admin/tag-manager/sites/:siteId/variables": TAG_VARIABLES,
  "POST /api/admin/tag-manager/sites/:siteId/variables": TAG_VARIABLES,
  "PATCH /api/admin/tag-manager/variables/:id": TAG_VARIABLES,
  "DELETE /api/admin/tag-manager/variables/:id": TAG_VARIABLES,
};

describe("dead surfaces — endpoints", () => {
  let h: TestHarness;
  let endpoints: string[] = [];
  /** Everything that could name an endpoint, the suite included. */
  let blob = "";
  /**
   * The same corpus MINUS the suite.
   *
   * A KEPT_UNCONSUMED entry claims nobody can REACH the endpoint — no screen,
   * no SDK method, no CLI verb, no MCP tool. A spec naming the path is not an
   * affordance, and neither is a sibling guard that happens to enumerate it in
   * its own ledger; checking those claims against the full corpus would let one
   * inventory silently vouch for another.
   */
  let affordances = "";

  beforeAll(() => {
    h = makeHarness();
    const table = (h.app as unknown as { routes: { method: string; path: string }[] }).routes;
    const uniq = new Set<string>();
    for (const r of table) {
      // Hono records one row per registered handler, so the middleware chain
      // shows up as bare wildcards. Those are not endpoints.
      if (r.path === "*" || r.path === "/*" || r.method === "ALL") continue;
      // OPTIONS is CORS plumbing, never a surface anyone calls by name.
      if (r.method === "OPTIONS") continue;
      if (!r.path.startsWith("/api/")) continue;
      uniq.add(`${r.method} ${r.path}`);
    }
    endpoints = [...uniq].sort();
    affordances = joinAll(affordanceFiles());
    blob = `${affordances}\n${joinAll(specFiles())}`;
  });

  afterAll(() => h.cleanup?.());

  test("the route table and both corpora actually loaded", () => {
    // Any one of these coming back empty would make every check below pass.
    expect(endpoints.length).toBeGreaterThan(400);
    expect(affordances.length).toBeGreaterThan(3_000_000);
    expect(blob.length).toBeGreaterThan(affordances.length + 1_000_000);
    expect(endpoints).toContain("GET /api/collections");
  });

  test("a path that IS consumed reads as consumed, and one that is not does not", () => {
    // Both directions, because a matcher that always says yes and one that
    // always says no are equally green when only one direction is checked.
    expect(namedIn(blob, "/api/collections/:collection/fields")).toBe(true);
    expect(namedIn(blob, "/api/items/:collection")).toBe(true);
    expect(namedIn(blob, "/api/no-such-resource/:id/no-such-action")).toBe(false);
    expect(namedIn(blob, "/api/storage/definitely-not-mounted-anywhere")).toBe(false);
  });

  test("every registered /api endpoint is named by something that could call it", () => {
    const dead = endpoints.filter((e) => {
      if (e in KEPT_UNCONSUMED || e in SCAN_BLIND_SPOTS) return false;
      return !namedIn(blob, e.slice(e.indexOf(" ") + 1));
    });
    expect(
      dead,
      "these endpoints are mounted and served, but no admin screen, SDK method, CLI\n" +
        "command, MCP tool, doc or test names them. Dead surface is unaudited surface —\n" +
        `wire it up, delete it, or record the reason in KEPT_UNCONSUMED:\n${dead.join("\n")}`,
    ).toEqual([]);
  });

  test("both ledgers describe endpoints the app still serves", () => {
    // An entry left behind after its route is deleted turns the ledger into
    // folklore, and the next reader believes it.
    const stale = [...Object.keys(KEPT_UNCONSUMED), ...Object.keys(SCAN_BLIND_SPOTS)].filter(
      (e) => !endpoints.includes(e),
    );
    expect(stale, "these ledger entries name endpoints the app no longer serves").toEqual([]);
  });

  test("every KEPT_UNCONSUMED entry still has no affordance", () => {
    // The other direction: once someone wires one up, the excuse has to go, or
    // the ledger starts hiding a real regression behind a stale reason.
    const nowReachable = Object.keys(KEPT_UNCONSUMED).filter((e) =>
      namedIn(affordances, e.slice(e.indexOf(" ") + 1)),
    );
    expect(
      nowReachable,
      "these can now be reached from a screen, an SDK, a CLI or an MCP tool —\n" +
        "delete their KEPT_UNCONSUMED entries",
    ).toEqual([]);
  });

  test("every SCAN_BLIND_SPOTS entry still points at a caller that exists", () => {
    // A blind-spot entry is a claim about code somewhere else. When that code
    // moves, the entry must fail rather than keep vouching for the endpoint.
    const broken = Object.entries(SCAN_BLIND_SPOTS)
      .filter(([, v]) => !blob.includes(v.probe))
      .map(([k, v]) => `${k} — probe not found: ${v.probe}`);
    expect(
      broken,
      "the caller these entries name has moved. Re-point the probe, or move the\n" +
        "endpoint to KEPT_UNCONSUMED because it is now genuinely dead",
    ).toEqual([]);
  });
});
