/**
 * Readiness must tell "the database is gone" apart from "the database is there
 * and has no schema yet".
 *
 * The probe used to be `SELECT 1`, which a reachable-but-unmigrated database
 * answers perfectly — so a deployment that had never been migrated reported
 * itself ready and then 500'd on every request with a body that said only
 * `INTERNAL`. It now probes `tenants` (created by the first migration) and
 * classifies the failure.
 *
 * The classifier is the subtle half, for a reason CLAUDE.md already records:
 * D1 puts the driver text on `cause` while bun:sqlite puts it on `message`, so
 * reading one of them is silently wrong on the other runtime. The error strings
 * below are verbatim from the real drivers.
 */
import { describe, expect, test } from "bun:test";
import { classifyDbProbeError } from "../src/server/app";

describe("readiness probe error classification", () => {
  test("D1 reports the missing table on `cause`, not `message`", () => {
    // Verbatim shape from miniflare/D1 on an unmigrated database — the outer
    // DrizzleQueryError's own message names the SQL, never the cause.
    const e = Object.assign(
      new Error('Failed query: select "id" from "tenants" where "tenants"."slug" = ? limit ?'),
      { cause: new Error("D1_ERROR: no such table: tenants: SQLITE_ERROR") },
    );
    const r = classifyDbProbeError(e);
    expect(r.reachable).toBe(true);
    expect(r.text).toContain("no such table");
  });

  test("bun:sqlite reports it on `message`", () => {
    const r = classifyDbProbeError(new Error("no such table: tenants"));
    expect(r.reachable).toBe(true);
  });

  test("postgres phrasing is recognised too", () => {
    const r = classifyDbProbeError(new Error('relation "tenants" does not exist'));
    expect(r.reachable).toBe(true);
  });

  test("a genuinely unreachable database is NOT reported as reachable", () => {
    // The case that must stay distinct: if this were classified as "reachable"
    // the probe would claim the database is merely unmigrated while it is down.
    for (const msg of [
      "connect ECONNREFUSED 127.0.0.1:5432",
      "D1_ERROR: Network connection lost",
      "timeout exceeded when trying to connect",
    ]) {
      expect(classifyDbProbeError(new Error(msg)).reachable).toBe(false);
    }
  });

  test("a non-Error throw does not crash the classifier", () => {
    expect(classifyDbProbeError("boom").reachable).toBe(false);
    expect(classifyDbProbeError(null).reachable).toBe(false);
    expect(classifyDbProbeError(undefined).text).toBe("");
  });
});
