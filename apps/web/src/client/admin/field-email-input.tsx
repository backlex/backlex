// The value editor for an `email` field — an address typed the way people type
// addresses, shown as the one the server will store.
//
// The design is inherited wholesale from `field-phone-input.tsx`, including the
// bug that shaped it: **what the operator SEES is local state; what the FORM
// holds is the canonical value.** Phone's first version committed the raw text
// and canonicalized on blur, and a real-screen pass caught what that costs —
// type into the box, press Save without leaving it, and the form submits the
// pre-canonical value while the hint underneath promises the one that would have
// worked. Committing the canonical form on every keystroke makes the promise
// true at all times, with no blur to race.
//
// Where it differs from phone is what the hint SAYS. Nearly every phone number a
// person types changes shape, so phone prints the canonical form always. Most
// addresses are already canonical, so printing "saved as ada@example.com" under
// `ada@example.com` would be pure noise on the common case and would train
// operators to stop reading it. It shows up only when folding actually changed
// something — which is exactly when someone needs to be told.
import { useEffect, useRef, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { Input } from "@backlex/ui/components/input";
import {
  type EmailDisplay,
  formatEmail,
  parseEmailForField,
  tryParseEmail,
} from "@backlex/db/email";
import { I } from "./icons";

interface EmailInputProps {
  value: unknown;
  onChange: (v: string | null) => void;
  /** Domains the field restricts to, for the message shown on refusal. */
  allowedDomains?: string[];
  /** Keep the case of the local part, matching the field's own setting. */
  caseSensitiveLocal?: boolean;
  display?: EmailDisplay;
  disabled?: boolean;
  invalid?: boolean;
}

export const EmailInput = ({
  value,
  onChange,
  allowedDomains,
  caseSensitiveLocal,
  display,
  disabled,
  invalid,
}: EmailInputProps) => {
  const { t } = useLingui();
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

  const spec = { caseSensitiveLocal, allowedDomains };
  let canonical: string | null = null;
  let error: string | null = null;
  if (text.trim()) {
    try {
      canonical = parseEmailForField(text, spec).email;
    } catch (e) {
      // Mid-typing, `ada@ex` is "not an address" and saying so on every keystroke
      // is nagging rather than helping. The message is held back until the value
      // at least looks finished — an `@` with something after it — which is the
      // earliest point a complaint is about the address rather than about the
      // fact that it is not typed yet.
      const at = text.indexOf("@");
      const looksFinished = at > 0 && text.slice(at + 1).includes(".");
      error = looksFinished ? (e as Error).message : null;
    }
  }
  // Shown only when folding actually changed something — see the header note.
  const foldedTo = canonical && canonical !== text.trim() ? canonical : null;
  // An internationalized domain stores its A-label, which is unreadable. The
  // U-label is shown next to it so an operator can see it is the domain they
  // meant, and is never what the form holds.
  const readable = canonical ? formatEmail(canonical, "unicode") : null;
  const isIdn = !!(canonical && readable && readable !== canonical);

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
      const parsed = tryParseEmail(next, spec);
      // `tryParseEmail`, not `parseEmailForField` — a domain the field does not
      // allow still FOLDS correctly, and committing the folded form means the
      // server's refusal names the domain rule rather than complaining about a
      // shape that was never the problem.
      if (parsed) out = parsed.email;
    }
    emitted.current = out ?? "";
    onChange(out);
  };

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Input
        className="min-w-0"
        value={text}
        disabled={disabled}
        aria-invalid={invalid || !!error || undefined}
        inputMode="email"
        autoComplete="email"
        spellCheck={false}
        placeholder={t`ada@example.com`}
        onChange={(e) => commit(e.target.value)}
      />
      {error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : foldedTo || isIdn ? (
        <p className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
          <I.Mail size={12} className="shrink-0" />
          <Trans>Saved as</Trans>{" "}
          <code className="min-w-0 truncate font-mono">
            {display === "unicode" && readable ? readable : (foldedTo ?? canonical)}
          </code>
          {isIdn && display !== "unicode" ? (
            <span className="shrink-0 truncate">({readable})</span>
          ) : null}
        </p>
      ) : allowedDomains?.length ? (
        <p className="text-xs text-muted-foreground">
          <Trans>Must be an address at</Trans>{" "}
          <code className="font-mono">{allowedDomains.join(", ")}</code>
        </p>
      ) : null}
    </div>
  );
};
