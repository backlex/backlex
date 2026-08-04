// The value editor for a slug field — the URL handle, typed freely and shown as
// the one the server will store.
//
// The design is inherited from `field-email-input.tsx` and, through it, from
// `field-phone-input.tsx`, including the bug that shaped both: **what the
// operator SEES is local state; what the FORM holds is the canonical value.**
// Committing the canonical form on every keystroke means pressing Save without
// leaving the box submits what the hint underneath promised.
//
// What it fixes that is specific to this field: the previous version folded the
// visible text on every keystroke, with `[^a-z0-9-]+ → "-"` and no trim. That
// had two consequences, and both were live.
//
//   1. It produced values the column REJECTED. A leading space, a trailing
//      space or a trailing `&` left a leading/trailing hyphen, which the slug
//      shape refuses — so typing in the box the product supplied earned a 422
//      naming the field you were typing into.
//   2. It made a hyphen impossible to type. Folding-and-trimming on keystroke
//      turns `my-` into `my`, so the next character lands as `myp`.
//
// Not folding the visible text solves both: the box holds exactly what was
// typed, the form holds `slugify` of it, and the two are reconciled on blur.
import { useEffect, useRef, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { Input } from "@backlex/ui/components/input";
import { SLUG_MAX_DEFAULT, slugify } from "@backlex/db/slug";
import { I } from "./icons";

interface SlugInputProps {
  value: unknown;
  onChange: (v: string | null) => void;
  /** Field's `slug.maxLength`, so the preview truncates where the server will. */
  maxLength?: number;
  /**
   * Label of the column this slug is folded from, when the field declares one —
   * used only for the "derived from X" hint on an empty box.
   */
  fromLabel?: string | null;
  disabled?: boolean;
  invalid?: boolean;
}

export const SlugInput = ({
  value,
  onChange,
  maxLength,
  fromLabel,
  disabled,
  invalid,
}: SlugInputProps) => {
  const { t } = useLingui();
  const external = typeof value === "string" ? value : value == null ? "" : String(value);
  const [text, setText] = useState(external);
  const emitted = useRef(external);
  // Resync when the row changes underneath us — loading a record, a reset, or
  // the form's own auto-derive filling this in as the title is typed. That last
  // one is why the guard compares against what WE emitted rather than blocking
  // all external writes: the derive has to reach the box, a half-typed slug of
  // our own must not be snapped back.
  useEffect(() => {
    if (external !== emitted.current) {
      setText(external);
      emitted.current = external;
    }
  }, [external]);

  const cap = maxLength ?? SLUG_MAX_DEFAULT;
  const canonical = slugify(text, cap);
  // Shown only when folding actually changed something — under a box already
  // holding `my-first-post`, "saved as my-first-post" is noise, and noise is
  // what trains people to stop reading the line that matters.
  const foldedTo = canonical && canonical !== text ? canonical : null;
  // Text that folds to nothing at all: a title in a script this cannot
  // romanize, or pure punctuation. Worth saying plainly, because the box looks
  // full and the column will be empty.
  const unfoldable = text.trim() !== "" && canonical === "";

  const commit = (next: string) => {
    setText(next);
    const out = slugify(next, cap);
    emitted.current = out;
    onChange(out === "" ? null : out);
  };

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Input
        className="min-w-0 font-mono"
        value={text}
        disabled={disabled}
        aria-invalid={invalid || unfoldable || undefined}
        spellCheck={false}
        autoComplete="off"
        placeholder={t`my-post-slug`}
        onChange={(e) => commit(e.target.value)}
        // Snap the visible text to the stored form once the operator is done
        // with it. Doing this on blur rather than on keystroke is what keeps a
        // hyphen typeable.
        onBlur={() => setText(canonical)}
      />
      {unfoldable ? (
        <p className="text-xs text-destructive">
          <Trans>
            This text has no Latin letters to build a URL from — type a slug in
            the Latin alphabet.
          </Trans>
        </p>
      ) : foldedTo ? (
        <p className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
          <I.Link size={12} className="shrink-0" />
          <Trans>Saved as</Trans>{" "}
          <code className="min-w-0 truncate font-mono">{foldedTo}</code>
        </p>
      ) : text === "" && fromLabel ? (
        <p className="text-xs text-muted-foreground">
          <Trans>Left empty, this is built from</Trans>{" "}
          <span className="font-medium">{fromLabel}</span>
        </p>
      ) : null}
    </div>
  );
};
