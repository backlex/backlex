/**
 * Postgres is not available on the Cloudflare Workers bundle, and this pins
 * both halves of that — the runtime refusal and the claims that used to
 * contradict it.
 *
 * The bug this replaces: `docs/deployment.md`'s runtime matrix advertised
 * "D1, libSQL/Turso, or Hyperdrive→PG" for Workers, `wrangler.toml` shipped a
 * commented `[[hyperdrive]]` block explaining how to wire it, and
 * `context.ts` read `env.HYPERDRIVE?.connectionString` — while
 * `vite.config.ts` aliased `postgres`, `@neondatabase/serverless` and both
 * `@backlex/db/pg` entrypoints to shims for that very build. Anyone who
 * followed the documented matrix got a Worker that booted and then threw
 * `Postgres driver is not bundled on the D1 Workers build (pg-shim)` on its
 * first query — a message that reads like a build bug rather than an answer.
 *
 * The aliasing is not incidental: `@backlex/db/pg` is statically imported
 * across ~80 files, so un-aliasing it pulls every `pgTable` definition plus
 * `drizzle-orm/pg-core` into the eager cold-start graph. A Postgres-capable
 * Workers build is a different bundle, not a flag — which is why the capability
 * was removed rather than repaired.
 *
 * Both assertion styles are here on purpose. The behavioural one proves the
 * refusal actually fires; the file scans prove the docs and config stopped
 * promising the thing the refusal denies, because those two drifting apart
 * silently is the entire failure mode.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "bun:test";
import { AppError } from "@backlex/core";
import { buildContext } from "../src/server/context";
import type { Env } from "../src/server/env";

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

/** Force `isCloudflareWorkers()` — it keys off `navigator.userAgent`. */
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
const asWorkers = () => {
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent: "Cloudflare-Workers" },
    configurable: true,
    writable: true,
  });
};
const restoreNavigator = () => {
  if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
  else delete (globalThis as Record<string, unknown>).navigator;
};

/** Catches both a synchronous throw and a rejection from `buildContext`. */
const capture = async (env: Env): Promise<unknown> => {
  try {
    await buildContext(env);
    return null;
  } catch (e) {
    return e;
  }
};

describe("Postgres on Cloudflare Workers", () => {
  afterEach(restoreNavigator);

  test("a Workers isolate with only DATABASE_URL is refused, by name", async () => {
    asWorkers();
    // A fresh object each time — `buildContext` memoizes per `Env` on a WeakMap.
    const env = { DATABASE_URL: "postgres://u:p@example.invalid:5432/db" } as unknown as Env;
    // try/catch, not `.then(_, onRejected)`: the guard runs before the first
    // await in `buildContext`, so it throws SYNCHRONOUSLY and a rejection
    // handler never sees it.
    const err = await capture(env);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("UNAVAILABLE");
    const msg = (err as AppError).message;
    // The message has to answer "then what do I do", not just say no.
    expect(msg).toContain("Cloudflare Workers");
    expect(msg).toContain("LIBSQL_URL");
    // And it must not read as a bundler failure, which is what the shim said.
    expect(msg).not.toContain("pg-shim");
  });

  test("the guard is scoped to Workers, and to having no other database", () => {
    // A SOURCE assertion, deliberately, and the reason is worth stating: the
    // behavioural twin (same env, non-Workers navigator) takes the Postgres
    // branch, which runs boot-time auto-migrate against the URL — a DNS lookup
    // and a wall of SQL logging inside a unit suite. So the non-vacuity of the
    // first test is pinned by reading the condition instead: it must name the
    // runtime AND the two escape hatches, or `if (pgUrl)` alone would satisfy
    // the assertions above while breaking every self-host Postgres deploy.
    const ctx = read("../src/server/context.ts");
    const guard = ctx
      .split("\n")
      .find((l) => l.includes("isCloudflareWorkers()") && l.trim().startsWith("if ("));
    expect(guard).toBeDefined();
    expect(guard).toContain("!env.D1");
    expect(guard).toContain("!env.LIBSQL_URL");
    expect(guard).toContain("pgUrl");
  });

  test("`Env` no longer declares the Hyperdrive bindings", () => {
    // Leaving the fields declared is how the contradiction survived: the type
    // said the binding was supported and nothing read it on a runtime that
    // could act on it.
    const env = read("../src/server/env.ts");
    expect(env).not.toContain("HYPERDRIVE?:");
    expect(env).not.toContain("HYPERDRIVE_REPLICA?:");
  });

  test("wrangler.toml declares no hyperdrive binding, commented or not", () => {
    const toml = read("../wrangler.toml");
    // A commented-out block is what shipped before, and it read as
    // "supported, just opt in".
    expect(toml).not.toMatch(/^\s*#?\s*\[\[hyperdrive\]\]/m);
  });

  test("the deployment matrix does not offer Postgres on Workers", () => {
    const doc = read("../../../docs/deployment.md");
    const row = doc.split("\n").find((l) => l.startsWith("| **Database**"));
    expect(row).toBeDefined();
    // Leading "|" makes cell 0 empty, so Bun=1 and Workers=2 of the split.
    const cells = (row as string).split("|");
    const workersCell = cells[3] ?? "";
    expect(workersCell).not.toMatch(/hyperdrive/i);
    expect(workersCell).toMatch(/no Postgres/i);
  });
});
