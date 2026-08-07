// Shared email editor — the Email tab of the Add / Edit field dialogs, shown for
// the `email` interface.
//
// Everything here is optional, and the default is the useful one: a bare email
// field accepts any well-formed address and folds it. That is the opposite of
// phone's default, and deliberately so — phone refuses a national number because
// `0532 111 22 33` is a real number in dozens of countries and picking one would
// silently store a number that dials elsewhere, whereas an address is
// unambiguous on its own and an address book has no business refusing a domain
// it has not heard of.
//
// So this tab captures two much smaller decisions: whether to keep the case of
// the local part, and whether the column is restricted to a set of domains.
import { useMemo, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
// `Select` is in ./select and `Checkbox` in ./ui — two modules, and mixing
// them up used to be a blank admin at run time rather than a typecheck error,
// because the field dialogs were suppressed with `@ts-nocheck`. They no longer
// are, so the compiler catches it now.
import { Checkbox } from "../ui";
import { Input } from "@backlex/ui/components/input";
import { Button } from "@backlex/ui/components/button";
import { domainToUnicode, tryParseEmail } from "@backlex/db/email";
import { I } from "../icons";

export interface EmailDraft {
  /** Keep the case of the local part instead of folding it. */
  caseSensitiveLocal: boolean;
  /** Domains the column is restricted to. Empty = no restriction. */
  allowedDomains: string[];
  /** How the value renders in lists and the form hint. */
  display: "ascii" | "unicode";
}

export const emptyEmailDraft = (): EmailDraft => ({
  caseSensitiveLocal: false,
  allowedDomains: [],
  display: "ascii",
});

/** Shape the stored `email` spec, or `undefined` when nothing was configured —
 *  an empty object would be noise in every schema export. */
export const cleanEmail = (d: EmailDraft): Record<string, unknown> | undefined => {
  const out: Record<string, unknown> = {};
  if (d.caseSensitiveLocal) out.caseSensitiveLocal = true;
  if (d.allowedDomains.length > 0) out.allowedDomains = d.allowedDomains;
  // `ascii` is the default, so storing it says nothing.
  if (d.display === "unicode") out.display = d.display;
  return Object.keys(out).length > 0 ? out : undefined;
};

/** Rehydrate the draft from a stored spec, so re-opening Edit shows what is
 *  actually saved rather than an empty form. */
export const emailDraftFrom = (spec: unknown): EmailDraft => {
  const s = (spec ?? {}) as {
    caseSensitiveLocal?: boolean;
    allowedDomains?: string[];
    display?: "ascii" | "unicode";
  };
  return {
    caseSensitiveLocal: s.caseSensitiveLocal === true,
    allowedDomains: Array.isArray(s.allowedDomains) ? [...s.allowedDomains] : [],
    display: s.display === "unicode" ? "unicode" : "ascii",
  };
};

interface EmailEditorProps {
  value: EmailDraft;
  onChange: (v: EmailDraft) => void;
}

export function FieldEmailEditor({ value, onChange }: EmailEditorProps) {
  const { t } = useLingui();
  const [domainInput, setDomainInput] = useState("");

  // Judged with the same parser the server uses, so a domain that could never
  // match anything is caught while it is being typed rather than at save time.
  const domainError = useMemo(() => {
    const d = domainInput.trim();
    if (!d) return null;
    if (value.allowedDomains.includes(d)) return t`Already on the list.`;
    return tryParseEmail(`x@${d}`) ? null : t`Not a domain.`;
  }, [domainInput, value.allowedDomains, t]);

  const addDomain = () => {
    const d = domainInput.trim();
    if (!d || domainError) return;
    onChange({ ...value, allowedDomains: [...value.allowedDomains, d] });
    setDomainInput("");
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <label className="flex items-start gap-2">
          <Checkbox
            checked={value.caseSensitiveLocal}
            onChange={(v: boolean) => onChange({ ...value, caseSensitiveLocal: v })}
          />
          <span className="min-w-0">
            <span className="text-[12.5px] font-medium text-foreground">
              <Trans>Keep the case of the part before the @</Trans>
            </span>
            <span className="mt-0.5 block text-[11.5px] text-muted-foreground">
              <Trans>
                Off by default, and almost always the right answer: folding is what
                makes one mailbox one row, so `unique`, portal auto-link and
                marketing-list dedup all work. Turn it on only for a mail server
                that genuinely treats Ada@ and ada@ as two people — and note that
                `unique` then stops catching the pair.
              </Trans>
            </span>
          </span>
        </label>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-[12.5px] font-medium text-foreground">
          <Trans>Only accept addresses at these domains</Trans>
        </span>
        <div className="flex min-w-0 items-start gap-2">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <Input
              className="min-w-0"
              value={domainInput}
              placeholder={t`example.com`}
              spellCheck={false}
              aria-invalid={!!domainError || undefined}
              onChange={(e) => setDomainInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addDomain();
                }
              }}
            />
            {domainError ? (
              <span className="text-[11.5px] text-destructive">{domainError}</span>
            ) : null}
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0"
            disabled={!domainInput.trim() || !!domainError}
            onClick={addDomain}
          >
            <Trans>Add</Trans>
          </Button>
        </div>
        {value.allowedDomains.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {value.allowedDomains.map((d) => (
              <span
                key={d}
                className="inline-flex max-w-full items-center gap-1 rounded-md border border-input px-2 py-0.5 text-[11.5px]"
              >
                <span className="min-w-0 truncate font-mono">{domainToUnicode(d)}</span>
                <button
                  type="button"
                  aria-label={t`Remove ${d}`}
                  className="shrink-0 text-muted-foreground hover:text-foreground"
                  onClick={() =>
                    onChange({
                      ...value,
                      allowedDomains: value.allowedDomains.filter((x) => x !== d),
                    })
                  }
                >
                  <I.X size={11} />
                </button>
              </span>
            ))}
          </div>
        ) : null}
        <span className="text-[11.5px] text-muted-foreground">
          <Trans>
            Empty means any domain, which is the right default for customers and
            contacts. A subdomain of a listed domain matches, so example.com admits
            ada@mail.example.com. Use it for a staff or member column that has to
            stay inside the company.
          </Trans>
        </span>
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="flex items-start gap-2">
          <Checkbox
            checked={value.display === "unicode"}
            onChange={(v: boolean) => onChange({ ...value, display: v ? "unicode" : "ascii" })}
          />
          <span className="min-w-0">
            <span className="text-[12.5px] font-medium text-foreground">
              <Trans>Show international domains in their own alphabet</Trans>
            </span>
            <span className="mt-0.5 block text-[11.5px] text-muted-foreground">
              <Trans>
                The column always stores the encoded form a mail server resolves.
                This only changes how it is DISPLAYED — ada@örnek.com instead of
                ada@xn--rnek-4qa.com. Off unless the workspace actually has
                addresses like that.
              </Trans>
            </span>
          </span>
        </label>
      </div>

      <p className="flex items-start gap-1.5 rounded-md border border-input bg-muted/40 p-2 text-[11.5px] text-muted-foreground">
        <I.Info size={13} className="mt-px shrink-0" />
        <span>
          <Trans>
            Turning an existing text column into an email field changes no storage,
            so nothing has to be migrated — but the rows already in it are still
            written however they were typed. Run
            backlex collections normalize-emails to fold them, with --dry-run
            first if the column is unique.
          </Trans>
        </span>
      </p>
    </div>
  );
}
