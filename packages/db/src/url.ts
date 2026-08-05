/**
 * URL fields — a web address stored the one way every client resolves it.
 *
 * Everything in this module is PURE, and it imports only the IDNA half of
 * `./email` (which is itself dependency-free), which is why `@backlex/db/url` is
 * its own package export — reaching it through the package root would drag the
 * migration bundles, and their `*.sql` imports, into the browser build. The
 * admin's URL input, its list cell and the server's write path all parse with
 * the same function, so the address an operator is shown while typing is the
 * exact string that lands in the column.
 *
 * ## The shape of the problem
 *
 * Sixteen columns across ten of the twenty-seven schema templates are a web
 * address — `website` on authors, brands, clients, organizers and speakers,
 * `canonical_url` on posts and pages, `url` on webhooks, `video_url`,
 * `submission_url`, `tracking_url`, `external_url`, `linkedin`, and the two
 * columns named `domain`. Every one of them was a bare `text` column carrying
 * the same hand-written string, `^https?://.+`. Four things break at once:
 *
 *  - **Agreement.** There were FIVE hand-written answers in this repo to "is
 *    this a URL", and they did not agree: the field-level {@link URL_RE} ancestor
 *    (`/^https?:\/\/[^\s/$.?#][^\s]*$/i`), the catalog's string twin
 *    (`"^https?://.+"`, which accepts a scheme followed by whitespace), the
 *    prefix-only `/^https?:\/\//` on `previewUrl`, the admin's client-side mirror
 *    of it, and GraphQL's `new URL()` in a `try`/`catch` — which pins no scheme
 *    at all, so `ftp://` and `javascript:` passed where the REST twin refused
 *    them. A value could pass validation at write time and be refused later by
 *    the thing that was supposed to fetch it.
 *  - **Identity.** `HTTPS://Acme.COM/` and `https://acme.com/` are one address
 *    and two strings, and nothing folded them. Scheme and host are
 *    case-insensitive (RFC 3986 §3.1, §3.2.2); a default port means the same
 *    endpoint as no port; a percent-escape and its unreserved character are the
 *    same byte. So `unique` on a URL column meant nothing, and a lookup by the
 *    address someone reads off a page found no row.
 *  - **Modelling.** The one regex was applied to columns named `domain`
 *    (`crm.companies`, `support.organizations`), which do not hold URLs — a CRM
 *    matches a company by its bare email domain, which is exactly what pairs
 *    with the `email` type. Because the regex demanded a scheme, both templates'
 *    sample rows hold `https://acme.example` in a column named `domain`, and an
 *    operator typing `acme.com` got a 422. The schema was distorted to satisfy a
 *    validator that was wrong for it.
 *  - **Reach.** An internationalized host has to reach a resolver in its A-label
 *    form. Nothing converted one, so `https://örnek.com` stored the U-label and
 *    every fetch against it depended on whatever the client happened to do.
 *
 * A `url` field stores a canonical serialization and nothing else. The column
 * stays `TEXT`, so a template's existing `text` URL column becomes a URL field
 * without a migration — only its values need normalizing.
 *
 * ## What is bundled, and what is deliberately refused
 *
 * Canonicalizing a URL is a **closed** problem with a written-down answer: the
 * WHATWG URL Standard, which every runtime this project targets already ships
 * (Bun, workerd, Node and every browser). So {@link parseUrl} parses with the
 * platform's `URL` rather than a sixth hand-written regex, and then rebuilds the
 * stored string from the parsed parts so the serialization is ours and not the
 * implementation's. The one piece with a history of divergence between
 * implementations is IDNA, so the host is folded with this package's own
 * {@link domainToAscii} — the same function the `email` type uses, which means
 * the two types provably cannot disagree about what a domain is.
 * `url-field.test.ts` pins that agreement against the platform `URL` on a
 * corpus, so a divergence shows up as a failing test rather than as a cell that
 * does not match the row it came from.
 *
 * Deciding whether an address will actually serve something is the opposite kind
 * of problem, and every tempting version of it is refused:
 *
 *  - **No reachability check.** That is a network call on the write path, its
 *    answer is true only at the instant it is asked, and on a field an operator
 *    controls it is a request-forgery primitive. Whether a URL may be FETCHED is
 *    a separate question, asked at fetch time by `fetchOutbound`.
 *  - **No tracking-parameter stripping.** Dropping `utm_*` is a policy about
 *    someone else's query string, the list is open and drifts, and a query
 *    parameter is meaningful to the server that defined it. Two URLs differing
 *    only in `?utm_source` really are two URLs.
 *  - **No query-parameter sorting.** `?b=2&a=1` and `?a=1&b=2` are the same
 *    request to almost every server and NOT to all of them — order is preserved
 *    in the grammar, and some APIs sign it.
 *  - **No trailing-slash folding on a path.** `/a/` and `/a` are different
 *    resources to most servers. Only the empty path is normalized, to `/`, which
 *    is what the URL Standard itself does.
 *  - **No credentials.** `https://user:pass@host/` is refused outright rather
 *    than stored: the column is exported, logged and shown in list cells, and a
 *    password does not belong in any of them. A caller that needs authentication
 *    sends a header.
 *  - **No shortener expansion, no redirect following.** Both are network calls,
 *    and both change what the operator typed into something they did not.
 *
 * This is the same judgement `email.ts` made about typo correction, `phone.ts`
 * made about numbering plans and `geo.ts` made about geocoders: bundle the
 * dataset that is closed, refuse the one that is not.
 *
 * @module
 */

import { domainToAscii, domainToUnicode, EMAIL_LABEL_MAX_LENGTH } from "./email";

/**
 * The most characters a canonical URL may hold.
 *
 * There is no cap in RFC 3986 — this is a practical one. 2048 is the smallest
 * limit in wide deployment (it is what several proxies and the older Microsoft
 * stack enforce), so a URL longer than this is one a meaningful share of clients
 * cannot request anyway. It is applied BEFORE any parsing runs — see
 * {@link parseUrl} — so nothing in this module is handed an unbounded string.
 */
export const URL_MAX_LENGTH = 2048;

/** The most characters one DNS label may hold — the same cap `email` applies. */
export const URL_LABEL_MAX_LENGTH = EMAIL_LABEL_MAX_LENGTH;

/**
 * The most characters a whole host may hold (RFC 1035 §2.3.4 — 253 once the
 * root label's dot is discounted).
 *
 * Exported because it, and NOT {@link URL_MAX_LENGTH}, is the right bound on
 * anything about to be handed to the IDNA encoder. Punycode is quadratic in the
 * number of DISTINCT code points in a label, so a 2048-character run of them
 * costs ~20ms of CPU; the same input capped at a host's real maximum costs
 * ~1ms. A string longer than this cannot be a host or a prefix of one, so
 * declining to encode it loses nothing.
 */
export const URL_HOST_MAX_LENGTH = 253;

/**
 * The schemes a URL field accepts unless it names its own.
 *
 * `https` first: it is the default the scheme autofill supplies, and the order
 * of this array is what decides that.
 */
export const DEFAULT_URL_SCHEMES = ["https", "http"] as const;

/** One ASCII DNS label — a letter or digit at each end, hyphens allowed inside. */
const LABEL = "[a-z0-9](?:[a-z0-9-]*[a-z0-9])?";

/**
 * A canonical *registrable* host: at least two dot-separated ASCII labels.
 *
 * This describes what a `form: "host"` column holds, i.e. a value
 * {@link parseUrl} has already folded — so it is lowercase ASCII by
 * construction. Two labels is the same refusal `email` makes for the same
 * reason: that column names a company's domain, and a single-label value in one
 * is a typo every time.
 *
 * Every quantified run is over a character class that excludes its own
 * separator, so matching is linear and there is nothing for a backtracker to
 * explore. The length cap above is belt-and-braces on top of that.
 */
export const HOST_RE = new RegExp(`^(?:${LABEL}\\.)+${LABEL}$`);

/**
 * A canonical host inside a URL — one label or many.
 *
 * Deliberately LAXER than {@link HOST_RE}, and the difference is the whole
 * reason the two exist. `http://localhost:9000/hook` and `http://receiver/` are
 * exactly the internal webhook endpoints a self-hosted install points at — the
 * SSRF guard is off by default on self-host precisely to keep them working — so
 * a URL field that refused a single-label host would break the deployments this
 * product is happiest in. A bare `domain` column is a different question and
 * gets the stricter pattern.
 */
const URL_HOST_RE = new RegExp(`^${LABEL}(?:\\.${LABEL})*$`);

/** Four dotted decimal octets — `URL` has already rejected out-of-range ones by
 *  the time this runs, so this only has to recognise the SHAPE. */
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** How the admin and CSV export render a stored address. */
export type UrlDisplay = "ascii" | "unicode";

/** What a URL field's column holds — a whole address, or just its host. */
export type UrlForm = "url" | "host";

/** A parsed, canonical URL. */
export interface ParsedUrl {
  /** The canonical value — exactly what the column holds. */
  url: string;
  /** The scheme, lowercased, without the `:`. Empty for `form: "host"`. */
  scheme: string;
  /** The host in A-label form. */
  host: string;
  /** The host a person recognises — `host` with its A-labels decoded. */
  unicodeHost: string;
  /** The port, when it is not the scheme's default. Empty otherwise. */
  port: string;
  /** Path, query and fragment, exactly as stored. Empty for `form: "host"`. */
  path: string;
}

/** The port a scheme uses when none is written down. */
const DEFAULT_PORTS: Record<string, string> = { http: "80", https: "443" };

/**
 * Whether a string already carries a scheme.
 *
 * The trap this exists to avoid is that `localhost:3000` IS a well-formed URL to
 * the URL Standard — scheme `localhost:`, opaque path `3000` — so testing for a
 * `:` is not enough and neither is handing the raw string to `new URL` and
 * seeing whether it throws. A scheme is a letter followed by letters, digits,
 * `+`, `-` or `.` (RFC 3986 §3.1), and it must be followed by `//` for the
 * hierarchical forms this type accepts. Requiring the `//` is what makes
 * `localhost:3000` read as a host and a port, which is what an operator typing
 * it means.
 */
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

/** A scheme-looking prefix WITHOUT the `//` — `mailto:`, `javascript:`, and the
 *  `localhost:3000` false positive this has to tell apart from them. */
const OPAQUE_SCHEME_RE = /^([a-z][a-z0-9+.-]*):(?!\/\/)/i;

/**
 * Fold a host to the form a resolver answers for: NFC, lowercase, A-labels, and
 * without the root's trailing dot.
 *
 * `acme.com.` and `acme.com` name the same host — the trailing dot is the
 * explicit root, and folding it is what stops the two spellings being two rows
 * on a `unique` column. It is dropped only when it is the LAST character;
 * an empty label anywhere else is a malformed host and the pattern refuses it.
 *
 * @throws Error naming the problem, for the caller to prefix with a field name.
 */
const canonicalHost = (raw: string, requireRegistrable: boolean): string => {
  // An IPv6 literal arrives from `URL` already bracketed and compressed to its
  // canonical form, and it has no labels to fold — IDNA would only corrupt it.
  // It never satisfies `requireRegistrable`: an address is not a domain.
  if (raw.startsWith("[")) {
    if (requireRegistrable) throw new Error("must be a domain, not an IP address");
    if (!raw.endsWith("]")) throw new Error("must have a valid host");
    return raw.toLowerCase();
  }
  const trimmed = raw.endsWith(".") ? raw.slice(0, -1) : raw;
  if (!trimmed) throw new Error("must have a host");
  // Bounded BEFORE the encoder runs, not after — Punycode is quadratic in the
  // distinct code points of a label, and this is reached from the write path
  // and (via the prefix fold) from the read path.
  if (trimmed.length > URL_HOST_MAX_LENGTH) {
    throw new Error(`has a host longer than ${URL_HOST_MAX_LENGTH} characters`);
  }
  const host = domainToAscii(trimmed);
  for (const label of host.split(".")) {
    if (label.length > URL_LABEL_MAX_LENGTH) {
      throw new Error(`has a host label longer than ${URL_LABEL_MAX_LENGTH} characters`);
    }
  }
  if (requireRegistrable) {
    // An IPv4 literal satisfies HOST_RE by accident — digits are ordinary label
    // characters, so `192.168.1.5` reads as four labels. A `domain` column names
    // the thing a company's mail is at; an address is not one, and letting it
    // through would put a value in the column that can never match an email's
    // right-hand side.
    if (IPV4_RE.test(host)) throw new Error("must be a domain, not an IP address");
    if (!HOST_RE.test(host)) throw new Error("must be a domain like example.com");
  } else if (!URL_HOST_RE.test(host)) {
    throw new Error("must have a valid host");
  }
  return host;
};

/**
 * Parse whatever was typed into a canonical URL.
 *
 * Folding, in order: trim, supply the default scheme when none was written,
 * parse with the platform's `URL`, refuse anything the field did not ask for
 * (scheme, credentials), fold the host with this package's IDNA, drop a default
 * port, and rebuild the string from the parts.
 *
 * The rebuild is the part worth stating plainly. `URL.href` would be shorter,
 * but it makes the stored value a property of whichever engine happened to run —
 * and the admin (a browser) and the write path (workerd or Bun) are not the same
 * engine. Assembling it here means the two agree by construction, and the only
 * component whose folding is not literal string work is the host, which is
 * {@link domainToAscii}'s job and is tested against the platform on a corpus.
 *
 * @throws Error describing the problem, never quoting the value — these reach
 *   activity rows and logs, and a URL can carry a capability in its path.
 */
export const parseUrl = (raw: unknown, spec: UrlSpec | undefined = undefined): ParsedUrl => {
  if (typeof raw !== "string") throw new Error("must be a URL");

  // Length is checked BEFORE any parsing, on the raw input — the cap is what
  // bounds every pattern in this module regardless of what arrives.
  if (raw.length > URL_MAX_LENGTH * 2) {
    throw new Error(`is longer than ${URL_MAX_LENGTH} characters`);
  }

  const value = raw.trim();
  if (!value) throw new Error("must be a URL");

  // A host column is the whole value, so it never goes near the URL parser: a
  // bare `acme.com` is not a URL, and giving the parser a scheme it did not have
  // just to take the host back out would accept `https://acme.com/orders` for a
  // field that means "the company's domain".
  if (spec?.form === "host") {
    if (SCHEME_RE.test(value) || OPAQUE_SCHEME_RE.test(value) || value.includes("/")) {
      throw new Error("must be a bare host, without a scheme or a path");
    }
    const host = canonicalHost(value, true);
    if (host.length > URL_MAX_LENGTH) {
      throw new Error(`is longer than ${URL_MAX_LENGTH} characters`);
    }
    return {
      url: host,
      scheme: "",
      host,
      unicodeHost: domainToUnicode(host),
      port: "",
      path: "",
    };
  }

  const schemes = urlSchemes(spec);
  if (schemes.length === 0) {
    // A declared restriction nobody can read. Same rule the email type's
    // `allowedDomains` follows: refuse and name the configuration, because a
    // scheme allow-list exists to keep `javascript:` out of a column that gets
    // rendered as a link, and one that silently is not running is worse than one
    // that rejects everything.
    throw new Error("the field's `schemes` cannot be read — fix the field configuration");
  }

  // Scheme autofill. `acme.com` is what an operator types into a box labelled
  // "Website", and two places in this repo were already prepending `https://` by
  // hand to cope with it. It happens only when there is NO scheme at all — an
  // opaque one (`mailto:`, `javascript:`) is a real scheme this field does not
  // accept, and saying so is more useful than turning it into
  // `https://mailto:...`.
  let candidate = value;
  if (!SCHEME_RE.test(candidate)) {
    if (OPAQUE_SCHEME_RE.test(candidate)) {
      const scheme = (OPAQUE_SCHEME_RE.exec(candidate)?.[1] ?? "").toLowerCase();
      // …except that `localhost:3000` matches the opaque form and means a host
      // and a port. It is told apart by what follows: all-digits is a port.
      const rest = candidate.slice(scheme.length + 1);
      if (/^\d+(?:[/?#]|$)/.test(rest)) {
        candidate = `${schemes[0]}://${candidate}`;
      } else {
        throw new Error(`must be a ${schemes.join(" or ")} URL`);
      }
    } else {
      candidate = `${schemes[0]}://${candidate}`;
    }
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error("must be a URL");
  }

  const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
  if (!schemes.includes(scheme)) {
    throw new Error(`must be a ${schemes.join(" or ")} URL`);
  }
  // Refused rather than stored — see the module header. `URL` keeps these, so
  // nothing else in the pipeline would have noticed.
  if (parsed.username || parsed.password) {
    throw new Error("must not carry a username or password");
  }
  if (!parsed.hostname) throw new Error("must have a host");

  const host = canonicalHost(parsed.hostname, false);
  const port = parsed.port && parsed.port !== DEFAULT_PORTS[scheme] ? parsed.port : "";
  // `URL` already normalized the path's dot segments and percent-encoded what
  // had to be, and it guarantees a leading `/` for these schemes. The query and
  // fragment are carried verbatim: they are case-sensitive and their meaning
  // belongs to the server that defined them.
  const path = `${parsed.pathname}${parsed.search}${parsed.hash}`;

  const url = `${scheme}://${host}${port ? `:${port}` : ""}${path}`;
  if (url.length > URL_MAX_LENGTH) {
    throw new Error(`is longer than ${URL_MAX_LENGTH} characters`);
  }

  return { url, scheme, host, unicodeHost: domainToUnicode(host), port, path };
};

/** {@link parseUrl} without the throw — `null` when the value isn't one. */
export const tryParseUrl = (
  raw: unknown,
  spec: UrlSpec | undefined = undefined,
): ParsedUrl | null => {
  if (raw === null || raw === undefined || raw === "") return null;
  try {
    return parseUrl(raw, spec);
  } catch {
    return null;
  }
};

/** The canonical string, or `null` when the value isn't a URL. */
export const canonicalizeUrl = (
  raw: unknown,
  spec: UrlSpec | undefined = undefined,
): string | null => tryParseUrl(raw, spec)?.url ?? null;

/**
 * True when a value is a well-formed `http`/`https` URL.
 *
 * This is the single validator the repo tests against — the places that used to
 * carry their own pattern (`validation.format === "url"`, the `previewUrl`
 * schemas, GraphQL's scheme-less `new URL()`) call it instead, which is what
 * makes "passes validation" and "can actually be fetched" the same question.
 */
export const isUrl = (raw: unknown): boolean => tryParseUrl(raw) !== null;

/**
 * True when a value is a well-formed `http`/`https` URL **as written** — with
 * the scheme spelled out.
 *
 * The difference from {@link isUrl} is the scheme autofill, and which of the two
 * is correct depends entirely on whether anything is going to FOLD the value
 * afterwards:
 *
 *  - A `url` FIELD folds, so `acme.com` is a perfectly good thing to type into
 *    one: the write path turns it into `https://acme.com/` and that is what the
 *    column ends up holding. {@link isUrl} is the right question there.
 *  - `validation.format: "url"` is a rule on a plain `text` column, where
 *    NOTHING folds. Accepting the shorthand there would let `acme.com` pass a
 *    check named "is this a URL" and then sit in the column as a string that is
 *    not one — the write-time/act-time disagreement this module exists to end,
 *    reintroduced by being helpful. So that check requires the scheme, exactly
 *    as the pattern it replaced did.
 *
 * Everything after the scheme is judged by the same parser either way, which is
 * the consolidation that mattered: the five old answers disagreed about hosts,
 * whitespace and credentials, not about whether `https://` was written down.
 */
export const isUrlWithScheme = (raw: unknown): boolean =>
  typeof raw === "string" && SCHEME_RE.test(raw.trim()) && isUrl(raw);

/**
 * Render a stored URL for a human.
 *
 * `unicode` decodes the host's A-labels back — `https://xn--rnek-4qa.com/a`
 * reads as `https://örnek.com/a`, which is the form the person who owns it would
 * recognise. Never use it to fetch; the column holds the resolvable form on
 * purpose.
 */
export const formatUrl = (
  value: unknown,
  display: UrlDisplay = "ascii",
  form: UrlForm = "url",
): string => {
  if (typeof value !== "string" || !value) return "";
  if (display !== "unicode") return value;
  // The form has to be passed in rather than sniffed. A stored host is a string
  // the URL parser will happily accept once the scheme autofill has run, so
  // guessing renders `acme.com` as `https://acme.com/` — a list cell inventing a
  // scheme the column does not hold.
  const parsed = tryParseUrl(value, { form });
  if (!parsed) return value;
  if (!parsed.scheme) return parsed.unicodeHost;
  const port = parsed.port ? `:${parsed.port}` : "";
  return `${parsed.scheme}://${parsed.unicodeHost}${port}${parsed.path}`;
};

/** A rule names the host it means, and a subdomain of it matches. No
 *  public-suffix list is consulted — that dataset is open. */
const hostMatches = (host: string, allowed: string): boolean =>
  host === allowed || host.endsWith(`.${allowed}`);

/* ------------------------------------------------------------------ *
 * Field configuration
 * ------------------------------------------------------------------ */

/**
 * A URL field's configuration.
 *
 * Every member is optional: a bare `url` field accepts any well-formed
 * `https`/`http` address, folded to canonical form, which is the right default —
 * a "Website" column has no business refusing a host it has not heard of.
 */
export interface UrlSpec {
  /**
   * What the column holds. `url` (the default) stores a whole address; `host`
   * stores a bare canonical host like `acme.com`.
   *
   * `host` exists because two templates have a column named `domain` that a CRM
   * matches a company by — the same thing the `email` type stores the right-hand
   * side of. Under the old `^https?://.+` regex both were forced to hold
   * `https://acme.example`, which is not a domain and could not be compared with
   * one. Note this changes what is STORED, unlike {@link display}.
   */
  form?: UrlForm;
  /**
   * The schemes this field accepts. Defaults to {@link DEFAULT_URL_SCHEMES}.
   *
   * The FIRST entry is also the scheme supplied when an operator types a bare
   * host, so a field declaring `["https"]` both refuses `http://` and turns
   * `acme.com` into `https://acme.com/`. Only `http` and `https` are accepted
   * here: every consumer of a stored URL in this product either fetches it or
   * renders it as a link, and no other scheme is safe to do either with.
   */
  schemes?: string[];
  /**
   * Restrict stored URLs to these hosts; an address outside them is refused at
   * write time. A subdomain of a listed host matches, so `example.com` admits
   * `https://docs.example.com/x`.
   *
   * For a column whose values get fetched — a webhook endpoint that must stay
   * inside a partner's domain. Written in whatever form is readable
   * (`örnek.com`) and folded to A-labels on save, so the rule and the values it
   * judges are compared in the same alphabet. It is NOT a request-forgery
   * defence: that is `fetchOutbound`'s job, at fetch time.
   */
  allowedHosts?: string[];
  /** How the admin and CSV export render the stored value. Default `ascii`. */
  display?: UrlDisplay;
}

/**
 * Reject a malformed {@link UrlSpec} at schema-save time.
 *
 * @throws Error naming the problem.
 */
export const validateUrlSpec = (spec: UrlSpec): void => {
  if (spec.form !== undefined && spec.form !== "url" && spec.form !== "host") {
    throw new Error('`form` must be "url" or "host"');
  }
  if (spec.display !== undefined && spec.display !== "ascii" && spec.display !== "unicode") {
    throw new Error('`display` must be "ascii" or "unicode"');
  }
  if (spec.schemes !== undefined) {
    if (!Array.isArray(spec.schemes) || spec.schemes.length === 0) {
      throw new Error("`schemes` must be a non-empty array");
    }
    if (spec.form === "host") {
      throw new Error("`schemes` is meaningless on a host field");
    }
    for (const s of spec.schemes) {
      if (typeof s !== "string" || !DEFAULT_URL_SCHEMES.includes(s as "http" | "https")) {
        throw new Error('`schemes` may only contain "https" and "http"');
      }
    }
  }
  if (spec.allowedHosts !== undefined) {
    if (!Array.isArray(spec.allowedHosts) || spec.allowedHosts.length === 0) {
      throw new Error("`allowedHosts` must be a non-empty array of hosts");
    }
    for (const h of spec.allowedHosts) {
      if (typeof h !== "string" || !h.trim()) {
        throw new Error("`allowedHosts` contains an empty host");
      }
      if (h.length > URL_MAX_LENGTH) {
        throw new Error("`allowedHosts` contains an over-long host");
      }
      // Judged with the same parser the values are, so a rule that could never
      // match anything is caught here rather than silently refusing every write.
      if (!tryParseUrl(h.trim(), { form: "host" })) {
        throw new Error(`\`allowedHosts\` contains an invalid host: ${h}`);
      }
    }
  }
};

/**
 * The spec's schemes, lowercased and de-duplicated.
 *
 * An EMPTY array means a restriction was declared and none of it could be read —
 * {@link parseUrl} refuses in that case rather than falling back to the default,
 * because the reason to narrow this list is to keep a scheme OUT.
 */
export const urlSchemes = (spec: UrlSpec | undefined): string[] => {
  // Three answers, not two — the distinction this function exists to make.
  // ABSENT is "no restriction was declared", and the default applies. Anything
  // else means a restriction WAS declared, and if it cannot be read the answer
  // is the empty array, which `parseUrl` turns into a refusal.
  //
  // Collapsing those two into one `!Array.isArray(...) -> default` test is a
  // fail-OPEN: stored field metadata is untrusted, and a `schemes` that arrived
  // as the string `"https"` from a restore or a hand-written import would fall
  // back to the default and quietly admit the `http` the field was configured to
  // keep out. Same rule, and the same near-miss, as the email type's
  // `allowedDomains`.
  if (spec?.schemes === undefined) return [...DEFAULT_URL_SCHEMES];
  if (!Array.isArray(spec.schemes) || spec.schemes.length === 0) return [];
  const out: string[] = [];
  for (const s of spec.schemes) {
    // A non-string entry must be skipped, not handed to `.toLowerCase()`, which
    // would throw from inside a validator and 500 the write instead of
    // rejecting it.
    if (typeof s !== "string") continue;
    const lower = s.trim().toLowerCase();
    if (DEFAULT_URL_SCHEMES.includes(lower as "http" | "https") && !out.includes(lower)) {
      out.push(lower);
    }
  }
  return out;
};

/**
 * The spec's hosts in the A-label form stored values carry.
 *
 * `null` means **no restriction was declared**. An EMPTY array means one was
 * declared and none of it could be read — a different answer, and the caller
 * must refuse rather than admit everything.
 */
export const allowedUrlHosts = (spec: UrlSpec | undefined): string[] | null => {
  // Three answers, exactly as {@link urlSchemes} makes them. ABSENT is the only
  // one that means "no restriction"; anything else means one was DECLARED, and
  // if it cannot be read the answer is the empty array, which `parseUrlForField`
  // turns into a refusal.
  //
  // Testing `!Array.isArray(...)` first — which is what the email twin this was
  // copied from did — collapses "not declared" and "declared as a string" into
  // the same `null`, so an `allowedHosts: "partner.example"` arriving from a
  // restore or a hand-written import reads as no restriction at all and the rule
  // silently stops running. `validateUrlSpec` refuses that shape at save time,
  // but `backup.ts` re-inserts dumped `collections` rows and calls
  // `applyCollection` without going through it.
  if (spec?.allowedHosts === undefined) return null;
  if (!Array.isArray(spec.allowedHosts) || spec.allowedHosts.length === 0) return [];
  const out: string[] = [];
  for (const h of spec.allowedHosts) {
    if (typeof h !== "string") continue;
    const parsed = tryParseUrl(h.trim(), { form: "host" });
    if (parsed) out.push(parsed.host);
  }
  // Deliberately NOT `out.length ? out : null`. `validateUrlSpec` refuses an
  // unreadable rule at save time, so reaching here means metadata that arrived
  // another way — a restore, an import, a direct write. The safe reading of a
  // restriction nobody can parse is "nothing passes", not "everything does".
  return out;
};

/**
 * Parse a value against a field's configuration — the function every surface
 * calls, so the admin preview, the write path and the filter operands cannot
 * disagree about what canonical means.
 *
 * @throws Error describing the problem, never quoting the value.
 */
export const parseUrlForField = (raw: unknown, spec?: UrlSpec): ParsedUrl => {
  const parsed = parseUrl(raw, spec);
  const allowed = allowedUrlHosts(spec);
  if (allowed && allowed.length === 0) {
    throw new Error("the field's `allowedHosts` cannot be read — fix the field configuration");
  }
  if (allowed && !allowed.some((h) => hostMatches(parsed.host, h))) {
    throw new Error(`must be at ${allowed.map((h) => domainToUnicode(h)).join(", ")}`);
  }
  return parsed;
};
