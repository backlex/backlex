/**
 * Access-token JWT lib — unit tests for `signAccessToken` / `verifyAccessToken`.
 *
 * These are pure (Web Crypto only, no DB), so they run without the harness.
 */
import { describe, expect, test } from "bun:test";
import {
  signAccessToken,
  verifyAccessToken,
  ACCESS_TOKEN_TTL_SECONDS,
} from "../src/server/lib/jwt";

const SECRET = "unit-test-secret-stable";

describe("jwt: sign → verify round-trip", () => {
  test("a freshly signed token verifies and carries the right claims", async () => {
    const { token, expiresIn } = await signAccessToken(SECRET, {
      sub: "user-1",
      tid: "tenant-1",
      sid: "session-1",
      email: "user@example.com",
    });
    expect(expiresIn).toBe(ACCESS_TOKEN_TTL_SECONDS);
    expect(token.split(".").length).toBe(3);

    const claims = await verifyAccessToken(SECRET, token);
    expect(claims).not.toBeNull();
    expect(claims!.sub).toBe("user-1");
    expect(claims!.tid).toBe("tenant-1");
    expect(claims!.sid).toBe("session-1");
    expect(claims!.email).toBe("user@example.com");
    expect(claims!.plane).toBe("app");
    expect(claims!.typ).toBe("access");
    expect(claims!.exp).toBeGreaterThan(claims!.iat);
  });

  test("a null email survives the round-trip", async () => {
    const { token } = await signAccessToken(SECRET, {
      sub: "u",
      tid: "t",
      sid: "s",
      email: null,
    });
    const claims = await verifyAccessToken(SECRET, token);
    expect(claims!.email).toBeNull();
  });
});

describe("jwt: rejections", () => {
  test("wrong secret → null", async () => {
    const { token } = await signAccessToken(SECRET, {
      sub: "u",
      tid: "t",
      sid: "s",
      email: null,
    });
    expect(await verifyAccessToken("a-different-secret", token)).toBeNull();
  });

  test("a tampered payload → null", async () => {
    const { token } = await signAccessToken(SECRET, {
      sub: "u",
      tid: "t",
      sid: "s",
      email: null,
    });
    const [h, , sig] = token.split(".");
    const forged = btoa(JSON.stringify({ sub: "attacker", typ: "access", plane: "app", exp: 9e9 }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(await verifyAccessToken(SECRET, `${h}.${forged}.${sig}`)).toBeNull();
  });

  test("an expired token → null", async () => {
    const { token } = await signAccessToken(
      SECRET,
      { sub: "u", tid: "t", sid: "s", email: null },
      -10,
    );
    expect(await verifyAccessToken(SECRET, token)).toBeNull();
  });

  test("an opaque session token (not a JWT) → null", async () => {
    expect(
      await verifyAccessToken(SECRET, `app_${crypto.randomUUID()}`),
    ).toBeNull();
  });

  test("a pak_ API key (not a JWT) → null", async () => {
    expect(await verifyAccessToken(SECRET, "pak_deadbeef_cafe")).toBeNull();
  });

  test("garbage strings → null, never throws", async () => {
    for (const bad of ["", "a.b", "a.b.c.d", "....", "not-a-token"]) {
      expect(await verifyAccessToken(SECRET, bad)).toBeNull();
    }
  });
});
