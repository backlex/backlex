// Shared phone editor — the Phone tab of the Add / Edit field dialogs, shown
// for the `phone` interface.
//
// Everything here is optional, and the default is the safe one: a bare phone
// field accepts numbers written in international form (`+90…`, `0090…`) and
// refuses national ones. That refusal is deliberate rather than unhelpful —
// `0532 111 22 33` is a real number in dozens of countries, and picking one for
// the operator would silently store a number that dials somewhere else.
//
// So the single decision this tab exists to capture is: **which country is a
// bare national number in?** Either one answer for the whole column (`region`),
// or one per row read off a sibling column (`regionField`) — the same two shapes
// money offers for currency, for the same reason. The rest narrows what is
// accepted at all.
import { useMemo } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
// `Select` is in ./select and `Checkbox` in ./ui — two modules. Mixing them up
// used to be a blank admin at run time rather than a typecheck error, because
// these dialogs were suppressed with `@ts-nocheck`; they no longer are.
import { Select } from "../select";
import { Checkbox } from "../ui";
import { CALLING_CODES, callingCodeFor, parsePhone } from "@backlex/db/phone";
import { I } from "../icons";

export interface PhoneDraft {
  /** ISO alpha-2 default region, or "" for none. */
  region: string;
  /** Sibling column holding a per-row region, or "" for none. */
  regionField: string;
  /** Regions the column is restricted to. Empty = no restriction. */
  allowedRegions: string[];
  /** How the value renders in lists and the form hint. */
  display: "e164" | "spaced";
}

export const emptyPhoneDraft = (): PhoneDraft => ({
  region: "",
  regionField: "",
  allowedRegions: [],
  display: "e164",
});

/** Shape the stored `phone` spec, or `undefined` when nothing was configured —
 *  an empty object would be noise in every schema export. */
export const cleanPhone = (d: PhoneDraft): Record<string, unknown> | undefined => {
  const out: Record<string, unknown> = {};
  if (d.region) out.region = d.region;
  if (d.regionField) out.regionField = d.regionField;
  if (d.allowedRegions.length > 0) out.allowedRegions = d.allowedRegions;
  // `e164` is the default, so storing it says nothing.
  if (d.display === "spaced") out.display = d.display;
  return Object.keys(out).length > 0 ? out : undefined;
};

/** Rehydrate the draft from a stored spec, so re-opening Edit shows what is
 *  actually saved rather than an empty form. */
export const phoneDraftFrom = (spec: unknown): PhoneDraft => {
  const s = (spec ?? {}) as {
    region?: string;
    regionField?: string;
    allowedRegions?: string[];
    display?: "e164" | "spaced";
  };
  return {
    region: typeof s.region === "string" ? s.region : "",
    regionField: typeof s.regionField === "string" ? s.regionField : "",
    allowedRegions: Array.isArray(s.allowedRegions) ? [...s.allowedRegions] : [],
    display: s.display === "spaced" ? "spaced" : "e164",
  };
};

interface PhoneEditorProps {
  value: PhoneDraft;
  onChange: (v: PhoneDraft) => void;
  /** The collection's other fields — only text ones can hold a country code. */
  candidates: { name: string; type?: string; label?: string }[];
}

const REGION_OPTIONS = Object.entries(CALLING_CODES)
  .map(([region, code]) => ({ region, code }))
  .sort((a, b) => Number(a.code) - Number(b.code) || a.region.localeCompare(b.region));

export function FieldPhoneEditor({ value, onChange, candidates }: PhoneEditorProps) {
  const { t } = useLingui();
  const regionColumns = candidates.filter((f) => (f.type ?? "text") === "text");

  // The example is live rather than written into the copy, because the whole
  // question this tab answers is "what will a typed number become" — and an
  // answer produced by the SAME parser the server runs cannot be out of date the
  // way a hard-coded `+90 532…` in a help string would be.
  const example = useMemo(() => {
    if (!value.region) return null;
    try {
      return parsePhone("0532 111 22 33", value.region).e164;
    } catch {
      // Not every plan has numbers of that shape; the region is still valid.
      return null;
    }
  }, [value.region]);

  const toggleAllowed = (region: string) => {
    const has = value.allowedRegions.includes(region);
    onChange({
      ...value,
      allowedRegions: has
        ? value.allowedRegions.filter((r) => r !== region)
        : [...value.allowedRegions, region],
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <span className="text-[12.5px] font-medium text-foreground">
          <Trans>A number typed without a country code is in</Trans>
        </span>
        <Select
          value={value.region}
          onChange={(v: string) => onChange({ ...value, region: v })}
          placeholder={t`No default — require +country code`}
          options={[
            { value: "", label: t`No default — require +country code` },
            ...REGION_OPTIONS.map((o) => ({
              value: o.region,
              label: `${o.region} · +${o.code}`,
            })),
          ]}
        />
        <span className="text-[11.5px] text-muted-foreground">
          {example ? (
            <Trans>
              With this set, <span className="font-mono">0532 111 22 33</span> is
              stored as <span className="font-mono text-foreground">{example}</span>.
            </Trans>
          ) : (
            <Trans>
              Without a default, only numbers written in full international form are
              accepted — which is the safe answer, since the same national number
              exists in dozens of countries.
            </Trans>
          )}
        </span>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-[12.5px] font-medium text-foreground">
          <Trans>
            …or read the country from{" "}
            <span className="text-muted-foreground">(optional)</span>
          </Trans>
        </span>
        <Select
          value={value.regionField}
          onChange={(v: string) => onChange({ ...value, regionField: v })}
          placeholder={t`Use the default above`}
          options={[
            { value: "", label: t`Use the default above` },
            ...regionColumns.map((f) => ({
              value: f.name,
              label: f.label ? `${f.label} (${f.name})` : f.name,
            })),
          ]}
        />
        <span className="text-[11.5px] text-muted-foreground">
          <Trans>
            A text column holding this row's two-letter country code, for a list of
            contacts spread across countries. Falls back to the default above when
            the column is empty.
          </Trans>
        </span>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-[12.5px] font-medium text-foreground">
          <Trans>
            Only accept numbers from{" "}
            <span className="text-muted-foreground">(optional)</span>
          </Trans>
        </span>
        <span className="text-[11.5px] text-muted-foreground">
          <Trans>
            Leave empty to accept any country. Restricting is how a mistyped country
            code gets caught at the write rather than showing up as an SMS sent
            abroad.
          </Trans>
        </span>
        {value.allowedRegions.length > 0 && (
          <div className="flex flex-wrap gap-1 pt-1">
            {value.allowedRegions.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => toggleAllowed(r)}
                className="flex items-center gap-1 rounded-control border border-border bg-muted/40 px-1.5 py-0.5 text-[11.5px] text-foreground hover:bg-muted"
              >
                <span className="font-mono">
                  {r} +{callingCodeFor(r)}
                </span>
                <I.X size={11} />
              </button>
            ))}
          </div>
        )}
        <Select
          value=""
          onChange={(v: string) => v && toggleAllowed(v)}
          placeholder={t`Add a country…`}
          options={[
            { value: "", label: t`Add a country…` },
            ...REGION_OPTIONS.filter((o) => !value.allowedRegions.includes(o.region)).map(
              (o) => ({ value: o.region, label: `${o.region} · +${o.code}` }),
            ),
          ]}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-[12.5px] font-medium text-foreground">
          <Trans>Shown in lists as</Trans>
        </span>
        <label className="flex min-w-0 cursor-pointer items-center gap-2 rounded-control px-1 py-1 hover:bg-muted/50">
          <Checkbox
            checked={value.display === "spaced"}
            onChange={() =>
              onChange({ ...value, display: value.display === "spaced" ? "e164" : "spaced" })
            }
          />
          <span className="min-w-0 text-[12.5px] text-foreground">
            <Trans>
              Put a space after the country code —{" "}
              <span className="font-mono">+90 5321112233</span>
            </Trans>
          </span>
        </label>
        <span className="text-[11.5px] text-muted-foreground">
          <Trans>
            There is no national format on purpose: printing one needs each
            country's numbering plan, and guessing at it produces numbers that look
            right and are not. The stored value is always E.164.
          </Trans>
        </span>
      </div>
    </div>
  );
}
