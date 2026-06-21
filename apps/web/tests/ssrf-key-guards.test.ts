/**
 * Regression tests for the SSRF + storage-key-traversal hardening
 * (feat/security-hardening-2026-06):
 *   - `isPrivateHost` must catch loopback/RFC1918/link-local across the
 *     alternative IP encodings (decimal/octal/hex, IPv4-mapped IPv6) attackers
 *     use to slip past a naive dotted-decimal check.
 *   - `assertPublicHttpUrl` must reject non-http(s) + private hosts.
 *   - `guardLogicalKey` must reject path-traversal / absolute / null-byte keys
 *     so an upload key can't escape the `tenants/<tid>/` prefix or the fs root.
 */
import { describe, expect, test } from "bun:test";
import { isPrivateHost, assertPublicHttpUrl } from "../src/server/services/storage/hosts";
import { guardLogicalKey } from "../src/server/services/storage/keys";

describe("isPrivateHost", () => {
  test("blocks loopback / RFC1918 / link-local / CGNAT (dotted decimal)", () => {
    for (const h of [
      "localhost",
      "127.0.0.1",
      "10.0.0.5",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254", // cloud metadata
      "100.64.0.1", // CGNAT
      "0.0.0.0",
    ]) {
      expect(isPrivateHost(h)).toBe(true);
    }
  });

  test("blocks alternative IPv4 encodings of 127.0.0.1", () => {
    for (const h of [
      "2130706433", // decimal
      "0x7f.0.0.1", // hex octet
      "0177.0.0.1", // octal octet
    ]) {
      expect(isPrivateHost(h)).toBe(true);
    }
  });

  test("blocks IPv6 loopback / link-local / unique-local + IPv4-mapped", () => {
    for (const h of ["::1", "::", "fe80::1", "fc00::1", "fd12::1", "::ffff:127.0.0.1"]) {
      expect(isPrivateHost(h)).toBe(true);
    }
  });

  test("allows ordinary public hosts", () => {
    for (const h of ["example.com", "api.stripe.com", "8.8.8.8", "fcm.googleapis.com"]) {
      expect(isPrivateHost(h)).toBe(false);
    }
  });
});

describe("assertPublicHttpUrl", () => {
  test("rejects non-http(s) schemes", () => {
    expect(() => assertPublicHttpUrl("file:///etc/passwd")).toThrow();
    expect(() => assertPublicHttpUrl("ftp://example.com")).toThrow();
    expect(() => assertPublicHttpUrl("not a url")).toThrow();
  });

  test("rejects private/internal hosts", () => {
    expect(() => assertPublicHttpUrl("http://169.254.169.254/latest/meta-data/")).toThrow();
    expect(() => assertPublicHttpUrl("http://localhost:8787/")).toThrow();
  });

  test("accepts public https URLs", () => {
    expect(assertPublicHttpUrl("https://example.com/x").hostname).toBe("example.com");
  });
});

describe("guardLogicalKey", () => {
  test("rejects path traversal, absolute, backslash, and null-byte keys", () => {
    for (const k of [
      "../../../etc/passwd",
      "a/../../b",
      "./x",
      "/absolute",
      "a\\b",
      "a\0b",
      "",
      "tenants/other/x", // reserved prefix
    ]) {
      expect(() => guardLogicalKey(k)).toThrow();
    }
  });

  test("accepts ordinary nested keys", () => {
    for (const k of ["logo.png", "images/2026/avatar.webp", "a-b_c.txt"]) {
      expect(() => guardLogicalKey(k)).not.toThrow();
    }
  });
});
