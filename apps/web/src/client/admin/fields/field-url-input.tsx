// The value editor for a `url` field — an address typed the way people type
// addresses, shown as the one the server will store.
//
// The design is inherited wholesale from `field-email-input.tsx` and, through
// it, from `field-phone-input.tsx` — including the bug that shaped both: **what
// the operator SEES is local state; what the FORM holds is the canonical
// value.** Phone's first version committed the raw text and canonicalized on
// blur, and a real-screen pass caught what that costs — type into the box, press
// Save without leaving it, and the form submits the pre-canonical value while
// the hint underneath promises the one that would have worked. Committing the
// canonical form on every keystroke makes the promise true at all times, with no
// blur to race.
//
// A URL changes shape more often than an address does — the scheme gets
// supplied, the root slash appears, a default port disappears — so the "saved
// as" line earns its place here more than it does on email. It still shows only
// when folding actually changed something.
import { useEffect, useRef, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { Input } from "@backlex/ui/components/input";
import {
  formatUrl,
  parseUrlForField,
  tryParseUrl,
  type UrlDisplay,
  type UrlForm,
} from "@backlex/db/url";
import { I } from "../icons";

interface UrlInputProps {
  value: unknown;
  onChange: (v: string | null) => void;
  /** Whole address or bare host — changes what is stored, so it drives parsing. */
  form?: UrlForm;
  /** Schemes the field accepts, for the message shown on refusal. */
  schemes?: string[];
  /** Hosts the field restricts to, for the same reason. */
  allowedHosts?: string[];
  display?: UrlDisplay;
  disabled?: boolean;
  invalid?: boolean;
}

export const UrlInput = ({
  value,
  onChange,
  form,
  schemes,
  allowedHosts,
  display,
  disabled,
  invalid,
}: UrlInputProps) => {
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

  const spec = { form, schemes, allowedHosts };
  let canonical: string | null = null;
  let error: string | null = null;
  if (text.trim()) {
    try {
      canonical = parseUrlForField(text, spec).url;
    } catch (e) {
      // Mid-typing, `htt` and `acme.` are "not a URL", and saying so on every
      // keystroke is nagging rather than helping. The complaint is held back
      // until the value at least looks finished — a dot with something after it,
      // or a scheme already spelled out — which is the earliest point the
      // objection is about the address rather than about it being half-typed.
      const trimmed = text.trim();
      const dot = trimmed.lastIndexOf(".");
      const looksFinished =
        trimmed.includes("://") || (dot > 0 && dot < trimmed.length - 1);
      error = looksFinished ? (e as Error).message : null;
    }
  }
  // Shown only when folding actually changed something — see the header note.
  const foldedTo = canonical && canonical !== text.trim() ? canonical : null;
  // An internationalized host stores its A-label, which is unreadable. The
  // U-label is shown next to it so an operator can see it is the host they
  // meant, and is never what the form holds.
  const readable = canonical ? formatUrl(canonical, "unicode", form) : null;
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
      // `tryParseUrl` with the rules that govern SHAPE only — a host the field
      // does not allow still folds correctly, and committing the folded form
      // means the server's refusal names the host rule rather than complaining
      // about a shape that was never the problem.
      const parsed = tryParseUrl(next, { form, schemes });
      if (parsed) out = parsed.url;
    }
    emitted.current = out ?? "";
    onChange(out);
  };

  const isHost = form === "host";

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex min-w-0 items-center gap-1.5">
        <Input
          className="min-w-0 flex-1"
          value={text}
          disabled={disabled}
          aria-invalid={invalid || !!error || undefined}
          inputMode="url"
          autoComplete="url"
          spellCheck={false}
          placeholder={isHost ? t`acme.com` : t`https://acme.com`}
          onChange={(e) => commit(e.target.value)}
        />
        {/* Open the stored address. A link-out is the single most useful thing a
            URL cell can offer and the plain `<Input>` this replaces had none.
            It is an anchor rather than a button so the browser's own
            middle-click and copy-link affordances work, and `noreferrer` keeps
            the admin's URL out of the target's logs. Hidden for a host column,
            which is a domain and not somewhere to navigate to. */}
        {!isHost && canonical ? (
          <a
            href={canonical}
            target="_blank"
            rel="noopener noreferrer"
            title={t`Open in a new tab`}
            className="shrink-0 rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <I.ExternalLink size={14} />
          </a>
        ) : null}
      </div>
      {error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : foldedTo || isIdn ? (
        <p className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
          <I.Link size={12} className="shrink-0" />
          {/* `shrink-0 whitespace-nowrap`: at 390px the flex row is tight enough
              that this two-word label wraps onto its own second line, which reads
              as a broken sentence next to the icon. The value beside it is the
              part that should give way, and it already truncates. */}
          <span className="shrink-0 whitespace-nowrap">
            <Trans>Saved as</Trans>
          </span>{" "}
          <code className="min-w-0 truncate font-mono">
            {display === "unicode" && readable ? readable : (foldedTo ?? canonical)}
          </code>
          {isIdn && display !== "unicode" ? (
            <span className="shrink-0 truncate">({readable})</span>
          ) : null}
        </p>
      ) : allowedHosts?.length ? (
        <p className="text-xs text-muted-foreground">
          <Trans>Must be at</Trans> <code className="font-mono">{allowedHosts.join(", ")}</code>
        </p>
      ) : schemes?.length === 1 ? (
        <p className="text-xs text-muted-foreground">
          <Trans>Must be a</Trans> <code className="font-mono">{schemes[0]}</code>{" "}
          <Trans>address</Trans>
        </p>
      ) : null}
    </div>
  );
};
