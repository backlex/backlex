/**
 * Percent rendering — the two conventions, and the bug that motivated splitting
 * them.
 *
 * `Intl.NumberFormat`'s percent style takes a FRACTION: it multiplies by a
 * hundred and appends the sign. Every schema template stores the percentage
 * itself — all seventeen validate `{min: 0, max: 100}`, which is what says the
 * column holds 20 and not 0.2 — so two template fields that had asked for
 * `style: "percent"` rendered `20` as **2,000%**.
 *
 * The fix is not to redefine `percent`: a workspace that stores fractions is
 * being served correctly by it today, and moving that token would break them
 * silently. So `percent100` was added for the convention the templates actually
 * use, and both are now named after what the COLUMN holds.
 */
import { describe, expect, test } from "bun:test";
import { formatFieldValue } from "../src/client/admin/lib/format-value";

const num = (format: Record<string, unknown>) => ({ type: "number", format }) as never;

describe("the two percent conventions", () => {
  test("`percent100` prints the number as the percentage it is", () => {
    expect(formatFieldValue(20, num({ style: "percent100" }), "en")).toBe("20%");
    expect(formatFieldValue(7.5, num({ style: "percent100", precision: 1 }), "en")).toBe("7.5%");
    expect(formatFieldValue(0, num({ style: "percent100" }), "en")).toBe("0%");
    expect(formatFieldValue(100, num({ style: "percent100" }), "en")).toBe("100%");
  });

  test("`percent` keeps Intl's fraction meaning, so nobody's rendering moves", () => {
    expect(formatFieldValue(0.2, num({ style: "percent" }), "en")).toBe("20%");
    // …and this is the combination that was wrong on the templates: the same
    // token against a column holding 20.
    expect(formatFieldValue(20, num({ style: "percent" }), "en")).toBe("2,000%");
  });

  test("the locale's own percent placement is kept, not hand-assembled", () => {
    // Turkish writes the sign FIRST. Appending "%" to a plain number would have
    // produced "20%" here, which is wrong in Turkish — which is why the value is
    // divided and handed to Intl rather than formatted as a bare number.
    expect(formatFieldValue(20, num({ style: "percent100" }), "tr")).toBe("%20");
  });

  test("precision applies to the percentage, not to the fraction", () => {
    expect(formatFieldValue(12.345, num({ style: "percent100", precision: 2 }), "en")).toBe(
      "12.35%",
    );
  });
});

describe("the schema templates", () => {
  test("every percentage field renders as one, and none uses the fraction style", async () => {
    // Both halves matter. A `percent` style on a 0–100 column is the hundredfold
    // bug; NO style at all is the milder one this also fixes — seventeen columns
    // printed as bare numbers beside labels that had to carry "(%)" by hand.
    const { TEMPLATES } = await import("../src/server/templates/catalog");
    const problems: string[] = [];
    let percentFields = 0;
    for (const tpl of TEMPLATES as any[]) {
      for (const col of tpl.collections ?? []) {
        for (const f of col.fields ?? []) {
          const style = f.format?.style;
          if (style === "percent") {
            problems.push(
              `${tpl.id}.${col.slug}.${f.name} uses the fraction style on a stored percentage`,
            );
          }
          if (style !== "percent100") continue;
          percentFields++;
          // A `percent100` column that does not cap at 100 is not on this
          // convention, and would print e.g. 250 as "250%".
          if (f.validation?.max !== 100) {
            problems.push(
              `${tpl.id}.${col.slug}.${f.name} is percent100 but validation.max=${f.validation?.max}`,
            );
          }
        }
      }
    }
    expect(problems).toEqual([]);
    // Proven non-vacuous: an empty corpus would pass the assertion above.
    expect(percentFields).toBeGreaterThan(10);
  });

  test("a score is a percentage only when it says it is", async () => {
    // The conversion went by MEANING, not by matching `{min: 0, max: 100}`. A
    // lead score of 80 is not "80%" — that range is a scale, not a proportion —
    // so `crm.leads.score`, `hr.training_attendance.score` and
    // `lms.quiz_attempts.score` keep printing as plain numbers.
    //
    // `lms.quizzes.passing_score` is the exception and a deliberate one: its own
    // label is "Passing score (%)", so the template already meant a percentage.
    // This test's first draft flagged it, which is how the distinction got made
    // explicit rather than left to whichever helper the field happened to use.
    const { TEMPLATES } = await import("../src/server/templates/catalog");
    const wrong: string[] = [];
    let plainScores = 0;
    for (const tpl of TEMPLATES as any[]) {
      for (const col of tpl.collections ?? []) {
        for (const f of col.fields ?? []) {
          if (!/(^|_)score($|_)/.test(f.name)) continue;
          const saysPercent = /%/.test(String(f.label ?? ""));
          const rendersPercent = f.format?.style === "percent100";
          if (rendersPercent && !saysPercent) {
            wrong.push(`${tpl.id}.${col.slug}.${f.name} renders as % but is a raw score`);
          }
          if (!rendersPercent) plainScores++;
        }
      }
    }
    expect(wrong).toEqual([]);
    // Proven non-vacuous: there really are raw scores left rendering plainly.
    expect(plainScores).toBeGreaterThan(0);
  });
});
