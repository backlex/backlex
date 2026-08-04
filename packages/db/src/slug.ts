/**
 * Slugs — the URL handle a row is addressed by, folded from the text a person
 * actually typed.
 *
 * Everything in this module is PURE: the spec, its validation, and the fold
 * itself. Nothing here imports anything, which is why `@backlex/db/slug` is its
 * own package export — reaching it through the package root would drag the
 * migration bundles, and their `*.sql` imports, into the browser build. The
 * admin previews a slug with the SAME function the server stores, so the hint
 * under the box is not a second implementation that can drift from it.
 *
 * ## The shape of the problem
 *
 * Twenty-four `text` columns across twenty-four collections in eleven of the
 * twenty-seven schema templates are slugs: posts, pages, categories, tags,
 * authors, brands, products, collections, courses, jobs, listings, vendors,
 * properties, events, campaigns, accounts, forms and KB articles. Every one of
 * them is `unique: true`, every one is validated by the same hand-written
 * regex, and every one is `required: false`.
 *
 * Nothing generated them.
 *
 *  - **Server-side: nothing at all.** Five separate slugifiers exist in this
 *    repo — for tenants, app organizations, SAML providers (twice) and agent
 *    handles — and not one of them touches a user collection. A row created
 *    through REST, the SDK, GraphQL, a CSV import, a flow or a restore got
 *    whatever the caller typed, or nothing.
 *  - **In the admin: a client-only derivation gated on a sibling field named
 *    literally `title`.** Thirteen of the twenty-four collections name that
 *    field `name` instead — every category, brand, tag, vendor, author and
 *    account — so for those the auto-fill silently never ran and the operator
 *    hand-typed a URL.
 *  - **The slug input produced values its own column rejects.** Its keystroke
 *    handler folded to `[^a-z0-9-]` without trimming, so a leading space, a
 *    trailing space or a trailing `&` left a leading/trailing hyphen — which
 *    the column's own regex refuses. Typing in the box the product supplied
 *    earned a 422 naming the field you were typing into.
 *  - **Non-ASCII text was destroyed rather than folded.** `Ürün Kataloğu`
 *    became `r-n-katalo-u` on the path that ran, while a different slugifier
 *    ten files away would have produced `urun-katalogu` from the same string.
 *    Non-Latin scripts folded to the empty string, which then failed the regex,
 *    so a Russian or Chinese title could not be saved at all.
 *  - **`unique: true` with nothing deduplicating.** A second row titled
 *    "Summer Sale" collided at the database.
 *
 * ## Why this is a spec on a text field, not a new field type
 *
 * A slug is stored as TEXT and stays TEXT, so — as with `sequence`, which is
 * also a server-issued value in an ordinary text column — making it a
 * {@link FieldType} would buy nothing and would cost a new entry in every
 * exhaustive `Record<FieldType>` in the codebase, the shape of bug that once
 * took the whole GraphQL endpoint down. All twenty-four template columns adopt
 * it as metadata, with no migration and no DDL.
 *
 * `email` and `phone` did become types, and the difference is worth stating so
 * the next one is not decided by coin flip: those two needed their canonical
 * form applied to FILTER OPERANDS as well as to stored values, because a person
 * searching for `Foo@Bar.com` means the row stored as `foo@bar.com`. A slug is
 * lowercase ASCII by construction and nobody searches for one in another form —
 * so the only thing a type would have bought does not arise.
 *
 * ## What is folded, and what is refused
 *
 * The fold is Unicode NFKD plus a fourteen-character map, and it stops there.
 *
 * NFKD decomposes a letter into its base plus combining marks, which are then
 * dropped: `é`→`e`, `ü`→`u`, `ğ`→`g`, `ş`→`s`, `ç`→`c`. That is an ALGORITHM
 * over a closed, standardised dataset, and it is exactly reversible in the
 * sense that matters — it never invents a letter.
 *
 * Fourteen Latin letters have no combining decomposition and so survive NFKD
 * unchanged: `ı đ ħ ŀ ł ŉ ø ŧ ß æ œ þ ð ŋ`. Their ASCII fallbacks are fixed by
 * orthographic convention rather than by an algorithm, but the SET is closed —
 * it is a finite list of letters that cannot grow — and two of them are
 * codified in Unicode's own case mappings (`ß`→`SS`). So they are bundled.
 * `ı` alone justifies the map: it is the dotless i, and Turkish text is full of
 * it.
 *
 * Everything else is REFUSED. Cyrillic, Greek, Arabic, Hebrew, Devanagari and
 * CJK are not transliterated, because romanisation is a property of the
 * LANGUAGE and not of the character, and the competing standards disagree —
 * Cyrillic alone has BGN/PCGN, ISO 9 and ALA-LC, which romanise the same name
 * three ways. Guessing would print a URL that looks right and is not. This is
 * the same line phone drew at national number formats and geo drew at
 * geocoders: bundle the dataset that is closed, refuse the one that is not.
 *
 * When the fold yields nothing, the slug is left UNSET rather than invented.
 * A generated token like `post-a3f9` is a working URL, but it is also a
 * permanent, unreadable one that nobody asked for, and the operator is right
 * there and can type a better one. See {@link slugify}.
 *
 * @module
 */

/**
 * Declares that a `text` column is a URL slug.
 *
 * Lives on the slug field itself. The column stays ordinary text — sortable,
 * filterable, indexable as itself — and what the declaration buys is that the
 * server maintains it: a create that omits the field folds one out of the row's
 * own title, any value that IS supplied is folded to the one canonical form
 * instead of being rejected by a regex, and a collision picks the next free
 * suffix rather than failing at the database.
 */
export interface SlugSpec {
  /**
   * The sibling columns a missing slug is folded from, in order — the first one
   * holding non-empty text wins. `["title"]` for a post, `["name"]` for a
   * category. Listing several is for collections where the readable field is
   * genuinely optional (`["display_name", "legal_name"]`), not for combining
   * them: a slug folded from two fields joined together is nobody's URL.
   *
   * Omit it and the field is simply a validated, folded slug the operator
   * types — generation is opt-in, and silently deriving a public URL from a
   * column the schema never nominated is worse than leaving the box empty.
   */
  from?: string[];
  /**
   * Longest slug to produce, in characters. Defaults to {@link SLUG_MAX_DEFAULT}.
   *
   * Applies to what this module GENERATES, including a collision suffix — the
   * base is truncated to make room for the suffix rather than the suffix being
   * dropped, because a slug that exceeds the cap and a slug that is not unique
   * are both broken, and only one of them is recoverable.
   */
  maxLength?: number;
}

/** Default cap for a generated slug. Long enough for a real headline, short
 *  enough to stay readable in a URL bar and well inside every index limit. */
export const SLUG_MAX_DEFAULT = 80;

/** Hard ceiling on `maxLength`. Past this a slug is not a handle any more, and
 *  MySQL's 191-char indexed-varchar limit is the practical wall for anyone
 *  migrating in. */
export const SLUG_MAX_LIMIT = 180;

/**
 * The one shape a slug may have: lowercase ASCII alphanumerics in groups
 * separated by single hyphens, with no leading, trailing or doubled hyphen.
 *
 * This is character-for-character the regex all twenty-four template columns
 * already carried in `validation.regex`. It is exported so the templates, the
 * validator and the admin all point at ONE copy instead of re-typing it, which
 * is how the seven implementations this feature replaces came to disagree.
 */
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** True when this field is a slug. */
export const isSlug = (field: { slug?: SlugSpec }): boolean => Boolean(field.slug);

/**
 * Latin letters that survive NFKD unchanged, and the ASCII they conventionally
 * stand in for.
 *
 * Closed by construction: these are the letters whose Unicode decomposition is
 * themselves, so no future normalisation makes this list shorter and no new
 * letter joins it. Uppercase forms are absent on purpose — the fold lowercases
 * before it reaches this map, so `Ø` and `ø` take the same entry and the two
 * cannot drift apart.
 */
const LATIN_FALLBACKS: Readonly<Record<string, string>> = {
  ı: "i",
  đ: "d",
  ħ: "h",
  ŀ: "l",
  ł: "l",
  ŉ: "n",
  ø: "o",
  ŧ: "t",
  ß: "ss",
  æ: "ae",
  œ: "oe",
  þ: "th",
  ð: "d",
  ŋ: "n",
};

/**
 * How much of an input {@link slugify} will look at.
 *
 * A guard on write-path CPU, not a limit anyone can reach on purpose: the
 * result is capped at {@link SLUG_MAX_LIMIT} regardless, so the only thing the
 * discarded tail could contribute is more punctuation to collapse. Generous
 * enough that a real headline — even a pathological one — is never truncated
 * before it is folded.
 */
const SCAN_LIMIT = 4096;

/** Unicode combining marks, dropped after NFKD has split them off their base. */
const COMBINING_RE = /[̀-ͯ]/g;

/**
 * Fold arbitrary text into the canonical slug form.
 *
 * Total and deterministic: every input produces a valid slug or the empty
 * string, and the same input always produces the same output. The empty string
 * is the honest answer for text this module cannot read — see the module note
 * on why a generated token is not offered instead.
 *
 * The order of operations is load-bearing and was a real disagreement between
 * the implementations this replaces: NFKD runs BEFORE the ASCII filter, or the
 * accented letters are stripped as "not `[a-z0-9]`" rather than folded, which
 * is how `Café Münch` became `caf-m-nch`.
 *
 * @param input text to fold — a title, a name, or a slug somebody typed
 * @param maxLength cap on the result; defaults to {@link SLUG_MAX_DEFAULT}
 */
export const slugify = (input: unknown, maxLength: number = SLUG_MAX_DEFAULT): string => {
  if (typeof input !== "string" || input === "") return "";
  const cap = Number.isFinite(maxLength) && maxLength > 0 ? Math.floor(maxLength) : SLUG_MAX_DEFAULT;
  // Cap the INPUT before any of the work below, not just the output.
  //
  // Every step here — NFKD, the per-character fallback pass, the two regex
  // replaces — is linear in the length of what it is handed, and this runs on
  // the write path for a value a client controls. Folding a five-megabyte
  // `longtext` costs a quarter of a second of CPU to produce eighty
  // characters. `SCAN_LIMIT` is far past any real title and makes the cost
  // constant; nothing legitimate reaches it, because the answer is capped at
  // {@link SLUG_MAX_LIMIT} either way. Same lesson as the phone extension
  // pattern: bound the input before the expensive part, not after.
  const raw = input.length > SCAN_LIMIT ? input.slice(0, SCAN_LIMIT) : input;
  // Lowercase first so the fallback map needs only lowercase keys. JS
  // `toLowerCase` is locale-independent, which is what a URL wants: Turkish
  // locale rules would send `I` to `ı` and straight back through the map to
  // `i`, but only on a Turkish-locale runtime — a slug that depended on the
  // server's locale would differ between two deploys of the same code.
  let s = raw.toLowerCase();
  s = s.normalize("NFKD").replace(COMBINING_RE, "");
  // The fallback map runs AFTER NFKD: `ǿ` decomposes to `ø` + acute, and only
  // then is it a key here. Running it first would miss exactly the composed
  // forms that need it most.
  let out = "";
  for (const ch of s) out += LATIN_FALLBACKS[ch] ?? ch;
  // Anything still not ASCII alphanumeric becomes a separator. Runs collapse,
  // which is what turns "C++ & C#" into "c-c" rather than "c-----c".
  out = out.replace(/[^a-z0-9]+/g, "-");
  // Trim BEFORE the cap and again after it: the first trim removes the hyphens
  // punctuation left at the ends, the second removes the one the cap can create
  // by slicing mid-word. Skipping the second is how a truncated slug ends in a
  // hyphen and fails the very regex this function exists to satisfy.
  out = out.replace(/^-+|-+$/g, "");
  if (out.length > cap) out = out.slice(0, cap).replace(/-+$/g, "");
  return out;
};

/**
 * Reject a malformed {@link SlugSpec} at schema-save time.
 *
 * `fieldTypes` is the collection's OTHER fields by name. Naming a source column
 * that does not exist is the mistake worth catching here, because its only
 * other symptom is a slug that is silently never generated — which looks
 * exactly like a slug the operator forgot to type.
 *
 * @throws Error naming the problem.
 */
export const validateSlugSpec = (
  spec: SlugSpec,
  ctx: {
    fieldName: string;
    fieldTypes: Record<string, string>;
    /** Which of the other fields are `private` — never returned by any read
     *  surface. A slug is the opposite of private, so one may not be folded
     *  out of one. */
    privateFields?: Set<string>;
  },
): void => {
  if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
    throw new Error("`slug` must be an object");
  }
  if (spec.maxLength !== undefined) {
    if (
      typeof spec.maxLength !== "number" ||
      !Number.isInteger(spec.maxLength) ||
      spec.maxLength < 1 ||
      spec.maxLength > SLUG_MAX_LIMIT
    ) {
      throw new Error(`\`slug.maxLength\` must be a whole number from 1 to ${SLUG_MAX_LIMIT}`);
    }
  }
  if (spec.from === undefined) return;
  if (!Array.isArray(spec.from) || spec.from.length === 0) {
    throw new Error("`slug.from` must be a non-empty array of field names");
  }
  for (const src of spec.from) {
    if (typeof src !== "string" || !src) {
      throw new Error("`slug.from` entries must be field names");
    }
    if (src === ctx.fieldName) {
      throw new Error("`slug.from` cannot name the slug column itself");
    }
    const t = ctx.fieldTypes[src];
    if (t === undefined) {
      throw new Error(`\`slug.from\` names an unknown field: ${src}`);
    }
    // The source has to be text a person wrote. A number folds to itself and
    // makes `1` a URL; a timestamp folds to a machine string nobody recognises;
    // a relation folds to somebody else's primary key. All three produce a slug
    // that is technically valid and useless, which is worse than none.
    if (t !== "text" && t !== "longtext") {
      throw new Error(
        `\`slug.from\` must name a text or longtext field ("${src}" is ${t}) — a slug is folded from words somebody wrote`,
      );
    }
    // A `private` column is stored and writable but never returned by ANY read
    // surface — REST, CSV, the changefeed, GraphQL. A slug is the exact
    // opposite: a public URL, printed in listings and handed to anonymous
    // visitors. Folding one out of the other would publish, in readable form,
    // the very text a schema went out of its way to keep unreadable. Refused at
    // save time, where it is a typo, rather than after a thousand rows carry it.
    if (ctx.privateFields?.has(src)) {
      throw new Error(
        `\`slug.from\` cannot name the private field "${src}" — a slug is a public URL, and a private column is never returned by any read surface`,
      );
    }
  }
};

/**
 * The candidate slugs for `base`, in the order they should be tried:
 * `base`, `base-2`, `base-3`, … Bounded, because a caller that has already
 * lost this many races is looking at a schema problem rather than a collision.
 *
 * The suffix is appended within `maxLength` by truncating the BASE — see
 * {@link SlugSpec.maxLength} for why that trade goes this way. Re-trimmed after
 * the truncation for the same reason {@link slugify} trims twice.
 *
 * A base that already ends in `-2` is not special-cased: `top-10` is a real
 * title, and treating its digits as a suffix would rename a row nobody
 * duplicated.
 */
export const slugCandidates = (
  base: string,
  maxLength: number = SLUG_MAX_DEFAULT,
  limit = 50,
): string[] => {
  if (!base) return [];
  const cap = Number.isFinite(maxLength) && maxLength > 0 ? Math.floor(maxLength) : SLUG_MAX_DEFAULT;
  const out: string[] = [base.slice(0, cap).replace(/-+$/g, "")];
  for (let n = 2; n <= limit; n++) {
    const suffix = `-${n}`;
    const room = cap - suffix.length;
    if (room < 1) break;
    const stem = base.slice(0, room).replace(/-+$/g, "");
    if (!stem) break;
    out.push(`${stem}${suffix}`);
  }
  return out;
};

/**
 * Where a resolved slug came from — which decides whether a collision may be
 * worked around.
 *
 *  - `stated` — the caller wrote this slug (possibly in a form that needed
 *    folding). It is a decision, so a collision is reported, not routed around.
 *  - `derived` — the server folded it out of a source column because the field
 *    was empty. It is a blank being filled, so a collision takes the next free
 *    suffix.
 *  - `none` — nothing usable, from either place.
 *
 * The split matters: silently handing back `summer-sale-2` to a caller who
 * asked for `summer-sale` is the server overruling a choice, while doing it for
 * a slug nobody chose is the server finishing a job. It is the same line
 * `performCreate` already draws for a stated `position`.
 */
export type SlugSource = "stated" | "derived" | "none";

/** What {@link resolveSlug} decided, and on what basis. */
export interface ResolvedSlug {
  /** The folded slug, or `""` when nothing could be resolved. */
  value: string;
  source: SlugSource;
}

/**
 * Resolve the slug a row should carry, given what the caller supplied and what
 * the row holds.
 *
 * Pure — it does not know what is already taken, which is the database's
 * question. It answers only "what should this row be called".
 *
 * The single rule, and it is deliberately one rule rather than a mode setting:
 * **a slug is derived only when it is empty.** So a create with no slug folds
 * one from the title, an update that leaves it alone keeps it — a published URL
 * must not silently move because somebody fixed a typo in the headline, which
 * is the very breakage the `redirects` collections in the blog and ecommerce
 * templates exist to paper over — and an update that CLEARS it re-derives from
 * whatever the title now says. That last one makes "regenerate this slug" a
 * discoverable action with no new API: empty the box and save.
 *
 * @param supplied what the caller wrote to the slug field, if anything
 * @param row the row as it will be after the write, for reading `from` sources
 * @param spec the field's {@link SlugSpec}
 */
export const resolveSlug = (
  supplied: unknown,
  row: Record<string, unknown>,
  spec: SlugSpec,
): ResolvedSlug => {
  const cap = spec.maxLength ?? SLUG_MAX_DEFAULT;
  // A supplied value is FOLDED, not rejected. A regex can refuse `My Post!`;
  // it cannot turn it into `my-post`, and refusing it sends a 422 about
  // punctuation to somebody who typed a perfectly good title.
  const folded = slugify(supplied, cap);
  if (folded) return { value: folded, source: "stated" };
  // Nothing usable was supplied — fold the first source that has text in it.
  for (const src of spec.from ?? []) {
    const candidate = slugify(row[src], cap);
    if (candidate) return { value: candidate, source: "derived" };
  }
  return { value: "", source: "none" };
};
