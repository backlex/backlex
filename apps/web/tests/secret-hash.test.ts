/**
 * Unit tests for `packages/auth/src/secret-hash.ts` — the one-way scrypt
 * hashing used by `hash`-typed collection fields (passwords, PINs, API
 * secrets). Pins:
 *
 *   - hash → verify roundtrip;
 *   - wrong plaintext fails;
 *   - hashes are salted (same input ⇒ different digests, both verify);
 *   - `isSecretHash` recognises the stored `<32-hex-salt>:<128-hex-key>` form;
 *   - a malformed / empty stored hash verifies `false` WITHOUT throwing (the
 *     service contract: a corrupt row must not 500 the verify endpoint);
 *   - empty-string edge cases.
 */
import { describe, expect, test } from "bun:test";
import { hashSecret, verifySecret, isSecretHash } from "@backlex/auth";

describe("secret-hash", () => {
  test("hash then verify roundtrip succeeds", async () => {
    const hash = await hashSecret("hunter2-but-longer");
    expect(await verifySecret("hunter2-but-longer", hash)).toBe(true);
  });

  test("wrong secret fails verification", async () => {
    const hash = await hashSecret("correct-secret");
    expect(await verifySecret("wrong-secret", hash)).toBe(false);
    // Prefix / suffix variants must not pass either.
    expect(await verifySecret("correct-secret ", hash)).toBe(false);
    expect(await verifySecret("correct-secre", hash)).toBe(false);
  });

  test("hashes are salted: same input produces distinct digests, both verify", async () => {
    const a = await hashSecret("same-input");
    const b = await hashSecret("same-input");
    expect(a).not.toBe(b); // random 16-byte salt per hash
    expect(await verifySecret("same-input", a)).toBe(true);
    expect(await verifySecret("same-input", b)).toBe(true);
  });

  test("stored format matches isSecretHash; plaintext does not", async () => {
    const hash = await hashSecret("format-check");
    expect(isSecretHash(hash)).toBe(true);
    // better-auth format: 32 hex chars (16-byte salt) ":" 128 hex chars (64-byte key)
    expect(hash).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/);
    expect(isSecretHash("format-check")).toBe(false);
    expect(isSecretHash("")).toBe(false);
    expect(isSecretHash("aa:bb")).toBe(false);
    // Uppercase hex is NOT accepted by the recogniser (format is lowercase).
    expect(isSecretHash(`${"A".repeat(32)}:${"A".repeat(128)}`)).toBe(false);
  });

  test("malformed stored hash fails cleanly (returns false, never throws)", async () => {
    expect(await verifySecret("whatever", "not-a-hash")).toBe(false);
    expect(await verifySecret("whatever", "aa:bb")).toBe(false);
    expect(await verifySecret("whatever", "")).toBe(false);
    expect(await verifySecret("whatever", ":")).toBe(false);
    // Right shape but truncated key half.
    expect(await verifySecret("whatever", `${"0".repeat(32)}:${"0".repeat(64)}`)).toBe(false);
  });

  test("well-formed but non-matching digest verifies false without throwing", async () => {
    const bogus = `${"0".repeat(32)}:${"0".repeat(128)}`;
    expect(isSecretHash(bogus)).toBe(true);
    expect(await verifySecret("anything", bogus)).toBe(false);
  });

  test("empty-string plaintext: hashable, verifies only against itself", async () => {
    const hash = await hashSecret("");
    expect(isSecretHash(hash)).toBe(true);
    expect(await verifySecret("", hash)).toBe(true);
    expect(await verifySecret("x", hash)).toBe(false);
    // Empty plaintext against a non-empty secret's hash must fail.
    const other = await hashSecret("non-empty");
    expect(await verifySecret("", other)).toBe(false);
  });
});
