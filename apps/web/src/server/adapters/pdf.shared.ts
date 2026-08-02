import type { PdfPageOptions } from "@backlex/core";

/**
 * The page setup both renderers need, in the two shapes they ask for.
 *
 * Chromium is underneath either way — Cloudflare's Browser Rendering and
 * Gotenberg both drive it — so the defaults live here once rather than drifting
 * between two adapters that would then produce differently-sized invoices from
 * the same template.
 */

export const DEFAULT_MARGIN = "20mm";

/** Normalize the shorthand into four explicit sides. */
export const marginsOf = (
  margin: PdfPageOptions["margin"],
): { top: string; right: string; bottom: string; left: string } => {
  if (typeof margin === "string" && margin.trim()) {
    const v = margin.trim();
    return { top: v, right: v, bottom: v, left: v };
  }
  const m = typeof margin === "object" && margin ? margin : {};
  return {
    top: m.top?.trim() || DEFAULT_MARGIN,
    right: m.right?.trim() || DEFAULT_MARGIN,
    bottom: m.bottom?.trim() || DEFAULT_MARGIN,
    left: m.left?.trim() || DEFAULT_MARGIN,
  };
};

export const formatOf = (opts: PdfPageOptions | undefined): string => opts?.format ?? "A4";

/** Backgrounds print unless the template explicitly said not to — see the note
 *  on {@link PdfPageOptions.printBackground}. */
export const printBackgroundOf = (opts: PdfPageOptions | undefined): boolean =>
  opts?.printBackground !== false;

/**
 * A CSS length, and nothing else.
 *
 * Margins reach a renderer from a stored template that an admin authored, and
 * both backends put them somewhere structured — a JSON body for one, a
 * multipart form for the other. Neither is an injection point on its own, but a
 * value like `"20mm; }"` is far more likely to be a mistake than an intention,
 * and a refusal at the boundary beats a renderer error nobody can decode.
 */
export const CSS_LENGTH = /^-?\d+(\.\d+)?(mm|cm|in|px|pt|pc)$/;

export const assertMargins = (m: { top: string; right: string; bottom: string; left: string }): void => {
  for (const [side, v] of Object.entries(m)) {
    if (!CSS_LENGTH.test(v)) {
      throw new Error(`PDF margin "${side}" must be a CSS length like 20mm, got ${JSON.stringify(v)}`);
    }
  }
};

/** Gotenberg wants inches as bare numbers; everything else is a CSS length. */
export const toInches = (v: string): number => {
  const m = /^(-?\d+(?:\.\d+)?)(mm|cm|in|px|pt|pc)$/.exec(v);
  if (!m) return 0.79;
  const n = Number(m[1]);
  switch (m[2]) {
    case "mm":
      return n / 25.4;
    case "cm":
      return n / 2.54;
    case "in":
      return n;
    case "px":
      return n / 96;
    case "pt":
      return n / 72;
    case "pc":
      return n / 6;
    default:
      return 0.79;
  }
};

/** Page sizes in inches, for the backend that takes dimensions rather than a
 *  name. Values are the ISO/US definitions, portrait. */
const SIZES: Record<string, { w: number; h: number }> = {
  A3: { w: 11.7, h: 16.5 },
  A4: { w: 8.27, h: 11.7 },
  A5: { w: 5.83, h: 8.27 },
  Letter: { w: 8.5, h: 11 },
  Legal: { w: 8.5, h: 14 },
};

export const sizeInches = (opts: PdfPageOptions | undefined): { w: number; h: number } => {
  const base = SIZES[formatOf(opts)] ?? SIZES.A4!;
  return opts?.landscape ? { w: base.h, h: base.w } : base;
};
