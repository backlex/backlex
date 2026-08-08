
import { Trans, } from "@lingui/react/macro";
import { I } from "../../../icons";
import {
  type ApiFormBlock,
  type ApiFormBlockScale,
  type ApiFormEligibleField,
} from "../../../api";

export const humanize = (name: string): string =>
  name
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^\w/, (ch) => ch.toUpperCase());

export const relTime = (v: unknown): string => {
  if (!v) return "—";
  const d = typeof v === "number" ? new Date(v) : new Date(String(v));
  if (Number.isNaN(d.getTime())) return "—";
  const mins = Math.floor((Date.now() - d.getTime()) / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  if (mins < 60 * 24) return `${Math.floor(mins / 60)}h`;
  return `${Math.floor(mins / (60 * 24))}d`;
};

/* The canvas is "what visitors see": it renders with the FORM's theme, accent
   and font (same palettes as the public page), not the admin theme. */

/** The scale a block renders as — the same `scale`-then-legacy-`rating`
 *  fallback the public page applies, so the canvas preview and the live form
 *  never disagree about what the question looks like. */
export const blockScale = (
  block: ApiFormBlock,
  ef: ApiFormEligibleField | null | undefined,
): ApiFormBlockScale | null => {
  if (!ef || ef.type !== "integer") return null;
  if (block.scale) return block.scale;
  if (block.rating) return { min: 1, max: 5, style: "stars" };
  return null;
};

/** The signature two fields must share to be rows of the same choice matrix —
 *  same choices, same order, because the columns are drawn once for all rows. */
export const choiceSignature = (f: ApiFormEligibleField): string | null =>
  f.choices?.length ? f.choices.join("␟") : null;

export const blockIcon = (ef: ApiFormEligibleField | null | undefined, block: ApiFormBlock) => {
  if (block.kind === "matrix") return I.Grid3;
  if ((block.kind ?? "field") === "step") return I.Layers;
  if (!ef) return I.Type;
  if (ef.choices && ef.type === "json") return I.CheckCircle;
  if (ef.choices) return I.LayoutList;
  if (ef.format === "email") return I.Mail;
  if (ef.format === "url") return I.Link;
  switch (ef.type) {
    case "integer": {
      const scale = blockScale(block, ef);
      if (!scale) return I.Hash;
      return scale.style === "stars" ? I.Star : I.Gauge;
    }
    case "number":
      return I.Hash;
    case "boolean":
      return I.Check;
    case "timestamp":
      return I.Calendar;
    case "longtext":
      return I.Type;
    case "file":
      return I.Upload;
    default:
      return I.Type;
  }
};

/** Design live/paused chip: mono uppercase, dotted, tinted border. */
export function LivePill({ active }: { active: boolean }) {
  return active ? (
    <span className="flex shrink-0 items-center gap-1.5 rounded-full border border-emerald-400/25 bg-emerald-400/10 px-2 py-0.5 font-mono text-[9.5px] uppercase tracking-[0.08em] text-emerald-400">
      <span className="size-[5px] rounded-full bg-emerald-400" />
      <Trans>live</Trans>
    </span>
  ) : (
    <span className="shrink-0 rounded-full border border-border bg-white/5 px-2 py-0.5 font-mono text-[9.5px] uppercase tracking-[0.08em] text-muted-foreground">
      <Trans>paused</Trans>
    </span>
  );
}


/* ── list view ─────────────────────────────────────────────────────── */
