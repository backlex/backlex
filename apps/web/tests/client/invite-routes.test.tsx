/**
 * The three invite lifecycles all end at a link in an email, and the person
 * clicking it is — by definition — signed out. Two things used to break that:
 *
 *  1. Only the platform invite had a page at all. The workspace-plane accept
 *     screens now live at `/t/:slug/join/:token` and `/t/:slug/join-org/:token`,
 *     and they only work if `App.tsx` lists them ABOVE the `/*` catch-all:
 *     everything below it renders inside `<AuthGate>`, which redirects a
 *     visitor with no session to /sign-in.
 *
 *     So the discriminator these tests read is where the app ends up: an accept
 *     URL keeps its own address and paints a page, while a near miss is carried
 *     off to /sign-in by the gate. The last test in the block asserts that
 *     second half, so "the accept page rendered" is a result rather than a
 *     tautology.
 *
 *     The bad-token case is called out separately because it is the one a real
 *     invitee hits: `/t/x/join/y` must still reach the join page, which can
 *     then say the link is stale. Falling through to `/*` would instead tell
 *     them the page does not exist — untrue, and nothing they can act on.
 *
 *     The two pages are deliberately NOT mocked. `bun test` shares one module
 *     registry across every spec file in the worker and evaluates them all
 *     before running any test, so a `mock.module` on a page some other spec
 *     imports is a coin flip decided by file order — and this file sorts ahead
 *     of anything named after those pages. Rendering the real components costs
 *     nothing here because no assertion depends on their contents.
 *
 *  2. `/invite` navigated to "/" unconditionally after creating the account.
 *     On a workspace that requires a confirmed email better-auth withholds the
 *     session, so "/" bounced straight back to /sign-in and refused the
 *     password the invitee had just chosen, never once mentioning the
 *     verification mail. It now holds the verify card instead.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { Route, Routes, useLocation } from "react-router";
import { renderWithProviders } from "./render";

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

/** Flipped per-test; the auth surface is what `/invite` reads the policy from. */
let requireEmailVerification = false;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const realFetch = globalThis.fetch;

/**
 * Every accept page resolves its token before it can paint anything, so the
 * stub answers all three lookups. The workspace-plane ones answer 404 — the
 * routing tests below drive tokens that do not exist, and a page that settles
 * into "this link is stale" is exactly what those URLs should reach.
 */
const stubFetch = ((input: RequestInfo | URL) => {
  const url =
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.includes("/api/auth/providers"))
    return Promise.resolve(
      json({
        data: {
          tenantId: null,
          providers: [],
          policy: { openSignup: true, requireEmailVerification },
          firstUserMode: false,
        },
      }),
    );
  if (url.includes("/api/tenants/invite/"))
    return Promise.resolve(
      json({
        data: { email: "rana@example.com", workspaceName: "Acme", expired: false },
      }),
    );
  if (url.includes("/api/t/"))
    return Promise.resolve(
      json({ error: { code: "NOT_FOUND", message: "invite not found" } }, 404),
    );
  if (url.includes("/api/workspace-config")) return Promise.resolve(json({ data: null }));
  return Promise.resolve(json({ data: {} }));
}) as unknown as typeof fetch;

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

/**
 * The auth client, as a PASSTHROUGH proxy — everything but the two methods
 * these tests drive resolves to the real client, so nothing else in the shared
 * module registry can notice. `getSession` matters as much as `signUp`: the
 * real one captured `fetch` at import time, so the stub above cannot reach it
 * and it would go out to localhost:5173 — which answers differently depending
 * on whether the developer happens to have `bun run dev` up. Signed out is the
 * state under test, so it is pinned here rather than left to the network.
 */
const signUpResult: { error: { message: string } | null } = { error: null };
// Snapshotted into a PLAIN object before mocking: an ES module namespace is a
// set of live bindings, so after `mock.module` the namespace itself resolves to
// the stub and a factory spreading it would spread its own output.
const realAuth = { ...(await import("../../src/client/lib/auth")) };
mock.module("../../src/client/lib/auth", () => ({
  ...realAuth,
  auth: new Proxy(realAuth.auth as object, {
    get: (target, prop) => {
      if (prop === "getSession") return async () => ({ data: { session: null } });
      if (prop === "signUp") return { email: async () => signUpResult };
      return Reflect.get(target, prop);
    },
  }),
}));

const realRaf = globalThis.requestAnimationFrame;

beforeAll(() => {
  globalThis.fetch = stubFetch;
  // The sign-in shell and its star canvas each drive a `requestAnimationFrame`
  // loop, and happy-dom backs rAF with a task that never drains — so an `act()`
  // flush landing after one of those screens mounts hangs until the test's own
  // deadline kills it. The animation is decoration; the routes are what is
  // under test. A callback that is never invoked ends the loop at its first
  // frame and leaves everything else alone.
  globalThis.requestAnimationFrame = (() => 0) as typeof requestAnimationFrame;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  globalThis.requestAnimationFrame = realRaf;
});

// RTL's auto-cleanup is order-dependent under bun's shared registry, so unmount
// explicitly between tests.
afterEach(() => cleanup());

beforeEach(() => {
  requireEmailVerification = false;
  // The surface is memoised in a module-level promise; drop it so each test
  // reads the policy it just set.
  realAuth.invalidateAuthSurface();
});

/** Reports the router's current path, mounted as a sibling of `<App />` inside
 *  the same MemoryRouter — the only way to observe the `<Navigate>` that the
 *  catch-all's AuthGate performs. */
const Probe = () => <output data-testid="path">{useLocation().pathname}</output>;

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

describe("public accept routes", () => {
  const renderApp = async (route: string) => {
    const { App } = await import("../../src/client/App");
    // Pre-resolve the sign-in chunk. React Router runs a navigation inside
    // `startTransition`, and a transition that suspends does not commit — so
    // with the chunk cold, the catch-all's redirect stalls and the router keeps
    // reporting the URL it was leaving. Warming it first is what makes "where
    // did this URL end up" an answerable question in a test.
    await import("../../src/client/pages/sign-in");
    renderWithProviders(
      <>
        <Probe />
        {/* A wrapper so an assertion can read the app's own output on its own. */}
        <div data-testid="app">
          <App />
        </div>
      </>,
      { route },
    );
  };

  const path = (): string => screen.getByTestId("path").textContent ?? "";

  /**
   * How many top-level elements the app painted.
   *
   * `<App>` always renders exactly one on its own — the `<Toaster>` region,
   * which sits outside `<Routes>`. So TWO means the matched route rendered a
   * page, and ONE means it rendered nothing. Paired with the path, that is
   * enough to tell an accept page apart from every way of not getting one.
   */
  const topLevelElements = (): number => screen.getByTestId("app").childElementCount;

  /**
   * Flush React until the expected outcome holds, or a bounded budget runs out.
   * What is being drained is the lazy chunk, the page's own token lookup, the
   * session probe, and the redirect a failed gate schedules.
   *
   * Deliberately NOT `waitFor`. A redirect out of the catch-all is a router
   * state change inside `startTransition`, which `waitFor`'s polling did not
   * reliably drive here — it woke on DOM mutations and the transition produced
   * none until it committed, so the wait and the thing waited on deadlocked.
   * act() drives React directly and lands the same result every run. Each
   * caller then ASSERTS the same condition it settled on, so exhausting the
   * budget fails rather than passing quietly.
   */
  const settleUntil = async (done: () => boolean) => {
    for (let i = 0; i < 40 && !done(); i++) await act(async () => {});
  };

  /** Signed out, an accept URL keeps its own address and paints its own page. */
  const expectAcceptPage = async (route: string) => {
    await settleUntil(() => topLevelElements() === 2);
    expect(path()).toBe(route);
    expect(topLevelElements()).toBe(2);
  };

  test("the end-user join link renders its page while signed out", async () => {
    await renderApp("/t/acme/join/tok-123");
    await expectAcceptPage("/t/acme/join/tok-123");
  });

  test("the org join link renders its page while signed out", async () => {
    await renderApp("/t/acme/join-org/tok-abc");
    await expectAcceptPage("/t/acme/join-org/tok-abc");
  });

  test("a token that no longer resolves still reaches the join page", async () => {
    // `/api/t/…` answers 404 for these tokens, so the page settles into
    // whatever it says about a stale link — which is the point. The catch-all
    // would instead tell the invitee the page does not exist.
    await renderApp("/t/x/join/y");
    await expectAcceptPage("/t/x/join/y");
  });

  test("a near miss IS swallowed by the catch-all, which is what makes the above a result", async () => {
    // Same prefix, one segment short: it matches no accept route, falls through
    // to `/*`, and `<AuthGate>` sends the signed-out visitor to the CONTROL
    // plane's sign-in — a screen with nothing to say about this invitation.
    // That is the fate the two routes above exist to avoid, demonstrated rather
    // than assumed; without it, "the accept page rendered" would be a claim
    // about React Router rather than about App.tsx.
    await renderApp("/t/acme/join");
    await settleUntil(() => path() === "/sign-in");
    expect(path()).toBe("/sign-in");
  });
});

// ---------------------------------------------------------------------------
// /invite — email verification
// ---------------------------------------------------------------------------

describe("invite acceptance under an email-verification policy", () => {
  /** Renders `/invite` against a sentinel "/" so a navigation away is visible. */
  const renderInvite = async () => {
    const { Invite } = await import("../../src/client/pages/invite");
    const r = renderWithProviders(
      <Routes>
        <Route path="/invite" element={<Invite />} />
        <Route path="/" element={<output data-testid="admin-home" />} />
      </Routes>,
      { route: "/invite?token=tok-123" },
    );
    // The screen holds a "checking your invite" card until the token resolves.
    await waitFor(() =>
      expect(r.container.querySelector("#invite-password")).not.toBeNull(),
    );
    return r;
  };

  const accept = (container: HTMLElement) => {
    const pw = container.querySelector("#invite-password") as HTMLInputElement;
    fireEvent.change(pw, { target: { value: "correct-horse-battery" } });
    fireEvent.submit(container.querySelector("form") as HTMLFormElement);
  };

  test("a workspace that requires verification gets the verify card, not the admin", async () => {
    requireEmailVerification = true;
    const { container } = await renderInvite();
    accept(container);
    await waitFor(() => expect(screen.queryByText("Check your inbox")).not.toBeNull());
    // The invitee's address is named, so "check your inbox" means a specific
    // inbox — and the admin was NOT navigated to.
    expect(screen.queryByText(/rana@example\.com/)).not.toBeNull();
    expect(screen.queryByTestId("admin-home")).toBeNull();
  });

  test("a workspace that does not require verification still lands in the admin", async () => {
    // The control. Without it the assertion above would also pass if the accept
    // button had simply stopped working.
    requireEmailVerification = false;
    const { container } = await renderInvite();
    accept(container);
    await waitFor(() => expect(screen.queryByTestId("admin-home")).not.toBeNull());
    expect(screen.queryByText("Check your inbox")).toBeNull();
  });
});
