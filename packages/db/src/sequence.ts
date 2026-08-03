/**
 * Sequence fields — a document number the server issues, not the client.
 *
 * Everything in this module is PURE: the pattern grammar, the reset scope key,
 * and the rendering. Allocating the counter needs the database and lives in the
 * server's sequence service; keeping the two apart is what lets the admin
 * preview a pattern (and the validator reject a bad one) without a round trip.
 *
 * It also carries no imports, which is why `@backlex/db/sequence` is its own
 * package export: the admin's numbering preview pulls THIS renderer in so the
 * preview cannot drift from what the server will actually issue, and reaching
 * it through the package root would drag the migration bundles — and their
 * `*.sql` imports — into the browser build.
 *
 * ## The shape of the problem
 *
 * Seventeen of the twenty-seven schema templates declare a `required + unique`
 * document number — `INV-1001`, `Q-2026-042`, `PO-2001`, `GRN-4001`. Before
 * this, `onCreate` could mint a `uuid`, a timestamp, the user id or the tenant
 * id, and nothing else, so every one of those numbers had to be invented by the
 * caller. Two clients creating an invoice at the same moment both compute
 * "highest + 1", both get the same string, and one of them eats the UNIQUE
 * violation — which is the good outcome. The bad one is the collection without
 * the unique index, where both rows simply keep the same number.
 *
 * ## What a sequence guarantees, and what it does not
 *
 * Guaranteed: **unique** and **monotonic within a scope**. Two rows never share
 * a counter, and a later allocation always gets a higher one.
 *
 * NOT guaranteed: **contiguity**. The counter is bumped by its own statement,
 * outside whatever transaction the row write is in — exactly like a Postgres
 * `SEQUENCE`, and for the same reason. If the insert that requested a number
 * then fails validation, or an atomic batch rolls back, that number is spent and
 * the series has a hole. Making it gap-free would mean holding the counter row
 * locked for the duration of every insert, which serialises all writes to the
 * collection. Jurisdictions that legally require gapless invoice numbering need
 * a bookkeeping process, not a database default, so the honest thing is to
 * promise uniqueness and say plainly that gaps happen.
 *
 * @module
 */

/** How often the counter restarts. See {@link sequenceScopeKey}. */
export const SEQUENCE_RESETS = ["never", "yearly", "monthly", "daily"] as const;
export type SequenceReset = (typeof SEQUENCE_RESETS)[number];

/**
 * A server-issued document number on a `text` field.
 *
 * The value is written on INSERT and never again: client writes are rejected on
 * create (the server owns the value) and on update (a document number that can
 * be edited is not a document number).
 */
export interface SequenceSpec {
  /**
   * How the value is rendered. Literal text plus tokens in braces:
   *
   *  - `{YYYY}` / `{YY}` — 4- or 2-digit year
   *  - `{MM}` / `{DD}`   — 2-digit month / day of month
   *  - `{#}`, `{##}`, `{###}`, … — the counter, zero-padded to the number of
   *    `#` characters. A counter that outgrows its padding widens rather than
   *    truncating: `{###}` renders 1000 as `1000`, never `000`.
   *
   * `INV-{YYYY}-{####}` → `INV-2026-0001`. A literal brace is written `{{`/`}}`.
   */
  pattern: string;
  /** First counter value in a fresh scope. Default 1. */
  start?: number;
  /** When the counter restarts. Default `never`. */
  reset?: SequenceReset;
  /**
   * IANA zone the date tokens and the reset boundary are resolved in. Default
   * `UTC`.
   *
   * Deliberately part of the SPEC rather than read from the workspace's display
   * timezone: the year on an invoice number is a property of the series, and
   * changing what timezone the admin happens to view dates in must not silently
   * renumber next January's invoices. The admin editor pre-fills this with the
   * workspace timezone so the common case still needs no thought.
   */
  timezone?: string;
}

/** True when a field's value is issued by a sequence rather than written. */
export const isSequence = (field: { sequence?: SequenceSpec }): boolean =>
  Boolean(field.sequence);

// --- Pattern parsing --------------------------------------------------------

/** One piece of a parsed pattern. */
export type SequenceToken =
  | { kind: "literal"; text: string }
  | { kind: "date"; token: "YYYY" | "YY" | "MM" | "DD" }
  | { kind: "counter"; width: number };

const DATE_TOKENS = new Set(["YYYY", "YY", "MM", "DD"]);

/**
 * Split a pattern into literals, date tokens and the counter.
 *
 * Throws on anything it does not recognise rather than passing it through as
 * literal text. A typo like `{YYY}` silently rendering as the four characters
 * `{YYY}` would produce a whole year of wrong-but-unique invoice numbers before
 * anyone noticed, and by then they are on documents that have been sent.
 */
export const parseSequencePattern = (pattern: string): SequenceToken[] => {
  const out: SequenceToken[] = [];
  let literal = "";
  const pushLiteral = () => {
    if (literal) out.push({ kind: "literal", text: literal });
    literal = "";
  };
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i] as string;
    // `{{` / `}}` are escapes for a literal brace, so a pattern can contain one
    // without it reading as the start of a token.
    if ((ch === "{" || ch === "}") && pattern[i + 1] === ch) {
      literal += ch;
      i++;
      continue;
    }
    if (ch === "}") {
      throw new Error(`unmatched "}" at position ${i} (write "}}" for a literal brace)`);
    }
    if (ch !== "{") {
      literal += ch;
      continue;
    }
    const end = pattern.indexOf("}", i + 1);
    if (end === -1) {
      throw new Error(`unclosed "{" at position ${i}`);
    }
    const body = pattern.slice(i + 1, end);
    i = end;
    if (body === "") {
      throw new Error(`empty token "{}" at position ${i}`);
    }
    pushLiteral();
    if (/^#+$/.test(body)) {
      out.push({ kind: "counter", width: body.length });
      continue;
    }
    if (DATE_TOKENS.has(body)) {
      out.push({ kind: "date", token: body as "YYYY" | "YY" | "MM" | "DD" });
      continue;
    }
    throw new Error(
      `unknown token "{${body}}" — expected {YYYY}, {YY}, {MM}, {DD} or a run of "#" for the counter`,
    );
  }
  pushLiteral();
  return out;
};

/** The date tokens a pattern uses. */
const dateTokensOf = (tokens: SequenceToken[]): Set<string> =>
  new Set(tokens.filter((t) => t.kind === "date").map((t) => (t as { token: string }).token));

// --- Date parts in a zone ---------------------------------------------------

export interface SequenceDateParts {
  year: number;
  month: number;
  day: number;
}

/**
 * Calendar parts of `at` as seen in `timezone`.
 *
 * `Intl.DateTimeFormat` with an explicit `timeZone` is the only DST-correct way
 * to do this without shipping a tz database, and it is available on every
 * runtime this repo targets (Workers, Bun, Node). An invalid zone throws here
 * rather than silently falling back to UTC — a sequence quietly numbering by the
 * wrong calendar is the failure this whole function exists to prevent.
 */
export const sequenceDateParts = (at: Date, timezone: string): SequenceDateParts => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const get = (type: string): number => {
    const hit = parts.find((p) => p.type === type);
    return hit ? Number(hit.value) : Number.NaN;
  };
  const out = { year: get("year"), month: get("month"), day: get("day") };
  if (!Number.isFinite(out.year) || !Number.isFinite(out.month) || !Number.isFinite(out.day)) {
    throw new Error(`could not resolve the date in time zone "${timezone}"`);
  }
  return out;
};

const pad = (n: number, width: number): string => String(n).padStart(width, "0");

// --- Scope + rendering ------------------------------------------------------

/**
 * The counter bucket this write belongs to — the empty string for `never`, else
 * the calendar prefix at the reset granularity (`2026`, `2026-08`, `2026-08-03`).
 *
 * This string is part of the counter row's unique key, which is the whole
 * mechanism: a yearly sequence does not "detect" that the year turned over and
 * reset itself, it simply asks for a bucket that has never been allocated
 * before and gets `start` back. Nothing runs at midnight, so nothing can fail to
 * run at midnight.
 */
export const sequenceScopeKey = (spec: SequenceSpec, at: Date): string => {
  const reset = spec.reset ?? "never";
  if (reset === "never") return "";
  const { year, month, day } = sequenceDateParts(at, spec.timezone ?? "UTC");
  if (reset === "yearly") return pad(year, 4);
  if (reset === "monthly") return `${pad(year, 4)}-${pad(month, 2)}`;
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
};

/** Render one issued value: the pattern with its date tokens resolved against
 *  `at` and its counter token filled with `counter`. */
export const renderSequenceValue = (
  spec: SequenceSpec,
  counter: number,
  at: Date,
): string => {
  const tokens = parseSequencePattern(spec.pattern);
  const needsDate = tokens.some((t) => t.kind === "date");
  const parts = needsDate
    ? sequenceDateParts(at, spec.timezone ?? "UTC")
    : { year: 0, month: 0, day: 0 };
  let out = "";
  for (const t of tokens) {
    if (t.kind === "literal") out += t.text;
    else if (t.kind === "counter") out += pad(counter, t.width);
    else if (t.token === "YYYY") out += pad(parts.year, 4);
    else if (t.token === "YY") out += pad(parts.year % 100, 2);
    else if (t.token === "MM") out += pad(parts.month, 2);
    else out += pad(parts.day, 2);
  }
  return out;
};

/**
 * The first few values a spec would issue in a fresh scope — what the admin
 * editor shows under the pattern box so a mistake is visible before saving
 * rather than after the first invoice goes out.
 */
export const sequencePreview = (spec: SequenceSpec, at: Date, count = 3): string[] => {
  const start = spec.start ?? 1;
  return Array.from({ length: count }, (_, i) => renderSequenceValue(spec, start + i, at));
};

// --- Reading a value back ---------------------------------------------------

/** What a stored value decodes to: which counter it took, and which bucket that
 *  counter came out of. */
export interface ParsedSequenceValue {
  counter: number;
  scope: string;
}

const escapeLiteral = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A matcher for values this spec would produce, used to read a series that
 * already exists — an adopted table full of `INV-0499`s, or a column whose
 * counter row was lost.
 *
 * Round-tripping is only possible because the grammar is closed: every token
 * has a fixed width (or, for the counter, is the only greedy run of digits), so
 * a rendered value can be taken apart again. That is a good reason not to grow
 * the grammar carelessly — a free-form token would make this impossible and
 * with it the repair path.
 */
export const sequenceMatcher = (
  spec: SequenceSpec,
): ((value: unknown) => ParsedSequenceValue | null) => {
  const tokens = parseSequencePattern(spec.pattern);
  let src = "^";
  for (const t of tokens) {
    if (t.kind === "literal") src += escapeLiteral(t.text);
    else if (t.kind === "counter") src += "(?<n>\\d+)";
    else if (t.token === "YYYY") src += "(?<y4>\\d{4})";
    else if (t.token === "YY") src += "(?<y2>\\d{2})";
    else if (t.token === "MM") src += "(?<mo>\\d{2})";
    else src += "(?<dd>\\d{2})";
  }
  src += "$";
  const re = new RegExp(src);
  const reset = spec.reset ?? "never";

  return (value: unknown): ParsedSequenceValue | null => {
    if (typeof value !== "string") return null;
    const m = re.exec(value);
    const g = m?.groups;
    if (!g?.n) return null;
    const counter = Number(g.n);
    if (!Number.isFinite(counter)) return null;
    if (reset === "never") return { counter, scope: "" };
    // `{YY}` loses the century. Assuming 20xx is the only reading that makes
    // sense for a document series in use today, and it only affects which
    // bucket a REPAIR attributes an old value to.
    const year = g.y4 ? Number(g.y4) : g.y2 ? 2000 + Number(g.y2) : null;
    if (year === null) return null;
    if (reset === "yearly") return { counter, scope: pad(year, 4) };
    if (!g.mo) return null;
    if (reset === "monthly") return { counter, scope: `${pad(year, 4)}-${g.mo}` };
    if (!g.dd) return null;
    return { counter, scope: `${pad(year, 4)}-${g.mo}-${g.dd}` };
  };
};

/**
 * The highest counter already used, per bucket, across values that were
 * rendered by this spec. Values that do not match (a hand-typed number, a
 * pattern that has since changed) are counted as unreadable rather than
 * guessed at — the caller reports that number so a repair that covered less
 * than the operator assumed says so.
 */
export const highestUsedCounters = (
  spec: SequenceSpec,
  values: unknown[],
): { byScope: Map<string, number>; unreadable: number } => {
  const match = sequenceMatcher(spec);
  const byScope = new Map<string, number>();
  let unreadable = 0;
  for (const v of values) {
    if (v === null || v === undefined || v === "") continue;
    const hit = match(v);
    if (!hit) {
      unreadable += 1;
      continue;
    }
    const cur = byScope.get(hit.scope);
    if (cur === undefined || hit.counter > cur) byScope.set(hit.scope, hit.counter);
  }
  return { byScope, unreadable };
};

// --- Validation -------------------------------------------------------------

/**
 * Shape validation for a {@link SequenceSpec}. Everything here is checkable
 * without touching the database, so it runs in `validateFields` and every
 * surface that stores a collection's fields gets it for free.
 */
export const validateSequenceSpec = (
  name: string,
  field: { sequence?: SequenceSpec; type?: string },
): void => {
  const spec = field.sequence;
  if (!spec) return;
  const where = `Field "${name}"`;
  if (typeof spec !== "object" || Array.isArray(spec)) {
    throw new Error(`${where}: sequence must be an object`);
  }
  // A rendered pattern is a string. An integer column could only hold the bare
  // counter, and then `INV-` would have nowhere to live — so rather than
  // supporting a second, weaker mode, sequences are text and say so.
  if (field.type !== "text") {
    throw new Error(
      `${where}: a sequence field must be type text (got "${field.type}") — the value is a rendered string like "INV-2026-0001"`,
    );
  }
  if (typeof spec.pattern !== "string" || !spec.pattern) {
    throw new Error(`${where}: sequence.pattern is required`);
  }
  let tokens: SequenceToken[];
  try {
    tokens = parseSequencePattern(spec.pattern);
  } catch (e) {
    throw new Error(`${where}: sequence.pattern ${(e as Error).message}`);
  }
  const counters = tokens.filter((t) => t.kind === "counter");
  if (counters.length === 0) {
    throw new Error(
      `${where}: sequence.pattern must contain a counter token (a run of "#", e.g. "{####}") — without one every row would render the same value`,
    );
  }
  if (counters.length > 1) {
    throw new Error(
      `${where}: sequence.pattern has ${counters.length} counter tokens — there is one counter per field, so only one can be rendered`,
    );
  }
  if (spec.start !== undefined) {
    if (typeof spec.start !== "number" || !Number.isInteger(spec.start) || spec.start < 0) {
      throw new Error(`${where}: sequence.start must be a non-negative whole number`);
    }
  }
  const reset = spec.reset ?? "never";
  if (!(SEQUENCE_RESETS as readonly string[]).includes(reset)) {
    throw new Error(`${where}: sequence.reset must be one of ${SEQUENCE_RESETS.join(", ")}`);
  }
  if (spec.timezone !== undefined) {
    if (typeof spec.timezone !== "string" || !spec.timezone) {
      throw new Error(`${where}: sequence.timezone must be an IANA time zone name`);
    }
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: spec.timezone });
    } catch {
      throw new Error(`${where}: sequence.timezone "${spec.timezone}" is not a known IANA time zone`);
    }
  }
  // The reset only changes which BUCKET the counter comes from. If the rendered
  // value carries no trace of that bucket, the new year restarts at 1 and hands
  // out a string last year already used — a UNIQUE violation on a good schema
  // and a silent duplicate on the rest. Require the pattern to name the period
  // it resets on.
  if (reset !== "never") {
    const used = dateTokensOf(tokens);
    const hasYear = used.has("YYYY") || used.has("YY");
    const missing: string[] = [];
    if (!hasYear) missing.push("{YYYY} or {YY}");
    if ((reset === "monthly" || reset === "daily") && !used.has("MM")) missing.push("{MM}");
    if (reset === "daily" && !used.has("DD")) missing.push("{DD}");
    if (missing.length) {
      throw new Error(
        `${where}: sequence.reset "${reset}" restarts the counter, so the pattern must include ${missing.join(
          " and ",
        )} — otherwise the next period reissues numbers this one already used`,
      );
    }
  }
};
