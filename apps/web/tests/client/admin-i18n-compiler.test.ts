/**
 * The admin chrome's Lingui runtime must carry its own message compiler.
 *
 * `@lingui/core` registers one in its constructor, but behind
 * `process.env.NODE_ENV !== "production"` — so a prod bundle tree-shakes it and
 * `i18n._()` falls into its uncompiled branch: a `console.warn` per lookup and
 * the raw ICU source returned verbatim (`… and {0} more` reaching the DOM with
 * the braces intact). `en` is 100% catalog misses by design, so that branch is
 * every English string. Dev and `bun test` both run with the dev compiler
 * present, which is exactly why this regressed unnoticed.
 *
 * A behavioural "does it interpolate?" assertion would therefore pass whether
 * or not `i18n.ts` registers anything — vacuously green. So the load-bearing
 * check is the IDENTITY one: our compiler memoises, and a memo returns the same
 * object for the same input. Lingui's own `compileMessage` builds a fresh array
 * per call, so reference equality holds only when OUR compiler is installed.
 */
import { describe, expect, test } from "bun:test";
import type { CompiledMessage } from "@lingui/message-utils/compileMessage";
import { i18n } from "../../src/client/admin/i18n";

type MessageCompiler = (message: string) => CompiledMessage;

/** `_messageCompiler` is private to `I18n`; there is no public getter. */
const activeCompiler = (): MessageCompiler | undefined =>
  (i18n as unknown as { _messageCompiler?: MessageCompiler })._messageCompiler;

describe("admin i18n runtime compiler", () => {
  test("i18n.ts registers a compiler of its own", () => {
    expect(typeof activeCompiler()).toBe("function");
  });

  test("the registered compiler is the memoised one, not Lingui's dev default", () => {
    const compile = activeCompiler();
    if (!compile) throw new Error("no message compiler registered");
    // Same input twice: a memo hands back the cached AST by reference.
    expect(compile("… and {0} more")).toBe(compile("… and {0} more"));
    // Distinct inputs still compile independently.
    expect(compile("… and {0} more")).not.toBe(compile("{0} of {1}"));
  });

  test("an uncompiled fallback message still interpolates", () => {
    // No catalog entry for this id — `_()` falls back to `message`, which only
    // renders correctly if a compiler turned the ICU source into an AST.
    const out = i18n._({
      id: "no-such-id-in-any-catalog",
      message: "… and {0} more",
      values: { 0: 7 },
    });
    expect(out).toBe("… and 7 more");
  });
});
