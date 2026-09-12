/**
 * The two write doors and the reader must agree about what a credential
 * `prefix` is.
 *
 * A stored prefix is not decoration: `routes/s3/index.ts` computes
 * `effective = requestPrefix.startsWith(scope) ? requestPrefix : scope` and
 * hands the result to `guardLogicalPrefix`. So a prefix the write door accepted
 * but the reader refuses is not a cosmetic disagreement — it makes every LIST
 * with that credential answer 400, and the row that caused it was written by
 * the product itself.
 *
 * `normalizePrefix` DID exist on both doors, so the shape #328 describes
 * ("no validation on the create door") is not the mechanism. The mechanism is
 * that it was a DIFFERENT, weaker validator than the reader's: it refused
 * `/…` and any `..` substring, while the reader also refuses backslashes,
 * `?`/`#`, NUL bytes, the reserved `tenants/` prefix, invalid percent-encoding,
 * a `.` segment, and traversal that only appears after decoding. Faz 7 hardened
 * the reader; nothing carried those rules back to the writers.
 *
 * The corpus below is therefore checked AGAINST THE READER rather than against
 * a hand-written list of blessed strings. A list would be correct today and
 * stale the next time `guardLogicalPrefix` grows a rule — which is exactly how
 * this got here. See "guard allowlists launder defects".
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import { guardLogicalPrefix } from "../src/server/services/storage/keys";

const json = { "Content-Type": "application/json" };
const BASE = "/api/admin/s3-credentials";

/** What the READER says about this prefix. The writers must say the same. */
const readerAccepts = (prefix: string): boolean => {
  try {
    guardLogicalPrefix(prefix);
    return true;
  } catch {
    return false;
  }
};

/**
 * Every shape either side has ever had an opinion about, plus ordinary ones.
 * Deliberately mixed: a corpus that is all-bad passes a writer that refuses
 * everything, and a corpus that is all-good passes one that refuses nothing.
 */
const CORPUS = [
  // ordinary, and must keep working
  "backups/",
  "backups/2026/",
  "a-b_c.d/",
  "ünlü/",
  // reader-refused shapes the old writer let through
  "a\\b",
  "a?b",
  "a#b",
  "tenants/",
  "tenants/abc/",
  "a\0b",
  "./foo",
  "foo/./bar",
  "%2e%2e/",
  "%zz",
  // refused by both, from the start
  "/absolute",
  "../up",
  "foo/../bar",
  // allowed by the reader, refused by the OLD writer's blunt `includes("..")`
  "a..b",
  "release..2026/",
];

describe("an S3 credential prefix", () => {
  let h: TestHarness;

  const post = (body: unknown) =>
    h.fetch(BASE, { method: "POST", headers: json, body: JSON.stringify(body) });
  const patch = (id: string, body: unknown) =>
    h.fetch(`${BASE}/${id}`, { method: "PATCH", headers: json, body: JSON.stringify(body) });

  /** A credential to PATCH against, made fresh so one test cannot poison another. */
  const makeOne = async (): Promise<string> => {
    const res = await post({ name: `probe-${crypto.randomUUID().slice(0, 8)}` });
    expect(res.status).toBe(201);
    return ((await res.json()) as { data: { id: string } }).data.id;
  };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  test("the corpus is not one-sided (vacuous-pass guard)", () => {
    const good = CORPUS.filter(readerAccepts);
    const bad = CORPUS.filter((p) => !readerAccepts(p));
    // If either side of this collapses, every assertion below could pass for
    // the wrong reason — a writer that refuses everything, or one that refuses
    // nothing, would still go green.
    expect(good.length).toBeGreaterThanOrEqual(5);
    expect(bad.length).toBeGreaterThanOrEqual(8);
  });

  test("the CREATE door answers exactly what the reader would", async () => {
    for (const prefix of CORPUS) {
      const res = await post({ name: `c-${crypto.randomUUID().slice(0, 8)}`, prefix });
      const accepted = res.status === 201;
      expect({ prefix, accepted }).toEqual({ prefix, accepted: readerAccepts(prefix) });
      // 422, not 400: this is the admin JSON API, where `VALIDATION` maps to
      // 422. The 400 in #328 is the S3 XML surface's own `InvalidArgument`,
      // which is a different door with a different protocol. Pinned so a
      // refusal cannot quietly become a 500 or a 403.
      if (!accepted) expect(res.status).toBe(422);
    }
  });

  test("the UPDATE door answers exactly what the reader would", async () => {
    for (const prefix of CORPUS) {
      const id = await makeOne();
      const res = await patch(id, { prefix });
      const accepted = res.status === 200;
      expect({ prefix, accepted }).toEqual({ prefix, accepted: readerAccepts(prefix) });
      // 422, not 400: this is the admin JSON API, where `VALIDATION` maps to
      // 422. The 400 in #328 is the S3 XML surface's own `InvalidArgument`,
      // which is a different door with a different protocol. Pinned so a
      // refusal cannot quietly become a 500 or a 403.
      if (!accepted) expect(res.status).toBe(422);
    }
  });

  test("an accepted prefix reads back unchanged", async () => {
    // Refused-not-normalized is the stated posture: silently rewriting a scope
    // WIDENS it, which is the opposite of what an admin editing a scope means.
    // So an accepted value must survive the round trip byte for byte.
    const res = await post({ name: `keep-${crypto.randomUUID().slice(0, 8)}`, prefix: "backups/2026/" });
    expect(res.status).toBe(201);
    const id = ((await res.json()) as { data: { id: string; prefix: string } }).data.id;

    const list = await h.fetch(BASE);
    expect(list.status).toBe(200);
    const rows = ((await list.json()) as { data: { id: string; prefix: string | null }[] }).data;
    expect(rows.find((r) => r.id === id)?.prefix).toBe("backups/2026/");
  });

  test("a blank prefix stores as null, not as an empty string", async () => {
    // `withinPrefix` is `!row.prefix || key.startsWith(row.prefix)`, so "" and
    // null both mean "whole bucket" today. Pinned because the two stop being
    // interchangeable the moment anything asks "is this credential scoped?".
    const res = await post({ name: `blank-${crypto.randomUUID().slice(0, 8)}`, prefix: "   " });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { data: { prefix: string | null } }).data.prefix).toBeNull();
  });
});
