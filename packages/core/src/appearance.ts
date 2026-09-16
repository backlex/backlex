/**
 * What "theme, accent, font" mean — for a page a stranger sees, and for the
 * email or PDF a template renders.
 *
 * The public form, the public booking page and their admin previews used to own
 * this in `client/lib/public-theme.ts`. It moved here when email and document
 * templates gained the same three settings, because a template is rendered on
 * the SERVER: the palette an admin picks has to become the same hex values in
 * the mail a customer opens as it does in the preview beside the editor. One
 * table of colours, read by both, is the only way those cannot drift.
 *
 * The shape is the one `forms.settings` already stored, so a surface that gains
 * appearance settings gains THIS vocabulary rather than a second one.
 */

export type AppearanceTheme = "dark" | "light";
export type AppearanceFont = "sans" | "lexend" | "mono" | "system";

/** The appearance half of a page's or template's settings. */
export interface Appearance {
  theme?: AppearanceTheme;
  accent?: string;
  font?: AppearanceFont;
  /**
   * Wrap a fragment body in the themed document (`template-shell.ts`).
   * Absent means yes — the setting exists to turn it OFF for a template whose
   * author wants the bare fragment on the wire. A body that is already a
   * complete document is never wrapped regardless.
   *
   * Only templates read this; the public form and booking pages ignore it.
   */
  shell?: boolean;
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

export const paletteFor = (theme: AppearanceTheme | undefined): Palette =>
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

export const APPEARANCE_THEMES: readonly AppearanceTheme[] = ["light", "dark"];
export const APPEARANCE_FONTS: readonly AppearanceFont[] = ["sans", "lexend", "mono", "system"];
export const ACCENT_PATTERN = /^#[0-9a-fA-F]{6}$/;

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
  typeof raw === "string" && ACCENT_PATTERN.test(raw) ? raw : DEFAULT_ACCENT;

export const fontStack = (font: AppearanceFont | undefined): string =>
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
 * Keep only a well-formed appearance, or null when nothing is set.
 *
 * Stored settings are read back through this rather than trusted: a value that
 * reaches a `style=""` attribute in someone's inbox must be one of the known
 * words or a `#rrggbb`, never whatever a JSON column happened to hold.
 */
export const normalizeAppearance = (raw: unknown): Appearance | null => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const out: Appearance = {};
  if (APPEARANCE_THEMES.includes(r.theme as AppearanceTheme)) out.theme = r.theme as AppearanceTheme;
  if (typeof r.accent === "string" && ACCENT_PATTERN.test(r.accent)) out.accent = r.accent;
  if (APPEARANCE_FONTS.includes(r.font as AppearanceFont)) out.font = r.font as AppearanceFont;
  // Only `false` is worth keeping: `shell: true` is the default, and storing it
  // would make an otherwise-empty appearance non-null for no behaviour.
  if (r.shell === false) out.shell = false;
  return Object.keys(out).length > 0 ? out : null;
};

/**
 * Why `raw` is not an appearance a template may store, or null when it is (or
 * is empty). For a surface with no schema of its own — GraphQL's JSON scalar —
 * so a typo such as `accent: "red"` is refused there as REST refuses it,
 * instead of being quietly dropped by {@link normalizeAppearance}.
 */
export const appearanceProblem = (raw: unknown): string | null => {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return "appearance must be an object";
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v === undefined || v === null) continue;
    if (k === "theme" && !APPEARANCE_THEMES.includes(v as AppearanceTheme)) {
      return `appearance.theme must be one of ${APPEARANCE_THEMES.join(", ")}`;
    }
    if (k === "accent" && !(typeof v === "string" && ACCENT_PATTERN.test(v))) {
      return "appearance.accent must be a #rrggbb colour";
    }
    if (k === "font" && !APPEARANCE_FONTS.includes(v as AppearanceFont)) {
      return `appearance.font must be one of ${APPEARANCE_FONTS.join(", ")}`;
    }
    if (k === "shell" && typeof v !== "boolean") return "appearance.shell must be a boolean";
    if (k !== "theme" && k !== "accent" && k !== "font" && k !== "shell") {
      return `appearance.${k} is not a setting`;
    }
  }
  return null;
};

/** Every value a template reads as `{{ theme.* }}`. */
export interface ThemeVars {
  /** `light` or `dark`. */
  mode: AppearanceTheme;
  accent: string;
  /** Text colour that reads on `accent` — for a button label. */
  accentInk: string;
  bg: string;
  card: string;
  text: string;
  muted: string;
  faint: string;
  border: string;
  /** A CSS `font-family` value. */
  font: string;
  /** Stylesheet for the webfonts `font` names. A PDF loads it; most mail
   *  clients ignore it and fall back along the stack, which is why it is one. */
  fontsHref: string;
}

/** The names `theme.*` offers, in the order the admin lists them. */
export const THEME_VAR_NAMES: readonly (keyof ThemeVars)[] = [
  "mode",
  "accent",
  "accentInk",
  "bg",
  "card",
  "text",
  "muted",
  "faint",
  "border",
  "font",
  "fontsHref",
];

/**
 * The `theme` values for an appearance.
 *
 * A template with no appearance still gets a full set — light, the default
 * accent, the default font — so a template written against `{{ theme.accent }}`
 * never renders an empty `color:` just because nobody opened the panel. Light
 * is the default here (forms default to dark) because paper and an inbox are
 * both white.
 */
export const themeVars = (appearance: Appearance | null | undefined): ThemeVars => {
  const a = normalizeAppearance(appearance) ?? {};
  const mode: AppearanceTheme = a.theme ?? "light";
  const palette = paletteFor(mode);
  const accent = safeAccent(a.accent);
  return {
    mode,
    accent,
    accentInk: accentInk(accent),
    ...palette,
    font: fontStack(a.font),
    fontsHref: FONTS_HREF,
  };
};

/**
 * The variables a template renders against, with `theme` filled in.
 *
 * The caller's own `theme` wins: a flow that already passed a `theme` value
 * before templates had appearance keeps rendering what it rendered.
 */
export const withThemeVars = (
  vars: Record<string, unknown>,
  appearance: Appearance | null | undefined,
): Record<string, unknown> => ({ theme: themeVars(appearance), ...vars });
