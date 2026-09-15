import { describe, expect, test } from "bun:test";
import { BUILT_IN_EMAIL_KEYS } from "@backlex/core/email-templates";
import type { ApiEmailTemplate } from "../../src/client/admin/api";
import {
  EMPTY_DRAFT,
  buildEntries,
  copyKey,
  draftFor,
  entryReplacedBy,
  entryStatus,
  insertText,
  isCompleteDocument,
  keyProblem,
  seedSample,
  senderPasses,
  setPath,
  variableWarnings,
  type TemplateEntry,
} from "../../src/client/admin/pages/settings/email-template-model";

// The email-templates page's decisions, asked directly. Each of these used to be
// wrong or absent somewhere: a key rule stricter than the server's that refused
// `booking.confirmed`, a preview that knew five variable names, a list with no
// way to tell a customized email from the one backlex sends.

const row = (over: Partial<ApiEmailTemplate>): ApiEmailTemplate => ({
  id: "r",
  tenantId: "ws",
  key: "k",
  name: "",
  subject: "",
  fromAddress: null,
  bodyHtml: "",
  bodyText: null,
  variables: null,
  inherited: false,
  overridesDefault: false,
  ...over,
});

const ROWS = [
  row({ id: "s-verify", tenantId: null, key: "verify", inherited: true }),
  row({ id: "o-reset", key: "reset", overridesDefault: true }),
  row({ id: "o-approval", key: "approval_request" }),
  row({ id: "o-welcome", key: "welcome" }),
];

describe("entries", () => {
  const entries = buildEntries(ROWS);
  const byKey = (k: string) => entries.find((e) => e.key === k)!;

  test("every built-in email lists, first and in catalog order, stored or not", () => {
    expect(entries.slice(0, BUILT_IN_EMAIL_KEYS.length).map((e) => e.key)).toEqual(BUILT_IN_EMAIL_KEYS);
    expect(entries.slice(BUILT_IN_EMAIL_KEYS.length).map((e) => e.key)).toEqual(["reset", "verify", "welcome"]);
  });

  test("status separates what backlex sends from what the workspace changed", () => {
    expect(entryStatus(byKey("form_invite"))).toBe("builtin");
    expect(entryStatus(byKey("approval_request"))).toBe("customized");
    expect(entryStatus(byKey("verify"))).toBe("shared");
    expect(entryStatus(byKey("reset"))).toBe("customized");
    expect(entryStatus(byKey("welcome"))).toBe("custom");
  });

  test("a built-in email nobody customized opens on its starter, named after it", () => {
    const d = draftFor(byKey("booking.confirmed"), "Booking confirmed");
    expect(d.name).toBe("Booking confirmed");
    expect(d.subject).toContain("{{ resource }}");
    expect(d.bodyHtml).toContain("{{ manageUrl }}");
  });
});

describe("keys", () => {
  const entries = buildEntries(ROWS);

  test("the server's pattern, dots included", () => {
    expect(keyProblem("booking.confirmed_v2", [])).toBeNull();
    expect(keyProblem("has space", [])).toBe("format");
    expect(keyProblem("x", [])).toBe("format");
    expect(keyProblem("_leading", [])).toBe("format");
  });

  test("taken means the workspace owns it — a default or a built-in is replaced, not taken", () => {
    expect(keyProblem("welcome", entries)).toBe("taken");
    expect(keyProblem("verify", entries)).toBeNull();
    expect(keyProblem("form_invite", entries)).toBeNull();
    expect(entryReplacedBy("verify", entries)?.key).toBe("verify");
    expect(entryReplacedBy("form_invite", entries)?.key).toBe("form_invite");
    expect(entryReplacedBy("welcome", entries)).toBeNull();
  });

  test("a copy's key is free and still fits the 40-character limit", () => {
    const withCopy = buildEntries([...ROWS, row({ id: "c", key: "welcome_copy" })]);
    expect(copyKey("welcome", withCopy)).toBe("welcome_copy_2");
    const long = copyKey("a".repeat(40), entries);
    expect(long.length).toBeLessThanOrEqual(40);
    expect(keyProblem(long, entries)).toBeNull();
  });
});

describe("variables", () => {
  const builtIn = buildEntries([]).find((e) => e.key === "signature_completed")!;
  const custom: TemplateEntry = { id: "c", key: "welcome", row: row({ key: "welcome", variables: ["user.name"] }), builtIn: null };

  test("a built-in email flags only what its sender never passes", () => {
    const draft = { ...EMPTY_DRAFT, bodyHtml: "{{ title }} {{ signers.1.email }} {{ titel }}" };
    expect(variableWarnings(builtIn, draft, null)).toEqual([{ path: "titel", reason: "not-sent" }]);
    // Past an array the sample cannot know the length, so it is not flagged.
    expect(senderPasses("signature_completed", "signers.3.name")).toBe(true);
    expect(senderPasses("signature_completed", "signer.name")).toBe(false);
  });

  test("a custom template flags what its sample data leaves empty", () => {
    const draft = { ...EMPTY_DRAFT, subject: "{{ user.name }}", bodyHtml: "{{ order.no }} {{ $user.email }}" };
    const sample = { user: { name: "Ada" }, order: { no: "" } };
    expect(variableWarnings(custom, draft, sample).map((w) => `${w.path}:${w.reason}`)).toEqual([
      "order.no:no-sample",
      "$user.email:no-sample",
    ]);
    // Unparseable sample data is reported by its editor, not as N warnings.
    expect(variableWarnings(custom, draft, null)).toEqual([]);
  });

  test("a custom template's seed names every variable, filling only what a caller supplies", () => {
    const draft = { ...EMPTY_DRAFT, bodyHtml: "{{ $user.email }} {{ data.title }} {{ report.filename }}" };
    expect(seedSample(custom, draft)).toEqual({
      user: { name: "" },
      $user: { email: "ops@example.com" },
      data: { title: "" },
      report: { filename: "monthly-revenue-2026-09-15.pdf" },
    });
  });

  test("setPath never flattens an object into a leaf", () => {
    const target: Record<string, unknown> = {};
    setPath(target, "user.email", "a@b.c");
    setPath(target, "user", "");
    expect(target).toEqual({ user: { email: "a@b.c" } });
  });
});

describe("editing and preview", () => {
  test("insertion replaces the selection and reports where the caret lands", () => {
    expect(insertText("<p>Hi </p>", 6, 6, "{{ x }}")).toEqual({ value: "<p>Hi {{ x }}</p>", caret: 13 });
    expect(insertText("abcdef", 1, 4, "X")).toEqual({ value: "aXef", caret: 2 });
    expect(insertText("ab", 99, 99, "X")).toEqual({ value: "abX", caret: 3 });
  });

  test("only a body that brings its own document is shown unwrapped", () => {
    expect(isCompleteDocument("<!doctype html><html><body>x</body></html>")).toBe(true);
    expect(isCompleteDocument("  <html lang=\"en\">…")).toBe(true);
    expect(isCompleteDocument("<p>Welcome to {{ site.name }}!</p>")).toBe(false);
  });
});
