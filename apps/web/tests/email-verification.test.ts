/**
 * Email-verification gating (OSS control plane). Mirrors the cloud behaviour:
 * when a real email transport is configured AND the instance policy opts in,
 * password sign-in is blocked until the address is confirmed. Critically, with
 * NO real email transport (the console adapter), the gate must stay OFF so a
 * new user is never locked out by a link that was only logged to stdout.
 *
 * Tests use the `resend` provider with a stubbed `globalThis.fetch` so the
 * verification mail is captured (and its link extracted) without a network
 * call. `requireEmailVerification` is a better-auth construction-time flag, so
 * the policy must exist *before* the auth instance is built — hence the
 * two-harness, shared-SQLite pattern: harness #1 bootstraps the admin and
 * writes the policy, harness #2 rebuilds against the same DB with the gate live.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { makeHarness, seedAdmin, } from "./setup";

const realFetch = globalThis.fetch;

/** Capture outbound Resend API calls and return success, so the verification
 *  mail is intercepted instead of hitting the network. Returns a getter for the
 *  most recent verification link. */
const stubResend = () => {
  const links: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("api.resend.com")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        html?: string;
        text?: string;
      };
      const blob = `${body.html ?? ""}\n${body.text ?? ""}`;
      const m = blob.match(/https?:\/\/[^\s"'<>]+/g);
      if (m) links.push(...m);
      return new Response(JSON.stringify({ id: "email_test" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return realFetch(input, init);
  }) as typeof fetch;
  return {
    lastVerifyLink: () => links.find((l) => l.includes("verify-email")) ?? null,
  };
};

describe("email verification gating", () => {
  let dbPath: string;
  const resendEnv = {
    RESEND_API_KEY: "re_test_key",
    EMAIL_FROM: "noreply@example.test",
  };

  beforeEach(() => {
    dbPath = resolve(tmpdir(), `backlex-emailverify-${randomUUID()}.sqlite`);
    mkdirSync(tmpdir(), { recursive: true });
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        rmSync(`${dbPath}${suffix}`, { force: true });
      } catch {
        /* ignore */
      }
    }
  });

  test("console email keeps the gate OFF even when the policy asks for it", async () => {
    // Default harness → console email transport. Turning the policy on must NOT
    // lock anyone out, because the verification link is only logged.
    const h = makeHarness({ SQLITE_PATH: dbPath });
    await seedAdmin(h);
    await h.fetch("/api/admin/auth/config", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ policy: { requireEmailVerification: true } }),
    });

    // Rebuild against the same DB so the (now-stored) policy is read at build.
    const h2 = makeHarness({ SQLITE_PATH: dbPath });
    const email = `user-${Date.now()}@example.test`;
    const signUp = await h2.fetch("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "correct-horse-battery", name: "U" }),
    });
    expect(signUp.status).toBeLessThan(400);
    // autoSignIn → already has a session; no verification gate with console mail.
    expect((await h2.fetch("/api/me")).status).toBe(200);
  });

  test("real email + policy ON blocks sign-in until verified, then allows it", async () => {
    const capture = stubResend();

    // Harness #1: bootstrap admin (first user is exempt) + enable the policy.
    const h1 = makeHarness({ SQLITE_PATH: dbPath, ...resendEnv });
    await seedAdmin(h1);
    const patch = await h1.fetch("/api/admin/auth/config", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ policy: { requireEmailVerification: true } }),
    });
    expect(patch.status).toBe(200);

    // Harness #2: same DB, rebuilt with the gate active.
    const h2 = makeHarness({ SQLITE_PATH: dbPath, ...resendEnv });
    const email = `gated-${Date.now()}@example.test`;
    const password = "correct-horse-battery";

    const signUp = await h2.fetch("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, name: "Gated" }),
    });
    expect(signUp.status).toBeLessThan(400);

    // A verification mail must have been sent.
    const link = capture.lastVerifyLink();
    expect(link).toBeTruthy();

    // Fresh client (no cookies) → password sign-in is rejected as unverified.
    const h3 = makeHarness({ SQLITE_PATH: dbPath, ...resendEnv });
    const signIn = await h3.fetch("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    expect(signIn.status).toBe(403);

    // Click the verification link, then sign-in succeeds.
    const path = new URL(link as string).pathname + new URL(link as string).search;
    await h3.fetch(path);
    const signIn2 = await h3.fetch("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    expect(signIn2.status).toBeLessThan(400);
    expect((await h3.fetch("/api/me")).status).toBe(200);
  });
});
