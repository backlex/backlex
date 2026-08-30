/**
 * The end-user invitation page renders exactly one operator-authored string,
 * and it is bounded.
 *
 * `/t/:slug/join/:token` is unauthenticated, sits on this instance's own
 * domain, and shows a password box. The workspace name it prints comes from
 * `tenants.name` — free text a workspace admin typed — so without a bound the
 * heading of a credential form is a paragraph slot somebody else controls, and
 * the phishing page is one backlex served itself. React escapes markup but not
 * prose, and prose is the attack.
 *
 * The sibling org page (`join-org.tsx`) carries the identical guard and the
 * identical test; this file exists because the guard is easy to add to one page
 * and forget on the other, which is exactly what had happened.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { Route, Routes } from "react-router";
import { cleanup, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "./render";
import { JoinWorkspaceUser } from "../../src/client/pages/join-workspace-user";

const JSON_HEADERS = { "content-type": "application/json" };
const realFetch = global.fetch;

const mount = () =>
  renderWithProviders(
    <Routes>
      <Route path="/t/:slug/join/:token" element={<JoinWorkspaceUser />} />
    </Routes>,
    { route: "/t/default/join/tok-abc" },
  );

/** Answer the page's one mount call with whatever `workspaceName` a test wants. */
const mockResolve = (workspaceName: string) => {
  global.fetch = (async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/auth/invite/"))
      return new Response(
        JSON.stringify({
          data: { valid: true, workspaceName, email: "invitee@join.test" },
        }),
        { status: 200, headers: JSON_HEADERS },
      );
    return new Response(
      JSON.stringify({ error: { code: "NOT_FOUND", message: `unmocked ${url}` } }),
      { status: 404, headers: JSON_HEADERS },
    );
  }) as unknown as typeof fetch;
};

describe("join-workspace-user: the workspace name is a label, not a canvas", () => {
  // Explicit, because RTL's auto-cleanup is order-dependent in this runner and
  // a leaked tree makes the next test's queries answer for the previous mount.
  afterEach(() => cleanup());
  afterAll(() => {
    global.fetch = realFetch;
  });

  test("an ordinary name renders in full", async () => {
    mockResolve("Acme Supply");
    mount();
    // Asserted against the LOADED state: querying while the skeleton is up
    // would pass vacuously for any bound at all.
    await waitFor(() => expect(screen.getByText(/Acme Supply/)).toBeDefined());
    expect(document.querySelector("h1")?.textContent ?? "").toContain("Acme Supply");
  });

  test("an essay typed into the workspace name cannot deliver its payload", async () => {
    const essay = `URGENT ${"x".repeat(200)} call 1-800-555-0100 to unlock your account`;
    mockResolve(essay);
    mount();
    // Wait for the form, so the assertions below run against a rendered page
    // rather than an empty skeleton.
    await waitFor(() => expect(document.querySelector("h1")).not.toBeNull());
    const heading = document.querySelector("h1")?.textContent ?? "";
    // The name survives as a label; the instruction the attacker cared about is
    // what falls off the end.
    expect(heading).not.toContain("1-800-555-0100");
    expect(heading.length).toBeLessThan(80);
    // Not anywhere else on the page either — one bound at the state boundary is
    // supposed to cover every render site, present and future.
    expect(document.body.textContent ?? "").not.toContain("1-800-555-0100");
  });
});
