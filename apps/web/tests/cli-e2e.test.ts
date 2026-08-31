/**
 * End-to-end tests for the `backlex` CLI (packages/cli).
 *
 * Unlike every other spec (which calls `app.fetch` in-process), the CLI is a
 * real subprocess speaking real HTTP — so the harness app is lifted onto a
 * live listener via `Bun.serve({ port: 0 })` (random free port) and each CLI
 * command runs as `bun packages/cli/bin/backlex.ts …` with env pointing at it:
 *
 *   BACKLEX_URL      → the harness server
 *   BACKLEX_API_KEY  → a freshly minted `pak_…` admin key
 *   BACKLEX_CONFIG   → an isolated temp config path (never ~/.backlex)
 *
 * Covered end-to-end: help/arg parsing, whoami/login/profile (config file
 * incl. 0600 perms), collections (list/get/export-schema), items
 * (create/list/get/update/export/delete), backup (now/list/download artifact/
 * restore confirm gate), schema (capture/snapshots/diff), roles list,
 * permissions simulate, and error paths (bad key, no key, unreachable server,
 * unknown commands) — asserting exit codes AND the actual stdout/stderr shape.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
const CLI_BIN = resolve(REPO_ROOT, "packages/cli/bin/backlex.ts");
const SLUG = "cli_notes";
const T = 30_000; // per-test timeout — every test spawns ≥1 subprocess

let h: TestHarness;
let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;
let apiKey: string;
let adminEmail: string;
let adminId: string;
let tmpDir: string;
let cfgPath: string;

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run the CLI as a subprocess. By default it gets BACKLEX_URL/BACKLEX_API_KEY
 * pointing at the harness server and an isolated BACKLEX_CONFIG. Pass
 * `env: { KEY: undefined }` to remove a variable, or a string to override it.
 */
const runCli = async (
  args: string[],
  opts: { env?: Record<string, string | undefined> } = {},
): Promise<CliResult> => {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    // Never let the developer's real BACKLEX_* leak into the subprocess.
    if (v !== undefined && !k.startsWith("BACKLEX_")) env[k] = v;
  }
  env.BACKLEX_CONFIG = cfgPath;
  env.BACKLEX_URL = baseUrl;
  env.BACKLEX_API_KEY = apiKey;
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  const proc = Bun.spawn(["bun", CLI_BIN, ...args], {
    cwd: REPO_ROOT,
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

/** Assert the CLI produced a clean one-line error, not a stack trace. */
const expectNoStackTrace = (r: CliResult): void => {
  expect(r.stderr).not.toContain("\n    at ");
  expect(r.stdout).not.toContain("\n    at ");
};

beforeAll(async () => {
  h = makeHarness();
  // Real listener over the in-process app — the CLI needs actual HTTP.
  server = Bun.serve({ port: 0, fetch: (req) => h.app.fetch(req) });
  baseUrl = `http://127.0.0.1:${server.port}`;

  const creds = await seedAdmin(h);
  adminEmail = creds.email;

  const meRes = await h.fetch("/api/me");
  if (meRes.status !== 200) throw new Error(`/api/me failed: ${meRes.status}`);
  adminId = ((await meRes.json()) as { data: { id: string } }).data.id;

  // Mint the pak_… key the CLI authenticates with (Bearer fallback path).
  const keyRes = await h.fetch("/api/api-keys", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "cli-e2e" }),
  });
  if (keyRes.status !== 201) throw new Error(`api key create failed: ${keyRes.status}`);
  apiKey = ((await keyRes.json()) as { data: { secret: string } }).data.secret;

  // Scratch collection the items/backup/schema tests operate on.
  const colRes = await h.fetch("/api/collections", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      slug: SLUG,
      fields: [
        { name: "title", type: "text", required: true },
        { name: "body", type: "longtext" },
      ],
    }),
  });
  if (colRes.status !== 201) throw new Error(`collection create failed: ${colRes.status}`);

  tmpDir = mkdtempSync(join(tmpdir(), "backlex-cli-e2e-"));
  cfgPath = join(tmpDir, "config.json");
});

afterAll(() => {
  // Kill the listener even if a test failed — no orphan servers.
  server?.stop(true);
  h?.cleanup();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

// ── arg parsing / help ───────────────────────────────────────────────────────

describe("cli: help + unknown commands", () => {
  test("`backlex help` exits 0 and prints the command reference", async () => {
    const r = await runCli(["help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("backlex — self-hostable backend platform CLI");
    expect(r.stdout).toContain("backlex collections");
    expect(r.stdout).toContain("backlex gen-types");
    expect(r.stderr).toBe("");
  }, T);

  test("no args behaves like help (exit 0)", async () => {
    const r = await runCli([]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("backlex — self-hostable backend platform CLI");
  }, T);

  test("unknown top-level command → exit 1 + clean message on stderr", async () => {
    const r = await runCli(["definitely-not-a-command"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("unknown command: definitely-not-a-command");
    expectNoStackTrace(r);
  }, T);

  test("unknown subcommand → exit 1 + the group's usage", async () => {
    const r = await runCli(["collections", "florp"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("unknown collections subcommand: florp");
    expect(r.stderr).toContain("backlex collections <list|get|clone|export-schema");
  }, T);
});

// ── auth: whoami / login / profile config ────────────────────────────────────

describe("cli: whoami + auth failures", () => {
  test("whoami --json resolves the key to the admin identity", async () => {
    const r = await runCli(["whoami", "--json"]);
    expect(r.code).toBe(0);
    const me = JSON.parse(r.stdout) as {
      email: string;
      isAdmin: boolean;
      roles: string[];
      url: string;
    };
    expect(me.email).toBe(adminEmail);
    expect(me.isAdmin).toBe(true);
    expect(me.roles).toContain("admin");
    expect(me.url).toBe(baseUrl);
  }, T);

  test("whoami (human) prints aligned key: value rows", async () => {
    const r = await runCli(["whoami"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/user\s+.*<.+@.+>/);
    expect(r.stdout).toMatch(/admin\s+yes/);
    expect(r.stdout).toContain(baseUrl);
  }, T);

  test("whoami without a key → exit 1 + login hint, no stack trace", async () => {
    const r = await runCli(["whoami"], {
      env: { BACKLEX_API_KEY: undefined, BACKLEX_CONFIG: join(tmpDir, "nope.json") },
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("no API key");
    expect(r.stderr).toContain("backlex login");
    expect(r.stdout).toBe("");
    expectNoStackTrace(r);
  }, T);

  test("whoami with a bogus key → exit 1 + `whoami failed: 401`", async () => {
    const r = await runCli(["whoami"], { env: { BACKLEX_API_KEY: "pak_bogus_ffff" } });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("whoami failed: 401");
    expectNoStackTrace(r);
  }, T);
});

describe("cli: login persists a profile", () => {
  test("login verifies the key and writes $BACKLEX_CONFIG with 0600 perms", async () => {
    const r = await runCli(
      ["login", "--url", baseUrl, "--key", apiKey],
      { env: { BACKLEX_API_KEY: undefined, BACKLEX_URL: undefined } },
    );
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('Saved profile "default"');
    expect(r.stdout).toMatch(/admin\s+yes/);

    expect(existsSync(cfgPath)).toBe(true);
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as {
      activeProfile?: string;
      profiles: Record<string, { url: string; key?: string }>;
    };
    expect(cfg.activeProfile).toBe("default");
    expect(cfg.profiles.default?.url).toBe(baseUrl);
    expect(cfg.profiles.default?.key).toBe(apiKey);
    // The file stores an API key — must not be group/world readable.
    expect(statSync(cfgPath).mode & 0o777).toBe(0o600);
  }, T);

  test("whoami works from the saved profile alone (no env url/key)", async () => {
    const r = await runCli(["whoami"], {
      env: { BACKLEX_API_KEY: undefined, BACKLEX_URL: undefined },
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/profile\s+default/);
    expect(r.stdout).toContain(baseUrl);
  }, T);

  test("profile list marks the active profile", async () => {
    const r = await runCli(["profile", "list"], {
      env: { BACKLEX_API_KEY: undefined, BACKLEX_URL: undefined },
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/\* default/);
    expect(r.stdout).toContain(baseUrl);
  }, T);

  test("login with an invalid key → exit 1, nothing saved for that profile", async () => {
    const r = await runCli(
      ["login", "--url", baseUrl, "--key", "pak_bad_key", "--profile", "broken"],
      { env: { BACKLEX_API_KEY: undefined, BACKLEX_URL: undefined } },
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("login failed: 401");
    expectNoStackTrace(r);
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as {
      profiles: Record<string, unknown>;
    };
    expect(cfg.profiles.broken).toBeUndefined();
  }, T);
});

// ── collections ──────────────────────────────────────────────────────────────

describe("cli: collections", () => {
  test("list renders the table with slug/fields/ownerScoped/adopted columns", async () => {
    const r = await runCli(["collections", "list"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/slug\s+fields\s+ownerScoped\s+adopted/);
    expect(r.stdout).toMatch(new RegExp(`${SLUG}\\s+\\d+\\s+no\\s+no`));
  }, T);

  test("list --json emits the raw collection array", async () => {
    const r = await runCli(["collections", "list", "--json"]);
    expect(r.code).toBe(0);
    const cols = JSON.parse(r.stdout) as { slug: string; fields: { name: string }[] }[];
    const col = cols.find((c) => c.slug === SLUG);
    expect(col).toBeDefined();
    expect(col!.fields.map((f) => f.name)).toEqual(
      expect.arrayContaining(["title", "body"]),
    );
  }, T);

  test("get <slug> shows metadata + the field table", async () => {
    const r = await runCli(["collections", "get", SLUG]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(new RegExp(`slug\\s+${SLUG}`));
    expect(r.stdout).toContain("fields:");
    expect(r.stdout).toMatch(/title\s+text\s+yes/);
    expect(r.stdout).toMatch(/body\s+longtext\s+no/);
  }, T);

  test("get on a missing slug → exit 1 + `no such collection`", async () => {
    const r = await runCli(["collections", "get", "nope_missing"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("no such collection: nope_missing");
    expectNoStackTrace(r);
  }, T);

  test("export-schema --out writes a diffable JSON schema dump", async () => {
    const out = join(tmpDir, "schema-export.json");
    const r = await runCli(["collections", "export-schema", "--out", out]);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("✓ wrote");
    const dump = JSON.parse(readFileSync(out, "utf8")) as { slug: string }[];
    expect(dump.some((c) => c.slug === SLUG)).toBe(true);
  }, T);
});

// ── items (create → read → update → export; delete comes after backup) ───────

let itemId: string;

describe("cli: items CRUD", () => {
  test("create --json returns the inserted row", async () => {
    const r = await runCli([
      "items", "create", SLUG,
      "--data", '{"title":"First","body":"hello from the cli"}',
      "--json",
    ]);
    expect(r.code).toBe(0);
    const res = JSON.parse(r.stdout) as { data: { id: string; title: string } };
    expect(res.data.title).toBe("First");
    expect(res.data.id).toBeTruthy();
    itemId = res.data.id;
  }, T);

  test("list renders a table containing the row", async () => {
    const r = await runCli(["items", "list", SLUG]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/\bid\b/); // header from the first row's keys
    expect(r.stdout).toContain("First");
  }, T);

  test("list --json with --filter narrows server-side", async () => {
    const r = await runCli([
      "items", "list", SLUG,
      "--filter", '{"title":{"_eq":"First"}}',
      "--json",
    ]);
    expect(r.code).toBe(0);
    const res = JSON.parse(r.stdout) as { data: { title: string }[] };
    expect(res.data.length).toBe(1);
    expect(res.data[0]!.title).toBe("First");
  }, T);

  test("get <id> prints key: value rows", async () => {
    const r = await runCli(["items", "get", SLUG, itemId]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/title\s+First/);
    expect(r.stdout).toMatch(new RegExp(`id\\s+${itemId}`));
  }, T);

  test("update --json returns the patched row", async () => {
    const r = await runCli([
      "items", "update", SLUG, itemId,
      "--data", '{"title":"Renamed"}',
      "--json",
    ]);
    expect(r.code).toBe(0);
    const res = JSON.parse(r.stdout) as { data: { title: string } };
    expect(res.data.title).toBe("Renamed");
  }, T);

  test("export --out writes the rows as JSON", async () => {
    const out = join(tmpDir, "items-export.json");
    const r = await runCli(["items", "export", SLUG, "--out", out]);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain(`✓ wrote ${SLUG}`);
    const rows = JSON.parse(readFileSync(out, "utf8")) as { title: string }[];
    expect(rows.some((row) => row.title === "Renamed")).toBe(true);
  }, T);

  test("list on a missing collection → exit 1 with the HTTP status", async () => {
    const r = await runCli(["items", "list", "ghost_collection"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("items list:");
    expect(r.stderr).toContain("404");
    expectNoStackTrace(r);
  }, T);
});

// ── backup (runs while the Renamed row still exists) ─────────────────────────

let backupId: string;

describe("cli: backup", () => {
  test("now --json runs a manual backup to done", async () => {
    const r = await runCli(["backup", "now", "--label", "cli-e2e", "--json"]);
    expect(r.code).toBe(0);
    const row = JSON.parse(r.stdout) as { id: string; status: string; label: string | null };
    expect(row.status).toBe("done");
    expect(row.label).toBe("cli-e2e");
    backupId = row.id;
  }, T);

  test("list shows the backup row", async () => {
    const r = await runCli(["backup", "list"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(backupId);
    expect(r.stdout).toContain("cli-e2e");
  }, T);

  test("download --out writes a JSONL artifact containing our data", async () => {
    const out = join(tmpDir, "backup.jsonl");
    const r = await runCli(["backup", "download", backupId, "--out", out]);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain(`✓ wrote backup ${backupId}`);
    expect(existsSync(out)).toBe(true);
    const text = readFileSync(out, "utf8");
    const lines = text.split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines.slice(0, 3)) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(parsed).toHaveProperty("table");
      expect(parsed).toHaveProperty("row");
    }
    // The item we created via the CLI made it into the dump.
    expect(text).toContain("Renamed");
  }, T);

  test("restore without --confirm is refused locally (exit 1, no request)", async () => {
    const r = await runCli(["backup", "restore", backupId]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Refusing to restore");
    expect(r.stderr).toContain("--confirm");
    expectNoStackTrace(r);
  }, T);
});

// ── items delete (after backup captured the row) ─────────────────────────────

describe("cli: items delete", () => {
  test("delete removes the row and reports `deleted`", async () => {
    const r = await runCli(["items", "delete", SLUG, itemId]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("deleted\n");

    const gone = await runCli(["items", "get", SLUG, itemId]);
    expect(gone.code).toBe(1);
    expect(gone.stderr).toContain("404");
  }, T);
});

// ── schema (snapshots / diff — non-destructive refs only) ────────────────────

let snapshotId: string;

describe("cli: schema snapshots + diff", () => {
  test("capture --json snapshots the live schema", async () => {
    const r = await runCli(["schema", "capture", "--name", "cli-snap", "--json"]);
    expect(r.code).toBe(0);
    const snap = JSON.parse(r.stdout) as { id: string; name: string };
    expect(snap.name).toBe("cli-snap");
    expect(snap.id).toBeTruthy();
    snapshotId = snap.id;
  }, T);

  test("snapshots lists the captured snapshot", async () => {
    const r = await runCli(["schema", "snapshots"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("cli-snap");
    expect(r.stdout).toContain(snapshotId);
  }, T);

  test("diff live → snapshot-of-live reports zero changes", async () => {
    const r = await runCli([
      "schema", "diff", "--from", "live", "--to", `snapshot:${snapshotId}`,
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^0 change\(s\): \+0 additive/);
  }, T);

  test("malformed ref → exit 1 + usage hint", async () => {
    const r = await runCli(["schema", "diff", "--from", "wat:1", "--to", "live"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('invalid from ref "wat:1"');
    expectNoStackTrace(r);
  }, T);
});

// ── roles + permissions simulate ─────────────────────────────────────────────

describe("cli: roles + permissions", () => {
  test("roles list renders the built-in roles table", async () => {
    const r = await runCli(["roles", "list"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/id\s+name\s+admin\s+description/);
    expect(r.stdout).toMatch(/admin\s+yes/);
  }, T);

  test("roles list --json includes the admin role", async () => {
    const r = await runCli(["roles", "list", "--json"]);
    expect(r.code).toBe(0);
    const roles = JSON.parse(r.stdout) as { name: string; admin: boolean }[];
    expect(roles.some((role) => role.name === "admin" && role.admin === true)).toBe(true);
  }, T);

  test("permissions simulate --user <admin> --json → ALLOW (admin bypass)", async () => {
    const r = await runCli([
      "permissions", "simulate",
      "--collection", SLUG,
      "--action", "read",
      "--user", adminId,
      "--json",
    ]);
    expect(r.code).toBe(0);
    const sim = JSON.parse(r.stdout) as { allowed: boolean; isAdmin: boolean };
    expect(sim.allowed).toBe(true);
    expect(sim.isAdmin).toBe(true);
  }, T);

  test("permissions simulate for a role with no grants → DENY (human)", async () => {
    const r = await runCli([
      "permissions", "simulate",
      "--collection", SLUG,
      "--action", "read",
      "--roles", "ghost-role",
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/decision\s+DENY/);
    expect(r.stdout).toMatch(/reason\s+/);
  }, T);

  test("permissions simulate without required flags → exit 1 + usage", async () => {
    const r = await runCli(["permissions", "simulate", "--collection", SLUG]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("permissions simulate --collection <slug> --action <action>");
    expectNoStackTrace(r);
  }, T);
});

// ── migrate (Bun-only, local — no server involved) ───────────────────────────

describe("cli: migrate", () => {
  test("migrate <path> applies the sqlite migrations to a fresh file", async () => {
    const dbPath = join(tmpDir, "migrated.sqlite");
    const r = await runCli(["migrate", dbPath]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`✓ migrations applied → ${dbPath}`);
    expect(existsSync(dbPath)).toBe(true);

    // The system tables actually exist in the migrated file.
    const { Database } = await import("bun:sqlite");
    const db = new Database(dbPath, { readonly: true });
    try {
      const tables = db
        .query("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as { name: string }[];
      const names = tables.map((t) => t.name);
      expect(names).toEqual(expect.arrayContaining(["roles", "collections", "user_roles"]));
    } finally {
      db.close();
    }
  }, T);
});

// ── HTTP wiring: unreachable server ──────────────────────────────────────────

describe("cli: unreachable server", () => {
  test("collections list against a closed port → exit 1, clean error", async () => {
    // Grab a port that is guaranteed free (bind then release it).
    const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
    const deadPort = probe.port;
    probe.stop(true);

    const r = await runCli(["collections", "list"], {
      env: { BACKLEX_URL: `http://127.0.0.1:${deadPort}` },
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("collections list:");
    expectNoStackTrace(r);
  }, T);
});

// ── gen-types: the first command a developer runs ────────────────────────────

/**
 * `gen-types.test.ts` covers `renderModule` — the pure half — against a
 * scripted collection list. What it cannot cover is everything between the
 * developer's shell and that function: argv parsing, the `--key` header, the
 * fetch, the file write, and the exit code on a refusal.
 *
 * That matters more here than for most commands. `gen-types` is what a
 * developer runs first, its output is imported by their application code, and
 * a broken run that still exits 0 produces a plausible-looking file — an empty
 * `Collections` map compiles perfectly and silently unTypes every query.
 */
describe("cli: gen-types", () => {
  test("emits a module describing the live collections", async () => {
    const r = await runCli(["gen-types", baseUrl, "--key", apiKey]);
    expect(r.code).toBe(0);
    // Named against the collection this suite actually created, not against a
    // fixture — the point of the end-to-end path is that the fetch reached a
    // real workspace.
    expect(r.stdout).toContain(pascalish(SLUG));
    expect(r.stdout).toContain("export type Collections");
    expectNoStackTrace(r);
  }, T);

  test("--out writes the file and reports how much it wrote", async () => {
    const out = join(tmpDir, "types.ts");
    const r = await runCli(["gen-types", baseUrl, "--key", apiKey, "--out", out]);
    expect(r.code).toBe(0);
    expect(existsSync(out)).toBe(true);

    const written = readFileSync(out, "utf8");
    expect(written).toContain("export type Collections");
    // stdout must NOT also carry the module: a command that writes the file
    // and prints it too breaks `> file` redirection and doubles CI logs.
    expect(r.stdout).not.toContain("export type Collections");
    // The count in the confirmation is the only signal a developer gets that
    // the fetch found anything. `wrote types for 0 collection(s)` is the
    // silent-failure shape this asserts against.
    const count = /for (\d+) collection\(s\)/.exec(r.stdout)?.[1];
    expect(`collections reported: ${Number(count) > 0}`).toBe("collections reported: true");
  }, T);

  test("--sdk adds the typed client factory, plain does not", async () => {
    const plain = await runCli(["gen-types", baseUrl, "--key", apiKey]);
    const sdk = await runCli(["gen-types", baseUrl, "--key", apiKey, "--sdk"]);
    expect(sdk.code).toBe(0);
    // Asserted as a DIFFERENCE rather than as "sdk output contains X": a flag
    // that silently did nothing would satisfy the second and fail this.
    expect(sdk.stdout).toContain("createTypedClient");
    expect(plain.stdout).not.toContain("createTypedClient");
    // Plain output is documented as dependency-free — an import of the SDK
    // package in it would break every consumer who has not installed it.
    expect(plain.stdout).not.toContain("@backlex/client");
    expect(plain.stdout).not.toContain('from "backlex"');
  }, T);

  test("a bad key fails loudly instead of writing an empty module", async () => {
    const out = join(tmpDir, "should-not-exist.ts");
    const r = await runCli(["gen-types", baseUrl, "--key", "pak_not_a_real_key", "--out", out]);
    expect(r.code).not.toBe(0);
    // The file must not appear. A run that wrote an empty `Collections = {}`
    // and exited 0 is worse than one that failed: the developer's build keeps
    // working and every query loses its types.
    expect(existsSync(out)).toBe(false);
  }, T);

  test("no url → exit 1 with the usage line, not a stack trace", async () => {
    const r = await runCli(["gen-types"], { env: { BACKLEX_URL: undefined } });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("url required");
    expectNoStackTrace(r);
  }, T);
});

/** `cli_notes` → `CliNotes`, matching gen-types' own `pascal()`. */
function pascalish(slug: string): string {
  return slug
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((p) => p[0]!.toUpperCase() + p.slice(1))
    .join("");
}
