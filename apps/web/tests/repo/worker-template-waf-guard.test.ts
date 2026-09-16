/**
 * Release gate: the worker-template tarball must not carry a literal attack
 * payload. The cloud repo publishes the bundle by PUTting every file to
 * `api.cloudflare.com`, which sits behind Cloudflare's managed WAF, so such a
 * literal — even inside a doc comment, since the worker build keeps comments —
 * makes that one object 403 with an HTML error page. It burned `worker-v0.4.98`.
 *
 * Pins both halves: the payload is caught, and the patterns that already ship
 * in vendor chunks are NOT (a guard that cries wolf gets deleted).
 *
 * …and then it burned `worker-v0.4.127` too, with every test below green.
 * Everything above this line examines fixtures this file writes itself, so it
 * proves `assertNoWafSignatures` WORKS and says nothing about whether this
 * repository would pass it — and `build-worker-template.ts` runs only on a
 * `worker-v*` tag. A doc comment naming an LFI path landed in `dc95fe6c` and
 * sat for five days and 230 commits, until somebody wanted a release. The last
 * test in this file is the missing half: the real signatures, over the real
 * source.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  assertNoWafSignatures,
  WAF_SIGNATURES,
} from "../../../../scripts/build-worker-template";

const stage = (files: Record<string, string>): string => {
  const dir = mkdtempSync(join(tmpdir(), "waf-guard-"));
  for (const [rel, body] of Object.entries(files)) {
    const path = join(dir, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, body);
  }
  return dir;
};

describe("worker-template WAF signature guard", () => {
  test("passes a bundle with no literal payloads", () => {
    const dir = stage({
      "worker/index.js": "export default { fetch() { return new Response('ok') } }",
      "worker/assets/keys.js": "// reject keys built from parent-directory segments\n",
      "client/index.html": "<!doctype html><script src=/a.js></script>",
      "migrations/0001.sql": "CREATE TABLE t (id text primary key);",
    });
    try {
      expect(() => assertNoWafSignatures(dir)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("catches the payload that burned v0.4.98 — in a comment, in a nested chunk", () => {
    // The exact shape that failed: an LFI path spelled out in a doc comment of
    // a code-split worker chunk.
    const payload = ["/etc", "passwd"].join("/");
    const dir = stage({
      "worker/assets/context-abc.js": `/** walks out of the root on ../../..${payload} */\nexport const x = 1;\n`,
    });
    try {
      expect(() => assertNoWafSignatures(dir)).toThrow(/WAF-tripping literal/);
      expect(() => assertNoWafSignatures(dir)).toThrow(/context-abc\.js/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("does NOT flag patterns that already ship in vendor chunks", () => {
    // These upload fine today; flagging them would make the gate useless noise.
    const dir = stage({
      "client/assets/react-vendor.js":
        'el.setAttribute("onerror", h); if (u.startsWith("javascript:")) return; d.write("<script>")',
    });
    try {
      expect(() => assertNoWafSignatures(dir)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("skips binary assets rather than reading them as text", () => {
    const dir = stage({ "worker/assets/photon.wasm": "\0\0binary" });
    try {
      expect(() => assertNoWafSignatures(dir)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("every signature is a real regex and none match an empty bundle", () => {
    expect(WAF_SIGNATURES.length).toBeGreaterThan(0);
    for (const sig of WAF_SIGNATURES) {
      expect(sig.name.length).toBeGreaterThan(0);
      expect(sig.pattern.test("")).toBe(false);
    }
  });

  /**
   * The half the fixtures above cannot cover: THIS repo, at merge time.
   *
   * Scanned as source rather than as a built bundle because a build costs
   * minutes and this costs milliseconds — the point is to fail on the commit
   * that introduces the literal, not on the release three weeks later.
   *
   * `apps/web/src` and every package's `src` are what the tarball is built
   * from. Both halves are held to the same rule even though only one strictly has
   * to be: the worker bundle ships UNMINIFIED (checked — its chunks carry
   * hundreds of comment lines each), so a server comment is shipped bytes,
   * while the client's comments are minified away and only its string literals
   * survive. Uniform anyway, because "which bundle am I in" is not a question
   * worth asking in the middle of writing a security comment.
   *
   * Tests are excluded on purpose: the SSRF and storage specs pass these exact
   * payloads to the guards they exercise, and no test file ships.
   */
  test("no shipped source in THIS repo carries a WAF-tripping literal", () => {
    const repoRoot = join(import.meta.dir, "../../../..");
    const roots = ["apps/web/src", "packages"];
    const SKIP = new Set(["node_modules", "dist", ".git", "tests", "__tests__"]);
    const TEXT = /\.(ts|tsx|js|mjs|cjs|json|sql|html|css)$/;
    const hits: string[] = [];

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        if (SKIP.has(entry)) continue;
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) {
          walk(p);
          continue;
        }
        if (!TEXT.test(entry) || /\.test\.(ts|tsx)$/.test(entry)) continue;
        const text = readFileSync(p, "utf8");
        for (const sig of WAF_SIGNATURES) {
          const m = text.match(sig.pattern);
          if (m) hits.push(`${relative(repoRoot, p)}: ${sig.name} (${JSON.stringify(m[0])})`);
        }
      }
    };
    for (const r of roots) walk(join(repoRoot, r));

    // Named, not counted: the fix is always "describe the payload in prose"
    // (`scripts/build-worker-template.ts` says so in its own error), and that
    // is only actionable if the failure says which file and which literal.
    expect(hits).toEqual([]);
  });
});
