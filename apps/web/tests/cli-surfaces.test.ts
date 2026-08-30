/**
 * Whether a subsystem reaches the CLI is a decision, and this is where it is
 * written down — plus the half the older ledgers leave out.
 *
 * `sdk-surfaces.test.ts` keeps the same ledger for the SDK and
 * `graphql-surfaces.test.ts` for GraphQL. `cli-release-drift.test.ts` is the
 * neighbour, not the duplicate: it compares the command list this build offers
 * against the one npm's `@backlex/cli` actually published, and cares only
 * about whether a release is owed. Nothing checks whether a command the CLI
 * ADVERTISES does anything, and that is the gap this file exists for.
 *
 * The gap is not theoretical. Four surfaces on this branch returned 2xx and
 * did nothing — MCP `users.invite` accepted a `roleName` it never read, MCP
 * `tenants.switch` accepted `{tenantId}` when the handler wanted `{tenant}`,
 * MCP settings accepted `brandName`/`flags` it dropped, and an admin menu item
 * called `pushToast` and issued no request. A name-to-name ledger passes on
 * every one. The CLI has exactly the same failure available to it, in three
 * shapes: a command in the help text that the dispatcher does not handle, a
 * subcommand a module advertises and does not implement, and a `--flag`
 * documented in the help and read by nobody.
 *
 * So four checks, weakest first, each saying what it is worth:
 *
 *   1. NAME parity   — `CLI_SURFACES` answers for every MCP tool module, both
 *                      directions.
 *   2. WIRING        — every `run*` a command module exports is imported by
 *                      `bin/backlex.ts` AND called from it, and every command
 *                      the root help offers has a `case` that reaches one.
 *   3. THE HELP TEXT IS TRUE — every subcommand a module advertises is
 *                      dispatched by that module, and every `--flag` it
 *                      documents is read by it. This is the check that fails
 *                      on `roleName`.
 *   4. EXECUTION     — two commands are run as the real binary against a real
 *                      listener and their effect is read back over REST, so a
 *                      zero exit code is not mistaken for work done.
 *
 * The first three are SOURCE SCANS over the CLI's own text (`typescript` here
 * is 7.0's Go port and ships no compiler API, so there is no parse to reach
 * for). Every one of them is bounded below in the sanity test: a regex that
 * stops matching empties the list it feeds, and an assertion over an empty
 * list is a green tick for work nobody did.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import { OPEN_WAVE } from "./surfaces-wave";

const REPO = join(import.meta.dir, "..", "..", "..");
const CLI = join(REPO, "packages", "cli");
const CLI_SRC = join(CLI, "src");
const CLI_BIN = join(CLI, "bin", "backlex.ts");
const MCP_DIR = join(REPO, "apps", "web", "src", "server", "mcp", "tools");

const read = (p: string) => readFileSync(p, "utf8");

// ---------------------------------------------------------------------------
// What the CLI's source says it offers
// ---------------------------------------------------------------------------

const binSrc = read(CLI_BIN);
const rootHelp = read(join(CLI_SRC, "help.ts"));
const clientSrc = read(join(CLI_SRC, "client.ts"));

/**
 * The body of every `const <X>HELP = \`…\`` in a module.
 *
 * Read by hand rather than by importing the module: importing `bin/backlex.ts`
 * dispatches a command, and several command modules read `process.argv` at
 * import time. The escape handling matters — every module's help quotes other
 * commands in backticks (`\`tenants members\``), so a naive `[^`]*` match stops
 * at the first one and silently truncates the text this file asserts over.
 */
const helpBodies = (src: string): string[] => {
  const out: string[] = [];
  for (const m of src.matchAll(/^const \w*HELP\s*=\s*`/gm)) {
    let i = (m.index ?? 0) + (m[0] as string).length;
    let body = "";
    while (i < src.length) {
      const ch = src[i] as string;
      if (ch === "\\") {
        body += src[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (ch === "`") break;
      body += ch;
      i += 1;
    }
    out.push(body);
  }
  return out;
};

type CliModule = {
  name: string;
  /** Source with the help templates removed, so a flag NAMED in the help does
   *  not read as a flag the code READS. That distinction is the whole check. */
  code: string;
  help: string;
  /** `runTenants` etc. */
  runs: string[];
  /** Subcommands the first line of the help offers: `backlex x <a|b|c>`. */
  advertised: string[];
  /** Flags the help documents on a line of their own or inside `[--x …]`. */
  documented: string[];
  /** Every `--flag` mentioned anywhere in the help, including inside a usage
   *  line. Looser, and used only for the "is it documented" direction. */
  mentioned: Set<string>;
  /** Flags the module reads through `flag(args, …)` / `has(args, …)`. */
  readFlags: string[];
};

/** Metasyntactic placeholders — `backlex schema <command>` names no command. */
const PLACEHOLDER = new Set(["cmd", "command", "options", "args", "subcommand", "sub"]);

const cliModules: CliModule[] = readdirSync(CLI_SRC)
  .filter((f) => f.endsWith(".ts"))
  .map((f) => {
    const name = f.slice(0, -3);
    const src = read(join(CLI_SRC, f));
    const help = helpBodies(src).join("\n");
    const code = src.replace(/^const \w*HELP\s*=\s*`[\s\S]*?[^\\]`/gm, "");
    const documented = new Set<string>();
    const mentioned = new Set<string>();
    for (const line of help.split("\n")) {
      const lead = /^(--[a-z][\w-]*)/.exec(line.trim());
      if (lead) documented.add(lead[1] as string);
      for (const b of line.matchAll(/\[(--[a-z][\w-]*)/g)) documented.add(b[1] as string);
      for (const b of line.matchAll(/(--[a-z][\w-]*)/g)) mentioned.add(b[1] as string);
    }
    // Read from the HEADER line only — `backlex tenants <list|switch|…>` —
    // and not from the indented body. That is a deliberate under-read and it
    // is the weaker half of this file: a subcommand described in the body and
    // absent from the header is not checked. The alternative was matching the
    // first word of every indented line, which cannot tell a subcommand from
    // the second line of a wrapped sentence, and a check that reports
    // imaginary gaps is one people learn to ignore. 245 subcommands across 40
    // modules are covered this way; the floor in the sanity test is what keeps
    // it from quietly becoming none.
    const advertised = new Set<string>();
    for (const m of help.matchAll(/^backlex [\w-]+ <([a-z][\w|-]*)>/gm)) {
      for (const s of (m[1] as string).split("|")) {
        if (/^[a-z][\w-]*$/.test(s) && !PLACEHOLDER.has(s)) advertised.add(s);
      }
    }
    // A module with no help template of its own is documented in the ROOT
    // help (`gen-openapi --out`, `logout --all`, `init --force`), so that is
    // where its flags are looked for. Without this the "undocumented flag"
    // ledger reports every flag those six commands read.
    if (help === "") {
      for (const b of rootHelp.matchAll(/(--[a-z][\w-]*)/g)) mentioned.add(b[1] as string);
    }
    return {
      name,
      code,
      help,
      runs: [...src.matchAll(/^export const (run\w+)/gm)].map((m) => m[1] as string),
      advertised: [...advertised],
      documented: [...documented],
      mentioned,
      readFlags: [
        ...new Set(
          [...code.matchAll(/\b(?:flag|has)\(\w+,\s*"(--[\w-]+)"\)/g)].map((m) => m[1] as string),
        ),
      ],
    };
  });

const byModule = new Map(cliModules.map((m) => [m.name, m]));

/**
 * Flags the shared context resolver reads for every command, derived from
 * `client.ts` rather than hardcoded — a list written down here would go stale
 * the first time a connection flag is added or renamed.
 */
const GLOBAL_FLAGS = new Set([
  ...[...clientSrc.matchAll(/"(--[\w-]+)"/g)].map((m) => m[1] as string),
  "--help",
]);

/**
 * The flags `resolveContext` reads off the FULL argv, on every command's
 * behalf — a narrower and far more dangerous set than `GLOBAL_FLAGS`.
 *
 * `resolveContext(args)` is handed the whole argument list, subcommand
 * arguments included, and `flag()` returns the FIRST match. So a command that
 * gives one of these names a meaning of its own does not merely shadow it: the
 * value the user meant for the command becomes the value the CLI connects to.
 * `backlex webhooks create --url https://hook.example/x` posts the create
 * request TO `https://hook.example/x` instead of to the instance, and dies with
 * a DNS error naming the webhook. Found by RUNNING the binary below, not by
 * reading it — which is the argument for the execution section existing.
 */
const CONNECTION_FLAGS = (() => {
  // Scoped to `resolveContext`'s own body. `buildListQuery` in the same file
  // reads a dozen more names off an `args` parameter, but commands hand IT
  // their own slice, so those are per-command by design and carry no hazard.
  const from = clientSrc.indexOf("export const resolveContext");
  const to = clientSrc.indexOf("export const makeClient", from);
  const body = from === -1 || to === -1 ? "" : clientSrc.slice(from, to);
  return new Set(
    [...body.matchAll(/\b(?:flag|has)\(args, "(--[\w-]+)"\)/g)].map((m) => m[1] as string),
  );
})();

/**
 * Commands that today give a connection flag a second meaning.
 *
 * Every entry is a LIVE DEFECT, not an exemption. It is recorded rather than
 * fixed because the fix belongs in `packages/cli/src/*`, and a red test nobody
 * in this file can turn green is a test that gets deleted. What the record buys
 * is that the set cannot GROW without someone answering for it, and that fixing
 * one forces the entry out.
 *
 * The fix, per site: give the command's own option a different name
 * (`--endpoint`, `--target`), or hand `resolveContext` the connection slice
 * rather than the whole argv.
 *
 * `--json` is deliberately not counted: every command that reads it means the
 * same thing by it, so the shared read is the intended behaviour. `auth` is
 * excluded for the same reason — `--url`, `--key`, `--tenant` and `--profile`
 * ARE its subject matter.
 */
const CONNECTION_FLAG_COLLISIONS: Record<string, string[]> = {
  "auth-hooks": ["--url"],
  cdc: ["--url"],
  // `items ingest --key <storage-key>` is the worst of the six: the storage
  // key becomes the Bearer token, so the command fails as 401 UNAUTHORIZED and
  // says nothing about the flag that caused it.
  items: ["--key"],
  messaging: ["--url"],
  "sync-hooks": ["--url"],
  webhooks: ["--url"],
};

/** `case "tenants":` in `bin/backlex.ts` — the commands the binary answers to,
 *  aliases included. */
const binCases = [...new Set([...binSrc.matchAll(/case "([^"]+)":/g)].map((m) => m[1] as string))];

/** `backlex <command>` as the root help offers it — the contract to a user. */
const rootCommands = [
  ...new Set([...rootHelp.matchAll(/^ {2}backlex ([a-z][a-z0-9-]*)/gm)].map((m) => m[1] as string)),
];

/** Module → the `run*` names `bin` imports from it. */
const binImports = new Map<string, string[]>();
for (const m of binSrc.matchAll(/import \{([^}]+)\} from "\.\.\/src\/([\w-]+)"/g)) {
  const names = (m[1] as string)
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.startsWith("run"));
  if (names.length) binImports.set(m[2] as string, names);
}

const mcpModules = readdirSync(MCP_DIR)
  .filter((f) => f.endsWith(".ts") && f !== "index.ts")
  .map((f) => ({ name: f.slice(0, -3), src: read(join(MCP_DIR, f)) }))
  .filter((m) => /^\s*name: "/m.test(m.src))
  .map((m) => m.name);

// ---------------------------------------------------------------------------
// Registry — how the CLI answers for every MCP tool module
// ---------------------------------------------------------------------------

/**
 * Exactly one of `command` / `deferred` / `serverOnly`.
 *
 * `retiredBy` is required on every deferral and is checked against reality:
 *
 *   `module:<name>`  — `packages/cli/src/<name>.ts` must not exist yet.
 *   `command:<name>` — the root help must not offer `backlex <name>`, and the
 *                      binary must not answer to it either.
 */
type Coverage = {
  /** A `packages/cli/src/<name>.ts` command module covers it. */
  command?: string;
  /** Not covered, on purpose, until the named wave. Needs real reasoning. */
  deferred?: string;
  /** Not covered and never will be — the CLI is the wrong place for it. */
  serverOnly?: string;
  /** Subcommands the covering module does NOT dispatch yet. Each must still
   *  be undispatched, so an entry cannot outlive its own gap. */
  missing?: string[];
  /** `wave-N` or `wave-N-phase-M`. Required by `deferred` and by `missing`. */
  until?: string;
  /** What would retire a deferral. Required by `deferred`. */
  retiredBy?: string;
};

/**
 * The reason repeated most often, written once so each entry's specific half
 * stays specific.
 *
 * It is an argument, not a placeholder: a CLI command earns its place when
 * someone would type it at a terminal — scripting a deploy, fixing data,
 * reading a value out. A surface whose only caller is the product's own
 * runtime gains nothing from an argv parser in front of it.
 */
const NOBODY_TYPES_IT = (what: string) =>
  `${what} is read by the product's own runtime rather than by a person at a terminal, and a command exists to be typed. Adding one would mean a second way to reach a value that is already resolved without a round trip, and one more surface to keep in step. Revisit if an operator ever needs to script it.`;

const CLI_SURFACES: Record<string, Coverage> = {
  activity: {
    deferred:
      "The activity log is the workspace's audit trail, and reading it usefully means filtering by actor, collection and window — which is a table, not a terminal. `backlex traces` covers the neighbouring need (what a request did) and is often mistaken for it; the audit half genuinely has no command.",
    until: "wave-21",
    retiredBy: "command:activity",
  },
  advisor: { command: "advisor" },
  agents: { command: "agents" },
  ai: {
    deferred:
      "`ai.query`, `ai.suggest_schema` and `ai.import_csv` reshape data and schema from a prompt. A terminal is exactly where that is most tempting and least reviewable — there is no diff to read before it runs — so the surface stays where a human can see the proposal first.",
    until: "wave-21",
    retiredBy: "command:ai",
  },
  analytics: { command: "analytics" },
  "api-keys": {
    deferred:
      "The CLI already CONSUMES a key: `backlex login` verifies one and saves it to a profile. Minting keys from the same binary would put issuance and storage in one place, and the mint path deliberately prints a secret exactly once — badly suited to a shell that keeps history.",
    until: "wave-21",
    retiredBy: "command:api-keys",
  },
  "app-orgs": { command: "orgs" },
  "app-users": {
    deferred:
      "`backlex orgs` covers the B2B grouping and its membership, which is what an operator scripts. The end-user roster underneath it — list, edit, set roles — is the application's own population and is administered from the console, not from a shell on someone's laptop.",
    until: "wave-21",
    retiredBy: "command:app-users",
  },
  approvals: { command: "approvals" },
  "auth-hooks": { command: "auth-hooks" },
  backups: { command: "backup" },
  booking: { command: "booking" },
  bulk: { command: "items" },
  cdc: { command: "cdc" },
  channels: { command: "channels" },
  collections: { command: "items" },
  comments: {
    deferred:
      "Comments are written by people looking at a row, and read in the same place. Nothing about them is scripted, and a command would exist only to make the surface count complete.",
    until: "wave-21",
    retiredBy: "command:comments",
  },
  consent: { command: "consent" },
  dashboards: { command: "dashboards" },
  db: {
    deferred:
      "`db.execute_sql` is the one tool a terminal is genuinely the right home for, and that is exactly why it needs a decision rather than a port: the CLI holds a saved profile, so a command here would run arbitrary SQL against whichever workspace happened to be active. It wants an explicit target and a confirmation, which is design work.",
    until: "wave-21",
    retiredBy: "command:db",
  },
  documents: { command: "documents" },
  email: { command: "collections" },
  embedding: { command: "collections" },
  extensions: { command: "extensions" },
  "feature-flags": { command: "admin" },
  flows: { command: "flows" },
  folders: {
    deferred:
      "Folders are the storage plane's tree, and the storage plane has no command at all yet — see the `storage` entry. Shipping the tree before the files it holds would be the wrong half first.",
    until: "wave-21",
    retiredBy: "command:folders",
  },
  forms: { command: "forms" },
  functions: { command: "functions" },
  geo: {
    // `backlex collections backfill-geo` is the bulk half. Geocoding one
    // address by hand is not there.
    command: "collections",
    missing: ["geocode", "reverse"],
    until: "wave-21",
  },
  graphql: {
    deferred:
      "A `backlex graphql` command would be a document on stdin and a JSON result on stdout, which is `curl` with extra steps unless it also carries the saved profile's credentials — which is the actual argument for it. It is small and genuinely just not written.",
    until: "wave-21",
    retiredBy: "command:graphql",
  },
  integrations: { command: "integrations" },
  "items-publish": {
    // `items verify` and `items transitions` are there; the draft/publish
    // lifecycle is not.
    command: "items",
    missing: ["publish", "unpublish", "archive"],
    until: "wave-21",
  },
  jobs: { command: "jobs" },
  kpis: { command: "kpis" },
  migrate: { command: "import-db" },
  notifications: {
    // `backlex messaging` covers the dispatch half — push and SMS. The in-app
    // bell has no subcommand.
    command: "messaging",
    missing: ["list", "notify", "mark-read"],
    until: "wave-21",
  },
  oauth: { command: "oauth" },
  order: { command: "items" },
  payments: { command: "payments" },
  permissions: { command: "permissions" },
  phone: { command: "collections" },
  retirement: { command: "items" },
  revisions: {
    deferred:
      "A revision is read next to the row it belongs to, and reverting one is a decision taken while looking at both. Neither is a thing to script, and the surface an operator would actually want — 'what changed here and by whom' — is the activity log, which has no command either.",
    until: "wave-21",
    retiredBy: "command:revisions",
  },
  rls: { command: "rls" },
  roles: { command: "admin" },
  s3: { command: "s3" },
  saml: {
    deferred:
      "SAML configuration is XML metadata and a certificate pasted once per identity provider, and getting it wrong locks people out. It is done in the console where the fields are labelled and validated in front of you, not as a flag whose value is a file path.",
    until: "wave-21",
    retiredBy: "command:saml",
  },
  "schema-admin": {
    // Everything except collection creation and dropping: `collections
    // drop-field`, `fts-reindex`, `vectorize`, `refresh-rollups` and
    // `sync-sequences` are all there, and `schema apply` carries the DDL.
    command: "collections",
    missing: ["create", "drop"],
    until: "wave-21",
  },
  "schema-versions": { command: "schema" },
  schema: { command: "collections" },
  settings: { command: "admin" },
  "shared-links": {
    deferred:
      "A shared link is minted so one person without a session can read one thing, and it is handed over by pasting it into a message. The mint is a single click next to the row it shares; a terminal would be a longer way to reach the same clipboard.",
    until: "wave-21",
    retiredBy: "command:shared-links",
  },
  signatures: { command: "signatures" },
  "signing-keys": { command: "signing-keys" },
  slug: { command: "items" },
  storage: {
    deferred:
      "The CLI's answer to file transfer is `backlex s3`: mint a credential and use rclone, aws-cli or mc, which already do resumable uploads, parallelism and directory sync far better than an argv parser written here would. A `storage` command would be a worse copy of tools the operator already has.",
    until: "wave-21",
    retiredBy: "command:storage",
  },
  support: { command: "support" },
  "sync-hooks": { command: "sync-hooks" },
  templates: { command: "templates" },
  tenants: { command: "tenants" },
  "third-party-auth": {
    deferred: NOBODY_TYPES_IT("A trusted external JWT issuer — a JWKS URL and an audience —"),
    until: "wave-21",
    retiredBy: "command:third-party-auth",
  },
  uploads: {
    deferred:
      "Resumable uploads are TUS, a protocol of `HEAD`/`PATCH` with byte offsets in headers. Listing and abandoning someone else's half-finished session is the small half of a surface whose main verb the CLI answers with `s3` instead.",
    until: "wave-21",
    retiredBy: "command:uploads",
  },
  usage: { command: "usage" },
  users: { command: "admin" },
  vector: { command: "items" },
  webhooks: { command: "webhooks" },
};

/**
 * Command modules with no MCP tool behind them at all.
 *
 * The reverse direction needs them: every module `bin` dispatches must be
 * claimed by something, or a new command could ship unregistered. These are
 * the CLI's own surfaces — the ones that exist BECAUSE there is a terminal.
 */
const CLI_ONLY: Record<string, string> = {
  auth: "login, logout, whoami and profile are the CLI's own state: which instance, which key, which workspace. There is no server surface to mirror because the thing being edited is a file on the operator's laptop.",
  traces: "Distributed traces are read as a waterfall, and the console draws one. The command exists so a failing request can be inspected from the same shell that made it, which is not something an agent tool would do.",
  migrate: "Applying pending SQL migrations to a local database. It runs before an instance is serving, so there is nothing for a server-side tool to call.",
  "gen-types": "Generating TypeScript types from a live schema, written to disk. Its output is a file in someone's repository, which only a local process can produce.",
  "gen-openapi": "Writing the OpenAPI document to disk, for the same reason as `gen-types`: the artefact is a file, not a response.",
  init: "Scaffolding a new project directory. It runs before there is an instance to talk to.",
  sdk: "Printing the SDK snippet for the connected instance, so a new project starts against the right URL with the right imports.",
  mcp: "Running the MCP stdio bridge, which is how an agent reaches this instance at all. The server end of it is the thing being bridged.",
};

const ALL_ENTRIES: [string, Coverage][] = Object.entries(CLI_SURFACES).map(
  ([k, v]) => [`mcp:${k}`, v] as [string, Coverage],
);

const UNTIL = /^wave-\d+(-phase-\d+)?$/;
const kindOf = (c: Coverage): string[] =>
  (["command", "deferred", "serverOnly"] as const).filter((k) => c[k] !== undefined);

/**
 * Flags a module reads and its own help never mentions.
 *
 * Recorded rather than fixed, because each is a documentation gap in someone
 * else's file and this test is not the place to edit them — but a RECORDED gap
 * cannot grow silently, and the assertion below fails the moment one is
 * documented, so the entry has to be deleted rather than left lying. Every one
 * of these is a flag that works today and is invisible to `backlex <cmd> help`.
 */
const UNDOCUMENTED_FLAGS: Record<string, string[]> = {
  analytics: ["--source", "--platform", "--release"],
  booking: ["--description", "--message", "--inactive", "--active"],
  forms: ["--ids", "--min-hours", "--force"],
  integrations: ["--category-field", "--lookup"],
  signatures: ["--filename"],
  templates: ["--samples"],
};

/**
 * Command modules that carry no help template of their own.
 *
 * Asserted as an exact set rather than skipped, because "this module has no
 * help text" is precisely the condition under which sections 3's checks pass
 * vacuously. A module that LOSES its help text fails here.
 */
const NO_LOCAL_HELP = ["auth", "gen-openapi", "gen-types", "init", "mcp", "migrate"];

// ---------------------------------------------------------------------------

describe("CLI parity — the scans found the surfaces they police", () => {
  test("sanity: every list this file asserts over is non-trivially full", () => {
    expect(mcpModules.length).toBeGreaterThanOrEqual(60);
    expect(cliModules.length).toBeGreaterThanOrEqual(45);
    expect(binCases.length).toBeGreaterThanOrEqual(60);
    expect(rootCommands.length).toBeGreaterThanOrEqual(45);
    expect(binImports.size).toBeGreaterThanOrEqual(40);
    // The three per-module scans. Each of these is a list an assertion below
    // iterates; empty means that assertion tests nothing.
    expect(cliModules.filter((m) => m.help !== "").length).toBeGreaterThanOrEqual(38);
    expect(cliModules.reduce((n, m) => n + m.advertised.length, 0)).toBeGreaterThanOrEqual(200);
    expect(cliModules.reduce((n, m) => n + m.documented.length, 0)).toBeGreaterThanOrEqual(250);
    expect(cliModules.reduce((n, m) => n + m.readFlags.length, 0)).toBeGreaterThanOrEqual(300);
    expect(GLOBAL_FLAGS.size).toBeGreaterThanOrEqual(10);
  });

  test("the modules without a help template are exactly the ones on record", () => {
    const dispatched = new Set(binImports.keys());
    const without = cliModules
      .filter((m) => dispatched.has(m.name) && m.help === "")
      .map((m) => m.name)
      .sort();
    expect(without).toEqual([...NO_LOCAL_HELP].sort());
  });

  test("every MCP tool module has an entry", () => {
    expect(mcpModules.filter((m) => !CLI_SURFACES[m])).toEqual([]);
  });

  test("no entry names an MCP module that no longer exists", () => {
    expect(Object.keys(CLI_SURFACES).filter((k) => !mcpModules.includes(k))).toEqual([]);
  });

  test("every command module the binary dispatches is claimed", () => {
    const claimed = new Set([
      ...Object.values(CLI_SURFACES)
        .map((c) => c.command)
        .filter((c): c is string => Boolean(c)),
      ...Object.keys(CLI_ONLY),
    ]);
    // A new command module wired into `bin` and named by nobody is a
    // capability the CLI has and no ledger admits to.
    expect([...binImports.keys()].filter((m) => !claimed.has(m))).toEqual([]);
  });

  test("no entry claims a command module that does not exist", () => {
    for (const [key, cov] of ALL_ENTRIES) {
      if (!cov.command) continue;
      expect(`${key} -> packages/cli/src/${cov.command}.ts: ${byModule.has(cov.command)}`).toBe(
        `${key} -> packages/cli/src/${cov.command}.ts: true`,
      );
      expect(`${key} -> ${cov.command} is wired into bin: ${binImports.has(cov.command)}`).toBe(
        `${key} -> ${cov.command} is wired into bin: true`,
      );
    }
    for (const name of Object.keys(CLI_ONLY)) {
      expect(`cli-only ${name} is wired into bin: ${binImports.has(name)}`).toBe(
        `cli-only ${name} is wired into bin: true`,
      );
    }
  });
});

describe("CLI parity — every entry is well formed", () => {
  test("each entry answers in exactly one way", () => {
    for (const [key, cov] of ALL_ENTRIES) {
      expect(`${key}: ${kindOf(cov).join("+") || "nothing"}`).toBe(`${key}: ${kindOf(cov)[0]}`);
    }
  });

  test("a deferral costs a real sentence, a wave, and something that retires it", () => {
    for (const [key, cov] of ALL_ENTRIES) {
      if (cov.deferred === undefined) continue;
      expect(`${key}: ${cov.deferred.length}`).toBe(`${key}: ${Math.max(cov.deferred.length, 60)}`);
      expect(`${key}: ${UNTIL.test(cov.until ?? "")}`).toBe(`${key}: true`);
      // Shape is not enough: a wave that has already shipped reads exactly like
      // one that has not. See `surfaces-wave.ts` for the drift this caught.
      expect(`${key} defers to the open wave: ${cov.until}`).toBe(
        `${key} defers to the open wave: ${OPEN_WAVE}`,
      );
      expect(`${key} retiredBy: ${/^(module|command):[\w-]+$/.test(cov.retiredBy ?? "")}`).toBe(
        `${key} retiredBy: true`,
      );
    }
  });

  test("a permanent exclusion says why it is permanent and defers to nothing", () => {
    for (const [key, cov] of ALL_ENTRIES) {
      if (cov.serverOnly === undefined) continue;
      expect(`${key}: ${cov.serverOnly.length}`).toBe(
        `${key}: ${Math.max(cov.serverOnly.length, 60)}`,
      );
      expect(cov.until).toBeUndefined();
      expect(cov.retiredBy).toBeUndefined();
    }
  });

  test("every CLI-only claim says why no server tool mirrors it", () => {
    for (const [name, why] of Object.entries(CLI_ONLY)) {
      expect(`${name}: ${why.length}`).toBe(`${name}: ${Math.max(why.length, 60)}`);
    }
  });

  test("every `retiredBy` is a tripwire that can still fire", () => {
    for (const [key, cov] of ALL_ENTRIES) {
      if (!cov.retiredBy) continue;
      const [kind, name] = cov.retiredBy.split(":") as [string, string];
      if (kind === "module") {
        expect(`${key} -> packages/cli/src/${name}.ts exists: ${byModule.has(name)}`).toBe(
          `${key} -> packages/cli/src/${name}.ts exists: false`,
        );
      } else {
        // Both halves: the help must not offer it and the binary must not
        // answer to it. A command that works and is undocumented is still a
        // command, and this deferral would be a lie about it.
        const offered = rootCommands.includes(name) || binCases.includes(name);
        expect(`${key} -> \`backlex ${name}\` exists: ${offered}`).toBe(
          `${key} -> \`backlex ${name}\` exists: false`,
        );
      }
    }
  });

  test("a `missing` subcommand is genuinely still missing", () => {
    for (const [key, cov] of ALL_ENTRIES) {
      if (!cov.missing) continue;
      expect(`${key}: ${cov.missing.length > 0}`).toBe(`${key}: true`);
      expect(`${key}: ${UNTIL.test(cov.until ?? "")}`).toBe(`${key}: true`);
      // Shape is not enough: a wave that has already shipped reads exactly like
      // one that has not. See `surfaces-wave.ts` for the drift this caught.
      expect(`${key} defers to the open wave: ${cov.until}`).toBe(
        `${key} defers to the open wave: ${OPEN_WAVE}`,
      );
      const mod = byModule.get(cov.command as string);
      expect(`${key} names a module: ${Boolean(mod)}`).toBe(`${key} names a module: true`);
      for (const sub of cov.missing) {
        const dispatched = new RegExp(`(?:case|===|!==)\\s*"${sub}"`).test(mod!.code);
        // When the subcommand lands this fails, and deleting the entry is how
        // the phase reports itself finished.
        expect(`${key}: \`${cov.command} ${sub}\` shipped: ${dispatched}`).toBe(
          `${key}: \`${cov.command} ${sub}\` shipped: false`,
        );
      }
    }
  });
});

describe("CLI parity — the binary reaches every command it offers", () => {
  test("every `run*` a command module exports is imported AND called by bin", () => {
    for (const [mod, names] of binImports) {
      for (const fn of names) {
        // Imported and never called is a command that type-checks, lints, and
        // cannot be run — the CLI's version of a module nobody spread into
        // the schema.
        const called = new RegExp(`\\b${fn}\\(`).test(binSrc);
        expect(`bin calls ${fn} (from ${mod}): ${called}`).toBe(`bin calls ${fn} (from ${mod}): true`);
      }
    }
  });

  test("no command module exports a `run*` the binary never imports", () => {
    for (const mod of cliModules) {
      if (!binImports.has(mod.name)) continue;
      const imported = new Set(binImports.get(mod.name));
      const orphaned = mod.runs.filter((r) => !imported.has(r));
      expect(`${mod.name} exports unreachable entry points: ${orphaned.join(", ")}`).toBe(
        `${mod.name} exports unreachable entry points: `,
      );
    }
  });

  test("every command the root help offers has a case in the dispatcher", () => {
    // `help` is answered before the switch, so it is the one exemption and it
    // is named rather than filtered by a pattern.
    const missing = rootCommands.filter((c) => c !== "help" && !binCases.includes(c));
    expect(missing).toEqual([]);
  });
});

describe("CLI parity — the help text is true", () => {
  test("every subcommand a module advertises is dispatched by it", () => {
    // The shape this catches: a help line offering `backlex forms results`
    // over a switch that never mentions `results`, which exits 1 with
    // "unknown subcommand" at a user who read the documentation.
    const undispatched: string[] = [];
    for (const mod of cliModules) {
      for (const sub of mod.advertised) {
        if (!new RegExp(`(?:case|===|!==)\\s*"${sub}"`).test(mod.code)) {
          undispatched.push(`${mod.name} ${sub}`);
        }
      }
    }
    expect(undispatched).toEqual([]);
  });

  test("every flag a module documents is a flag it reads", () => {
    // The `roleName` shape, at the CLI: a documented option accepted by argv
    // and read by nobody, so the command succeeds and ignores what it was
    // told. `GLOBAL_FLAGS` is derived from `client.ts`, which reads the
    // connection flags on every command's behalf.
    const unread: string[] = [];
    for (const mod of cliModules) {
      for (const f of mod.documented) {
        if (GLOBAL_FLAGS.has(f)) continue;
        // Any literal mention in the code counts — several commands pass a
        // flag name through a helper rather than calling `flag()` inline.
        if (!new RegExp(`"${f}"`).test(mod.code)) unread.push(`${mod.name} ${f}`);
      }
    }
    expect(unread).toEqual([]);
  });

  test("no command quietly redefines a connection flag", () => {
    const found: Record<string, string[]> = {};
    for (const mod of cliModules) {
      if (mod.name === "auth" || mod.name === "client") continue;
      // Only flags read off the SUBCOMMAND's own slice count — a module that
      // reads `--url` off the full argv is reading the connection flag on
      // purpose, which is what `resolveContext` already did for it.
      const own = new Set(
        [...mod.code.matchAll(/\b(?:flag|has)\((rest|sub\w*|a\w*),\s*"(--[\w-]+)"\)/g)].map(
          (m) => m[2] as string,
        ),
      );
      const clashes = [...own].filter((f) => f !== "--json" && CONNECTION_FLAGS.has(f)).sort();
      if (clashes.length) found[mod.name] = clashes;
    }
    const recorded = Object.fromEntries(
      Object.entries(CONNECTION_FLAG_COLLISIONS).map(([k, v]) => [k, [...v].sort()]),
    );
    // Both directions: a NEW command may not take one of these names, and a
    // recorded one that gets fixed must be struck from the list.
    expect(found).toEqual(recorded);
  });

  test("the flags no help mentions are exactly the ones on record", () => {
    const found: Record<string, string[]> = {};
    for (const mod of cliModules) {
      const gaps = mod.readFlags.filter((f) => !mod.mentioned.has(f) && !GLOBAL_FLAGS.has(f));
      if (gaps.length) found[mod.name] = gaps.sort();
    }
    const recorded = Object.fromEntries(
      Object.entries(UNDOCUMENTED_FLAGS).map(([k, v]) => [k, [...v].sort()]),
    );
    // Fails in both directions: a new undocumented flag appears, or a recorded
    // one gets documented and the entry has to go.
    expect(found).toEqual(recorded);
  });
});

// ---------------------------------------------------------------------------
// Execution — the only section that proves a command does anything
// ---------------------------------------------------------------------------

describe("CLI parity — a command that runs, and a result read back elsewhere", () => {
  let h: TestHarness;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let baseUrl: string;
  let apiKey: string;
  let tmpDir: string;
  const T = 30_000; // each test spawns a subprocess

  const json = (body: unknown, method = "POST"): RequestInit => ({
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  /**
   * Run the REAL binary against a REAL listener.
   *
   * Importing `runWebhooks` directly would skip argv parsing, the help
   * dispatch and the exit code, which is most of what a CLI is — and all
   * three are where a command quietly stops doing anything.
   */
  const runCli = async (args: string[]) => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      // Never let the developer's own BACKLEX_* reach the subprocess.
      if (v !== undefined && !k.startsWith("BACKLEX_")) env[k] = v;
    }
    env.BACKLEX_CONFIG = join(tmpDir, "config.json");
    env.BACKLEX_URL = baseUrl;
    env.BACKLEX_API_KEY = apiKey;
    const proc = Bun.spawn(["bun", CLI_BIN, ...args], {
      cwd: REPO,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  };

  beforeAll(async () => {
    h = makeHarness();
    server = Bun.serve({ port: 0, fetch: (req) => h.app.fetch(req) });
    baseUrl = `http://127.0.0.1:${server.port}`;
    await seedAdmin(h);
    const keyRes = await h.fetch("/api/api-keys", json({ name: "cli-surfaces" }));
    expect(keyRes.status).toBe(201);
    apiKey = ((await keyRes.json()) as { data: { secret: string } }).data.secret;
    tmpDir = mkdtempSync(join(tmpdir(), "backlex-cli-surfaces-"));
  });

  afterAll(() => {
    server?.stop(true);
    h?.cleanup();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  test(
    "`channels create` sends every flag it accepted, read back over REST",
    async () => {
      // Six flags, none of them a connection-flag name — see
      // `CONNECTION_FLAG_COLLISIONS`. `webhooks create` would have been the
      // obvious subject and is unusable here for exactly that reason: its
      // `--url` is eaten by the context resolver before the command sees it.
      const r = await runCli([
        "channels",
        "create",
        "--name",
        "cli-surfaces-channel",
        "--pattern",
        "clisurf:{room}:feed",
        "--subscribe",
        "authenticated",
        "--publish",
        "roles:admin",
        "--presence",
        "--retention",
        "48",
        "--json",
      ]);
      expect(r.code, r.stderr).toBe(0);
      const created = JSON.parse(r.stdout) as { id: string };
      expect(created.id).toBeTruthy();

      // A different surface entirely: had the CLI parsed the flags and posted
      // a body without them, the exit code and its own JSON would both still
      // look right.
      const rest = (await (await h.fetch("/api/admin/realtime-channels")).json()) as {
        data: Record<string, any>[];
      };
      const row = rest.data.find((c) => c.id === created.id);
      expect(row, "the channel the CLI created is not readable over REST").toBeTruthy();
      expect(row!.name).toBe("cli-surfaces-channel");
      expect(row!.pattern).toBe("clisurf:{room}:feed");
      // The access rules are the point of a channel, and they are the part a
      // zero exit code would happily lie about.
      expect(row!.subscribe?.mode ?? row!.subscribe).toBeTruthy();
      expect(JSON.stringify(row!.publish)).toContain("admin");
      // Two optional flags, both dropped without a trace if read under another
      // name — which is the shape this whole file is about.
      expect(row!.presence).toBe(true);
      expect(row!.retentionHours).toBe(48);
    },
    T,
  );

  test(
    "`flags set` writes the value and the rollout it was given",
    async () => {
      const r = await runCli([
        "flags",
        "set",
        "cli-surfaces-flag",
        "--enabled",
        "true",
        "--value",
        '{"tier":"pro"}',
        "--rollout",
        "25",
        "--json",
      ]);
      expect(r.code, r.stderr).toBe(0);

      const rest = (await (await h.fetch("/api/admin/feature-flags")).json()) as {
        data: Record<string, any>[];
      };
      const row = rest.data.find((f) => f.key === "cli-surfaces-flag");
      expect(row, "the flag the CLI set is not readable over REST").toBeTruthy();
      expect(row!.enabled).toBe(true);
      // `--value` and `--rollout` are parsed into two different body shapes
      // (`value`, `rules.rollout`); dropping either leaves a flag that exists
      // and does nothing, which is the bug this whole file is about.
      expect(row!.value).toEqual({ tier: "pro" });
      expect(row!.rules?.rollout).toBe(25);
    },
    T,
  );

  test(
    "an unknown command is refused rather than silently succeeding",
    async () => {
      // The floor under every check above: if the dispatcher fell through to a
      // zero exit, "the command ran" would mean nothing.
      const r = await runCli(["definitely-not-a-command"]);
      expect(r.code).not.toBe(0);
    },
    T,
  );
});
