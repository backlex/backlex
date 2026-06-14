/**
 * Cloud-brokered SSO — proj-worker side.
 *
 * Two layers:
 *  1. Unit — `verifyHandoffToken` accepts a correctly-signed token and rejects
 *     every tamper (wrong secret = project scoping, wrong aud, expiry, mangled
 *     body/sig).
 *  2. Route — `GET /api/auth/platform/sso/handoff` exchanges a cloud-minted
 *     token for a platform session: 302 + a working better-auth cookie, a `cloud`
 *     identity provisioned as `authenticated` (not admin, since the seeded admin
 *     is the first user), single-use replay → 401, and 404 when the install
 *     isn't a managed cloud tenant.
 *
 * The local `mintToken` mirrors the cloud minter
 * (`backlex-cloud .../lib/handoff-token.ts`) byte-for-byte; the real cross-repo
 * agreement is also covered by the end-to-end manual test.
 */
import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { Database } from "bun:sqlite";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import { verifyHandoffToken, type HandoffClaims } from "../src/server/lib/cloud-handoff";

const SECRET = "per-project-report-secret-abc123";
const PROJECT_ID = "proj-test-001";

// ---- local minter (mirror of the cloud side) -------------------------------

const b64urlFromBytes = (bytes: Uint8Array): string => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const hmacB64url = async (secret: string, data: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)),
  );
  return b64urlFromBytes(sig);
};
const mintToken = async (
  payload: Partial<HandoffClaims> & Pick<HandoffClaims, "email" | "subject">,
  secret = SECRET,
): Promise<string> => {
  const now = Math.floor(Date.now() / 1000);
  const full: HandoffClaims = {
    v: 1,
    iss: "backlex-cloud",
    aud: PROJECT_ID,
    name: "Brokered Operator",
    groups: [],
    iat: now,
    exp: now + 45,
    jti: crypto.randomUUID(),
    ...payload,
  };
  const body = b64urlFromBytes(new TextEncoder().encode(JSON.stringify(full)));
  return `${body}.${await hmacB64url(secret, body)}`;
};

// ---- unit: verifyHandoffToken ----------------------------------------------

describe("verifyHandoffToken", () => {
  test("accepts a correctly-signed, current token", async () => {
    const token = await mintToken({ email: "op@acme.test", subject: "cloud-user-1" });
    const claims = await verifyHandoffToken(token, SECRET, PROJECT_ID);
    expect(claims).not.toBeNull();
    expect(claims?.email).toBe("op@acme.test");
    expect(claims?.subject).toBe("cloud-user-1");
  });

  test("rejects an expired token", async () => {
    const past = Math.floor(Date.now() / 1000) - 10;
    const token = await mintToken({ email: "op@acme.test", subject: "u", iat: past - 45, exp: past });
    expect(await verifyHandoffToken(token, SECRET, PROJECT_ID)).toBeNull();
  });

  test("rejects a token signed with another project's secret (project scoping)", async () => {
    const token = await mintToken({ email: "op@acme.test", subject: "u" }, "some-other-project-secret");
    expect(await verifyHandoffToken(token, SECRET, PROJECT_ID)).toBeNull();
  });

  test("rejects a token minted for a different project (aud mismatch)", async () => {
    const token = await mintToken({ email: "op@acme.test", subject: "u", aud: "proj-OTHER" });
    expect(await verifyHandoffToken(token, SECRET, PROJECT_ID)).toBeNull();
  });

  test("rejects a tampered body", async () => {
    const token = await mintToken({ email: "op@acme.test", subject: "u" });
    const [body, sig] = token.split(".");
    const mangled = `${body!.slice(0, -1)}${body!.slice(-1) === "A" ? "B" : "A"}.${sig}`;
    expect(await verifyHandoffToken(mangled, SECRET, PROJECT_ID)).toBeNull();
  });

  test("rejects a tampered signature", async () => {
    const token = await mintToken({ email: "op@acme.test", subject: "u" });
    const [body, sig] = token.split(".");
    const mangled = `${body}.${sig!.slice(0, -1)}${sig!.slice(-1) === "A" ? "B" : "A"}`;
    expect(await verifyHandoffToken(mangled, SECRET, PROJECT_ID)).toBeNull();
  });

  test("rejects malformed / empty tokens", async () => {
    expect(await verifyHandoffToken("no-dot-here", SECRET, PROJECT_ID)).toBeNull();
    expect(await verifyHandoffToken("", SECRET, PROJECT_ID)).toBeNull();
    expect(await verifyHandoffToken(undefined, SECRET, PROJECT_ID)).toBeNull();
  });

  test("rejects when secret or projectId is missing", async () => {
    const token = await mintToken({ email: "op@acme.test", subject: "u" });
    expect(await verifyHandoffToken(token, "", PROJECT_ID)).toBeNull();
    expect(await verifyHandoffToken(token, SECRET, "")).toBeNull();
  });

  test("preserves a non-Latin1 name through utf8 base64url", async () => {
    const token = await mintToken({ email: "öp@acme.test", subject: "u", name: "Çağrı Ş“ä”" });
    const claims = await verifyHandoffToken(token, SECRET, PROJECT_ID);
    expect(claims?.name).toBe("Çağrı Ş“ä”");
    expect(claims?.email).toBe("öp@acme.test");
  });
});

// ---- route: GET /api/auth/platform/sso/handoff -----------------------------

const cloudEnv = {
  CLOUD_REPORT_SECRET: SECRET,
  CLOUD_PROJECT_ID: PROJECT_ID,
  CLOUD_REPORT_URL: "https://cloud.test",
} as const;

const handoff = (h: TestHarness, token: string) =>
  h.fetch(`/api/auth/platform/sso/handoff?token=${encodeURIComponent(token)}`);

describe("control-plane: cloud-brokered SSO handoff route", () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = makeHarness(cloudEnv);
    await seedAdmin(h); // admin = first user, so brokered users are non-first
  });
  afterAll(() => h.cleanup());

  test("happy path: 302, provisions a `cloud` identity as `authenticated`", async () => {
    const token = await mintToken({ email: "brokered@acme.test", subject: "cloud-user-42" });
    const res = await handoff(h, token);
    expect(res.status).toBe(302);

    const db = new Database(h.env.SQLITE_PATH!);
    const ident = db
      .query(
        "SELECT provider_type, provider_id, subject FROM platform_external_identities WHERE subject = ?",
      )
      .get("cloud-user-42") as { provider_type: string; provider_id: string } | undefined;
    expect(ident?.provider_type).toBe("cloud");
    expect(ident?.provider_id).toBe("cloud-broker");

    const roleRow = db
      .query(
        `SELECT r.name AS role FROM user_roles ur
           JOIN roles r ON r.id = ur.role_id
           JOIN users u ON u.id = ur.user_id
          WHERE u.email = ?`,
      )
      .get("brokered@acme.test") as { role: string } | undefined;
    expect(roleRow?.role).toBe("authenticated");
    db.close();
  });

  test("load-bearing: the minted cookie is accepted by better-auth get-session", async () => {
    // The happy-path handoff above set the brokered user's session cookie on the
    // harness jar; get-session must verify it (proves mintPlatformSession's cookie).
    const res = await h.fetch("/api/auth/get-session");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user?: { email?: string } } | null;
    expect(body?.user?.email).toBe("brokered@acme.test");
  });

  test("single-use: replaying the same token → 401", async () => {
    const token = await mintToken({ email: "replay@acme.test", subject: "cloud-user-replay" });
    expect((await handoff(h, token)).status).toBe(302);
    expect((await handoff(h, token)).status).toBe(401);
  });

  test("wrong-secret token → 401", async () => {
    const token = await mintToken(
      { email: "evil@acme.test", subject: "x" },
      "not-this-projects-secret",
    );
    expect((await handoff(h, token)).status).toBe(401);
  });

  test("token minted for another project (aud) → 401", async () => {
    const token = await mintToken({ email: "evil@acme.test", subject: "x", aud: "proj-OTHER" });
    expect((await handoff(h, token)).status).toBe(401);
  });
});

describe("control-plane: /api/users surfaces the auth provider", () => {
  let h: TestHarness;
  let admin: { email: string; password: string };

  beforeAll(async () => {
    h = makeHarness(cloudEnv);
    admin = await seedAdmin(h); // password operator (better-auth credential)
    // Broker a cloud operator in — this also leaves the brokered session in the
    // harness cookie jar, so we re-auth as admin before listing users.
    const token = await mintToken({ email: "broker-view@acme.test", subject: "cloud-view-1" });
    expect((await handoff(h, token)).status).toBe(302);
    const back = await h.fetch("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: admin.email, password: admin.password }),
    });
    expect(back.status).toBe(200);
  });
  afterAll(() => h.cleanup());

  test("brokered user shows provider=cloud; password admin shows provider=password", async () => {
    const res = await h.fetch("/api/users");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ email: string; provider: string }> };
    const brokered = body.data.find((u) => u.email === "broker-view@acme.test");
    const pwAdmin = body.data.find((u) => u.email === admin.email);
    expect(brokered?.provider).toBe("cloud");
    expect(pwAdmin?.provider).toBe("password");
  });
});

describe("control-plane: handoff 404s on a non-cloud install", () => {
  let h: TestHarness;
  beforeAll(async () => {
    h = makeHarness(); // no CLOUD_* bindings → not a managed cloud tenant
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  test("cloudConfigured=false → 404", async () => {
    const token = await mintToken({ email: "op@acme.test", subject: "u" });
    expect((await handoff(h, token)).status).toBe(404);
  });
});

describe("control-plane: handoff 404s when platform SSO is disabled", () => {
  let h: TestHarness;
  beforeAll(async () => {
    h = makeHarness({ ...cloudEnv, PLATFORM_SSO_ENABLED: "false" });
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  test("PLATFORM_SSO_ENABLED=false → 404", async () => {
    const token = await mintToken({ email: "op@acme.test", subject: "u" });
    expect((await handoff(h, token)).status).toBe(404);
  });
});
