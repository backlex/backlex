import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SignUpPage, type SignUpPageProps } from "@backlex/auth-ui";

/**
 * Regression guard for the claim-page black screen (7c66a011 introduced a bare
 * `return null` hold that waited on `getSession` with no timeout — a slow or
 * stalled /api/auth/get-session left the claim deep-link stuck on a permanent
 * black screen). Claim mode must now:
 *   - never leave a bare blank once the probe is visibly slow (show a spinner),
 *   - redirect a stale claim (already-claimed instance) to /sign-in,
 *   - redirect an authed visitor to "/".
 */

// The hold/redirect branches short-circuit before any `copy`/`shellCopy` string
// is read, so empty stubs are safe for these tests.
const baseProps = (over: Partial<SignUpPageProps>): SignUpPageProps => ({
  authClient: {
    getSession: () => new Promise(() => {}), // never resolves by default
    signIn: { email: async () => ({}) },
    signUp: { email: async () => ({}) },
  } as unknown as SignUpPageProps["authClient"],
  navigate: () => {},
  searchParam: (k: string) => (k === "claim" ? "1" : null),
  Link: (({ children }: { children: ReactNode }) => children) as SignUpPageProps["Link"],
  copy: {} as SignUpPageProps["copy"],
  shellCopy: {} as SignUpPageProps["shellCopy"],
  branding: { name: "test" },
  ...over,
});

describe("SignUpPage claim-mode hold", () => {
  afterEach(() => cleanup());

  test("shows a loader (not a blank void) once a slow session probe passes the grace window", async () => {
    const { container } = render(
      <SignUpPage {...baseProps({ surface: { firstUserMode: true } })} />,
    );
    // Grace window: nothing yet.
    expect(container.querySelector(".animate-spin")).toBeNull();
    // After the 700ms grace, the held blank becomes a spinner so a stalled
    // instance never reads as a dead black screen.
    await waitFor(
      () => expect(container.querySelector(".animate-spin")).not.toBeNull(),
      { timeout: 2000 },
    );
  });

  test("a stale claim (already-claimed instance) redirects to /sign-in", async () => {
    const seen: Array<[string, unknown]> = [];
    render(
      <SignUpPage
        {...baseProps({
          surface: { firstUserMode: false },
          authClient: {
            getSession: async () => ({ data: { session: null } }),
            signIn: { email: async () => ({}) },
            signUp: { email: async () => ({}) },
          } as unknown as SignUpPageProps["authClient"],
          navigate: (to, opts) => seen.push([to, opts]),
        })}
      />,
    );
    await waitFor(() =>
      expect(seen.some(([to]) => to === "/sign-in")).toBe(true),
    );
  });

  test("an authed visitor on a claim deep-link is redirected to /", async () => {
    const seen: string[] = [];
    render(
      <SignUpPage
        {...baseProps({
          surface: { firstUserMode: false },
          authClient: {
            getSession: async () => ({ data: { session: { id: "s1" } } }),
            signIn: { email: async () => ({}) },
            signUp: { email: async () => ({}) },
          } as unknown as SignUpPageProps["authClient"],
          navigate: (to) => seen.push(to),
        })}
      />,
    );
    await waitFor(() => expect(seen).toContain("/"));
  });
});
