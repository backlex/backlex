import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  SignInPage,
  type SignInPageProps,
  SignUpPage,
  type SignUpPageProps,
} from "@backlex/auth-ui";

/**
 * Regression guard for the frozen primary button (fix `21230e36`).
 *
 * A stalled instance (cold Worker + slow/provisioning DB) made the auth call
 * hang, and the submits awaited it with no `try`/`catch` — so a rejection (or
 * the client-level 30s fetch timeout aborting) left the button stuck on
 * "Signing in…" / "Claiming…" forever: no error, no retry, no way out.
 *
 * The distinction these tests pin is the one the bug turned on. An auth call
 * that *resolves* with `{ error }` was always handled; what wasn't is one that
 * **rejects**. So the stubs below throw rather than return an error envelope —
 * a test that only covered the resolved-error path would have passed against
 * the broken code.
 */

const COPY = {
  signInFailed: "Sign-in failed",
  submit: "Sign in",
  submitBusy: "Signing in…",
  emailLabel: "Email",
  passwordLabel: "Password",
  title: "t",
  description: "d",
  missingFields: "missing",
} as unknown as SignInPageProps["copy"];

const signInProps = (
  authClient: SignInPageProps["authClient"],
): SignInPageProps =>
  ({
    authClient,
    navigate: () => {},
    searchParam: () => null,
    Link: (({ children }: { children: ReactNode }) => children) as SignInPageProps["Link"],
    copy: COPY,
    shellCopy: {} as SignInPageProps["shellCopy"],
    branding: { name: "test" },
  }) as SignInPageProps;

/** Fill the email + password inputs and submit the form. */
const submitEmailForm = (container: HTMLElement) => {
  const email = container.querySelector("#email") as HTMLInputElement;
  const password = container.querySelector("#password") as HTMLInputElement;
  fireEvent.change(email, { target: { value: "a@b.test" } });
  fireEvent.change(password, { target: { value: "hunter2hunter2" } });
  const form = container.querySelector("form") as HTMLFormElement;
  fireEvent.submit(form);
};

/** The primary submit — the control that used to freeze. */
const primary = (container: HTMLElement): HTMLButtonElement | null =>
  [...container.querySelectorAll("button")].find(
    (b) => b.getAttribute("type") === "submit",
  ) as HTMLButtonElement | null;

describe("sign-in: a rejected auth call must not freeze the button", () => {
  afterEach(() => cleanup());

  test("a thrown sign-in re-enables the button and surfaces the reason", async () => {
    const { container } = render(
      <SignInPage
        {...signInProps({
          getSession: async () => ({ data: { session: null } }),
          signIn: {
            email: async () => {
              throw new Error("The operation was aborted due to timeout");
            },
          },
        } as unknown as SignInPageProps["authClient"])}
      />,
    );

    submitEmailForm(container);

    await waitFor(() => {
      const btn = primary(container);
      expect(btn).not.toBeNull();
      // The freeze was exactly this: disabled forever, still reading "busy".
      expect(btn?.disabled).toBe(false);
      expect(btn?.textContent).toContain("Sign in");
      expect(btn?.textContent).not.toContain("Signing in…");
    });

    // And the user is told why, rather than left guessing.
    expect(container.textContent).toContain("timeout");
  });

  test("the form can be submitted again after a failure", async () => {
    let attempts = 0;
    const { container } = render(
      <SignInPage
        {...signInProps({
          getSession: async () => ({ data: { session: null } }),
          signIn: {
            email: async () => {
              attempts++;
              throw new Error("network down");
            },
          },
        } as unknown as SignInPageProps["authClient"])}
      />,
    );

    submitEmailForm(container);
    await waitFor(() => expect(primary(container)?.disabled).toBe(false));
    // A frozen (disabled) button made retry impossible — prove it's reachable.
    submitEmailForm(container);
    await waitFor(() => expect(attempts).toBe(2));
  });
});

/** Build SignUpPage props with a given auth client and collect toasts. */
const signUpProps = (
  authClient: unknown,
  notified: string[],
  extra: Partial<Record<string, unknown>> = {},
): SignUpPageProps =>
  ({
    authClient,
    navigate: () => {},
    searchParam: () => null,
    Link: (({ children }: { children: ReactNode }) => children) as SignUpPageProps["Link"],
    copy: {
      ...COPY,
      submit: "Create account",
      submitBusy: "Creating…",
      signUpFailed: "Sign-up failed",
      signUpTimedOut: "Server took too long — try signing in",
    },
    shellCopy: {},
    branding: { name: "test" },
    // First-user claim, consent off: exercise the failure path, not the guard.
    surface: { firstUserMode: true },
    showConsent: false,
    notify: (m: string) => notified.push(m),
    ...extra,
  }) as unknown as SignUpPageProps;

describe("sign-up: a rejected claim must not freeze the button", () => {
  afterEach(() => cleanup());

  test("a non-abort rejection re-enables the button and surfaces the reason", async () => {
    // The freeze was the button stuck disabled on "Claiming…" with nothing
    // said. A genuine failure (not an abort) still surfaces its own message.
    const notified: string[] = [];
    const { container } = render(
      <SignUpPage
        {...signUpProps(
          {
            getSession: async () => ({ data: { session: null } }),
            signIn: { email: async () => ({}) },
            signUp: {
              email: async () => {
                throw new Error("boom: sign-up rejected");
              },
            },
          },
          notified,
        )}
      />,
    );

    await waitFor(() => expect(container.querySelector("#email")).not.toBeNull());
    submitEmailForm(container);

    await waitFor(() => expect(notified.length).toBeGreaterThan(0));
    expect(notified.join(" ")).toContain("boom");
    await waitFor(() => {
      const btn = primary(container);
      expect(btn).not.toBeNull();
      expect(btn?.disabled).toBe(false);
    });
  });

  test("an aborted sign-up whose account did land recovers via sign-in", async () => {
    // The client-level fetch timeout aborts the create AFTER the server has
    // committed the account. Instead of the cryptic "signal is aborted" +
    // manual "retry → user exists → sign in" dance, a sign-in with the same
    // credentials succeeds and we carry straight through — no error toast.
    const notified: string[] = [];
    let signedUp = false;
    let recoveryAttempts = 0;
    const { container } = render(
      <SignUpPage
        {...signUpProps(
          {
            getSession: async () => ({ data: { session: null } }),
            signIn: {
              email: async () => {
                recoveryAttempts++;
                return {}; // the aborted create landed → sign-in succeeds
              },
            },
            signUp: {
              email: async () => {
                throw new DOMException("signal is aborted without reason", "AbortError");
              },
            },
          },
          notified,
          { onSignedUp: () => { signedUp = true; } },
        )}
      />,
    );

    await waitFor(() => expect(container.querySelector("#email")).not.toBeNull());
    submitEmailForm(container);

    await waitFor(() => expect(signedUp).toBe(true));
    expect(recoveryAttempts).toBe(1);
    // The raw abort string must never reach the user, and no error is shown.
    expect(notified.join(" ")).not.toContain("aborted");
    expect(notified).toEqual([]);
  });

  test("an aborted sign-up whose account did NOT land shows a human message", async () => {
    // Recovery sign-in also fails (the create truly never happened): the user
    // gets a clean retry message, never the raw abort string, and can retry.
    const notified: string[] = [];
    const { container } = render(
      <SignUpPage
        {...signUpProps(
          {
            getSession: async () => ({ data: { session: null } }),
            signIn: {
              email: async () => ({ error: { message: "Invalid email or password" } }),
            },
            signUp: {
              email: async () => {
                throw new DOMException("signal is aborted without reason", "AbortError");
              },
            },
          },
          notified,
        )}
      />,
    );

    await waitFor(() => expect(container.querySelector("#email")).not.toBeNull());
    submitEmailForm(container);

    await waitFor(() => expect(notified.length).toBeGreaterThan(0));
    expect(notified.join(" ")).toContain("Server took too long");
    expect(notified.join(" ")).not.toContain("aborted");
    await waitFor(() => {
      const btn = primary(container);
      expect(btn).not.toBeNull();
      expect(btn?.disabled).toBe(false);
    });
  });
});

describe("the auth client caps every request", () => {
  test("createBacklexAuthClient sets a finite fetch timeout", async () => {
    // The UI guards above only help if the hang eventually *becomes* a
    // rejection. Without a client-level deadline a stalled instance never
    // rejects at all and the button stays busy no matter what the page does.
    const src = await Bun.file(
      new URL("../../../../packages/auth/src/client.ts", import.meta.url),
    ).text();
    expect(src).toContain("fetchOptions");
    const timeout = src.match(/timeout:\s*([\d_]+)/)?.[1]?.replace(/_/g, "");
    expect(Number(timeout)).toBeGreaterThan(0);
    expect(Number(timeout)).toBeLessThanOrEqual(60_000);
  });
});
