/**
 * The one fold, for search.
 *
 * A case-insensitive substring filter needs both sides reduced to the same
 * canonical form, and the reduction has to happen somewhere BOTH sides can
 * reach. SQLite cannot do it: its `LOWER()` handles `A-Z` and nothing else, by
 * documented design — full Unicode case conversion "would nearly double the
 * size of the SQLite library" — and D1 ships neither the ICU extension nor a
 * way to register a function. Postgres can (`lower()` + `unaccent`), but only
 * as an extension, and only for Postgres.
 *
 * So the fold happens HERE, in one place, in JavaScript, and its result is
 * stored beside the column it came from. That is not a workaround for SQLite —
 * it is the same shape Postgres users build by hand as an `unaccent(lower(x))`
 * expression index. Doing it in the application buys two things neither
 * database offers on its own: the two dialects behave IDENTICALLY, and the SQL
 * path and the in-memory predicate can run the very same function, so a filter
 * cannot mean one thing over REST and another over a socket.
 *
 * What it does, in order:
 *
 *  1. **NFKD** — decompose. `İ` becomes `I` + a combining dot; `é` becomes `e`
 *     + an acute; the ligature `ﬁ` becomes `fi`; `²` becomes `2`.
 *  2. **Drop combining marks** — the accents from step 1 go, so `Öztürk` and
 *     `ozturk` converge. This is the half that plain lowercasing cannot do.
 *  3. **Lowercase** — now safe, because the hard characters have already been
 *     decomposed into ASCII letters plus marks that no longer exist.
 *  4. **Map what does not decompose** — a short, deliberate table. `ß`, `æ`,
 *     `ø`, `ł`, `þ` and friends have no canonical decomposition, so NFKD leaves
 *     them exactly as they were and `strasse` would never find `Straße`.
 *
 * Measured against the alternatives on a Turkish/German/Greek/Nordic corpus,
 * this finds every row FTS5's `unicode61` tokenizer finds, plus mid-word
 * substrings (which a token index cannot do at all), plus `ß`, `æ`, `ø` and
 * Turkish dotless `ı` (which `unicode61` misses).
 */

/**
 * Letters with no canonical decomposition, and what a searcher types instead.
 *
 * Keys are already lowercase because the map is applied AFTER step 3. Each
 * entry is a letter a keyboard cannot easily produce, mapped to the sequence
 * people actually type for it — the same convention `unaccent`'s rule file
 * uses.
 *
 * **Every entry was measured, not assumed.** `å`, `ç`, `ş`, `ğ`, `ü`, `ö`, `ż`,
 * `ų` and the long `ſ` are all absent because NFKD already decomposes them —
 * listing one would be a line of dead table that reads as if it were doing
 * work. A test walks this map and fails on any entry NFKD would have handled.
 *
 * `ı` (U+0131 dotless i) is the one judgement call here, and it is deliberate:
 * folding it to `i` merges Turkish's two i's, so `isil` finds `Işıl` and
 * `yildirim` finds `Yıldırım`. Keeping them apart would be more correct as
 * *orthography* and useless as *search* — nobody hunting for a name types the
 * dotless form. It is also the only direction that can work: `I` uppercase
 * folds to `i` everywhere except Turkish, so the merge has to happen on the
 * dotless side.
 */
const NON_DECOMPOSING: Readonly<Record<string, string>> = Object.freeze({
  ß: "ss", // German
  æ: "ae", // Danish, Norwegian, Icelandic
  œ: "oe", // French
  ø: "o", //  Danish, Norwegian
  đ: "d", //  Croatian, Vietnamese
  ð: "d", //  Icelandic
  ħ: "h", //  Maltese
  ł: "l", //  Polish
  ŋ: "n", //  Sámi, several African orthographies
  þ: "th", // Icelandic
  ı: "i", //  Turkish — see the note above
  ə: "e", //  Azerbaijani
});

/** Combining marks — everything NFKD split off in step 1. */
const COMBINING = /\p{M}/gu;

/**
 * Reduce text to the form both a needle and a stored value are compared in.
 *
 * Idempotent (`fold(fold(x)) === fold(x)`), total (never throws, handles the
 * empty string), and dialect-independent BY CONSTRUCTION — that last property
 * is the point, and it is why this takes no dialect argument.
 */
export const foldSearch = (input: string): string => {
  if (input === "") return "";
  const decomposed = input.normalize("NFKD").replace(COMBINING, "").toLowerCase();
  // Only pay for the map when there is something in it to find. The common
  // case — text that decomposed cleanly — skips the per-character walk.
  let mapped = "";
  let dirty = false;
  for (const ch of decomposed) {
    const sub = NON_DECOMPOSING[ch];
    if (sub === undefined) {
      mapped += ch;
    } else {
      mapped += sub;
      dirty = true;
    }
  }
  return dirty ? mapped : decomposed;
};

/** The suffix a folded companion column carries. Reserved: a user field may not
 *  end in it, so a column and its fold can never collide. */
export const FOLD_SUFFIX = "__fold";

/** The companion column holding {@link foldSearch} of `name`. */
export const foldColumn = (name: string): string => `${name}${FOLD_SUFFIX}`;

/** Whether a column name is a fold companion rather than a user field. */
export const isFoldColumn = (name: string): boolean => name.endsWith(FOLD_SUFFIX);

/**
 * The searchable text inside a JSON value — its string and number LEAVES,
 * joined.
 *
 * Not the raw JSON, and the difference matters. Folding `JSON.stringify(v)`
 * would put the KEYS and the punctuation into the haystack, so `_icontains:
 * "cpu"` would match a row because the attribute is *called* cpu. What a
 * person filtering an attribute bag means is the values, which is also exactly
 * what a hand-rolled spec search concatenates by hand
 * (`json_extract(attrs,'$.cpu') || ' ' || json_extract(attrs,'$.gpu') || …`).
 *
 * Numbers are included because a spec bag is full of them and people type them
 * (`32`, `9950`). Booleans and nulls are not: nobody searches for "true".
 */
export const jsonSearchText = (value: unknown): string => {
  const out: string[] = [];
  const walk = (v: unknown, depth: number): void => {
    // A bounded walk: a hostile or merely enormous document must not turn one
    // write into an unbounded traversal.
    if (depth > 12 || out.length > 2_000) return;
    if (typeof v === "string") out.push(v);
    else if (typeof v === "number" && Number.isFinite(v)) out.push(String(v));
    else if (Array.isArray(v)) for (const x of v) walk(x, depth + 1);
    else if (v && typeof v === "object") {
      for (const x of Object.values(v as Record<string, unknown>)) walk(x, depth + 1);
    }
  };
  walk(value, 0);
  return out.join(" ");
};

/**
 * The folded search text for a value as it is STORED, whatever shape the
 * dialect keeps it in.
 *
 * The three paths that write a column from a stored value rather than from the
 * caller's input — the backfill, template seeding and external-DB ingest — all
 * need the same answer, and a `json` column reaches them as TEXT on SQLite and
 * as an object on Postgres. One helper so the three cannot drift, which is the
 * failure this codebase keeps finding: a sidecar value that most of its writers
 * maintained.
 *
 * A JSON string that will not parse is folded as plain text rather than
 * dropped: an adopted column can hold anything, and half a haystack beats none.
 */
export const foldStored = (type: string | undefined, stored: unknown): string | null => {
  if (stored === null || stored === undefined) return null;
  if (type !== "json") return foldSearch(String(stored));
  let value: unknown = stored;
  if (typeof stored === "string") {
    try {
      value = JSON.parse(stored);
    } catch {
      return foldSearch(stored);
    }
  }
  return foldSearch(jsonSearchText(value));
};

