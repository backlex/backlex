import { describe, expect, test } from "bun:test";
import type { ApiBookingQuestion } from "../../src/client/admin/api";
import {
  blankQuestion,
  isBlankQuestion,
  questionName,
  slugKey,
} from "../../src/client/admin/pages/data/booking/questions";
import { DEFAULT_FORM, bodyOf, problemWith } from "../../src/client/admin/pages/data/booking/records";
import { blankRule } from "../../src/client/admin/pages/data/booking/rules";

// Pure-logic unit tests for the booking resource's intake questions. The bunfig
// preloads (lingui-macro + happy-dom) let the client modules import cleanly.

/** A draft that is otherwise valid, so every failure below is about questions. */
const draft = (questions: ApiBookingQuestion[]) => ({
  form: { ...DEFAULT_FORM, name: "Ter" },
  rules: [blankRule()],
  questions,
  look: {},
  mirrorMap: {},
});

const q = (over: Partial<ApiBookingQuestion>): ApiBookingQuestion => ({
  ...blankQuestion(),
  ...over,
});

describe("a row that has been added but not typed into", () => {
  test("pressing Add question does not put the draft in a failed state", () => {
    // The bug: `blankQuestion()` tripped the `!q.name` check on the very first
    // autosave, so the button answered with "Give every question a label."
    // before there was anywhere to type one.
    expect(problemWith(draft([blankQuestion()]))).toBeNull();
  });

  test("two of them do not read as a duplicate stored name", () => {
    expect(problemWith(draft([blankQuestion(), blankQuestion()]))).toBeNull();
  });

  test("a blank row set to Choice does not demand options", () => {
    expect(problemWith(draft([q({ type: "select" })]))).toBeNull();
  });

  test("it is not sent to the server", () => {
    expect(bodyOf(draft([blankQuestion()])).questions).toEqual([]);
  });

  test("it does not displace the real questions around it", () => {
    const body = bodyOf(draft([q({ name: "reason", label: "Reason" }), blankQuestion()]));
    expect(body.questions).toHaveLength(1);
    expect(body.questions[0]!.name).toBe("reason");
  });
});

describe("a question that is genuinely incomplete still blocks the save", () => {
  test("a label with nothing nameable in it says so, and names itself", () => {
    const p = problemWith(draft([q({ label: "???", name: "" })]));
    expect(p).toEqual({ code: "question-label", label: "???" });
  });

  test("two questions may not share one stored name", () => {
    const p = problemWith(draft([q({ label: "Reason", name: "reason" }), q({ label: "Reason ", name: "reason" })]));
    expect(p).toEqual({ code: "question-duplicate", name: "reason" });
  });

  test("a choice with no options is still refused", () => {
    const p = problemWith(draft([q({ label: "Visit", name: "visit", type: "select", options: [] })]));
    expect(p).toEqual({ code: "question-options", label: "Visit" });
  });
});

describe("a stored question whose label was cleared is not a blank row", () => {
  // Retyping the label of an answered question must not move its name, so the
  // name survives while the label is empty. That is a real question, and
  // `bodyOf` falls back to the name for its label.
  const stored = q({ name: "reason_for_visit", label: "" });

  test("it is not treated as blank", () => {
    expect(isBlankQuestion(stored)).toBe(false);
  });

  test("it is still sent, labelled by its name", () => {
    const body = bodyOf(draft([stored]));
    expect(body.questions).toHaveLength(1);
    expect(body.questions[0]!.label).toBe("reason_for_visit");
  });
});

describe("questionName folds accents rather than dropping them", () => {
  test("a Turkish label keeps its letters", () => {
    // Unfolded this was "do_um_tarihi" — an underscore where the ğ was.
    expect(questionName("Doğum tarihi")).toBe("dogum_tarihi");
    expect(questionName("Şikayet")).toBe("sikayet");
  });

  test("a label with no ASCII in it still yields a name", () => {
    // Unfolded this was "", which reported a missing label at a labelled
    // question and left the operator nothing to type to clear it.
    expect(questionName("ÇÖĞÜŞİ")).toBe("cogusi");
    expect(problemWith(draft([q({ label: "ÇÖĞÜŞİ", name: questionName("ÇÖĞÜŞİ") })]))).toBeNull();
  });

  test("slugKey is unchanged by sharing the fold", () => {
    expect(slugKey("Kuaför Ayşe")).toBe("kuafor-ayse");
    expect(slugKey("Reason for visit")).toBe("reason-for-visit");
  });
});
