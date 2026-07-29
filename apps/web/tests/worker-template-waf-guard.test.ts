/**
 * Release gate: the worker-template tarball must not carry a literal attack
 * payload. The cloud repo publishes the bundle by PUTting every file to
 * `api.cloudflare.com`, which sits behind Cloudflare's managed WAF, so such a
 * literal — even inside a doc comment, since the worker build keeps comments —
 * makes that one object 403 with an HTML error page. It burned `worker-v0.4.98`.
 *
 * Pins both halves: the payload is caught, and the patterns that already ship
 * in vendor chunks are NOT (a guard that cries wolf gets deleted).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertNoWafSignatures,
  WAF_SIGNATURES,
} from "../../../scripts/build-worker-template";

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
});
