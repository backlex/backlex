/**
 * A WebAuthn ceremony that never settles used to freeze the page it was on.
 *
 * `navigator.credentials.*` rejects on cancel, but it does not always settle:
 * an environment with no authenticator, or a prompt nobody answers, leaves the
 * promise pending forever — and `try/catch` cannot observe that, because
 * neither branch ever runs.
 *
 * Observed on a freshly provisioned tenant: "Claim this instance" created the
 * admin account (proven out of band — a later `POST /api/auth/sign-in/email`
 * returned 200 for it) and then sat on "Setting up passkey…" indefinitely with
 * no error, no retry, and nothing to say the account already existed. Enrolment
 * is opt-OUT, so that is the default path through the claim screen.
 */
import { describe, expect, test } from "bun:test";
import {
  WEBAUTHN_DEADLINE_MS,
  WebAuthnTimeout,
  withWebAuthnDeadline,
} from "@backlex/auth-ui";

describe("withWebAuthnDeadline", () => {
  test("a ceremony that never settles rejects instead of hanging forever", async () => {
    const never = new Promise<string>(() => {});
    await expect(withWebAuthnDeadline(never, 20)).rejects.toBeInstanceOf(WebAuthnTimeout);
  });

  test("the timeout is distinguishable from a real rejection", async () => {
    // The caller has to tell "the person cancelled" from "nothing answered":
    // after sign-up the account is already durable and the right move is to
    // carry on either way, but the message a person reads differs.
    const cancelled = Promise.reject(new Error("NotAllowedError"));
    await expect(withWebAuthnDeadline(cancelled, 1000)).rejects.not.toBeInstanceOf(WebAuthnTimeout);
  });

  test("a ceremony that completes in time passes its value straight through", async () => {
    await expect(withWebAuthnDeadline(Promise.resolve({ ok: true }), 1000)).resolves.toEqual({
      ok: true,
    });
  });

  test("the timer is cleared on the happy path", async () => {
    // Otherwise a pending timer keeps the event loop alive after the page has
    // moved on — and in a test runner that shows up as a suite that will not
    // exit, which is how this class of bug usually gets noticed too late.
    let live = 0;
    const realSet = globalThis.setTimeout;
    const realClear = globalThis.clearTimeout;
    globalThis.setTimeout = ((fn: never, ms: never) => {
      live++;
      return realSet(fn, ms);
    }) as typeof globalThis.setTimeout;
    globalThis.clearTimeout = ((id: never) => {
      live--;
      return realClear(id);
    }) as typeof globalThis.clearTimeout;
    try {
      await withWebAuthnDeadline(Promise.resolve(1), 5000);
      expect(live).toBe(0);
    } finally {
      globalThis.setTimeout = realSet;
      globalThis.clearTimeout = realClear;
    }
  });

  test("the default deadline is a real budget, not a hair trigger", () => {
    // Long enough for someone to find a security key in a drawer; short enough
    // that a ceremony which will never settle does not read as a hung page.
    expect(WEBAUTHN_DEADLINE_MS).toBeGreaterThanOrEqual(30_000);
    expect(WEBAUTHN_DEADLINE_MS).toBeLessThanOrEqual(180_000);
  });
});
