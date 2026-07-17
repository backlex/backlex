/**
 * Smoke test for the standalone self-host entry
 * `apps/web/src/server/entries/node.ts`.
 *
 * The entry targets Node (`@hono/node-server`), but nothing in it is
 * Node-exclusive — under Bun the same `node:http`-based server boots and
 * `buildContext` picks `bun:sqlite` via SQLITE_PATH (the production Node build
 * aliases `bun:sqlite` away and requires Postgres; that build step is out of
 * scope for `bun test`). So this spec exercises the entry's real boot path:
 * env parsing (`envFromSource`), `createApp`, SPA mount, the HTTP listener,
 * and the scheduler start — as a subprocess, the way an operator runs it.
 *
 * No hardcoded ports: PORT=0 lets the listener pick a free port, which the
 * entry prints ("backlex api listening on http://localhost:<port>") — the test
 * parses it from stdout, then polls /health.
 */
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Subprocess } from "bun";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
const ENTRY = "apps/web/src/server/entries/node.ts";

let child: Subprocess<"ignore", "pipe", "pipe"> | undefined;
let tmpDir: string | undefined;

afterAll(async () => {
  // Kill the server even when the test failed — no orphan processes.
  if (child) {
    child.kill("SIGTERM");
    await child.exited;
  }
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

/** Accumulate a subprocess stream until `pattern` matches (or timeout). */
const waitForOutput = async (
  stream: ReadableStream<Uint8Array>,
  pattern: RegExp,
  timeoutMs: number,
): Promise<{ match: RegExpExecArray; seen: string }> => {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let seen = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const chunk = await Promise.race([
        reader.read(),
        new Promise<null>((r) => setTimeout(() => r(null), remaining)),
      ]);
      if (chunk === null || chunk.done) break;
      seen += dec.decode(chunk.value, { stream: true });
      const match = pattern.exec(seen);
      if (match) return { match, seen };
    }
  } finally {
    reader.releaseLock();
  }
  throw new Error(`pattern ${pattern} not seen in output within ${timeoutMs}ms:\n${seen}`);
};

describe("entries/node.ts boots and serves /health", () => {
  test("subprocess boot → parse port from stdout → /health 200 ok", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "backlex-node-entry-"));
    const dbPath = join(tmpDir, "smoke.sqlite");

    // Apply the sqlite migrations the entry expects (argv[2] = db path).
    const mig = Bun.spawn(
      ["bun", "packages/db/src/sqlite/migrate.ts", dbPath],
      { cwd: REPO_ROOT, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    const migCode = await mig.exited;
    if (migCode !== 0) {
      throw new Error(
        `sqlite migration failed (${migCode}): ${await new Response(mig.stderr).text()}`,
      );
    }

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) env[k] = v;
    }
    Object.assign(env, {
      SQLITE_PATH: dbPath,
      // Blank out any ambient Postgres so buildContext picks bun:sqlite.
      DATABASE_URL: "",
      PORT: "0", // ← the listener picks a free port and prints it
      APP_URL: "http://localhost:5173",
      AUTH_SECRET: "node-entry-smoke-secret-stable",
      LOG_LEVEL: "error",
    });

    child = Bun.spawn(["bun", ENTRY], {
      cwd: REPO_ROOT,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    const { match } = await waitForOutput(
      child.stdout,
      /listening on http:\/\/localhost:(\d+)/,
      30_000,
    );
    const port = Number(match[1]);
    expect(port).toBeGreaterThan(0);

    // The log line races the listener by a hair — poll briefly.
    const deadline = Date.now() + 15_000;
    let res: Response | undefined;
    let lastErr: unknown;
    while (Date.now() < deadline) {
      try {
        res = await fetch(`http://127.0.0.1:${port}/health`);
        break;
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    if (!res) throw new Error(`/health never answered: ${String(lastErr)}`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; dialect: string; version: string };
    expect(body.ok).toBe(true);
    expect(body.dialect).toBe("sqlite");
    expect(typeof body.version).toBe("string");

    // Readiness probe exercises a real DB round-trip through the entry.
    const ready = await fetch(`http://127.0.0.1:${port}/health/ready`);
    expect(ready.status).toBe(200);
  }, 60_000);
});
