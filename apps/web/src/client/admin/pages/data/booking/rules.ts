
import {
  type ApiBookingRule,
} from "../../../api";

// The value sets the pickers below may emit. `Select` hands its handler a bare
// `string`, so each of these is the list that string is narrowed back against
// before it is written into a typed field.
export const RULE_KINDS = ["open", "block"] as const;

/** Where a fresh opening starts and ends, and where a fresh break does. */
export const DEFAULT_OPEN = { startMinute: 9 * 60, endMinute: 17 * 60 };

export const DEFAULT_BREAK = { startMinute: 12 * 60, endMinute: 13 * 60 };

/**
 * A recurring daily break, read back off the rules that store it.
 *
 * There is no "break" in the schema — a break IS a set of block rules, and this
 * page must not invent a second place for one to live. So the card is a VIEW:
 * it recognises the shape (weekday-scoped, undated blocks that all agree on
 * their hours) and edits exactly those rows. Anything that does not fit the
 * shape — a block on a date range, two blocks at different hours — is not a
 * "break" this can speak for, and stays in the list below where it can be read
 * for what it is.
 */
interface DailyBreak {
  startMinute: number;
  endMinute: number;
  weekdays: number[];
}

export const readBreak = (rules: ApiBookingRule[]): DailyBreak | null => {
  const blocks = rules.filter(
    (r) => r.kind === "block" && r.weekday !== null && !r.startsOn && !r.endsOn,
  );
  const first = blocks[0];
  if (!first) return null;
  // Blocks that disagree about their hours are several different closures, not
  // one break with a typo in it. Claiming otherwise would rewrite hours the
  // operator never pointed the card at.
  if (blocks.some((b) => b.startMinute !== first.startMinute || b.endMinute !== first.endMinute))
    return null;
  return {
    startMinute: first.startMinute,
    endMinute: first.endMinute,
    weekdays: [...new Set(blocks.map((b) => Number(b.weekday)))].sort((a, b) => a - b),
  };
};

/** Is this row one of the ones the break card is speaking for? Must agree with
 *  `readBreak` exactly, or a rule is drawn twice or not at all. */
export const isBreakRule = (r: ApiBookingRule, brk: DailyBreak | null): boolean =>
  brk !== null &&
  r.kind === "block" &&
  r.weekday !== null &&
  !r.startsOn &&
  !r.endsOn &&
  r.startMinute === brk.startMinute &&
  r.endMinute === brk.endMinute;

export const blankRule = (): ApiBookingRule => ({
  kind: "open",
  weekday: 1,
  startMinute: 9 * 60,
  endMinute: 17 * 60,
  startsOn: null,
  endsOn: null,
  reason: null,
});
