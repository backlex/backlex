/**
 * Regression: `validateFields` must reject hostile computed-column formulas.
 * `columnDefSql` splices `field.computed.formula` RAW into DDL
 * (`GENERATED ALWAYS AS (<formula>) STORED`), and `applyCollection` →
 * `validateFields` is the chokepoint the backup-restore path flows through.
 * Without validation a tampered backup could break out of the parenthesis and
 * append arbitrary DDL.
 */
import { describe, expect, test } from "bun:test";
import { validateFields } from "@backlex/db";

describe("validateFields rejects unsafe computed formulas", () => {
  const withFormula = (formula: string) =>
    () =>
      validateFields([
        { name: "danger", type: "text", computed: { formula } } as any,
      ]);

  test("accepts a benign concat expression", () => {
    expect(
      withFormula("first_name || ' ' || last_name"),
    ).not.toThrow();
  });

  test("rejects a paren break-out + stacked DDL", () => {
    expect(withFormula("0) STORED); DROP TABLE users; --")).toThrow();
  });

  test("rejects a bare semicolon", () => {
    expect(withFormula("1; DELETE FROM users")).toThrow();
  });

  test("rejects SQL comments", () => {
    expect(withFormula("price -- comment")).toThrow();
  });

  test("rejects DDL/DML keywords", () => {
    expect(withFormula("(SELECT secret FROM users)")).toThrow();
  });

  test("rejects unbalanced parentheses", () => {
    expect(withFormula("abs(price")).toThrow();
  });
});
