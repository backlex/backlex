/**
 * What "theme, accent, font" mean on a page a stranger sees.
 *
 * The palettes, the accent-contrast rule and the font stacks now live in
 * `@backlex/core/appearance`, because email and document templates render the
 * same three settings on the server and the two sides must not hold separate
 * tables of colours. What stays here is the part only a browser has: loading
 * the webfont stylesheet. The re-exports keep every existing import working.
 */
import { useEffect } from "react";
import { FONTS_HREF } from "@backlex/core/appearance";

export {
  ACCENTS,
  DARK,
  DEFAULT_ACCENT,
  FONTS_HREF,
  LIGHT,
  accentInk,
  fontStack,
  paletteFor,
  safeAccent,
  type Palette,
} from "@backlex/core/appearance";
export type {
  Appearance as PublicAppearance,
  AppearanceFont as PublicFont,
  AppearanceTheme as PublicTheme,
} from "@backlex/core/appearance";

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
