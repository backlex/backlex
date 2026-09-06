import { AppError } from "@backlex/core";
import type { Env } from "../../env";

/** One `inet_aton` part, in any of the three bases C's parser accepts: hex
 *  (`0x…`), octal (a leading `0`), or decimal. Unbounded — how wide a part may
 *  be depends on how many parts there are, which is {@link parseIpv4}'s job. */
function parsePart(tok: string): number | null {
  if (!tok) return null;
  let n: number;
  if (/^0x[0-9a-f]+$/i.test(tok)) n = Number.parseInt(tok.slice(2), 16);
  else if (/^0[0-7]+$/.test(tok)) n = Number.parseInt(tok.slice(1), 8);
  else if (/^\d+$/.test(tok)) n = Number.parseInt(tok, 10);
  else return null;
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * The four octets of `host` when it is an IPv4 address in ANY spelling the
 * resolver accepts, or null when it is not an address at all.
 *
 * This implements `inet_aton`, not "dotted quad", because `inet_aton` is what
 * actually runs when the connection is made. It accepts one, two, three or four
 * parts — the last part absorbing whatever is left of the 32 bits, so `127.1`,
 * `127.0.1` and `2130706433` are all `127.0.0.1` — and each part may be
 * decimal, octal (`0177`) or hex (`0x7f`). Add the IPv4-mapped IPv6 wrappers on
 * top and one address has dozens of names.
 *
 * Shared by both guards below, deliberately. A second hand-written matcher is
 * how `services/migrate.ts` ended up with eleven regexes that `2130706433`,
 * `0x7f000001` and `[::ffff:127.0.0.1]` all walked straight past while
 * `net.connect` resolved every one of them to loopback — and how this very
 * function's first draft still missed `0x7f000001`, because it had inherited
 * "hex OCTET" from the old code and not "hex ADDRESS".
 */
export function parseIpv4(host: string): [number, number, number, number] | null {
  let h = host.toLowerCase().trim().replace(/^\[|\]$/g, "");
  // IPv4-mapped IPv6: ::ffff:127.0.0.1 or the hex-word form ::ffff:7f00:1.
  const mapped = h.match(/^::ffff:(.+)$/);
  if (mapped?.[1]) {
    const inner = mapped[1];
    if (inner.includes(".")) h = inner;
    else {
      const words = inner.split(":");
      if (words.length !== 2) return null;
      const hi = Number.parseInt(words[0]!, 16);
      const lo = Number.parseInt(words[1]!, 16);
      if (!Number.isInteger(hi) || !Number.isInteger(lo)) return null;
      return [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff];
    }
  }
  if (!/^[0-9a-fx.]+$/i.test(h)) return null;
  const toks = h.split(".");
  if (toks.length < 1 || toks.length > 4) return null;
  const parts = toks.map(parsePart);
  if (!parts.every((p): p is number => p != null)) return null;
  // Every part but the last is a single octet; the last absorbs the remaining
  // bytes (`a.b` → a.0.0.b's low 24 bits, `a` → the whole 32).
  const lead = parts.slice(0, -1);
  if (lead.some((p) => p > 255)) return null;
  const tail = parts[parts.length - 1]!;
  const tailBytes = 4 - lead.length;
  if (tail > 2 ** (8 * tailBytes) - 1) return null;
  const octets = [...lead];
  for (let i = tailBytes - 1; i >= 0; i--) octets.push((tail >>> (8 * i)) & 0xff);
  return [octets[0]!, octets[1]!, octets[2]!, octets[3]!];
}

/**
 * The cloud metadata endpoints — the credential vending machines every managed
 * runtime exposes on a fixed link-local address.
 *
 * Kept apart from {@link isPrivateHost} because it is enforced on a different
 * schedule. The private-host block is opt-in (`BLOCK_PRIVATE_FETCH_HOSTS`, or
 * managed cloud) so a self-hoster's internal webhook receiver on `10.0.0.7`
 * keeps working, and that permissiveness is a deliberate, documented product
 * decision. Reaching `169.254.169.254` is not: on the GCP, Azure and Node
 * entries this repo ships, one workspace-authored flow `request` op at
 * `http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token`
 * put the instance service account's OAuth token straight into a run result the
 * same admin reads back.
 *
 * So this list is refused UNCONDITIONALLY — every runtime, guard on or off. A
 * private LAN receiver still works; the credential endpoint does not.
 */
export function isMetadataHost(host: string): boolean {
  const h = host.toLowerCase().trim().replace(/^\[|\]$/g, "");
  if (!h) return false;
  // Resolver names for the same address (GCP, and Alibaba's fixed IP).
  if (h === "metadata.google.internal" || h === "metadata" || h === "100.100.100.200") {
    return true;
  }
  // EC2 IMDSv2 over IPv6.
  if (h === "fd00:ec2::254") return true;
  // AWS / Azure / GCP / DigitalOcean / Oracle IMDS all live in 169.254.0.0/16,
  // and ECS task metadata is 169.254.170.2. Matched through the shared octet
  // parser, so `2852039166` and `0xa9fea9fe` are the same address here as they
  // are to the resolver.
  const v4 = parseIpv4(h);
  return v4 !== null && v4[0] === 169 && v4[1] === 254;
}

/** True when the four IPv4 octets fall in a private / loopback / link-local /
 *  reserved range that the Worker must never reach. */
function isPrivateIpv4(a: number, b: number): boolean {
  if (a === 0 || a === 10 || a === 127) return true; // this-host / RFC1918 / loopback
  if (a === 169 && b === 254) return true; // link-local (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (RFC6598)
  return false;
}

/** SSRF guard. Returns true for hostnames the Worker should refuse to fetch —
 *  link-local, loopback, RFC1918/CGNAT, the IPv6 equivalents (incl. the
 *  IPv4-mapped form), alternative integer/octal/hex IP encodings, and common
 *  internal-DNS suffixes. Purely syntactic — DNS rebinding still sidesteps it,
 *  so callers that follow redirects must re-check every hop (see `fetchNoSSRF`)
 *  and production should additionally lean on the runtime's egress policy. */
export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().trim().replace(/^\[|\]$/g, "");
  if (!h) return true;
  if (
    h === "localhost" ||
    h.endsWith(".local") ||
    h.endsWith(".internal") ||
    h.endsWith(".lan")
  )
    return true;

  // Every IPv4 spelling in one place — dotted decimal/octal/hex, the bare
  // 32-bit integer form, and the IPv4-mapped IPv6 wrappers.
  const v4 = parseIpv4(h);
  if (v4) return isPrivateIpv4(v4[0], v4[1]);

  // IPv6 loopback / unspecified / link-local / unique-local. Gate on the
  // presence of ":" so an ordinary hostname like "fcm.googleapis.com" (starts
  // with "fc") isn't misread as a unique-local IPv6 address.
  if (h.includes(":")) {
    if (h === "::1" || h === "::") return true;
    if (h.startsWith("fe80:")) return true; // link-local
    if (h.startsWith("fc") || h.startsWith("fd")) return true; // unique local
  }
  return false;
}

/** Validate a user-supplied URL before the server fetches it: must be http(s)
 *  and must not resolve (syntactically) to a private/loopback/metadata host.
 *  Throws `AppError("VALIDATION", …)` otherwise. Returns the parsed URL. */
export function assertPublicHttpUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new AppError("VALIDATION", "Invalid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new AppError("VALIDATION", "Only http(s) URLs are allowed");
  }
  if (isPrivateHost(parsed.hostname)) {
    throw new AppError("VALIDATION", "URL host is not allowed (private/internal address)");
  }
  return parsed;
}

/**
 * The one refusal that is NOT behind {@link ssrfGuardEnabled}.
 *
 * Everything else about outbound fetching is a posture an operator chooses.
 * This is not: no deployment has a reason to fetch its own instance metadata
 * from inside a tenant-authored webhook, flow, sync or import, and the reply is
 * a credential.
 */
export function assertNotMetadataHost(rawUrl: string): void {
  let host: string;
  try {
    host = new URL(rawUrl).hostname;
  } catch {
    return; // not a URL we can judge — the caller's own parse will refuse it
  }
  if (isMetadataHost(host)) {
    throw new AppError(
      "VALIDATION",
      "URL host is not allowed (cloud instance metadata endpoint)",
    );
  }
}

/**
 * Follow a redirect chain ourselves, re-judging the host at every hop.
 *
 * ONE walker, two policies. `fetchNoSSRF` applies the full private-host block;
 * `fetchOutbound`'s permissive path applies only the unconditional metadata
 * refusal. They used to be one guarded walker and one bare `fetch`, which meant
 * the permissive path could be 30x'd into the metadata address even when the
 * first hop was innocent.
 *
 * Following the chain ourselves means a redirected request RE-SENDS `init`, so
 * a body has to be re-readable — a string or a buffer, not a one-shot stream.
 * Every caller on this path sends a serialized payload (webhooks, flow request
 * ops, integration deliveries), and the one that streams (`/from-url`) was
 * already on the manual walker. Worth knowing before adding a caller that
 * pipes.
 */
async function walkRedirects(
  rawUrl: string,
  init: RequestInit,
  maxRedirects: number,
  judge: (url: string) => void,
): Promise<Response> {
  let url = rawUrl;
  for (let i = 0; i <= maxRedirects; i++) {
    judge(url);
    // `redirect: "manual"` surfaces 30x with a Location header (status 0/opaque
    // on some runtimes is treated as no-redirect → return as-is).
    const resp = await fetch(url, { ...init, redirect: "manual" });
    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get("location");
      if (!loc) return resp;
      if (i === maxRedirects) throw new AppError("VALIDATION", "Too many redirects");
      // Resolve relative redirects against the current URL, then re-judge.
      url = new URL(loc, url).toString();
      continue;
    }
    return resp;
  }
  throw new AppError("VALIDATION", "Too many redirects");
}

/**
 * SSRF-safe `fetch` for server-side requests to user-supplied URLs. Follows
 * redirects MANUALLY, re-validating the host on every hop so an attacker can't
 * pass the initial guard and then 30x-redirect into `169.254.169.254` /
 * `localhost`. Caps the redirect chain. Use this anywhere a stored/user URL is
 * fetched (URL import, webhooks, flow `request` ops, etc.).
 *
 * Syntactic only — a hostname whose A record points at loopback still connects.
 * See the note on {@link isPrivateHost}.
 */
export async function fetchNoSSRF(
  rawUrl: string,
  init: RequestInit & { maxRedirects?: number } = {},
): Promise<Response> {
  const { maxRedirects = 5, ...rest } = init;
  return walkRedirects(rawUrl, rest, maxRedirects, (u) => {
    assertPublicHttpUrl(u);
  });
}

/** Whether SSRF host-blocking is active for admin-supplied outbound URLs
 *  (webhooks, flow request ops). On by default for managed cloud tenants
 *  (`CLOUD_PROJECT_ID`) or when `BLOCK_PRIVATE_FETCH_HOSTS` is set; off for
 *  self-host so internal webhook receivers keep working. */
export const ssrfGuardEnabled = (env: Pick<Env, "BLOCK_PRIVATE_FETCH_HOSTS" | "CLOUD_PROJECT_ID">): boolean =>
  Boolean(env.BLOCK_PRIVATE_FETCH_HOSTS) || Boolean(env.CLOUD_PROJECT_ID);

/** `fetch` for admin-supplied outbound URLs. Applies the SSRF guard
 *  (private-host block + redirect re-validation) only when enabled for the
 *  environment; otherwise a plain fetch (preserving self-host behavior). */
export async function fetchOutbound(
  env: Pick<Env, "BLOCK_PRIVATE_FETCH_HOSTS" | "CLOUD_PROJECT_ID">,
  rawUrl: string,
  init: RequestInit & { maxRedirects?: number } = {},
): Promise<Response> {
  if (ssrfGuardEnabled(env)) return fetchNoSSRF(rawUrl, init);
  // The permissive path is still not permissive about THIS. `isPrivateHost` is
  // opt-in so a self-hoster's internal receiver on 10.0.0.7 keeps working; the
  // metadata endpoint is not an internal receiver, it is the deployment's own
  // credentials, and it is refused whatever the operator configured.
  const { maxRedirects = 5, ...rest } = init;
  return walkRedirects(rawUrl, rest, maxRedirects, assertNotMetadataHost);
}
