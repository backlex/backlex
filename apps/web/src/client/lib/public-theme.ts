/**
 * What "theme, accent, font" mean on a page a stranger sees.
 *
 * The public form, the public booking page and the admin's own preview of
 * either all have to agree about this, or a form previewed in the admin looks
 * one way and looks another on the customer's screen. So the palettes, the
 * accent-contrast rule, the font stacks and the webfont href live here once
 * and every surface reads them rather than restating them.
 *
 * The shape is deliberately the same one `forms.settings` already stored, so
 * a page that gains appearance settings gains THIS vocabulary rather than a
 * second, slightly-different one.
 */
import { useEffect } from "react";

export type PublicTheme = "dark" | "light";
export type PublicFont = "sans" | "lexend" | "mono" | "system";

/** The appearance half of a public page's settings. */
export interface PublicAppearance {
  theme?: PublicTheme;
  accent?: string;
  font?: PublicFont;
}

export interface Palette {
  bg: string;
  card: string;
  text: string;
  muted: string;
  faint: string;
  border: string;
  inputBg: string;
}

export const DARK: Palette = {
  bg: "#08070F",
  card: "#0E0C18",
  text: "#ECEAF7",
  muted: "#A6A1C2",
  faint: "#635E80",
  border: "rgba(255,255,255,0.09)",
  inputBg: "rgba(255,255,255,0.03)",
};

export const LIGHT: Palette = {
  bg: "#F6F5FA",
  card: "#FFFFFF",
  text: "#17141F",
  muted: "#5F5A73",
  faint: "#8A85A0",
  border: "rgba(20,15,45,0.12)",
  inputBg: "rgba(20,15,45,0.03)",
};

export const paletteFor = (theme: PublicTheme | undefined): Palette =>
  theme === "light" ? LIGHT : DARK;

/** The accents offered in the admin. First entry is the default. */
export const ACCENTS = [
  "#8B6CFF",
  "#5C6CFF",
  "#4FB7E8",
  "#3AC9C4",
  "#34C79A",
  "#8FCC5C",
  "#F2C14E",
  "#FF8A5C",
  "#E5484D",
  "#E85CA8",
  "#C77DFF",
  "#8A94A6",
] as const;

export const DEFAULT_ACCENT = ACCENTS[0];

/** Readable text color on the accent: relative luminance picks dark ink on
 *  light accents, white on dark ones — no manual contrast knob needed. */
export const accentInk = (hex: string): string => {
  const n = hex.replace("#", "");
  const ch = (i: number) => {
    const c = parseInt(n.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const L = 0.2126 * ch(0) + 0.7152 * ch(2) + 0.0722 * ch(4);
  return L > 0.45 ? "#17141F" : "#FFFFFF";
};

/** A `#rrggbb` the page can safely write into a style. Anything else falls
 *  back to the default: the value reaches here from stored settings, and a
 *  page must not paste an arbitrary string into a CSS declaration. */
export const safeAccent = (raw: string | null | undefined): string =>
  typeof raw === "string" && /^#[0-9a-fA-F]{6}$/.test(raw) ? raw : DEFAULT_ACCENT;

export const fontStack = (font: PublicFont | undefined): string =>
  font === "lexend"
    ? "'Lexend','Manrope',system-ui,sans-serif"
    : font === "mono"
      ? "'JetBrains Mono',ui-monospace,monospace"
      : font === "system"
        ? "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
        : "'Manrope',system-ui,sans-serif";

export const FONTS_HREF =
  "https://fonts.googleapis.com/css2?family=Lexend:wght@300;400;500;600;700&family=Manrope:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap";

/**
 * Load the shared webfont stylesheet once. The public pages' CSP allows it.
 *
 * `enabled` exists for a page that only sometimes needs it: the booking page
 * ships unstyled by default, and a resource that never chose a font should not
 * make its visitors fetch one. Passed as an argument rather than guarded at the
 * call site because this is a hook.
 */
export const useFonts = (enabled = true): void => {
  useEffect(() => {
    if (!enabled) return;
    if (document.querySelector(`link[href="${FONTS_HREF}"]`)) return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = FONTS_HREF;
    document.head.appendChild(link);
  }, [enabled]);
};
