import { AppError } from "@backlex/core";
import type { Env } from "../../env";

/** Parse a single IPv4 octet that may be written in decimal, octal (leading
 *  `0`), or hex (`0x`) — the encodings attackers use to dodge naive
 *  dotted-decimal checks (`0x7f.0.0.1`, `0177.0.0.1`). Returns null when the
 *  token isn't a valid octet. */
function parseOctet(tok: string): number | null {
  let n: number;
  if (/^0x[0-9a-f]+$/i.test(tok)) n = parseInt(tok, 16);
  else if (/^0[0-7]+$/.test(tok)) n = parseInt(tok, 8);
  else if (/^\d+$/.test(tok)) n = parseInt(tok, 10);
  else return null;
  return Number.isInteger(n) && n >= 0 && n <= 255 ? n : null;
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
  let h = host.toLowerCase().trim().replace(/^\[|\]$/g, "");
  if (!h) return true;
  if (
    h === "localhost" ||
    h.endsWith(".local") ||
    h.endsWith(".internal") ||
    h.endsWith(".lan")
  )
    return true;

  // IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1 or ::ffff:7f00:1) — unwrap to v4.
  const mapped = h.match(/^::ffff:(.+)$/);
  if (mapped?.[1]) {
    const inner = mapped[1];
    if (inner.includes(".")) h = inner;
    else {
      // hex word form ::ffff:7f00:1
      const words = inner.split(":");
      if (words.length === 2) {
        const hi = parseInt(words[0]!, 16);
        const lo = parseInt(words[1]!, 16);
        if (Number.isInteger(hi) && Number.isInteger(lo)) {
          return isPrivateIpv4((hi >> 8) & 0xff, hi & 0xff);
        }
      }
    }
  }

  // Dotted IPv4 (with decimal/octal/hex octets).
  if (/^[0-9a-fx.]+$/i.test(h) && h.includes(".")) {
    const toks = h.split(".");
    if (toks.length === 4) {
      const octs = toks.map(parseOctet);
      if (octs.every((o): o is number => o != null)) {
        return isPrivateIpv4(octs[0]!, octs[1]!);
      }
    }
  }

  // Bare integer IPv4 (e.g. 2130706433 == 127.0.0.1).
  if (/^\d+$/.test(h)) {
    const n = Number(h);
    if (Number.isInteger(n) && n >= 0 && n <= 0xffffffff) {
      return isPrivateIpv4((n >>> 24) & 0xff, (n >>> 16) & 0xff);
    }
  }

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
 * SSRF-safe `fetch` for server-side requests to user-supplied URLs. Follows
 * redirects MANUALLY, re-validating the host on every hop so an attacker can't
 * pass the initial guard and then 30x-redirect into `169.254.169.254` /
 * `localhost`. Caps the redirect chain. Use this anywhere a stored/user URL is
 * fetched (URL import, webhooks, flow `request` ops, etc.).
 */
export async function fetchNoSSRF(
  rawUrl: string,
  init: RequestInit & { maxRedirects?: number } = {},
): Promise<Response> {
  const { maxRedirects = 5, ...rest } = init;
  let url = assertPublicHttpUrl(rawUrl).toString();
  for (let i = 0; i <= maxRedirects; i++) {
    const resp = await fetch(url, { ...rest, redirect: "manual" });
    // `redirect: "manual"` surfaces 30x with a Location header (status 0/opaque
    // on some runtimes is treated as no-redirect → return as-is).
    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get("location");
      if (!loc) return resp;
      if (i === maxRedirects) {
        throw new AppError("VALIDATION", "Too many redirects");
      }
      // Resolve relative redirects against the current URL, then re-guard.
      url = assertPublicHttpUrl(new URL(loc, url).toString()).toString();
      continue;
    }
    return resp;
  }
  throw new AppError("VALIDATION", "Too many redirects");
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
  const { maxRedirects: _ignore, ...rest } = init;
  return fetch(rawUrl, rest);
}
