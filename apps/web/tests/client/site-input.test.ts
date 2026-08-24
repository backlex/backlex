/**
 * The admin form's copy of the site-input rules has to answer the way the
 * server does — and the obvious implementation does not.
 *
 * `services/analytics.ts` refuses a domain, an exclusion pattern or an ignored
 * address that cannot match, and the form mirrors those predicates so it can
 * name the bad entry before the request. A mirror that disagrees is worse than
 * no mirror: it either blocks a value the server would take, or lets one
 * through and turns a silent no-op into a 422 over a dialog that has already
 * closed optimistically.
 *
 * The one that actually bit: `new URL()` does not mean the same thing in the
 * browser as it does on the server. Chrome percent-encodes a space in a host —
 * `new URL("https://my site.com").hostname` is `"my%20site.com"`, no throw —
 * while Node, Bun and workerd all throw on that input. So the first version of
 * this mirror, built on the throw, passed `my site.com` in the browser and let
 * the operator submit exactly what the server was about to refuse. The rule is
 * a character set now, and this file is what keeps it one.
 */
import { expect, test } from "bun:test";
import {
  domainProblem,
  ipProblem,
  normalizeDomain,
  pathProblem,
  splitList,
} from "../../src/client/admin/lib/site-input";

test("a domain is reduced to its host the way the server reduces it", () => {
  expect(normalizeDomain("example.com")).toBe("example.com");
  expect(normalizeDomain("https://example.com/pricing")).toBe("example.com");
  expect(normalizeDomain("EXAMPLE.com:8080")).toBe("example.com");
  expect(normalizeDomain("  Example.COM  ")).toBe("example.com");
  expect(normalizeDomain("")).toBe("");
});

test("the hosts an operator legitimately types are accepted", () => {
  for (const ok of [
    "example.com",
    "https://example.com/pricing",
    "EXAMPLE.com:8080",
    "sub.example.co.uk",
    // A self-hosted admin measures these.
    "localhost",
    "192.168.1.10",
    // Punycoded by normalization, which is the form the origin header arrives in.
    "köşe.com",
    // Real internal names carry underscores.
    "a_b.example.com",
  ]) {
    expect(`${ok}: ${domainProblem(ok)}`).toBe(`${ok}: null`);
  }
});

test("a value the browser would percent-encode into a host is still refused", () => {
  // The regression this file exists for. In Chrome each of these PARSES —
  // `.hostname` comes back with `%20` in it — so a mirror that only asks
  // whether `new URL()` threw would call them valid.
  for (const bad of ["my site.com", "not a domain", "exam ple"]) {
    expect(`${bad}: ${domainProblem(bad)}`).toBe(`${bad}: host`);
  }
});

test("a value that is plainly not a host is refused", () => {
  for (const bad of ["<script>alert(1)</script>", "http://", "..", "a b"]) {
    expect(`${bad}: ${domainProblem(bad)}`).toBe(`${bad}: host`);
  }
  // Empty is not the form's problem to report — the submit button owns
  // "required", and complaining before anything is typed is noise.
  expect(domainProblem("")).toBeNull();
  expect(domainProblem("   ")).toBeNull();
});

test("both list fields split on comma and newline alike", () => {
  expect(splitList("/a, /b\n/c ,, ")).toEqual(["/a", "/b", "/c"]);
  expect(splitList("")).toEqual([]);
});

test("an exclusion pattern that could never fire is named, with the reason", () => {
  // `pathExcluded` compares against a pathname, which always starts with "/".
  expect(pathProblem(["admin"])).toEqual({ entry: "admin", reason: "slash" });
  // The query string is stripped before the comparison.
  expect(pathProblem(["/search?q=x"])).toEqual({ entry: "/search?q=x", reason: "query" });
  expect(pathProblem(["/a b"])).toEqual({ entry: "/a b", reason: "query" });
  // A bare `*` is `includes("")` — every page.
  expect(pathProblem(["*"])).toEqual({ entry: "*", reason: "everything" });
  expect(pathProblem(["**"])).toEqual({ entry: "**", reason: "everything" });
  // It reports the FIRST bad entry, not merely that one exists.
  expect(pathProblem(["/ok", "admin", "*"])).toEqual({ entry: "admin", reason: "slash" });
});

test("the wildcard forms the matcher supports are accepted", () => {
  expect(pathProblem(["/admin/*", "*.json", "*preview*", "/health", "/"])).toBeNull();
  expect(pathProblem([])).toBeNull();
});

test("an ignored address that could never match is named, with the reason", () => {
  expect(ipProblem(["office"])).toEqual({ entry: "office", reason: "address" });
  // The plausible mistake: there is no CIDR support in the matcher.
  expect(ipProblem(["203.0.113.0/24"])).toEqual({ entry: "203.0.113.0/24", reason: "range" });
  expect(ipProblem(["256.1.1.1"])).toEqual({ entry: "256.1.1.1", reason: "address" });
  expect(ipProblem(["1.2.3"])).toEqual({ entry: "1.2.3", reason: "address" });
});

test("both address families are accepted", () => {
  expect(ipProblem(["203.0.113.4", "2001:db8::1", "::1", "255.255.255.255"])).toBeNull();
  expect(ipProblem([])).toBeNull();
});
