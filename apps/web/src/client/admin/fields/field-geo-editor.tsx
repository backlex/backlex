// Shared location editor — the Location tab of the Add / Edit field dialogs,
// shown for the `map` interface.
//
// Everything here is optional, which is the point: a bare `geo` field already
// works as a coordinate pair someone types or picks. What this tab adds is the
// thing that makes the feature reach collections that already exist — telling
// backlex which of the row's own text columns spell out an address, so a point
// can be derived instead of retyped.
//
// The source columns are CHECKBOXES over the collection's real text fields, not
// a comma-separated string. A field name typed by hand is rejected at save time
// (`validateGeoSpec` checks it against the collection), and the only other way
// to find out you got it wrong is a geocode that silently never fires.
import { Trans, useLingui } from "@lingui/react/macro";
import { Input } from "@backlex/ui/components/input";
import { Checkbox } from "../ui";
import { tryParseGeoPoint } from "@backlex/db/geo";
import { I } from "../icons";

export interface GeoDraft {
  /** Field names composing the address, in the order they are joined. */
  geocodeFrom: string[];
  /** Free text `"lat, lng"` — parsed on save. Empty means "no default". */
  center: string;
}

export const emptyGeoDraft = (): GeoDraft => ({ geocodeFrom: [], center: "" });

/** Shape the stored `geo` spec, or `undefined` when nothing was configured —
 *  an empty object would be noise in every schema export. */
export const cleanGeo = (d: GeoDraft): Record<string, unknown> | undefined => {
  const out: Record<string, unknown> = {};
  if (d.geocodeFrom.length > 0) out.geocodeFrom = d.geocodeFrom;
  const center = tryParseGeoPoint(d.center);
  if (center) out.defaultCenter = center;
  return Object.keys(out).length > 0 ? out : undefined;
};

/** Rehydrate the draft from a stored spec, so re-opening Edit shows what is
 *  actually saved rather than an empty form. */
export const geoDraftFrom = (spec: unknown): GeoDraft => {
  const s = (spec ?? {}) as { geocodeFrom?: string[]; defaultCenter?: { lat: number; lng: number } };
  return {
    geocodeFrom: Array.isArray(s.geocodeFrom) ? [...s.geocodeFrom] : [],
    center: s.defaultCenter ? `${s.defaultCenter.lat}, ${s.defaultCenter.lng}` : "",
  };
};

interface GeoEditorProps {
  value: GeoDraft;
  onChange: (v: GeoDraft) => void;
  /** The collection's other fields — only text-ish ones can spell an address. */
  candidates: { name: string; type?: string; label?: string }[];
}

/** Column types a written address can live in. A number or a relation cannot
 *  contribute to a string a geocoder will understand. */
const ADDRESSY = new Set(["text", "longtext"]);

export function FieldGeoEditor({ value, onChange, candidates }: GeoEditorProps) {
  const { t } = useLingui();
  const options = candidates.filter((f) => ADDRESSY.has(f.type ?? "text"));
  const centerParsed = tryParseGeoPoint(value.center);
  const centerBad = value.center.trim() !== "" && !centerParsed;

  const toggle = (name: string) => {
    const has = value.geocodeFrom.includes(name);
    onChange({
      ...value,
      // Appended rather than sorted into field order: the ORDER is the address
      // format ("street, district, city, country"), and only the operator knows
      // what that is for their data.
      geocodeFrom: has
        ? value.geocodeFrom.filter((n) => n !== name)
        : [...value.geocodeFrom, name],
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <span className="text-[12.5px] font-medium text-foreground">
          <Trans>Look the point up from</Trans>
        </span>
        <span className="text-[11.5px] text-muted-foreground">
          <Trans>
            Pick the columns that spell out the address. When a row is saved without
            a point, these are joined together and looked up. Tick them in the order
            they should be read.
          </Trans>
        </span>
        {options.length === 0 ? (
          <span className="text-[11.5px] text-muted-foreground">
            <Trans>This collection has no text columns to build an address from.</Trans>
          </span>
        ) : (
          <div className="flex flex-col gap-1 pt-1">
            {options.map((f) => {
              const idx = value.geocodeFrom.indexOf(f.name);
              return (
                <label
                  key={f.name}
                  className="flex min-w-0 cursor-pointer items-center gap-2 rounded-control px-1 py-1 hover:bg-muted/50"
                >
                  <Checkbox checked={idx >= 0} onChange={() => toggle(f.name)} />
                  <span className="min-w-0 truncate text-[12.5px] text-foreground">
                    {f.label || f.name}
                  </span>
                  {idx >= 0 && (
                    <span className="ml-auto shrink-0 text-[11px] tabular-nums text-muted-foreground">
                      {idx + 1}
                    </span>
                  )}
                </label>
              );
            })}
          </div>
        )}
        {value.geocodeFrom.length > 0 && (
          <div className="flex items-start gap-1.5 rounded-control border border-border bg-muted/40 px-2 py-1.5 text-[11.5px] text-muted-foreground">
            <I.Info size={12} className="mt-px shrink-0" />
            <span className="min-w-0">
              <Trans>Looked up as:</Trans>{" "}
              <span className="font-mono text-foreground">
                {value.geocodeFrom.join(", ")}
              </span>
            </span>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-[12.5px] font-medium text-foreground">
          <Trans>
            Map opens at <span className="text-muted-foreground">(optional)</span>
          </Trans>
        </span>
        <Input
          className="font-mono"
          value={value.center}
          placeholder="41.0082, 28.9784"
          aria-invalid={centerBad || undefined}
          aria-label={t`Default map centre`}
          onChange={(e) => onChange({ ...value, center: e.target.value })}
        />
        <span className="text-[11.5px] text-muted-foreground">
          {centerBad ? (
            <Trans>Enter a coordinate pair, or leave this blank.</Trans>
          ) : (
            <Trans>Where the preview starts for a row that has no point yet.</Trans>
          )}
        </span>
      </div>
    </div>
  );
}
