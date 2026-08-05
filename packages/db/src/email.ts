/**
 * Email fields — an address stored the one way every mail server accepts.
 *
 * Everything in this module is PURE: the envelope, the parser, the Punycode
 * codec and the formatter. Nothing here imports anything, which is why
 * `@backlex/db/email` is its own package export — reaching it through the
 * package root would drag the migration bundles, and their `*.sql` imports, into
 * the browser build. The admin's email input, its list cell and the server's
 * write path all parse with the same function, so the address an operator is
 * shown while typing is the exact string that lands in the column.
 *
 * ## The shape of the problem
 *
 * Fifty-eight columns across twenty-five of the twenty-seven schema templates
 * are an email address — `email` on customers, contacts, leads, patients,
 * students, donors, drivers, technicians; `work_email`, `personal_email`,
 * `author_email`, `billing_email`, `contact_email`, `tenant_email`,
 * `buyer_email`, `member_email`, `notify_email`, `inbound_address`. Every one of
 * them was a bare `text` column carrying a hand-written regex. Three things
 * break at once:
 *
 *  - **Identity.** `Ada@Example.com` and `ada@example.com` are one mailbox and
 *    two strings. FOURTEEN of those columns are declared `unique`, across
 *    fourteen different templates, and every one of them was enforcing nothing
 *    against the commonest way an address gets written twice. A lookup by the
 *    address a customer types finds no row, and deduplication cannot work.
 *    Every consumer that needed identity was already fixing this by hand and in
 *    a different place: `portal-links` wraps the COLUMN in `lower()` (defeating
 *    its index) so a signup can find its person row, and the Mailchimp and
 *    Klaviyo providers lowercase on the way out because both key a subscriber
 *    on the folded address.
 *  - **Delivery.** An internationalized domain has to reach the SMTP envelope in
 *    its A-label (Punycode) form. Nothing converted one, so `ada@örnek.com`
 *    stored the U-label and every send against it depended on whatever the
 *    provider happened to do with non-ASCII.
 *  - **Agreement.** There were EIGHT hand-written email regexes in this repo and
 *    they did not agree. The field-level one accepted `,`, `;`, `<`, `>` and
 *    `"`; the send paths (`reports`, `signatures`, `booking`) rejected exactly
 *    those. So a value could pass validation at write time and be refused months
 *    later by the thing that was supposed to mail it — the failure landing on
 *    whoever was waiting for the email, not on whoever typed it.
 *
 * An `email` field stores {@link EMAIL_RE} and nothing else. The column stays
 * `TEXT`, so a template's existing `text` email column becomes an email field
 * without a migration — only its values need normalizing.
 *
 * ## What is bundled, and what is deliberately refused
 *
 * Folding a domain to the form a mail server resolves needs IDNA, and its
 * transcoding half is **closed**: RFC 3492 is an algorithm, not a dataset, it is
 * exactly reversible, and it is about a hundred lines. So it is bundled here in
 * BOTH directions ({@link punycodeEncode}, {@link punycodeDecode}) — the column
 * holds the A-label because that is what gets delivered, and the admin renders
 * the U-label back because that is what a person recognises.
 *
 * Deciding whether an address will actually receive mail is the opposite kind of
 * problem, and every tempting version of it is refused:
 *
 *  - **No typo correction.** `gmial.com` → `gmail.com` needs a list of domains
 *    worth correcting toward, which is open and drifts; a wrong "correction"
 *    silently mails a stranger.
 *  - **No disposable/role-address blocklist.** Same open dataset, and `info@` is
 *    a perfectly ordinary address for a supplier row.
 *  - **No subaddress stripping.** `ada+news@example.com` is a working, distinct
 *    address; folding away the `+tag` is a per-provider convention, and applying
 *    it to a provider that does not share it destroys deliverability.
 *  - **No MX or SMTP probe.** That is a network call on the write path, and its
 *    answer is true only at the instant it is asked.
 *
 * This is the same judgement `phone.ts` made about numbering plans and `geo.ts`
 * made about geocoders: bundle the dataset that is closed, refuse the one that
 * is not.
 *
 * @module
 */

/**
 * The most characters a canonical address may hold.
 *
 * RFC 5321 §4.5.3.1.3 caps a forward-path at 256 octets including the angle
 * brackets, which is the 254 every mail server actually enforces. It is applied
 * BEFORE any regex runs — see {@link parseEmail} — so no pattern in this module
 * can be handed an unbounded string.
 */
export const EMAIL_MAX_LENGTH = 254;

/** The most characters the local part may hold (RFC 5321 §4.5.3.1.1). */
export const EMAIL_LOCAL_MAX_LENGTH = 64;

/** The most characters one DNS label may hold (RFC 1035 §2.3.4). */
export const EMAIL_LABEL_MAX_LENGTH = 63;

/**
 * A canonical email value: an unquoted dot-atom local part, `@`, and an ASCII
 * domain of at least two labels.
 *
 * This describes what the COLUMN holds, i.e. a value {@link canonicalizeEmail}
 * has already folded — so it is ASCII by construction, and it is deliberately
 * narrower than RFC 5322's grammar in three places, each a refusal rather than a
 * half-implementation:
 *
 *  - **No quoted local part.** `"ada bell"@example.com` is legal and is the
 *    single richest source of the escaping bugs this type exists to end (it is
 *    where the `<`, `>` and `"` the old field-level regex admitted came from).
 *    Nothing in the fleet uses one.
 *  - **No address literal.** `ada@[192.0.2.1]` bypasses DNS, so none of the
 *    folding below means anything for it.
 *  - **At least two labels.** `ada@localhost` is deliverable only inside one
 *    machine, and a single-label domain in a customer row is a typo every time.
 *
 * Both quantified runs are over character classes that exclude their own
 * separator, so each character belongs to exactly one alternative and matching
 * is linear — there is no ambiguity for a backtracker to explore. The length cap
 * above is belt-and-braces on top of that.
 */
export const EMAIL_RE =
  /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/**
 * The same envelope, case-insensitively — for testing a value that has NOT been
 * folded yet (an operand a caller typed, a cell an import is about to convert).
 *
 * Kept as its own constant rather than an `i` flag on {@link EMAIL_RE}, because
 * a canonical value being lowercase is a property worth being able to assert.
 */
export const EMAIL_RE_LOOSE = new RegExp(EMAIL_RE.source, "i");

/* ------------------------------------------------------------------ *
 * Punycode (RFC 3492) — the closed half of IDNA, both directions.
 * ------------------------------------------------------------------ */

const PUNY_BASE = 36;
const PUNY_TMIN = 1;
const PUNY_TMAX = 26;
const PUNY_SKEW = 38;
const PUNY_DAMP = 700;
const PUNY_INITIAL_BIAS = 72;
const PUNY_INITIAL_N = 128;
/** An A-label announces itself with this prefix (RFC 5890 §2.3.2.1). */
export const PUNYCODE_PREFIX = "xn--";

/** RFC 3492 §6.1 — the bias adaptation, verbatim. */
const punyAdapt = (delta: number, numPoints: number, firstTime: boolean): number => {
  let d = firstTime ? Math.floor(delta / PUNY_DAMP) : delta >> 1;
  d += Math.floor(d / numPoints);
  let k = 0;
  while (d > ((PUNY_BASE - PUNY_TMIN) * PUNY_TMAX) >> 1) {
    d = Math.floor(d / (PUNY_BASE - PUNY_TMIN));
    k += PUNY_BASE;
  }
  return k + Math.floor(((PUNY_BASE - PUNY_TMIN + 1) * d) / (d + PUNY_SKEW));
};

/** digit 0..35 → its basic code point (`a`-`z` then `0`-`9`). */
const punyDigitToBasic = (digit: number): string =>
  String.fromCharCode(digit + 22 + (digit < 26 ? 75 : 0));

/** The inverse; `-1` for a character that is not a Punycode digit. */
const punyBasicToDigit = (code: number): number => {
  if (code >= 0x30 && code <= 0x39) return code - 0x30 + 26; // 0-9
  if (code >= 0x61 && code <= 0x7a) return code - 0x61; // a-z
  if (code >= 0x41 && code <= 0x5a) return code - 0x41; // A-Z (decode is lenient)
  return -1;
};

/**
 * Encode one label's Unicode code points to Punycode (WITHOUT the `xn--`).
 *
 * Operates on code points, not UTF-16 units, so a label outside the BMP (an
 * emoji domain, which some registries really do sell) encodes correctly rather
 * than as two lone surrogates.
 */
export const punycodeEncode = (label: string): string => {
  const input = Array.from(label, (ch) => ch.codePointAt(0) as number);
  const output: string[] = [];
  for (const c of input) if (c < PUNY_INITIAL_N) output.push(String.fromCodePoint(c));
  const basicLength = output.length;
  let handled = basicLength;
  if (basicLength > 0) output.push("-");

  let n = PUNY_INITIAL_N;
  let delta = 0;
  let bias = PUNY_INITIAL_BIAS;

  while (handled < input.length) {
    // The smallest code point at or above `n` that still has to be encoded.
    let m = Number.MAX_SAFE_INTEGER;
    for (const c of input) if (c >= n && c < m) m = c;
    delta += (m - n) * (handled + 1);
    n = m;
    for (const c of input) {
      if (c < n) delta++;
      if (c !== n) continue;
      let q = delta;
      for (let k = PUNY_BASE; ; k += PUNY_BASE) {
        const t = k <= bias ? PUNY_TMIN : k >= bias + PUNY_TMAX ? PUNY_TMAX : k - bias;
        if (q < t) break;
        output.push(punyDigitToBasic(t + ((q - t) % (PUNY_BASE - t))));
        q = Math.floor((q - t) / (PUNY_BASE - t));
      }
      output.push(punyDigitToBasic(q));
      bias = punyAdapt(delta, handled + 1, handled === basicLength);
      delta = 0;
      handled++;
    }
    delta++;
    n++;
  }
  return output.join("");
};

/**
 * Decode one Punycode label back to Unicode (input WITHOUT the `xn--`).
 *
 * @throws Error when the input is not well-formed Punycode. Every caller in this
 *   module treats that as "then it was never an A-label" and keeps the original
 *   text, because a domain that merely starts with `xn--` is not a promise.
 */
export const punycodeDecode = (label: string): string => {
  const output: number[] = [];
  const delim = label.lastIndexOf("-");
  // Everything before the last delimiter is literal basic code points.
  if (delim > 0) {
    for (let i = 0; i < delim; i++) {
      const code = label.charCodeAt(i);
      if (code >= 0x80) throw new Error("non-basic code point in the literal part");
      output.push(code);
    }
  }

  let n = PUNY_INITIAL_N;
  let i = 0;
  let bias = PUNY_INITIAL_BIAS;

  for (let at = delim > 0 ? delim + 1 : 0; at < label.length; ) {
    const oldi = i;
    let w = 1;
    for (let k = PUNY_BASE; ; k += PUNY_BASE) {
      if (at >= label.length) throw new Error("truncated punycode sequence");
      const digit = punyBasicToDigit(label.charCodeAt(at++));
      if (digit < 0) throw new Error("invalid punycode digit");
      if (digit > Math.floor((Number.MAX_SAFE_INTEGER - i) / w)) {
        throw new Error("punycode overflow");
      }
      i += digit * w;
      const t = k <= bias ? PUNY_TMIN : k >= bias + PUNY_TMAX ? PUNY_TMAX : k - bias;
      if (digit < t) break;
      w *= PUNY_BASE - t;
    }
    const out = output.length + 1;
    bias = punyAdapt(i - oldi, out, oldi === 0);
    n += Math.floor(i / out);
    i %= out;
    if (n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) {
      throw new Error("punycode decoded to an invalid code point");
    }
    output.splice(i, 0, n);
    i++;
  }
  return output.map((c) => String.fromCodePoint(c)).join("");
};

/** True when a string holds a character outside ASCII. */
const hasNonAscii = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0x7f) return true;
  return false;
};

/**
 * A domain in its A-label (all-ASCII) form: each non-ASCII label Punycode-encoded
 * and prefixed, each ASCII label lowercased and left alone.
 *
 * @throws Error naming the problem, for the caller to prefix with a field name.
 */
export const domainToAscii = (domain: string): string =>
  domain
    .split(".")
    .map((label) => {
      if (!hasNonAscii(label)) return label.toLowerCase();
      // NFC first: `é` typed as `e` + U+0301 and `é` as U+00E9 are the same
      // domain, and only one of them resolves. Without this the two fold to
      // different A-labels and land in the column as two different addresses.
      const encoded = punycodeEncode(label.normalize("NFC").toLowerCase());
      if (!encoded) throw new Error("has an empty domain label");
      return PUNYCODE_PREFIX + encoded;
    })
    .join(".");

/**
 * The inverse — for DISPLAY only. A label that claims to be Punycode but does not
 * decode is returned untouched rather than throwing, because this runs on stored
 * values in list cells and exports where a thrown error would blank a whole row.
 */
export const domainToUnicode = (domain: string): string =>
  domain
    .split(".")
    .map((label) => {
      if (!label.toLowerCase().startsWith(PUNYCODE_PREFIX)) return label;
      try {
        const decoded = punycodeDecode(label.slice(PUNYCODE_PREFIX.length));
        return decoded || label;
      } catch {
        return label;
      }
    })
    .join(".");

/* ------------------------------------------------------------------ *
 * Parsing
 * ------------------------------------------------------------------ */

/** How the admin and CSV export render a stored address. */
export type EmailDisplay = "ascii" | "unicode";

/** A parsed, canonical address. */
export interface ParsedEmail {
  /** The canonical value — exactly what the column holds. */
  email: string;
  /** Everything before the `@`. */
  local: string;
  /** Everything after it, in A-label form. */
  domain: string;
  /** The domain a person recognises — `domain` with its A-labels decoded. */
  unicodeDomain: string;
}

/**
 * Parse whatever was typed into a canonical address.
 *
 * Folding, in order: trim, strip one surrounding pair of angle brackets, lower
 * the domain and encode it to A-labels, and — unless the field opted out — lower
 * the local part.
 *
 * The local-part fold is the one judgement call in this module worth stating
 * plainly. RFC 5321 §2.4 reserves the interpretation of a local part to the
 * receiving server, so lowering it is a POLICY, not a fact the way lowering a
 * domain is (DNS is case-insensitive by RFC 4343). It is on by default anyway,
 * for two reasons: identity is the entire point of the type — `unique`, portal
 * auto-link and marketing-list dedup all need one mailbox to be one string — and
 * every consumer in this repo that needed identity was ALREADY folding it by
 * hand, so the default matches the behaviour that shipped. A workspace whose
 * mail server genuinely distinguishes case sets `caseSensitiveLocal`.
 *
 * @throws Error describing the problem, never quoting the value — these reach
 *   activity rows and logs, and an address identifies a real person.
 */
export const parseEmail = (
  raw: unknown,
  spec: EmailSpec | undefined = undefined,
): ParsedEmail => {
  if (typeof raw !== "string") throw new Error("must be an email address");

  // Length is checked BEFORE any pattern runs, on the raw input — the cap is
  // what bounds every regex in this module regardless of what arrives.
  if (raw.length > EMAIL_MAX_LENGTH * 2) {
    throw new Error(`is longer than ${EMAIL_MAX_LENGTH} characters`);
  }

  let value = raw.trim();
  // `Ada Lovelace <ada@example.com>` is what a mail client puts on the clipboard,
  // so the brackets alone are unwrapped — but a display name is NOT parsed off,
  // because keeping only part of what someone pasted is how the wrong address
  // gets stored silently.
  if (value.startsWith("<") && value.endsWith(">")) value = value.slice(1, -1).trim();

  if (!value) throw new Error("must be an email address");
  if (value.length > EMAIL_MAX_LENGTH) {
    throw new Error(`is longer than ${EMAIL_MAX_LENGTH} characters`);
  }

  const at = value.lastIndexOf("@");
  if (at <= 0 || at === value.length - 1) {
    throw new Error("must be an email address");
  }
  const rawLocal = value.slice(0, at);
  const rawDomain = value.slice(at + 1);
  if (rawLocal.includes("@")) throw new Error("must be an email address");

  const local = spec?.caseSensitiveLocal ? rawLocal : rawLocal.toLowerCase();
  if (local.length > EMAIL_LOCAL_MAX_LENGTH) {
    throw new Error(`has a local part longer than ${EMAIL_LOCAL_MAX_LENGTH} characters`);
  }

  let domain: string;
  try {
    domain = domainToAscii(rawDomain);
  } catch (e) {
    throw new Error((e as Error).message);
  }
  for (const label of domain.split(".")) {
    if (label.length > EMAIL_LABEL_MAX_LENGTH) {
      throw new Error(`has a domain label longer than ${EMAIL_LABEL_MAX_LENGTH} characters`);
    }
  }

  const email = `${local}@${domain}`;
  if (email.length > EMAIL_MAX_LENGTH) {
    throw new Error(`is longer than ${EMAIL_MAX_LENGTH} characters`);
  }
  // The canonical value is lowercase everywhere except a local part the field
  // asked to preserve, so the strict pattern is applied to the domain half and
  // the loose one to the local half.
  if (!EMAIL_RE_LOOSE.test(email) || !EMAIL_RE.test(`x@${domain}`)) {
    throw new Error("must be an email address");
  }

  return { email, local, domain, unicodeDomain: domainToUnicode(domain) };
};

/** {@link parseEmail} without the throw — `null` when the value isn't one. */
export const tryParseEmail = (
  raw: unknown,
  spec: EmailSpec | undefined = undefined,
): ParsedEmail | null => {
  if (raw === null || raw === undefined || raw === "") return null;
  try {
    return parseEmail(raw, spec);
  } catch {
    return null;
  }
};

/** The canonical string, or `null` when the value isn't an address. */
export const canonicalizeEmail = (
  raw: unknown,
  spec: EmailSpec | undefined = undefined,
): string | null => tryParseEmail(raw, spec)?.email ?? null;

/**
 * True when a value is a well-formed address.
 *
 * This is the single validator the whole repo tests against — the send paths
 * (`reports`, `signatures`, `booking`) call it instead of the three hand-written
 * regexes they used to carry, which is what makes "passes validation" and "can
 * actually be mailed" the same question. `@backlex/integrations` cannot reach it
 * (`core`/`integrations` may not depend on `db`), so `email-surfaces.test.ts`
 * asserts its copy agrees against a corpus rather than trusting two hand-written
 * patterns to stay in step — the same arrangement `E164_PATTERN` has.
 */
export const isEmail = (raw: unknown): boolean => tryParseEmail(raw) !== null;

/**
 * Render a stored address for a human.
 *
 * `unicode` decodes the A-labels back — `ada@xn--rnek-goa.com` reads as
 * `ada@örnek.com`, which is the form the person who owns it would recognise.
 * Never use it to address mail; the column holds the deliverable form on purpose.
 */
export const formatEmail = (value: unknown, display: EmailDisplay = "ascii"): string => {
  if (typeof value !== "string" || !value) return "";
  if (display !== "unicode") return value;
  const at = value.lastIndexOf("@");
  if (at <= 0) return value;
  return `${value.slice(0, at)}@${domainToUnicode(value.slice(at + 1))}`;
};

/** The registrable-looking tail of an address's domain, lowercased — used by the
 *  domain allow-list. No public-suffix list is consulted (that dataset is open);
 *  a rule names the domain it means, and a subdomain of it matches. */
const domainMatches = (domain: string, allowed: string): boolean =>
  domain === allowed || domain.endsWith(`.${allowed}`);

/* ------------------------------------------------------------------ *
 * Field configuration
 * ------------------------------------------------------------------ */

/**
 * An email field's configuration.
 *
 * Every member is optional: a bare `email` field accepts any well-formed
 * address, folded to canonical form, which is the right default — an address
 * book has no business refusing a domain it has not heard of.
 */
export interface EmailSpec {
  /**
   * Preserve the case of the local part instead of lowering it.
   *
   * Off by default. See {@link parseEmail} for why the default is the fold: RFC
   * 5321 leaves the local part to the receiving server, but identity is what the
   * type is for, and every consumer in this repo was already folding by hand.
   * Turn it on only for a workspace whose mail server genuinely distinguishes
   * `Ada@` from `ada@` — and note that `unique` then stops catching the pair.
   */
  caseSensitiveLocal?: boolean;
  /**
   * Restrict stored addresses to these domains; an address outside them is
   * refused at write time. A subdomain of a listed domain matches, so
   * `example.com` admits `ada@mail.example.com`.
   *
   * For a staff or member collection that must stay inside the company. Written
   * in whatever form is readable (`örnek.com`) and folded to A-labels on save,
   * so the rule and the values it judges are compared in the same alphabet.
   */
  allowedDomains?: string[];
  /** How the admin and CSV export render the stored value. Default `ascii`. */
  display?: EmailDisplay;
}

/**
 * Reject a malformed {@link EmailSpec} at schema-save time.
 *
 * @throws Error naming the problem.
 */
export const validateEmailSpec = (spec: EmailSpec): void => {
  if (spec.caseSensitiveLocal !== undefined && typeof spec.caseSensitiveLocal !== "boolean") {
    throw new Error("`caseSensitiveLocal` must be a boolean");
  }
  if (spec.display !== undefined && spec.display !== "ascii" && spec.display !== "unicode") {
    throw new Error('`display` must be "ascii" or "unicode"');
  }
  if (spec.allowedDomains !== undefined) {
    if (!Array.isArray(spec.allowedDomains) || spec.allowedDomains.length === 0) {
      throw new Error("`allowedDomains` must be a non-empty array of domains");
    }
    for (const d of spec.allowedDomains) {
      if (typeof d !== "string" || !d.trim()) {
        throw new Error("`allowedDomains` contains an empty domain");
      }
      if (d.length > EMAIL_MAX_LENGTH) {
        throw new Error("`allowedDomains` contains an over-long domain");
      }
      // Judged with the same parser the values are, so a rule that could never
      // match anything is caught here rather than silently refusing every write.
      if (!tryParseEmail(`x@${d.trim()}`)) {
        throw new Error(`\`allowedDomains\` contains an invalid domain: ${d}`);
      }
    }
  }
};

/**
 * The spec's domains in the A-label form stored values carry.
 *
 * `null` means **no restriction was declared**. An EMPTY array means one was
 * declared and none of it could be read — a different answer, and the caller
 * must refuse rather than admit everything.
 */
export const allowedEmailDomains = (spec: EmailSpec | undefined): string[] | null => {
  // THREE answers, not two — and getting this to two was a live fail-open until
  // the `url` type copied this function and its reviewer noticed.
  //
  // `Array.isArray` alone reads STORED field metadata correctly enough to stop a
  // string ITERATING as characters, which is what the original note here was
  // about. What it does NOT do is distinguish "no restriction was declared" from
  // "a restriction was declared and is unreadable": both landed on `null`, so an
  // `allowedDomains: "corp.example"` — a plausible shape from a restore, an
  // import or a hand-edited dump — meant "any domain", and a rule that gates who
  // gets MAILED was silently not running. `validateEmailSpec` refuses that at
  // save time, but `backup.ts` re-inserts dumped `collections` rows and calls
  // `applyCollection` without it.
  //
  // Only ABSENT means unrestricted. Anything else that cannot be read is the
  // empty array, which `parseEmailForField` turns into a refusal naming the
  // field's configuration.
  if (spec?.allowedDomains === undefined) return null;
  if (!Array.isArray(spec.allowedDomains) || spec.allowedDomains.length === 0) return [];
  const out: string[] = [];
  for (const d of spec.allowedDomains) {
    // Same reason: a non-string entry must be skipped, not handed to `.trim()`,
    // which would throw from inside a validator and 500 the write instead of
    // rejecting it.
    if (typeof d !== "string") continue;
    const parsed = tryParseEmail(`x@${d.trim()}`);
    if (parsed) out.push(parsed.domain);
  }
  // Deliberately NOT `out.length ? out : null`. `validateEmailSpec` refuses an
  // unreadable rule at save time, so reaching here means metadata that arrived
  // another way — a restore, an import, a direct write. A domain restriction is
  // there to gate who gets mailed; the safe reading of one nobody can parse is
  // "nothing passes", not "everything does".
  return out;
};

/**
 * Parse a value against a field's configuration — the function every surface
 * calls, so the admin preview, the write path and the filter operands cannot
 * disagree about what canonical means.
 *
 * @throws Error describing the problem, never quoting the value.
 */
export const parseEmailForField = (raw: unknown, spec?: EmailSpec): ParsedEmail => {
  const parsed = parseEmail(raw, spec);
  const allowed = allowedEmailDomains(spec);
  if (allowed && allowed.length === 0) {
    // A declared restriction nobody can read. Refusing names the field's
    // configuration as the problem, which is where the fix is — admitting the
    // address would leave the operator believing a rule that is not running.
    throw new Error("the field's `allowedDomains` cannot be read — fix the field configuration");
  }
  if (allowed && !allowed.some((d) => domainMatches(parsed.domain, d))) {
    // The allow-list is named, the value is not: an operator needs to know which
    // domains are acceptable, and the rejected address is still a person's.
    throw new Error(
      `must be an address at ${allowed.map((d) => domainToUnicode(d)).join(", ")}`,
    );
  }
  return parsed;
};
