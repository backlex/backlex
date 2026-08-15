/**
 * Guards the three properties that kept the remote D1 ledger unreadable for
 * ~290 deploys. Each one failed silently, which is why they are pinned by a
 * test rather than by a comment.
 *
 * The failure was self-reinforcing. `__drizzle_migrations` gets one row per
 * hash per deploy and nothing dedupes it, so production reached 34,811 rows for
 * 121 distinct hashes. `SELECT hash FROM __drizzle_migrations` then produced
 * ~2.8 MB on stdout, which exceeded spawnSync's 1 MB default `maxBuffer`. That
 * overflow is invisible in the worst way: `status: null`, stdout truncated
 * mid-JSON, and **stderr empty** — so the parse failed, the empty Set read as
 * "no migrations recorded", all 120 replayed, and the replay appended 120 more
 * rows for next time. 15 of every 16-minute build went here.
 *
 * These assertions read the source because the behaviour they protect only
 * manifests against a real remote D1 with a large ledger — there is nothing to
 * exercise locally, where the table is small enough that every version works.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = readFileSync(
  fileURLToPath(new URL("../../../packages/db/src/sqlite/migrate-d1.ts", import.meta.url)),
  "utf8",
);

const ledgerSelect = (): string => {
  const m = source.match(/const LEDGER_SELECT = `([^`]+)`/);
  if (!m?.[1]) throw new Error("LEDGER_SELECT not found in migrate-d1.ts");
  return m[1];
};

describe("migrate-d1 ledger read", () => {
  test("the ledger query selects DISTINCT hashes", () => {
    // Only the SET of hashes is ever used. Without DISTINCT the result grows by
    // 120 rows per deploy forever, which is what overflowed the buffer.
    expect(ledgerSelect()).toMatch(/DISTINCT/);
  });

  test("the ledger query contains no spaces", () => {
    // On the Cloudflare runner a spaced `--command=` argv element reached
    // wrangler split into four tokens (`Unknown arguments: hash, FROM, ...`).
    // SQLite treats `/**/` as whitespace, keeping it a single token.
    expect(ledgerSelect()).not.toMatch(/ /);
  });

  test("the wrangler spawn raises maxBuffer above the 1 MB default", () => {
    const m = source.match(/maxBuffer:\s*([0-9*\s]+)/);
    expect(m?.[1]).toBeDefined();
    // The literal is written as `64 * 1024 * 1024`; multiply the factors out
    // rather than evaluating source.
    const bytes = (m?.[1] ?? "0").split("*").reduce((a, b) => a * Number(b.trim()), 1);
    expect(bytes).toBeGreaterThan(1024 * 1024);
  });

  test("a failed ledger read is reported unconditionally, not gated on stderr", () => {
    // The original guard was `if (!r.ok && r.stderr)`. ENOBUFS leaves stderr
    // EMPTY, so that branch never ran and a failed read passed silently as an
    // empty ledger. The warning must not sit behind a stderr check.
    const readLedgerBody = source.slice(
      source.indexOf("const readLedger"),
      source.indexOf("// Bootstrap drizzle's tracking table"),
    );
    // Strip `//` comments first — the comment above the fix quotes the old
    // guard verbatim to explain it, and matching that text would make this
    // assertion fail on the very code it is meant to approve.
    const code = readLedgerBody
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    expect(code).toContain("ledger read FAILED");
    expect(code).not.toMatch(/if\s*\(!r\.ok && r\.stderr\)/);
  });
});
