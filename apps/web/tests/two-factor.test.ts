/**
 * End-to-end TOTP two-factor flow against a real better-auth instance + temp
 * SQLite. Exercises the full lifecycle the UI drives:
 *
 *   enable (password) → verify-totp (code) → sign-out →
 *   sign-in (gets twoFactorRedirect, no session) → verify-totp → session.
 *
 * TOTP codes are generated in-test with node:crypto so we don't depend on a
 * wall clock the server can't see — the secret returned by `enable` (base32 in
 * the otpauth URI) is the HMAC key, exactly what an authenticator app uses.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

// RFC 4648 base32 decode (no padding) — the otpauth URI secret is uppercase
// A–Z/2–7. The decoded bytes are the raw HMAC key the server signs with.
const base32Decode = (input: string): Uint8Array => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = input.replace(/=+$/, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
};

// Standard RFC 6238 TOTP (SHA-1, 6 digits, 30s) over the decoded secret bytes.
const totp = (secretBytes: Uint8Array, period = 30, digits = 6): string => {
  const counter = Math.floor(Date.now() / 1000 / period);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", Buffer.from(secretBytes)).update(buf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const code =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  return (code % 10 ** digits).toString().padStart(digits, "0");
};

const secretFromUri = (uri: string): string =>
  new URL(uri).searchParams.get("secret") ?? "";

/** Read the user the admin SPA sees — `auth.useSession()` hits this endpoint,
 *  and it's where the Account → Security card reads `twoFactorEnabled`. */
const sessionUser = async (
  h: TestHarness,
): Promise<{ email?: string; twoFactorEnabled?: boolean } | null> => {
  const res = await h.fetch("/api/auth/get-session");
  if (!res.ok) return null;
  const body = (await res.json()) as
    | { user?: { email?: string; twoFactorEnabled?: boolean } }
    | { data?: { user?: { email?: string; twoFactorEnabled?: boolean } } }
    | null;
  return (
    (body as { user?: { twoFactorEnabled?: boolean } })?.user ??
    (body as { data?: { user?: { twoFactorEnabled?: boolean } } })?.data?.user ??
    null
  );
};

describe("two-factor (TOTP): enable → gated sign-in → verify", () => {
  let h: TestHarness;
  let email: string;
  let password: string;
  let secretBytes: Uint8Array;
  let backupCodes: string[] = [];

  beforeAll(async () => {
    h = makeHarness();
    const creds = await seedAdmin(h);
    email = creds.email;
    password = creds.password;
  });

  afterAll(() => h.cleanup());

  test("enable returns a TOTP URI + backup codes", async () => {
    const res = await h.fetch("/api/auth/two-factor/enable", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    expect(res.status).toBeLessThan(400);
    const body = (await res.json()) as {
      totpURI: string;
      backupCodes: string[];
    };
    expect(body.totpURI).toContain("otpauth://totp/");
    const secret = secretFromUri(body.totpURI);
    expect(secret.length).toBeGreaterThan(0);
    secretBytes = base32Decode(secret);
    backupCodes = body.backupCodes;
    expect(backupCodes.length).toBeGreaterThan(0);
  });

  test("2FA is not active until a code is verified", async () => {
    // The enrolment row is unverified, so the session must not yet advertise
    // 2FA as on — this is the flag the Account → Security card reads.
    const user = await sessionUser(h);
    expect(user?.twoFactorEnabled).toBeFalsy();
  });

  test("verify-totp with a valid code enables 2FA", async () => {
    const res = await h.fetch("/api/auth/two-factor/verify-totp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: totp(secretBytes) }),
    });
    expect(res.status).toBeLessThan(400);
    const user = await sessionUser(h);
    expect(user?.twoFactorEnabled).toBe(true);
  });

  test("verify-totp rejects a wrong code", async () => {
    const res = await h.fetch("/api/auth/two-factor/verify-totp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "000000" }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  test("after sign-out, password sign-in is gated by 2FA", async () => {
    await h.fetch("/api/auth/sign-out", { method: "POST" });
    expect((await h.fetch("/api/me")).status).toBe(401);

    const signIn = await h.fetch("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    expect(signIn.status).toBeLessThan(400);
    const body = (await signIn.json()) as { twoFactorRedirect?: boolean };
    expect(body.twoFactorRedirect).toBe(true);
    // Password alone must NOT yield a usable session.
    expect((await h.fetch("/api/me")).status).toBe(401);
  });

  test("verifying a TOTP code completes the gated sign-in", async () => {
    const res = await h.fetch("/api/auth/two-factor/verify-totp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: totp(secretBytes) }),
    });
    expect(res.status).toBeLessThan(400);
    const me = await h.fetch("/api/me");
    expect(me.status).toBe(200);
    const body = (await me.json()) as { data: { email: string } };
    expect(body.data.email).toBe(email);
  });

  test("a backup code also completes a gated sign-in", async () => {
    await h.fetch("/api/auth/sign-out", { method: "POST" });
    const signIn = await h.fetch("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const gated = (await signIn.json()) as { twoFactorRedirect?: boolean };
    expect(gated.twoFactorRedirect).toBe(true);

    const res = await h.fetch("/api/auth/two-factor/verify-backup-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: backupCodes[0] }),
    });
    expect(res.status).toBeLessThan(400);
    expect((await h.fetch("/api/me")).status).toBe(200);
  });
});

/** Helper: enable + verify TOTP for the current (signed-in) session, returning
 *  the secret bytes + initial backup codes. */
const setupTwoFactor = async (
  h: TestHarness,
  password: string,
): Promise<{ secretBytes: Uint8Array; backupCodes: string[] }> => {
  const enable = (await (
    await h.fetch("/api/auth/two-factor/enable", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    })
  ).json()) as { totpURI: string; backupCodes: string[] };
  const secretBytes = base32Decode(secretFromUri(enable.totpURI));
  await h.fetch("/api/auth/two-factor/verify-totp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: totp(secretBytes) }),
  });
  return { secretBytes, backupCodes: enable.backupCodes };
};

describe("two-factor recovery: regenerate backup codes", () => {
  let h: TestHarness;
  let email: string;
  let password: string;
  let oldCodes: string[];
  let newCodes: string[] = [];

  beforeAll(async () => {
    h = makeHarness();
    const creds = await seedAdmin(h);
    email = creds.email;
    password = creds.password;
    const s = await setupTwoFactor(h, password);
    oldCodes = s.backupCodes;
  });

  afterAll(() => h.cleanup());

  test("generate-backup-codes returns a fresh set", async () => {
    const res = await h.fetch("/api/auth/two-factor/generate-backup-codes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    expect(res.status).toBeLessThan(400);
    const body = (await res.json()) as { backupCodes?: string[] };
    expect(body.backupCodes?.length).toBeGreaterThan(0);
    newCodes = body.backupCodes ?? [];
    // The new set must differ from the originals.
    expect(newCodes).not.toEqual(oldCodes);
  });

  test("an OLD backup code is rejected, a NEW one is accepted", async () => {
    await h.fetch("/api/auth/sign-out", { method: "POST" });
    const gate = async () => {
      const r = await h.fetch("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const b = (await r.json()) as { twoFactorRedirect?: boolean };
      expect(b.twoFactorRedirect).toBe(true);
    };

    // Old code: rejected, and the sign-in stays ungranted.
    await gate();
    const stale = await h.fetch("/api/auth/two-factor/verify-backup-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: oldCodes[0] }),
    });
    expect(stale.status).toBeGreaterThanOrEqual(400);
    expect((await h.fetch("/api/me")).status).toBe(401);

    // New code: accepted, sign-in completes.
    const fresh = await h.fetch("/api/auth/two-factor/verify-backup-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: newCodes[0] }),
    });
    expect(fresh.status).toBeLessThan(400);
    expect((await h.fetch("/api/me")).status).toBe(200);
  });
});

describe("two-factor recovery: admin reset", () => {
  let h: TestHarness;
  let email: string;
  let password: string;

  beforeAll(async () => {
    h = makeHarness();
    const creds = await seedAdmin(h);
    email = creds.email;
    password = creds.password;
    await setupTwoFactor(h, password);
  });

  afterAll(() => h.cleanup());

  test("admin reset clears 2FA so sign-in is no longer gated", async () => {
    // The admin is a tenant member, so they can reset their own enrolment via
    // the user-admin route (the realistic flow targets another locked-out
    // user, but the gating + DB effect are identical).
    const user = await sessionUser(h);
    const session = await h.fetch("/api/auth/get-session");
    const uid = (
      (await session.json()) as
        | { user?: { id?: string } }
        | { data?: { user?: { id?: string } } }
    );
    const id =
      (uid as { user?: { id?: string } }).user?.id ??
      (uid as { data?: { user?: { id?: string } } }).data?.user?.id;
    expect(user?.twoFactorEnabled).toBe(true);
    expect(id).toBeTruthy();

    const reset = await h.fetch(`/api/users/${id}/reset-two-factor`, {
      method: "POST",
    });
    expect(reset.status).toBeLessThan(400);

    // Reset revokes sessions; a fresh password sign-in must now succeed with a
    // session directly — no twoFactorRedirect.
    const signIn = await h.fetch("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    expect(signIn.status).toBeLessThan(400);
    const body = (await signIn.json()) as { twoFactorRedirect?: boolean };
    expect(body.twoFactorRedirect).toBeFalsy();
    expect((await h.fetch("/api/me")).status).toBe(200);

    const after = await sessionUser(h);
    expect(after?.twoFactorEnabled).toBeFalsy();
  });
});
