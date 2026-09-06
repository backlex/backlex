/**
 * Pre-prod audit 2026-09, Faz 7 — input handling and limits.
 *
 * Four findings, each reproduced against the real code before it was fixed:
 *
 *   1. `adapters/storage.fs.ts` built the multipart temp path by appending a
 *      CALLER-SUPPLIED upload id to an already-root-checked key, so the id's
 *      parent-directory hops were resolved by the kernel and never by the
 *      guard. Two signed S3 requests wrote a file outside the storage root.
 *   2. `client/admin/collections/item-form.tsx` handed a stored `richtext`
 *      value to `dangerouslySetInnerHTML`. Covered by
 *      `tests/client/html-preview-sandbox.test.tsx`, which needs a DOM.
 *   3. Eleven copies of an IP derivation read `cf-connecting-ip` first on every
 *      runtime, so off Cloudflare every IP-keyed limiter had one bucket per
 *      request — i.e. no limit.
 *   4. `services/graphql/cost.ts::measure` was exponential in fragment fan-out,
 *      so the guard that refuses an unaffordable document was itself the cost.
 *
 * Each block asserts BOTH directions: the thing that must now be refused, and
 * the legitimate neighbour that must still work. A guard that refuses
 * everything passes a one-sided test and breaks the product.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { parse } from "graphql";
import { fsStorage } from "../src/server/adapters/storage.fs";
import {
  guardLogicalKey,
  guardLogicalPrefix,
} from "../src/server/services/storage/keys";
import { clientAddress, clientAddressKey } from "../src/server/lib/client-address";
import {
  MAX_MEASURE_NODES,
  budgetFromEnv,
  measure,
  overBudget,
} from "../src/server/services/graphql/cost";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const JSON_HEADERS = { "content-type": "application/json" };

/** `uploadPart` declares its body as bytes or a stream; a plain string is
 *  accepted at runtime but not by the contract, so the specs encode. */
const bytes = (v: string): Uint8Array => new TextEncoder().encode(v);

// ─────────────────────────────────────────────────────────────────────────────
// 1. The fs storage adapter — a caller-supplied fragment reaching a path
// ─────────────────────────────────────────────────────────────────────────────

describe("fs storage — the multipart upload id cannot leave the storage root", () => {
  let base = "";
  let root = "";
  let outside = "";

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "faz7-"));
    root = join(base, "storage");
    // A sibling of the root, INSIDE the same temp dir: the payloads here stay
    // synthetic on purpose. A literal system path in a spec ships in the worker
    // bundle and trips Cloudflare's managed WAF on template upload.
    outside = join(base, "elsewhere");
    mkdirSync(root, { recursive: true });
    mkdirSync(outside, { recursive: true });
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  /** The exact two-step shape from the finding. Step 1 creates a directory the
   *  kernel can take a parent hop FROM (`uploadPart` does not create parents);
   *  step 2 is the hostile id. */
  const hostileId = (): string => {
    const depth = resolve(root, "tenants/t1/x").split(sep).length - 1;
    return `${"/..".repeat(depth)}${outside}/evil`;
  };

  test("a hostile upload id is refused, and writes nothing", async () => {
    const s = fsStorage(root);
    // Step 1: the trailing-dot segment the old key guard allowed.
    await s.put({ key: "tenants/t1/x./y", body: "seed" });

    await expect(
      s.uploadPart!("tenants/t1/x", hostileId(), 1, bytes("OWNED"), 5),
    ).rejects.toThrow();

    // The assertion that matters is not "it threw" but "nothing landed".
    expect(await readdir(outside)).toEqual([]);
  });

  test("every multipart verb refuses it, not just the one in the finding", async () => {
    const s = fsStorage(root);
    const id = hostileId();
    await expect(s.createMultipart!(`../${id}`)).rejects.toThrow();
    await expect(s.uploadPart!("tenants/t1/x", id, 1, bytes("x"), 1)).rejects.toThrow();
    await expect(s.completeMultipart!("tenants/t1/x", id, [])).rejects.toThrow();
    await expect(s.abortMultipart!("tenants/t1/x", id)).rejects.toThrow();
    expect(await readdir(outside)).toEqual([]);
  });

  test("a separator alone in the upload id is refused — no traversal needed", async () => {
    // This is what SEPARATES the two halves of the fix. `x.a/b.uploading`
    // stays under the root, so the path check has nothing to object to; only
    // the charset does. Without it, a break that deletes the charset check
    // passes every other assertion here.
    //
    // Matched on the MESSAGE, and that is the whole test. A bare `.toThrow()`
    // went green against the broken build too — `appendFile` fails with ENOENT
    // because the parent directory of the smuggled path does not happen to
    // exist. A guard verified by an error the filesystem raised for its own
    // reasons is not verified at all; create that directory first and the
    // write succeeds.
    const s = fsStorage(root);
    await expect(s.uploadPart!("tenants/t1/x", "a/b", 1, bytes("x"), 1)).rejects.toThrow(
      /upload id/,
    );
  });

  test("an empty key cannot make the temp file a SIBLING of the root", async () => {
    // And this separates them the other way. `path("")` resolves to the root
    // itself and passes its own check, so the temp name becomes
    // `<root>.<id>.uploading` — a path outside the root built entirely from
    // characters the charset allows. Only re-checking the FINISHED path sees
    // it. `guardLogicalKey` refuses an empty key, so no route reaches this;
    // the adapter is the last line of defence and has to hold alone.
    const s = fsStorage(root);
    await expect(
      s.uploadPart!("", "11111111-2222-3333-4444-555555555555", 1, bytes("x"), 1),
    ).rejects.toThrow(/storage root/);
  });

  test("an ordinary server-issued id still round-trips end to end", async () => {
    // The other direction. Every id this adapter mints is a uuid, so an upload
    // that was already IN FLIGHT when the guard landed keeps working — its temp
    // file has exactly the name it had.
    const s = fsStorage(root);
    const { uploadId } = await s.createMultipart!("tenants/t1/big.bin");
    expect(uploadId).toMatch(/^[0-9a-f-]{36}$/);
    await s.uploadPart!("tenants/t1/big.bin", uploadId, 1, bytes("hello "), 6);
    await s.uploadPart!("tenants/t1/big.bin", uploadId, 2, bytes("world"), 5);
    const done = await s.completeMultipart!("tenants/t1/big.bin", uploadId, []);
    expect(done.size).toBe(11);
    const got = await s.get("tenants/t1/big.bin");
    expect(await new Response(got!.body).text()).toBe("hello world");
  });

  test("the temp file is still inside the root while an upload is in flight", async () => {
    const s = fsStorage(root);
    const { uploadId } = await s.createMultipart!("tenants/t1/big.bin");
    await s.uploadPart!("tenants/t1/big.bin", uploadId, 1, bytes("x"), 1);
    expect(existsSync(join(root, "tenants/t1", `big.bin.${uploadId}.uploading`))).toBe(true);
  });
});

describe("logical keys — the guard is not weaker than it looks", () => {
  test("a segment that is only dots is refused, at any length", () => {
    for (const k of ["a/./b", "a/../b", "a/.../b", "./x", "x/.."]) {
      expect(() => guardLogicalKey(k)).toThrow();
    }
    // Which RULE refused it is part of the contract: a traversal hop has to
    // report as one. Without this the two dot rules are interchangeable and
    // neither is individually pinned — removing either leaves the suite green.
    expect(() => guardLogicalKey("a/../b")).toThrow(/path-traversal/);
    expect(() => guardLogicalKey("a/.../b")).toThrow(/dot or a space/);
  });

  test("a segment ending in a dot is refused — it is a hop's launch pad", () => {
    // The exact segment step 1 of the traversal needed. Also what Windows
    // silently strips, so `x.` and `x` name the same object there.
    expect(() => guardLogicalKey("x./y")).toThrow();
    expect(() => guardLogicalKey("dir/x.")).toThrow();
    expect(() => guardLogicalKey("dir/x ")).toThrow();
  });

  test("the multipart temp suffix is reserved", () => {
    // Otherwise an uploaded object can occupy the name of an upload in flight,
    // and `list` (which skips the suffix) hides it from storage accounting.
    expect(() => guardLogicalKey("a/b.uploading")).toThrow();
  });

  test("ordinary keys still pass — including dots that are not segments", () => {
    for (const k of ["logo.png", "a/b/c.tar.gz", "2026.01.02/report.pdf", "a.b.c"]) {
      expect(() => guardLogicalKey(k)).not.toThrow();
    }
  });

  test("a LIST prefix is judged by its own, smaller rule", () => {
    // Empty means "everything in scope", and the last segment is a PARTIAL
    // name — so a trailing dot there is an ordinary request, not an attack.
    expect(() => guardLogicalPrefix("")).not.toThrow();
    expect(() => guardLogicalPrefix("invoices/inv")).not.toThrow();
    expect(() => guardLogicalPrefix("report.")).not.toThrow();
    expect(() => guardLogicalPrefix("a/b/")).not.toThrow();
    // But it still may not leave the workspace's subtree.
    expect(() => guardLogicalPrefix("a/../../b")).toThrow();
    expect(() => guardLogicalPrefix("/etc")).toThrow();
    expect(() => guardLogicalPrefix("tenants/other")).toThrow();
    expect(() => guardLogicalPrefix("a%2f%2e%2e%2fb")).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. One client-address derivation, and it does not believe the caller
// ─────────────────────────────────────────────────────────────────────────────

const reqWith = (headers: Record<string, string>): Request =>
  new Request("http://localhost/api/anything", { headers });

describe("client address — a header is read only where something set it", () => {
  test("with nothing configured, a caller-supplied cf-connecting-ip is ignored", () => {
    // The finding, in one assertion. The suite does not run on Workers, so
    // `isCloudflareWorkers()` is false and this header has no standing.
    expect(clientAddress(reqWith({ "cf-connecting-ip": "203.0.113.9" }), {})).toBeNull();
    expect(clientAddress(reqWith({ "x-real-ip": "203.0.113.9" }), {})).toBeNull();
    expect(clientAddress(reqWith({ "x-forwarded-for": "203.0.113.9" }), {})).toBeNull();
  });

  test("an absent address collapses to ONE bucket, never to a fresh one", () => {
    const a = clientAddressKey(reqWith({ "cf-connecting-ip": "203.0.113.1" }), {});
    const b = clientAddressKey(reqWith({ "cf-connecting-ip": "203.0.113.2" }), {});
    expect(a).toBe(b);
  });

  test("a configured header is read, and from the RIGHT of the list", () => {
    const env = { TRUSTED_PROXY_HEADER: "x-forwarded-for" };
    // Element [0] is what the ORIGINAL client sent — the end an attacker owns
    // even behind a correct proxy. The last hop is the one the proxy appended.
    expect(
      clientAddress(reqWith({ "x-forwarded-for": "1.1.1.1, 2.2.2.2, 9.9.9.9" }), env),
    ).toBe("9.9.9.9");
    expect(clientAddress(reqWith({ "x-forwarded-for": "9.9.9.9" }), env)).toBe("9.9.9.9");
  });

  test("configuring one header does not re-open the others", () => {
    const env = { TRUSTED_PROXY_HEADER: "x-real-ip" };
    expect(clientAddress(reqWith({ "cf-connecting-ip": "203.0.113.9" }), env)).toBeNull();
    expect(clientAddress(reqWith({ "x-real-ip": "198.51.100.4" }), env)).toBe("198.51.100.4");
  });

  test("the configured header is matched case-insensitively and trimmed", () => {
    expect(
      clientAddress(reqWith({ "x-real-ip": "198.51.100.4" }), {
        TRUSTED_PROXY_HEADER: "  X-Real-IP  ",
      }),
    ).toBe("198.51.100.4");
  });
});

describe("auth brute-force limits survive a forged header", () => {
  let h: TestHarness;
  // The production default: no proxy declared, so nothing the caller sends is
  // believed. The harness normally declares `x-forwarded-for` so specs get one
  // bucket each; this block deliberately opts out of that.
  beforeEach(() => {
    h = makeHarness({ TRUSTED_PROXY_HEADER: undefined });
  });
  afterEach(() => h.cleanup());

  /** A distinct EMAIL per attempt, and that is load-bearing.
   *
   *  `authLockoutMiddleware` locks an account after 8 failures in 15 minutes,
   *  keyed on the email and across all IPs. Reusing one address made this test
   *  pass against a build with the IP derivation still broken: the lockout was
   *  what answered 429. The two 429s are told apart by their message, asserted
   *  below — a rate-limit test that cannot say WHICH limiter fired is not a
   *  rate-limit test. */
  const signIn = (n: number) =>
    h.app.fetch(
      new Request(`${h.env.APP_URL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: {
          ...JSON_HEADERS,
          origin: h.env.APP_URL as string,
          // A different claimed address every time — the whole attack.
          "cf-connecting-ip": `203.0.113.${n}`,
          "x-forwarded-for": `203.0.113.${n}`,
          "x-real-ip": `203.0.113.${n}`,
        },
        body: JSON.stringify({
          email: `nobody-${n}@example.com`,
          password: "wrong-password",
        }),
      }),
      h.env,
    );

  test("a fresh cf-connecting-ip per request no longer buys a fresh bucket", async () => {
    // The sign-in rule is 10/min per IP. Before the fix each of these landed in
    // its own bucket and the limiter never fired, on every runtime except
    // Workers.
    let body = "";
    let limited = false;
    for (let i = 1; i <= 14 && !limited; i++) {
      const res = await signIn(i);
      if (res.status === 429) {
        limited = true;
        body = await res.text();
      }
    }
    expect(limited).toBe(true);
    // The per-IP limiter, not the per-account lockout.
    expect(body).toContain("Too many auth requests");
  });
});

describe("the harness declares the proxy it actually is", () => {
  let h: TestHarness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => h.cleanup());

  test("with TRUSTED_PROXY_HEADER set, per-spec IP isolation still works", () => {
    // Every other spec in the suite depends on this: `withSyntheticIp` gives
    // each harness its own `X-Forwarded-For` so they do not share the auth
    // limiter. If the derivation stopped reading it, ~600 files would start
    // fighting over one bucket.
    expect(h.env.TRUSTED_PROXY_HEADER).toBe("x-forwarded-for");
    expect(
      clientAddress(reqWith({ "x-forwarded-for": "127.0.0.5" }), h.env),
    ).toBe("127.0.0.5");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. The GraphQL cost guard is no longer the expense
// ─────────────────────────────────────────────────────────────────────────────

/** N fragments, each spreading the next one TWICE. Legal GraphQL, acyclic, and
 *  walked 2^N times by a walk that only cuts off the current path. */
const fanOut = (n: number): string => {
  const frags: string[] = [];
  for (let i = 0; i < n; i++) frags.push(`fragment f${i} on Q { ...f${i + 1} ...f${i + 1} }`);
  frags.push(`fragment f${n} on Q { id }`);
  return `query { things { ...f0 } }\n${frags.join("\n")}`;
};

describe("GraphQL cost — a fragment DAG is refused, not walked", () => {
  const budget = budgetFromEnv({});

  test("the document from the finding is refused", () => {
    const r = measure(parse(fanOut(22)));
    expect(r.truncated).toBe(true);
    expect(overBudget(parse(fanOut(22)), budget)).toContain("too complex to measure");
  });

  test("measuring it is BOUNDED — the assertion the finding is really about", () => {
    // Measured on this module before the fix: N=22 took 4.9 s and N=26 would
    // have taken ~80 s, from a body under 1 KB. Neither the depth budget (2)
    // nor the alias budget (0) could refuse it, and the verdict only existed
    // after the walk. The ceiling below is deliberately loose — a slow shared
    // CI box must not make this flaky — and still two orders of magnitude
    // under the old figure.
    for (const n of [22, 26, 40]) {
      const doc = parse(fanOut(n));
      const t0 = performance.now();
      const verdict = overBudget(doc, budget);
      const ms = performance.now() - t0;
      expect(verdict).not.toBeNull();
      expect(ms).toBeLessThan(2_000);
    }
  });

  test("more fragments does not mean more work", () => {
    // The shape of the old defect was that each extra fragment DOUBLED the
    // time. Pinning the ratio catches a regression that a single absolute
    // threshold on a fast machine would sail past.
    const time = (n: number): number => {
      const doc = parse(fanOut(n));
      const t0 = performance.now();
      measure(doc);
      return performance.now() - t0;
    };
    time(24); // warm
    const small = Math.max(time(24), 1);
    const large = Math.max(time(30), 1);
    expect(large / small).toBeLessThan(8);
  });

  test("an ordinary document is unaffected and reports the same figures", () => {
    const r = measure(
      parse(`{ orders(limit: 10) { lines(limit: 10) { parts(limit: 10) { id } } } }`),
    );
    expect(r.truncated).toBe(false);
    expect(r.depth).toBe(4);
    expect(r.cost).toBeGreaterThanOrEqual(1000);
    expect(overBudget(parse(`{ orders(limit: 2) { id } }`), budget)).toBeNull();
  });

  test("legitimate fragment reuse is not mistaken for fan-out", () => {
    // A linear chain of 60 fragments is ordinary generated-client output. It
    // must stay far under the visit budget.
    const frags: string[] = [];
    for (let i = 0; i < 60; i++) frags.push(`fragment g${i} on Q { id name ...g${i + 1} }`);
    frags.push(`fragment g60 on Q { id }`);
    const r = measure(parse(`{ a { ...g0 } }\n${frags.join("\n")}`));
    expect(r.truncated).toBe(false);
  });

  test("a cyclic spread still terminates, and still reports a real figure", () => {
    const r = measure(parse(`{ a { ...F } } fragment F on A { a { ...F } }`));
    expect(r.truncated).toBe(false);
    expect(r.depth).toBeGreaterThan(0);
  });

  test("the visit budget is far above anything a real query reaches", () => {
    expect(MAX_MEASURE_NODES).toBeGreaterThanOrEqual(100_000);
  });
});

describe("GraphQL — the route refuses before it parses", () => {
  let h: TestHarness;
  beforeEach(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterEach(() => h.cleanup());

  const gql = (query: string) =>
    h.fetch("/api/graphql", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ query }),
    });

  test("the fan-out document is refused over HTTP, quickly", async () => {
    const t0 = performance.now();
    const res = await gql(fanOut(26));
    const ms = performance.now() - t0;
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).toContain("too complex to measure");
    expect(ms).toBeLessThan(5_000);
  });

  test("an oversized document is refused ahead of parse", async () => {
    const res = await gql(`{ a(x: "${"z".repeat(200_000)}") { id } }`);
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).toContain("too large");
  });

  test("an ordinary query still reaches the schema", async () => {
    // Not a 422: whatever GraphQL says about an unknown field, the budget must
    // not be what refused it.
    const res = await gql(`{ __typename }`);
    expect(res.status).not.toBe(422);
  });
});
