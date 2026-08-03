/**
 * Phone fields — a number that is stored the one way every machine can dial.
 *
 * Everything in this module is PURE: the calling-code table, the trunk-prefix
 * exceptions, the parser and the formatter. Nothing here imports anything, which
 * is why `@backlex/db/phone` is its own package export — reaching it through the
 * package root would drag the migration bundles, and their `*.sql` imports, into
 * the browser build. The admin's phone input, its list cell and the server's
 * write path all parse with the same function, so the E.164 the operator is
 * shown while typing is the exact string that lands in the column.
 *
 * ## The shape of the problem
 *
 * Thirty-six columns across twenty-one of the twenty-seven schema templates are
 * a phone number — `phone` on customers, contacts, leads, patients, drivers,
 * technicians, donors, tenants, candidates; `mobile_phone`, `tenant_phone`.
 * Every one of them was a bare `text` column, which means the same number
 * reaches storage as `+90 532 111 22 33`, `0532 111 22 33` and `(532) 111-2233`
 * depending on who typed it. Three things break at once:
 *
 *  - **Identity.** Two rows holding the same person are not equal, so a lookup
 *    by the number a caller reads out loud misses, deduplication cannot work,
 *    and `unique` on the column enforces nothing.
 *  - **Delivery.** backlex already ships SMS. Twilio, SNS, NetGSM and
 *    İletimerkezi all want E.164, and the `sms` flow op refuses to send a
 *    recipient that does not match it. So *every* reminder flow addressed at
 *    `{{ data.phone }}` — the single most obvious thing to build on the
 *    appointments, clinic, restaurant and field-service templates — failed at
 *    run time, on a per-row basis, long after the write that caused it.
 *  - **Validation.** The alternative was for each admin to hand-write a regex
 *    per column, and a regex is exactly the wrong tool: it can reject a good
 *    number and cannot canonicalize a bad one.
 *
 * A `phone` field stores {@link E164_RE} and nothing else. The column stays
 * `TEXT`, so a template's existing `text` phone column becomes a phone field
 * without a migration — only its values need normalizing.
 *
 * ## What is bundled, and what is deliberately refused
 *
 * Canonicalizing a national number needs to know the country's calling code and
 * whether it uses a trunk prefix. That is a **closed** dataset: ~250 rows, fixed
 * by the ITU, changing on the timescale of countries being founded. It is
 * bundled here ({@link CALLING_CODES}, {@link TRUNK_PREFIXES}).
 *
 * Printing a number the way a local would write it needs the country's
 * **numbering plan** — which prefixes are mobile, how many digits each carrier
 * block holds, where the spaces go. That is an *open* dataset, it drifts, and
 * the whole of `libphonenumber` exists to track it. So there is no
 * national-format pretty-printer here, and {@link formatPhone} offers exactly
 * one alternative to raw E.164: a space after the calling code, which is the
 * only split the closed table actually justifies. A renderer that guessed the
 * rest would print numbers that look right and are not — see `docs/phone.md`.
 *
 * This is the same judgement `geo.ts` made about geocoders, landing on the other
 * side: bundle the dataset that is closed, refuse the one that is not.
 *
 * @module
 */

/**
 * A canonical phone value: `+`, a non-zero leading digit, 7–15 digits total.
 *
 * This is E.164's own envelope — a country code plus a national significant
 * number, fifteen digits maximum. It is deliberately NOT a per-country length
 * check (see the module note on numbering plans).
 *
 * `E164_PATTERN` in `@backlex/core/adapters` is the same envelope, applied by
 * the SMS adapters. The two cannot be merged — `@backlex/core` may not depend on
 * `@backlex/db`, and this module may not import anything — so instead of
 * trusting that two hand-written regexes stay in agreement,
 * `phone-surfaces.test.ts` asserts it against a corpus.
 */
export const E164_RE = /^\+[1-9]\d{6,14}$/;

/** The most digits E.164 allows, country code included. */
export const E164_MAX_DIGITS = 15;

/**
 * ISO 3166-1 alpha-2 → ITU country calling code, without the `+`.
 *
 * Territories that share a code with their parent (the NANP, Kazakhstan under
 * +7, Jersey under +44) are listed separately so that a workspace can name its
 * own region and get the right answer; the shared code is what actually reaches
 * the column, which is correct — E.164 does not distinguish them either.
 */
export const CALLING_CODES: Readonly<Record<string, string>> = {
  AC: "247", AD: "376", AE: "971", AF: "93", AG: "1", AI: "1", AL: "355",
  AM: "374", AO: "244", AR: "54", AS: "1", AT: "43", AU: "61", AW: "297",
  AX: "358", AZ: "994", BA: "387", BB: "1", BD: "880", BE: "32", BF: "226",
  BG: "359", BH: "973", BI: "257", BJ: "229", BL: "590", BM: "1", BN: "673",
  BO: "591", BQ: "599", BR: "55", BS: "1", BT: "975", BW: "267", BY: "375",
  BZ: "501", CA: "1", CD: "243", CF: "236", CG: "242", CH: "41", CI: "225",
  CK: "682", CL: "56", CM: "237", CN: "86", CO: "57", CR: "506", CU: "53",
  CV: "238", CW: "599", CY: "357", CZ: "420", DE: "49", DJ: "253", DK: "45",
  DM: "1", DO: "1", DZ: "213", EC: "593", EE: "372", EG: "20", EH: "212",
  ER: "291", ES: "34", ET: "251", FI: "358", FJ: "679", FK: "500", FM: "691",
  FO: "298", FR: "33", GA: "241", GB: "44", GD: "1", GE: "995", GF: "594",
  GG: "44", GH: "233", GI: "350", GL: "299", GM: "220", GN: "224", GP: "590",
  GQ: "240", GR: "30", GT: "502", GU: "1", GW: "245", GY: "592", HK: "852",
  HN: "504", HR: "385", HT: "509", HU: "36", ID: "62", IE: "353", IL: "972",
  IM: "44", IN: "91", IO: "246", IQ: "964", IR: "98", IS: "354", IT: "39",
  JE: "44", JM: "1", JO: "962", JP: "81", KE: "254", KG: "996", KH: "855",
  KI: "686", KM: "269", KN: "1", KP: "850", KR: "82", KW: "965", KY: "1",
  KZ: "7", LA: "856", LB: "961", LC: "1", LI: "423", LK: "94", LR: "231",
  LS: "266", LT: "370", LU: "352", LV: "371", LY: "218", MA: "212", MC: "377",
  MD: "373", ME: "382", MF: "590", MG: "261", MH: "692", MK: "389", ML: "223",
  MM: "95", MN: "976", MO: "853", MP: "1", MQ: "596", MR: "222", MS: "1",
  MT: "356", MU: "230", MV: "960", MW: "265", MX: "52", MY: "60", MZ: "258",
  NA: "264", NC: "687", NE: "227", NF: "672", NG: "234", NI: "505", NL: "31",
  NO: "47", NP: "977", NR: "674", NU: "683", NZ: "64", OM: "968", PA: "507",
  PE: "51", PF: "689", PG: "675", PH: "63", PK: "92", PL: "48", PM: "508",
  PR: "1", PS: "970", PT: "351", PW: "680", PY: "595", QA: "974", RE: "262",
  RO: "40", RS: "381", RU: "7", RW: "250", SA: "966", SB: "677", SC: "248",
  SD: "249", SE: "46", SG: "65", SH: "290", SI: "386", SJ: "47", SK: "421",
  SL: "232", SM: "378", SN: "221", SO: "252", SR: "597", SS: "211", ST: "239",
  SV: "503", SX: "1", SY: "963", SZ: "268", TC: "1", TD: "235", TG: "228",
  TH: "66", TJ: "992", TK: "690", TL: "670", TM: "993", TN: "216", TO: "676",
  TR: "90", TT: "1", TV: "688", TW: "886", TZ: "255", UA: "380", UG: "256",
  US: "1", UY: "598", UZ: "998", VA: "39", VC: "1", VE: "58", VG: "1",
  VI: "1", VN: "84", VU: "678", WF: "681", WS: "685", XK: "383", YE: "967",
  YT: "262", ZA: "27", ZM: "260", ZW: "263",
};

/**
 * The digits a region's own subscribers dial before a national number, which
 * are NOT part of the number and must come off before the calling code goes on.
 *
 * `"0"` is the overwhelming default and is assumed for any region not listed.
 * Only the exceptions are here, and they fall in three groups:
 *
 *  - **`null` — no trunk prefix at all.** The national number is dialled as-is,
 *    so nothing may be stripped. The NANP is the big one (a US number is ten
 *    digits, and a leading `0` would be an operator call, not a subscriber);
 *    Spain, Portugal, Norway, Denmark and Iceland closed their numbering plans
 *    the same way.
 *  - **Italy and its enclaves.** Italy abolished the trunk prefix in 1998 but
 *    kept the leading `0` as part of the landline number: `06 …` in Rome is
 *    `+39 06 …`, not `+39 6 …`. Stripping it produces a number that fails to
 *    connect, so `null` is exactly right here too — and it is the case a blanket
 *    "strip the leading zero" rule gets wrong.
 *  - **`"8"` — the post-Soviet plan.** Russia, Belarus, Kazakhstan and their
 *    neighbours dial `8` for a trunk call, so `8 (495) …` is `+7 495 …`.
 *
 * When a value already carries a `+`, none of this applies: an explicitly
 * international number is taken at its word.
 */
export const TRUNK_PREFIXES: Readonly<Record<string, string | null>> = {
  // NANP — ten significant digits, no trunk prefix.
  AG: null, AI: null, AS: null, BB: null, BM: null, BS: null, CA: null,
  DM: null, DO: null, GD: null, GU: null, JM: null, KN: null, KY: null,
  LC: null, MP: null, MS: null, PR: null, SX: null, TC: null, TT: null,
  US: null, VC: null, VG: null, VI: null,
  // Closed plans with no trunk prefix.
  DK: null, ES: null, IS: null, NO: null, PT: null, SJ: null,
  // Italy keeps the leading 0 as part of the number; so do the enclaves that
  // sit inside its plan.
  IT: null, SM: null, VA: null,
  // Trunk code 8.
  BY: "8", KZ: "8", RU: "8", TM: "8", UZ: "8",
  // Hungary dials 06 for a trunk call.
  HU: "06",
};

/**
 * The regions whose numbers legitimately BEGIN with a zero.
 *
 * Both this and the `null` entries above answer "do not strip the leading 0",
 * but for opposite reasons, and the difference is load-bearing. Italy has no
 * trunk prefix *because* the 0 became part of the number, so `06…` is a real
 * Rome landline. The NANP and the closed European plans have no trunk prefix
 * because their numbers never start with 0 at all — an area code beginning 0 or
 * 1 does not exist, and neither does a Spanish or Norwegian subscriber number.
 *
 * Which means a national number starting with 0 in one of THOSE regions is not a
 * number, and saying so is a check the bundled table already contains the facts
 * for. Without it, `0532 999 88 77` read as American produces `+105329998877` —
 * twelve digits, a leading `1`, passes {@link E164_RE}, dials nothing. Found on
 * a real screen, not in a test.
 */
const LEADING_ZERO_IS_PART_OF_NUMBER: ReadonlySet<string> = new Set(["IT", "SM", "VA"]);

/** The trunk prefix to strip for a region — `"0"` unless listed otherwise. */
export const trunkPrefixFor = (region: string): string | null => {
  const key = region.trim().toUpperCase();
  return key in TRUNK_PREFIXES ? (TRUNK_PREFIXES[key] ?? null) : "0";
};

/** Calling code for an ISO alpha-2 region, or null when it is not a region. */
export const callingCodeFor = (region: string): string | null =>
  CALLING_CODES[region.trim().toUpperCase()] ?? null;

/** Every calling code in the table, longest first — the order a prefix match
 *  has to try them in, so `+1` never shadows `+1` … and `+35` never shadows
 *  `+350`. Built once. */
const CODES_LONGEST_FIRST: readonly string[] = [
  ...new Set(Object.values(CALLING_CODES)),
].sort((a, b) => b.length - a.length);

/**
 * Split a canonical E.164 string into its calling code and the rest.
 *
 * Returns null when no known calling code prefixes it — which happens for a
 * number in a country the table does not carry, and is not an error: the value
 * is still valid E.164 and is still stored. Only the display split is lost.
 */
export const splitCallingCode = (
  e164: string,
): { code: string; national: string } | null => {
  if (!E164_RE.test(e164)) return null;
  const digits = e164.slice(1);
  for (const code of CODES_LONGEST_FIRST) {
    if (digits.startsWith(code) && digits.length > code.length) {
      return { code, national: digits.slice(code.length) };
    }
  }
  return null;
};

/** How a stored E.164 value is rendered for a human. */
export type PhoneDisplay = "e164" | "spaced";

/**
 * Render a stored value for display.
 *
 * `e164` (the default) hands back exactly what is stored. `spaced` puts one
 * space after the calling code — the only grouping the bundled table can
 * actually justify. There is deliberately no national format; see the module
 * note. A value that is not canonical E.164 (an adopted column holding
 * something else) is returned untouched rather than mangled.
 */
export const formatPhone = (value: unknown, display: PhoneDisplay = "e164"): string => {
  if (typeof value !== "string" || !value) return "";
  if (display === "e164") return value;
  const split = splitCallingCode(value);
  return split ? `+${split.code} ${split.national}` : value;
};

/**
 * The longest input worth even looking at.
 *
 * Fifteen digits is E.164's ceiling; the rest is room for the way people write
 * them — `+90 (532) 111-22-33` is nineteen characters, and doubling that is
 * generous. The bound is here rather than being left to the digit count for a
 * security reason: {@link EXTENSION_RE} ends `\s*\d+\s*$` behind an alternation
 * that can start at every whitespace character, so a megabyte of spaces POSTed
 * to a phone field would make the engine backtrack quadratically. Nothing
 * upstream caps the length of a JSON string, so the cap belongs at the door.
 */
const MAX_INPUT_LENGTH = 40;

/** Characters a human puts in a phone number that carry no information. */
const PUNCTUATION_RE = /[\s\-(). ‐-―−/\\]/g;

/**
 * An extension, in the forms people actually write. Matched only so it can be
 * REFUSED with a message that says why — see {@link parsePhone}.
 */
const EXTENSION_RE = /(?:^|[\s,;])(?:ext?|x|int|dahili|durchwahl|poste)\.?\s*\d+\s*$/i;

/** Turn the common international-access prefixes into a `+`. `00` is the ITU
 *  standard and near-universal; `011` is the NANP's. Both are unambiguous at
 *  the START of a number and nowhere else. */
const stripIddPrefix = (digits: string, region: string | null): string | null => {
  if (digits.startsWith("00")) return digits.slice(2);
  // `011` is only an IDD prefix to someone dialling FROM the NANP. Elsewhere
  // `011…` is a perfectly ordinary national number (an Algiers landline, for
  // one), so this must not be applied globally.
  if (region && trunkPrefixFor(region) === null && callingCodeFor(region) === "1") {
    if (digits.startsWith("011")) return digits.slice(3);
  }
  return null;
};

/** What {@link parsePhone} produces. */
export interface ParsedPhone {
  /** Canonical E.164, `+` included. This is what the column holds. */
  e164: string;
  /** The calling code it starts with, when the bundled table recognises one. */
  callingCode: string | null;
  /** True when the input was already exactly `e164` — nothing was changed. */
  canonical: boolean;
}

/**
 * Canonicalize whatever a human typed into E.164.
 *
 * The rules, in the order they apply:
 *
 *  1. Punctuation, spaces and dashes come off. An **extension is refused**, not
 *     dropped: E.164 has no room for one, and silently discarding it changes who
 *     the number reaches. Store the extension in its own column.
 *  2. A leading `+`, or an international access prefix (`00`, and `011` when the
 *     default region dials it), means the caller has stated the country. The
 *     digits are taken verbatim and `region` is not consulted at all.
 *  3. Otherwise the number is national, and needs a region to mean anything. Its
 *     trunk prefix ({@link trunkPrefixFor}) comes off and the region's calling
 *     code goes on.
 *  4. The result must satisfy {@link E164_RE}, and its calling code must be one
 *     the table knows — a number starting `+0` or `+99999` is a typo, not a
 *     country.
 *
 * @param raw the value as supplied — a string, or a number from a CSV/JSON
 *   import (where a spreadsheet has already eaten the leading `+`, which is why
 *   a bare numeric national value still parses given a region).
 * @param region default ISO alpha-2 region for a national-form number. Only
 *   consulted in case 3 above.
 * @throws Error with a message naming what was wrong, never quoting the value —
 *   these messages reach activity rows and logs, and the value is a real
 *   person's phone number.
 */
export const parsePhone = (raw: unknown, region?: string | null): ParsedPhone => {
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || !Number.isInteger(raw) || raw <= 0) {
      throw new Error("must be a phone number");
    }
    return parsePhone(String(raw), region);
  }
  if (typeof raw !== "string") {
    throw new Error("must be a phone number");
  }
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("must be a phone number");
  // Checked BEFORE any regex touches the value — see MAX_INPUT_LENGTH.
  if (trimmed.length > MAX_INPUT_LENGTH) {
    throw new Error("is too long to be a phone number");
  }

  if (EXTENSION_RE.test(trimmed)) {
    throw new Error(
      "has an extension — E.164 cannot carry one. Store the extension in its own field",
    );
  }

  const plus = trimmed.startsWith("+");
  const body = plus ? trimmed.slice(1) : trimmed;
  const digits = body.replace(PUNCTUATION_RE, "");
  if (!digits) throw new Error("must be a phone number");
  if (!/^\d+$/.test(digits)) {
    throw new Error("must contain only digits, spaces and () - . separators");
  }

  const regionKey = region ? region.trim().toUpperCase() : null;
  if (regionKey && !callingCodeFor(regionKey)) {
    // An unknown default region is an admin-configuration mistake, and saying so
    // is far more useful than reporting the operator's number as malformed.
    throw new Error(`default region "${regionKey}" is not a known country code`);
  }

  let international: string | null = plus ? digits : stripIddPrefix(digits, regionKey);

  if (international === null) {
    // A national number. Without a region there is nothing to prepend, and
    // guessing one would silently route a number to the wrong country.
    if (!regionKey) {
      throw new Error(
        "is a national number and this field has no default region — write it as +<country code>… or set a region on the field",
      );
    }
    const code = callingCodeFor(regionKey)!;
    const trunk = trunkPrefixFor(regionKey);
    let national = digits;
    if (
      trunk === null &&
      national.startsWith("0") &&
      !LEADING_ZERO_IS_PART_OF_NUMBER.has(regionKey)
    ) {
      // Almost always the symptom of the wrong region rather than a typo — a
      // number written for a country that DOES use a trunk prefix, read as one
      // that does not. Say which country was assumed, since that is the part the
      // operator has to change.
      throw new Error(
        `is not a ${regionKey} number — numbers there do not start with 0. Pick the right country, or write it as +<country code>…`,
      );
    }
    if (trunk && national.startsWith(trunk) && national.length > trunk.length) {
      national = national.slice(trunk.length);
    } else if (national.startsWith(code) && national.length > code.length) {
      // A national field that already carries its own country code, written
      // without the `+` — the shape a spreadsheet export produces. Taking it as
      // national would prepend the code a second time.
      national = national.slice(code.length);
    }
    international = code + national;
  }

  const e164 = `+${international}`;
  if (!E164_RE.test(e164)) {
    throw new Error(
      international.length > E164_MAX_DIGITS
        ? `has ${international.length} digits — E.164 allows at most ${E164_MAX_DIGITS}`
        : "is not a valid phone number",
    );
  }
  const split = splitCallingCode(e164);
  if (!split) {
    throw new Error("does not start with a known country calling code");
  }
  return { e164, callingCode: split.code, canonical: e164 === trimmed };
};

/**
 * The half of {@link parsePhone} that needs no region: is this value even
 * phone-SHAPED — digits and separators, no extension, few enough digits to be a
 * number at all.
 *
 * Exists because a field whose region lives in a sibling column cannot be fully
 * parsed by anything that sees only the field (`validateValue`). Rejecting the
 * junk that is junk in every country is still worth doing there; the
 * region-dependent half happens on the write path, which has the row.
 *
 * @throws Error with a message naming what was wrong, never quoting the value.
 */
export const assertPhoneShaped = (raw: unknown): void => {
  const s =
    typeof raw === "number" && Number.isInteger(raw) && raw > 0
      ? String(raw)
      : typeof raw === "string"
        ? raw.trim()
        : null;
  if (s === null || !s) throw new Error("must be a phone number");
  // Same guard, same reason — this is the path `validateValue` takes for a
  // field whose region lives in a sibling column, so it is just as reachable
  // from an unauthenticated-shaped write as the one in `parsePhone`.
  if (s.length > MAX_INPUT_LENGTH) {
    throw new Error("is too long to be a phone number");
  }
  if (EXTENSION_RE.test(s)) {
    throw new Error(
      "has an extension — E.164 cannot carry one. Store the extension in its own field",
    );
  }
  const digits = (s.startsWith("+") ? s.slice(1) : s).replace(PUNCTUATION_RE, "");
  if (!digits || !/^\d+$/.test(digits)) {
    throw new Error("must contain only digits, spaces and () - . separators");
  }
  // An upper bound is safe to apply without a region — no country's number is
  // longer than E.164 allows, even before a calling code goes on. A LOWER bound
  // is not: a national number is legitimately shorter than the canonical form it
  // becomes, so checking it here would reject the very values this branch exists
  // to let through.
  if (digits.length > E164_MAX_DIGITS) {
    throw new Error(
      `has ${digits.length} digits — E.164 allows at most ${E164_MAX_DIGITS}`,
    );
  }
};

/** {@link parsePhone} without the throw — `null` when the value isn't one. */
export const tryParsePhone = (raw: unknown, region?: string | null): ParsedPhone | null => {
  if (raw === null || raw === undefined || raw === "") return null;
  try {
    return parsePhone(raw, region);
  } catch {
    return null;
  }
};

/**
 * A phone field's configuration.
 *
 * Every member is optional: a bare `phone` field accepts anything written in
 * international form and refuses a national one, which is the safe default —
 * there is no region it could assume without risking silently dialling another
 * country.
 */
export interface PhoneSpec {
  /**
   * ISO 3166-1 alpha-2 region a national-form number is interpreted in, e.g.
   * `"TR"`. Without it, only `+…` / `00…` values are accepted.
   */
  region?: string;
  /**
   * A sibling text field holding this row's region code, for a collection whose
   * contacts are in different countries — the same shape `money.currencyField`
   * takes. Read on WRITE only: unlike an amount, a stored E.164 number carries
   * its own country code, so nothing on the read path needs the row.
   *
   * Falls back to {@link region} when the row's value is empty or unknown.
   */
  regionField?: string;
  /**
   * Restrict stored numbers to these regions' calling codes. A number outside
   * them is refused at write time. Use for a workspace that only operates in one
   * country and would rather catch a mistyped country code than send an SMS
   * abroad.
   */
  allowedRegions?: string[];
  /** How the admin and CSV export render the stored value. Default `e164`. */
  display?: PhoneDisplay;
}

/**
 * Reject a malformed {@link PhoneSpec} at schema-save time.
 *
 * `fieldNames` is the collection's other field names; naming a region column
 * that does not exist is the mistake worth catching here, because its only other
 * symptom is a per-row region that silently never applies.
 *
 * @throws Error naming the problem.
 */
export const validatePhoneSpec = (
  spec: PhoneSpec,
  fieldNames: readonly string[],
): void => {
  if (spec.region !== undefined) {
    if (typeof spec.region !== "string" || !callingCodeFor(spec.region)) {
      throw new Error(`\`region\` must be an ISO 3166-1 alpha-2 country code (got "${spec.region}")`);
    }
  }
  if (spec.regionField !== undefined) {
    if (typeof spec.regionField !== "string" || !spec.regionField) {
      throw new Error("`regionField` must be a field name");
    }
    const known = new Set(fieldNames);
    if (known.size > 0 && !known.has(spec.regionField)) {
      throw new Error(`\`regionField\` names an unknown field: ${spec.regionField}`);
    }
  }
  if (spec.allowedRegions !== undefined) {
    if (!Array.isArray(spec.allowedRegions) || spec.allowedRegions.length === 0) {
      throw new Error("`allowedRegions` must be a non-empty array of country codes");
    }
    for (const r of spec.allowedRegions) {
      if (typeof r !== "string" || !callingCodeFor(r)) {
        throw new Error(`\`allowedRegions\` contains an unknown country code: ${String(r)}`);
      }
    }
  }
  if (spec.display !== undefined && spec.display !== "e164" && spec.display !== "spaced") {
    throw new Error('`display` must be "e164" or "spaced"');
  }
};

/**
 * The calling codes an {@link PhoneSpec.allowedRegions} list permits.
 *
 * Returns null when the field does not restrict. Note that several regions share
 * a code, so allowing `US` also allows every other NANP territory — E.164 does
 * not distinguish them, and pretending otherwise would reject valid numbers.
 */
export const allowedCallingCodes = (spec: PhoneSpec | undefined): Set<string> | null => {
  if (!spec?.allowedRegions?.length) return null;
  const out = new Set<string>();
  for (const r of spec.allowedRegions) {
    const code = callingCodeFor(r);
    if (code) out.add(code);
  }
  return out.size ? out : null;
};

/**
 * Parse a value for a phone field, honouring the field's region and its
 * allow-list. `rowRegion` is the value of {@link PhoneSpec.regionField} on the
 * row being written, when the field names one.
 *
 * @throws Error with a message naming what was wrong (never the value).
 */
export const parsePhoneForField = (
  raw: unknown,
  spec: PhoneSpec | undefined,
  rowRegion?: unknown,
): ParsedPhone => {
  const perRow =
    typeof rowRegion === "string" && callingCodeFor(rowRegion) ? rowRegion : null;
  const parsed = parsePhone(raw, perRow ?? spec?.region ?? null);
  const allowed = allowedCallingCodes(spec);
  if (allowed && (parsed.callingCode === null || !allowed.has(parsed.callingCode))) {
    // Name the codes, not the number: this message is surfaced to the operator
    // and persisted in activity rows.
    throw new Error(
      `is not in an allowed country (+${[...allowed].sort().join(", +")})`,
    );
  }
  return parsed;
};
