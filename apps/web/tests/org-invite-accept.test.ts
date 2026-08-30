import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { Route, Routes } from "react-router";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import { JoinOrg } from "../src/client/pages/join-org";
import { renderWithProviders } from "./client/render";

/**
 * Organization invitations, end to end from the mail to the membership.
 *
 * The defect this pins closed: the invitation email told its recipient to
 * "sign in to your account, then POST /api/t/<slug>/orgs/invites/accept with
 * {token}". Nobody outside this repository can act on that, and the whole B2B
 * journey — create an org, add colleagues — dead-ended on it.
 *
 * What has to hold now:
 *   1. a link token resolves for a caller with NO credentials at all, because
 *      the person holding the link may not have an account yet;
 *   2. it resolves to the three things the page renders and nothing else — the
 *      endpoint is unauthenticated and addressed by a secret;
 *   3. accepting binds the invited membership role AND the org-scoped
 *      workspace roles staged on the invitation;
 *   4. the invitation is single-use;
 *   5. an invitation addressed to one mailbox cannot be accepted by another
 *      account — it is addressed to a person, not bearer authority;
 *   6. the mail carries the link and no longer carries an HTTP recipe;
 *   7. the page a signed-out visitor lands on offers sign-in, not an error.
 */

const JSON_HEADERS = { "content-type": "application/json" };

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: JSON_HEADERS,
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

type Bearer = (path: string, init?: RequestInit) => Promise<Response>;

/** App-plane caller — the bearer an end-user's SDK would hold. */
const bearerFor =
  (h: TestHarness, token: string): Bearer =>
  (path, init = {}) =>
    h.app.request(path, {
      ...init,
      headers: {
        ...JSON_HEADERS,
        ...(init.headers ?? {}),
        Authorization: `Bearer ${token}`,
      },
    });

/** Admin-invite an end-user into `default` and accept it, returning their id +
 *  session token. Same shape `app-orgs.test.ts` uses. */
const makeEndUser = async (
  h: TestHarness,
  email: string,
): Promise<{ id: string; token: string; email: string }> => {
  const invited = await h.fetch("/api/app-users/invite", json("POST", { email }));
  expect(invited.status).toBe(201);
  const { data } = (await invited.json()) as {
    data: { id: string; email: string; token: string };
  };
  const accepted = await h.app.request(
    "/api/t/default/auth/invite/accept",
    json("POST", { token: data.token, password: "join-org-pass-12345" }),
  );
  expect(accepted.status).toBe(200);
  const session = (await accepted.json()) as { token: string };
  return { id: data.id, token: session.token, email: data.email };
};

/**
 * The `[email] …` line the console transport prints, captured while `fn` runs.
 *
 * The invite mail is sent from a floating promise on purpose (a broken SMTP
 * config must never fail the invitation), so it lands some ticks after the
 * response. Poll rather than assume, and fail loudly if it never arrives —
 * a capture that silently found nothing would make every assertion below
 * vacuously true.
 */
const captureEmail = async (
  fn: () => Promise<void>,
  needle: string,
): Promise<string> => {
  const real = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "));
  };
  try {
    await fn();
    for (let i = 0; i < 100; i++) {
      const hit = lines.find((l) => l.includes(needle));
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 10));
    }
  } finally {
    console.log = real;
  }
  throw new Error(`no email containing ${JSON.stringify(needle)} was sent`);
};

describe("org invitations — the link, and what it resolves to", () => {
  let h: TestHarness;
  let owner: { id: string; token: string; email: string };
  let invitee: { id: string; token: string; email: string };
  let stranger: { id: string; token: string; email: string };
  let ownerFetch: Bearer;
  let orgId: string;
  /** A role the operator marked org-assignable, staged on the invitation. */
  let openRoleId: string;
  /** The invitation minted in `beforeAll`, redeemed by the tests in order. */
  let token: string;

  const mintInvite = async (
    email: string,
    extra: Record<string, unknown> = {},
  ): Promise<string> => {
    const res = await ownerFetch(
      `/api/t/default/orgs/${orgId}/invites`,
      json("POST", { email, ...extra }),
    );
    expect(res.status).toBe(201);
    return ((await res.json()) as { data: { token: string } }).data.token;
  };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    owner = await makeEndUser(h, "inviter@join.test");
    invitee = await makeEndUser(h, "invitee@join.test");
    stranger = await makeEndUser(h, "stranger@join.test");
    ownerFetch = bearerFor(h, owner.token);

    const role = await h.fetch(
      "/api/roles",
      json("POST", { name: "org_editor", description: "org_editor", orgAssignable: true }),
    );
    expect(role.status).toBe(201);
    openRoleId = ((await role.json()) as { data: { id: string } }).data.id;

    const created = await h.fetch(
      "/api/app-orgs",
      json("POST", { name: "Join Co", ownerAppUserId: owner.id }),
    );
    expect(created.status).toBe(201);
    orgId = ((await created.json()) as { data: { id: string } }).data.id;

    token = await mintInvite(invitee.email, { role: "admin", roleIds: [openRoleId] });
  });
  afterAll(() => h.cleanup());

  test("a caller with no credentials at all can resolve a live invitation", async () => {
    // No cookie, no bearer — the state the person opening the link is in.
    const res = await h.app.request(
      `/api/t/default/orgs/invites/${encodeURIComponent(token)}`,
    );
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    expect(data.orgName).toBe("Join Co");
    expect(data.email).toBe(invitee.email);
    expect(data.role).toBe("admin");
    expect(data.expired).toBe(false);
  });

  test("…and learns nothing else: no token, no org id, no staged roles", async () => {
    const res = await h.app.request(
      `/api/t/default/orgs/invites/${encodeURIComponent(token)}`,
    );
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    // Asserted as the WHOLE key set rather than field by field, so a field
    // added to the preview later has to be looked at rather than slipping in.
    expect(Object.keys(data).sort()).toEqual(["email", "expired", "orgName", "role"]);
  });

  test("an unknown token is a 404, the same answer a spent one gets", async () => {
    const res = await h.app.request("/api/t/default/orgs/invites/not-a-real-token");
    expect(res.status).toBe(404);
  });

  test("accepting still needs a session — the link alone is not the grant", async () => {
    const res = await h.app.request(
      "/api/t/default/orgs/invites/accept",
      json("POST", { token }),
    );
    expect(res.status).toBe(401);
    // And the invitation survives the attempt: an anonymous POST must not
    // consume it.
    const still = await h.app.request(
      `/api/t/default/orgs/invites/${encodeURIComponent(token)}`,
    );
    expect(still.status).toBe(200);
  });

  test("an invitation addressed to one mailbox can't be accepted by another", async () => {
    const res = await bearerFor(h, stranger.token)(
      "/api/t/default/orgs/invites/accept",
      json("POST", { token }),
    );
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("different email");

    // Still redeemable by the person it was sent to — a refused attempt must
    // not burn somebody else's invitation.
    const still = await h.app.request(
      `/api/t/default/orgs/invites/${encodeURIComponent(token)}`,
    );
    expect(still.status).toBe(200);
  });

  test("accepting binds the invited role AND the staged org-scoped roles", async () => {
    const res = await bearerFor(h, invitee.token)(
      "/api/t/default/orgs/invites/accept",
      json("POST", { token }),
    );
    expect(res.status).toBe(200);

    const members = (await (
      await h.fetch(`/api/app-orgs/${orgId}/members`)
    ).json()) as {
      data: Array<{ appUserId: string; role: string; roles: { id: string }[] }>;
    };
    const row = members.data.find((m) => m.appUserId === invitee.id);
    expect(row, "the invitee should now be a member").toBeDefined();
    // Both halves. The membership role decides who may invite and rename; the
    // org-scoped role is what the permission DSL reads once the org is active,
    // and an accept that bound only the first would look green in a listing.
    expect(row!.role).toBe("admin");
    expect(row!.roles.map((r) => r.id)).toEqual([openRoleId]);
  });

  test("the invitation is single-use", async () => {
    const again = await bearerFor(h, invitee.token)(
      "/api/t/default/orgs/invites/accept",
      json("POST", { token }),
    );
    expect(again.status).toBe(422);

    // And the page's own read agrees: a spent token is as dead as an unknown
    // one, which is what lets the page say one thing about both.
    const resolved = await h.app.request(
      `/api/t/default/orgs/invites/${encodeURIComponent(token)}`,
    );
    expect(resolved.status).toBe(404);
  });

  test("the mail carries a link, and the token appears only inside it", async () => {
    const email = "linked@join.test";
    let minted = "";
    const line = await captureEmail(async () => {
      minted = await mintInvite(email);
    }, email);

    const link = `http://localhost:5173/t/default/join-org/${minted}`;
    expect(line).toContain(link);

    // The old body told the recipient to issue an HTTP request. Nothing about
    // the API surface belongs in mail addressed to a person.
    expect(line).not.toContain("POST ");
    expect(line).not.toContain("/api/t/default/orgs/invites/accept");

    // The token must reach the recipient ONLY through the link. A copyable
    // bare token is what turns a forwarded quote of the email into a working
    // credential — so every occurrence of it has to be the one inside the URL.
    const occurrences = line.split(minted).length - 1;
    expect(occurrences).toBe(1);
  });

  /**
   * The case the whole phase exists for, proved on the SERVER rather than
   * against a mocked page.
   *
   * An org invitation is the only one of the three lifecycles that does not
   * create the account it invites — `acceptOrgInvite` binds an existing
   * `app_users` row and refuses anything else. So the page's answer for a
   * visitor with no account is "sign up on the workspace's own auth surface,
   * then accept in the same submit", and that answer is only worth rendering
   * if the sequence actually works end to end. Mocking `fetch` in the
   * component test cannot tell us that; this can.
   */
  test("a person with no account at all can sign up and then accept", async () => {
    const email = "newcomer@join.test";
    const minted = await mintInvite(email, { role: "member" });

    // Step 1 — the state the page loads in: no cookie, no bearer, no account.
    const preview = await h.app.request(
      `/api/t/default/orgs/invites/${encodeURIComponent(minted)}`,
    );
    expect(preview.status).toBe(200);

    // Step 2 — the workspace's own auth surface, which is what the page posts
    // to. NOT `/api/auth/*`: that is the control plane, and a session there
    // would authenticate an operator of this instance, not a member of this
    // workspace.
    const signUp = await h.app.request(
      "/api/t/default/auth/sign-up/email",
      json("POST", { email, password: "join-org-pass-12345", name: "New Comer" }),
    );
    expect(signUp.status).toBe(200);
    const session = (await signUp.json()) as { token?: string };
    expect(session.token, "sign-up must return a session to accept with").toBeTruthy();

    // Step 3 — same submit, from the page's point of view.
    const accepted = await bearerFor(h, session.token!)(
      "/api/t/default/orgs/invites/accept",
      json("POST", { token: minted }),
    );
    expect(accepted.status).toBe(200);

    // Read the membership back rather than trusting the 2xx: a response that
    // reports success while binding nothing is this codebase's signature bug.
    const members = (await (
      await h.fetch(`/api/app-orgs/${orgId}/members`)
    ).json()) as { data: Array<{ email: string; role: string }> };
    const row = members.data.find((m) => m.email === email);
    expect(row, "the brand-new account should now be a member").toBeDefined();
    expect(row!.role).toBe("member");
  });
});

describe("<JoinOrg> — the page a signed-out invitee lands on", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    cleanup();
    global.fetch = realFetch;
  });

  const reply = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

  /** Stand in for the two calls the page makes on mount. `session: null` is a
   *  visitor with no workspace cookie — the common case for a mailed link. */
  const mockRoutes = (opts: { expired?: boolean; session?: string | null } = {}) => {
    global.fetch = (async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/auth/get-session"))
        return reply(opts.session ? { user: { email: opts.session } } : {});
      if (url.includes("/orgs/invites/"))
        return reply({
          data: {
            orgName: "Join Co",
            email: "invitee@join.test",
            role: "member",
            expired: opts.expired ?? false,
          },
        });
      return reply({ error: { code: "NOT_FOUND", message: `unmocked ${url}` } }, 404);
    }) as unknown as typeof fetch;
  };

  const mount = () =>
    renderWithProviders(
      createElement(
        Routes,
        null,
        createElement(Route, {
          path: "/t/:slug/join-org/:token",
          element: createElement(JoinOrg),
        }),
      ),
      { route: "/t/default/join-org/tok-123" },
    );

  test("offers sign-in rather than an error, and names the org it is for", async () => {
    mockRoutes();
    mount();
    await waitFor(() => expect(screen.getByText(/Join Co/)).toBeDefined());
    // The whole point: no session is not a failure state here.
    expect(screen.queryByText(/not valid/i)).toBeNull();
    expect(screen.getByText("Sign in and join")).toBeDefined();
    // The invited address is shown and locked — the membership binds to it and
    // the server refuses any other, so an editable box would only offer a way
    // to fail.
    const email = document.querySelector<HTMLInputElement>("#join-org-email");
    expect(email?.value).toBe("invitee@join.test");
    expect(email?.disabled).toBe(true);
  });

  test("a visitor who already has a session is offered the one-click accept", async () => {
    mockRoutes({ session: "invitee@join.test" });
    mount();
    await waitFor(() => expect(screen.getByText("Accept invitation")).toBeDefined());
    expect(document.querySelector("#join-org-password")).toBeNull();
  });

  test("a session on the wrong account says so instead of failing at the server", async () => {
    mockRoutes({ session: "someone.else@join.test" });
    mount();
    await waitFor(() => expect(screen.getByText("Wrong account")).toBeDefined());
    expect(screen.getByText(/someone\.else@join\.test/)).toBeDefined();
  });

  test("an expired invitation reads as expired, not as a broken link", async () => {
    mockRoutes({ expired: true });
    mount();
    await waitFor(() =>
      expect(screen.getByText("This invitation has expired")).toBeDefined(),
    );
  });

  test("no account yet: ONE submit creates it and joins", async () => {
    const seen: string[] = [];
    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      seen.push(`${init?.method ?? "GET"} ${url}`);
      if (url.includes("/auth/get-session")) return reply({});
      if (url.includes("/auth/sign-up/email")) return reply({ token: "app-session" });
      // Ordered before the resolve branch on purpose — the accept URL also
      // contains "/orgs/invites/", and a mock that answered it with a preview
      // would make this test pass while the page never accepted anything.
      if (url.includes("/orgs/invites/accept"))
        return reply({ data: { org: { id: "o1", name: "Join Co" }, role: "member" } });
      if (url.includes("/orgs/invites/"))
        return reply({
          data: {
            orgName: "Join Co",
            email: "invitee@join.test",
            role: "member",
            expired: false,
          },
        });
      return reply({ error: { code: "NOT_FOUND", message: `unmocked ${url}` } }, 404);
    }) as unknown as typeof fetch;

    mount();
    await waitFor(() => expect(screen.getByText("Sign in and join")).toBeDefined());
    fireEvent.click(screen.getByText("Create one"));
    const password = document.querySelector<HTMLInputElement>("#join-org-password");
    expect(password, "the sign-up form must offer a password box").not.toBeNull();
    fireEvent.change(password!, { target: { value: "join-org-pass-12345" } });
    const form = document.querySelector("form");
    expect(form).not.toBeNull();
    fireEvent.submit(form!);

    await waitFor(() => expect(screen.getByText("You're in")).toBeDefined());
    // Both halves, in one submit. Signing the invitee up and then leaving them
    // on a page that still says "accept" is the dead end this page replaced.
    expect(seen.some((c) => c.startsWith("POST") && c.includes("/auth/sign-up/email"))).toBe(
      true,
    );
    expect(
      seen.some((c) => c.startsWith("POST") && c.includes("/orgs/invites/accept")),
    ).toBe(true);
    // Against the WORKSPACE's auth surface, never the control plane's — a
    // session on `/api/auth/*` would sign the invitee into the backlex
    // dashboard, which is not the identity a membership binds to.
    expect(seen.some((c) => c.includes("/api/t/default/auth/sign-up/email"))).toBe(true);
  });

  test("a workspace can't paint an essay on this page through the org name", async () => {
    const essay = `URGENT ${"x".repeat(200)} call 1-800-555-0100 to unlock your account`;
    global.fetch = (async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/auth/get-session")) return reply({});
      if (url.includes("/orgs/invites/"))
        return reply({
          data: {
            orgName: essay,
            email: "invitee@join.test",
            role: "member",
            expired: false,
          },
        });
      return reply({ error: { code: "NOT_FOUND", message: `unmocked ${url}` } }, 404);
    }) as unknown as typeof fetch;

    mount();
    await waitFor(() => expect(screen.getByText("Sign in and join")).toBeDefined());
    // The name survives as a LABEL and nothing longer. The phone number an
    // attacker cared about is what falls off the end.
    const heading = document.querySelector("h1");
    expect(heading?.textContent ?? "").not.toContain("1-800-555-0100");
    expect((heading?.textContent ?? "").length).toBeLessThan(80);
    expect(document.body.textContent ?? "").not.toContain("1-800-555-0100");
  });
});
