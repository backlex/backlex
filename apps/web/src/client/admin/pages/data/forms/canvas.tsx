
import { Fragment, } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { I } from "../../../icons";
import {
  type ApiFormBlock,
  type ApiFormBlockScale,
  type ApiFormEligibleField,
} from "../../../api";
import { blockIcon, blockScale, humanize } from "./shared";

// Mirrors the public page's DARK palette (and the admin card surface) so the
// canvas shows exactly the card visitors get.
export const CANVAS_DARK = {
  bg: "#0E0C18",
  text: "#ECEAF7",
  muted: "#A6A1C2",
  border: "rgba(255,255,255,0.09)",
  inputBg: "rgba(255,255,255,0.03)",
};

export const CANVAS_LIGHT = {
  bg: "#FFFFFF",
  text: "#17141F",
  muted: "#5F5A73",
  border: "rgba(20,15,45,0.12)",
  inputBg: "rgba(20,15,45,0.03)",
};

export type CanvasPalette = typeof CANVAS_DARK;

/** The points a scale offers, low to high. */
const scalePoints = (scale: ApiFormBlockScale): number[] =>
  Array.from({ length: Math.max(0, scale.max - scale.min + 1) }, (_, i) => scale.min + i);

export function CanvasFieldPreview({
  block,
  ef,
  locale,
  base,
  p,
}: {
  block: ApiFormBlock;
  ef: ApiFormEligibleField | null;
  locale: string;
  base: string;
  p: CanvasPalette;
}) {
  const { t } = useLingui();
  const loc = locale !== base ? block.i18n?.[locale] : undefined;
  const ph = loc?.placeholder || block.placeholder || "";
  if (!ef) return null;
  const LeadIcon = blockIcon(ef, block);
  const boxStyle: React.CSSProperties = {
    borderColor: p.border,
    background: p.inputBg,
    color: p.muted,
  };
  if (ef.choices && ef.type === "json") {
    return (
      <div className="flex flex-col gap-2">
        {ef.choices.slice(0, 4).map((c) => (
          <div key={c} className="flex items-center gap-2.5 text-[13.5px]" style={{ color: p.muted }}>
            <span className="size-[17px] shrink-0 rounded-[5px] border-[1.5px]" style={{ borderColor: p.border, background: p.inputBg }} />
            {c}
          </div>
        ))}
        {ef.choices.length > 4 && (
          <span className="self-start rounded-full border border-dashed px-2.5 py-1 text-[11.5px]" style={{ borderColor: p.border, color: p.muted }}>
            + {ef.choices.length - 4} <Trans>more</Trans>
          </span>
        )}
      </div>
    );
  }
  if (ef.choices) {
    return (
      <>
        <div className="flex h-10 items-center gap-2 rounded-[10px] border px-3 text-[13.5px]" style={boxStyle}>
          <LeadIcon size={13} />
          <span>{t`Select one…`}</span>
          <span className="ml-auto"><I.ChevronDown size={14} /></span>
        </div>
        <div className="flex flex-wrap gap-1.5 pt-0.5">
          {ef.choices.slice(0, 4).map((c) => (
            <span
              key={c}
              className="rounded-full border px-2.5 py-1 text-[11.5px]"
              style={{ borderColor: p.border, color: p.muted }}
            >
              {c}
            </span>
          ))}
          {ef.choices.length > 4 && (
            <span
              className="rounded-full border border-dashed px-2.5 py-1 text-[11.5px]"
              style={{ borderColor: p.border, color: p.muted }}
            >
              + {ef.choices.length - 4} <Trans>more</Trans>
            </span>
          )}
        </div>
      </>
    );
  }
  const previewScale = blockScale(block, ef);
  if (previewScale) {
    const points = scalePoints(previewScale);
    return (
      <div className="flex flex-col gap-1.5">
        {previewScale.style === "stars" ? (
          <div className="flex flex-wrap items-center gap-1" style={{ color: p.muted }}>
            {points.map((n) => (
              <I.Star key={n} size={17} />
            ))}
            <span className="ml-1 text-[11px]">
              {previewScale.min}–{previewScale.max}
            </span>
          </div>
        ) : (
          <div className="flex flex-wrap gap-1">
            {points.map((n) => (
              <span
                key={n}
                // Fixed cells, matching the public page: a growing basis makes
                // the three points that wrap onto a second row three times the
                // size of the eight above them.
                className="flex h-8 w-9 shrink-0 items-center justify-center rounded-[9px] border text-[12.5px]"
                style={{ borderColor: p.border, background: p.inputBg, color: p.muted }}
              >
                {n}
              </span>
            ))}
          </div>
        )}
        {(previewScale.minLabel || previewScale.maxLabel) && (
          <div className="flex justify-between gap-3 text-[11px]" style={{ color: p.muted }}>
            <span>{previewScale.minLabel ?? ""}</span>
            <span className="text-right">{previewScale.maxLabel ?? ""}</span>
          </div>
        )}
      </div>
    );
  }
  if (ef.type === "longtext") {
    return (
      <div className="flex h-[74px] items-start gap-2 rounded-[10px] border px-3 py-2.5 text-[13.5px]" style={boxStyle}>
        <span className="mt-0.5"><LeadIcon size={13} /></span>
        <span className="opacity-70">{ph}</span>
      </div>
    );
  }
  if (ef.type === "file") {
    return (
      <div
        className="flex min-h-[68px] flex-col items-center justify-center gap-1 rounded-[10px] border-[1.5px] border-dashed px-3 py-3 text-[13px]"
        style={{ borderColor: p.border, background: p.inputBg, color: p.muted }}
      >
        <I.Upload size={16} />
        <span><Trans>Choose a file or drag it here</Trans></span>
        <span className="text-[11px] opacity-70">
          <Trans>up to {Math.floor((block.maxBytes ?? 5 * 1024 * 1024) / 1024 / 1024)} MB</Trans>
        </span>
      </div>
    );
  }
  return (
    <div className="flex h-10 items-center gap-2 rounded-[10px] border px-3 text-[13.5px]" style={boxStyle}>
      <LeadIcon size={13} />
      <span className="opacity-70">{ph || (ef.type === "timestamp" ? "YYYY-MM-DD" : "")}</span>
    </div>
  );
}

/** The columns a matrix draws, as the builder sees them: the block's own scale,
 *  or the choices its rows agree on. Mirrors `resolveMatrixColumns` on the
 *  server so the canvas and the live form never disagree. */
function matrixColumnLabels(
  block: ApiFormBlock,
  efByName: Map<string, ApiFormEligibleField>,
): string[] {
  if (block.scale) return scalePoints(block.scale).map(String);
  const first = (block.rows ?? []).map((r) => efByName.get(r.name)).find(Boolean);
  return first?.choices ?? [];
}

/** The grid, in miniature — same columns, same rows, no answers. */
export function CanvasMatrixPreview({
  block,
  efByName,
  locale,
  base,
  accent,
  p,
}: {
  block: ApiFormBlock;
  efByName: Map<string, ApiFormEligibleField>;
  locale: string;
  base: string;
  accent: string;
  p: CanvasPalette;
}) {
  const columns = matrixColumnLabels(block, efByName);
  const rows = (block.rows ?? []).filter((r) => efByName.has(r.name));
  if (columns.length === 0 || rows.length === 0) return null;
  return (
    <div
      className="grid items-center gap-1.5 text-[12px]"
      style={{
        gridTemplateColumns: `minmax(0,1.4fr) repeat(${columns.length}, minmax(0,1fr))`,
        color: p.muted,
      }}
    >
      <span />
      {columns.map((c) => (
        <span key={c} className="truncate text-center text-[10.5px] leading-tight">
          {c}
        </span>
      ))}
      {rows.map((r) => {
        const ef = efByName.get(r.name);
        const loc = locale !== base ? r.i18n?.[locale] : undefined;
        return (
          <Fragment key={r.name}>
            <span className="min-w-0 truncate pr-1.5" style={{ color: p.text }}>
              {loc?.label || r.label || ef?.label || humanize(r.name)}
              {ef?.required && <span style={{ color: accent }}> *</span>}
            </span>
            {columns.map((c) => (
              <span key={c} className="flex h-7 items-center justify-center">
                <span
                  className="size-[11px] rounded-full border-[1.5px]"
                  style={{ borderColor: p.border, background: p.inputBg }}
                />
              </span>
            ))}
          </Fragment>
        );
      })}
    </div>
  );
}

export function InsertDot({ onClick, bg }: { onClick: () => void; bg: string }) {
  const { t } = useLingui();
  // Editor chrome — always the admin primary, never the form's accent (this
  // control isn't part of the published form).
  return (
    <button
      type="button"
      title={t`Add block`}
      onClick={onClick}
      className="-mx-6 flex h-6 w-[calc(100%+3rem)] items-center gap-2 px-3.5 text-primary opacity-60 transition-opacity hover:opacity-100 sm:-mx-8 sm:w-[calc(100%+4rem)]"
    >
      <span className="h-px flex-1 bg-primary/45" />
      <span className="grid size-[18px] place-items-center rounded-full border border-primary/55" style={{ background: bg }}>
        <I.Plus size={10} />
      </span>
      <span className="h-px flex-1 bg-primary/45" />
    </button>
  );
}

/* ── builder ───────────────────────────────────────────────────────── */
