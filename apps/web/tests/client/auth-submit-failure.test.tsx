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

describe("sign-up: a rejected claim must not freeze the button", () => {
  afterEach(() => cleanup());

  test("a thrown sign-up re-enables the button and surfaces the reason", async () => {
    // Sign-up reports failures through the `notify` toast callback rather than
    // an inline error node, and its submit is gated on the consent checkbox —
    // turn consent off so the test exercises the failure path, not the guard.
    const notified: string[] = [];
    const { container } = render(
      <SignUpPage
        {...({
          authClient: {
            getSession: async () => ({ data: { session: null } }),
            signIn: { email: async () => ({}) },
            signUp: {
              email: async () => {
                throw new Error("The operation was aborted due to timeout");
              },
            },
          },
          navigate: () => {},
          searchParam: () => null,
          Link: (({ children }: { children: ReactNode }) => children) as SignUpPageProps["Link"],
          copy: {
            ...COPY,
            submit: "Create account",
            submitBusy: "Creating…",
            signUpFailed: "Sign-up failed",
          },
          shellCopy: {},
          branding: { name: "test" },
          surface: { firstUserMode: true },
          showConsent: false,
          notify: (m: string) => notified.push(m),
        } as unknown as SignUpPageProps)}
      />,
    );

    await waitFor(() => expect(container.querySelector("#email")).not.toBeNull());
    submitEmailForm(container);

    // The freeze was the button stuck disabled on "Claiming…" with nothing said.
    await waitFor(() => expect(notified.length).toBeGreaterThan(0));
    expect(notified.join(" ")).toContain("timeout");
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
