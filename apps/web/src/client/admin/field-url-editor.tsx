// Shared URL editor — the URL tab of the Add / Edit field dialogs, shown for the
// `url` type.
//
// Everything here is optional, and the default is the useful one: a bare url
// field accepts any well-formed https/http address and folds it. That matches
// `email`'s posture rather than `phone`'s — a "Website" column has no business
// refusing a host it has not heard of, whereas phone has to refuse a national
// number because it would silently dial another country.
//
// So this tab captures three small decisions: whether the column holds a whole
// address or a bare domain, which schemes are acceptable, and whether it is
// pinned to a set of hosts.
import { useMemo, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
// `Select` is in ./select and `Checkbox` in ./ui — two modules, and on the
// dialogs that carry `@ts-nocheck` getting it wrong is a blank admin at run time
// rather than a typecheck error. This file deliberately does NOT carry it.
import { Checkbox } from "./ui";
import { Input } from "@backlex/ui/components/input";
import { Button } from "@backlex/ui/components/button";
import { domainToUnicode } from "@backlex/db/email";
import { tryParseUrl } from "@backlex/db/url";
import { I } from "./icons";

export interface UrlDraft {
  /** Whole address, or a bare registrable host. */
  form: "url" | "host";
  /** Accept `http://` alongside `https://`. */
  allowHttp: boolean;
  /** Hosts the column is restricted to. Empty = no restriction. */
  allowedHosts: string[];
  /** How the value renders in lists and the form hint. */
  display: "ascii" | "unicode";
}

export const emptyUrlDraft = (): UrlDraft => ({
  form: "url",
  allowHttp: true,
  allowedHosts: [],
  display: "ascii",
});

/** Shape the stored `url` spec, or `undefined` when nothing was configured — an
 *  empty object would be noise in every schema export. */
export const cleanUrl = (d: UrlDraft): Record<string, unknown> | undefined => {
  const out: Record<string, unknown> = {};
  if (d.form === "host") out.form = "host";
  // `schemes` is only written when it NARROWS. Both schemes is the default, and
  // storing the default would mean every future change to that default silently
  // failed to reach columns created today. `schemes` is also meaningless on a
  // host column and the server refuses the combination, so it is not emitted
  // there at all.
  if (!d.allowHttp && d.form !== "host") out.schemes = ["https"];
  if (d.allowedHosts.length > 0) out.allowedHosts = d.allowedHosts;
  // `ascii` is the default, so storing it says nothing.
  if (d.display === "unicode") out.display = d.display;
  return Object.keys(out).length > 0 ? out : undefined;
};

/** Rehydrate the draft from a stored spec, so re-opening Edit shows what is
 *  actually saved rather than an empty form. */
export const urlDraftFrom = (spec: unknown): UrlDraft => {
  const s = (spec ?? {}) as {
    form?: "url" | "host";
    schemes?: string[];
    allowedHosts?: string[];
    display?: "ascii" | "unicode";
  };
  return {
    form: s.form === "host" ? "host" : "url",
    // Absent `schemes` means "no restriction", which includes http. Only an
    // explicit list that omits it turns the box off.
    allowHttp: Array.isArray(s.schemes) ? s.schemes.includes("http") : true,
    allowedHosts: Array.isArray(s.allowedHosts) ? [...s.allowedHosts] : [],
    display: s.display === "unicode" ? "unicode" : "ascii",
  };
};

interface UrlEditorProps {
  value: UrlDraft;
  onChange: (v: UrlDraft) => void;
}

export function FieldUrlEditor({ value, onChange }: UrlEditorProps) {
  const { t } = useLingui();
  const [hostInput, setHostInput] = useState("");

  // Judged with the same parser the server uses, so a host that could never
  // match anything is caught while it is being typed rather than at save time.
  const hostError = useMemo(() => {
    const h = hostInput.trim();
    if (!h) return null;
    if (value.allowedHosts.includes(h)) return t`Already on the list.`;
    return tryParseUrl(h, { form: "host" }) ? null : t`Not a domain.`;
  }, [hostInput, value.allowedHosts, t]);

  const addHost = () => {
    const h = hostInput.trim();
    if (!h || hostError) return;
    onChange({ ...value, allowedHosts: [...value.allowedHosts, h] });
    setHostInput("");
  };

  const isHost = value.form === "host";

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <label className="flex items-start gap-2">
          <Checkbox
            checked={isHost}
            onChange={(v: boolean) => onChange({ ...value, form: v ? "host" : "url" })}
          />
          <span className="min-w-0">
            <span className="text-[12.5px] font-medium text-foreground">
              <Trans>Store a bare domain instead of a whole address</Trans>
            </span>
            <span className="mt-0.5 block text-[11.5px] text-muted-foreground">
              <Trans>
                acme.com rather than https://acme.com/. For the column a CRM matches
                a company by — it is the right-hand side of an email address, so it
                folds the same way one does and can be compared with one. A scheme
                or a path is refused.
              </Trans>
            </span>
          </span>
        </label>
      </div>

      {!isHost ? (
        <div className="flex flex-col gap-1.5">
          <label className="flex items-start gap-2">
            <Checkbox
              checked={!value.allowHttp}
              onChange={(v: boolean) => onChange({ ...value, allowHttp: !v })}
            />
            <span className="min-w-0">
              <span className="text-[12.5px] font-medium text-foreground">
                <Trans>Require https</Trans>
              </span>
              <span className="mt-0.5 block text-[11.5px] text-muted-foreground">
                <Trans>
                  Refuses http:// and supplies https:// when someone types a bare
                  host. Off by default, because a self-hosted install points
                  perfectly ordinary columns at http:// endpoints on its own
                  network.
                </Trans>
              </span>
            </span>
          </label>
        </div>
      ) : null}

      <div className="flex flex-col gap-1.5">
        <span className="text-[12.5px] font-medium text-foreground">
          <Trans>Only accept addresses at these hosts</Trans>
        </span>
        <div className="flex min-w-0 items-start gap-2">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <Input
              className="min-w-0"
              value={hostInput}
              placeholder={t`example.com`}
              spellCheck={false}
              aria-invalid={!!hostError || undefined}
              onChange={(e) => setHostInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addHost();
                }
              }}
            />
            {hostError ? (
              <span className="text-[11.5px] text-destructive">{hostError}</span>
            ) : null}
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0"
            disabled={!hostInput.trim() || !!hostError}
            onClick={addHost}
          >
            <Trans>Add</Trans>
          </Button>
        </div>
        {value.allowedHosts.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {value.allowedHosts.map((hst) => (
              <span
                key={hst}
                className="inline-flex max-w-full items-center gap-1 rounded-md border border-input px-2 py-0.5 text-[11.5px]"
              >
                <span className="min-w-0 truncate font-mono">{domainToUnicode(hst)}</span>
                <button
                  type="button"
                  aria-label={t`Remove ${hst}`}
                  className="shrink-0 text-muted-foreground hover:text-foreground"
                  onClick={() =>
                    onChange({
                      ...value,
                      allowedHosts: value.allowedHosts.filter((x) => x !== hst),
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
            Empty means any host, which is the right default for a website column. A
            subdomain of a listed host matches, so example.com admits
            docs.example.com. This is a schema rule about what may be STORED — it is
            not what decides whether a URL may be fetched.
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
              <Trans>Show international hosts in their own alphabet</Trans>
            </span>
            <span className="mt-0.5 block text-[11.5px] text-muted-foreground">
              <Trans>
                The column always stores the encoded form a resolver answers for.
                This only changes how it is DISPLAYED — https://örnek.com/ instead
                of https://xn--rnek-4qa.com/. Off unless the workspace actually has
                hosts like that.
              </Trans>
            </span>
          </span>
        </label>
      </div>

      <p className="flex items-start gap-1.5 rounded-md border border-input bg-muted/40 p-2 text-[11.5px] text-muted-foreground">
        <I.Info size={13} className="mt-px shrink-0" />
        <span>
          <Trans>
            A URL field replaces any regex you had on the column — validation runs
            before the value is folded, so a pattern demanding https:// would reject
            the bare acme.com this field exists to accept. The fold is the stricter
            check.
          </Trans>
        </span>
      </p>
    </div>
  );
}
