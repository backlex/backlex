// The value editor for a `geo` field — where a row actually IS.
//
// Three ways to fill it in, in the order an operator reaches for them:
//
//  1. **From the address already on the form.** A field configured with
//     `geocodeFrom` reads those inputs live and offers a one-click lookup, so
//     the person filling in a clinic record never types a coordinate. This is
//     the same `/api/geo/geocode` call the write path makes, so the answer the
//     button shows IS the answer a save would have produced.
//  2. **From the browser.** `navigator.geolocation` for the case where the
//     operator is standing at the place.
//  3. **By hand.** Two numeric inputs, because a coordinate pair pasted out of
//     a maps app is still how a lot of this data arrives. The paired field
//     accepts a whole `"41.0082, 28.9784"` string pasted into either box and
//     splits it, which is what pasting actually does.
//
// The map is a PREVIEW and it is deliberately click-to-load. Rendering an
// embedded map on form open would send the row's coordinates to a third-party
// tile server every time anyone opened the record — for a customer's home
// address that is a disclosure the operator did not ask for. Nothing here
// contacts an outside host until a button is pressed.
//
// There is no bundled click-to-place map, on purpose: a real one means shipping
// a mapping library and a tile subscription into every deployment, including
// the air-gapped ones, to replace two number inputs and a geocode button.
import { useMemo, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { Input } from "@backlex/ui/components/input";
import { formatGeoPoint, tryParseGeoPoint, type GeoPoint } from "@backlex/db/geo";
import { api } from "../lib/api";
import { I } from "./icons";

interface GeoInputProps {
  value: unknown;
  onChange: (v: GeoPoint | null) => void;
  /** Field names whose current form values compose the address to look up.
   *  Empty when the field has no `geocodeFrom`, which hides the lookup. */
  geocodeFrom?: string[];
  /** Live values of the other fields on the form, for the address lookup. */
  siblings?: Record<string, unknown>;
  /** Where the preview map opens for a row that has no point yet. */
  defaultCenter?: GeoPoint;
  disabled?: boolean;
  invalid?: boolean;
}

/** The OSM embed used for the preview. Only ever built after a click. */
const embedUrl = (p: GeoPoint): string => {
  // A small window around the point — tight enough to see the street, wide
  // enough that a slightly-off geocode is still visibly slightly off.
  const d = 0.01;
  const bbox = [p.lng - d, p.lat - d, p.lng + d, p.lat + d].join(",");
  return `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${p.lat},${p.lng}`;
};

const linkUrl = (p: GeoPoint): string =>
  `https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lng}#map=15/${p.lat}/${p.lng}`;

/** Compose the address string exactly the way the server composes it — blanks
 *  dropped, comma-joined, source order preserved. */
const addressOf = (names: string[], siblings: Record<string, unknown>): string =>
  names
    .map((n) => {
      const v = siblings[n];
      return v === null || v === undefined ? "" : String(v).trim();
    })
    .filter(Boolean)
    .join(", ");

export function GeoInput({
  value,
  onChange,
  geocodeFrom = [],
  siblings = {},
  defaultCenter,
  disabled,
  invalid,
}: GeoInputProps) {
  const { t } = useLingui();
  const point = useMemo(() => tryParseGeoPoint(value), [value]);
  // Free text while typing: a half-entered "41." is not a number yet, and
  // coercing on every keystroke makes the field impossible to type a decimal
  // into. Committed to the parent only when both halves parse.
  const [latText, setLatText] = useState<string | null>(null);
  const [lngText, setLngText] = useState<string | null>(null);
  const [showMap, setShowMap] = useState(false);
  const [busy, setBusy] = useState<"geocode" | "locate" | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const latValue = latText ?? (point ? String(point.lat) : "");
  const lngValue = lngText ?? (point ? String(point.lng) : "");

  const commit = (latRaw: string, lngRaw: string) => {
    if (latRaw.trim() === "" && lngRaw.trim() === "") {
      onChange(null);
      return;
    }
    const parsed = tryParseGeoPoint({ lat: latRaw, lng: lngRaw });
    // A half-typed pair leaves the stored value alone rather than writing a
    // broken one — the inputs keep showing what was typed either way.
    if (parsed) onChange(parsed);
  };

  /** A pasted "lat,lng" in either box fills both — which is what pasting a
   *  coordinate out of a maps app actually does. */
  const handleHalf = (which: "lat" | "lng", raw: string) => {
    setNote(null);
    if (raw.includes(",")) {
      const pair = tryParseGeoPoint(raw);
      if (pair) {
        setLatText(String(pair.lat));
        setLngText(String(pair.lng));
        onChange(pair);
        return;
      }
    }
    if (which === "lat") {
      setLatText(raw);
      commit(raw, lngValue);
    } else {
      setLngText(raw);
      commit(latValue, raw);
    }
  };

  const address = addressOf(geocodeFrom, siblings);

  const runGeocode = async () => {
    if (!address) return;
    setBusy("geocode");
    setNote(null);
    try {
      const res = await api<{ data: (GeoPoint & { formatted?: string }) | null }>(
        "/api/geo/geocode",
        { method: "POST", body: JSON.stringify({ address }) },
      );
      if (!res.data) {
        setNote(t`No match for that address.`);
        return;
      }
      const p = { lat: res.data.lat, lng: res.data.lng };
      setLatText(String(p.lat));
      setLngText(String(p.lng));
      onChange(p);
      // Show what the provider MATCHED, not what was sent — it is the only way
      // to notice that "Springfield" resolved to the wrong Springfield.
      setNote(res.data.formatted ?? null);
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const useMyLocation = () => {
    if (!navigator.geolocation) {
      setNote(t`This browser cannot report a location.`);
      return;
    }
    setBusy("locate");
    setNote(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const p = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        setLatText(String(p.lat));
        setLngText(String(p.lng));
        onChange(p);
        setBusy(null);
      },
      (err) => {
        setNote(err.message);
        setBusy(null);
      },
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  };

  const mapPoint = point ?? defaultCenter ?? null;

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="grid min-w-0 grid-cols-2 gap-2 [&>*]:min-w-0">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-[11px] text-muted-foreground"><Trans>Latitude</Trans></span>
          <Input
            className="font-mono"
            inputMode="decimal"
            value={latValue}
            placeholder="41.0082"
            disabled={disabled}
            aria-invalid={invalid || undefined}
            aria-label={t`Latitude`}
            onChange={(e) => handleHalf("lat", e.target.value)}
          />
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-[11px] text-muted-foreground"><Trans>Longitude</Trans></span>
          <Input
            className="font-mono"
            inputMode="decimal"
            value={lngValue}
            placeholder="28.9784"
            disabled={disabled}
            aria-invalid={invalid || undefined}
            aria-label={t`Longitude`}
            onChange={(e) => handleHalf("lng", e.target.value)}
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {geocodeFrom.length > 0 && (
          <button
            type="button"
            disabled={disabled || !address || busy !== null}
            onClick={runGeocode}
            className="inline-flex items-center gap-1 rounded-control border border-border bg-card px-2 py-1 text-[11.5px] text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            <I.Search size={11} />
            {busy === "geocode" ? <Trans>Looking up…</Trans> : <Trans>Find from address</Trans>}
          </button>
        )}
        <button
          type="button"
          disabled={disabled || busy !== null}
          onClick={useMyLocation}
          className="inline-flex items-center gap-1 rounded-control border border-border bg-card px-2 py-1 text-[11.5px] text-muted-foreground hover:text-foreground disabled:opacity-50"
        >
          <I.Globe size={11} />
          {busy === "locate" ? <Trans>Locating…</Trans> : <Trans>Use my location</Trans>}
        </button>
        {mapPoint && (
          <button
            type="button"
            onClick={() => setShowMap((v) => !v)}
            className="inline-flex items-center gap-1 rounded-control border border-border bg-card px-2 py-1 text-[11.5px] text-muted-foreground hover:text-foreground"
          >
            <I.Eye size={11} />
            {showMap ? <Trans>Hide map</Trans> : <Trans>Show map</Trans>}
          </button>
        )}
        {point && !disabled && (
          <button
            type="button"
            onClick={() => {
              setLatText("");
              setLngText("");
              setShowMap(false);
              setNote(null);
              onChange(null);
            }}
            className="inline-flex items-center gap-1 rounded-control border border-border bg-card px-2 py-1 text-[11.5px] text-muted-foreground hover:text-foreground"
          >
            <I.X size={11} />
            <Trans>Clear</Trans>
          </button>
        )}
      </div>

      {geocodeFrom.length > 0 && !address && (
        <span className="text-[11px] text-muted-foreground">
          <Trans>Fill in the address fields to look this up automatically.</Trans>
        </span>
      )}
      {note && <span className="text-[11px] text-muted-foreground">{note}</span>}

      {showMap && mapPoint && (
        <div className="flex flex-col gap-1">
          <iframe
            title={t`Map preview`}
            src={embedUrl(mapPoint)}
            className="h-[220px] w-full rounded-control border border-border"
            loading="lazy"
            referrerPolicy="no-referrer"
          />
          <a
            href={linkUrl(mapPoint)}
            target="_blank"
            rel="noreferrer noopener"
            className="self-start text-[11px] text-muted-foreground underline hover:text-foreground"
          >
            {formatGeoPoint(mapPoint)}
          </a>
        </div>
      )}
    </div>
  );
}
