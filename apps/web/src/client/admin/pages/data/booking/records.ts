
import {
  type ApiBookingQuestion,
  type ApiBookingRule,
} from "../../../api";
import {
  type PublicAppearance,
} from "@/lib/public-theme";
import { isBlankQuestion } from "./questions";

export const DEFAULT_FORM = {
  key: "",
  name: "",
  description: "",
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  slotMinutes: "30",
  capacity: "1",
  bufferBeforeMinutes: "0",
  bufferAfterMinutes: "0",
  leadMinutes: "0",
  horizonDays: "60",
  holdMinutes: "10",
  confirmationMessage: "",
  mirrorEnabled: true,
  mirrorCollection: "",
  active: true,
};

/** The ledger keys a custom field map may point a column at. The default
 *  collection derives its own, so this list is only ever shown for a target the
 *  workspace owns. Intake answers are reachable by question name too, but they
 *  are per resource and so are offered next to the questions instead. */
/** The slug the platform provisions. Mirrors `BOOKING_COLLECTION_SLUG` on the
 *  server; the panel needs the name before any resource has been saved, which
 *  is the one moment the server's own answer is not available yet. */
export const DEFAULT_RECORD_COLLECTION = "booking_records";

export const MIRROR_KEYS = [
  "booking",
  "start",
  "end",
  "name",
  "email",
  "phone",
  "status",
  "resource",
  "source",
  "notes",
] as const;

/** The draft as the API takes it. Pulled out of the component so the autosave
 *  timer can build it from a ref rather than from a closed-over render. */
export const bodyOf = (d: {
  form: typeof DEFAULT_FORM;
  rules: ApiBookingRule[];
  questions: ApiBookingQuestion[];
  look: PublicAppearance;
  mirrorMap: Record<string, string>;
}) => ({
  name: d.form.name.trim(),
  description: d.form.description.trim() || null,
  timeZone: d.form.timeZone.trim(),
  slotMinutes: Number(d.form.slotMinutes) || 30,
  capacity: Number(d.form.capacity) || 1,
  bufferBeforeMinutes: Number(d.form.bufferBeforeMinutes) || 0,
  bufferAfterMinutes: Number(d.form.bufferAfterMinutes) || 0,
  leadMinutes: Number(d.form.leadMinutes) || 0,
  horizonDays: Number(d.form.horizonDays) || 60,
  holdMinutes: Number(d.form.holdMinutes) || 10,
  confirmationMessage: d.form.confirmationMessage.trim() || null,
  mirrorEnabled: d.form.mirrorEnabled,
  mirrorCollection: d.form.mirrorCollection.trim() || null,
  // Only meaningful for a custom target; the default derives its map, and
  // sending one for it would be storing an answer that can go stale.
  mirrorFieldMap: d.form.mirrorCollection.trim() ? d.mirrorMap : null,
  active: d.form.active,
  rules: d.rules.map((r) => ({
    kind: r.kind,
    weekday: r.weekday,
    startMinute: r.startMinute,
    endMinute: r.endMinute,
    startsOn: r.startsOn,
    endsOn: r.endsOn,
    reason: r.reason,
  })),
  // Options only travel with a choice: a question that was a dropdown and is
  // now free text would otherwise keep clamping its own answers server-side.
  // A row nobody has typed into yet is not sent at all — see `isBlankQuestion`.
  questions: d.questions.filter((q) => !isBlankQuestion(q)).map((q) => ({
    name: q.name,
    label: q.label?.trim() || q.name,
    type: q.type ?? "text",
    required: q.required === true,
    ...(q.type === "select" ? { options: (q.options ?? []).filter((o) => o.trim() !== "") } : {}),
  })),
  // An empty panel is stored as null rather than `{}` — "the defaults" is a
  // state the reader already has, and two spellings of it would eventually
  // disagree.
  settings: Object.keys(d.look).length > 0 ? d.look : null,
});

/**
 * Why this draft cannot be saved yet, or null.
 *
 * With a Save button these were toasts fired on a click. Autosave fires on a
 * keystroke, so they are a state instead: the save is held back, the toolbar
 * says which one, and nothing is lost while it is fixed. Half-typed work is
 * the normal case here, not an error to shout about.
 *
 * A CODE, not a sentence — deliberately. The `t` macro only rewrites tagged
 * templates it finds inside a component, so a message built out here would
 * leave a raw call to whatever was passed in as `t` and quietly answer with
 * something falsy, which is to say: it would never block anything. The wording
 * lives at the one call site that has the real macro in scope.
 */
export type Problem =
  | { code: "name" }
  | { code: "rule-order" }
  | { code: "rule-dates" }
  | { code: "rule-range" }
  | { code: "question-label"; label: string }
  | { code: "question-duplicate"; name: string }
  | { code: "question-options"; label: string }
  | { code: "mirror-map"; collection: string };

export const problemWith = (d: {
  form: typeof DEFAULT_FORM;
  rules: ApiBookingRule[];
  questions: ApiBookingQuestion[];
  mirrorMap: Record<string, string>;
}): Problem | null => {
  if (!d.form.name.trim()) return { code: "name" };
  for (const r of d.rules) {
    if (r.startMinute >= r.endMinute) return { code: "rule-order" };
    // Either bound alone is a range — "from the 7th onwards", "until the 7th"
    // — which is what the server accepts too. Demanding a start here blocked
    // a draft the API would have taken.
    if (r.weekday === null && !r.startsOn && !r.endsOn) return { code: "rule-dates" };
    if (r.startsOn && r.endsOn && r.startsOn > r.endsOn) return { code: "rule-range" };
  }
  // The name is the key the answer is stored under, so two questions sharing
  // one would silently overwrite each other on every booking.
  const seen = new Set<string>();
  for (const q of d.questions) {
    // An untouched row is not yet a question, so it is not yet wrong either.
    if (isBlankQuestion(q)) continue;
    // Past the blank check, a missing name means the label is there but has
    // nothing `questionName` can keep — punctuation, or emoji alone.
    if (!q.name) return { code: "question-label", label: (q.label ?? "").trim() };
    if (seen.has(q.name)) return { code: "question-duplicate", name: q.name };
    seen.add(q.name);
    if (q.type === "select" && (q.options ?? []).filter((o) => o.trim() !== "").length === 0)
      return { code: "question-options", label: q.label || q.name };
  }
  // The server refuses a custom target with no map, and it is right to — but
  // picking the collection and typing its columns are two moves, and firing the
  // refusal between them shows a failure for a state the operator is halfway
  // through making. Held here as a half-finished draft, like every other one.
  const target = d.form.mirrorCollection.trim();
  if (
    d.form.mirrorEnabled &&
    target &&
    Object.values(d.mirrorMap).filter((c) => c.trim()).length === 0
  ) {
    return { code: "mirror-map", collection: target };
  }
  return null;
};
