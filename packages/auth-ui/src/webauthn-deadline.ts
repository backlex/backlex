/**
 * Bound a WebAuthn ceremony so a prompt nobody answers cannot freeze the page.
 *
 * `navigator.credentials.create()` / `.get()` reject when the user cancels, but
 * they do not always settle at all: an environment with no authenticator, or a
 * prompt left sitting on a screen nobody is looking at, leaves the promise
 * pending forever. A `try/catch` cannot see that — neither branch runs — so an
 * `await` on one is an `await` with no upper bound.
 *
 * That was observable on a freshly provisioned tenant: **Claim this instance**
 * created the admin account (proven out of band — `POST /api/auth/sign-in/email`
 * returned 200 for it) and then sat on "Setting up passkey…" indefinitely, with
 * no error, no retry, and nothing to say the account already existed. Enrolment
 * is opt-OUT (`useState(supportsPasskey)`), so that is the default path.
 *
 * The sibling freeze — a stalled instance hanging the auth request itself — was
 * fixed by a 30s deadline on the auth client, and that fix says in its own
 * message that "WebAuthn ceremony is browser-native, unaffected". This is the
 * half it left.
 *
 * Racing does not cancel the ceremony; the OS dialog may still be open. That is
 * fine and deliberate: the point is that the *page* stops waiting on it. The
 * caller decides what a lapsed ceremony means — after sign-up the account is
 * already durable, so the right move is to carry on; on sign-in there is
 * nothing to carry on to, so the button comes back.
 */

/** Generous enough for a real person to find their key; short enough that a
 *  ceremony which will never settle does not read as a hung page. */
export const WEBAUTHN_DEADLINE_MS = 90_000;

/** Thrown when the ceremony outlived its deadline, so callers can tell it apart
 *  from a genuine rejection (a cancel, a wrong key, an unsupported device). */
export class WebAuthnTimeout extends Error {
  constructor(ms: number) {
    super(`Passkey prompt did not complete within ${Math.round(ms / 1000)}s`);
    this.name = "WebAuthnTimeout";
  }
}

export const withWebAuthnDeadline = async <T>(
  ceremony: Promise<T>,
  ms: number = WEBAUTHN_DEADLINE_MS,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      ceremony,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new WebAuthnTimeout(ms)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};
