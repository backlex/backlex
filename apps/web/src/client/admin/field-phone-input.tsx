// The value editor for a `phone` field — a number typed the way people type
// numbers, shown as the one the server will store.
//
// The whole design is one idea: **canonicalization is invisible until it isn't.**
// An operator types `0532 111 22 33` because that is how the number is written
// on the form in front of them, and the field saves `+905321112233`. If those
// two are never shown together, the first time anyone learns the value changed
// is when they notice the list column looks different from what they typed — so
// the input prints the canonical form underneath as it is typed, from the SAME
// parser the server uses (`@backlex/db/phone`, which is dependency-free
// precisely so the browser can run it). What the preview says is what a save
// produces; they cannot drift, because there is only one implementation.
//
// The region selector is next to the input rather than in the field's settings
// because the field's `region` is only a DEFAULT: a workspace in Turkey with one
// German supplier needs that row to be `+49…`, and forcing the operator into the
// schema editor to say so would be absurd. Picking a region here changes how the
// NATIONAL number in the box is read; a number already written with `+` ignores
// it entirely, which is why the selector greys out when one is.
import { useEffect, useMemo, useRef, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { Input } from "@backlex/ui/components/input";
import {
  CALLING_CODES,
  callingCodeFor,
  formatPhone,
  parsePhone,
  parsePhoneForField,
  type PhoneDisplay,
} from "@backlex/db/phone";
import { I } from "./icons";

interface PhoneInputProps {
  value: unknown;
  onChange: (v: string | null) => void;
  /** The field's default region (ISO alpha-2), when it has one. */
  region?: string;
  /** Region for THIS row, read live off a sibling column (`phone.regionField`).
   *  Beats the field default, exactly as it does on the server. */
  rowRegion?: string;
  /** Calling codes the field restricts to, for the message shown on refusal. */
  allowedRegions?: string[];
  display?: PhoneDisplay;
  disabled?: boolean;
  invalid?: boolean;
  onRegionChange?: (region: string) => void;
}

/** Regions offered in the selector, labelled with their calling code. Sorted by
 *  code so the list reads as a phone book rather than as an alphabet. */
const REGION_OPTIONS = Object.entries(CALLING_CODES)
  .map(([region, code]) => ({ region, code }))
  .sort((a, b) => Number(a.code) - Number(b.code) || a.region.localeCompare(b.region));

// There is deliberately NO browser-locale default for the region selector.
//
// It was tried, and the real-screen pass caught what it does: on a field with no
// configured region, an `en-US` browser silently read `0532 999 88 77` as a NANP
// number and previewed `+105329998877` — a string that satisfies E.164's
// envelope, looks like a phone number, and dials nothing. That is precisely the
// failure this whole type refuses to produce, arriving through the one door that
// was supposed to be a convenience.
//
// So the selector starts EMPTY when the field says nothing, the placeholder asks
// for international form, and a national number is refused until an operator
// picks a country themselves. Picking one is a deliberate act; inheriting one
// from a browser's language settings is not.

export const PhoneInput = ({
  value,
  onChange,
  region,
  rowRegion,
  allowedRegions,
  display,
  disabled,
  invalid,
  onRegionChange,
}: PhoneInputProps) => {
  const { t } = useLingui();
  // What the operator SEES is local state; what the FORM holds is the canonical
  // value. Splitting the two is the whole correctness argument of this
  // component, and it is not a refinement — the first version committed the raw
  // text and canonicalized on blur, and a real-screen pass caught what that
  // costs: pick a country, type a national number, press Save without leaving
  // the box, and the form submits the raw text. The server, which never saw the
  // country you picked, rejects it — while the hint underneath is still
  // promising the exact value that would have worked.
  //
  // Committing the canonical form on every keystroke instead makes the promise
  // true at all times, with no blur to race. The visible box is never rewritten
  // mid-number, because it is not what is being committed.
  const external = typeof value === "string" ? value : value == null ? "" : String(value);
  const [text, setText] = useState(external);
  const emitted = useRef(external);
  // Resync when the row changes underneath us (loading a record, a reset, an
  // undo) — but NOT when the new value is simply what we just emitted, which
  // would snap the half-typed box to its own canonical form.
  useEffect(() => {
    if (external !== emitted.current) {
      setText(external);
      emitted.current = external;
    }
  }, [external]);
  const raw = text;
  // The selector is a PARSING HINT, not stored data — whichever region is
  // picked, the column receives E.164. So it stays usable even on a field with
  // no `regionField` to write back to: a Turkish workspace entering one German
  // supplier should not have to open the schema editor, and does not have to,
  // because nothing about that choice is persisted. When the field DOES name a
  // sibling region column, `onRegionChange` additionally sets it, so the row
  // records the country and a later edit resolves the same way.
  const [picked, setPicked] = useState<string | null>(null);
  const configured = rowRegion && callingCodeFor(rowRegion) ? rowRegion : region;
  const effectiveRegion = picked ?? configured;
  // The user has stated the country themselves; the selector cannot change what
  // this parses to, so it is disabled rather than left looking meaningful.
  const explicitlyInternational = raw.trim().startsWith("+") || raw.trim().startsWith("00");

  const parsed = useMemo(() => {
    if (!raw.trim()) return { e164: null as string | null, error: null as string | null };
    try {
      const p = parsePhone(raw, effectiveRegion ?? null);
      const allowed = allowedRegions?.length
        ? new Set(allowedRegions.map((r) => callingCodeFor(r)).filter(Boolean))
        : null;
      if (allowed && p.callingCode && !allowed.has(p.callingCode)) {
        return {
          e164: null,
          error: t`Not one of the countries this field allows.`,
        };
      }
      return { e164: p.e164, error: null };
    } catch (e) {
      return { e164: null, error: (e as Error).message };
    }
  }, [raw, effectiveRegion, allowedRegions, t]);

  /**
   * Show `next`, and hand the FORM the canonical value it stands for.
   *
   * When it does not parse yet — mid-typing, or genuinely wrong — the raw text
   * is committed instead, so the server produces the error rather than the write
   * silently going through with a stale value from two keystrokes ago.
   */
  const commit = (next: string) => {
    setText(next);
    let out: string | null = next === "" ? null : next;
    if (next.trim()) {
      try {
        out = parsePhoneForField(
          next,
          { region: effectiveRegion ?? undefined, allowedRegions },
        ).e164;
      } catch {
        // Reported by the hint below; the raw value travels so the server's own
        // message is the one the operator ends up seeing.
      }
    }
    emitted.current = out ?? "";
    onChange(out);
  };

  // Re-canonicalize what is already typed when the country changes underneath
  // it. Without this, picking a region after typing updates the hint and leaves
  // the form holding the pre-selection value — the same promise-vs-payload split
  // this component exists to close.
  const changeRegion = (next: string) => {
    setPicked(next === "" ? null : next);
    onRegionChange?.(next);
  };
  useEffect(() => {
    if (text.trim()) commit(text);
    // Only when the region moves; `commit` reads the latest text off state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveRegion]);

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex min-w-0 items-center gap-2">
        {/* A finite set of values, so it is directly selectable rather than
            typed — and it hugs the input so the pair reads as one control. */}
        <select
          className="h-9 shrink-0 rounded-md border border-input bg-transparent px-2 text-sm disabled:opacity-50"
          value={effectiveRegion ?? ""}
          disabled={disabled || explicitlyInternational}
          onChange={(e) => changeRegion(e.target.value)}
          aria-label={t`Country the typed number is read as`}
          title={
            explicitlyInternational
              ? t`This number already states its country code.`
              : t`Country a national number is read as`
          }
        >
          <option value="">{t`—`}</option>
          {REGION_OPTIONS.map((o) => (
            <option key={o.region} value={o.region}>
              {o.region} +{o.code}
            </option>
          ))}
        </select>
        <Input
          className="min-w-0 flex-1"
          value={raw}
          disabled={disabled}
          aria-invalid={invalid || !!parsed.error || undefined}
          inputMode="tel"
          autoComplete="tel"
          placeholder={effectiveRegion ? t`0532 111 22 33` : t`+90 532 111 22 33`}
          onChange={(e) => commit(e.target.value)}
        />
      </div>
      {parsed.error ? (
        <p className="text-xs text-destructive">{parsed.error}</p>
      ) : parsed.e164 ? (
        <p className="flex items-center gap-1 text-xs text-muted-foreground">
          <I.Phone size={12} />
          <Trans>Saved as</Trans>{" "}
          <code className="font-mono">{formatPhone(parsed.e164, display)}</code>
        </p>
      ) : !raw.trim() && !effectiveRegion ? (
        <p className="text-xs text-muted-foreground">
          <Trans>Write the number in full international form, starting with +.</Trans>
        </p>
      ) : null}
    </div>
  );
};
