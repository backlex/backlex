/**
 * `POST /api/admin/oidc/discover` — the SSRF half of OIDC discovery.
 *
 * `oidc-providers.test.ts` covers `discoverOidcEndpoints` thoroughly, and every
 * one of those tests passes it a `fetchImpl` stub. That is the right way to
 * assert the parsing, and it is why nothing yet asserts the part that matters
 * most: the ROUTE calls the service with no stub, so it goes through
 * `fetchOutbound`, and `fetchOutbound` is the only thing standing between an
 * admin-supplied URL and the deploy's private network. Every existing test
 * bypasses that path by construction.
 *
 * The endpoint takes a URL from a form field and makes the server fetch it —
 * on Workers that reaches the Cloudflare internal network, and on a self-host
 * it reaches whatever the box can route to: link-local metadata (169.254.169.254),
 * a loopback admin port, a private-range database. So the assertion is not that
 * the response is an error; a 400 for an unrelated reason would satisfy that,
 * which is the weakness in the sibling `saml-metadata-ssrf.test.ts` (its own
 * comment says "the point is that the request is never made" and then checks
 * only the status). Here the outbound `fetch` is spied on and the assertion is
 * that the private host was never dialled at all.
 *
 * `BLOCK_PRIVATE_FETCH_HOSTS` is set on the harness because that is the flag a
 * deploy is expected to run with; the last test pins that the ordinary public
 * path still works with it on, since a guard that breaks the normal case is a
 * guard someone turns off.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const ROUTE = "/api/admin/oidc/discover";

/** Hosts an SSRF is actually aimed at, rather than a token private address. */
const PRIVATE = [
  "https://169.254.169.254/.well-known/openid-configuration", // cloud instance metadata
  "https://127.0.0.1/.well-known/openid-configuration",
  "https://localhost/.well-known/openid-configuration",
  "https://10.0.0.5/.well-known/openid-configuration",
  "https://192.168.1.1/.well-known/openid-configuration",
  "https://[::1]/.well-known/openid-configuration",
];

const DISCOVERY_DOC = {
  issuer: "https://idp.example.test",
  authorization_endpoint: "https://idp.example.test/authorize",
  token_endpoint: "https://idp.example.test/token",
  userinfo_endpoint: "https://idp.example.test/userinfo",
  scopes_supported: ["openid", "email"],
};

let h: TestHarness;

const discover = (url: string) =>
  h.fetch(ROUTE, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url }),
  });

/**
 * Record every outbound URL and answer any that gets through with a valid
 * discovery document. Answering rather than throwing matters: a spy that threw
 * would make a request that DID escape look like a blocked one.
 */
const spyOutbound = () => {
  const real = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input?.url ?? String(input));
    if (/^https?:/.test(url) && !url.startsWith(h.env.APP_URL as string)) {
      seen.push(url);
      return new Response(JSON.stringify(DISCOVERY_DOC), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return real(input, init);
  }) as typeof fetch;
  return { seen, restore: () => { globalThis.fetch = real; } };
};

beforeAll(async () => {
  h = makeHarness({ BLOCK_PRIVATE_FETCH_HOSTS: "1" });
  await seedAdmin(h);
});
afterAll(() => h.cleanup());

describe("POST /api/admin/oidc/discover", () => {
  test("a private host is refused, and never dialled", async () => {
    const spy = spyOutbound();
    try {
      for (const url of PRIVATE) {
        const res = await discover(url);
        expect(`${url} -> ${res.status >= 400}`).toBe(`${url} -> true`);
      }
    } finally {
      spy.restore();
    }
    // The assertion the status cannot make. If the guard were removed, each URL
    // above would appear here — and the responses would have been 200s built
    // from the stub, so the loop above would have failed too. Both halves are
    // needed: the status proves the caller was told no, this proves the packet
    // never left.
    expect(spy.seen.filter((u) => !u.includes("idp.example.test"))).toEqual([]);
  });

  test("a non-https scheme is refused before any fetch", async () => {
    const spy = spyOutbound();
    try {
      for (const url of ["http://idp.example.test", "file:///etc/hosts", "gopher://idp.example.test"]) {
        expect(`${url} -> ${(await discover(url)).status >= 400}`).toBe(`${url} -> true`);
      }
    } finally {
      spy.restore();
    }
    expect(spy.seen).toEqual([]);
  });

  test("a public issuer still resolves with the guard on", async () => {
    // Liveness for the whole file, and the reason the guard survives contact
    // with operators: everything above is satisfied by an endpoint that refuses
    // every URL, which would be a broken feature rather than a safe one.
    const spy = spyOutbound();
    let body: any;
    try {
      const res = await discover("https://idp.example.test");
      expect(res.status).toBe(200);
      body = await res.json();
    } finally {
      spy.restore();
    }
    expect(body.data.authorizationUrl).toBe("https://idp.example.test/authorize");
    expect(body.data.tokenUrl).toBe("https://idp.example.test/token");
    // The bare origin gets the well-known path appended — through the route,
    // not just in the unit test that calls the service directly.
    expect(spy.seen).toEqual(["https://idp.example.test/.well-known/openid-configuration"]);
  });

  test("a signed-out caller cannot make the server fetch anything", async () => {
    const spy = spyOutbound();
    try {
      const res = await h.app.request(
        ROUTE,
        {
          method: "POST",
          headers: { "content-type": "application/json", origin: h.env.APP_URL as string },
          body: JSON.stringify({ url: "https://idp.example.test" }),
        },
        h.env,
      );
      expect(res.status).toBe(401);
    } finally {
      spy.restore();
    }
    // An anonymous SSRF is the same primitive as an authenticated one, minus
    // the audit trail.
    expect(spy.seen).toEqual([]);
  });
});
