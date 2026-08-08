import type { FieldChoice, FieldDef } from "@backlex/db";

/**
 * The authoring DSL every template in `defs/` is written in.
 *
 * These are not general-purpose helpers: each one encodes a decision the
 * catalog made once and wants applied everywhere (relations are indexed, a
 * `url` field carries no regex because the fold IS the validator, a percentage
 * renders as `percent100` because `percent` expects a fraction). The long
 * comments are those decisions, kept next to the thing that enforces them.
 */
/** Semantic badge colors for status/priority dropdowns. */
export const C = {
  green: "#16a34a",
  blue: "#2563eb",
  amber: "#d97706",
  red: "#dc2626",
  gray: "#6b7280",
  purple: "#9333ea",
  teal: "#0d9488",
  slate: "#475569",
} as const;

/** Parse an ISO date to epoch ms for sample timestamp values (deterministic). */
export const ms = (iso: string): number => new Date(iso).getTime();

export const text = (name: string, extra: Partial<FieldDef> = {}): FieldDef => ({ name, type: "text", ...extra });
export const notes = (name: string, extra: Partial<FieldDef> = {}): FieldDef => ({ name, type: "longtext", interface: "textarea", ...extra });
export const num = (name: string, extra: Partial<FieldDef> = {}): FieldDef => ({ name, type: "number", ...extra });
export const int = (name: string, extra: Partial<FieldDef> = {}): FieldDef => ({ name, type: "integer", ...extra });
export const bool = (name: string, extra: Partial<FieldDef> = {}): FieldDef => ({ name, type: "boolean", interface: "toggle", ...extra });
export const ts = (name: string, extra: Partial<FieldDef> = {}): FieldDef => ({ name, type: "timestamp", interface: "datetime", ...extra });
export const date = (name: string, extra: Partial<FieldDef> = {}): FieldDef => ({ name, type: "timestamp", interface: "date", ...extra });
export const file = (name: string, extra: Partial<FieldDef> = {}): FieldDef => ({ name, type: "file", ...extra });
/** Relations are indexed by default — they're the hot join/filter path. */
export const rel = (name: string, to: string, extra: Partial<FieldDef> = {}): FieldDef => ({ name, type: "relation", to, interface: "relation", indexed: true, ...extra });
export const relMany = (name: string, to: string, extra: Partial<FieldDef> = {}): FieldDef => ({ name, type: "relation_many", to, ...extra });
/**
 * All fifty-eight of these are a real `email` field now, not `text` + a regex.
 *
 * The regex is gone rather than kept alongside: the type enforces a strictly
 * narrower envelope than it did, and leaving it would mean two rules to keep in
 * step. Every column converted at once because an email field's storage is
 * identical to `text` — the conversion is metadata, exactly as it was for phone
 * and unlike money, which could convert only 51 of 182.
 */
export const email = (name: string, extra: Partial<FieldDef> = {}): FieldDef => ({ name, type: "email", interface: "email", ...extra });
/**
 * A web address — a `url` field, and NO `validation.regex`.
 *
 * Every one of these columns used to be `text` carrying the string
 * `"^https?://.+"`. Dropping the regex is not a relaxation, it is what makes the
 * type work: `validateValue` runs on the RAW value, BEFORE the write path folds
 * it, so a pattern demanding a scheme rejects the bare `acme.com` an operator
 * types into a box labelled "Website" — and the fold that would have turned it
 * into `https://acme.com/` never gets to run. A canonicalizing field and a
 * validating regex on the same column are mutually exclusive; the fold IS the
 * validator, and it is a stricter one than the pattern ever was.
 *
 * All sixteen columns converted at once. On SQLite that is pure metadata (TEXT
 * either way); on Postgres the column widens from `varchar(255)` to `text`,
 * which several of these needed anyway — a `canonical_url` or a `tracking_url`
 * with campaign parameters goes past 255 routinely.
 */
export const url = (name: string, extra: Partial<FieldDef> = {}): FieldDef => ({ name, type: "url", interface: "url", ...extra });
/**
 * A bare registrable domain — `acme.com`, not `https://acme.com/`.
 *
 * The two columns this serves (`crm.companies.domain`,
 * `support.organizations.domain`) are what a CRM matches a company by, which is
 * the right-hand side of an email address and not an address of its own. Under
 * the old shared regex they were forced to hold a scheme, which is why both
 * templates' sample rows said `https://acme.example` in a column named `domain`
 * and why typing `acme.com` into one returned a 422. The schema was distorted to
 * satisfy a validator that was wrong for it.
 */
export const host = (name: string, extra: Partial<FieldDef> = {}): FieldDef => ({ name, type: "url", interface: "url", url: { form: "host" }, ...extra });
/**
 * An amount in a collection that has no currency column of its own — still a
 * plain `number`.
 *
 * Kept for the collections `moneyIn` cannot serve: line-item tables whose
 * currency belongs to the parent row, and the many collections that carry a
 * price without ever stating a denomination. Converting those is a modelling
 * decision per template (give the table its own `currency`, or pin one), not a
 * rename — see docs/money.md.
 */
export const money = (name: string, extra: Partial<FieldDef> = {}): FieldDef => ({ name, type: "number", interface: "decimal", validation: { min: 0 }, ...extra });
/**
 * An amount denominated by the row's OWN `currency` column — a real `money`
 * field.
 *
 * Used in every collection that already ships a `currency` text column beside
 * its amounts, which is what these templates were doing by hand: the two
 * columns existed, and nothing tied them together. Now the amount is stored in
 * minor units, read back as `{ amount, currency }`, formatted with that
 * currency's own decimals, and refused from any total that would mix
 * denominations.
 */
export const moneyIn = (name: string, extra: Partial<FieldDef> = {}): FieldDef => ({ name, type: "money", money: { currencyField: "currency" }, interface: "money", validation: { min: 0 }, ...extra });
/**
 * A phone number, stored as canonical E.164.
 *
 * Deliberately carries **no `region`**. These templates are country-neutral, and
 * a region is not a cosmetic default: it decides which country a bare
 * `0532 111 22 33` dials. Picking one here would mean every workspace that
 * seeded the template inherited someone else's country, and the failure would be
 * silent — a stored number that parses, looks right, and rings in the wrong
 * place. Without one, only international-form numbers are accepted, which is the
 * refusal-over-a-guess rule the whole type is built on.
 *
 * Setting a region afterwards is a one-field change in the schema editor, and
 * the item form's own country picker means an operator can type nationally
 * without one anyway (the choice is a parsing hint, never stored).
 *
 * The column stays TEXT, so this is metadata-only against a table that already
 * exists — which is what made converting all thirty-six of these possible at
 * once, where money could only convert fifty-one of a hundred and eighty-two.
 */
export const phone = (name: string, extra: Partial<FieldDef> = {}): FieldDef => ({ name, type: "phone", interface: "phone", ...extra });
export const rating = (name: string, extra: Partial<FieldDef> = {}): FieldDef => ({ name, type: "integer", interface: "rating", validation: { min: 1, max: 5 }, ...extra });
/**
 * A URL slug folded from `from` — the collection's own title or name column.
 *
 * There is deliberately NO `validation.regex` here any more. Body validation
 * runs BEFORE the slug resolver, so a regex on this column would reject
 * `My First Post!` on the way in and the fold that turns it into `my-first-post`
 * would never get to run — which is the whole feature. The `slug` spec is the
 * shape's single source of truth now; see `@backlex/db/slug`.
 */
export const slugField = (from: string, extra: Partial<FieldDef> = {}): FieldDef => ({ name: "slug", type: "text", interface: "slug", unique: true, slug: { from: [from] }, ...extra });
export const computedNum = (name: string, formula: string, extra: Partial<FieldDef> = {}): FieldDef => ({ name, type: "number", computed: { formula }, ...extra });
/**
 * A generated column that is MONEY, denominated by the row's own `currency`.
 *
 * The formula works in the units the columns hold — minor units — so
 * `total - amount_paid` is an integer subtraction of two integers, and the
 * result is read back as an amount like any other. Declaring it `computedNum`
 * instead would produce the exact silent wrongness the money type exists to
 * end: a balance of `250000` printed as a number beside a total of `€2,500.00`.
 */
export const computedMoneyIn = (name: string, formula: string, extra: Partial<FieldDef> = {}): FieldDef => ({ name, type: "money", money: { currencyField: "currency" }, interface: "money", computed: { formula }, ...extra });
export const computedText = (name: string, formula: string, extra: Partial<FieldDef> = {}): FieldDef => ({ name, type: "text", computed: { formula }, ...extra });
/**
 * A point on the earth, derived from the address columns beside it.
 *
 * `from` names the text columns whose values are joined and geocoded when a row
 * is saved without a point — which is what lets a template's own sample rows,
 * and every row an operator types afterwards, become answerable by `_near`
 * without anyone entering a coordinate. Order is the address format.
 *
 * Deployments with no geocoder configured simply leave the column null; the
 * field still works as a pair of coordinates someone enters by hand, and
 * `POST /api/geo/backfill/{slug}` fills the rest in later. See docs/geo.md.
 */
export const geo = (name: string, from: string[], extra: Partial<FieldDef> = {}): FieldDef => ({
  name,
  type: "geo",
  interface: "map",
  geo: { geocodeFrom: from },
  ...extra,
});
/** Single image (file storage, image picker). */
export const image = (name: string, extra: Partial<FieldDef> = {}): FieldDef => ({ name, type: "file", interface: "image", ...extra });
/** Free-form label list (JSON array). Never seeded with sample values — a JSON
 *  array bound straight into a Postgres jsonb column trips the pg driver; define
 *  the column, leave samples scalar. Same rule applies to `relation_many`. */
export const tags = (name: string, extra: Partial<FieldDef> = {}): FieldDef => ({ name, type: "json", interface: "tags", ...extra });
/** Self-referential parent FK for hierarchical/tree collections. */
export const parent = (to: string, extra: Partial<FieldDef> = {}): FieldDef => rel("parent", to, { label: "Parent", ...extra });
/** Link to a workspace end-user (`app_users.id`) — set by the admin (or a
 *  future invite/auto-link flow) so the person can sign in and see their own
 *  rows via `$user.id` permission conditions. The "user" interface renders an
 *  end-user picker in the admin and enforces that the id exists on write. */
export const userLink = (extra: Partial<FieldDef> = {}): FieldDef => text("app_user_id", { indexed: true, label: "Login user", interface: "user", ...extra });
/**
 * The place a row holds in a list somebody arranged by hand.
 *
 * `order` is what turns the column from a number an operator had to type into
 * one the server maintains: a create that says nothing about it is APPENDED to
 * the end of its list instead of landing on the same `default: 0` as every
 * other row, and `POST /:slug/reorder` moves one row without renumbering the
 * rest. The default stays for rows written around the API (a restore, direct
 * SQL) — `POST /:slug/order/normalize` repairs those.
 *
 * `scope` names the column that splits the collection into separate lists: each
 * module's lessons are numbered 1, 2, 3 independently. Leaving it off is the
 * right answer for a top-level arrangement (pipelines, SLA policies, folders)
 * and the wrong one for anything nested, where a single numbering would make
 * two parents' children interleave.
 *
 * Indexed so ordered lists stay cheap — every read of one sorts by this column.
 */
export const position = (scope?: string, extra: Partial<FieldDef> = {}): FieldDef => ({
  name: "position",
  type: "integer",
  default: 0,
  indexed: true,
  order: scope ? { scope } : {},
  ...extra,
});
/** Percent 0–100 integer. */
/**
 * A percentage, stored as the number people say — `20` means twenty percent.
 *
 * The `{min: 0, max: 100}` was always here and is what settles the convention:
 * the column holds 20, not 0.2. What was missing is the RENDERING, so every one
 * of these printed as a bare `20` next to labels that had to say "(%)" by hand.
 *
 * `percent100` rather than `percent` for exactly that reason —
 * `Intl.NumberFormat`'s percent style expects a fraction, so it printed `20` as
 * `2,000%`. Two of these templates carried that combination and were wrong by a
 * factor of a hundred on screen. See `FieldDef.format.style`.
 */
export const pct = (name: string, extra: Partial<FieldDef> = {}): FieldDef => ({ name, type: "integer", interface: "slider", validation: { min: 0, max: 100 }, format: { style: "percent100" }, ...extra });

/** Colored dropdown. `values` may be plain strings or `{ value, color, label }`. */
export const select = (
  name: string,
  values: Array<string | FieldChoice>,
  extra: Partial<FieldDef> = {},
): FieldDef => ({
  name,
  type: "text",
  interface: "dropdown",
  options: { choices: values.map((v) => (typeof v === "string" ? { value: v } : v)) },
  indexed: true,
  ...extra,
});

export const ch = (value: string, color: string, label?: string): FieldChoice => ({ value, color, label });

/**
 * A status lifecycle for a `select` field — which value may follow which.
 *
 * Written as an adjacency list because that is what it is, and because the
 * admin's editor draws exactly this as a matrix. A value that appears as no
 * key is FINAL: nothing leads out of it. Pass the result into `select`'s
 * `extra`.
 *
 * `requires` names the sibling fields a particular target demands and `labels`
 * gives it a verb. Both are keyed by TARGET value, since in practice the
 * demand belongs to where the row is going rather than to any one edge into it.
 *
 * Deliberately NOT applied to every status field in the catalog. A lifecycle
 * that is merely plausible is worse than none: it blocks work an operator was
 * entitled to do, in a workspace they did not author. Only the flows whose
 * shape is genuinely standard in their domain carry one.
 */
export const flow = (
  edges: Record<string, string[]>,
  opts: {
    initial?: string[];
    requires?: Record<string, string[]>;
    labels?: Record<string, string>;
  } = {},
): Partial<FieldDef> => ({
  transitions: {
    ...(opts.initial ? { initial: opts.initial } : {}),
    allow: Object.entries(edges).flatMap(([from, tos]) =>
      tos.map((to) => ({
        from,
        to,
        ...(opts.requires?.[to] ? { requires: opts.requires[to] } : {}),
        ...(opts.labels?.[to] ? { label: opts.labels[to] } : {}),
      })),
    ),
  },
});

/* ──────────────────────────── form-layout helpers ───────────────────────────
 * These wrap the field-organization primitives (`group`, `width`,
 * `sectionCollapsible` / `sectionCollapsed`, `sectionsAsTabs`, and the
 * presentational `divider` / `notice` types). The house rules the catalog
 * follows, enforced by `tests/templates-layout.test.ts`:
 *
 *   • < 10 storage fields  → flat is fine; the record is one conceptual unit
 *     (a line item, a ledger row) and a lone section header is just noise.
 *     Still pair the scalars with `half()`.
 *   • 10–13 storage fields → `stacked(...)` headings, 2–3 sections.
 *   • ≥ 14 storage fields  → `tabbed(...)`, one tab per section.
 *   • "SEO" / "Internal" / "Churn"-style trailing sections → `{ folded: true }`,
 *     but ONLY when stacked: the renderer's tabs branch returns before the
 *     collapsible one, so a fold flag next to `sectionsAsTabs` is dead weight.
 *
 * Section order is field order: the renderer buckets fields into a Map keyed by
 * `group`, so the first field of a section fixes that section's position. In
 * tabs mode every field must carry a group — an ungrouped one lands in an
 * implicit "General" tab that reads as a bug.
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * Assign a form section (`group`) to a run of fields. `fold` makes the section
 * collapsible; `folded` additionally starts it collapsed.
 *
 * The fold flags land on the section's FIRST field only — the renderer
 * aggregates them with `.some()` across the group, so one carrier is enough and
 * keeps the stored schema lean.
 */
export const sec = (
  name: string,
  fields: FieldDef[],
  opts: { fold?: boolean; folded?: boolean } = {},
): FieldDef[] =>
  fields.map((f, i) => ({
    ...f,
    group: name,
    ...(i === 0 && (opts.fold || opts.folded) ? { sectionCollapsible: true } : {}),
    ...(i === 0 && opts.folded ? { sectionCollapsed: true } : {}),
  }));

/**
 * Mark fields half-width. Two CONSECUTIVE halves share a 2-column row (a single
 * column on mobile); a full-width field or a presentational block between them
 * breaks the pair, so keep the operands adjacent.
 */
export const half = (...fields: FieldDef[]): FieldDef[] =>
  fields.map((f) => ({ ...f, width: "half" as const }));

/**
 * Render the form's sections as TABS instead of stacked headings — for records
 * too large to scroll. Pass the already-`sec()`-ed runs. The flag is form-wide
 * and aggregated, so it rides on the first field.
 *
 * Every field must belong to a section: an ungrouped field falls into an
 * implicit "General" tab, which reads as a bug.
 */
export const tabbed = (...sections: FieldDef[][]): FieldDef[] =>
  sections.flat().map((f, i) => (i === 0 ? { ...f, sectionsAsTabs: true } : f));

/** Concatenate sections as stacked headings (the renderer's default). */
export const stacked = (...sections: FieldDef[][]): FieldDef[] => sections.flat();

/** A labeled rule separating sub-blocks inside a section. Owns no column —
 *  `key` only has to be unique within the collection. Always pass a label: an
 *  unlabeled presentational block falls back to rendering its raw field name. */
export const divider = (key: string, label: string): FieldDef => ({
  name: `div_${key}`,
  type: "divider",
  label,
});

/** An info callout explaining a section or a non-obvious field. Owns no column.
 *  The body text comes from `description`; keep it to one operator-facing
 *  sentence, and use it only where the form would otherwise mislead. */
export const hint = (key: string, body: string): FieldDef => ({
  name: `hint_${key}`,
  type: "notice",
  description: body,
});
