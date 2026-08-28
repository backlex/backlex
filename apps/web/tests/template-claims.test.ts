/**
 * A field's prose is not executable, and in these templates it makes
 * load-bearing claims.
 *
 * Measured before this file existed: across 516 spec files, exactly ONE
 * related a field's description to that field's behaviour — and it was written
 * the same day, for one template, after the defect. Everything a template says
 * about itself in words was unchecked.
 *
 * That is not cosmetic here, because the prose is the only place a template
 * explains a mechanism the schema is supposed to provide. Two hints in the
 * commerce model told an operator a number was "summed from" its children when
 * the column was a plain writable integer nobody summed anything into — and the
 * seeded data proved it, shipping a product whose stock said 120 while its
 * variants held 90. The operator was told to trust a number and the number was
 * wrong. A test that reads the schema alone cannot see this: a writable int is
 * a perfectly valid writable int. It only becomes a defect against a sentence.
 *
 * So: a description may not name a mechanism the schema does not declare.
 *
 * Only the direction that can mislead is checked. A `rollup` that stays silent
 * about being one is under-documented, not wrong, and forcing every derived
 * field to announce itself would be a style rule wearing a test's clothes.
 *
 * Two shapes of claim, because the templates carry two:
 *  - on a real field, the claim is about ITSELF;
 *  - on a `notice` (what `hint()` emits) or a collection `note`, the claim is
 *    about a SIBLING, so it is satisfied by any field in the same collection.
 *    Weaker on purpose — a notice that says "generated as" while the
 *    collection holds no generated column at all is the case worth catching,
 *    and pinning the sibling by name would only guess at English.
 */
import { describe, expect, test } from "bun:test";
import { TEMPLATES } from "../src/server/templates/catalog";

/** A phrase, and the declaration that has to be there for it to be true. */
interface Claim {
  label: string;
  phrase: RegExp;
  satisfiedBy: (f: FieldLike) => boolean;
  /**
   * Whether the catalog says this today. A `live` rule that stops matching is
   * a failure — the wording moved and the rule went quietly dead, which reads
   * exactly like a pass. A rule that is not live is deliberately forward-
   * looking: nothing phrases it that way yet, and it is here so that the first
   * field which does is checked.
   */
  live: boolean;
}

interface FieldLike {
  name: string;
  type?: string;
  description?: string;
  rollup?: unknown;
  computed?: unknown;
  sequence?: unknown;
  money?: unknown;
  unique?: unknown;
  uniqueWith?: unknown;
}

const isRollup = (f: FieldLike) => Boolean(f.rollup);
const isComputed = (f: FieldLike) => Boolean(f.computed);
const isDerived = (f: FieldLike) => Boolean(f.rollup || f.computed || f.sequence);

const CLAIMS: Claim[] = [
  {
    label: "a roll-up",
    // "summed across", "counted from", "totalled from" — the words the
    // catalog actually uses, not a vocabulary invented here.
    phrase: /\broll-?ups?\b|\brolled up\b|\brolls up\b|\bsummed (from|across)\b|\bcounted from\b|\btotall?ed from\b/i,
    satisfiedBy: isRollup,
    live: true,
  },
  {
    label: "a generated column",
    phrase: /\bgenerated (as|from|by the database)\b|\bcalculated as\b|\bderived as\b/i,
    satisfiedBy: isComputed,
    live: true,
  },
  {
    label: "a server-issued sequence",
    phrase: /\bthe server issues\b|\bissued by the server\b|\bauto-?numbered\b|\bnext number in\b/i,
    satisfiedBy: (f) => Boolean(f.sequence),
    live: false,
  },
  {
    label: "minor-unit money storage",
    phrase: /\bminor units\b|\bin cents\b/i,
    satisfiedBy: (f) => Boolean(f.money),
    live: false,
  },
  {
    label: "a value the operator cannot type",
    phrase: /\bcan(no|')t be typed\b|\bnobody types\b|\bonly number here anyone types\b/i,
    satisfiedBy: isDerived,
    live: true,
  },
];

/**
 * Does this prose ASSERT the claim?
 *
 * Split first, because a description can deny the very mechanism it names:
 * `customers.total_spent` reads "a money total cannot be summed across an
 * order history in several currencies", which is the opposite of claiming to
 * be a roll-up — and a naive `/summed across/` reported it as one. The clause,
 * not the sentence, is the unit: "it can't be typed in, it is summed from its
 * children" has to keep matching on the second half.
 */
const assertingClauses = (text: string, phrase: RegExp): string[] =>
  text
    .split(/[.;,—]|\bbut\b|\brather than\b/)
    .filter((clause) => phrase.test(clause) && !/\b(cannot|can'?t|never|not|no|without)\b/i.test(clause));

const asserts = (text: string, phrase: RegExp): boolean =>
  assertingClauses(text, phrase).length > 0;

/** Column names a clause names outright, which is the only sort a test can check. */
const backticked = (clause: string): string[] =>
  [...clause.matchAll(/`([a-z][a-z0-9_]*)`/gi)].map((m) => m[1] as string);

/** `hint()` emits `{ name: "hint_<key>", type: "notice", description }`. */
const isNotice = (f: FieldLike) => f.type === "notice";

/** Every real field of a template, indexed by name — one name can be several. */
const fieldsByName = (t: (typeof TEMPLATES)[number]): Map<string, FieldLike[]> => {
  const out = new Map<string, FieldLike[]>();
  for (const c of t.collections ?? []) {
    for (const f of (c.fields ?? []) as FieldLike[]) {
      if (isNotice(f)) continue;
      out.set(f.name, [...(out.get(f.name) ?? []), f]);
    }
  }
  return out;
};

/** Every sentence a template's agents carry, addressed for a failure message. */
const agentProse = (t: (typeof TEMPLATES)[number]): { where: string; text: string }[] =>
  ((t.agents ?? []) as { handle?: string; systemPrompt?: string; description?: string }[]).flatMap(
    (a) => [
      { where: `${a.handle}.systemPrompt`, text: String(a.systemPrompt ?? "") },
      { where: `${a.handle}.description`, text: String(a.description ?? "") },
    ],
  );

describe("a template's prose may not claim a mechanism its schema lacks", () => {
  for (const claim of CLAIMS) {
    test(`no field describes itself as ${claim.label} without being one`, () => {
      const broken: string[] = [];
      for (const t of TEMPLATES) {
        for (const c of t.collections ?? []) {
          const fields = (c.fields ?? []) as FieldLike[];
          for (const f of fields) {
            if (isNotice(f)) continue;
            const text = String(f.description ?? "");
            if (!asserts(text, claim.phrase)) continue;
            if (!claim.satisfiedBy(f)) {
              broken.push(`${t.id}/${c.slug}.${f.name}: "${text.replace(/\s+/g, " ").slice(0, 90)}"`);
            }
          }
        }
      }
      expect(broken).toEqual([]);
    });

    test(`no hint or note promises ${claim.label} the collection does not have`, () => {
      const broken: string[] = [];
      for (const t of TEMPLATES) {
        for (const c of t.collections ?? []) {
          const fields = (c.fields ?? []) as FieldLike[];
          const anySatisfies = fields.some((f) => !isNotice(f) && claim.satisfiedBy(f));
          const prose = [
            ...fields.filter(isNotice).map((f) => ({ where: f.name, text: String(f.description ?? "") })),
            { where: "note", text: String(c.note ?? "") },
          ];
          for (const p of prose) {
            if (!asserts(p.text, claim.phrase)) continue;
            if (!anySatisfies) {
              broken.push(
                `${t.id}/${c.slug} (${p.where}): "${p.text.replace(/\s+/g, " ").slice(0, 90)}"`,
              );
            }
          }
        }
      }
      expect(broken).toEqual([]);
    });

    test(`no agent prompt promises ${claim.label} its columns do not have`, () => {
      // The sweep above stops at the schema, and the commerce template proved
      // that is not far enough: its "Store analyst" prompt told the model "a
      // product's own stock number is a reporting roll-up" while the column was
      // a plain writable int, and the field-level guard could not see it — the
      // sentence is attached to no field.
      //
      // An agent's prose is worse than a hint, not better. A hint sits beside
      // the column and an operator can look; a prompt is repeated to whoever
      // asks, in confident natural language, with the schema out of sight.
      //
      // The rule that has teeth is NAMING, and it is the one thing the original
      // sentence would not do. "A template-wide check" was tried first and is
      // worthless here: the commerce model holds five rollups, so ANY claim
      // about a roll-up is satisfied by one of them and the false sentence
      // passes. Resolving the claim to the column it is about is the only way
      // it fails, so a claim must name its column in backticks and every column
      // it names has to hold up.
      //
      // Which is also a constraint on how a prompt is worded: do not name the
      // SOURCE column inside the clause making the claim ("`stock` is summed
      // from `on_hand`" fails, because `on_hand` is a plain int). Split the
      // sentence. That is a low price for a claim a test can read.
      const broken: string[] = [];
      for (const t of TEMPLATES) {
        const byName = fieldsByName(t);
        for (const p of agentProse(t)) {
          for (const clause of assertingClauses(p.text, claim.phrase)) {
            const named = backticked(clause).filter((n) => byName.has(n));
            if (named.length === 0) {
              broken.push(
                `${t.id}/${p.where}: names no column, so nothing can check it — "${clause.trim().slice(0, 90)}"`,
              );
              continue;
            }
            for (const n of named) {
              if (!byName.get(n)!.every((f) => claim.satisfiedBy(f))) {
                broken.push(`${t.id}/${p.where}: \`${n}\` is not ${claim.label} — "${clause.trim().slice(0, 90)}"`);
              }
            }
          }
        }
      }
      expect(broken).toEqual([]);
    });
  }

  test("the agent sweep reaches real prompts — it checked nothing otherwise", () => {
    // The same deadness trap as the vocabulary check below, one layer out: if
    // no agent prose asserts any claim at all, every prompt test above passes
    // by finding nothing, and would keep passing once the prompts were
    // rewritten into lies. Two do today — commerce's `stock` /
    // `inventory_quantity` and manufacturing's `actual_minutes`.
    const found = TEMPLATES.flatMap((t) =>
      agentProse(t).flatMap((p) => CLAIMS.flatMap((claim) => assertingClauses(p.text, claim.phrase))),
    );
    expect(found.length).toBeGreaterThan(0);
  });

  test("the vocabulary still matches something — a guard that fires on nothing is not a guard", () => {
    // A regex that has stopped matching the catalog reports success forever.
    // Count the claims each phrase currently finds, so a rewording that makes
    // the whole rule dead shows up as a failure here rather than as silence.
    const hits: Record<string, number> = {};
    for (const claim of CLAIMS) {
      let n = 0;
      for (const t of TEMPLATES) {
        for (const c of t.collections ?? []) {
          for (const f of ((c.fields ?? []) as FieldLike[])) {
            if (asserts(String(f.description ?? ""), claim.phrase)) n++;
          }
          if (asserts(String(c.note ?? ""), claim.phrase)) n++;
        }
      }
      hits[claim.label] = n;
    }
    const dead = CLAIMS.filter((claim) => claim.live && (hits[claim.label] ?? 0) === 0).map(
      (claim) => claim.label,
    );
    expect(dead).toEqual([]);
  });
});
