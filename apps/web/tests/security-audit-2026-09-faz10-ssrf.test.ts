/**
 * Phase 10 of the 2026-09 pre-prod audit — the outbound-fetch cluster.
 *
 * Five findings, one sentence: *a URL a tenant chose was handed to `fetch`
 * without the guard the code believed was applied.* They differ only in which
 * belief was wrong.
 *
 *   · **The sandbox `ctx.fetch` allow-list checked the host and never the
 *     scheme.** `new URL("file://api.example.com/etc/passwd").host` is
 *     `api.example.com`, so the documented `FUNCTIONS_FETCH_ALLOW=api.example.com`
 *     admitted it, and Bun's `fetch` ignores the host on a `file:` URL and reads
 *     the path. `.env`, `/proc/self/environ` and `./.data/backlex.sqlite` — the
 *     whole multi-tenant database — came back as `{status, ok, text}` in the
 *     function author's own return value. The GUARDED path already refused it,
 *     which is exactly why the check had to move: the option is documented for
 *     the self-host default, where the guard is off.
 *
 *   · **`migrate`'s private-host guard was eleven regexes over `u.hostname`.**
 *     `postgres:` is a non-special scheme so the parser leaves the host opaque:
 *     `postgres://u:p@2130706433/db` has hostname `2130706433`, matching none of
 *     them, and `getaddrinfo` turns it into `127.0.0.1`. A saved source is
 *     readable and copyable, which is the outcome the function's own comment
 *     says it exists to prevent.
 *
 *   · **The integrations engine fetched with the bare global.** `fetchImpl` was
 *     only ever supplied by specs, so `engineFetch`'s fallback was `fetch` —
 *     live even on managed cloud, where the guard is supposed to be armed.
 *
 *   · **The flow `request` op is a full read-back SSRF and the guard is OFF by
 *     default.** On the GCP/Azure/Node entries this repo ships, one op at
 *     `169.254.169.254/computeMetadata/…` with `Metadata-Flavor: Google` put
 *     the instance service account's OAuth token in a run result.
 *
 *   · **The guard resolves nothing.** A hostname whose A record is `127.0.0.1`
 *     walks past it, and `SECURITY.md` claimed hop re-validation defeated DNS
 *     rebinding. It does not — there is no redirect; the first hop is already
 *     the private address. That one is a DOC fix, asserted here only as the
 *     absence of a claim we cannot keep.
 *
 * The shape of the remedy is worth stating because it is not "turn the guard
 * on". Flipping `BLOCK_PRIVATE_FETCH_HOSTS` to default-on would break every
 * self-hoster's internal webhook receiver, and that permissiveness is a
 * deliberate, documented product decision. What is NOT a decision is reaching
 * the instance metadata service, so that refusal is unconditional on every
 * runtime — a private LAN receiver still works, the credential endpoint does
 * not.
 */
import { describe, expect, test } from "bun:test";
import {
  assertNotMetadataHost,
  assertPublicHttpUrl,
  fetchOutbound,
  isMetadataHost,
  isPrivateHost,
  parseIpv4,
  ssrfGuardEnabled,
} from "../src/server/services/storage/hosts";
import { isAllowedFetch } from "../src/server/services/sandbox/host-bridge";

// ---------------------------------------------------------------------------
// The metadata refusal — the one that is not the operator's to configure away
// ---------------------------------------------------------------------------

describe("faz10: cloud instance metadata is refused unconditionally", () => {
  test("every spelling of 169.254.169.254", () => {
    for (const h of [
      "169.254.169.254",
      "169.254.170.2", // ECS task metadata
      "2852039166", // bare integer
      "0xa9fea9fe", // hex
      "0251.0376.0251.0376", // octal octets
      "::ffff:169.254.169.254", // IPv4-mapped IPv6
      "[::ffff:169.254.169.254]", // …bracketed, as a URL carries it
      "fd00:ec2::254", // EC2 IMDSv2 over IPv6
      "metadata.google.internal",
      "100.100.100.200", // Alibaba
    ]) {
      expect(isMetadataHost(h)).toBe(true);
    }
  });

  test("an ordinary host is not metadata", () => {
    // A guard that refuses everything passes a one-directional test.
    for (const h of ["example.com", "1.1.1.1", "10.0.0.7", "169.253.1.1", "fcm.googleapis.com"]) {
      expect(isMetadataHost(h)).toBe(false);
    }
  });

  test("assertNotMetadataHost throws on the URL form", () => {
    expect(() => assertNotMetadataHost("http://169.254.169.254/latest/meta-data/")).toThrow();
    expect(() =>
      assertNotMetadataHost(
        "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
      ),
    ).toThrow();
    expect(() => assertNotMetadataHost("https://api.example.com/x")).not.toThrow();
  });

  test("`fetchOutbound` refuses it with the guard OFF — the self-host default", async () => {
    // The whole point. `ssrfGuardEnabled({})` is false, and the call must still
    // not reach the metadata service.
    const env = {} as Parameters<typeof ssrfGuardEnabled>[0];
    expect(ssrfGuardEnabled(env)).toBe(false);
    await expect(
      fetchOutbound(env, "http://169.254.169.254/computeMetadata/v1/"),
    ).rejects.toThrow(/metadata/i);
  });

  test("…and with the guard ON, via the private-host block", async () => {
    const env = { BLOCK_PRIVATE_FETCH_HOSTS: "1" } as Parameters<typeof ssrfGuardEnabled>[0];
    expect(ssrfGuardEnabled(env)).toBe(true);
    await expect(fetchOutbound(env, "http://169.254.169.254/")).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// One IPv4 parser, so the two guards cannot disagree about an address
// ---------------------------------------------------------------------------

describe("faz10: parseIpv4 reads every spelling the resolver does", () => {
  test("the encodings that walked past migrate's regex list", () => {
    // Each of these resolves to 127.0.0.1 under `getaddrinfo`; the finding
    // verified all three directly.
    expect(parseIpv4("2130706433")).toEqual([127, 0, 0, 1]);
    expect(parseIpv4("0x7f000001")).toEqual([127, 0, 0, 1]);
    expect(parseIpv4("0177.0.0.1")).toEqual([127, 0, 0, 1]);
    expect(parseIpv4("[::ffff:127.0.0.1]")).toEqual([127, 0, 0, 1]);
    expect(parseIpv4("::ffff:7f00:1")).toEqual([127, 0, 0, 1]);
    expect(parseIpv4("0xa000001")).toEqual([10, 0, 0, 1]);
  });

  test("the short inet_aton forms the resolver also accepts", () => {
    // `127.1` is 127.0.0.1 to `getaddrinfo`, and a dotted-quad matcher does not
    // see it at all.
    expect(parseIpv4("127.1")).toEqual([127, 0, 0, 1]);
    expect(parseIpv4("127.0.1")).toEqual([127, 0, 0, 1]);
    expect(parseIpv4("0177.1")).toEqual([127, 0, 0, 1]);
  });

  test("and answers null for things that are not addresses", () => {
    for (const h of ["example.com", "", "999.1.1.1", "::1", "1.2.3.4.5", "0x"]) {
      expect(parseIpv4(h)).toBeNull();
    }
  });

  test("isPrivateHost still catches all of them", () => {
    for (const h of [
      "2130706433",
      "0x7f000001",
      "0177.0.0.1",
      "[::ffff:127.0.0.1]",
      "0xa000001",
      "127.1",
      "0177.1",
    ]) {
      expect(isPrivateHost(h)).toBe(true);
    }
    // …and still lets a real host through.
    expect(isPrivateHost("api.example.com")).toBe(false);
    expect(isPrivateHost("fcm.googleapis.com")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scheme is not a host — the sandbox allow-list
// ---------------------------------------------------------------------------

describe("faz10: a scheme is not a host", () => {
  test("assertPublicHttpUrl refuses file: / gopher: / data:", () => {
    for (const u of [
      "file://api.example.com/etc/passwd",
      "gopher://api.example.com/",
      "data:text/plain,hi",
      "ftp://api.example.com/x",
    ]) {
      expect(() => assertPublicHttpUrl(u)).toThrow();
    }
  });

  test("the sandbox allow-list refuses file: against an allow-listed host", () => {
    // The finding, verbatim: the operator sets exactly what docs/sandbox.md
    // recommends, and the function author reads the server's filesystem.
    expect(isAllowedFetch("file://api.example.com/etc/passwd", ["api.example.com"])).toBe(false);
    expect(isAllowedFetch("https://api.example.com/x", ["api.example.com"])).toBe(true);
  });

  test("…and BEFORE the `*` short-circuit, which was the wider hole", () => {
    // `*` is the documented "allow anything hosts" value. It used to return
    // true before the URL had been parsed at all, so the permissive setting was
    // not merely permissive about hosts — it was permissive about schemes.
    expect(isAllowedFetch("file:///etc/passwd", ["*"])).toBe(false);
    expect(isAllowedFetch("file://anything/etc/passwd", ["*"])).toBe(false);
    expect(isAllowedFetch("https://anything.example/x", ["*"])).toBe(true);
  });

  test("an empty allow-list still denies everything", () => {
    expect(isAllowedFetch("https://api.example.com/x", [])).toBe(false);
  });

  test("subdomain matching still works, and does not match a suffix by accident", () => {
    expect(isAllowedFetch("https://a.api.example.com/x", ["api.example.com"])).toBe(true);
    expect(isAllowedFetch("https://evil-api.example.com/x", ["api.example.com"])).toBe(false);
  });

  test("garbage is not a URL and is not allowed", () => {
    expect(isAllowedFetch("not a url", ["*"])).toBe(false);
  });
});
