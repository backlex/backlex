// What a website's domain, exclusion patterns and ignored addresses have to
// look like to do anything.
//
// The server is the authority — `services/analytics.ts` refuses the same three
// shapes, and REST, GraphQL, the SDK and the CLI all go through it. This exists
// so the form can say WHICH entry is wrong while it is still on screen, rather
// than closing optimistically and surfacing a 422 over a page the operator has
// already left.
//
// Every rule here is derived from how the value is USED at collect time, not
// from a general idea of what a domain or a path is:
//
//   - the domain is compared against the request's real origin host when
//     `require_known_origin` is on (the default), so a value a browser can
//     never send drops every event with a 202 and no error anywhere;
//   - `pathExcluded` compares against `location.pathname` with the query
//     already stripped, and an entry with no `*` is an EXACT match, so `admin`
//     and `/search?q=x` are rules that can never fire;
//   - `ignoredIps` is an exact `includes` against the request IP, so a label or
//     a CIDR range never matches.
//
// Keep this in step with `assertDomain` / `assertPaths` / `assertIps`.

/** Reduce whatever was typed to a bare lowercase host, the way the server
 *  does: a full URL, a host with a port and a bare host all arrive here. */
export const normalizeDomain = (raw: string): string => {
  const t = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (!t) return "";
  const withScheme = t.includes("://") ? t : `https://${t}`;
  try {
    return new URL(withScheme).hostname;
  } catch {
    return t.replace(/^https?:\/\//, "").split("/")[0]?.split(":")[0] ?? "";
  }
};

/**
 * Is this a host, by the same rule the server applies?
 *
 * The character test is not belt-and-braces — it is the whole check, because
 * `new URL()` cannot be trusted to agree with itself across runtimes. Chrome
 * PERCENT-ENCODES a space in a host (`https://my site.com` parses, and
 * `.hostname` comes back `my%20site.com`), while Node, Bun and workerd all
 * throw on the same input. A mirror built on the throw therefore passes in the
 * browser exactly the value the server is about to refuse — measured, not
 * assumed. So the set of characters a host may hold is what decides, and the
 * round-trip only catches the rest.
 *
 * `localhost`, a bare IP and a bracketed IPv6 literal are hosts and pass on
 * purpose; `_` is accepted because the server accepts it.
 */
const HOST_CHARS = /^[a-z0-9._-]+$/;
const IPV6_LITERAL = /^\[[0-9a-f:.]+\]$/;

const isResolvableHost = (host: string): boolean => {
  if (!host) return false;
  if (IPV6_LITERAL.test(host)) return true;
  if (!HOST_CHARS.test(host)) return false;
  // Every label has to be a label: `..`, `a..b` and a bare `-` clear the
  // character test and are still not names anything resolves.
  if (!host.split(".").every((label) => label.length > 0 && /[a-z0-9]/.test(label))) {
    return false;
  }
  try {
    return new URL(`https://${host}`).hostname === host;
  } catch {
    return false;
  }
};

/** `null` when the domain is usable, otherwise the reason it is not. */
export const domainProblem = (raw: string): string | null => {
  const trimmed = raw.trim();
  if (!trimmed) return null; // "required" is the submit button's job, not this one's
  return isResolvableHost(normalizeDomain(trimmed)) ? null : "host";
};

/** Split the comma/newline form both list fields are edited in. */
export const splitList = (v: string): string[] =>
  v
    .split(/[\n,]/)
    .map((x) => x.trim())
    .filter(Boolean);

export type ListProblem = { entry: string; reason: "everything" | "query" | "slash" };

/** The first exclusion pattern that cannot match, if any. */
export const pathProblem = (entries: string[]): ListProblem | null => {
  for (const entry of entries) {
    if (entry === "*" || entry === "**") return { entry, reason: "everything" };
    if (/[\s?#]/.test(entry)) return { entry, reason: "query" };
    if (!entry.startsWith("/") && !entry.startsWith("*")) return { entry, reason: "slash" };
  }
  return null;
};

const isIpAddress = (value: string): boolean => {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) {
    return value.split(".").every((o) => Number(o) <= 255);
  }
  try {
    return new URL(`https://[${value}]`).hostname === `[${value.toLowerCase()}]`;
  } catch {
    return false;
  }
};

export type IpProblem = { entry: string; reason: "range" | "address" };

/** The first ignored address that cannot match, if any. */
export const ipProblem = (entries: string[]): IpProblem | null => {
  for (const entry of entries) {
    if (entry.includes("/")) return { entry, reason: "range" };
    if (!isIpAddress(entry)) return { entry, reason: "address" };
  }
  return null;
};
