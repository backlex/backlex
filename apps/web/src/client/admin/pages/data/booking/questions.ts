
import {
  type ApiBookingQuestion,
} from "../../../api";

export const QUESTION_TYPES = ["text", "textarea", "select", "boolean"] as const;

/** What the booker is asked beyond name and address. Mirrors the server's
 *  `MAX_QUESTIONS`, so the button stops offering what the API would refuse. */
export const MAX_QUESTIONS = 20;

export const blankQuestion = (): ApiBookingQuestion => ({
  name: "",
  label: "",
  type: "text",
  required: false,
  options: [],
});

/**
 * A row that has been added but not started.
 *
 * "Add question" puts one on screen, and between that click and the first
 * keystroke it is not a half-typed question — it is no question at all.
 * Counting it as one is what made the button answer with "Give every question a
 * label." before there was anywhere to type the label. So it is skipped by
 * `problemWith` and dropped by `bodyOf`, the same way an empty option entry
 * already survives the keystroke and is filtered on the way out.
 *
 * The name is checked as well as the label because a question that already has
 * answers stored against it keeps its name when its label is cleared — that one
 * is a real question with a blank label, not a blank row, and `bodyOf` falls
 * back to the name for it.
 */
export const isBlankQuestion = (q: ApiBookingQuestion): boolean =>
  !(q.label ?? "").trim() && !(q.name ?? "").trim();

/** What a question is rendered as. Options are decisive — a question carrying
 *  them is a choice whatever its type says — and this has to agree with the
 *  public page's own reading, or the operator's form and the booker's would
 *  disagree about what a question is. */
export const questionKind = (q: ApiBookingQuestion): "text" | "textarea" | "select" | "boolean" => {
  if (Array.isArray(q.options) && q.options.length > 0) return "select";
  const raw = String(q.type ?? "text");
  return raw === "textarea" || raw === "boolean" ? raw : "text";
};

/**
 * Lowercase, with accented letters folded to their plain form.
 *
 * Folded rather than dropped: a plain a–z filter turns "Kuaför Ayşe" into
 * "kuaf-r-ay-e", which is not a name anybody would choose and is the first
 * thing a Turkish operator sees this page do. NFD splits most of them into a
 * letter plus a combining mark the strip then removes; the ones with no
 * decomposition — Turkish dotless ı, German ß, Nordic ø/å/æ — have no mark to
 * drop and are spelled out here.
 */
const FOLD: Record<string, string> = {
  ı: "i", ß: "ss", ø: "o", å: "a", æ: "ae", œ: "oe", đ: "d", ħ: "h", ł: "l", ŧ: "t",
};

const foldAscii = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[ıßøåæœđħłŧ]/g, (ch) => FOLD[ch] ?? ch)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

/**
 * The stored key an answer lands under — and, when the resource mirrors, the
 * column name a `--map` entry points at. Underscores rather than dashes for
 * exactly that reason: it has to be usable as a column.
 *
 * Folded like the resource key, and for a sharper reason than tidiness: this
 * name is what tells a real question apart from a row nobody has typed into.
 * A plain a–z filter turns "Doğum tarihi" into "do_um_tarihi", and a label with
 * no ASCII in it at all into the empty string — at which point the page reports
 * "Give every question a label." against a question whose label is on screen,
 * and there is nothing the operator can type to clear it.
 */
export const questionName = (s: string): string =>
  foldAscii(s).replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60);

/** The key suggested for a new resource, from its name. */
export const slugKey = (s: string): string =>
  foldAscii(s).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
