/**
 * Session persistence and `useSession` (packages/client/src/token-store.ts,
 * clients/auth.ts, react.ts).
 *
 * The behaviour under test is the one every example SPA had reimplemented:
 * a token read on boot, written after sign-in, and cleared on sign-out. The
 * reason it belongs in the SDK rather than in each app is that only the SDK
 * knows every path a token can be captured on — `core.setToken` is the single
 * write, so persistence costs the sign-in, OTP, invite-accept and sign-out
 * paths nothing.
 *
 * The reference-stability test is not a style check. `useSyncExternalStore`
 * compares snapshots by identity, so a `getState()` that built a fresh object
 * per call would re-render forever under React 19 — a hang, in a hook every
 * screen mounts.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import {
  createClient,
  cookieTokens,
  memoryTokens,
  sessionStorageTokens,
  type BacklexClient,
} from "../../../../packages/client/src/index";
import { useSession } from "../../../../packages/client/src/react";
import { renderWithProviders } from "./render";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const USER = { id: "u1", email: "a@b.test", name: "A" };

/** A client whose whole network layer is one handler, keyed by path. */
const makeClient = (
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
  opts: Partial<Parameters<typeof createClient>[0]> = {},
): BacklexClient =>
  createClient({
    url: "http://api.test",
    workspace: "acme",
    tracing: false,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return handler(url, init);
    }) as typeof fetch,
    ...opts,
  });

/** Answers a sign-in with a token and a session with a user. */
const signedIn = (token = "tok_1") =>
  makeClient((url) => {
    if (url.includes("/sign-in/email")) return json({ token, user: USER });
    if (url.includes("/get-session")) return json({ user: USER });
    if (url.includes("/sign-out")) return json({ success: true });
    return json({});
  });

describe("token persistence", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  test("`persist: true` survives a reload — a fresh client is already signed in", async () => {
    const first = makeClient(
      (url) => (url.includes("/sign-in/email") ? json({ token: "tok_x", user: USER }) : json({})),
      { persist: true },
    );
    await first.auth.signIn({ email: "a@b.test", password: "pw" });
    expect(first.auth.getToken()).toBe("tok_x");

    // What a page reload actually is: a brand new client, given nothing.
    const second = makeClient(() => json({}), { persist: true });
    expect(second.auth.getToken()).toBe("tok_x");
  });

  test("signing out clears the store, not just the client", async () => {
    const client = makeClient(
      (url) =>
        url.includes("/sign-in/email")
          ? json({ token: "tok_y", user: USER })
          : json({ success: true }),
      { persist: true },
    );
    await client.auth.signIn({ email: "a@b.test", password: "pw" });
    await client.auth.signOut();

    expect(client.auth.getToken()).toBeNull();
    // The bug this catches is the one every hand-rolled version had: sign-out
    // clears the variable and leaves the storage key, so the next reload
    // restores a session the user just ended.
    const reloaded = makeClient(() => json({}), { persist: true });
    expect(reloaded.auth.getToken()).toBeNull();
  });

  test("an explicit `token` beats a stored one", async () => {
    const seed = makeClient(
      (url) => (url.includes("/sign-in/email") ? json({ token: "stored", user: USER }) : json({})),
      { persist: true },
    );
    await seed.auth.signIn({ email: "a@b.test", password: "pw" });

    // A caller passing a token knows something the store does not — an
    // invite-accept link, or a token handed down from a server render.
    const explicit = makeClient(() => json({}), { persist: true, token: "explicit" });
    expect(explicit.auth.getToken()).toBe("explicit");
  });

  test("two workspaces on one origin do not overwrite each other", async () => {
    const acme = makeClient(
      (url) => (url.includes("/sign-in/email") ? json({ token: "tok_acme", user: USER }) : json({})),
      { persist: true, workspace: "acme" },
    );
    const other = makeClient(
      (url) => (url.includes("/sign-in/email") ? json({ token: "tok_other", user: USER }) : json({})),
      { persist: true, workspace: "other" },
    );
    await acme.auth.signIn({ email: "a@b.test", password: "pw" });
    await other.auth.signIn({ email: "a@b.test", password: "pw" });

    expect(makeClient(() => json({}), { persist: true, workspace: "acme" }).auth.getToken()).toBe(
      "tok_acme",
    );
    expect(makeClient(() => json({}), { persist: true, workspace: "other" }).auth.getToken()).toBe(
      "tok_other",
    );
  });

  test("a custom store is used verbatim — sessionStorage, cookies, anything", async () => {
    const client = makeClient(
      (url) => (url.includes("/sign-in/email") ? json({ token: "tok_s", user: USER }) : json({})),
      { persist: sessionStorageTokens({ workspace: "acme" }) },
    );
    await client.auth.signIn({ email: "a@b.test", password: "pw" });

    expect(sessionStorage.getItem("backlex.token.acme")).toBe("tok_s");
    // And nothing leaked into the default store.
    expect(localStorage.getItem("backlex.token.acme")).toBeNull();
  });

  test("a cookie store round-trips a token a server could read", () => {
    const store = cookieTokens({ workspace: "acme", secure: false });
    store.set("tok_c");
    expect(document.cookie).toContain("backlex_token_acme=");
    expect(store.get()).toBe("tok_c");

    store.set(null);
    expect(store.get()).toBeNull();
  });

  test("a memory store forgets, which is the right answer on a server", () => {
    const store = memoryTokens();
    expect(store.get()).toBeNull();
    store.set("tok_m");
    expect(store.get()).toBe("tok_m");
    // A second store shares nothing — on a server this is what stops one
    // request's session reaching the next.
    expect(memoryTokens().get()).toBeNull();
  });
});

describe("auth session state", () => {
  test("`getState()` returns the SAME reference until something changes", async () => {
    const client = signedIn();
    const a = client.auth.getState();
    expect(client.auth.getState()).toBe(a);
    expect(a.status).toBe("unknown");

    await client.auth.signIn({ email: "a@b.test", password: "pw" });
    const b = client.auth.getState();
    // The token changed, so the snapshot must be a new object — otherwise
    // `useSyncExternalStore` would never see the sign-in.
    expect(b).not.toBe(a);
    expect(client.auth.getState()).toBe(b);
  });

  test("a token write says a different person MAY be signed in, not that they are", async () => {
    const client = signedIn();
    await client.auth.signIn({ email: "a@b.test", password: "pw" });
    // Not "authenticated" — the token is new and nobody has asked the server
    // whose it is. Claiming the previous user here is how a UI shows the
    // wrong name after an account switch.
    expect(client.auth.getState().status).toBe("unknown");

    await client.auth.resolve();
    expect(client.auth.getState().status).toBe("authenticated");
    expect(client.auth.getState().user?.id).toBe("u1");
  });

  test("concurrent resolves share one request", async () => {
    let sessionCalls = 0;
    const client = makeClient((url) => {
      if (url.includes("/get-session")) {
        sessionCalls++;
        return json({ user: USER });
      }
      return json({});
    });

    await Promise.all([client.auth.resolve(), client.auth.resolve(), client.auth.resolve()]);
    expect(sessionCalls).toBe(1);
  });

  test("a failed probe is not a sign-out", async () => {
    const client = makeClient((url) =>
      url.includes("/get-session") ? json({ error: "boom" }, 500) : json({}),
    );
    client.auth.setToken("tok_live");
    await expect(client.auth.resolve()).rejects.toBeDefined();

    // Still "unknown", never "anonymous": a dropped connection would otherwise
    // sign the user out of the interface while their session is perfectly good.
    expect(client.auth.getState().status).toBe("unknown");
    expect(client.auth.getToken()).toBe("tok_live");
  });

  test("`onChange` sees a sign-in made anywhere, and unsubscribes cleanly", async () => {
    const client = signedIn();
    const seen: string[] = [];
    const off = client.auth.onChange((s) => seen.push(s.status));

    await client.auth.signIn({ email: "a@b.test", password: "pw" });
    await client.auth.resolve();
    off();
    await client.auth.signOut();

    expect(seen).toEqual(["unknown", "authenticated"]);
  });
});

describe("useSession", () => {
  afterEach(cleanup);

  function Probe({ client }: { client: BacklexClient }) {
    const { status, user, loading } = useSession(client);
    return (
      <div>
        <span data-testid="status">{status}</span>
        <span data-testid="loading">{loading ? "loading" : "settled"}</span>
        <span data-testid="user">{user?.email ?? ""}</span>
      </div>
    );
  }

  test("resolves the session on mount and settles — no `booting` flag needed", async () => {
    const client = signedIn();
    renderWithProviders(<Probe client={client} />);

    // The state every SPA was hand-rolling: we have not asked yet.
    expect(screen.getByTestId("loading").textContent).toBe("loading");

    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("authenticated"));
    expect(screen.getByTestId("user").textContent).toBe("a@b.test");
    expect(screen.getByTestId("loading").textContent).toBe("settled");
  });

  test("a session with nobody in it settles as anonymous", async () => {
    const client = makeClient((url) =>
      url.includes("/get-session") ? json({ user: null }) : json({}),
    );
    renderWithProviders(<Probe client={client} />);

    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("anonymous"));
    expect(screen.getByTestId("user").textContent).toBe("");
  });

  test("one session probe serves however many components ask for it", async () => {
    let sessionCalls = 0;
    const client = makeClient((url) => {
      if (url.includes("/get-session")) {
        sessionCalls++;
        return json({ user: USER });
      }
      return json({});
    });

    renderWithProviders(
      <div>
        <Probe client={client} />
        <Probe client={client} />
        <Probe client={client} />
      </div>,
    );

    await waitFor(() =>
      expect(screen.getAllByTestId("status")[0]!.textContent).toBe("authenticated"),
    );
    // The de-duplication is what keeps a page of components from opening one
    // session request each on every mount.
    expect(sessionCalls).toBe(1);
  });

  test("signing out moves every mounted component to anonymous", async () => {
    const client = signedIn();
    renderWithProviders(<Probe client={client} />);
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("authenticated"));

    // Wrapped: the sign-out happens outside React's own event flow, which is
    // exactly the case this hook exists for — a call made anywhere in the app.
    await act(async () => {
      await client.auth.signOut();
    });
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("anonymous"));
  });
});
